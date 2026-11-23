// CloudTAK lints copied plugin routes with its OWN house-style rules, which differ across
// versions (@stylistic/brace-style flips between releases and isn't defined on older
// ones). A plugin can't satisfy every CloudTAK version, so this route file opts out of
// CloudTAK's lint — the plugin repo owns its correctness.
/* eslint-disable */
import { Type } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import tls from 'node:tls';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { Agent, fetch as undiciFetch } from 'undici';
import Schema from '@openaddresses/batch-schema';
import Err from '@openaddresses/batch-error';
import TAK, { TAKAPI, APIAuth, APIAuthPassword } from '@tak-ps/node-tak';
import { CoTParser } from '@tak-ps/node-cot';
import type CoT from '@tak-ps/node-cot';
// CloudTAK 13.45+ (hub/api split): routes live in api/stateless/routes/, shared libs in
// api/common/, and route files receive ConfigStateless — the same contract as the Dispatcher
// plugin's server routes. The infra-TAK installer copies this file into
// api/stateless/routes/ and refuses to install onto a pre-split tree.
import Auth from '../../common/auth.js';
import type ConfigStateless from '../config.js';

// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK — CloudTAK server route
// Copyright (C) 2026 TAKWERX
//
// Streams CoT from linked TAK Servers (other agencies' servers, NOT federated) into the
// CloudTAK map through the hub's public wsNotify call.
// Design: the CrossTAK plan (work items W2–W13 below refer to it).
//
// Auto-loaded by schema.load('../../routes/') at boot. A route file that throws at load
// takes the whole CloudTAK API down, so everything below this line must fail soft.
//
// Trust model:
// - Each linked server's CA is pinned on that server's own sockets (8089 stream, 8443 API).
//   It is never added to Node's global store or NODE_EXTRA_CA_CERTS.
// - Enrollment (8446) trusts the row's CA if it has one, plus Node's bundled public roots,
//   with full hostname verification: infra-TAK puts a Let's Encrypt cert on 8446, and the
//   enrollment response hands back the server's CA, which is then pinned for 8089/8443.
//
// Secrets discipline (PLAN W2): the `ca` and `auth` columns are read only by this module.
// No route returns them, no log line carries them, and error text that could quote a PEM
// is replaced before it reaches a response or a log.

const VERSION = '0.6.1';
const TAG = 'crosstak';

const PRESENCE_POLL_MS = 15_000;     // W7: how often we ask the hub which link owners are on the map
const IDLE_DISCONNECT_MS = 60_000;   // W7: a link closes this long after its owner leaves the map
const SELF_MIN_MS = 9_000;           // W11: at most one own-position report per user per ~10 s
const SELF_STALE_MS = 60_000;        // W11: same stale as CloudTAK's own self PLI
const SELF_TYPE = 'a-f-G-E-V-C';     // W11: team member skittle, as CloudTAK reports self
const SWEEP_MS = 60 * 60_000;
const MISSION_REFRESH_MS = 30 * 60_000; // W13: re-load subscribed feeds (keeps their stale fresh)
const MISSION_STALE_MS = 2 * 60 * 60_000; // W13: feed items stay on the map at least this long
const MISSION_DEBOUNCE_MS = 2_000;      // W13: change messages often arrive in bursts        // leavers: how often orphaned links are removed
const FLUSH_MS = 250;                // W3: coalesce fan-out, newest feature per id
const RETRY_MIN_MS = 10_000;
const RETRY_MAX_MS = 60_000;
const DEFAULT_STALE_MS = 10 * 60_000;
// W12: a sent feature is a fresh message. A shape drawn an hour ago still carries its old
// stale time, and ATAK expired it on arrival (operator test 2026-11-17).
const SENT_MIN_STALE_MS = 24 * 60 * 60_000;

// TAK Server 5.8+ only honours a channel selection from a certificate carrying this
// Extended Key Usage (CloudTAK 13.x surfaces the same flag as a Channels badge).
const CHANNELS_EKU = '1.2.840.113549.1.9.7';

// TLS verification failures are final: the row is wrong (bad CA, wrong host), and retrying
// would just hammer the linked server with handshakes. Anything else is a network blip.
const TLS_REJECT_CODES = new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'CERT_SIGNATURE_FAILURE', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'HOSTNAME_MISMATCH',
]);

interface ServerAuth {
    cert: string;
    key: string;
}

interface ServerRow {
    id: number;
    name: string;
    url: string;
    api: string | null;
    webtak: string | null;
    expected_name: string | null;
    ca: string;
    auth: ServerAuth | null;
    enabled: boolean;
    always_on: boolean;
    created: string;
    updated: string;
    created_by: string | null;
    enrolled_by: string | null;
    enrolled_at: string | null;
    // D2 (2026-11-17): every link belongs to one CloudTAK user. Its stream carries that user's
    // identity on the linked server, and its CoT goes to that user's browser only.
    owner: string | null;
}

interface CertSummary {
    subject: string;
    issuer: string;
    valid_to: string;
    channels: boolean;
}

interface StreamStatus {
    connected: boolean;
    verified: boolean;
    since: string | null;
    last_cot: string | null;
    cots: number;
    error: string | null;
    rejected: boolean;
}

interface TakGroup {
    name: string;
    direction: string;
    created: string;
    type: string;
    bitpos: number;
    active: boolean;
    description?: string;
}

interface ChannelView {
    name: string;
    description: string | null;
    active: boolean;
    in: boolean;
    out: boolean;
}

type GeoJSONFeature = Awaited<ReturnType<typeof CoTParser.to_geojson>>;

const SELECT_ROW = sql`
    SELECT id, name, url, api, webtak, expected_name, ca, auth, enabled, always_on,
           created, updated, created_by, enrolled_by, enrolled_at, owner
    FROM crosstak_server
`;

// drizzle's execute() returns the driver RowList; cast to the row shape we SELECTed.
async function query<T>(config: ConfigStateless, statement: ReturnType<typeof sql>): Promise<T[]> {
    const result = await config.pg.execute(statement);
    return result as unknown as T[];
}

// jsonb can come back from the driver as a JSON string.
function asAuth(v: unknown): ServerAuth | null {
    let x: unknown = v;
    if (typeof x === 'string') {
        try { x = JSON.parse(x); } catch { return null; }
    }
    if (!x || typeof x !== 'object') return null;
    const o = x as Record<string, unknown>;
    if (typeof o.cert !== 'string' || typeof o.key !== 'string') return null;
    return { cert: o.cert, key: o.key };
}

function normalizeRow(r: ServerRow): ServerRow {
    return { ...r, auth: asAuth(r.auth) };
}

// Error text that is safe for a response or a log line: a code when there is one, never a
// PEM fragment, never more than one line.
function safeMessage(err: unknown): string {
    const e = err as { code?: unknown; message?: unknown; safe?: unknown } | null;
    // batch-error (used by node-tak) keeps the readable text in .safe and puts the inner
    // error's message — often an empty TAK Server body — in .message.
    if (e && typeof e.safe === 'string' && e.safe && e.safe !== 'Generic Error') return e.safe.slice(0, 160);
    const code = e && typeof e.code === 'string' ? e.code : '';
    let msg = e && typeof e.message === 'string' ? e.message : '';
    if (/BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)/.test(msg) || /[A-Za-z0-9+/=]{64,}/.test(msg)) msg = '';
    msg = msg.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (code && msg && !msg.includes(code)) return `${code}: ${msg}`;
    return msg || code || 'unknown error';
}

// The TLS error code of an error or of any error in its cause chain (undici wraps them).
function tlsCode(err: unknown): string {
    let e = err as { code?: unknown; cause?: unknown } | null | undefined;
    for (let i = 0; i < 4 && e; i++) {
        if (typeof e.code === 'string' && TLS_REJECT_CODES.has(e.code)) return e.code;
        e = e.cause as typeof e;
    }
    return '';
}

// altnameMessage:begin (the test in test/altname-message.test.mjs cuts this block out by marker)
// Status text for a certificate whose names do not match. Says what the certificate names,
// where to fix it (Edit on the server card) and what to type. The suggested name comes from
// the remote certificate, so only plain host names are echoed; the CA is verified either way.
function altnameMessage(subjectaltname: string | undefined, expectedName: string | null): string {
    const sans = String(subjectaltname || '').split(',').map((s) => s.trim()).filter(Boolean);
    const dns = sans.filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4)).filter((n) => /^[A-Za-z0-9.\-]+$/.test(n) && n.length <= 253);
    const names = dns.length ? dns.join(', ') : '';
    const head = 'TLS pin failed: ERR_TLS_CERT_ALTNAME_INVALID';
    if (expectedName) {
        return `${head} — the certificate names ${names || 'something else'}, not "${expectedName}". Click Edit on this server and fix "Expected certificate name"${dns.length ? ` (the certificate names ${dns[0]})` : ''}.`;
    }
    if (dns.length) {
        return `${head} — the server's certificate is named ${names}, not the address you typed. Click Edit on this server, then enter ${dns[0]} in "Expected certificate name". The CA is still verified.`;
    }
    return `${head} — the server's certificate does not name the address you typed. Click Edit on this server and set "Expected certificate name" to the name on its certificate.`;
}
// altnameMessage:end

