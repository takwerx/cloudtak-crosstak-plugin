// SPDX-License-Identifier: AGPL-3.0-or-later
// CrossTAK runtime bundle: read the BUILT file (index.js) for the Security conditions of ops #1410.
// Node only, no dependencies. test/bundle.test.mjs runs it on the real build, and on planted
// code that must fail, so a rule that stops working shows up as a red test.
//
//   1  the bundle reads only the stored values `token` and `serverUrl`, and never writes one
//   2  the only network call is one fetch(), made by the std shim (which refuses other origins)
//   3  the token has no place to go: no storage write, no cookie, no beacon, no socket, no log line
//      that is not a fixed sentence, no eval or dynamic import
export const READABLE_KEYS = ['token', 'serverUrl'];

// What the bundle reads from storage: the reader function is the one that passes its argument
// to `.get({ key })`; every call of it must name a key as a plain string.
export function storedKeysRead(code) {
    const reader = /(?:async\s+)?function\s+([\w$]+)\(([\w$]+)\)\s*\{(?:(?!function[\s(])[^])*?\.get\(\{\s*key:\s*\2\s*\}\)/.exec(code);
    if (!reader) return { found: false, keys: [], dynamic: 0 };
    const name = reader[1].replace(/\$/g, '\\$');
    const keys = new Set();
    let dynamic = 0;
    for (const m of code.matchAll(new RegExp(`(?<!function\\s)(?<![\\w$.])${name}\\(([^)]*)\\)`, 'g'))) {
        const lit = /^\s*"([^"]*)"\s*$/.exec(m[1]) || /^\s*'([^']*)'\s*$/.exec(m[1]);
        if (lit) keys.add(lit[1]); else dynamic++;
    }
    return { found: true, keys: [...keys].sort(), dynamic };
}

const FORBIDDEN = [
    ['sessionStorage', /\bsessionStorage\b/],
    ['indexedDB', /\bindexedDB\b/],
    ['a cookie', /document\.cookie/],
    ['a storage write', /\.(setItem|removeItem)\(/],
    ['a Preferences write', /\.(set|remove|clear)\(\{\s*key/],
    ['sendBeacon', /sendBeacon/],
    ['a WebSocket', /\bWebSocket\b/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['an EventSource', /\bEventSource\b/],
    ['an image request', /new\s+Image\b/],
    ['a worker', /\b(importScripts|new\s+(Shared)?Worker)\b/],
    ['eval', /\beval\(|new\s+Function\b/],
    ['a dynamic import', /\bimport\(/],
    ['window.open', /window\.open\(/],
    ['postMessage', /postMessage\(/],
];

// Returns a list of what breaks a rule. Empty means the built file passes.
export function auditBundle(code) {
    const problems = [];

    const stored = storedKeysRead(code);
    if (!stored.found) problems.push('cannot find the function that reads stored values');
    for (const k of stored.keys) if (!READABLE_KEYS.includes(k)) problems.push(`reads the stored value "${k}"`);
    if (stored.dynamic) problems.push(`reads a stored value by a name the build cannot see (${stored.dynamic} call(s))`);
    for (const k of ['refresh', 'sessionId', 'session']) {
        if (new RegExp(`key:\\s*["'\`]${k}`).test(code)) problems.push(`names the stored value "${k}"`);
    }
    for (const m of code.matchAll(/\blocalStorage\b(?!\.getItem\()/g)) problems.push(`uses localStorage other than getItem near "${code.slice(m.index, m.index + 30)}"`);
    if ((code.match(/CapacitorStorage\./g) || []).length > 1) problems.push('reads the Capacitor storage prefix in more than one place');

    for (const [what, re] of FORBIDDEN) if (re.test(code)) problems.push(`uses ${what}`);

    const fetches = (code.match(/(?<![\w$.])fetch\(/g) || []).length;
    if (fetches !== 1) problems.push(`has ${fetches} fetch() calls, expected exactly 1 (the std shim)`);
    if ((code.match(/Bearer/g) || []).length !== 1) problems.push('the word Bearer is not in exactly one place');

    for (const m of code.matchAll(/console\.(\w+)\(([^)]*)\)/g)) {
        if (!/^\s*"[^"]*"\s*$/.test(m[2])) problems.push(`logs something that is not a fixed sentence: console.${m[1]}(${m[2].slice(0, 40)})`);
    }
    return problems;
}
