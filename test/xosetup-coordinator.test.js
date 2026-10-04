// Adding a hypervisor, as the coordinator sees it: who may, which machine, and
// what reaches the person's phone while it runs.
//
//   node --test test/xosetup-coordinator.test.js
//
// ASKED FOR: onboarding a Xen Orchestra pool that proxies through a machine
// already in the fleet, "so you don't need the app to stay alive", with its
// progress on a Live Activity and the Dynamic Island. docs/hypervisors.md.
//
// The machines are played by a transport that answers from a function, the
// way runner-repo.test.js does it: what is pinned here is the coordinator's
// half, and the host's half has its own tests.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore, narrowProgress, narrowCertificate } from '../src/fleet/coordinator/core.js';
import { XOSETUP_STEPS } from '../src/fleet/protocol/intents.js';

const JOB = 'a1b2c3d4e5f6';
const admin = { email: 'eli@example.com', admin: true };
const member = { email: 'sam@example.com', admin: false };

/**
 * Permanent machines, a transport that records what each was sent, and a push
 * sender that records what each phone would have been shown.
 * @param {string[]} boxes
 * @param {(hostId: string, spec: any) => any} reply
 */
function fleet(boxes, reply) {
  /** @type {Array<{ devices: any[], message: any }>} */
  const sent = [];
  /** @type {Array<{ tokens: string[], update: any }>} */
  const activities = [];
  const push = {
    send: async (/** @type {any[]} */ devices, /** @type {any} */ message) => {
      sent.push({ devices, message });
      return { sent: devices.length, dead: [] };
    },
    activity: async (/** @type {string[]} */ tokens, /** @type {any} */ update) => {
      activities.push({ tokens, update });
      return { sent: tokens.length, dead: [] };
    },
  };
  const core = new CoordinatorCore({ push: /** @type {any} */ (push) });
  for (const hostId of boxes) {
    core.registry.connect(hostId, () => {});
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol: 7, maxSessions: 5, running: 0, free: 5, labels: [] });
  }
  /** @type {Array<{ hostId: string, spec: any }>} */
  const asked = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    asked.push({ hostId: host.hostId, spec });
    return reply(host.hostId, spec);
  });
  return { core, asked, sent, activities };
}

/** A machine that answers `begin` with a job, and anything else plainly. */
const machine = (/** @type {string} */ _hostId, /** @type {any} */ spec) =>
  spec.params.phase === 'begin'
    ? { ok: true, text: 'Ready for the sign-in.', xosetup: { job: JOB, state: 'waiting', key: 'k', keySig: 's', hostKey: 'h' } }
    : { ok: true, text: 'Running.', xosetup: { job: JOB, state: 'running', step: 0, of: XOSETUP_STEPS.length } };

const begin = (/** @type {any} */ requester, /** @type {any} */ extra = {}) => ({
  verb: 'xosetup',
  params: { phase: 'begin', address: 'xo.lan', pin: 'a'.repeat(64) },
  actor: requester ? `fleet:${requester.email}` : undefined,
  requester,
  ...extra,
});

test('adding a hypervisor is an admin’s, the probe included', async () => {
  const { core, asked } = fleet(['deb14'], machine);
  for (const verb of ['xoprobe', 'xosetup']) {
    const params = verb === 'xoprobe' ? { address: 'xo.lan' } : { phase: 'begin', address: 'xo.lan' };
    const r = await core.dispatch({ verb, params, actor: `fleet:${member.email}`, requester: member });
    assert.equal(r.ok, false, verb);
    assert.equal(r.error.code, 'not_admin', verb);
  }
  assert.equal(asked.length, 0, 'nothing reached a machine');
});

