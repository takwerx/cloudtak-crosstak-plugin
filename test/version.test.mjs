// SPDX-License-Identifier: AGPL-3.0-or-later
// Release hygiene: the version in the route file, README status line and newest CHANGELOG
// section must all say the same thing. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');
const route = read('server/plugin-crosstak.ts').match(/const VERSION = '([^']+)'/);
const readme = read('README.md').match(/Status: [^(]*\(v([^)]+)\)/);
const changelog = read('CHANGELOG.md').match(/^## (\d+\.\d+\.\d+)/m);

test('route VERSION, README status and newest CHANGELOG section agree', () => {
    assert.ok(route && readme && changelog, 'a version line is missing');
    assert.equal(readme[1], route[1], 'README status line differs from VERSION');
    assert.equal(changelog[1], route[1], 'newest CHANGELOG section differs from VERSION');
});
