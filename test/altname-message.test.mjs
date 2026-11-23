// Run: node --test test/
// The route file cannot be imported on its own (it needs CloudTAK's host modules), so this
// cuts the altnameMessage() block out between its markers and runs just that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../server/plugin-crosstak.ts', import.meta.url)), 'utf8');
const m = src.match(/\/\/ altnameMessage:begin[^\n]*\n([\s\S]*?)\/\/ altnameMessage:end/);

test('route file has the altnameMessage block', () => {
    assert.ok(m, 'altnameMessage block missing');
});

const altnameMessage = m && new Function(`${m[1]
    .replace('subjectaltname: string | undefined, expectedName: string | null): string', 'subjectaltname, expectedName)')
}\nreturn altnameMessage;`)();

test('infra-TAK style certificate (DNS:takserver): says where to fix it and what to type', () => {
    const msg = altnameMessage('DNS:takserver', null);
    assert.match(msg, /ERR_TLS_CERT_ALTNAME_INVALID/);
    assert.match(msg, /named takserver/);
    assert.match(msg, /Click Edit on this server/);
    assert.match(msg, /enter takserver in "Expected certificate name"/);
});

test('the field the message names exists in the Edit form and the link form', () => {
    for (const f of ['ServerForm.vue', 'LinkForm.vue']) {
        const vue = readFileSync(fileURLToPath(new URL(`../plugin/lib/${f}`, import.meta.url)), 'utf8');
        assert.ok(vue.includes("label='Expected certificate name (optional)'"), f);
    }
});

test('wrong expected name set: tells the user to fix it, shows what the certificate names', () => {
    const msg = altnameMessage('DNS:takserver, DNS:other.example', 'tak.example.org');
    assert.match(msg, /not "tak\.example\.org"/);
    assert.match(msg, /certificate names takserver/);
});

test('names from the remote certificate are echoed only when they are plain host names', () => {
    const msg = altnameMessage('DNS:<script>alert(1)</script>, IP Address:10.0.0.1', null);
    assert.doesNotMatch(msg, /script/);
    assert.match(msg, /does not name the address you typed/);
});

test('no subjectAltName at all still gives the next step', () => {
    assert.match(altnameMessage(undefined, null), /Click Edit on this server/);
});
