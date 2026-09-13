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

/** Walk the flow to the PIN, returning it. @param {any} [opts] */
function begin(opts = {}) {
  cancelReboot();
  const first = reboot(CFG, [], { actor: 'telegram:1', sessions: ['cc-brave-otter'], exec: ok, ...opts });
  const pin = /\/reboot (\d{6})/.exec(first.text)?.[1];
  assert.ok(pin, 'step 1 issues a PIN');
  return { first, pin };
}

test('step 1 says what will be lost before asking anything', () => {
  const { first } = begin();
  assert.match(first.text, /cc-brave-otter/, 'the sessions are named, not counted');
  assert.match(first.text, /Nothing here resumes them afterwards/);
  assert.match(first.text, /Step 2 of 3/);
});

test('the PIN and the hostname together reboot the box — the message the apps send', () => {
  // The apps append the targeted host to the PIN the person typed, so the
  // confirm arrives as `/reboot <pin> <hostname>` in one message. That used to
  // be refused ("confirm the PIN on its own first"), which was a step no phone
  // could get past. It completes now: both proofs are present — the live PIN and
  // the right hostname — and step 1 was still its own message.
  const { pin } = begin();

  let ran = false;
  const done = reboot(CFG, [pin, os.hostname()], {
    actor: 'telegram:1',
    exec: () => { ran = true; return ok(); },
  });
  assert.equal(done.ok, true, done.text);
  assert.equal(ran, true);
});

test('the stepwise flow still works: the PIN alone gets step 3, then the hostname finishes', () => {
  // A client that does send the PIN on its own is not broken by making the
  // combined message work — it gets the step-3 prompt and finishes with the
  // hostname.
  const { pin } = begin();

  const second = reboot(CFG, [pin], { actor: 'telegram:1', exec: ok });
  assert.match(second.text, /Step 3 of 3/);

  let ran = false;
  const third = reboot(CFG, [pin, os.hostname()], {
    actor: 'telegram:1',
    exec: () => { ran = true; return ok(); },
  });
  assert.equal(third.ok, true);
  assert.equal(ran, true);
});

test('a reboot still cannot happen in one message — step 1 issues the live PIN first', () => {
  // The footgun the ceremony exists to prevent: a single message that reboots.
  // Step 1 hands out a live PIN that cannot be known in advance, so a first
  // message carrying a guessed pin and the hostname has no pending challenge to
  // match and does nothing.
  cancelReboot();
  const cold = reboot(CFG, ['000000', os.hostname()], { actor: 'telegram:1', exec: ok });
  assert.equal(cold.ok, false);
  assert.match(cold.text, /No reboot is pending/);
});

test('the wrong hostname is refused, which is the mistake worth preventing', () => {
  const { pin } = begin();
  reboot(CFG, [pin], { actor: 'telegram:1', exec: ok });

  let ran = false;
  const r = reboot(CFG, [pin, 'some-other-box'], {
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
  const { pin } = begin();
  const r = reboot(CFG, [pin], { actor: 'telegram:999', exec: ok });
  assert.equal(r.ok, false);
  assert.match(r.text, /started by somebody else/);
});

test('the PIN expires, and a stale one starts over rather than working', () => {
  const t0 = 1_000_000;
  cancelReboot();
  const first = reboot(CFG, [], { actor: 'a', now: () => t0, exec: ok });
  const pin = /\/reboot (\d{6})/.exec(first.text)?.[1] ?? '';

  const late = reboot(CFG, [pin], { actor: 'a', now: () => t0 + 121_000, exec: ok });
  assert.equal(late.ok, false);
  assert.match(late.text, /expired|No reboot is pending/);
});

test('a PIN cannot be replayed after it has fired', () => {
  const { pin } = begin();
  reboot(CFG, [pin], { actor: 'telegram:1', exec: ok });
  reboot(CFG, [pin, os.hostname()], { actor: 'telegram:1', exec: ok });

  const again = reboot(CFG, [pin, os.hostname()], { actor: 'telegram:1', exec: ok });
  assert.equal(again.ok, false, 'single use — the same message sent twice must not reboot twice');
});

test('with reboot off, the refusal is the instructions and names its own rule', () => {
  const r = reboot(/** @type {any} */ ({ systemReboot: false, runUser: 'agent' }), []);
  assert.equal(r.ok, false);
  assert.match(r.text, /agent ALL=\(root\) NOPASSWD: \/usr\/bin\/systemctl reboot/);
  assert.match(r.text, /separate rule/, 'and says why it is not folded into the package one');
});

test('an empty host asks once, because nothing is lost', () => {
  // THE CEREMONY COSTS WHAT THE REBOOT COSTS. Three confirmations were asked
  // of every reboot, including one of a box with nothing running — where the
  // whole loss is a machine being away for thirty seconds and coming back.
  //
  // That is not the end of the world, and a ritual that treats it as one is a
  // ritual people learn to rush — which is how the case that DOES matter gets
  // rushed too.
  const first = reboot(CFG, [], { actor: 'fleet:a@b.com', sessions: [], exec: ok });
  assert.equal(first.ok, true);
  assert.equal(first.reboot.sessions, 0);
  assert.equal(first.reboot.pinRequired, false);
  assert.doesNotMatch(first.text, /Step 2 of 3|PIN|pin/, 'an empty host was still asked for a pin');

  // The hostname alone finishes it — the step that says WHICH machine, which
  // is the one thing still worth asking when nothing is at stake.
  const done = reboot(CFG, [os.hostname()], { actor: 'fleet:a@b.com', exec: ok });
  assert.equal(done.ok, true, done.text);
});

test('an empty host still refuses the wrong hostname', () => {
  reboot(CFG, [], { actor: 'fleet:a@b.com', sessions: [], exec: ok });
  const wrong = reboot(CFG, ['some-other-box'], { actor: 'fleet:a@b.com', exec: ok });
  assert.equal(wrong.ok, false);
  assert.match(wrong.text, /not some-other-box/);
});

test('a host with work on it cannot be talked out of its pin', () => {
  // `pin: null` is set by step one and ONLY by step one. There is no argument
  // that turns the pin off, and a box that had sessions when it was asked keeps
  // needing one even if they end while somebody is deciding — otherwise "wait
  // for the work to finish" becomes a way to lower the bar.
  const first = reboot(CFG, [], { actor: 'fleet:a@b.com', sessions: ['cc-brave-otter'], exec: ok });
  assert.equal(first.reboot.pinRequired, true);
  assert.equal(first.reboot.sessions, 1);

  const skipped = reboot(CFG, [os.hostname()], { actor: 'fleet:a@b.com', sessions: [], exec: ok });
  assert.equal(skipped.ok, false, 'the hostname alone finished a reboot that had issued a pin');
});

test('the counts travel as data, so a screen sizes its own ceremony', () => {
  // The apps ask for a fingerprint when this says nothing is running, and for
  // the pin when it does not. Reading it out of the prose would break the first
  // time the wording changed — the same rule as `waiting`, `entries`, `channel`.
  const empty = reboot(CFG, [], { actor: 'fleet:x@y.z', sessions: [], exec: ok });
  assert.equal(typeof empty.reboot.pinRequired, 'boolean');
  assert.equal(empty.reboot.hostname, os.hostname());
});
