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
import { computed, isRef, markRaw, toRaw } from 'vue';
import { sendFeature } from './crosstak-client.ts';

const LINKED_UID = /^crosstak:(\d+):(.+)$/;

type SendCOT = (feat: unknown, ...rest: unknown[]) => Promise<unknown>;

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

// Put our sendCOT in front of CloudTAK's worker.
//
// Share reads the worker through the map store's `worker` getter every time it sends
// (`mapStore.worker.conn.sendCOT(...)`). That getter exists in every CloudTAK we support
// (13.102 to now), but where the worker itself lives has changed: up to 14.4.0 it is in the
// store state (`_worker`), from 14.4.1 it is a module variable no plugin can reach. So we do
// not touch the worker's home. We replace the getter itself: Pinia keeps each getter as a
// computed ref on the store, and ours reads CloudTAK's original and hands out the worker in a
// Proxy that swaps in our sendCOT and forwards everything else untouched. Because ours reads
// the original every time, it follows a new worker after a logout and login on its own.
export function installSendHijack(mapStore: unknown): () => void {
    const raw = toRaw(mapStore) as Record<string, unknown> | null;
    const original = raw ? raw.worker : undefined;
    if (!raw || !isRef(original)) {
        console.warn(
            'CrossTAK: this CloudTAK has no map store worker I can hook, so Share to a person on a '
            + 'linked server will not work. Use Send in the CrossTAK pane instead.'
        );
        return () => { /* nothing was installed */ };
    }

    const wrapped = new WeakMap<object, unknown>();
    const ours = markRaw(computed(() => {
        // Reading the original throws CloudTAK's own "worker has not yet started" until it has.
        const current = (original as { value: unknown }).value;
        if (!current || (typeof current !== 'object' && typeof current !== 'function')) return current;
        let proxy = wrapped.get(current);
        if (!proxy) {
            try {
                proxy = markRaw(wrapWorker(current as Record<string | symbol, unknown>) as object);
            } catch {
                // Never put CloudTAK's own worker at risk: if we cannot wrap it, hand it out as it is.
                proxy = current;
            }
            wrapped.set(current, proxy);
        }
        return proxy;
    }));
    raw.worker = ours;

    return () => {
        // Put the original back only if nobody replaced ours meanwhile.
        if (raw.worker === ours) raw.worker = original;
    };
}

function wrapWorker(worker: Record<string | symbol, unknown>): unknown {
    const conn = worker.conn as Record<string | symbol, unknown>;
    const original: SendCOT = (feat, ...rest) => (conn.sendCOT as SendCOT)(feat, ...rest);
    const sendCOT = makeSendCOT(original);
    const connProxy = new Proxy(conn, {
        get(target, prop, receiver) {
            if (prop === 'sendCOT') return sendCOT;
            return Reflect.get(target, prop, receiver);
        },
    });
    return new Proxy(worker, {
        get(target, prop, receiver) {
            if (prop === 'conn') return connProxy;
            return Reflect.get(target, prop, receiver);
        },
    });
}
