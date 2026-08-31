// Push: the path from "a session needs you" to a phone buzzing.
//
//   node --test test/
//
// The coordinator core is transport-free, so the whole fan-out is testable in
// plain Node with a fake sender. The FCM sender's signing is tested against a
// real generated key, because a JWT that is subtly wrong fails at Google with a
// message that says nothing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore, describeEvent } from '../src/fleet/coordinator/core.js';
import {
  fcmPusher,
  logPusher,
  pusherFromEnv,
  parseServiceAccount,
  signJwtRS256,
  signJwtES256,
  apnsPusher,
  routingPusher,
  pemToBytes,
} from '../src/fleet/push.js';

/** A sender that records what it was asked to deliver. */
function fakePusher({ dead = [] } = {}) {
  /** @type {Array<{devices: any[], message: any}>} */
  const sends = [];
  return {
    sends,
    async send(devices, message) {
      sends.push({ devices, message });
      return { sent: devices.length - dead.length, dead };
    },
  };
}

/** @param {object} [opts] */
function core(opts = {}) {
  return new CoordinatorCore({ newId: () => 'test-id', ...opts });
}

// --- registering a phone ----------------------------------------------------

test('a device registers and is remembered by its push token', () => {
  const c = core();
  const r = c.registerDevice({ platform: 'android', token: 'a'.repeat(40), actor: 'telegram:1' });

  assert.equal(r.ok, true);
  assert.equal(c.devices.size, 1);
});

test('re-registering the same token updates rather than duplicating', () => {
  // A reinstall hands back the same token. Two registrations would mean two
  // notifications for one phone.
  const c = core();
  c.registerDevice({ platform: 'android', token: 'a'.repeat(40) });
  c.registerDevice({ platform: 'android', token: 'a'.repeat(40), actor: 'telegram:2' });

  assert.equal(c.devices.size, 1);
  assert.equal([...c.devices.values()][0].actor, 'telegram:2');
});

test('a phone that changes its push address does not become two phones', () => {
  // THE FCM TOKEN -> FID TRANSITION IN ONE TEST. Every phone crosses that line
  // once, on the update that changes what it registers, and the old address
  // does not stop working the moment the new one appears — FCM keeps accepting
  // a superseded registration token. Two live rows for one phone is every
  // notification delivered twice, which nobody reads as stale state.
  const c = core();
  c.registerDevice({ platform: 'android', token: 'old-fcm-token-'.padEnd(40, 'x'), clientId: 'phone-1' });
  c.registerDevice({ platform: 'android', token: 'new-fid-'.padEnd(40, 'y'), clientId: 'phone-1' });

  assert.equal(c.devices.size, 1);
  assert.equal([...c.devices.values()][0].token.startsWith('new-fid'), true);
});

test('two phones on one account both keep their registration', () => {
  // The guard above keys on the credential issued to a phone, not on the
  // person. Someone with a tablet and a phone is one actor and two devices.
  const c = core();
  c.registerDevice({ platform: 'android', token: 'a'.repeat(40), clientId: 'phone-1', actor: 'fleet:e@x.com' });
  c.registerDevice({ platform: 'ios', token: 'b'.repeat(40), clientId: 'tablet-2', actor: 'fleet:e@x.com' });

  assert.equal(c.devices.size, 2);
});

test('an unidentified registration never deletes an existing one', () => {
  // No clientId means the coordinator cannot tell "the same phone with a new
  // address" from "a different phone". Cannot-tell is not the same as
  // supersedes, and guessing here deletes somebody else's registration.
  const c = core();
  c.registerDevice({ platform: 'android', token: 'a'.repeat(40) });
  c.registerDevice({ platform: 'android', token: 'b'.repeat(40) });

  assert.equal(c.devices.size, 2);
});

test('a nonsense platform or token is refused', () => {
  const c = core();
  assert.equal(c.registerDevice({ platform: 'blackberry', token: 'a'.repeat(40) }).ok, false);
  assert.equal(c.registerDevice({ platform: 'ios', token: 'short' }).ok, false);
  assert.equal(c.registerDevice({ platform: 'ios', token: 'x'.repeat(5000) }).ok, false);
  assert.equal(c.devices.size, 0);
});

