// Run: node --test test/
// Switching a linked server to disabled must take its markers off the map at once.
// The route file and the Vue pane cannot be imported on their own (they need CloudTAK's host
// modules), so the pure helper is imported, flush() is cut out of the route file and run on a
// fake manager, and the pane wiring is checked in its source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const route = readFileSync(here('../server/plugin-crosstak.ts'), 'utf8');
const pane = readFileSync(here('../plugin/lib/CrosstakContainer.vue'), 'utf8');

test('isFromLink picks out one link\'s features and no one else\'s', async () => {
    const { isFromLink } = await import('../plugin/lib/linked-features.ts');
    const mine = { id: 'crosstak:7:abc', properties: { metadata: { crosstak: { server: 7, uid: 'abc' } } } };
    const feedItem = { id: 'crosstak:7:xyz', properties: { metadata: { crosstak: { server: 7, mission: 'Fire' } } } };
    const other = { id: 'crosstak:70:abc', properties: { metadata: { crosstak: { server: 70 } } } };
    const home = { id: 'some-home-uid', properties: {} };
    assert.equal(isFromLink(mine, 7), true);
    assert.equal(isFromLink(feedItem, 7), true);
    assert.equal(isFromLink(other, 7), false);
    assert.equal(isFromLink(home, 7), false);
    // no metadata, id only
    assert.equal(isFromLink({ id: 'crosstak:7:q' }, 7), true);
    assert.equal(isFromLink({ id: 'crosstak:70:q' }, 7), false);
});

test('flush() sends nothing for a link that is switched off, and drops what was waiting', () => {
    const m = route.match(/\n    flush\(\): void \{\n([\s\S]*?)\n    \}\n/);
    assert.ok(m, 'flush() not found in the route file');
    const body = m[1].replace(/safeMessage|logError/g, 'noop');
    const flush = new Function('noop', `return function () {\n${body}\n};`)(() => '');
    const sent = [];
    const feat = { id: 'crosstak:1:a' };
    const mk = (enabled) => ({
        id: 1, wsConnection: 1, row: { owner: 'u@x', enabled },
        pending: new Map([['crosstak:1:a', feat]]),
    });
    const on = mk(true);
    const off = mk(false);
    const mgr = {
        streams: new Map([[1, on], [2, off]]),
        recipients: new Set(['u@x']),
        config: { hub: { wsNotify: async (o, p) => { sent.push(p); } } },
    };
    flush.call(mgr);
    assert.equal(sent.length, 1, 'only the enabled link sends');
    assert.equal(off.pending.size, 0, 'a switched-off link keeps nothing waiting');
});

test('a feed that finishes loading after the link was switched off puts nothing on the map', () => {
    const m = route.match(/async pushMission[\s\S]*?\n    \}\n/);
    assert.ok(m);
    assert.match(m[0], /await withChannelApi[\s\S]*if \(!s\.row\.enabled\) return 0;[\s\S]*s\.pending\.set/);
});

test('the pane clears the link\'s markers when Enabled is switched off and when an edit saves it off', () => {
    assert.match(pane, /import \{ isFromLink \} from '\.\/linked-features\.ts'/);
    assert.match(pane, /feature\.list\(\{ filter: \(feat\) => isFromLink\(feat, serverId\) \}\)/);
    assert.match(pane, /mapStore\.worker\.db\.remove\(String\(feat\.id\)\)/);
    assert.match(pane, /await patchServer\(s\.id, \{ \[field\]: value \}\);\n\s+if \(!value\) await clearAfterDisable\(s\);/);
    assert.match(pane, /if \(!server\.enabled\) await clearAfterDisable\(server\);/);
});