// The linked server refusing OUR certificate (TLS alert from its side). Retrying cannot fix
// it: the owner must enroll again (expired) or ask that agency (revoked / not trusted).
const PEER_REFUSED: Record<string, string> = {
    ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED: 'the linked server says your certificate has expired — enroll again',
    ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED: 'the linked server says your certificate is revoked — ask that agency',
    ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE: 'the linked server refused your certificate — enroll again, or ask that agency',
    ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN: 'the linked server refused your certificate — enroll again, or ask that agency',
    ERR_SSL_TLSV1_ALERT_UNKNOWN_CA: 'the linked server does not trust the CA of your certificate — enroll again, or ask that agency',
    ERR_SSL_TLSV1_ALERT_ACCESS_DENIED: 'the linked server denied your certificate — ask that agency',
};

function peerRefused(err: unknown): string {
    let e = err as { code?: unknown; cause?: unknown } | null | undefined;
    for (let i = 0; i < 4 && e; i++) {
        if (typeof e.code === 'string' && PEER_REFUSED[e.code]) return e.code;
        e = e.cause as typeof e;
    }
    return '';
}

function log(id: number | string, msg: string): void {
    console.log(`${TAG}:${id} ${msg}`);
}

function logError(id: number | string, msg: string): void {
    console.error(`${TAG}:${id} ${msg}`);
}

// ── PEM handling (W4a) ──────────────────────────────────────────────────────────────────

function pemCertificates(pem: string): string[] {
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    return blocks ? blocks.map((b) => b.trim()) : [];
}