test('the probe asks every permanent machine and says which reached it, never a runner', async () => {
  const { core, asked } = fleet(['deb14', 'rpi-7550'], (hostId) => ({
    ok: true,
    text: hostId === 'deb14' ? 'Xen Orchestra answered.' : 'Nothing answered.',
    xoprobe:
      hostId === 'deb14'
        ? {
            reachable: true,
            xo: true,
            tls: true,
            cert: 'b'.repeat(64),
            certificate: { trusted: false, problems: ['self-signed'], subject: 'CN=xo.lan', issuer: 'CN=xo.lan', notBefore: '2026-01-01T00:00:00Z', notAfter: '2036-01-01T00:00:00Z', names: ['xo.lan'], extra: 'no' },
            version: '5.170',
            extra: 'not forwarded',
          }
        : { reachable: false, xo: null, tls: false, cert: null },
  }));
  core.registry.connect('gha-1', () => {}, { ephemeral: true });
  core.registry.recordHealth('gha-1', { hub: { reachable: true }, protocol: 7, maxSessions: 5, running: 0, free: 5, labels: [] });

  const r = await core.dispatch({ verb: 'xoprobe', params: { address: 'xo.lan' }, actor: `fleet:${admin.email}`, requester: admin });
  assert.deepEqual(asked.map((a) => a.hostId).sort(), ['deb14', 'rpi-7550']);
  const deb = r.probes.find((/** @type {any} */ p) => p.hostId === 'deb14');
  assert.deepEqual(deb, {
    hostId: 'deb14',
    reachable: true,
    xo: true,
    tls: true,
    cert: 'b'.repeat(64),
    certificate: {
      trusted: false,
      problems: ['self-signed'],
      subject: 'CN=xo.lan',
      issuer: 'CN=xo.lan',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2036-01-01T00:00:00.000Z',
      names: ['xo.lan'],
    },
    version: '5.170',
  });
  assert.equal(r.probes.find((/** @type {any} */ p) => p.hostId === 'rpi-7550').reachable, false);
});

test('with several machines a person chooses, and every later phase goes back to that one', async () => {
  const { core, asked } = fleet(['deb14', 'rpi-7550'], machine);
  const unchosen = await core.dispatch(begin(admin));
  assert.equal(unchosen.ok, false);
  assert.equal(unchosen.error.code, 'ambiguous_host');

  const started = await core.dispatch(begin(admin, { preferHost: 'rpi-7550' }));
  assert.equal(started.ok, true, started.text);
  assert.equal(started.hostId, 'rpi-7550');
  assert.equal(started.xosetup.job, JOB);

  // Asking for another machine does not move it: the key is in rpi-7550's memory.
  const run = await core.dispatch({
    verb: 'xosetup',
    params: { phase: 'run', job: JOB, sealed: 'epk.iv.ct' },
    actor: `fleet:${admin.email}`,
    requester: admin,
    preferHost: 'deb14',
  });
  assert.equal(run.ok, true, run.text);
  assert.deepEqual(asked.map((a) => a.hostId), ['rpi-7550', 'rpi-7550']);
  assert.equal(asked[1].spec.params.sealed, 'epk.iv.ct');
});

test('a job is only its owner’s, and a stranger hears the same as for a job that never was', async () => {
  const { core, asked } = fleet(['deb14'], machine);
  await core.dispatch(begin(admin));
  const other = { email: 'ops@example.com', admin: true };
  const theirs = await core.dispatch({ verb: 'xosetup', params: { phase: 'status', job: JOB }, actor: `fleet:${other.email}`, requester: other });
  const none = await core.dispatch({ verb: 'xosetup', params: { phase: 'status', job: 'ffffffffffff' }, actor: `fleet:${admin.email}`, requester: admin });
  assert.equal(theirs.ok, false);
  assert.equal(theirs.text, none.text);
  assert.equal(asked.length, 1, 'only the begin reached a machine');
});

