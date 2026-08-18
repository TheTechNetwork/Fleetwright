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
import { fcmPusher, logPusher, pusherFromEnv, parseServiceAccount, signJwtRS256, pemToBytes } from '../src/fleet/push.js';

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
