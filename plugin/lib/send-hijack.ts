// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK — route CloudTAK's NATIVE Share to people on linked servers (PLAN §11, W12b).
// Copyright (C) 2026 TAKWERX
//
// CloudTAK's Share sends one feature with properties.dest = [{uid}, {group}, …] through
// mapStore.worker.conn.sendCOT(), and that always goes to the HOME TAK Server. A person seen
// through a link is a contact whose uid is `crosstak:<link id>:<real uid>` (the server route
// namespaces ids on ingest), so a native Share to them would reach nobody.
//
// This wraps sendCOT in the browser, without patching CloudTAK: every dest whose uid carries
// the crosstak prefix is taken out and sent by CrossTAK on that link, as this user, to the
// real uid; whatever is left (home contacts, channels) goes to the home server unchanged.
//
// Not covered: Share of several features or of a feature with attachments (CloudTAK builds a
// data package server-side, PUT /api/marti/package), and chat. Those still go home only.
import { markRaw } from 'vue';
import { sendFeature } from './crosstak-client.ts';

const LINKED_UID = /^crosstak:(\d+):(.+)$/;
const RECHECK_MS = 5_000;

type SendCOT = (feat: unknown, ...rest: unknown[]) => Promise<unknown>;

interface StoreWithWorker {
    _worker?: unknown;
}

interface Dest {
    uid?: unknown;
    [key: string]: unknown;
}

interface FeatureLike {
    properties?: { dest?: unknown; [key: string]: unknown };
    [key: string]: unknown;
}

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}

function makeSendCOT(original: SendCOT): SendCOT {
    return async (feat: unknown, ...rest: unknown[]) => {
        const f = feat as FeatureLike | null;
        const dest = f && f.properties ? f.properties.dest : undefined;
        if (!Array.isArray(dest) || !dest.length) return await original(feat, ...rest);

        const linked = new Map<number, string[]>();
        const home: Dest[] = [];
        for (const d of dest as Dest[]) {
            const m = d && typeof d.uid === 'string' ? LINKED_UID.exec(d.uid) : null;
            if (m) {
                const id = Number(m[1]);
                const list = linked.get(id) || [];
                list.push(m[2]);
                linked.set(id, list);
            } else {
                home.push(d);
            }
        }
        if (!linked.size) return await original(feat, ...rest);

        const bare = clone(f as FeatureLike);
        if (bare.properties) delete bare.properties.dest;
        for (const [id, uids] of linked) {
            await sendFeature(id, bare, { uids });
        }

        if (!home.length) return undefined;
        const toHome = clone(f as FeatureLike);
        if (toHome.properties) toHome.properties.dest = home;
        return await original(toHome, ...rest);
    };
}

// Wrap the store's Comlink worker in a Proxy that hands out our sendCOT and forwards
// everything else untouched. Re-applied whenever CloudTAK replaces the worker (re-login).
export function installSendHijack(mapStore: unknown): () => void {
    const store = mapStore as StoreWithWorker;
    let installedOn: unknown = undefined;
    let ours: unknown = undefined;

    const apply = () => {
        const current = store._worker;
        if (!current || current === ours) return;
        const raw = current as Record<string | symbol, unknown>;
        const conn = raw.conn as Record<string | symbol, unknown>;
        const original: SendCOT = (feat, ...rest) => (conn.sendCOT as SendCOT)(feat, ...rest);
        const sendCOT = makeSendCOT(original);
        const connProxy = new Proxy(conn, {
            get(target, prop, receiver) {
                if (prop === 'sendCOT') return sendCOT;
                return Reflect.get(target, prop, receiver);
            },
        });
        const workerProxy = new Proxy(raw, {
            get(target, prop, receiver) {
                if (prop === 'conn') return connProxy;
                return Reflect.get(target, prop, receiver);
            },
        });
        installedOn = current;
        ours = markRaw(workerProxy);
        store._worker = ours;
    };

    apply();
    const timer = setInterval(() => {
        try { apply(); } catch { /* worker not started yet */ }
    }, RECHECK_MS);

    return () => {
        clearInterval(timer);
        // Put the original back only if nobody replaced it meanwhile.
        if (store._worker === ours && installedOn) store._worker = installedOn;
        installedOn = undefined;
        ours = undefined;
    };
}
