// The manifest's protocol number has to be the protocol's.
//
// It was `Number(process.env.RELEASE_PROTOCOL || 2)`, nothing ever set that
// variable, and the literal was correct on the day it was written. So the first
// manifest this project ever published — v0.2.1, built from code that speaks v3
// — advertised `"protocol": 2`.
//
// The number still has to be TRUE, but the reason has shifted. It once gated
// updates in both directions (refuse anything but an exact match), on the
// reasoning that a host installing a newer protocol would strand itself. Version
// negotiation removed that danger — an updated host down-speaks to whatever the
// coordinator supports — so a forward bump is now takeable, and refusing it was
// a deadlock: the release is the only way to cross the bump. What the number
// still buys is the DOWNGRADE guard (a host must not move backward below the
// coordinator's floor) and the coordinator's own range logic, and a wrong
// number breaks both silently.
//
// Same shape as the installer's node floor: a number written down in a second
// place, with a default that made being wrong silent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { decideRelease } from '../src/core/release.js';

const BUILDER = readFileSync(new URL('../tools/build-host-package.mjs', import.meta.url), 'utf8');

test('the builder reads the protocol rather than being told it', () => {
  assert.match(BUILDER, /protocol: PROTOCOL_VERSION,/);
  assert.match(BUILDER, /from '\.\.\/src\/fleet\/protocol\/intents\.js'/);
  // No environment override and no literal fallback. Either would let a build
  // machine publish a number the code does not agree with.
  // Comments are where the history lives — one of them names the variable that
  // caused this — so the assertion reads the code.
  assert.equal(/RELEASE_PROTOCOL/.test(BUILDER.replace(/^\s*\/\/.*$/gm, '')), false,
    'the protocol is settable from the environment again');
});

test('the builder has a recovery mode that omits protocol, to unstick stranded hosts', () => {
  // The one lever on a host already stranded on pre-fix code: a manifest its old
  // gate does not refuse. That gate only fires when protocol is present, so a
  // recovery release omits it — accepted by every host's existing update button.
  const code = BUILDER.replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /RELEASE_RECOVERY/, 'no recovery mode to build the unsticking manifest');
  assert.match(code, /delete manifest\.protocol/, 'recovery must OMIT protocol, not set it');
});

test('a forward or matching protocol is taken; a downgrade is refused', () => {
  // What the number buys now, and it only works if it is true.
  const base = { version: 'v9.9.9', file: 'x.tar.gz', sha256: 'a'.repeat(64) };

  // Ahead: taken. Negotiation makes the forward move safe, and it is the only
  // way to cross the bump — refusing it was the deadlock.
  const ahead = decideRelease({
    manifest: { ...base, protocol: PROTOCOL_VERSION + 1 },
    installed: 'v0.0.1',
    protocol: PROTOCOL_VERSION,
  });
  assert.equal(ahead.act, true, 'a forward protocol bump must be takeable — it is the only path across');

  // Behind: refused. Moving backward can drop a host below the fleet floor.
  const behind = decideRelease({
    manifest: { ...base, protocol: PROTOCOL_VERSION - 1 },
    installed: 'v0.0.1',
    protocol: PROTOCOL_VERSION,
  });
  assert.equal(behind.act, false, 'a downgrade was accepted');
  assert.equal(behind.reason, 'protocol');

  // Matching: taken, or the guard above is just "never update".
  const matching = decideRelease({
    manifest: { ...base, protocol: PROTOCOL_VERSION },
    installed: 'v0.0.1',
    protocol: PROTOCOL_VERSION,
  });
  assert.equal(matching.act, true, `a matching release was refused: ${matching.message}`);
});

test('the downgrade refusal says which two numbers disagree', () => {
  // "cannot update" sends somebody to a document. The two versions are the whole
  // content of the problem.
  const decision = decideRelease({
    manifest: { version: 'v0.0.1', file: 'x.tar.gz', sha256: 'a'.repeat(64), protocol: PROTOCOL_VERSION - 1 },
    installed: 'v9.9.9',
    protocol: PROTOCOL_VERSION,
  });
  assert.match(String(decision.message), new RegExp(String(PROTOCOL_VERSION)));
  assert.match(String(decision.message), new RegExp(String(PROTOCOL_VERSION - 1)));
});