test('a device can be unregistered', () => {
  const c = core();
  c.registerDevice({ platform: 'ios', token: 'b'.repeat(40) });
  assert.equal(c.unregisterDevice('b'.repeat(40)).ok, true);
  assert.equal(c.devices.size, 0);
});

// --- an event reaching a phone ----------------------------------------------

test('a session waiting for input notifies every registered device', async () => {
  const push = fakePusher();
  const c = core({ push });
  c.registerDevice({ platform: 'android', token: 'a'.repeat(40) });
  c.registerDevice({ platform: 'ios', token: 'b'.repeat(40) });

  await c.onHostMessage('unabandoned', {
    kind: 'event',
    event: 'session.awaiting-input',
    name: 'bigjob',
    text: 'waiting for you to choose how to resume',
  });

  assert.equal(push.sends.length, 1);
  assert.equal(push.sends[0].devices.length, 2);
  assert.match(push.sends[0].message.title, /bigjob on unabandoned/);
  assert.match(push.sends[0].message.body, /choose how to resume/);
  // The data rides alongside so the app can open the session rather than just
  // opening.
  assert.equal(push.sends[0].message.data.name, 'bigjob');
  assert.equal(push.sends[0].message.data.event, 'session.awaiting-input');
});

test('an event nobody needs waking for is recorded but not pushed', async () => {
  const push = fakePusher();
  const c = core({ push });
  c.registerDevice({ platform: 'android', token: 'a'.repeat(40) });

  await c.onHostMessage('unabandoned', { kind: 'event', event: 'session.started', name: 'api' });

  assert.equal(push.sends.length, 0, 'not everything that happens is worth a buzz');
  assert.equal(c.events.length, 1, 'but it is still worth recording');
});

test('with no devices registered nothing is sent and nothing breaks', async () => {
  const push = fakePusher();
  const c = core({ push });
  await c.onHostMessage('h', { kind: 'event', event: 'session.ended', name: 'x' });
  assert.equal(push.sends.length, 0);
});

test('a push provider blowing up does not take the coordinator with it', async () => {
  const c = core({
    push: {
      async send() {
        throw new Error('FCM is having a day');
      },
    },
  });
  c.registerDevice({ platform: 'android', token: 'a'.repeat(40) });

  await c.onHostMessage('h', { kind: 'event', event: 'session.error', name: 'x', text: 'boom' });

  assert.equal(c.events.length, 1, 'the event is still recorded');
});

test('events are bounded, because a coordinator is not a log server', async () => {
  const c = core();
  for (let i = 0; i < 500; i++) {
    await c.onHostMessage('h', { kind: 'event', event: 'session.started', name: `s${i}` });
  }
  assert.ok(c.events.length <= 200);
  assert.equal(c.events.at(-1)?.name, 's499', 'and it is the RECENT ones that are kept');
});

test('health arriving unsolicited is recorded, not treated as a stray reply', async () => {
  const c = core();
  c.hostConnected('unabandoned', () => {});

  await c.onHostMessage('unabandoned', {
    kind: 'health',
    health: { hostId: 'unabandoned', maxSessions: 5, running: 1, free: 4, labels: [], loadavg: [0, 0, 0], loggedIn: true, hub: { reachable: true } },
  });

  assert.equal(c.registry.get('unabandoned')?.state, 'healthy');
});

test('event text is turned into something a person would read', () => {
  assert.equal(describeEvent({ event: 'session.ended' }), 'finished');
  assert.equal(describeEvent({ event: 'session.rc-online' }), 'is ready to drive');
  assert.equal(describeEvent({ event: 'session.awaiting-input', text: 'pick one' }), 'pick one');
  assert.equal(describeEvent({ event: 'session.awaiting-input' }), 'is waiting for you');
});

// --- the senders ------------------------------------------------------------

