// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK runtime bundle: which third-party packages are inside the built file, and do they match
// bundle/package-lock.json (Security condition 4, ops #1410). Node only, no dependencies.
import { readFileSync } from 'node:fs';
import path from 'node:path';

// "/x/bundle/node_modules/@tabler/icons-vue/dist/esm/a.mjs" -> "@tabler/icons-vue"
export function packageOf(id) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const at = id.lastIndexOf(marker);
    if (at < 0) return null;
    const parts = id.slice(at + marker.length).split(path.sep);
    return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

// One entry per bundled package: name, version and license from the package's own package.json.
export function bundledPackages(moduleIds, nodeModules) {
    const names = new Set();
    for (const id of moduleIds) {
        const name = packageOf(id);
        if (name) names.add(name);
    }
    return [...names].sort().map((name) => {
        const pkg = JSON.parse(readFileSync(path.join(nodeModules, name, 'package.json'), 'utf8'));
        return { name, version: pkg.version, license: pkg.license || null };
    });
}

// Returns what is wrong; an empty list means every bundled package is in the lock at that version.
export function checkAgainstLock(packages, lock) {
    const problems = [];
    for (const p of packages) {
        const entry = lock.packages && lock.packages[`node_modules/${p.name}`];
        if (!entry) problems.push(`${p.name} is not in the lock`);
        else if (entry.version !== p.version) problems.push(`${p.name} is ${p.version}, the lock says ${entry.version}`);
        else if (!entry.integrity) problems.push(`${p.name} has no integrity hash in the lock`);
    }
    return problems;
}
