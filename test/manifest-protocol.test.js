// The manifest's protocol number has to be the protocol's.
//
// It was `Number(process.env.RELEASE_PROTOCOL || 2)`, nothing ever set that
// variable, and the literal was correct on the day it was written. So the first
// manifest this project ever published — v0.2.1, built from code that speaks v3
// — advertised `"protocol": 2`.
//
// THAT IS THE DANGEROUS DIRECTION. A v2 host reading it sees its own number,
// concludes the release matches, installs v3 code and strands itself from its
// coordinator. Which is the exact failure the field exists to prevent, caused by
// the field — and release.js's own header says so: "A release built for a
// different protocol version strands this host from its coordinator, and it
// strands it AFTER the update, when it can no longer say so."
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

test('a manifest from another protocol is refused, in both directions', () => {
  // This is what the field buys, and it only works if the number is true.
  const base = { version: 'v9.9.9', file: 'x.tar.gz', sha256: 'a'.repeat(64) };

  const ahead = decideRelease({
    manifest: { ...base, protocol: PROTOCOL_VERSION + 1 },
    installed: 'v0.0.1',
    protocol: PROTOCOL_VERSION,
  });
  assert.equal(ahead.act, false, 'a release for a newer protocol was accepted');

  const behind = decideRelease({
    manifest: { ...base, protocol: PROTOCOL_VERSION - 1 },
    installed: 'v0.0.1',
    protocol: PROTOCOL_VERSION,
  });
  assert.equal(behind.act, false, 'a release for an older protocol was accepted');

  // And the matching one is acted on, or the guard above is just "never update".
  const matching = decideRelease({
    manifest: { ...base, protocol: PROTOCOL_VERSION },
    installed: 'v0.0.1',
    protocol: PROTOCOL_VERSION,
  });
  assert.equal(matching.act, true, `a matching release was refused: ${matching.message}`);
});

test('the refusal says which two numbers disagree', () => {
  // "cannot update" sends somebody to a document. The two versions are the
  // whole content of the problem, and the person reading it is the one who can
  // upgrade the other end.
  const decision = decideRelease({
    manifest: { version: 'v9.9.9', file: 'x.tar.gz', sha256: 'a'.repeat(64), protocol: PROTOCOL_VERSION + 1 },
    installed: 'v0.0.1',
    protocol: PROTOCOL_VERSION,
  });
  assert.match(String(decision.message), new RegExp(String(PROTOCOL_VERSION)));
  assert.match(String(decision.message), new RegExp(String(PROTOCOL_VERSION + 1)));
});
