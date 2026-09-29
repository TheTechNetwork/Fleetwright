// Five defects found by reading the join and retention paths end to end for
// docs/auth-and-join.md, each written as the behaviour that was missing rather
// than as the line that was wrong — because every one of them was a field or a
// call that existed at every layer but one, and a test of any single function
// could not see it.
//
//   1. a pin minted `ephemeral` produced a PERMANENT host record, so the
//      retirement that fires on disconnect never fired for a pin-enrolled runner
//   2. that runner's owner was always null, because the pin's actor is a bare
//      email and the reader wanted `fleet:<email>`
//   3. admin rows were swept with everybody else's after thirty days, and the
//      two checks that read revoked admin rows then read nothing
//   4. a revoked host stayed in the registry as `offline` until a restart
//   5. an Actions runner enrolled under the coordinator's name and dialled
//      under the workflow's, because the enrol step set an env var in a process
//      that had already exited

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Coordinator } from './helpers/node-coordinator.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { ClientRegistry } from '../src/fleet/coordinator/clients.js';
import { emailOf } from '../src/fleet/coordinator/enrollment.js';
import { generateKeyPair } from '../src/fleet/crypto.js';
import { recordAssignedName, readAssignedName, assignedNameFile } from '../src/fleet/host/identity.js';
import { loadSidecarConfig } from '../src/fleet/host/config.js';
import { Authorizations, s256 } from '../src/mcp/oauth.js';
import { Fleet } from '../worker/src/fleet-do.js';
import worker from '../worker/src/worker.js';

