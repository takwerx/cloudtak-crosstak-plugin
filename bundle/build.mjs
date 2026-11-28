#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK runtime bundle build.
//
//   node bundle/build.mjs --cloudtak /path/to/CloudTAK [--out bundle/dist]
//
// Builds bundle/entry.ts and the plugin/lib panes into one ES module and packs it with a
// manifest into crosstak-<version>.tar.gz, ready for POST /api/plugin/bundle on CloudTAK 14.2+.
//
// The CloudTAK checkout is only the tool box: its node_modules give Vite and the Vue compiler.
// Nothing of CloudTAK's own source is copied into the bundle. The one third-party package that
// does go into the file (the icon set) is installed from bundle/package-lock.json with
// `npm ci` (Security condition 4, ops #1410): the build stops if it is not there, or if a
// bundled package differs from the lock. The build also writes the list of bundled packages
// (crosstak-<version>.deps.json, for the release SBOM) and the sha256 of the archive. `vue`, `vue-router` and `@tak-ps/vue-tabler` stay out of the file:
// they are read from globalThis.__CLOUDTAK__ at run time, so the bundle and the app share one
// Vue. CloudTAK's `std`, map store and menu frame cannot be imported by a bundle, so
// bundle/shims/ replaces them.
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { makeTarball, sha256 } from './pack.mjs';
import { bundledPackages, checkAgainstLock } from './deps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

const HOST_MODULES = ['vue', 'vue-router', '@tak-ps/vue-tabler'];

export function routeVersion() {
    const m = /const VERSION = '([^']+)'/.exec(readFileSync(path.join(repo, 'server/plugin-crosstak.ts'), 'utf8'));
    if (!m) throw new Error('VERSION not found in server/plugin-crosstak.ts');
    return m[1];
}

function* sources(dir) {
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (name === 'node_modules' || name === 'dist') continue;
        if (statSync(p).isDirectory()) yield* sources(p);
        else if (/\.(ts|vue)$/.test(name)) yield p;
    }
}

// Names the sources take from each host module (import type lines do not count).
export function importedNames(spec, files) {
    const found = new Set();
    const re = new RegExp(`import\\s+(?!type\\b)\\{([^}]*)\\}\\s+from\\s+'${spec.replace(/[/@]/g, '\\$&')}'`, 'g');
    for (const file of files) {
        for (const m of readFileSync(file, 'utf8').matchAll(re)) {
            for (const part of m[1].split(',')) {
                const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
                if (name && !part.trim().startsWith('type ')) found.add(name);
            }
        }
    }
    return [...found].sort();
}

function hostModule(spec, names) {
    const lines = [
        `const M = globalThis.__CLOUDTAK__ && globalThis.__CLOUDTAK__[${JSON.stringify(spec)}];`,
        `if (!M) throw new Error('CrossTAK: CloudTAK did not hand over ${spec}');`,
        'export default M;',
        ...names.map((n) => `export const ${n} = M.${n};`),
    ];
    return lines.join('\n');
}

