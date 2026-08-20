// What the Worker answers WITHOUT a credential.
//
// Everything else in this file's routing is a gate; these four are the holes in
// it, and a hole nobody meant to leave is the failure worth catching. Each one
// is here for a stated reason, and the test is really "the list is still
// exactly this long".
//
// The Durable Object is never reached by any of them, so a stub that throws is
// the right binding: if one of these ever starts fetching the object, this
// fails loudly rather than quietly working.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/worker.js';

/** A DO binding that must not be used. */
const noFleet = {
  idFromName() {
    throw new Error('the Durable Object was reached on an unauthenticated route');
  },
  get() {
    throw new Error('the Durable Object was reached on an unauthenticated route');
  },
};

/** @param {string} path */
const get = (path, env = {}) =>
  worker.fetch(new Request(`https://fleet.example${path}`), /** @type {any} */ ({ FLEET: noFleet, ...env }));

test('liveness needs nothing, and says nothing', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  const body = /** @type {any} */ (await res.json());
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'protocol']);
  // No host names, no counts. A liveness endpoint that leaks the fleet is not
  // a liveness endpoint.
  assert.equal(JSON.stringify(body).includes('host'), false);
});

test('the privacy policy is public, because App Store Connect requires one', async () => {
  const res = await get('/privacy');
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /text\/html/);
});

test('the install one-liner redirects to the script in this repository', async () => {
  // A box being installed has no credential — acquiring one is what the install
  // is for — so this has to sit above the token gate.
  for (const path of ['/install', '/install.sh']) {
    const res = await get(path);
    assert.equal(res.status, 302, path);
    assert.match(String(res.headers.get('location')), /install\/bootstrap\.sh$/);
  }
});

test('a redirect, not a copy of the script', async () => {
  // The thing people paste into a root shell should be served by the place that
  // has the source. A Worker that returned the script itself could go stale
  // here, and could be edited here.
  const res = await get('/install');
  assert.equal((await res.text()).includes('#!/bin/sh'), false);
});

test('everything else refuses before the object is reached', async () => {
  // Not "we are careful" — the binding above throws, so this asserts that the
  // fleet is unreachable rather than merely unauthorised.
  for (const path of ['/api/hosts', '/api/intent', '/api/clients', '/api/enroll', '/']) {
    const res = await get(path, { AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' });
    assert.equal(res.status, 401, path);
  }
});

test('with no admin token configured it refuses everything and says which', async () => {
  const res = await get('/api/hosts');
  assert.equal(res.status, 503);
  assert.match(/** @type {any} */ ((await res.json()).text), /AGENT_FLEET_API_TOKEN/);
});

test('the admin token gets through, and a wrong one does not', async () => {
  // The other half of the check above, and the half that was broken: the gate
  // has to LET SOMETHING THROUGH. `expected` was deleted with the host token
  // while the comparison that used it stayed, so every authenticated request
  // threw ReferenceError — a Worker that refuses everybody looks a lot like a
  // Worker that is working, right up until nothing works.
  let reached = 0;
  const fleet = {
    idFromName: () => 'id',
    get: () => ({ fetch: async () => { reached++; return new Response('{"ok":true}'); } }),
  };
  const env = { FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' };

  const good = await worker.fetch(
    new Request('https://fleet.example/api/hosts', { headers: { authorization: 'Bearer a-token-at-least-16ch' } }),
    /** @type {any} */ (env),
  );
  assert.equal(good.status, 200);
  assert.equal(reached, 1);

  const bad = await worker.fetch(
    new Request('https://fleet.example/api/hosts', { headers: { authorization: 'Bearer nope' } }),
    /** @type {any} */ (env),
  );
  assert.equal(bad.status, 401);
  assert.equal(reached, 1, 'and it never reached the object');
});

test('a device credential is passed to the object rather than refused here', async () => {
  // The Durable Object holds the client registry, so it is the only thing that
  // can say whether an fwk_ token is live. The Worker must not guess.
  let reached = 0;
  const fleet = {
    idFromName: () => 'id',
    get: () => ({ fetch: async () => { reached++; return new Response('{"ok":true}'); } }),
  };
  const res = await worker.fetch(
    new Request('https://fleet.example/api/hosts', { headers: { authorization: 'Bearer fwk_abc_def' } }),
    /** @type {any} */ ({ FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' }),
  );
  assert.equal(res.status, 200);
  assert.equal(reached, 1);
});

test('host routes reach the object without any token at all', async () => {
  // They authenticate by signature, inside the object, which is the only thing
  // holding the enrolled keys.
  let reached = [];
  const fleet = {
    idFromName: () => 'id',
    get: () => ({ fetch: async (/** @type {Request} */ r) => { reached.push(new URL(r.url).pathname); return new Response('{}'); } }),
  };
  const env = /** @type {any} */ ({ FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' });
  for (const path of ['/host/connect', '/api/host/challenge', '/api/host/verify', '/api/enroll/host']) {
    await worker.fetch(new Request(`https://fleet.example${path}`), env);
  }
  assert.deepEqual(reached, ['/host/connect', '/api/host/challenge', '/api/host/verify', '/api/enroll/host']);
});