const ADMIN = 'a-token-at-least-16ch';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** The Worker, wired to a real Durable Object over an in-memory storage stub. */
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
  const fleet = new Fleet(/** @type {any} */ (state), { FLEETWRIGHT_API_TOKEN: ADMIN });
  const env = { FLEET: { idFromName: () => 'id', get: () => fleet }, FLEETWRIGHT_API_TOKEN: ADMIN };
  return {
    core: fleet.core,
    call: (/** @type {string} */ p, /** @type {string} */ method, /** @type {any} */ body, /** @type {Record<string,string>} */ headers = {}) =>
      worker.fetch(
        new Request(`https://fleet.example${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
        /** @type {any} */ (env),
      ),
  };
}

/** @param {import('node:test').TestContext} t */
async function nodeFleet(t) {
  const c = new Coordinator({ apiToken: ADMIN, logger: silent });
  const port = await c.listen(0, '127.0.0.1');
  t.after(() => c.close());
  return {
    core: c.core,
    call: (/** @type {string} */ p, /** @type {string} */ method, /** @type {any} */ body, /** @type {Record<string,string>} */ headers = {}) =>
      fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }),
  };
}

const bearer = (/** @type {string} */ token) => ({ authorization: `Bearer ${token}` });

/**
 * Sign somebody in without a provider: a device credential issued straight
 * from the core, the way /api/session would after verifying an ID token.
 * @param {CoordinatorCore} core @param {string} email
 */
async function member(core, email) {
  const issued = await core.issueClient({ email, name: 'Someone' }, 'a phone');
  assert.ok('token' in issued && issued.token, 'the test needs a credential');
  return issued.token;
}

for (const [name, build] of /** @type {const} */ ([
  ['the Node coordinator', nodeFleet],
  ['the Worker', async () => workerFleet()],
])) {
  test(`1+2. on ${name}, a pin minted ephemeral enrols an ephemeral host that belongs to whoever minted it`, async (t) => {
    const fleet = await build(t);
    const token = await member(fleet.core, 'minter@example.com');

    const minted = await (await fleet.call('/api/enroll', 'POST', { kind: 'host', ephemeral: true }, bearer(token))).json();
    assert.ok(minted.code, 'a pin was minted');

    const { publicJwk } = await generateKeyPair();
    const enrolled = await fleet.call('/api/enroll/host', 'POST', { code: minted.code, hostId: 'gha-throwaway-1', publicJwk });
    assert.equal(enrolled.status, 200, await enrolled.text());

    const record = fleet.core.hostIds.get('gha-throwaway-1');
    assert.ok(record, 'the host is enrolled');
    // THE RECORD IS WHAT hostConnected READS. Before this, mint kept the flag
    // and the redemption dropped it, so the record said permanent and the
    // runner was never retired.
    assert.equal(record.ephemeral, true, 'the record carries ephemeral');
    assert.equal(record.owner, 'minter@example.com', 'and names who minted the pin');
  });

  test(`1. on ${name}, a plain pin still enrols a permanent, unowned host`, async (t) => {
    const fleet = await build(t);
    const token = await member(fleet.core, 'minter@example.com');
    const minted = await (await fleet.call('/api/enroll', 'POST', { kind: 'host' }, bearer(token))).json();
    const { publicJwk } = await generateKeyPair();
    const enrolled = await fleet.call('/api/enroll/host', 'POST', { code: minted.code, hostId: 'real-box', publicJwk });
    assert.equal(enrolled.status, 200);
    const record = fleet.core.hostIds.get('real-box');
    assert.equal(record?.ephemeral, false);
    assert.equal(record?.owner ?? null, null, 'a permanent box is the fleet\'s, not one person\'s');
  });

  test(`4. on ${name}, a revoked host leaves the live picture in the same act`, async (t) => {
    const fleet = await build(t);
    const { publicJwk } = await generateKeyPair();
    await fleet.core.hostIds.enrol({ hostId: 'doomed', publicJwk });
    // Connected, as if its socket were open — the registry is what /api/hosts
    // and snapshot() read.
    fleet.core.registry.connect('doomed', () => {});
    assert.ok(fleet.core.snapshot().hosts.some((h) => h.hostId === 'doomed'), 'listed while connected');

    const res = await fleet.call('/api/hosts/doomed', 'DELETE', undefined, bearer(ADMIN));
    assert.equal(res.status, 200, await res.text());

    // Not "offline". Gone. A removed host that still shows in the list reads
    // exactly like the removal not working, which is how it was reported.
    assert.equal(fleet.core.snapshot().hosts.some((h) => h.hostId === 'doomed'), false, 'not in the snapshot');
    assert.equal(fleet.core.registry.get('doomed'), null, 'not in the registry');
    assert.ok(fleet.core.hostIds.get('doomed')?.revokedAt, 'and its key is refused from here on');
    assert.ok(fleet.core.events.some((e) => e.event === 'host.revoked' && e.hostId === 'doomed'), 'recorded once, by the core');
  });
}

test('4. a socket closing after the revocation does not resurrect the entry as offline', async () => {
  const core = new CoordinatorCore({ logger: silent });
  const { publicJwk } = await generateKeyPair();
  await core.hostIds.enrol({ hostId: 'doomed', publicJwk });
  core.registry.connect('doomed', () => {});
  assert.equal(core.revokeHost('doomed'), true);
  // Both coordinators close the socket AFTER revoking, and the close handler
  // reports a disconnect. That must be a no-op for a host that is gone.
  core.hostDisconnected('doomed', 'socket closed: 1008 revoked');
  assert.equal(core.registry.get('doomed'), null);
  assert.equal(core.revokeHost('doomed'), false, 'revoking twice is agreement, and records nothing new');
});

test('2. emailOf reads a person however the fleet spells them', () => {
  assert.equal(emailOf('someone@example.com'), 'someone@example.com');
  assert.equal(emailOf('fleet:Someone@Example.com'), 'someone@example.com');
  assert.equal(emailOf('the admin token'), null, 'a label is not a person');
  assert.equal(emailOf(null), null);
  assert.equal(emailOf(''), null);
});

test('3. admin rows survive the thirty-day sweep, so the fleet is founded once', async () => {
  let now = 1_000_000;
  const clients = new ClientRegistry({ now: () => now });

  const founder = await clients.issue('owner phone', { admin: true });
  const other = await clients.issue('member phone');
  assert.ok(founder.ok && other.ok);
  founder.client.email = 'owner@example.com';
  clients.revoke(founder.client.id);
  clients.revoke(other.client.id);

  // Thirty-one days later, something makes the store sweep.
  now += 31 * 24 * 3_600_000;
  await clients.issue('a new phone');

  assert.equal(clients.clients.has(other.client.id), false, 'an ordinary revoked row is swept');
  assert.equal(clients.clients.has(founder.client.id), true, 'the founding row is not');
  // These two are what the first-person-in rule consults (core.issueClient).
  // With the row swept, the next stranger to sign in founded the fleet again
  // and the owner returning after a month came back as a member.
  assert.equal(clients.everHadAdmin(), true);
  assert.equal(clients.emailHasAdmin('owner@example.com'), true);
});

test('5. the name a coordinator assigned this key is what the sidecar dials under', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-assigned-'));
  const hostKeyFile = path.join(dir, 'host-key.json');
  const env = { FLEETWRIGHT_HOST_KEY: hostKeyFile, FLEETWRIGHT_HOST_ID: 'gha-mac-123-1', FLEETWRIGHT_COORDINATOR_URL: 'https://fleet.example' };

  // A permanent host: nobody assigned a name, so what it asked for stands.
  assert.equal(readAssignedName(hostKeyFile), null);
  assert.equal(loadSidecarConfig(env).hostId, 'gha-mac-123-1');

  // enrol-actions: the coordinator derived the name from the job token, in a
  // process that exits before the sidecar starts. The record beside the key is
  // how the second process learns it.
  const file = recordAssignedName(hostKeyFile, { hostId: 'gha-owner-repo-123-1', origin: 'https://fleet.example' });
  assert.equal(file, assignedNameFile(hostKeyFile));
  assert.equal(readAssignedName(hostKeyFile), 'gha-owner-repo-123-1');
  assert.equal(loadSidecarConfig(env).hostId, 'gha-owner-repo-123-1', 'the assigned name wins over the workflow\'s guess');
});

test('5. a broken record is nobody, not a host called undefined', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-assigned-'));
  const hostKeyFile = path.join(dir, 'host-key.json');
  writeFileSync(assignedNameFile(hostKeyFile), '{"hostId": 42}');
  assert.equal(readAssignedName(hostKeyFile), null);
  writeFileSync(assignedNameFile(hostKeyFile), 'not json');
  assert.equal(readAssignedName(hostKeyFile), null);
});

test('the PKCE verifier is still checked, just not byte-by-byte-and-stop', async () => {
  const auth = new Authorizations();
  const reg = auth.register({ redirect_uris: ['https://client.example/cb'], client_name: 'test' });
  assert.ok(reg.ok);
  const verifier = 'v'.repeat(43);
  const challenge = await s256(verifier);
  const issue = () => auth.issueCode({ email: 'a@example.com', name: null, clientId: reg.clientId, redirectUri: 'https://client.example/cb', challenge });
  const good = issue();
  assert.ok(good.ok);
  const spent = await auth.redeem({ code: good.code, clientId: reg.clientId, redirectUri: 'https://client.example/cb', verifier });
  assert.equal(spent.ok, true);
  const bad = issue();
  assert.ok(bad.ok);
  const refused = await auth.redeem({ code: bad.code, clientId: reg.clientId, redirectUri: 'https://client.example/cb', verifier: 'w'.repeat(43) });
  assert.equal(refused.ok, false);
});

test('a plain `enrol <pin>` records the name beside the key, like the Actions path', () => {
  // The recorder existed for ephemeral runners, whose name the coordinator
  // derives. A permanent box had the same exposure from the other direction:
  // its default name is the hostname, cloud images rewrite that on first boot,
  // and a box enrolled as `vm` that woke up as `web-1` dialled as web-1 and
  // was refused with its own key on disk. Found by running the installer on a
  // box, not by a test — so this is the test.
  const bin = readFileSync(new URL('../bin/fleetwright-sidecar', import.meta.url), 'utf8');
  const start = bin.indexOf('async function doEnrol(');
  const end = bin.indexOf('async function', start + 1);
  assert.ok(start > 0 && end > start, 'doEnrol moved');
  const body = bin.slice(start, end);
  assert.match(body, /recordAssignedName\(cfg\.hostKeyFile, \{ hostId: cfg\.hostId, origin: cfg\.coordinatorUrl \}\)/);
  // After the enrol succeeded and before afterEnrol, so a refused pin records nothing.
  assert.ok(body.indexOf('await enrol(') < body.indexOf('recordAssignedName('), 'recorded before the coordinator answered');
  assert.ok(body.indexOf('recordAssignedName(') < body.indexOf('await afterEnrol()'), 'recorded after the sidecar was already told to start');
});
