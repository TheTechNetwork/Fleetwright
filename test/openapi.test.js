// The spec, used as a test rather than as a document.
//
// There are two implementations of this API and they are required to behave
// identically. Five parity bugs reached this branch before openapi.json existed
// — a route on one coordinator and not the other, divergent actor handling,
// different response shapes, different persistence, different page sizes — and
// each was found the hard way, by something breaking.
//
// So the point of this file is not that the document is accurate. It is that
// the document is EXECUTED: every path in it is asserted against both
// coordinators, and a route added to one and forgotten on the other fails here
// instead of on somebody's phone.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateKeyPair } from '../src/fleet/crypto.js';
import { Coordinator } from '../src/fleet/coordinator/server.js';
import { Fleet } from '../worker/src/fleet-do.js';
import worker from '../worker/src/worker.js';

const SPEC = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const ADMIN = 'a-token-at-least-16ch';

/** Every path/method the document declares, with whether it needs a credential. */
function declared() {
  const out = [];
  for (const [path, item] of Object.entries(SPEC.paths)) {
    for (const [method, op] of Object.entries(item)) {
      // `security: []` on an operation means "deliberately reachable without
      // one", and every such route in this API is there for a stated reason.
      out.push({ path, method: method.toUpperCase(), open: Array.isArray(op.security) && op.security.length === 0, op });
    }
  }
  return out;
}

/**
 * A body that lets the route get far enough to prove it is routed.
 *
 * DELETE /api/devices names its target in the BODY rather than the path — a
 * push token is not a path segment — so a body-less request answers 404 for
 * "not registered", which is indistinguishable from 404 for "no such route".
 *
 * @param {string} path
 */
function bodyFor(path) {
  if (path === '/api/devices') return JSON.stringify({ platform: 'ios', token: 'a'.repeat(64) });
  return '{}';
}

/** A path with its parameters filled in, so it can actually be requested. */
function concrete(path, ids = {}) {
  return path.replace('{hostId}', ids.hostId || 'some-host').replace('{id}', ids.clientId || 'some-id');
}

/**
 * Put a host, a client and a device into a coordinator so the DELETE routes
 * have something to delete.
 *
 * Without this the existence check cannot work: a routed
 * `DELETE /api/hosts/nope` answers 404 for "no such host", which is
 * indistinguishable from the 404 that means "no such route". Seeding makes the
 * difference legible — a routed delete of something that exists answers 200.
 */
async function seed(core) {
  await core.hostIds.enrol({ hostId: 'seeded-host', publicJwk: (await generateKeyPair()).publicJwk });
  const { client } = await core.clients.issue('a phone (someone@example.com)');
  core.registerDevice({ platform: 'ios', token: 'a'.repeat(64) });
  return { hostId: 'seeded-host', clientId: client.id };
}

