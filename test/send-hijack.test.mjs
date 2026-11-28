// SPDX-License-Identifier: AGPL-3.0-or-later
// CloudTAK's native Share to a person on a linked server must go out over the link (ops #1442).
//
// This runs the real plugin/lib/send-hijack.ts against the real Vue, Pinia and Comlink that
// CloudTAK uses, with a map store shaped like CloudTAK's in both generations:
//   - up to 14.4.0: the worker sits in the store state (`_worker`) and the `worker` getter reads it
//   - 14.4.1 and later: the worker is a module variable and the `worker` getter reads that
// Only CloudTAK's own `std` (the authenticated fetch) is replaced, so the test can see the request.
//
// Setup once:  npm ci --prefix test      Run:  node --test test/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const testDir = pathToFileURL(fileURLToPath(new URL('.', import.meta.url))).href;
const hooks = `
const TEST_DIR = ${JSON.stringify(testDir)};
export async function resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/src/std.ts')) {
        return {
            url: 'data:text/javascript,' + encodeURIComponent(
                'export const std = (url, init) => { globalThis.__stdCalls.push({ url, init }); return Promise.resolve({ status: 200, message: "ok", uid: "u" }); };'
            ),
            shortCircuit: true,
        };
    }
    // The plugin's own folder has no node_modules in CI: take vue from test/node_modules.
    if (specifier === 'vue') return nextResolve(specifier, { ...context, parentURL: TEST_DIR + 'x.mjs' });
    return nextResolve(specifier, context);
}`;
register('data:text/javascript,' + encodeURIComponent(hooks));
globalThis.__stdCalls = [];

const Comlink = await import('comlink');
const { createPinia, defineStore, setActivePinia } = await import('pinia');
const { markRaw } = await import('vue');
const { installSendHijack } = await import('../plugin/lib/send-hijack.ts');

// ---- a worker the way CloudTAK has it: a Comlink proxy over a message channel ----

const open = [];
function makeWorker() {
    const log = { home: [], db: [] };
    const { port1, port2 } = new MessageChannel();
    Comlink.expose({
        conn: { sendCOT: async (feat) => { log.home.push(feat); return 'sent-home'; } },
        db: { add: async (feat) => { log.db.push(feat); return 'added'; } },
    }, port2);
    open.push(port1, port2);
    return { remote: Comlink.wrap(port1), log };
}
test.after(() => { for (const p of open) p.close(); });

// ---- a map store shaped like CloudTAK's, in both generations ----

function oldStore() {
    setActivePinia(createPinia());
    const use = defineStore('cloudtak', {
        state: () => ({ _worker: undefined }),
        getters: {
            worker() {
                if (!this._worker) throw new Error('Atlas worker has not yet started');
                return this._worker;
            },
        },
        actions: { startWorker(w) { this._worker = markRaw(w); } },
    });
    return use();
}

function newStore() {
    setActivePinia(createPinia());
    let atlasWorker;
    const use = defineStore('cloudtak', {
        state: () => ({ workerStarted: false }),
        getters: {
            worker() {
                if (!this.workerStarted || !atlasWorker) throw new Error('Atlas worker has not yet started');
                return atlasWorker;
            },
        },
        actions: {
            startWorker(w) { atlasWorker = w; this.workerStarted = true; },
            destroy() { atlasWorker = undefined; this.$reset(); },
        },
    });
    return use();
}

const SHAPES = { 'CloudTAK up to 14.4.0 (worker in store state)': oldStore, 'CloudTAK 14.4.1 and later (worker in a module variable)': newStore };

const feature = (dest) => ({ type: 'Feature', properties: { id: 'f1', callsign: 'Alpha', ...(dest ? { dest } : {}) }, geometry: { type: 'Point', coordinates: [1, 2] } });
const calls = () => globalThis.__stdCalls;
const reset = () => { globalThis.__stdCalls.length = 0; };

