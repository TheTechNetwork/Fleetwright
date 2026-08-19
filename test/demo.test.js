// The demo fleet: what App Store review sees, and what it must never reach.
//
// The property worth testing is not "the shapes look right" — it is that a
// demo request is answered from constants and cannot express anything about a
// real host. The shapes matter too, because an app that cannot parse the demo
// is an app the reviewer reports as broken.

import test from 'node:test';
import assert from 'node:assert/strict';

import { demoReply } from '../worker/src/demo.js';

/** @param {string} path @param {string} [method] @param {any} [body] */
const call = (path, method = 'GET', body = null) => demoReply(new URL(`https://x${path}`), method, body);

test('the demo fleet answers /api/hosts in the coordinator shape', () => {
  const r = /** @type {any} */ (call('/api/hosts'));
  assert.deepEqual(Object.keys(r).sort(), ['devices', 'events', 'hosts', 'ok', 'protocol']);
  assert.equal(r.hosts.length, 2);
  for (const h of r.hosts) {
    assert.deepEqual(Object.keys(h).sort(), ['connected', 'connectedAt', 'health', 'healthAt', 'hostId', 'reason', 'state']);
    assert.match(h.hostId, /^demo-/, 'a demo host says so, so nobody reading a support question is misled');
  }
});

test('list returns sessions an app can render', () => {
  const r = /** @type {any} */ (call('/api/list'));
  assert.equal(r.ok, true);
  assert.equal(r.sessions.length, 3);
  for (const s of r.sessions) {
    for (const key of ['name', 'title', 'status', 'hostId', 'resumable', 'uuid']) {
      assert.ok(key in s, `session is missing ${key}`);
    }
  }
  // One waiting on a person: the state the whole product exists for, and the
  // one a reviewer should be able to see.
  assert.ok(r.sessions.some((/** @type {any} */ s) => s.status === 'awaiting-input'));
});

test('mutating verbs answer plausibly and change nothing', () => {
  const before = JSON.stringify(call('/api/list'));
  assert.equal(/** @type {any} */ (call('/api/stop/cc-brave-otter')).ok, true);
  assert.equal(/** @type {any} */ (call('/api/intent', 'POST', { verb: 'start' })).ok, true);
  assert.equal(/** @type {any} */ (call('/api/resume/cc-quiet-heron')).ok, true);
  assert.equal(JSON.stringify(call('/api/list')), before, 'the demo fleet is a constant, not a state machine');
});

test('a name that is not a name is refused rather than reflected', () => {
  const r = /** @type {any} */ (call('/api/status/' + encodeURIComponent('--dangerous')));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'bad_name');
});

test('an unknown session says so instead of inventing one', () => {
  const r = /** @type {any} */ (call('/api/status/cc-not-here'));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'no_such_session');
});

test('anything the demo does not serve returns null, never a real answer', () => {
  assert.equal(call('/host/connect'), null, 'a host must never be served by the demo');
  assert.equal(call('/api/whatever'), null);
  assert.equal(call('/'), null);
});