// TAK's signClient response carries the CA chain as bare base64 (ca0, ca1, …).
function asPem(value: string): string {
    if (value.includes('-----BEGIN CERTIFICATE-----')) return value;
    const b64 = value.replace(/\s+/g, '');
    const lines = b64.match(/.{1,64}/g) || [];
    return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

function summarizeCert(pem: string): CertSummary {
    const x = new X509Certificate(pem);
    let eku: string[] = [];
    try { eku = x.keyUsage || []; } catch { eku = []; }
    return {
        subject: x.subject.replace(/\n/g, ', '),
        issuer: x.issuer.replace(/\n/g, ', '),
        valid_to: new Date(x.validTo).toISOString(),
        channels: eku.includes(CHANNELS_EKU),
    };
}

// Returns the CA bundle as plain CERTIFICATE blocks (TAK's ca-trusted.pem style "TRUSTED
// CERTIFICATE" blocks are not something Node's TLS accepts) and throws 400 on garbage.
function validateCA(ca: unknown): string {
    if (typeof ca !== 'string' || !ca.trim()) throw new Err(400, null, 'ca is required: the linked server\'s CA chain as PEM');
    const blocks = pemCertificates(ca);
    if (!blocks.length) throw new Err(400, null, 'ca contains no CERTIFICATE block');
    for (const b of blocks) {
        try {
            new X509Certificate(b);
        } catch {
            throw new Err(400, null, 'ca contains a certificate Node cannot parse');
        }
    }
    return blocks.join('\n') + '\n';
}

function validateAuth(cert: unknown, key: unknown): ServerAuth {
    if (typeof cert !== 'string' || typeof key !== 'string') throw new Err(400, null, 'cert and key must both be PEM strings');
    const certs = pemCertificates(cert);
    if (certs.length !== 1) throw new Err(400, null, 'cert must contain exactly one CERTIFICATE block');
    let x: X509Certificate;
    try {
        x = new X509Certificate(certs[0]);
    } catch {
        throw new Err(400, null, 'cert cannot be parsed');
    }
    let k: ReturnType<typeof createPrivateKey>;
    try {
        k = createPrivateKey({ key, format: 'pem' });
    } catch {
        throw new Err(400, null, 'key cannot be parsed: supply an unencrypted PEM private key');
    }
    if (!x.checkPrivateKey(k)) throw new Err(400, null, 'key does not match cert');
    if (new Date(x.validTo).getTime() < Date.now()) throw new Err(400, null, 'cert has expired');
    return { cert: certs[0] + '\n', key: k.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

function validateUrl(value: unknown, field: string, protocols: string[]): string {
    if (typeof value !== 'string' || !value.trim()) throw new Err(400, null, `${field} is required`);
    let u: URL;
    try {
        u = new URL(value.trim());
    } catch {
        throw new Err(400, null, `${field} is not a URL`);
    }
    if (!protocols.includes(u.protocol)) throw new Err(400, null, `${field} must start with ${protocols.join(' or ')}//`);
    if (!u.hostname) throw new Err(400, null, `${field} has no host`);
    if (u.username || u.password) throw new Err(400, null, `${field} must not carry credentials`);
    return u.toString().replace(/\/$/, '');
}

function validateHostname(value: unknown, field = 'expected_name'): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !/^[A-Za-z0-9.\-*]+$/.test(value) || value.length > 253) {
        throw new Err(400, null, `${field} must be a hostname`);
    }
    return value;
}

// Accept "takserver.example.org", "https://takserver.example.org:8446/…" or "ssl://…:8089".
function hostOf(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Err(400, null, 'host is required');
    let v = value.trim();
    if (v.includes('://')) {
        try {
            v = new URL(v).hostname;
        } catch {
            throw new Err(400, null, 'host is not a hostname or URL');
        }
    } else {
        v = v.replace(/[:/].*$/, '');
    }
    const host = validateHostname(v, 'host');
    if (!host || host.includes('*')) throw new Err(400, null, 'host must be a hostname');
    return host;
}

// Hostname check for a pinned socket: the URL host first, then the user-supplied
// expected_name (infra-TAK TAK Servers present SAN DNS:takserver, which never matches a
// real URL). Returns undefined when the peer matches, else the Node error.
function checkPeerName(urlHost: string, expectedName: string | null, cert: tls.PeerCertificate): Error | undefined {
    const byUrl = tls.checkServerIdentity(urlHost, cert);
    if (!byUrl || !expectedName) return byUrl;
    return tls.checkServerIdentity(expectedName, cert);
}

// ── Pinned HTTPS clients (W4b enrollment, channel API) ──────────────────────────────────
//
// node-tak's APIAuthPassword uses its default fetch (Node's trust store plus
// NODE_EXTRA_CA_CERTS) and APIAuthCertificate disables verification outright. Neither is
// acceptable for a linked server, so these classes route every request through an undici
// Agent whose trust is explicit. Everything else (OAuth login, TLS config, CSR, signClient,
// group list/update) is node-tak's own code.

function makeAgent(opts: { ca: string[]; cert?: string; key?: string; expectedName: string | null }): Agent {
    return new Agent({
        connect: {
            ca: opts.ca,
            ...(opts.cert && opts.key ? { cert: opts.cert, key: opts.key } : {}),
            rejectUnauthorized: true,
            checkServerIdentity: (host: string, cert: tls.PeerCertificate) => checkPeerName(host, opts.expectedName, cert),
        },
    });
}

class PinnedPasswordAuth extends APIAuthPassword {
    private dispatcher: Agent;

    constructor(username: string, password: string, dispatcher: Agent) {
        super(username, password);
        this.dispatcher = dispatcher;
    }

    async fetch(api: TAKAPI, url: URL, opts: any): Promise<any> {
        opts = opts || {};
        opts.headers = opts.headers || {};
        if (!opts.headers.Authorization && this.jwt) opts.headers.Authorization = `Bearer ${this.jwt}`;
        delete opts.credentials;
        delete opts.nocookies;
        return await undiciFetch(url, { ...opts, dispatcher: this.dispatcher });
    }
}

class PinnedCertAuth extends APIAuth {
    private dispatcher: Agent;

    constructor(dispatcher: Agent) {
        super();
        this.dispatcher = dispatcher;
    }

    async fetch(api: TAKAPI, url: URL, opts: any): Promise<any> {
        opts = opts || {};
        delete opts.credentials;
        delete opts.nocookies;
        return await undiciFetch(url, { ...opts, dispatcher: this.dispatcher });
    }
}

function closeAgent(agent: Agent): void {
    agent.close().catch(() => undefined);
}

function enrollError(err: unknown, trusted: string, host: string): Err {
    const code = tlsCode(err);
    if (code) {
        return new Err(400, null, `Enrollment refused: ${host}:8446 did not verify against ${trusted} (${code})`);
    }
    const msg = safeMessage(err);
    if (/(incorrect|invalid) username or password/i.test(msg)) {
        return new Err(400, null, `${host} rejected the username or password. Check that the account can sign in there (a new account may need its password changed first).`);
    }
    return new Err(400, null, `Enrollment on ${host} failed: ${msg}`);
}

// W4b: username/password → the user's own certificate. The password is used for this call only.
async function enroll(webtak: string, username: string, password: string, ca: string | null, expectedName: string | null): Promise<{ auth: ServerAuth; ca: string }> {
    const trust = [...(ca ? pemCertificates(ca) : []), ...tls.rootCertificates];
    const trusted = ca ? 'the pinned CA or a public CA' : 'a public CA';
    const agent = makeAgent({ ca: trust, expectedName: ca ? expectedName : null });
    try {
        let certs: { cert: string; key: string; ca: string[] };
        try {
            const api = await TAKAPI.init(new URL(webtak), new PinnedPasswordAuth(username, password, agent));
            certs = await api.Credentials.generate({ username });
        } catch (err) {
            let host = webtak;
            try { host = new URL(webtak).hostname; } catch { /* keep the raw value */ }
            throw enrollError(err, trusted, host);
        }
        const auth = validateAuth(certs.cert, certs.key);
        let chain = ca;
        if (!chain) {
            const returned = (certs.ca || []).filter((c) => typeof c === 'string' && c.trim()).map(asPem).join('\n');
            if (!returned) throw new Err(400, null, 'The server issued a certificate but returned no CA chain; paste its CA instead');
            chain = validateCA(returned);
        }
        return { auth, ca: chain };
    } finally {
        closeAgent(agent);
    }
}

function apiUrlOf(row: ServerRow): string {
    if (row.api) return row.api;
    let host = '';
    try { host = new URL(row.url).hostname; } catch { /* validated on write */ }
    if (!host) throw new Err(400, null, 'Set the API URL (https://host:8443) on this server');
    return `https://${host}:8443`;
}

async function withChannelApi<T>(row: ServerRow, fn: (api: TAKAPI) => Promise<T>): Promise<T> {
    if (!row.auth) throw new Err(400, null, 'This server has no client certificate yet: link or enroll it first');
    const agent = makeAgent({ ca: pemCertificates(row.ca), cert: row.auth.cert, key: row.auth.key, expectedName: row.expected_name });
    try {
        const api = await TAKAPI.init(new URL(apiUrlOf(row)), new PinnedCertAuth(agent));
        return await fn(api);
    } catch (err) {
        if (err instanceof Err) throw err;
        const code = tlsCode(err);
        if (code) throw new Err(502, null, `The API port did not verify against the pinned CA (${code})`);
        throw new Err(502, null, `Request to the linked server failed: ${safeMessage(err)}`);
    } finally {
        closeAgent(agent);
    }
}

async function listGroups(api: TAKAPI): Promise<TakGroup[]> {
    const res = await api.Group.list({ useCache: true }) as unknown as { data?: TakGroup[] };
    return Array.isArray(res.data) ? res.data : [];
}

function channelView(groups: TakGroup[]): ChannelView[] {
    const byName = new Map<string, ChannelView>();
    for (const g of groups) {
        const v = byName.get(g.name) || { name: g.name, description: g.description || null, active: false, in: false, out: false };
        if (g.active) v.active = true;
        if (String(g.direction).toUpperCase() === 'IN') v.in = true;
        if (String(g.direction).toUpperCase() === 'OUT') v.out = true;
        if (!v.description && g.description) v.description = g.description;
        byName.set(g.name, v);
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// W3: namespace a linked feature (id, provenance, never archived). W13 adds the feed name.
function tagLinked(row: ServerRow, feat: GeoJSONFeature, mission?: string): string {
    const uid = String(feat.id);
    const id = `${TAG}:${row.id}:${uid}`;
    feat.id = id;
    // node-cot's Feature type has no properties.id, but the browser mirrors it from
    // feat.id on ingest; set it anyway so a feature carries the namespace end to end.
    (feat.properties as Record<string, unknown>).id = id;
    feat.properties.metadata = {
        ...((feat.properties.metadata as Record<string, unknown> | undefined) || {}),
        [TAG]: { server: row.id, name: row.name, uid, ...(mission ? { mission } : {}) },
    };
    // archived is the one state where the browser PUTs a feature to CloudTAK's own store.
    feat.properties.archived = false;
    if (!feat.properties.stale) feat.properties.stale = new Date(Date.now() + DEFAULT_STALE_MS).toISOString();
    return id;
}

// ── Stream manager (W3, W7) ─────────────────────────────────────────────────────────────

class Stream {
    row: ServerRow;
    tak?: TAK;
    status: StreamStatus;
    pending: Map<string, GeoJSONFeature>;
    certSummary: CertSummary | null;
    caSummary: CertSummary[];
    // W11: called once the socket is verified, so the owner's position goes out at once.
    onReady?: (s: Stream) => void;
    // W13: a Data Sync feed changed on the linked server (t-x-m-c on this socket).
    onMissionChange?: (s: Stream, name: string) => void;
    private retry?: ReturnType<typeof setTimeout>;
    private backoff: number;
    private connecting: boolean;
    private generation: number;

    constructor(row: ServerRow) {
        this.row = row;
        this.status = { connected: false, verified: false, since: null, last_cot: null, cots: 0, error: null, rejected: false };
        this.pending = new Map();
        this.certSummary = null;
        this.caSummary = [];
        this.backoff = RETRY_MIN_MS;
        this.connecting = false;
        this.generation = 0;
        this.summarize();
    }

    get id(): number {
        return this.row.id;
    }

    get wsConnection(): string {
        return `${TAG}:${this.row.id}`;
    }

    summarize(): void {
        try {
            this.certSummary = this.row.auth ? summarizeCert(this.row.auth.cert) : null;
        } catch {
            this.certSummary = null;
        }
        try {
            this.caSummary = pemCertificates(this.row.ca).map(summarizeCert);
        } catch {
            this.caSummary = [];
        }
    }

    // A new row from PATCH/enroll: restart only when something the socket depends on changed.
    update(row: ServerRow): void {
        const before = this.row;
        this.row = row;
        this.summarize();
        const socketChanged = before.url !== row.url || before.ca !== row.ca || before.expected_name !== row.expected_name
            || JSON.stringify(before.auth) !== JSON.stringify(row.auth);
        if (socketChanged) {
            this.status.rejected = false;
            this.status.error = null;
            this.backoff = RETRY_MIN_MS;
            this.disconnect('reconfigured');
        }
    }

    connect(): void {
        if (this.tak || this.connecting || this.status.rejected) return;
        if (!this.row.auth) {
            this.status.error = 'no client certificate: link or enroll this server';
            return;
        }
        // Expired: the linked server would refuse it anyway, so do not knock on its door.
        const validTo = this.certSummary ? Date.parse(this.certSummary.valid_to) : NaN;
        if (!Number.isNaN(validTo) && validTo < Date.now()) {
            this.status.rejected = true;
            this.status.error = `your certificate expired on ${this.certSummary!.valid_to.slice(0, 10)} — enroll again`;
            log(this.id, 'not connecting: certificate expired');
            return;
        }
        const gen = ++this.generation;
        this.connecting = true;
        // strict: Node verifies chain AND hostname and aborts the handshake itself.
        // expected_name set: Node still verifies the chain (authorizationError is populated
        // either way) but we accept the handshake and judge the name ourselves before a
        // single byte is trusted. The CA is pinned on this socket only, never globally.
        const strict = !this.row.expected_name;
        let url: URL;
        try {
            url = new URL(this.row.url);
        } catch {
            this.connecting = false;
            this.status.rejected = true;
            this.status.error = 'url is not a URL';
            return;
        }

        TAK.connect(url, {
            cert: this.row.auth.cert,
            key: this.row.auth.key,
            ca: this.row.ca,
            rejectUnauthorized: strict,
        }, {
            id: this.wsConnection,
            cot: { milsym: { augment: true } },
        }).then((tak) => {
            this.connecting = false;
            if (gen !== this.generation) {
                // disconnect() ran while we were connecting
                try { tak.destroy(); } catch { /* ignore */ }
                return;
            }
            this.tak = tak;
            this.attach(tak, strict);
        }).catch((err) => {
            this.connecting = false;
            this.down(`connect failed ${safeMessage(err)}`, err);
        });
    }

    private attach(tak: TAK, strict: boolean): void {
        tak.on('secureConnect', () => {
            const sock = tak.client;
            const code = sock ? sock.authorizationError : undefined;
            let ok = false;
            let names = '';
            if (!sock) {
                ok = false;
            } else if (strict) {
                ok = !code;
            } else if (!code) {
                ok = true;
            } else if (String(code) === 'ERR_TLS_CERT_ALTNAME_INVALID') {
                // ERR_TLS_CERT_ALTNAME_INVALID is only reported once the chain has verified.
                let host = '';
                try { host = new URL(this.row.url).hostname; } catch { /* unreachable, validated above */ }
                const peer = sock.getPeerCertificate();
                ok = !checkPeerName(host, this.row.expected_name, peer);
                names = peer && peer.subjectaltname ? String(peer.subjectaltname) : '';
            }
            if (!ok) {
                this.status.rejected = true;
                this.status.verified = false;
                this.status.error = String(code) === 'ERR_TLS_CERT_ALTNAME_INVALID'
                    ? altnameMessage(names, this.row.expected_name)
                    : `TLS pin failed: ${String(code || 'no socket')}${names ? ` — the certificate names ${names}` : ''}`;
                logError(this.id, `REJECTED ${String(code || 'no socket')}`);
                this.disconnect('rejected');
                return;
            }
            this.status.connected = true;
            this.status.verified = true;
            this.status.since = new Date().toISOString();
            this.status.error = null;
            this.backoff = RETRY_MIN_MS;
            log(this.id, `connected ${this.row.url}${strict ? '' : ` name=${this.row.expected_name}`}`);
            if (this.onReady) {
                try { this.onReady(this); } catch (err) { logError(this.id, `onReady failed ${safeMessage(err)}`); }
            }
        });

        tak.on('cot', (cot: CoT) => {
            if (!this.status.verified) return;
            this.ingest(cot).catch((err) => logError(this.id, `cot dropped ${safeMessage(err)}`));
        });

        tak.on('ping', () => undefined);
        tak.on('end', () => this.down('end'));
        tak.on('close', () => this.down('close'));
        tak.on('error', (err: Error) => this.down(`error ${safeMessage(err)}`, err));
    }

    private async ingest(cot: CoT): Promise<void> {
        const type = cot.type();
        // W13: a feed we follow changed — reload it (debounced by the manager).
        if (type.startsWith('t-x-m-c')) {
            const detail = (cot.raw as { event?: { detail?: { mission?: { _attributes?: { name?: unknown } } } } }).event?.detail;
            const name = detail?.mission?._attributes?.name;
            if (typeof name === 'string' && name && this.onMissionChange) this.onMissionChange(this, name);
            return;
        }
        // No linked chat, tasking or file-transfer control messages (PLAN W3 step 1).
        if (type.startsWith('b-t-f') || type.startsWith('t-x') || type.startsWith('b-f-t')) return;
        if (cot.is_chat()) return;

        const feat = await CoTParser.to_geojson(cot, { normalize2525: true });
        const id = tagLinked(this.row, feat);

        this.status.cots++;
        this.status.last_cot = new Date().toISOString();
        this.pending.set(id, feat);
    }

    private down(why: string, err?: unknown): void {
        const wasConnected = this.status.connected;
        this.status.connected = false;
        this.status.verified = false;
        if (!this.status.rejected) this.status.error = why;

        const refused = peerRefused(err);
        if (refused) {
            this.status.rejected = true;
            this.status.error = PEER_REFUSED[refused];
            logError(this.id, `REFUSED by linked server ${refused}`);
            this.disconnect('refused');
            return;
        }

        const code = tlsCode(err);
        if (code) {
            const peer = (err as { cert?: { subjectaltname?: string } } | undefined)?.cert;
            this.status.rejected = true;
            this.status.error = code === 'ERR_TLS_CERT_ALTNAME_INVALID'
                ? altnameMessage(peer?.subjectaltname, this.row.expected_name)
                : `TLS pin failed: ${code}`;
            logError(this.id, `REJECTED ${code}`);
            this.disconnect('rejected');
            return;
        }

        if (wasConnected || !this.retry) logError(this.id, `down ${why}`);
        if (this.retry || this.status.rejected || !this.tak) return;
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, RETRY_MAX_MS);
        this.retry = setTimeout(() => {
            this.retry = undefined;
            const tak = this.tak;
            if (!tak || this.status.rejected) return;
            tak.reconnect().catch((e: unknown) => this.down(`reconnect failed ${safeMessage(e)}`, e));
        }, delay);
    }

    disconnect(why: string): void {
        this.generation++;
        this.connecting = false;
        if (this.retry) {
            clearTimeout(this.retry);
            this.retry = undefined;
        }
        const tak = this.tak;
        this.tak = undefined;
        this.pending.clear();
        if (tak) {
            try { tak.removeAllListeners(); } catch { /* ignore */ }
            try { tak.destroy(); } catch { /* ignore */ }
            log(this.id, `disconnected (${why})`);
        }
        this.status.connected = false;
        this.status.verified = false;
        if (why === 'idle') this.status.error = null;
    }

    // W11: a ready-made CoT on this socket (own position). Silently skipped while down.
    async writeCot(cot: CoT): Promise<boolean> {
        const tak = this.tak;
        if (!tak || !this.status.verified) return false;
        await tak.write([cot]);
        return true;
    }

    // W6: one feature to this server, as the link owner's identity.
    // W12: always addressed (a person, a team's members, or a feed); never a bare broadcast.
    async send(feature: Record<string, unknown>, dests: Array<{ uid?: string; mission?: string }>): Promise<void> {
        const tak = this.tak;
        if (!tak || !this.status.verified) throw new Err(503, null, `${this.row.name} is not connected`);
        if (!dests.length) throw new Err(400, null, 'Choose who to send to');
        const cot = await CoTParser.from_geojson(feature as Parameters<typeof CoTParser.from_geojson>[0]);
        for (const d of dests) cot.addDest(d);
        await tak.write([cot]);
    }
}

class Manager {
    config: ConfigStateless;
    streams: Map<number, Stream>;
    // Link owners who are on the map right now (D2: per user).
    recipients: Set<string>;
    // When each owner was last seen on the map, for the idle grace (W7).
    private lastActive: Map<string, number>;
    private presenceTimer?: ReturnType<typeof setInterval>;
    private flushTimer?: ReturnType<typeof setInterval>;
    private sweepTimer?: ReturnType<typeof setInterval>;
    // Owners whose CloudTAK profile is disabled: their links stay but never open.
    private disabled: Set<string>;
    // W11: each owner's latest own-position CoT, re-sent when one of their links (re)connects.
    private selfCot: Map<string, { cot: CoT; at: number }>;
    // W13: subscribed Data Sync feeds per link. The token is the linked server's mission
    // token for this subscription: a secret, never returned or logged.
    missions: Map<number, Map<string, { guid: string | null; token: string | null }>>;
    private missionTimer?: ReturnType<typeof setInterval>;
    private missionDebounce: Map<string, ReturnType<typeof setTimeout>>;
    private polling: boolean;
    // A poll asked for while one is running (e.g. a new link): run once more right after.
    private pollAgain: boolean;

    constructor(config: ConfigStateless) {
        this.config = config;
        this.streams = new Map();
        this.recipients = new Set();
        this.lastActive = new Map();
        this.disabled = new Set();
        this.selfCot = new Map();
        this.missions = new Map();
        this.missionDebounce = new Map();
        this.polling = false;
        this.pollAgain = false;
    }

    async load(): Promise<void> {
        const rows = await query<ServerRow>(this.config, sql`${SELECT_ROW} ORDER BY id`);
        for (const r of rows) this.streams.set(r.id, this.wire(new Stream(normalizeRow(r))));
        const subs = await query<{ link_id: number; name: string; guid: string | null; token: string | null }>(this.config, sql`
            SELECT link_id, name, guid, token FROM crosstak_mission
        `);
        for (const m of subs) this.missionsOf(m.link_id).set(m.name, { guid: m.guid, token: m.token });
        log('*', `loaded ${rows.length} linked server(s), ${subs.length} feed subscription(s)`);
    }

    start(): void {
        this.presenceTimer = setInterval(() => {
            this.poll().catch((err) => logError('*', `presence poll failed ${safeMessage(err)}`));
        }, PRESENCE_POLL_MS);
        this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
        this.sweepTimer = setInterval(() => {
            this.sweep().catch((err) => logError('*', `leaver sweep failed ${safeMessage(err)}`));
        }, SWEEP_MS);
        // Don't keep a shutting-down process alive for our timers.
        this.presenceTimer.unref();
        this.flushTimer.unref();
        this.sweepTimer.unref();
        this.missionTimer = setInterval(() => this.refreshAllMissions(), MISSION_REFRESH_MS);
        this.missionTimer.unref();
        this.sweep().catch((err) => logError('*', `leaver sweep failed ${safeMessage(err)}`));
        this.poll().catch((err) => logError('*', `presence poll failed ${safeMessage(err)}`));
    }

    private owners(): string[] {
        const set = new Set<string>();
        for (const s of this.streams.values()) if (s.row.owner) set.add(s.row.owner);
        return [...set];
    }

    // W7 + D2: a link is open while its owner is on the map.
    async poll(): Promise<void> {
        if (this.polling) {
            this.pollAgain = true;
            return;
        }
        this.polling = true;
        try {
            const owners = this.owners();
            const next = new Set<string>();
            if (owners.length) {
                const presence = await this.config.hub.wsPresence(owners);
                for (const [username, p] of Object.entries(presence)) {
                    if (p && p.active) next.add(username);
                }
            }
            const now = Date.now();
            for (const u of next) this.lastActive.set(u, now);
            for (const u of [...this.lastActive.keys()]) {
                if (!owners.includes(u)) this.lastActive.delete(u);
            }
            this.recipients = next;
            this.reconcile();
        } finally {
            this.polling = false;
        }
        if (this.pollAgain) {
            this.pollAgain = false;
            await this.poll();
        }
    }

    // Leavers (PLAN §10, 2026-11-17): a link whose owner no longer has a CloudTAK profile is
    // deleted with its stored certificate (TAK Portal erases the profile when it removes a
    // user: ValleyTacticalSolutions/TAK-Portal#132; an admin can also erase it in CloudTAK).
    // A disabled profile keeps its links but they never open (the person may come back).
    async sweep(): Promise<void> {
        const owners = this.owners();
        if (!owners.length) {
            this.disabled = new Set();
            return;
        }
        const rows = await query<{ username: string; disabled: boolean | null }>(this.config, sql`
            SELECT username, disabled FROM profile
        `);
        const known = new Map(rows.map((r) => [r.username, !!r.disabled]));
        this.disabled = new Set(owners.filter((o) => known.get(o) === true));
        const gone = owners.filter((o) => !known.has(o));
        for (const owner of gone) {
            const ids = [...this.streams.values()].filter((s) => s.row.owner === owner).map((s) => s.id);
            await this.config.pg.execute(sql`DELETE FROM crosstak_server WHERE owner = ${owner}`);
            for (const id of ids) this.remove(id);
            this.selfCot.delete(owner);
            log('*', `removed ${ids.length} link(s) of ${owner}: CloudTAK profile no longer exists`);
        }
        this.reconcile();
    }

    private ownerActive(owner: string | null): boolean {
        if (!owner || this.disabled.has(owner)) return false;
        if (this.recipients.has(owner)) return true;
        const at = this.lastActive.get(owner);
        return !!at && Date.now() - at < IDLE_DISCONNECT_MS;
    }

    reconcile(): void {
        for (const s of this.streams.values()) {
            const wanted = s.row.enabled && !!s.row.auth && this.ownerActive(s.row.owner);
            if (wanted && !s.tak) {
                s.connect();
            } else if (!wanted && s.tak) {
                s.disconnect(s.row.enabled ? 'idle' : 'disabled');
            }
        }
    }

    // W3 step 7 + D2: newest feature per id, one wsNotify to the link's owner per feature.
    flush(): void {
        for (const s of this.streams.values()) {
            if (!s.pending.size) continue;
            const feats = [...s.pending.values()];
            s.pending.clear();
            // A link switched off sends nothing more: its markers were just cleared from the map.
            if (!s.row.enabled) continue;
            const owner = s.row.owner;
            if (!owner || !this.recipients.has(owner)) continue;
            for (const feat of feats) {
                const payload = { type: 'cot', connection: s.wsConnection, data: feat };
                this.config.hub.wsNotify(owner, payload).catch((err) => {
                    logError(s.id, `wsNotify failed ${safeMessage(err)}`);
                });
            }
        }
    }

    get(id: number): Stream {
        const s = this.streams.get(id);
        if (!s) throw new Err(404, null, 'Linked server not found');
        return s;
    }

    // D2: a user reaches only their own links. Someone else's link answers 404, the same as
    // a link that does not exist, so ids reveal nothing.
    mine(id: number, username: string): Stream {
        const s = this.streams.get(id);
        if (!s || s.row.owner !== username) throw new Err(404, null, 'Linked server not found');
        return s;
    }

    ownedBy(username: string): Stream[] {
        return [...this.streams.values()].filter((s) => s.row.owner === username);
    }

    private wire(s: Stream): Stream {
        s.onReady = (ready) => {
            const owner = ready.row.owner;
            const self = owner ? this.selfCot.get(owner) : undefined;
            if (self && Date.now() - self.at <= SELF_STALE_MS) {
                ready.writeCot(self.cot).catch((err) => logError(ready.id, `own position failed ${safeMessage(err)}`));
            }
            for (const name of this.missionsOf(ready.id).keys()) this.scheduleMission(ready, name, 0);
        };
        s.onMissionChange = (changed, name) => {
            if (this.missionsOf(changed.id).has(name)) this.scheduleMission(changed, name, MISSION_DEBOUNCE_MS);
        };
        return s;
    }

    missionsOf(id: number): Map<string, { guid: string | null; token: string | null }> {
        let m = this.missions.get(id);
        if (!m) {
            m = new Map();
            this.missions.set(id, m);
        }
        return m;
    }

    scheduleMission(s: Stream, name: string, delay: number): void {
        const key = `${s.id}|${name}`;
        const prev = this.missionDebounce.get(key);
        if (prev) clearTimeout(prev);
        const t = setTimeout(() => {
            this.missionDebounce.delete(key);
            this.pushMission(s, name).catch((err) => logError(s.id, `feed "${name}" load failed ${safeMessage(err)}`));
        }, delay);
        if (typeof t === 'object' && t && 'unref' in t) (t as { unref: () => void }).unref();
        this.missionDebounce.set(key, t);
    }

    // W13: the feed's current contents onto the owner's map (only while they are online).
    async pushMission(s: Stream, name: string): Promise<number> {
        const sub = this.missionsOf(s.id).get(name);
        const owner = s.row.owner;
        if (!sub || !owner || !this.recipients.has(owner)) return 0;
        const res = await withChannelApi(s.row, async (api) => await api.Mission.latestFeats(name, sub.token ? { token: sub.token } : {}));
        if (!s.row.enabled) return 0; // switched off while the feed was loading
        const minStale = Date.now() + MISSION_STALE_MS;
        let n = 0;
        for (const feat of (res && res.features) || []) {
            const f = feat as GeoJSONFeature;
            if (!f || !f.properties) continue;
            const type = String(f.properties.type || '');
            if (type.startsWith('b-f-t') || type.startsWith('t-x')) continue;
            const stale = typeof f.properties.stale === 'string' ? Date.parse(f.properties.stale) : NaN;
            if (Number.isNaN(stale) || stale < minStale) f.properties.stale = new Date(minStale).toISOString();
            const id = tagLinked(s.row, f, name);
            s.pending.set(id, f);
            n++;
        }
        log(s.id, `feed "${name}": ${n} item(s) loaded`);
        return n;
    }

    private refreshAllMissions(): void {
        for (const s of this.streams.values()) {
            if (!s.status.verified || !s.row.owner || !this.recipients.has(s.row.owner)) continue;
            for (const name of this.missionsOf(s.id).keys()) this.scheduleMission(s, name, 0);
        }
    }

    // W11: the owner's own position, on every link of theirs that is connected.
    async reportSelf(owner: string, cot: CoT): Promise<number> {
        const last = this.selfCot.get(owner);
        if (last && Date.now() - last.at < SELF_MIN_MS) return 0;
        this.selfCot.set(owner, { cot, at: Date.now() });
        let sent = 0;
        for (const s of this.ownedBy(owner)) {
            try {
                if (await s.writeCot(cot)) sent++;
            } catch (err) {
                logError(s.id, `own position failed ${safeMessage(err)}`);
            }
        }
        return sent;
    }

    add(row: ServerRow): Stream {
        const s = this.wire(new Stream(row));
        this.streams.set(row.id, s);
        // The owner may not be in the presence set yet (first link): ask now, not in 15 s.
        this.poll().catch((err) => logError('*', `presence poll failed ${safeMessage(err)}`));
        return s;
    }

    replace(row: ServerRow): Stream {
        const s = this.get(row.id);
        s.update(row);
        this.reconcile();
        return s;
    }

    remove(id: number): void {
        this.missions.delete(id);
        const s = this.streams.get(id);
        if (!s) return;
        s.disconnect('deleted');
        this.streams.delete(id);
    }
}

// ── Public view (never ca/auth) ─────────────────────────────────────────────────────────

const CertSummarySchema = Type.Object({
    subject: Type.String(),
    issuer: Type.String(),
    valid_to: Type.String(),
    channels: Type.Boolean(),
});

const PublicServer = Type.Object({
    id: Type.Integer(),
    name: Type.String(),
    url: Type.String(),
    api: Type.Union([Type.String(), Type.Null()]),
    webtak: Type.Union([Type.String(), Type.Null()]),
    expected_name: Type.Union([Type.String(), Type.Null()]),
    enabled: Type.Boolean(),
    created: Type.String(),
    updated: Type.String(),
    created_by: Type.Union([Type.String(), Type.Null()]),
    enrolled_by: Type.Union([Type.String(), Type.Null()]),
    enrolled_at: Type.Union([Type.String(), Type.Null()]),
    owner: Type.Union([Type.String(), Type.Null()]),
    has_auth: Type.Boolean(),
    cert: Type.Union([CertSummarySchema, Type.Null()]),
    ca: Type.Array(CertSummarySchema),
    status: Type.Object({
        connected: Type.Boolean(),
        verified: Type.Boolean(),
        since: Type.Union([Type.String(), Type.Null()]),
        last_cot: Type.Union([Type.String(), Type.Null()]),
        cots: Type.Integer(),
        error: Type.Union([Type.String(), Type.Null()]),
        rejected: Type.Boolean(),
    }),
});

const ChannelList = Type.Object({
    items: Type.Array(Type.Object({
        name: Type.String(),
        description: Type.Union([Type.String(), Type.Null()]),
        active: Type.Boolean(),
        in: Type.Boolean(),
        out: Type.Boolean(),
    })),
    can_switch: Type.Boolean(),
});

function publicView(s: Stream) {
    const r = s.row;
    return {
        id: r.id,
        name: r.name,
        url: r.url,
        api: r.api,
        webtak: r.webtak,
        expected_name: r.expected_name,
        enabled: r.enabled,
        created: String(r.created),
        updated: String(r.updated),
        created_by: r.created_by,
        enrolled_by: r.enrolled_by,
        enrolled_at: r.enrolled_at ? String(r.enrolled_at) : null,
        owner: r.owner,
        has_auth: !!r.auth,
        cert: s.certSummary,
        ca: s.caSummary,
        status: { ...s.status },
    };
}

async function readRow(config: ConfigStateless, id: number): Promise<ServerRow> {
    const rows = await query<ServerRow>(config, sql`${SELECT_ROW} WHERE id = ${id}`);
    if (!rows.length) throw new Err(404, null, 'Linked server not found');
    return normalizeRow(rows[0]);
}

// ── Router ──────────────────────────────────────────────────────────────────────────────

export default async function router(schema: Schema, config: ConfigStateless) {
    const manager = new Manager(config);
    let ready = false;

    // Idempotent schema bootstrap, best-effort: a DB hiccup must not block CloudTAK startup.
    try {
        // D1 (2026-11-17): the plugin is CrossTAK again. Carry tables from the CrossLink
        // builds over once (links, certificates and joined feeds survive the rename).
        await config.pg.execute(sql`
            DO $$
            BEGIN
                IF to_regclass('public.crosslink_server') IS NOT NULL AND to_regclass('public.crosstak_server') IS NULL THEN
                    ALTER TABLE crosslink_server RENAME TO crosstak_server;
                    IF to_regclass('public.crosslink_server_id_seq') IS NOT NULL THEN
                        ALTER SEQUENCE crosslink_server_id_seq RENAME TO crosstak_server_id_seq;
                    END IF;
                    IF to_regclass('public.crosslink_server_owner') IS NOT NULL THEN
                        ALTER INDEX crosslink_server_owner RENAME TO crosstak_server_owner;
                    END IF;
                END IF;
                IF to_regclass('public.crosslink_mission') IS NOT NULL AND to_regclass('public.crosstak_mission') IS NULL THEN
                    ALTER TABLE crosslink_mission RENAME TO crosstak_mission;
                END IF;
            END $$
        `);
        await config.pg.execute(sql`
            CREATE TABLE IF NOT EXISTS crosstak_server (
                id            SERIAL PRIMARY KEY,
                name          TEXT NOT NULL,
                url           TEXT NOT NULL,
                api           TEXT,
                webtak        TEXT,
                expected_name TEXT,
                ca            TEXT NOT NULL,
                auth          JSONB,
                enabled       BOOLEAN NOT NULL DEFAULT TRUE,
                always_on     BOOLEAN NOT NULL DEFAULT FALSE,
                created       TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated       TIMESTAMPTZ NOT NULL DEFAULT now(),
                created_by    TEXT,
                enrolled_by   TEXT,
                enrolled_at   TIMESTAMPTZ
            )
        `);
        // D2 (2026-11-17): per-user links. Rows from the shared-agency build belong to whoever
        // made them. always_on stays as a column but is no longer read (D3 note in the PLAN).
        await config.pg.execute(sql`ALTER TABLE crosstak_server ADD COLUMN IF NOT EXISTS owner TEXT`);
        await config.pg.execute(sql`UPDATE crosstak_server SET owner = created_by WHERE owner IS NULL`);
        await config.pg.execute(sql`CREATE INDEX IF NOT EXISTS crosstak_server_owner ON crosstak_server (owner)`);
        // W13: Data Sync feeds a link's owner follows on that linked server.
        await config.pg.execute(sql`
            CREATE TABLE IF NOT EXISTS crosstak_mission (
                link_id    INTEGER NOT NULL REFERENCES crosstak_server (id) ON DELETE CASCADE,
                name       TEXT NOT NULL,
                guid       TEXT,
                token      TEXT,
                subscribed TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (link_id, name)
            )
        `);
        await manager.load();
        ready = true;
    } catch (err) {
        logError('*', `bootstrap failed, routes will answer 503 until restart: ${safeMessage(err)}`);
    }

    // Never awaited, never throws: a broken linked row logs and the rest of CloudTAK boots.
    if (ready) {
        try {
            manager.start();
        } catch (err) {
            logError('*', `stream manager failed to start ${safeMessage(err)}`);
        }
    }

    const requireReady = () => {
        if (!ready) throw new Err(503, null, 'CrossTAK failed to initialise its table at boot; see the API log');
    };

    await schema.get('/crosstak/health', {
        name: 'CrossTAK Health',
        group: 'CrossTAK',
        description: 'Confirms the CrossTAK server route is installed and loaded',
        res: Type.Object({
            version: Type.String(),
            ready: Type.Boolean(),
            servers: Type.Integer({ description: 'Your own linked servers' }),
            online: Type.Boolean({ description: 'Whether CrossTAK sees you on the map (your links stream only then)' }),
        }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            res.json({ version: VERSION, ready, servers: manager.ownedBy(user.email).length, online: manager.recipients.has(user.email) });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/crosstak/server', {
        name: 'List Linked Servers',
        group: 'CrossTAK',
        description: 'List your own linked TAK Servers with live stream status. Never returns certificate bodies.',
        res: Type.Object({
            total: Type.Integer(),
            items: Type.Array(PublicServer),
        }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const items = manager.ownedBy(user.email).map(publicView);
            res.json({ total: items.length, items });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/crosstak/link', {
        name: 'Link a TAK Server',
        group: 'CrossTAK',
        description: 'Link a TAK Server by address with your own username/password on it. Enrolls over 8446 (verified against a public CA, or the given CA), pins the CA the server returns for 8089/8443, and stores the certificate issued to you. The link is yours only. The password is used once and never stored.',
        body: Type.Object({
            host: Type.String({ description: 'e.g. takserver.agency.org' }),
            username: Type.String({ minLength: 1 }),
            password: Type.String({ minLength: 1 }),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
            expected_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            ca: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }),
        res: PublicServer,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const host = hostOf(req.body.host);
            const name = (req.body.name || '').trim() || host;
            const expected_name = validateHostname(req.body.expected_name);
            const pinned = req.body.ca ? validateCA(req.body.ca) : null;
            const url = `ssl://${host}:8089`;
            const api = `https://${host}:8443`;
            const webtak = `https://${host}:8446`;

            const enrolled = await enroll(webtak, req.body.username, req.body.password, pinned, expected_name);

            const rows = await query<{ id: number }>(config, sql`
                INSERT INTO crosstak_server (name, url, api, webtak, expected_name, ca, auth, enabled, always_on, created_by, enrolled_by, enrolled_at, owner)
                VALUES (${name}, ${url}, ${api}, ${webtak}, ${expected_name}, ${enrolled.ca},
                        ${JSON.stringify(enrolled.auth)}::jsonb, true, false, ${user.email},
                        ${user.email}, now(), ${user.email})
                RETURNING id
            `);
            const row = await readRow(config, rows[0].id);
            log(row.id, `linked "${row.name}" as "${req.body.username}" by ${user.email}`);
            res.json(publicView(manager.add(row)));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/crosstak/server', {
        name: 'Create Linked Server',
        group: 'CrossTAK',
        description: 'Register your own linked TAK Server from PEMs. The CA is required and is pinned on that server\'s sockets only. cert/key are optional here; enroll later instead.',
        body: Type.Object({
            name: Type.String({ minLength: 1, maxLength: 80 }),
            url: Type.String({ description: 'ssl://host:8089' }),
            api: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            webtak: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            expected_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            ca: Type.String(),
            cert: Type.Optional(Type.String()),
            key: Type.Optional(Type.String()),
            enabled: Type.Optional(Type.Boolean()),
        }),
        res: PublicServer,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const url = validateUrl(req.body.url, 'url', ['ssl:']);
            const api = req.body.api ? validateUrl(req.body.api, 'api', ['https:']) : null;
            const webtak = req.body.webtak ? validateUrl(req.body.webtak, 'webtak', ['https:']) : null;
            const expected_name = validateHostname(req.body.expected_name);
            const ca = validateCA(req.body.ca);
            if ((req.body.cert && !req.body.key) || (!req.body.cert && req.body.key)) {
                throw new Err(400, null, 'cert and key must be supplied together');
            }
            const auth = req.body.cert ? validateAuth(req.body.cert, req.body.key) : null;
            const enabled = req.body.enabled ?? true;

            const rows = await query<{ id: number }>(config, sql`
                INSERT INTO crosstak_server (name, url, api, webtak, expected_name, ca, auth, enabled, always_on, created_by, enrolled_by, enrolled_at, owner)
                VALUES (${req.body.name}, ${url}, ${api}, ${webtak}, ${expected_name}, ${ca},
                        ${auth ? JSON.stringify(auth) : null}::jsonb, ${enabled}, false, ${user.email},
                        ${auth ? user.email : null}, ${auth ? sql`now()` : null}, ${user.email})
                RETURNING id
            `);
            const row = await readRow(config, rows[0].id);
            log(row.id, `created "${row.name}" by ${user.email}`);
            res.json(publicView(manager.add(row)));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/crosstak/server/:id', {
        name: 'Get Linked Server',
        group: 'CrossTAK',
        description: 'One linked TAK Server with live stream status',
        params: Type.Object({ id: Type.Integer() }),
        res: PublicServer,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            res.json(publicView(manager.mine(req.params.id, user.email)));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.patch('/crosstak/server/:id', {
        name: 'Update Linked Server',
        group: 'CrossTAK',
        description: 'Update one of your linked TAK Servers. Changing url, ca, expected_name or cert/key restarts its stream.',
        params: Type.Object({ id: Type.Integer() }),
        body: Type.Object({
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
            url: Type.Optional(Type.String()),
            api: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            webtak: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            expected_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            ca: Type.Optional(Type.String()),
            cert: Type.Optional(Type.String()),
            key: Type.Optional(Type.String()),
            enabled: Type.Optional(Type.Boolean()),
        }),
        res: PublicServer,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const current = manager.mine(req.params.id, user.email).row;
            const b = req.body;

            const name = b.name ?? current.name;
            const url = b.url !== undefined ? validateUrl(b.url, 'url', ['ssl:']) : current.url;
            const api = b.api !== undefined ? (b.api ? validateUrl(b.api, 'api', ['https:']) : null) : current.api;
            const webtak = b.webtak !== undefined ? (b.webtak ? validateUrl(b.webtak, 'webtak', ['https:']) : null) : current.webtak;
            const expected_name = b.expected_name !== undefined ? validateHostname(b.expected_name) : current.expected_name;
            const ca = b.ca !== undefined ? validateCA(b.ca) : current.ca;
            if ((b.cert && !b.key) || (!b.cert && b.key)) throw new Err(400, null, 'cert and key must be supplied together');
            const auth = b.cert ? validateAuth(b.cert, b.key) : current.auth;
            const enabled = b.enabled ?? current.enabled;
            const reEnrolled = !!b.cert;

            await config.pg.execute(sql`
                UPDATE crosstak_server SET
                    name = ${name}, url = ${url}, api = ${api}, webtak = ${webtak}, expected_name = ${expected_name},
                    ca = ${ca}, auth = ${auth ? JSON.stringify(auth) : null}::jsonb,
                    enabled = ${enabled}, updated = now(),
                    enrolled_by = ${reEnrolled ? user.email : current.enrolled_by},
                    enrolled_at = ${reEnrolled ? sql`now()` : current.enrolled_at}
                WHERE id = ${req.params.id}
            `);
            const row = await readRow(config, req.params.id);
            log(row.id, `updated by ${user.email}`);
            res.json(publicView(manager.replace(row)));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.delete('/crosstak/server/:id', {
        name: 'Delete Linked Server',
        group: 'CrossTAK',
        description: 'Close the stream and delete one of your linked TAK Servers, with its stored certificate',
        params: Type.Object({ id: Type.Integer() }),
        res: Type.Object({ status: Type.Integer(), message: Type.String() }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const s = manager.mine(req.params.id, user.email);
            manager.remove(s.id);
            await config.pg.execute(sql`DELETE FROM crosstak_server WHERE id = ${req.params.id}`);
            log(s.id, `deleted by ${user.email}`);
            res.json({ status: 200, message: 'Linked server deleted' });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/crosstak/server/:id/enroll', {
        name: 'Enroll on Linked Server',
        group: 'CrossTAK',
        description: 'Replace your client certificate on one of your linked servers by enrolling with your username/password there. The password is used once and never stored.',
        params: Type.Object({ id: Type.Integer() }),
        body: Type.Object({
            username: Type.String({ minLength: 1 }),
            password: Type.String({ minLength: 1 }),
        }),
        res: PublicServer,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const current = manager.mine(req.params.id, user.email).row;
            let webtak = current.webtak;
            if (!webtak) {
                try { webtak = `https://${new URL(current.url).hostname}:8446`; } catch { webtak = null; }
            }
            if (!webtak) throw new Err(400, null, 'Set the enrollment URL (https://host:8446) on this server before enrolling');

            const enrolled = await enroll(webtak, req.body.username, req.body.password, current.ca, current.expected_name);

            await config.pg.execute(sql`
                UPDATE crosstak_server SET
                    auth = ${JSON.stringify(enrolled.auth)}::jsonb, webtak = ${webtak},
                    enrolled_by = ${user.email}, enrolled_at = now(), updated = now()
                WHERE id = ${req.params.id}
            `);
            const row = await readRow(config, req.params.id);
            log(row.id, `enrolled as "${req.body.username}" by ${user.email}`);
            res.json(publicView(manager.replace(row)));
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/crosstak/server/:id/channel', {
        name: 'List Linked Channels',
        group: 'CrossTAK',
        description: 'Channels (TAK Server groups) your identity belongs to on one of your linked servers, with which are active',
        params: Type.Object({ id: Type.Integer() }),
        res: ChannelList,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const s = manager.mine(req.params.id, user.email);
            const items = await withChannelApi(s.row, async (api) => channelView(await listGroups(api)));
            res.json({ items, can_switch: !!s.certSummary?.channels });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.put('/crosstak/server/:id/channel', {
        name: 'Set Linked Channels',
        group: 'CrossTAK',
        description: 'Choose which of your channels are active on one of your linked servers. Affects only you.',
        params: Type.Object({ id: Type.Integer() }),
        body: Type.Object({
            active: Type.Array(Type.String(), { minItems: 1 }),
        }),
        res: ChannelList,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const s = manager.mine(req.params.id, user.email);
            const wanted = new Set(req.body.active);
            const items = await withChannelApi(s.row, async (api) => {
                const groups = await listGroups(api);
                const known = new Set(groups.map((g) => g.name));
                for (const n of wanted) {
                    if (!known.has(n)) throw new Err(400, null, `Not a channel of this identity: ${n}`);
                }
                await api.Group.update(groups.map((g) => ({ ...g, active: wanted.has(g.name) })) as any, {});
                return channelView(await listGroups(api));
            });
            log(s.id, `channels set to [${[...wanted].join(', ')}] by ${user.email}`);
            res.json({ items, can_switch: !!s.certSummary?.channels });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    // W12: who is on that server, as seen with your certificate.
    const ContactList = Type.Object({
        self_uid: Type.String(),
        items: Type.Array(Type.Object({
            uid: Type.String(),
            callsign: Type.String(),
            team: Type.String(),
            role: Type.String(),
            self: Type.Boolean(),
        })),
    });

    async function contactsOf(s: Stream): Promise<Array<{ uid: string; callsign: string; team: string; role: string }>> {
        const list = await withChannelApi(s.row, async (api) => await api.Contacts.list());
        return (list || [])
            .filter((c) => c && typeof c.uid === 'string' && c.uid)
            .map((c) => ({ uid: c.uid, callsign: c.callsign || c.uid, team: c.team || '', role: c.role || '' }));
    }

    await schema.get('/crosstak/server/:id/contact', {
        name: 'List Linked Contacts',
        group: 'CrossTAK',
        description: 'People on one of your linked servers (its contact list, as your certificate sees it). Yours is marked self once your position has reached that server.',
        params: Type.Object({ id: Type.Integer() }),
        res: ContactList,
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const s = manager.mine(req.params.id, user.email);
            const self_uid = `ANDROID-CloudTAK-${user.email}`;
            const items = (await contactsOf(s))
                .map((c) => ({ ...c, self: c.uid === self_uid }))
                .sort((a, b) => a.callsign.localeCompare(b.callsign));
            res.json({ self_uid, items });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    // W13: Data Sync feeds on one of your links, as your certificate sees them.
    const MissionItem = Type.Object({
        name: Type.String(),
        guid: Type.Union([Type.String(), Type.Null()]),
        description: Type.String(),
        keywords: Type.Array(Type.String()),
        locked: Type.Boolean({ description: 'Password protected (not supported yet)' }),
        subscribed: Type.Boolean(),
    });

    await schema.get('/crosstak/server/:id/mission', {
        name: 'List Linked Feeds',
        group: 'CrossTAK',
        description: 'Data Sync feeds (missions) on one of your linked servers that your account can see, and which you have joined.',
        params: Type.Object({ id: Type.Integer() }),
        res: Type.Object({ items: Type.Array(MissionItem) }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const s = manager.mine(req.params.id, user.email);
            const subs = manager.missionsOf(s.id);
            const list = await withChannelApi(s.row, async (api) => await api.Mission.list({}));
            const seen = new Set<string>();
            const items = [];
            for (const m of ((list && list.data) || []) as Array<Record<string, unknown>>) {
                const name = typeof m.name === 'string' ? m.name : '';
                if (!name || seen.has(name)) continue;
                seen.add(name);
                items.push({
                    name,
                    guid: typeof m.guid === 'string' ? m.guid : null,
                    description: typeof m.description === 'string' ? m.description : '',
                    keywords: Array.isArray(m.keywords) ? (m.keywords as unknown[]).map(String) : [],
                    locked: m.passwordProtected === true,
                    subscribed: subs.has(name),
                });
            }
            // A followed feed that no longer lists (deleted, or access removed) still shows, so it can be dropped.
            for (const name of subs.keys()) {
                if (!seen.has(name)) items.push({ name, guid: subs.get(name)?.guid ?? null, description: '(no longer listed on this server)', keywords: [], locked: false, subscribed: true });
            }
            items.sort((a, b) => Number(b.subscribed) - Number(a.subscribed) || a.name.localeCompare(b.name));
            res.json({ items });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.put('/crosstak/server/:id/mission/:name', {
        name: 'Join Linked Feed',
        group: 'CrossTAK',
        description: 'Subscribe to a Data Sync feed on one of your linked servers, as you, and load its contents onto your map. Changes follow live while you are online.',
        params: Type.Object({ id: Type.Integer(), name: Type.String({ minLength: 1, maxLength: 512 }) }),
        res: Type.Object({ status: Type.Integer(), message: Type.String(), items: Type.Integer() }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const s = manager.mine(req.params.id, user.email);
            const name = req.params.name;
            const uid = `ANDROID-CloudTAK-${user.email}`;
            const sub = await withChannelApi(s.row, async (api) => await api.Mission.subscribe(name, { uid }));
            const data = (sub && (sub as { data?: Record<string, unknown> }).data) || {};
            const token = typeof data.token === 'string' ? data.token : null;
            const mission = data.mission as { guid?: unknown } | undefined;
            const guid = mission && typeof mission.guid === 'string' ? mission.guid : null;
            await config.pg.execute(sql`
                INSERT INTO crosstak_mission (link_id, name, guid, token) VALUES (${s.id}, ${name}, ${guid}, ${token})
                ON CONFLICT (link_id, name) DO UPDATE SET guid = EXCLUDED.guid, token = EXCLUDED.token, subscribed = now()
            `);
            manager.missionsOf(s.id).set(name, { guid, token });
            const n = await manager.pushMission(s, name);
            log(s.id, `joined feed "${name}" (${user.email})`);
            res.json({ status: 200, message: `Joined ${name} on ${s.row.name}`, items: n });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/crosstak/server/:id/mission/:name', {
        name: 'List Linked Feed Items',
        group: 'CrossTAK',
        description: 'The current items of a Data Sync feed you have joined on one of your linked servers (id as it appears on your map, callsign, type, position).',
        params: Type.Object({ id: Type.Integer(), name: Type.String({ minLength: 1, maxLength: 512 }) }),
        res: Type.Object({
            items: Type.Array(Type.Object({
                id: Type.String(),
                callsign: Type.String(),
                type: Type.String(),
                center: Type.Union([Type.Array(Type.Number()), Type.Null()]),
            })),
        }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const s = manager.mine(req.params.id, user.email);
            const sub = manager.missionsOf(s.id).get(req.params.name);
            if (!sub) throw new Err(404, null, 'You have not joined this feed');
            const r = await withChannelApi(s.row, async (api) => await api.Mission.latestFeats(req.params.name, sub.token ? { token: sub.token } : {}));
            const items = [];
            for (const feat of (r && r.features) || []) {
                const f = feat as GeoJSONFeature;
                if (!f || !f.properties) continue;
                const type = String(f.properties.type || '');
                if (type.startsWith('b-f-t') || type.startsWith('t-x')) continue;
                const c = (f.properties as { center?: unknown }).center;
                items.push({
                    id: `${TAG}:${s.id}:${String(f.id)}`,
                    callsign: String(f.properties.callsign || f.id),
                    type,
                    center: Array.isArray(c) && c.length >= 2 ? [Number(c[0]), Number(c[1])] : null,
                });
            }
            items.sort((a, b) => a.callsign.localeCompare(b.callsign));
            res.json({ items });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.delete('/crosstak/server/:id/mission/:name', {
        name: 'Leave Linked Feed',
        group: 'CrossTAK',
        description: 'Unsubscribe from a Data Sync feed on one of your linked servers. Its items leave your map (the pane removes them).',
        params: Type.Object({ id: Type.Integer(), name: Type.String({ minLength: 1, maxLength: 512 }) }),
        res: Type.Object({ status: Type.Integer(), message: Type.String() }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const s = manager.mine(req.params.id, user.email);
            const name = req.params.name;
            const sub = manager.missionsOf(s.id).get(name);
            try {
                await withChannelApi(s.row, async (api) => await api.Mission.unsubscribe(name, { uid: `ANDROID-CloudTAK-${user.email}` }, sub && sub.token ? { token: sub.token } : {}));
            } catch (err) {
                // Gone on their side already: still drop it here.
                logError(s.id, `unsubscribe "${name}" on the linked server failed ${safeMessage(err)}`);
            }
            await config.pg.execute(sql`DELETE FROM crosstak_mission WHERE link_id = ${s.id} AND name = ${name}`);
            manager.missionsOf(s.id).delete(name);
            log(s.id, `left feed "${name}" (${user.email})`);
            res.json({ status: 200, message: `Left ${name}` });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.get('/crosstak/status', {
        name: 'Linked Stream Status',
        group: 'CrossTAK',
        description: 'Live status of your own linked streams',
        res: Type.Object({
            online: Type.Boolean({ description: 'Whether CrossTAK sees you on the map (your links stream only then)' }),
            items: Type.Array(Type.Object({
                id: Type.Integer(),
                name: Type.String(),
                enabled: Type.Boolean(),
                connected: Type.Boolean(),
                verified: Type.Boolean(),
                since: Type.Union([Type.String(), Type.Null()]),
                last_cot: Type.Union([Type.String(), Type.Null()]),
                cots: Type.Integer(),
                error: Type.Union([Type.String(), Type.Null()]),
                rejected: Type.Boolean(),
            })),
        }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            res.json({
                online: manager.recipients.has(user.email),
                items: manager.ownedBy(user.email).map((s) => ({
                    id: s.id, name: s.row.name, enabled: s.row.enabled, ...s.status,
                })),
            });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    // W11: own position. Fields mirror CloudTAK's /profile/location body.
    const settingKeys = ['tak::callsign', 'tak::group', 'tak::role', 'tak::remarks', 'tak::phone'];
    await schema.post('/crosstak/self', {
        name: 'Report Own Position to Linked Servers',
        group: 'CrossTAK',
        description: 'Send your own position (as your TAK team-member PLI, uid ANDROID-CloudTAK-<username>) on every one of your connected links, so the people on those servers see you. At most one per ~10 s; extra calls are accepted and ignored.',
        body: Type.Object({
            longitude: Type.Number({ minimum: -180, maximum: 180 }),
            latitude: Type.Number({ minimum: -90, maximum: 90 }),
            altitude: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
            accuracy: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
            speed: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
            bearing: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
        }),
        res: Type.Object({ status: Type.Integer(), message: Type.String(), sent: Type.Integer() }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            if (!manager.ownedBy(user.email).length) {
                res.json({ status: 200, message: 'No linked servers', sent: 0 });
                return;
            }
            const rows = await query<{ key: string; value: string }>(config, sql`
                SELECT key, value FROM profile_settings
                WHERE username = ${user.email} AND key IN (${sql.join(settingKeys.map((k) => sql`${k}`), sql`, `)})
            `);
            const setting = new Map(rows.map((r) => [r.key, r.value]));
            const b = req.body;
            const now = new Date();
            const callsign = setting.get('tak::callsign') || user.email;
            const uid = `ANDROID-CloudTAK-${user.email}`;
            const cot = await CoTParser.from_geojson({
                id: uid,
                type: 'Feature',
                path: '/',
                properties: {
                    callsign,
                    type: SELF_TYPE,
                    how: 'm-g',
                    time: now.toISOString(),
                    start: now.toISOString(),
                    stale: new Date(now.getTime() + SELF_STALE_MS).toISOString(),
                    center: [b.longitude, b.latitude],
                    remarks: setting.get('tak::remarks') || '',
                    ...(typeof b.accuracy === 'number' && { ce: b.accuracy }),
                    ...(typeof b.speed === 'number' && { speed: b.speed }),
                    ...(typeof b.bearing === 'number' && { course: b.bearing }),
                    droid: callsign,
                    contact: { endpoint: '*:-1:stcp', callsign, ...(setting.get('tak::phone') ? { phone: setting.get('tak::phone') } : {}) },
                    group: { name: setting.get('tak::group') || 'Cyan', role: setting.get('tak::role') || 'Team Member' },
                    // TAK Server fills a contact's team and role only for a client that
                    // identifies itself with takv (TAK Server 5.8 lists team/role "unknown" without it).
                    takv: { device: 'CloudTAK CrossTAK', platform: 'CloudTAK', os: 'CrossTAK', version: `CrossTAK ${VERSION}` },
                },
                geometry: { type: 'Point', coordinates: [b.longitude, b.latitude, b.altitude ?? 0] },
            } as Parameters<typeof CoTParser.from_geojson>[0]);
            const sent = await manager.reportSelf(user.email, cot);
            res.json({ status: 200, message: sent ? `Position sent to ${sent} linked server(s)` : 'Position noted', sent });
        } catch (err) {
            Err.respond(err, res);
        }
    });

    await schema.post('/crosstak/send', {
        name: 'Send to Linked Server',
        group: 'CrossTAK',
        description: 'Send one GeoJSON feature to people on one of your linked TAK Servers, as you: to chosen people (uids), to every member of a team, or into a Data Sync feed (mission). There is no broadcast. Never writes to the home server.',
        body: Type.Object({
            server_id: Type.Integer(),
            feature: Type.Any(),
            to: Type.Object({
                uids: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 200 })),
                team: Type.Optional(Type.String({ minLength: 1 })),
                mission: Type.Optional(Type.String({ minLength: 1 })),
            }),
        }),
        res: Type.Object({ status: Type.Integer(), message: Type.String(), uid: Type.String() }),
    }, async (req, res) => {
        try {
            const user = await Auth.as_user(config, req);
            requireReady();
            const s = manager.mine(req.body.server_id, user.email);
            const input = req.body.feature;
            if (!input || typeof input !== 'object' || input.type !== 'Feature' || !input.geometry || !input.properties) {
                throw new Err(400, null, 'feature must be a GeoJSON Feature with geometry and properties');
            }
            // Work on a copy; strip our namespacing so the linked server sees the real uid.
            const feature = JSON.parse(JSON.stringify(input)) as { id?: unknown; properties: Record<string, unknown> };
            const props = feature.properties;
            const meta = (props.metadata && typeof props.metadata === 'object') ? { ...(props.metadata as Record<string, unknown>) } : undefined;
            const origin = meta && meta[TAG] && typeof meta[TAG] === 'object' ? meta[TAG] as { server?: unknown; uid?: unknown } : undefined;
            if (origin && origin.server === s.id && typeof origin.uid === 'string') {
                feature.id = origin.uid;
                props.id = origin.uid;
            } else if (typeof feature.id === 'string' && feature.id.startsWith(`${TAG}:`)) {
                // Came from another linked server: keep it distinct, but don't leak our prefix.
                const uid = feature.id.split(':').slice(2).join(':') || feature.id;
                feature.id = uid;
                props.id = uid;
            }
            if (meta) {
                delete meta[TAG];
                if (Object.keys(meta).length) props.metadata = meta;
                else delete props.metadata;
            }
            delete props.archived;
            const now = Date.now();
            const oldStale = typeof props.stale === 'string' ? Date.parse(props.stale) : NaN;
            props.time = new Date(now).toISOString();
            props.start = new Date(now).toISOString();
            props.stale = new Date(Math.max(Number.isNaN(oldStale) ? 0 : oldStale, now + SENT_MIN_STALE_MS)).toISOString();

            const to = req.body.to || {};
            const dests: Array<{ uid?: string; mission?: string }> = [];
            let label = '';
            const self_uid = `ANDROID-CloudTAK-${user.email}`;
            if (to.uids && to.uids.length) {
                for (const u of new Set(to.uids)) dests.push({ uid: u });
                label = `${dests.length} ${dests.length === 1 ? 'person' : 'people'}`;
            } else if (to.team) {
                const members = (await contactsOf(s)).filter((c) => c.team === to.team && c.uid !== self_uid);
                if (!members.length) throw new Err(400, null, `Nobody on team ${to.team} is on ${s.row.name} right now`);
                for (const m of members) dests.push({ uid: m.uid });
                label = `team ${to.team} (${members.length})`;
            } else if (to.mission) {
                dests.push({ mission: to.mission });
                label = `feed ${to.mission}`;
            } else {
                throw new Err(400, null, 'Choose who to send to: people, a team, or a feed');
            }

            await s.send(feature as Record<string, unknown>, dests);
            const uid = String(feature.id ?? props.id ?? '');
            log(s.id, `sent ${uid} to ${label} by ${user.email}`);
            res.json({ status: 200, message: `Sent to ${label} on ${s.row.name}`, uid });
        } catch (err) {
            Err.respond(err, res);
        }
    });
}