test('with no credentials configured, push logs and says so', async () => {
  /** @type {string[]} */
  const lines = [];
  const pusher = pusherFromEnv({}, { info: (m) => lines.push(String(m)), warn: (m) => lines.push(String(m)) });

  const r = await pusher.send([{ token: 'a'.repeat(40), platform: 'ios' }], { title: 'x', body: 'y' });

  assert.equal(r.sent, 0);
  assert.match(lines.join('\n'), /not configured/);
});

test('a malformed service account falls back to logging rather than throwing', () => {
  // A coordinator that will not boot because push is misconfigured is worse
  // than one that cannot send notifications.
  /** @type {string[]} */
  const warned = [];
  const logger = { info() {}, warn: (/** @type {any} */ m) => warned.push(String(m)) };

  assert.ok(pusherFromEnv({ AGENT_FLEET_FCM_SERVICE_ACCOUNT: 'not json' }, logger));
  assert.ok(pusherFromEnv({ AGENT_FLEET_FCM_SERVICE_ACCOUNT: '{"project_id":"p"}' }, logger));
  assert.equal(warned.length, 2);
});

/** A service account with a real key, since fcmPusher signs before it sends. */
async function realServiceAccount() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    client_email: 'svc@example.iam.gserviceaccount.com',
    project_id: 'p',
    private_key: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`,
  };
}

/** @param {string} status @param {number} code */
function fcmRejecting(status, code) {
  return async (/** @type {any} */ url) =>
    String(url).includes('oauth2')
      ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ error: { status } }), { status: code });
}

test('an APNs token rejected by FCM is kept, not silently unregistered', async () => {
  // The failure this prevents: an iOS app registers with APNs directly and
  // posts the raw device token. FCM answers INVALID_ARGUMENT because that is
  // not an FCM registration token. Reporting it as dead made the coordinator
  // delete the registration — the phone unregistered itself, and the only
  // trace was a line saying a dead token was dropped.
  /** @type {string[]} */
  const warned = [];
  const pusher = fcmPusher(await realServiceAccount(), {
    logger: { info() {}, warn: (/** @type {any} */ m) => warned.push(String(m)) },
    fetchImpl: fcmRejecting('INVALID_ARGUMENT', 400),
  });

  const r = await pusher.send([{ token: 'a1b2c3d4e5f6', platform: 'ios' }], { title: 't', body: 'b' });
  assert.equal(r.sent, 0);
  assert.deepEqual(r.dead, [], 'a misconfigured token is not a dead one');
  // The message has to name the cause, because the symptom is silence.
  assert.match(warned.join('\n'), /INVALID_ARGUMENT/);
  assert.match(warned.join('\n'), /Firebase SDK|Messaging\.messaging/);
});

test('a genuinely unregistered token is still dropped', async () => {
  const pusher = fcmPusher(await realServiceAccount(), {
    logger: { info() {}, warn() {} },
    fetchImpl: fcmRejecting('UNREGISTERED', 404),
  });

  const r = await pusher.send([{ token: 'gone-forever', platform: 'android' }], { title: 't', body: 'b' });
  assert.deepEqual(r.dead, ['gone-forever']);
});

test('a service account is read as raw JSON or as base64', () => {
  // Base64 exists because of systemd. An EnvironmentFile has no multi-line
  // values, and a service-account JSON arrives pretty-printed across a dozen
  // lines — so the only form that survives the box is one line of base64.
  const account = {
    project_id: 'p',
    client_email: 'e@example.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----\n',
  };
  const json = JSON.stringify(account);
  const b64 = Buffer.from(json, 'utf8').toString('base64');

  assert.deepEqual(parseServiceAccount(json), account);
  assert.deepEqual(parseServiceAccount(b64), account);
  // Still valid base64 after an editor, a YAML block or a copy-paste has
  // wrapped it.
  assert.deepEqual(parseServiceAccount(b64.replace(/(.{40})/g, '$1\n')), account);
  assert.deepEqual(parseServiceAccount(`  ${json}  `), account);
});

test('what systemd does to a raw-JSON service account is rejected, not half-read', () => {
  // The actual failure this guards: systemd expands C escapes inside a
  // double-quoted EnvironmentFile value, so the \n in private_key arrives as a
  // real newline — which is an illegal raw control character inside a JSON
  // string. Better to fall back to logging with an explanation than to throw
  // on a coordinator that was otherwise fine.
  const mangled = '{"project_id":"p","private_key":"-----BEGIN-----\n-----END-----"}';
  assert.equal(parseServiceAccount(mangled), null);

  /** @type {string[]} */
  const warned = [];
  const pusher = pusherFromEnv(
    { AGENT_FLEET_FCM_SERVICE_ACCOUNT: mangled },
    { info() {}, warn: (/** @type {any} */ m) => warned.push(String(m)) },
  );
  assert.ok(pusher);
  // The message has to name the fix, since the symptom is silence.
  assert.match(warned.join('\n'), /base64/);
});

test('a base64 service account configures FCM end to end', () => {
  /** @type {string[]} */
  const infos = [];
  const encoded = Buffer.from(
    JSON.stringify({ project_id: 'proj-42', client_email: 'e', private_key: 'k' }),
    'utf8',
  ).toString('base64');
  pusherFromEnv({ AGENT_FLEET_FCM_SERVICE_ACCOUNT: encoded }, { info: (/** @type {any} */ m) => infos.push(String(m)), warn() {} });
  assert.match(infos.join('\n'), /proj-42/);
});

test('the FCM JWT is signed with a real key and has the right shape', async () => {
  // Signing is where an FCM integration silently fails: Google returns an
  // opaque 400 and the cause is a header, a claim or the PEM parsing.
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`;

  const jwt = await signJwtRS256({ iss: 'svc@example.iam.gserviceaccount.com', exp: 1, iat: 0 }, pem);

  const [header, claim, signature] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'RS256');
  assert.equal(JSON.parse(Buffer.from(claim, 'base64url').toString()).iss, 'svc@example.iam.gserviceaccount.com');

  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    pair.publicKey,
    Buffer.from(signature, 'base64url'),
    new TextEncoder().encode(`${header}.${claim}`),
  );
  assert.equal(verified, true, 'the signature must actually verify');
});