for (const [shape, make] of Object.entries(SHAPES)) {
    test(`${shape}: Share to a person on a link goes out on the link, not home`, async () => {
        reset();
        const store = make();
        const { remote, log } = makeWorker();
        store.startWorker(remote);
        const uninstall = installSendHijack(store);

        await store.worker.conn.sendCOT(feature([{ uid: 'crosstak:7:ANDROID-abc' }]));

        assert.equal(calls().length, 1, 'one request to CrossTAK');
        assert.equal(calls()[0].url, '/api/crosstak/send');
        const body = calls()[0].init.body;
        assert.equal(body.server_id, 7);
        assert.deepEqual(body.to, { uids: ['ANDROID-abc'] });
        assert.equal(body.feature.properties.id, 'f1');
        assert.equal('dest' in body.feature.properties, false, 'the feature sent on the link carries no dest');
        assert.equal(log.home.length, 0, 'nothing goes to the home server');
        uninstall();
    });

    test(`${shape}: a mixed Share sends linked people on the link and the rest home`, async () => {
        reset();
        const store = make();
        const { remote, log } = makeWorker();
        store.startWorker(remote);
        const uninstall = installSendHijack(store);

        await store.worker.conn.sendCOT(feature([
            { uid: 'crosstak:7:one' }, { uid: 'home-user' }, { group: 'Blue' }, { uid: 'crosstak:7:two' }, { uid: 'crosstak:9:three' },
        ]));

        const sent = calls().map((c) => [c.init.body.server_id, c.init.body.to.uids]);
        assert.deepEqual(sent, [[7, ['one', 'two']], [9, ['three']]]);
        assert.equal(log.home.length, 1);
        assert.deepEqual(log.home[0].properties.dest, [{ uid: 'home-user' }, { group: 'Blue' }]);
        uninstall();
    });

    test(`${shape}: a Share with no linked person reaches home untouched`, async () => {
        reset();
        const store = make();
        const { remote, log } = makeWorker();
        store.startWorker(remote);
        const uninstall = installSendHijack(store);

        const f = feature([{ uid: 'home-user' }]);
        assert.equal(await store.worker.conn.sendCOT(f), 'sent-home');
        await store.worker.conn.sendCOT(feature());
        assert.equal(calls().length, 0, 'no CrossTAK request');
        assert.deepEqual(log.home[0], f);
        assert.equal(log.home.length, 2);
        uninstall();
    });

    test(`${shape}: every other worker call still reaches CloudTAK's worker`, async () => {
        reset();
        const store = make();
        const { remote, log } = makeWorker();
        store.startWorker(remote);
        const uninstall = installSendHijack(store);

        assert.equal(await store.worker.db.add({ id: 'x' }), 'added');
        assert.deepEqual(log.db, [{ id: 'x' }]);
        uninstall();
    });

    test(`${shape}: before the worker starts, store.worker fails the way CloudTAK's does, then works`, async () => {
        reset();
        const store = make();
        const uninstall = installSendHijack(store);

        assert.throws(() => store.worker, /Atlas worker has not yet started/);

        const { remote } = makeWorker();
        store.startWorker(remote);
        await store.worker.conn.sendCOT(feature([{ uid: 'crosstak:3:late' }]));
        assert.equal(calls().length, 1, 'the hook works on a worker that started after the plugin');
        uninstall();
    });

    test(`${shape}: uninstall puts CloudTAK's own worker back`, async () => {
        reset();
        const store = make();
        const { remote, log } = makeWorker();
        store.startWorker(remote);
        const uninstall = installSendHijack(store);
        uninstall();

        await store.worker.conn.sendCOT(feature([{ uid: 'crosstak:7:x' }]));
        assert.equal(calls().length, 0, 'the hook is gone');
        assert.equal(log.home.length, 1);
    });
}

test('after a logout and a new login the new worker is hooked too (14.4.1 and later)', async () => {
    reset();
    const store = newStore();
    const first = makeWorker();
    store.startWorker(first.remote);
    const uninstall = installSendHijack(store);
    await store.worker.conn.sendCOT(feature([{ uid: 'crosstak:7:a' }]));
    assert.equal(calls().length, 1);

    store.destroy();
    assert.throws(() => store.worker, /Atlas worker has not yet started/);

    const second = makeWorker();
    store.startWorker(second.remote);
    await store.worker.conn.sendCOT(feature([{ uid: 'crosstak:7:b' }]));
    assert.equal(calls().length, 2, 'the second worker sends on the link too');
    assert.equal(second.log.home.length, 0);
    uninstall();
});

test('a CloudTAK with no worker getter we can hook says so and changes nothing', () => {
    const warnings = [];
    const real = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
        setActivePinia(createPinia());
        const use = defineStore('cloudtak', { state: () => ({ other: 1 }) });
        const store = use();
        const uninstall = installSendHijack(store);
        assert.equal(typeof uninstall, 'function');
        assert.doesNotThrow(() => uninstall());
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /CrossTAK/);
        assert.match(warnings[0], /Send/, 'tells the user the Send pane still works');
    } finally {
        console.warn = real;
    }
});
