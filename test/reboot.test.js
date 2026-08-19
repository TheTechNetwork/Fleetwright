// The most destructive thing the hub can do, and the confirmation that guards
// it.
//
// The property under test is not "three prompts" — it is that the three ask
// for DIFFERENT things, so a person who misread the first cannot sail through
// the rest. Each test here is one way that guarantee could quietly stop
// holding.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { reboot, cancelReboot } from '../src/core/reboot.js';

const CFG = /** @type {any} */ ({ systemReboot: true, runUser: 'agent' });
const ok = () => ({ status: 0, stderr: '' });

/** Walk the flow to the token, returning it. @param {any} [opts] */
function begin(opts = {}) {
  cancelReboot();
  const first = reboot(CFG, [], { actor: 'telegram:1', sessions: ['cc-brave-otter'], exec: ok, ...opts });
  const token = /\/reboot ([0-9a-f]{6})/.exec(first.text)?.[1];
  assert.ok(token, 'step 1 issues a token');
  return { first, token };
}

test('step 1 says what will be lost before asking anything', () => {
  const { first } = begin();
  assert.match(first.text, /cc-brave-otter/, 'the sessions are named, not counted');
  assert.match(first.text, /Nothing here resumes them afterwards/);
  assert.match(first.text, /Step 2 of 3/);
});

test('the whole flow needs the token AND the hostname, in that order', () => {
  const { token } = begin();

  const skipped = reboot(CFG, [token, os.hostname()], { actor: 'telegram:1', exec: ok });
  assert.equal(skipped.ok, false, 'the hostname cannot be sent with the token in one go');

  const second = reboot(CFG, [token], { actor: 'telegram:1', exec: ok });
  assert.match(second.text, /Step 3 of 3/);

  let ran = false;
  const third = reboot(CFG, [token, os.hostname()], {
    actor: 'telegram:1',
    exec: () => { ran = true; return ok(); },
  });
  assert.equal(third.ok, true);
  assert.equal(ran, true);
});

test('the wrong hostname is refused, which is the mistake worth preventing', () => {
  const { token } = begin();
  reboot(CFG, [token], { actor: 'telegram:1', exec: ok });

  let ran = false;
  const r = reboot(CFG, [token, 'some-other-box'], {
    actor: 'telegram:1',
    exec: () => { ran = true; return ok(); },
  });
  assert.equal(r.ok, false);
  assert.equal(ran, false, 'nothing runs when the operator named a different machine');
  assert.match(r.text, /Nothing was done/);
});

test('somebody else cannot finish your reboot', () => {
  // Two people in a chat is the normal case, and a stranger answering a prompt
  // they did not read is a coincidence rather than a confirmation.
  const { token } = begin();
  const r = reboot(CFG, [token], { actor: 'telegram:999', exec: ok });
  assert.equal(r.ok, false);
  assert.match(r.text, /started by somebody else/);
});

test('the token expires, and a stale one starts over rather than working', () => {
  const t0 = 1_000_000;
  cancelReboot();
  const first = reboot(CFG, [], { actor: 'a', now: () => t0, exec: ok });
  const token = /\/reboot ([0-9a-f]{6})/.exec(first.text)?.[1] ?? '';

  const late = reboot(CFG, [token], { actor: 'a', now: () => t0 + 121_000, exec: ok });
  assert.equal(late.ok, false);
  assert.match(late.text, /expired|No reboot is pending/);
});

test('a token cannot be replayed after it has fired', () => {
  const { token } = begin();
  reboot(CFG, [token], { actor: 'telegram:1', exec: ok });
  reboot(CFG, [token, os.hostname()], { actor: 'telegram:1', exec: ok });

  const again = reboot(CFG, [token, os.hostname()], { actor: 'telegram:1', exec: ok });
  assert.equal(again.ok, false, 'single use — the same message sent twice must not reboot twice');
});

test('with reboot off, the refusal is the instructions and names its own rule', () => {
  const r = reboot(/** @type {any} */ ({ systemReboot: false, runUser: 'agent' }), []);
  assert.equal(r.ok, false);
  assert.match(r.text, /agent ALL=\(root\) NOPASSWD: \/usr\/bin\/systemctl reboot/);
  assert.match(r.text, /separate rule/, 'and says why it is not folded into the package one');
});
