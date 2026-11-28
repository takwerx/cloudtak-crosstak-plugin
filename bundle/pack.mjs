// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK runtime bundle: manifest and tarball. Node only, no dependencies.
//
// CloudTAK 14.2+ takes one .tar.gz with exactly two files at its root: manifest.json and
// index.js. The manifest carries the SHA-256 of index.js (api/stateless/lib/plugin-bundle.ts
// in CloudTAK checks it, and rejects any other entry). The archive is built the same way every
// time (fixed times, sorted names), so one source tree gives one file and one hash.
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const PLUGIN_API_VERSION = 1;
export const NAME = 'CrossTAK';
export const HOMEPAGE = 'https://github.com/takwerx/cloudtak-crosstak-plugin';

export function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

export function makeManifest(index, version) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(version)) throw new Error(`bad version: ${version}`);
    return {
        name: NAME,
        version,
        description: 'Link other agencies\' TAK Servers into the CloudTAK map',
        author: 'TAKWERX',
        license: 'AGPL-3.0-or-later',
        homepage: HOMEPAGE,
        sha256: sha256(index),
        api_version: PLUGIN_API_VERSION,
    };
}

function octal(n, width) {
    return n.toString(8).padStart(width - 1, '0') + '\0';
}

function tarEntry(name, data) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(octal(0o644, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(data.length, 12), 124);
    header.write(octal(0, 12), 136);
    header.write('        ', 148);          // checksum field counts as spaces
    header.write('0', 156);                  // regular file
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(octal(sum, 7) + ' ', 148);
    const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
    return Buffer.concat([header, data, pad]);
}

export function makeTarball(index, version) {
    const manifest = Buffer.from(JSON.stringify(makeManifest(index, version), null, 2) + '\n');
    const tar = Buffer.concat([
        tarEntry('index.js', index),
        tarEntry('manifest.json', manifest),
        Buffer.alloc(1024),
    ]);
    // gzip header time is left at 0 by zlib; level fixed so the bytes repeat
    return gzipSync(tar, { level: 9 });
}
