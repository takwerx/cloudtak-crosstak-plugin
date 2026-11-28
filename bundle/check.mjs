#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK runtime bundle: type-check and lint against a CloudTAK checkout.
//
//   node bundle/check.mjs --cloudtak /path/to/CloudTAK
//
// plugin/ only type-checks where it sits inside CloudTAK (its imports are relative to
// app/plugins/crosstak/). This copies plugin/ and bundle/ into scratch folders under
// CloudTAK's app/plugins/, runs vue-tsc and eslint there, prints only the CrossTAK lines and
// removes the scratch folders. Exit 0 means no CrossTAK errors.
import { cpSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const i = process.argv.indexOf('--cloudtak');
if (i < 0 || !process.argv[i + 1]) {
    console.error('usage: node bundle/check.mjs --cloudtak /path/to/CloudTAK');
    process.exit(2);
}
const app = path.join(path.resolve(process.argv[i + 1]), 'app');
const plug = path.join(app, 'plugins/crosstak-check');
const bund = path.join(app, 'plugins/crosstak-bundle-check');
const cfg = path.join(app, 'tsconfig.crosstak-check.json');
const lintCfg = path.join(app, 'eslint.crosstak-check.config.js');

function run(cmd, args) {
    const r = spawnSync(cmd, args, { cwd: app, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return `${r.stdout || ''}${r.stderr || ''}`;
}

let bad = 0;
try {
    rmSync(plug, { recursive: true, force: true });
    rmSync(bund, { recursive: true, force: true });
    mkdirSync(plug, { recursive: true });
    cpSync(path.join(repo, 'plugin/index.ts'), path.join(plug, 'index.ts'));
    cpSync(path.join(repo, 'plugin/lib'), path.join(plug, 'lib'), { recursive: true });
    cpSync(path.join(repo, 'plugin/env.d.ts'), path.join(plug, 'env.d.ts'));
    cpSync(path.join(here, 'shims'), path.join(bund, 'shims'), { recursive: true });
    cpSync(path.join(here, 'entry.ts'), path.join(bund, 'entry.ts'));
    cpSync(path.join(here, 'compat.ts'), path.join(bund, 'compat.ts'));
    cpSync(path.join(repo, 'plugin/eslint.config.js'), lintCfg);
    writeFileSync(cfg, JSON.stringify({
        extends: './tsconfig.json',
        compilerOptions: {
            paths: {
                '@tak-ps/cloudtak': ['./plugin.ts'],
                '@cloudtak/api-types': ['../api/derived-types.d.ts'],
                '@crosstak/*': ['./plugins/crosstak-check/*'],
            },
        },
        include: ['plugins/crosstak-check', 'plugins/crosstak-bundle-check', 'plugin.ts', 'shims-vue.d.ts'],
    }));

    const tsc = run('node_modules/.bin/vue-tsc', ['--noEmit', '-p', 'tsconfig.crosstak-check.json'])
        .split('\n').filter((l) => /plugins\/crosstak-(bundle-)?check/.test(l));
    console.log(`vue-tsc: ${tsc.length} CrossTAK error line(s)`);
    if (tsc.length) { console.log(tsc.join('\n')); bad++; }

    const lint = run('node_modules/.bin/eslint', ['--config', 'eslint.crosstak-check.config.js', 'plugins/crosstak-check', 'plugins/crosstak-bundle-check']);
    const problems = /(\d+) problems?/.exec(lint);
    console.log(`eslint: ${problems ? problems[0] : '0 problems'}`);
    if (problems) { console.log(lint); bad++; }
} finally {
    rmSync(plug, { recursive: true, force: true });
    rmSync(bund, { recursive: true, force: true });
    rmSync(cfg, { force: true });
    rmSync(lintCfg, { force: true });
}
process.exit(bad ? 1 : 0);
