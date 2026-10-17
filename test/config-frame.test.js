// Values the coordinator may push to a host, and the very short list of them.
//
//   node --test test/
//
// THIS IS A COMMAND CHANNEL WEARING A DIFFERENT HAT. "The coordinator can push
// configuration to hosts" is, unconstrained, exactly what design.md §5 refuses
// when it refuses shell strings: arbitrary key/value delivery from the party
// this system treats as compromised. So the tests here are mostly about what a
// coordinator CANNOT make a host store.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readConfigFrame, buildConfigFrame, CONFIG_KEYS } from '../src/fleet/protocol/config-frame.js';
import { PROTOCOL_VERSION, PROTOCOL_MIN } from '../src/fleet/protocol/intents.js';

const SECRET = 'clientsecret000000000000000000000000';
const frame = (values) => ({ v: PROTOCOL_VERSION, kind: 'config', values });

test('a named value arrives', () => {
  const r = readConfigFrame(frame({ githubClientSecret: SECRET }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, { githubClientSecret: SECRET });
  assert.deepEqual(r.dropped, []);
});

test('both client secrets travel on one frame', () => {
  // Cloudflare's is the second entry in the fixed set, the same object with
  // the same custody argument as GitHub's — useless without a refresh token
  // somebody already granted.
  const r = readConfigFrame(frame({ githubClientSecret: SECRET, cloudflareClientSecret: 'cfsecret000000000000000000' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, { githubClientSecret: SECRET, cloudflareClientSecret: 'cfsecret000000000000000000' });
  assert.deepEqual(buildConfigFrame({ cloudflareClientSecret: 'cfsecret000000000000000000' })?.values, {
    cloudflareClientSecret: 'cfsecret000000000000000000',
  });
});

test('a key the host does not know is dropped, not stored', () => {
  // The whole guardrail. A host that stores whatever it is sent is a host whose
  // behaviour the coordinator writes.
  const r = readConfigFrame(frame({ githubClientSecret: SECRET, sandboxImage: 'evil/image:latest' }));

  assert.deepEqual(Object.keys(r.values), ['githubClientSecret']);
  assert.deepEqual(r.dropped, ['sandboxImage']);
});

test('one bad key does not reject the frame', () => {
  // Otherwise a coordinator can make a host refuse its own configuration by
  // adding a field — a denial primitive handed over for free.
  const r = readConfigFrame(frame({ githubClientSecret: SECRET, nonsense: 42 }));
  assert.equal(r.ok, true);
  assert.equal(r.values.githubClientSecret, SECRET);
});

test('a value that could not survive a command line is refused', () => {
  // Same charset as a protocol `secret`: no whitespace, quotes or backslashes.
  for (const bad of ['has space', "quo'te", 'back\\slash', '', 'x'.repeat(5000), 42, null]) {
    const r = readConfigFrame(frame({ githubClientSecret: bad }));
    assert.deepEqual(r.values, {}, JSON.stringify(bad));
    assert.deepEqual(r.dropped, ['githubClientSecret']);
  }
});

test('a refusal never quotes the value back', () => {
  // These are credentials, and a refusal travels to a log like every other one.
  const r = readConfigFrame(frame({ githubClientSecret: 'secret with a space in it' }));
  assert.equal(JSON.stringify(r).includes('secret with'), false);
});

test('a frame from a coordinator AHEAD of us is read, not dropped', () => {
  // The bug this fixes: an updated coordinator's frames were refused by an older
  // host every fifteen seconds, so the host got no config while looking
  // connected. Config keys are append-only, so a newer frame is a superset —
  // read the keys we know, drop the rest.
  const r = readConfigFrame({ v: PROTOCOL_VERSION + 1, kind: 'config', values: { githubClientSecret: SECRET } });
  assert.equal(r.ok, true);
  assert.equal(r.values.githubClientSecret, SECRET);
});

test('a frame from below the floor is still refused — old semantics are not guessed at', () => {
  const r = readConfigFrame({ v: PROTOCOL_MIN - 1, kind: 'config', values: { githubClientSecret: SECRET } });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /below this host's floor/);
});

test('an intent is not a config frame and vice versa', () => {
  assert.equal(readConfigFrame({ v: PROTOCOL_VERSION, kind: 'intent', verb: 'list' }).ok, false);
  assert.equal(readConfigFrame(null).ok, false);
  assert.equal(readConfigFrame({ v: PROTOCOL_VERSION, kind: 'config' }).ok, false);
});

test('nothing to say sends no frame at all', () => {
  // A frame with no values would make a host log a delivery that carried
  // nothing, which is worse than silence.
  assert.equal(buildConfigFrame({}), null);
  assert.equal(buildConfigFrame({ githubClientSecret: null }), null);
  assert.equal(buildConfigFrame({ notAKey: 'x' }), null);
});

test('the coordinator can only build what the protocol names', () => {
  const built = buildConfigFrame({ githubClientSecret: SECRET, sandboxImage: 'evil/image' });
  assert.deepEqual(Object.keys(/** @type {any} */ (built).values), ['githubClientSecret']);
});

test('the list is short, and staying short is the point', () => {
  // "It should grow slowly and never become a map." A test rather than a
  // comment, because the way this stops being true is somebody adding a key
  // that seemed harmless in isolation.
  assert.ok(Object.keys(CONFIG_KEYS).length <= 3, 'the config channel is growing — is each key still necessary?');
});

test('the client secrets go to the fleet’s own boxes, never to a machine a member controls', async () => {
  // FOUND BY AN AUDIT: a member minted a host pin, enrolled a box of their own
  // and was sent both of the fleet's OAuth client secrets on connect, and on
  // every reconnect after their own credential was revoked. A runner was sent
  // them too. The repository runners come from is not a secret and still goes
  // everywhere.
  const { CoordinatorCore } = await import('../src/fleet/coordinator/core.js');
  const { admit, makeAdmin } = await import('./helpers/enrolled-hosts.js');
  const core = new CoordinatorCore({
    githubApp: { clientId: 'Iv1.app', clientSecret: SECRET },
    cloudflareOauth: { clientId: 'cf-app', clientSecret: 'cfsecret000000000000000000' },
    runnerRepo: 'fleet/runners',
  });
  await makeAdmin(core, 'admin@example.test');
  /** @type {Record<string, any>} */
  const frames = {};
  const recorder = (/** @type {string} */ hostId) => (/** @type {any} */ msg) => {
    if (msg?.kind === 'config') frames[hostId] = msg.values;
  };
  await admit(core, 'ops-box', { send: recorder('ops-box') });
  await admit(core, 'admin-box', { enrolledBy: 'admin@example.test', send: recorder('admin-box') });
  await admit(core, 'bob-box', { enrolledBy: 'bob@example.test', send: recorder('bob-box') });
  await admit(core, 'holder-0a1b2c', { enrolledBy: 'holder:bob@example.test', send: recorder('holder-0a1b2c') });
  await admit(core, 'gha-bob-1', { enrolledBy: 'actions:bob/runners', owner: 'bob@example.test', ephemeral: true, send: recorder('gha-bob-1') });

  const both = { githubClientSecret: SECRET, cloudflareClientSecret: 'cfsecret000000000000000000', runnerRepo: 'fleet/runners' };
  assert.deepEqual(frames['ops-box'], both);
  assert.deepEqual(frames['admin-box'], both);
  for (const id of ['bob-box', 'holder-0a1b2c', 'gha-bob-1']) {
    assert.deepEqual(frames[id], { runnerRepo: 'fleet/runners' }, id);
  }
});

test('a removed admin’s boxes stop being the fleet’s, connected or reconnecting', async () => {
  // FOUND BY AN AUDIT: an admin removed by revoking every credential they
  // held kept their boxes in the operator's tier for good, because admin rows
  // are kept and the tier asked only whether a row had ever been admin. Each
  // reconnect was sent both client secrets, and every member's pasted token
  // still reached the box the removed person had root on.
  const { CoordinatorCore } = await import('../src/fleet/coordinator/core.js');
  const { admit } = await import('./helpers/enrolled-hosts.js');
  const core = new CoordinatorCore({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    githubApp: { clientId: 'Iv1.app', clientSecret: SECRET },
    cloudflareOauth: { clientId: 'cf-app', clientSecret: 'cfsecret000000000000000000' },
    runnerRepo: 'fleet/runners',
  });
  const boss = { email: 'boss@example.test', name: null };
  const phone = /** @type {any} */ (await core.issueClient(boss, 'phone'));
  const laptop = /** @type {any} */ (await core.issueClient(boss, 'laptop'));
  assert.equal(phone.client.admin, true);
  await core.issueClient({ email: 'nina@example.test', name: null }, 'phone');
  /** @type {any} */
  let frame = null;
  await admit(core, 'boss-box', { enrolledBy: boss.email, send: (/** @type {any} */ m) => { if (m?.kind === 'config') frame = m.values; } });
  await admit(core, 'nina-box', { enrolledBy: 'nina@example.test' });
  /** @type {string[]} */
  let sent = [];
  core.send = async (/** @type {any} */ host) => {
    sent.push(host.hostId);
    return { ok: true, text: 'stored' };
  };
  const nina = { email: 'nina@example.test', admin: false };
  const linked = async () => {
    sent = [];
    await core.dispatch({ verb: 'link', params: { provider: 'github', secret: 'ghp_DUMMY' }, actor: nina.email, requester: nina });
    return sent.sort();
  };
  assert.deepEqual(await linked(), ['boss-box', 'nina-box'], 'an admin’s box is the fleet’s');

  core.revokeClient(phone.client.id);
  assert.deepEqual(await linked(), ['boss-box', 'nina-box'], 'one lost phone is not a removal');
  core.revokeClient(laptop.client.id);
  assert.deepEqual(await linked(), ['nina-box'], 'a removed admin’s box, still connected, was sent a member’s token');
  core.hostDisconnected('boss-box', 'reconnect');
  core.hostConnected('boss-box', (/** @type {any} */ m) => { if (m?.kind === 'config') frame = m.values; });
  assert.deepEqual(frame, { runnerRepo: 'fleet/runners' }, 'a removed admin’s box was sent the fleet’s client secrets');
  assert.deepEqual(await linked(), ['nina-box']);

  // Signing in again is still how an admin whose every phone went comes back.
  assert.equal(/** @type {any} */ (await core.issueClient(boss, 'new phone')).client.admin, true);
  assert.deepEqual(await linked(), ['boss-box', 'nina-box']);
});

test('a removed admin’s box is asked for back what it held for everyone else, and the fleet says so', async () => {
  // FOUND BY THE NEXT AUDIT: the test above took the tier away and nothing
  // the tier had sent came back. Every member's GitHub and Cloudflare link
  // had fanned out to the box and their sessions ran there under their own
  // Claude sign-ins. Once it acted for the removed admin alone, a member's
  // unlink left it out, its next health frame filed their session under that
  // admin, and their stop and peek answered that no such session existed,
  // on a machine somebody no longer in the fleet has root on.
  const { CoordinatorCore } = await import('../src/fleet/coordinator/core.js');
  const { admit } = await import('./helpers/enrolled-hosts.js');
  const core = new CoordinatorCore({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const boss = /** @type {any} */ (await core.issueClient({ email: 'boss@example.test' }, 'phone'));
  await core.issueClient({ email: 'nina@example.test' }, 'phone');
  await admit(core, 'boss-box', { enrolledBy: 'boss@example.test' });
  await admit(core, 'nina-box', { enrolledBy: 'nina@example.test' });
  core.registry.recordHealth('boss-box', {
    hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 5, running: 2, free: 3, labels: [],
    sessions: [
      { name: 'nina-job', status: 'running', createdBy: 'fleet:nina@example.test' },
      { name: 'boss-job', status: 'running', createdBy: 'fleet:boss@example.test' },
    ],
  });
  /** @type {string[]} */
  const asked = [];
  core.send = async (/** @type {any} */ host, /** @type {any} */ spec) => {
    asked.push(`${host.hostId} ${spec.verb} ${spec.params.name ?? spec.params.provider} for ${spec.actor}`);
    return { ok: true, text: 'done' };
  };

  core.revokeClient(boss.client.id);
  assert.deepEqual(asked.sort(), [
    'boss-box stop nina-job for nina@example.test',
    'boss-box unlink claude for nina@example.test',
    'boss-box unlink cloudflare for nina@example.test',
    'boss-box unlink github for nina@example.test',
  ], 'a member’s session and sign-ins were left on a box the fleet no longer runs');
  const nina = { email: 'nina@example.test', admin: false };
  const said = core.recentEvents(nina).find((/** @type {any} */ e) => e.event === 'host.demoted');
  assert.equal(said?.hostId, 'boss-box', 'the members whose tokens it held were not told');
  assert.match(said.text, /client secrets/);

  // And from now on the box is the removed admin's alone: a member's verbs on
  // what it reported do not reach it, before its next frame as after.
  asked.length = 0;
  const stop = await core.dispatch({ verb: 'stop', params: { name: 'nina-job' }, actor: nina.email, requester: nina });
  assert.equal(stop.error?.code, 'unknown_session');
  assert.deepEqual(asked, [], 'a member’s stop reached a box that no longer acts for them');
});