test('a PEM whose newlines survived an env var as backslash-n still parses', () => {
  // The single most common way an FCM service account is broken: the private
  // key goes through an environment variable and comes out with literal \\n.
  const real = '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBg\n-----END PRIVATE KEY-----';
  const mangled = real.replace(/\n/g, '\\n');
  assert.deepEqual(pemToBytes(mangled), pemToBytes(real));
});

/** A real PKCS#8 key, because the sender signs before it ever fetches. */
async function realPem() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`;
}

test('FCM reports dead tokens so they can be dropped rather than retried forever', async () => {
  const account = { client_email: 'a@b.iam.gserviceaccount.com', private_key: await realPem(), project_id: 'proj' };
  const pusher = fcmPusher(account, {
    now: () => 1000,
    // Skip the real OAuth exchange and the real key: this test is about how the
    // send loop treats each status.
    fetchImpl: /** @type {any} */ (async (url) => {
      if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }));
      const body = String(url).includes('messages:send') ? 'UNREGISTERED' : '';
      return new Response(body, { status: 404 });
    }),
    logger: { info() {}, warn() {} },
  });

  const r = await pusher.send([{ token: 'dead-token-aaaa', platform: 'android' }], { title: 't', body: 'b' });

  assert.equal(r.sent, 0);
  assert.deepEqual(r.dead, ['dead-token-aaaa']);
});

test('dead tokens are pruned from the registry', () => {
  const c = core();
  c.registerDevice({ platform: 'android', token: 'a'.repeat(40) });
  c.registerDevice({ platform: 'android', token: 'b'.repeat(40) });

  assert.equal(c.pruneDevices(['a'.repeat(40)]), 1);
  assert.equal(c.devices.size, 1);
});

test('the log pusher is a real sender, not a stub that pretends', async () => {
  const pusher = logPusher({ info() {} });
  const r = await pusher.send([{ token: 'x'.repeat(40), platform: 'ios' }], { title: 'a', body: 'b' });
  assert.deepEqual(r, { sent: 0, dead: [] });
});

// --- the test notification --------------------------------------------------

test('a test push reports what actually happened, not that it tried', async () => {
  // The whole value of this button is telling apart "delivered", "nobody is
  // registered" and "this coordinator only logs". A cheerful "sent!" in the
  // last two cases is worse than no button, because somebody then spends an
  // hour looking at the phone.
  const core = new CoordinatorCore({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    push: logPusher({ info() {} }),
  });

  const none = await core.testPush();
  assert.equal(none.ok, false);
  assert.equal(none.error?.code, 'no_devices');

  core.registerDevice({ platform: 'ios', token: 'a-real-looking-token' });

  // logPusher reports sent: 0 — configured to log, so nothing was delivered.
  const logged = await core.testPush();
  assert.equal(logged.ok, false);
  assert.equal(logged.error?.code, 'not_delivered');
  assert.match(logged.text, /logging notifications/);
});

test('a test push that lands says so, and a dead token unregisters itself', async () => {
  /** @type {any[]} */
  const sent = [];
  const core = new CoordinatorCore({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    push: {
      async send(devices, message) {
        sent.push({ devices, message });
        return devices[0].token === 'dead-token-01' ? { sent: 0, dead: ['dead-token-01'] } : { sent: devices.length, dead: [] };
      },
    },
  });

  core.registerDevice({ platform: 'android', token: 'alive-token-1' });
  const ok = await core.testPush();
  assert.equal(ok.ok, true);
  assert.equal(ok.sent, 1);
  assert.match(sent[0].message.body, /push is working/i);
  assert.equal(sent[0].message.data.event, 'test', 'the app can tell a test from a real event');

  core.registerDevice({ platform: 'android', token: 'dead-token-01' });
  const gone = await core.testPush('dead-token-01');
  assert.equal(gone.ok, false);
  assert.match(gone.text, /dead/i);
  assert.equal(core.devices.has('dead-token-01'), false, 'a dead token is removed, not left to fail forever');
  assert.equal(core.devices.has('alive-token-1'), true, 'and the others are untouched');
});

test('a test push to one device does not wake the whole fleet', async () => {
  /** @type {any[]} */
  const seen = [];
  const core = new CoordinatorCore({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    push: { async send(devices) { seen.push(devices.map((d) => d.token)); return { sent: devices.length, dead: [] }; } },
  });
  core.registerDevice({ platform: 'ios', token: 'mine-token-01' });
  core.registerDevice({ platform: 'ios', token: 'somebody-elses-token' });

  await core.testPush('mine-token-01');
  assert.deepEqual(seen, [['mine-token-01']]);
});

// --- APNs -------------------------------------------------------------------

/** A .p8 as Apple hands it over, from a key generated here. */
async function apnsKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    pair,
    pem: `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8).toString('base64')}\n-----END PRIVATE KEY-----\n`,
  };
}

test('the APNs JWT is ES256, carries the key id, and verifies', async () => {
  // Getting this wrong is a 403 from Apple with a three-word reason, so it is
  // worth asserting against a real key rather than eyeballing the shape.
  const { pair, pem } = await apnsKey();
  const jwt = await signJwtES256({ iss: 'TEAMID1234', iat: 1_700_000_000 }, pem, 'KEYID5678');

  const [h, c, sig] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  assert.equal(header.alg, 'ES256');
  assert.equal(header.kid, 'KEYID5678', 'the key id lives in the header, not the claim');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url').toString()).iss, 'TEAMID1234');

  const signature = Buffer.from(sig, 'base64url');
  assert.equal(signature.length, 64, 'raw r||s, not DER — the mistake that makes Apple say InvalidProviderToken');
  assert.equal(
    await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, signature, new TextEncoder().encode(`${h}.${c}`)),
    true,
  );
});

test('an APNs push sends what Apple expects and drops a token Apple has buried', async () => {
  const { pem } = await apnsKey();
  /** @type {any[]} */
  const calls = [];
  const pusher = apnsPusher(
    { keyId: 'K', teamId: 'T', bundleId: 'network.thetech.fleetwright', privateKey: pem },
    {
      logger: { info() {}, warn() {} },
      deliver: async (token, payload, headers) => {
        calls.push({ token, payload: JSON.parse(payload), headers });
        return token === 'gone' ? { status: 410, body: '{"reason":"Unregistered"}' } : { status: 200, body: '' };
      },
    },
  );

  const r = await pusher.send(
    [{ token: 'alive', platform: 'ios' }, { token: 'gone', platform: 'ios' }],
    { title: 'cc-brave-otter', body: 'is waiting for you', data: { name: 'cc-brave-otter' } },
  );

  assert.equal(r.sent, 1);
  assert.deepEqual(r.dead, ['gone'], '410 means the app is gone, so the registration should not survive it');

  const first = calls[0];
  assert.equal(first.headers['apns-topic'], 'network.thetech.fleetwright', 'the topic is the bundle id');
  assert.equal(first.headers['apns-push-type'], 'alert');
  assert.equal(first.headers['apns-priority'], '10');
  assert.match(first.headers.authorization, /^bearer eyJ/);
  assert.equal(first.payload.aps.alert.title, 'cc-brave-otter');
  assert.equal(first.payload.name, 'cc-brave-otter', 'data rides alongside aps so the app can deep-link');
});

test('the bearer token is reused rather than minted per notification', async () => {
  // Apple rate-limits providers that regenerate too often, and a fleet event
  // can fan out to every phone at once.
  const { pem } = await apnsKey();
  const seen = new Set();
  const pusher = apnsPusher(
    { keyId: 'K', teamId: 'T', bundleId: 'b', privateKey: pem },
    {
      logger: { info() {}, warn() {} },
      deliver: async (_t, _p, headers) => {
        seen.add(headers.authorization);
        return { status: 200, body: '' };
      },
    },
  );
  await pusher.send([{ token: 'a', platform: 'ios' }, { token: 'b', platform: 'ios' }], { title: 't', body: 'b' });
  await pusher.send([{ token: 'c', platform: 'ios' }], { title: 't', body: 'b' });
  assert.equal(seen.size, 1);
});

test('iOS goes to APNs and everything else goes to FCM', async () => {
  // The bug this whole sender exists for: an APNs device token handed to FCM,
  // rejected, and the registration deleted. Routing is what makes that
  // impossible rather than unlikely.
  /** @type {string[]} */
  const toApns = [];
  /** @type {string[]} */
  const toFcm = [];
  const pusher = routingPusher({
    ios: { async send(devices) { toApns.push(...devices.map((d) => d.token)); return { sent: devices.length, dead: [] }; } },
    other: { async send(devices) { toFcm.push(...devices.map((d) => d.token)); return { sent: devices.length, dead: ['bad'] }; } },
  });

  const r = await pusher.send(
    [
      { token: 'iphone', platform: 'ios' },
      { token: 'pixel', platform: 'android' },
      { token: 'browser', platform: 'web' },
    ],
    { title: 't', body: 'b' },
  );

  assert.deepEqual(toApns, ['iphone']);
  assert.deepEqual(toFcm, ['pixel', 'browser']);
  assert.equal(r.sent, 3);
  assert.deepEqual(r.dead, ['bad'], 'dead tokens from either side come back together');
});

test('half a set of APNs credentials is refused rather than half-configured', () => {
  /** @type {string[]} */
  const warned = [];
  const logger = { info() {}, warn: (/** @type {any} */ m) => warned.push(String(m)) };
  const pusher = pusherFromEnv({ AGENT_FLEET_APNS_KEY_ID: 'K', AGENT_FLEET_APNS_TEAM_ID: 'T' }, logger);
  assert.ok(pusher);
  assert.match(warned.join('\n'), /all three/);
});