test('progress becomes a Live Activity update with numbers only, and an Android notification', async () => {
  const { core, sent, activities } = fleet(['deb14'], machine);
  await core.registerDevice({ platform: 'ios', token: 'i'.repeat(64), actor: `fleet:${admin.email}` });
  await core.registerDevice({ platform: 'android', token: 'a'.repeat(64), actor: `fleet:${admin.email}` });
  await core.dispatch(begin(admin));

  const token = 'c0ffee'.repeat(12);
  const registered = core.registerSetupActivity(admin, { job: JOB, token });
  assert.equal(registered.ok, true, registered.text);
  assert.equal(core.registerSetupActivity(member, { job: JOB, token }).ok, false, 'somebody else’s job');

  await core.onHostMessage('deb14', { kind: 'event', event: 'xosetup.progress', job: JOB, step: 3, of: 8, phase: 'user', state: 'running', text: 'Making the fleetwright user on xo.lan.' });

  assert.equal(activities.length, 1);
  assert.deepEqual(activities[0].tokens, [token]);
  assert.equal(activities[0].update.event, 'update');
  // NOTHING A LOCK SCREEN SHOULD NOT SHOW: the address is in the sentence and
  // not in the activity, because the activity cannot be sealed.
  assert.deepEqual(activities[0].update.state, { step: 3, of: 8, phase: 'user', state: 'running' });
  assert.ok(!JSON.stringify(activities[0].update).includes('xo.lan'));

  // Android draws progress as an ongoing notification; iOS has the activity.
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].devices.map((/** @type {any} */ d) => d.platform), ['android']);
  assert.equal(sent[0].message.data.kind, 'xosetup');
  assert.equal(sent[0].message.data.name, `xosetup-${JOB}`, 'each step replaces the last');
  assert.equal(sent[0].message.drawnByApp, true, 'Android draws it as one ongoing notification, so FCM must not');

  // The end goes to both, and ends the activity.
  await core.onHostMessage('deb14', { kind: 'event', event: 'xosetup.progress', job: JOB, step: 8, of: 8, phase: 'done', state: 'done', text: 'xo.lan is in the fleet.' });
  assert.equal(activities[1].update.event, 'end');
  assert.ok(activities[1].update.dismissAt > Date.now());
  assert.deepEqual(sent[1].devices.map((/** @type {any} */ d) => d.platform).sort(), ['android', 'ios']);
  assert.equal(sent[1].message.title, 'Hypervisor added');
  // And a phone that opens later is told where it got to.
  assert.equal(core.registerSetupActivity(admin, { job: JOB, token }).progress.state, 'done');
});

test('only the machine running a job can report on it, and only in its known shape', async () => {
  const { core, sent, activities } = fleet(['deb14', 'rpi-7550'], machine);
  await core.registerDevice({ platform: 'android', token: 'a'.repeat(64), actor: `fleet:${admin.email}` });
  await core.dispatch(begin(admin, { preferHost: 'deb14' }));
  core.registerSetupActivity(admin, { job: JOB, token: 'c0ffee'.repeat(12) });

  await core.onHostMessage('rpi-7550', { kind: 'event', event: 'xosetup.progress', job: JOB, step: 1, of: 8, phase: 'sign-in', state: 'running' });
  assert.equal(sent.length + activities.length, 0, 'another machine cannot paint onto it');

  for (const bad of [
    { step: 9, of: 8, phase: 'user', state: 'running' },
    { step: 1, of: 8, phase: 'rm -rf', state: 'running' },
    { step: 1, of: 8, phase: 'user', state: 'exploded' },
    { step: 1.5, of: 8, phase: 'user', state: 'running' },
  ]) {
    assert.equal(narrowProgress(bad), null, JSON.stringify(bad));
  }
  assert.equal(narrowProgress({ step: 0, of: 8, phase: 'connect', state: 'running', text: 'a\u0007b' })?.text, 'a b');
});

test('the Live Activity route is the owner’s and takes a token, nothing else', () => {
  const { core } = fleet(['deb14'], machine);
  assert.equal(core.registerSetupActivity(admin, { job: 'nope', token: 'c0ffee'.repeat(12) }).error.code, 'bad_params');
  assert.equal(core.registerSetupActivity(admin, { job: JOB, token: 'not hex' }).error.code, 'bad_params');
  assert.equal(core.registerSetupActivity(admin, { job: JOB, token: 'c0ffee'.repeat(12) }).error.code, 'unknown_job');
});

test('a certificate is called trusted only when the machine said so and named nothing wrong with it', () => {
  // The doubtful case lands on the side that asks the person.
  assert.equal(narrowCertificate({ trusted: true, problems: ['expired'] })?.trusted, false);
  assert.equal(narrowCertificate({ trusted: 'yes', problems: [] })?.trusted, false);
  assert.equal(narrowCertificate({ trusted: true, problems: [] })?.trusted, true);
  // Only the problems there are words for, and nothing that is not a date.
  const odd = narrowCertificate({ problems: ['self-signed', 'rm -rf'], notAfter: 'tomorrow', subject: 'CN=a\u0007b' });
  assert.deepEqual(odd?.problems, ['self-signed']);
  assert.equal(odd?.notAfter, null);
  assert.equal(odd?.subject, 'CN=a b');
  assert.equal(narrowCertificate(null), null);
});
