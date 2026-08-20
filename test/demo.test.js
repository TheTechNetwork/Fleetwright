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

// --- the sign-in path -------------------------------------------------------

test('a device credential is refused once revoked, and revoking one leaves the rest', async () => {
  // The property the whole exercise is for: losing a phone costs that phone.
  const { ClientRegistry } = await import('../src/fleet/coordinator/clients.js');
  const clients = new ClientRegistry();

  const phone = await clients.issue('Eli iPhone');
  const pixel = await clients.issue('Eli Pixel');

  assert.ok(await clients.verify(phone.token));
  assert.ok(await clients.verify(pixel.token));

  assert.equal(clients.revoke(phone.client.id), true);
  assert.equal(await clients.verify(phone.token), null, 'the lost phone is out');
  assert.ok(await clients.verify(pixel.token), 'and nothing else had to change');

  assert.equal(clients.revoke(phone.client.id), false, 'revoking twice is not an error worth reporting');
});

test('a token is stored hashed, so the registry is not a list of credentials', async () => {
  const { ClientRegistry, hashSecret } = await import('../src/fleet/coordinator/clients.js');
  const clients = new ClientRegistry();
  const { client, token } = await clients.issue('phone');

  const stored = JSON.stringify(clients.serialise());
  const secret = token.split('_')[2];
  assert.equal(stored.includes(secret), false, 'the secret is not in what gets persisted');
  assert.equal(client.secretHash, await hashSecret(secret));

  // And what an app renders carries no hash either.
  assert.equal(JSON.stringify(clients.list()).includes(client.secretHash), false);
});

test('a credential survives being persisted and restored', async () => {
  const { ClientRegistry } = await import('../src/fleet/coordinator/clients.js');
  const before = new ClientRegistry();
  const { token } = await before.issue('phone');

  const after = new ClientRegistry();
  after.restore(JSON.parse(JSON.stringify(before.serialise())));
  assert.ok(await after.verify(token), 'a Durable Object eviction must not sign everybody out');
});

test('the identity screen has something to show', () => {
  // A reviewer opens Settings before anything else. Without these the panel is
  // empty and the buttons report errors, which reads as a broken app rather
  // than a demo fleet.
  const hosts = /** @type {any} */ (call('/api/hosts/enrolled'));
  assert.equal(hosts.hosts.length, 2);
  for (const h of hosts.hosts) {
    assert.match(h.hostId, /^demo-/);
    assert.match(h.fingerprint, /^[0-9a-f]{16}$/, 'the app renders this next to the name');
    assert.equal(h.revokedAt, null);
  }

  const minted = /** @type {any} */ (call('/api/enroll', 'POST', { kind: 'host' }));
  assert.match(minted.code, /^\d{6}$/);
  assert.match(minted.text, /demo/i, 'and it says it is not a real pin');

  assert.equal(/** @type {any} */ (call('/api/hosts/demo-attic', 'DELETE')).ok, true);
});

test('the demo cannot express anything about a real host', () => {
  // The property that matters, restated for the routes added above: every
  // answer comes from constants in this file, and there is no path from any of
  // them to the Durable Object.
  const body = JSON.stringify([
    call('/api/hosts/enrolled'),
    call('/api/enroll', 'POST', { kind: 'host' }),
    call('/api/hosts/anything', 'DELETE'),
  ]);
  assert.equal(/fwk_|[0-9a-f]{48}/.test(body), false, 'no credential-shaped string is ever returned');
  for (const name of ['deb13-staging', 'thetech']) {
    assert.equal(body.includes(name), false);
  }
});