export async function buildBundle({ cloudtak, out }) {
    const app = path.join(path.resolve(cloudtak), 'app');
    const appRequire = createRequire(path.join(app, 'package.json'));
    const { build } = await import(pathToFileURL(appRequire.resolve('vite')).href);
    const vue = (await import(pathToFileURL(appRequire.resolve('@vitejs/plugin-vue')).href)).default;
    const compiler = appRequire('vue/compiler-sfc');
    const version = routeVersion();

    const files = [...sources(path.join(repo, 'plugin/lib')), ...sources(here)];
    const names = {
        'vue': Object.keys(appRequire('vue')).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default'),
        'vue-router': importedNames('vue-router', files),
        '@tak-ps/vue-tabler': importedNames('@tak-ps/vue-tabler', files),
    };

    const shim = (file) => path.join(here, 'shims', file);
    const plugin = {
        name: 'crosstak-bundle',
        enforce: 'pre',
        async resolveId(spec, importer, opts) {
            if (HOST_MODULES.includes(spec)) return `\0host:${spec}`;
            if (/\/src\/std\.ts$/.test(spec)) return shim('std.ts');
            if (/\/src\/stores\/map\.ts$/.test(spec)) return shim('map-store.ts');
            if (spec.startsWith('@crosstak/')) return path.join(repo, 'plugin', spec.slice('@crosstak/'.length));
            // any other bare import (the icon set) is looked up in bundle/node_modules, which
            // `npm ci` fills from bundle/package-lock.json. Never from the CloudTAK checkout.
            if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('\0') && !spec.startsWith('virtual:')) {
                const r = await this.resolve(spec, path.join(here, 'locked-imports.ts'), { ...opts, skipSelf: true });
                if (!r || !r.id.startsWith(path.join(here, 'node_modules') + path.sep)) {
                    throw new Error(`CrossTAK bundle: "${spec}" is not in bundle/node_modules. Run: npm ci --prefix bundle`);
                }
                return r;
            }
            return null;
        },
        load(id) {
            if (id.startsWith('\0host:')) {
                const spec = id.slice('\0host:'.length);
                return hostModule(spec, names[spec]);
            }
            return null;
        },
    };

    const result = await build({
        root: repo,
        configFile: false,
        logLevel: 'warn',
        publicDir: false,
        plugins: [plugin, vue({ compiler })],
        define: {
            __BUNDLE_VERSION__: JSON.stringify(version),
            'process.env.NODE_ENV': '"production"',
        },
        build: {
            write: false,
            emptyOutDir: false,
            target: 'es2022',
            minify: true,
            sourcemap: false,
            cssCodeSplit: false,
            lib: { entry: path.join(here, 'entry.ts'), formats: ['es'], fileName: () => 'index.js', cssFileName: 'style' },
        },
    });

    const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => r.output);
    const chunk = outputs.find((o) => o.type === 'chunk' && o.isEntry);
    if (!chunk) throw new Error('no entry chunk in the build output');
    const css = outputs.filter((o) => o.type === 'asset' && /\.css$/.test(o.fileName))
        .map((o) => String(o.source)).join('\n');

    let code = chunk.code;
    if (css) {
        const inject = `(function(){var id='crosstak-runtime-style';if(!document.getElementById(id)){var s=document.createElement('style');s.id=id;s.textContent=${JSON.stringify(css)};document.head.appendChild(s)}})();\n`;
        code = inject + code;
    }

    // A bundle is loaded from a blob: URL, so a bare import would not resolve there.
    const bare = /(^|[;\n}])\s*import\s*(?:[\w*${}\s,]+from\s*)?["'][^"']+["']|\bimport\(/.exec(code);
    if (bare) throw new Error(`the bundle still has an import: ${bare[0].trim().slice(0, 80)}`);

    // Every third-party package in the file must be the one the lock names (version and hash).
    const packages = bundledPackages(Object.keys(chunk.modules || {}), path.join(here, 'node_modules'));
    const lock = JSON.parse(readFileSync(path.join(here, 'package-lock.json'), 'utf8'));
    const problems = checkAgainstLock(packages, lock);
    if (problems.length) throw new Error(`the bundle holds packages the lock does not list: ${problems.join('; ')}`);

    const index = Buffer.from(code);
    const tarball = makeTarball(index, version);
    mkdirSync(out, { recursive: true });
    const tgz = path.join(out, `crosstak-${version}.tar.gz`);
    const depsFile = path.join(out, `crosstak-${version}.deps.json`);
    writeFileSync(path.join(out, 'index.js'), index);
    writeFileSync(tgz, tarball);
    writeFileSync(depsFile, JSON.stringify({ bundle: `crosstak-${version}.tar.gz`, packages }, null, 2) + '\n');
    return { version, tgz, depsFile, packages, indexSha256: sha256(index), tgzSha256: sha256(tarball), bytes: index.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const arg = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : undefined; };
    const cloudtak = arg('--cloudtak');
    if (!cloudtak) {
        console.error('usage: node bundle/build.mjs --cloudtak /path/to/CloudTAK [--out DIR]');
        process.exit(2);
    }
    const res = await buildBundle({ cloudtak, out: path.resolve(arg('--out') || path.join(here, 'dist')) });
    console.log(`${res.tgz}\nversion ${res.version}\nindex.js ${res.bytes} bytes sha256 ${res.indexSha256}`);
    console.log(`bundled packages: ${res.packages.map((p) => `${p.name}@${p.version}`).join(', ') || 'none'} (${res.depsFile})`);
    console.log(`Release notes line: crosstak-${res.version}.tar.gz sha256 ${res.tgzSha256}`);
}
