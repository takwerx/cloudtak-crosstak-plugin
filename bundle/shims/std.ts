// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK runtime bundle: stands in for CloudTAK's `src/std.ts` (the std() helper).
//
// CloudTAK keeps the login token with the Capacitor Preferences plugin it registered at start,
// and that plugin works the same in a browser, on iOS and on Android. A bundle cannot import
// the host's std(), so this copy reads the token and the server address the same way and sends
// the same request. What it leaves out: the host's refresh of an expired login (a 401 here just
// throws '401', and the host refreshes the stored token on its own schedule).
//
// Two rules for the Security review (ops #1410, conditions 1 and 2), each with a test in
// test/bundle.test.mjs:
//  - the only stored values this file reads are `token` and `serverUrl`. It never writes or removes
//    one, and never reads the refresh token, the session id or any other key;
//  - every request goes to the CloudTAK server's own origin. A full URL that points anywhere else
//    is refused before anything is sent, so the login token cannot leave for another host.
interface PreferencesPlugin {
    get(opts: { key: string }): Promise<{ value: string | null }>;
}

interface StdOptions {
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
    method?: string;
    signal?: AbortSignal;
    timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

// The only stored keys this bundle reads.
export const READABLE_KEYS = ['token', 'serverUrl'] as const;
type ReadableKey = typeof READABLE_KEYS[number];

function preferences(): PreferencesPlugin | undefined {
    const cap = (globalThis as { Capacitor?: { Plugins?: { Preferences?: PreferencesPlugin } } }).Capacitor;
    return cap?.Plugins?.Preferences;
}

async function pref(key: ReadableKey): Promise<string | undefined> {
    if (!READABLE_KEYS.includes(key)) throw new Error('CrossTAK reads only the login token and the server address');
    const p = preferences();
    if (p) {
        const res = await p.get({ key });
        return (res && res.value) || undefined;
    }
    try {
        return localStorage.getItem(`CapacitorStorage.${key}`) || undefined;
    } catch {
        return undefined;
    }
}

export async function stdurl(url: string | URL): Promise<URL> {
    const base = (await pref('serverUrl')) || location.origin;
    let target: URL;
    try {
        target = new URL(url);
    } catch {
        target = new URL(base.replace(/\/$/, '') + String(url));
    }
    if (target.origin !== new URL(base).origin) {
        throw new Error('CrossTAK sends requests only to your CloudTAK server');
    }
    return target;
}

export async function std(url: string | URL, opts: StdOptions = {}): Promise<unknown> {
    const target = await stdurl(url);
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    let body = opts.body as BodyInit | undefined;

    if (!(body instanceof FormData) && typeof opts.body === 'object' && opts.body !== null && !headers['Content-Type']) {
        body = JSON.stringify(opts.body);
        headers['Content-Type'] = 'application/json';
    }

    const token = opts.token || await pref('token');
    if (token && !headers.Authorization) headers.Authorization = `Bearer ${token}`;

    const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;

    let res: Response;
    try {
        res = await fetch(target, { method: opts.method, headers, body, signal });
    } catch (err) {
        if (controller.signal.aborted) {
            throw new Error(`Request timed out after ${timeoutMs}ms: ${String(target)}`, { cause: err });
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (res.status === 401) {
        const err = new Error('401') as Error & { status?: number };
        err.status = 401;
        throw err;
    }

    if (res.status < 200 || res.status >= 400) {
        let bdy: { message?: string; details?: unknown } = {};
        try {
            bdy = await res.json() as typeof bdy;
        } catch (cause) {
            const err = new Error(`Status Code: ${res.status}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }) as Error & { status?: number };
            err.status = res.status;
            throw err;
        }
        const err = new Error(bdy.message || `Status Code: ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
    }

    const type = res.headers.get('Content-Type');
    if (type && type.includes('application/json')) return await res.json();
    return res;
}