/** The Worker, wired to a real Durable Object rather than a stub. */
function workerFleet() {
  const storage = new Map();
  const state = {
    storage: {
      get: async (/** @type {string} */ k) => storage.get(k),
      put: async (/** @type {string} */ k, /** @type {any} */ v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    },
    blockConcurrencyWhile: (/** @type {() => any} */ fn) => fn(),
    getWebSockets: () => [],
    setAlarm: () => {},
  };
  const fleet = new Fleet(/** @type {any} */ (state), { AGENT_FLEET_API_TOKEN: ADMIN });
  return {
    fleet,
    call: (/** @type {string} */ path, /** @type {string} */ method, /** @type {Record<string,string>} */ headers = {}) =>
      worker.fetch(
        new Request(`https://fleet.example${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : bodyFor(path) }),
        /** @type {any} */ ({ FLEET: { idFromName: () => 'id', get: () => fleet }, AGENT_FLEET_API_TOKEN: ADMIN }),
      ),
  };
}

/** @param {import('node:test').TestContext} t */
async function nodeFleet(t) {
  const c = new Coordinator({ apiToken: ADMIN });
  const port = await c.listen(0, '127.0.0.1');
  t.after(() => c.close());
  return {
    coordinator: c,
    call: (/** @type {string} */ path, /** @type {string} */ method, /** @type {Record<string,string>} */ headers = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: method === 'GET' ? undefined : bodyFor(path),
      }),
  };
}

test('the document is a valid enough OpenAPI to be worth executing', () => {
  assert.match(SPEC.openapi, /^3\.1/);
  assert.ok(Object.keys(SPEC.paths).length >= 12, 'the API is bigger than a handful of routes');
  for (const [path, item] of Object.entries(SPEC.paths)) {
    assert.match(path, /^\//, path);
    for (const [method, op] of Object.entries(item)) {
      assert.ok(op.summary, `${method} ${path} has no summary`);
      assert.ok(op.responses && Object.keys(op.responses).length, `${method} ${path} declares no responses`);
    }
  }
});

test('every documented route exists on the Node coordinator', async (t) => {
  const { call, coordinator } = await nodeFleet(t);
  const ids = await seed(coordinator.core);
  const missing = [];
  for (const { path, method } of declared()) {
    const res = await call(concrete(path, ids), method, { authorization: `Bearer ${ADMIN}` });
    // 404 is the one answer that means "this route is not implemented here".
    // Anything else — including 400, 401, 403 — means it was routed.
    if (res.status === 404) missing.push(`${method} ${path}`);
  }
  assert.deepEqual(missing, [], 'documented but not implemented');
});

test('every documented route exists on the Worker', async () => {
  const { call, fleet } = workerFleet();
  const ids = await seed(fleet.core);
  const missing = [];
  for (const { path, method } of declared()) {
    const res = await call(concrete(path, ids), method, { authorization: `Bearer ${ADMIN}` });
    if (res.status === 404) missing.push(`${method} ${path}`);
  }
  assert.deepEqual(missing, [], 'documented but not implemented');
});

test('a route open in the document is open in both, and no others are', async (t) => {
  // This is the assertion with teeth. The set of routes reachable without a
  // credential is the API's attack surface, and it must be a deliberate list
  // rather than whatever the routing happens to allow. `?token=fwk_` was once
  // full access precisely because that set was decided in two places.
  const node = await nodeFleet(t);
  const wrk = workerFleet();

  for (const { path, method, open } of declared()) {
    for (const [label, call] of [['node', node.call], ['worker', wrk.call]]) {
      const res = await call(concrete(path), method, {});
      const body = await res.json().catch(() => ({}));
      // TWO DIFFERENT 401s, and the difference is the whole test.
      //
      // The credential gate answers `error.code === 'unauthorised'`. An open
      // route can also answer 401 on its own terms — /api/host/verify says so
      // when a proof does not verify, which is exactly right and is not the
      // same thing. Asserting on the status alone would have called that a
      // guarded route and hidden the distinction the document is drawing.
      const askedForCredential = res.status === 401 && /** @type {any} */ (body)?.error?.code === 'unauthorised';
      if (open) {
        assert.equal(askedForCredential, false, `${label} ${method} ${path} is documented as open and asked for a credential`);
      } else {
        assert.equal(askedForCredential, true, `${label} ${method} ${path} is documented as guarded and answered ${res.status} without one`);
      }
    }
  }
});

test('both coordinators answer /healthz in the documented shape', async (t) => {
  const node = await nodeFleet(t);
  const wrk = workerFleet();
  const shape = SPEC.paths['/healthz'].get.responses['200'].content['application/json'].schema;

  for (const [label, call] of [['node', node.call], ['worker', wrk.call]]) {
    const res = await call('/healthz', 'GET');
    assert.equal(res.status, 200, label);
    const body = /** @type {any} */ (await res.json());
    for (const key of shape.required) assert.ok(key in body, `${label} /healthz has no ${key}`);
    assert.equal(typeof body.protocol, 'number', label);
  }
});

test('the intent verbs in the document are the verbs the protocol has', async () => {
  // A document that drifts from the verb set is worse than none: it is the
  // thing an app author builds against.
  const { VERBS } = await import('../src/fleet/protocol/intents.js');
  const documented = SPEC.paths['/api/intent'].post.requestBody.content['application/json'].schema.properties.verb.enum;
  assert.deepEqual([...documented].sort(), Object.keys(VERBS).sort());
});

test('both coordinators serve the contract they implement', async (t) => {
  // And it must be the SAME document. The Worker inlines it because it ships no
  // files; the Node coordinator reads it off disk. Two copies is how a spec
  // starts describing one implementation and not the other.
  const node = await nodeFleet(t);
  const wrk = workerFleet();

  const fromNode = await (await node.call('/openapi.json', 'GET')).json();
  const fromWorker = await (await wrk.call('/openapi.json', 'GET')).json();

  assert.equal(/** @type {any} */ (fromNode).info.version, SPEC.info.version);
  assert.deepEqual(Object.keys(/** @type {any} */ (fromWorker).paths).sort(), Object.keys(SPEC.paths).sort());
  assert.deepEqual(
    Object.keys(/** @type {any} */ (fromNode).paths).sort(),
    Object.keys(/** @type {any} */ (fromWorker).paths).sort(),
    'the Worker has been rebuilt from a different openapi.json than the one on disk',
  );
});

test('the enums in the document are the enums in the code', async () => {
  // The Host.state enum said three values and registry.js declares four —
  // `offline`, which is what a host becomes when its socket drops, and which is
  // a thing we KNOW as opposed to `unknown`, which is what we say when we have
  // not heard recently enough to be sure. A client that collapses them reports
  // a box we know is gone as a box we cannot see.
  //
  // Caught by a designer reading registry.js, not by this file, because the
  // route tests assert that a path is ROUTED and never look at the shape of
  // what comes back. This is that gap, closed for the enums that matter.
  const registry = readFileSync(new URL('../src/fleet/coordinator/registry.js', import.meta.url), 'utf8');
  const declared = /** @type {string[]} */ (SPEC.components.schemas.Host.properties.state.enum);
  const inCode = [...registry.matchAll(/'(healthy|degraded|unknown|offline)'/g)].map((m) => m[1]);
  for (const state of new Set(inCode)) {
    assert.ok(declared.includes(state), `registry.js can produce state '${state}' and the document does not list it`);
  }

  const sessions = readFileSync(new URL('../src/core/sessions.js', import.meta.url), 'utf8');
  const status = /** @type {string[]} */ (SPEC.components.schemas.Session.properties.status.enum);
  for (const s of ['running', 'stopped', 'error']) {
    if (sessions.includes(`'${s}'`)) assert.ok(status.includes(s), `sessions.js produces '${s}' and the document does not list it`);
  }
});
