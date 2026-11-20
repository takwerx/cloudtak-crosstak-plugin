// SPDX-License-Identifier: AGPL-3.0-or-later
// Theme checks: CrossTAK must follow CloudTAK's light and dark mode (issue #1).
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const plugin = join(fileURLToPath(new URL('..', import.meta.url)), 'plugin');
const index = readFileSync(join(plugin, 'index.ts'), 'utf8');
const vueFiles = readdirSync(join(plugin, 'lib')).filter((f) => f.endsWith('.vue'));

test('menu icon is a Tabler icon component, not an <img> of a fixed-colour SVG', () => {
    // An <img> cannot take the host's colour, so a black stroke vanished on the dark theme.
    assert.match(index, /from '@tabler\/icons-vue'/);
    assert.match(index, /IconAccessPoint/);
    assert.doesNotMatch(index, /h\('img'/);
    assert.doesNotMatch(index, /Crosstak\.svg/);
});

test('no hard-coded colour in the plugin icon files', () => {
    const files = readdirSync(join(plugin, 'lib')).filter((f) => f.endsWith('.svg'));
    for (const f of files) {
        const svg = readFileSync(join(plugin, 'lib', f), 'utf8');
        assert.doesNotMatch(svg, /(stroke|fill)="#[0-9a-fA-F]{3,8}"/, `${f} has a fixed colour`);
    }
});

test('no .vue file forces a light or dark colour that breaks the other theme', () => {
    for (const f of vueFiles) {
        const src = readFileSync(join(plugin, 'lib', f), 'utf8');
        // btn-close-white is a white X: unreadable on the pale alert boxes of the light theme.
        assert.doesNotMatch(src, /btn-close-white/, `${f} uses btn-close-white`);
        assert.doesNotMatch(src, /(?:color|background(?:-color)?)\s*:\s*(?:#[0-9a-fA-F]{3,8}|rgba?\(|white|black)/i,
            `${f} sets a fixed colour in CSS`);
    }
});
