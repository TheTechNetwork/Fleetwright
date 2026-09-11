// THE INVARIANT THAT MAKES THE VERSION RANGE SOUND.
//
// validateIntent accepts any version in [PROTOCOL_MIN, PROTOCOL_VERSION] rather
// than a single point (see PROTOCOL_MIN in intents.js). That is only safe if an
// older envelope means the SAME thing under newer code — which holds exactly
// while the protocol is append-only: a bump may ADD a verb or a param, and may
// never remove one or change what an existing one means. Then an old envelope is
// a strict subset of a new one and reading it under new code is sound.
//
// This is the enforcement, not a promise in a comment. BASELINE is the frozen
// history of the wire surface: every verb, every param, and the version each
// param was introduced at. The live VERBS must still contain all of it, with
// every `since` unchanged — and anything added must be recorded here, stamped
// with the version that introduced it, which is the one deliberate act a bump
// is allowed. Break the invariant and this fails before a range can carry a
// wrong meaning.
//
//   node --test test/protocol-appendonly.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { VERBS, PROTOCOL_VERSION, PROTOCOL_MIN } from '../src/fleet/protocol/intents.js';

// APPEND ONLY. When a bump adds a verb or a param, add it here with its `since`
// (the PROTOCOL_VERSION that introduced it; params from a verb's beginning are
// 1). You may NEVER change or delete an entry — that is the whole point.
const BASELINE = Object.freeze({
  list: {},
  status: { name: 1 },
  peek: { name: 1, lines: 1 },
  health: {},
  start: { name: 1, mode: 1, title: 1, brief: 1, profile: 3 },
  channel: { to: 1 },
  sandbox: { to: 1 },
  labels: { add: 1, remove: 1 },
  profiles: {},
  resume: { name: 1, choice: 1 },
  stop: { name: 1 },
  updates: {},
  logs: { name: 1, service: 1, lines: 1 },
  files: { name: 1, path: 1 },
  readfile: { name: 1, path: 1 },
  writefile: { name: 1, path: 1, content: 1 },
  copyfile: { name: 1, path: 1, to: 1 },
  deletefile: { name: 1, path: 1 },
  update: { restart: 1 },
  upgrade: { apply: 1 },
  reboot: { pin: 1, confirm: 1 },
  answer: { name: 1, option: 1, promptId: 1 },
  forget: { name: 1 },
  restore: { name: 1 },
  purge: { name: 1 },
  connect: { provider: 1, scope: 1 },
  link: { provider: 1, secret: 1, scope: 1 },
  verify: { provider: 1, scope: 1 },
  unlink: { provider: 1, scope: 1 },
  renew: { provider: 1, clientId: 1, refresh: 1, client: 1 },
  provision: { platform: 1, minutes: 1, ticket: 1 },
});

/** @param {import('../src/fleet/protocol/intents.js').ParamSpec} ps */
const since = (ps) => ps.since ?? 1;

test('nothing in the protocol has been removed, and no `since` has changed', () => {
  for (const [verb, params] of Object.entries(BASELINE)) {
    assert.ok(VERBS[verb], `verb "${verb}" is gone — a bump may only ADD, never remove`);
    for (const [p, was] of Object.entries(params)) {
      const ps = VERBS[verb].params[p];
      assert.ok(ps, `${verb}.${p} is gone — a param present at a version may never disappear`);
      assert.equal(
        since(ps),
        was,
        `${verb}.${p} changed its introduction version (${was} → ${since(ps)}); \`since\` is immutable`,
      );
    }
  }
});

test('anything added to the wire is recorded here, so the append is deliberate', () => {
  // The other direction: a verb or param that exists in code but not in BASELINE
  // is an undocumented surface change. Adding it here — with its `since` — is the
  // one edit a bump is allowed to make to this file, and forgetting it fails
  // loudly rather than letting a range quietly carry something unrecorded.
  for (const [verb, spec] of Object.entries(VERBS)) {
    assert.ok(BASELINE[verb], `verb "${verb}" is not in BASELINE — add it (append-only) when you add the verb`);
    for (const p of Object.keys(spec.params)) {
      assert.ok(
        p in BASELINE[verb],
        `${verb}.${p} is not in BASELINE — record it with its \`since\` when you add the param`,
      );
    }
  }
});

test('no param claims to come from a version this code cannot speak', () => {
  // A param cannot be introduced in the future: its `since` is at most the
  // current version. (It MAY be below PROTOCOL_MIN — that is an old param the
  // floor has risen past, still read, never gated out.)
  for (const [verb, spec] of Object.entries(VERBS)) {
    for (const [p, ps] of Object.entries(spec.params)) {
      assert.ok(since(ps) <= PROTOCOL_VERSION, `${verb}.${p} has since ${since(ps)} > PROTOCOL_VERSION ${PROTOCOL_VERSION}`);
      assert.ok(Number.isInteger(since(ps)) && since(ps) >= 1, `${verb}.${p} has a nonsense since ${since(ps)}`);
    }
  }
});

test('the floor is not above the ceiling', () => {
  // A range with PROTOCOL_MIN > PROTOCOL_VERSION would accept nothing and refuse
  // every honest envelope, which is the one way this whole mechanism can be set
  // to strand the entire fleet at once.
  assert.ok(PROTOCOL_MIN <= PROTOCOL_VERSION, `PROTOCOL_MIN ${PROTOCOL_MIN} must not exceed PROTOCOL_VERSION ${PROTOCOL_VERSION}`);
  assert.ok(Number.isInteger(PROTOCOL_MIN) && PROTOCOL_MIN >= 1, 'PROTOCOL_MIN must be a positive integer');
});
