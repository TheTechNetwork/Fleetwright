// The join, end to end, and the ways it must fail.
//
// The pieces are tested separately elsewhere — hosts.test.js has the
// challenge/response, oidc.test.js has token verification. What is here is the
// seam: a box with no credential becoming a box the coordinator will talk to,
// and the states in between that people actually hit.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Coordinator } from '../src/fleet/coordinator/server.js';
import { Enrollment } from '../src/fleet/coordinator/enrollment.js';
import { loadOrCreateKey, enrol, checkEnrolled, proveIdentity } from '../src/fleet/host/identity.js';
import { generateKeyPair } from '../src/fleet/crypto.js';
import { forgetJwks } from '../src/fleet/coordinator/oidc.js';
import { sidecarConfig, identity, enrol as fleetEnrol } from '../src/core/fleet-identity.js';

/** @param {import('node:test').TestContext} t */
async function coordinator(t, opts = {}) {
  const c = new Coordinator({ ...opts });
  const port = await c.listen(0, '127.0.0.1');
  t.after(() => c.close());
  return { coordinator: c, origin: `http://127.0.0.1:${port}` };
}

function scratch() {
  return path.join(mkdtempSync(path.join(tmpdir(), 'fleet-key-')), 'host-key.json');
}

test('a box makes a key once and keeps it', async () => {
  const file = scratch();
  const first = await loadOrCreateKey(file);
  assert.equal(first.created, true);
  assert.equal(statSync(file).mode & 0o777, 0o600, 'nobody else can read it');

  const second = await loadOrCreateKey(file);
  assert.equal(second.created, false);
  assert.deepEqual(second.publicJwk, first.publicJwk, 'the same box is the same host');
});

test('a key file anyone can read is refused rather than used', async () => {
  const file = scratch();
  await loadOrCreateKey(file);
  chmodSync(file, 0o644);

  // The interesting case is not "we set the mode on creation" — it is a file
  // that BECAME readable, which is what a careless chmod or a restored backup
  // produces, and which no amount of care at creation time would catch.
  await assert.rejects(() => loadOrCreateKey(file), /must not be readable by anyone else/);
});

test('the public half is what goes over the wire, never the private half', async () => {
  const file = scratch();
  const key = await loadOrCreateKey(file);
  assert.ok(key.privateJwk.d, 'the private key is on disk');
  assert.equal(key.publicJwk.d, undefined, 'and not in the half that gets sent');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.publicJwk.d, undefined);
});

test('a pin joins a box to a fleet, and works exactly once', async (t) => {
  const { coordinator: c, origin } = await coordinator(t);
  const key = await loadOrCreateKey(scratch());
  const { code } = c.core.enrollment.mint({ purpose: 'host' });

  const first = await enrol({ origin, code, hostId: 'rehearsed', publicJwk: key.publicJwk });
  assert.equal(first.ok, true);
  assert.match(first.fingerprint, /^[0-9a-f]{16}$/);

  // The second attempt is the whole point of a pin being single-use: a code
  // sitting in a scrollback must not be a second host nobody knows about.
  await assert.rejects(
    () => enrol({ origin, code, hostId: 'stowaway', publicJwk: key.publicJwk }),
    /not valid, or has already been used/,
  );
  assert.deepEqual(
    c.core.hostIds.list().map((h) => h.hostId),
    ['rehearsed'],
  );
});

test('enrolled, revoked, and never-enrolled are three different answers', async (t) => {
  const { coordinator: c, origin } = await coordinator(t);
  const key = await loadOrCreateKey(scratch());
  const { code } = c.core.enrollment.mint({ purpose: 'host' });
  await enrol({ origin, code, hostId: 'candid', publicJwk: key.publicJwk });

  const known = await checkEnrolled({ origin, hostId: 'candid', privateJwk: key.privateJwk });
  assert.equal(known.ok, true);

  const stranger = await checkEnrolled({ origin, hostId: 'nobody', privateJwk: key.privateJwk });
  assert.equal(stranger.ok, false);
  assert.match(stranger.reason, /not enrolled/);

  c.core.hostIds.revoke('candid');
  const after = await checkEnrolled({ origin, hostId: 'candid', privateJwk: key.privateJwk });
  assert.equal(after.ok, false);
  // "revoked" and "never enrolled" send an operator to completely different
  // actions, and a single "unauthorised" sends them to guess.
  assert.match(after.reason, /revoked/);
});

test("another box's key cannot answer this box's challenge", async (t) => {
  const { coordinator: c, origin } = await coordinator(t);
  const mine = await loadOrCreateKey(scratch());
  const theirs = await generateKeyPair();
  const { code } = c.core.enrollment.mint({ purpose: 'host' });
  await enrol({ origin, code, hostId: 'genuine', publicJwk: mine.publicJwk });

  const forged = await checkEnrolled({ origin, hostId: 'genuine', privateJwk: theirs.privateJwk });
  assert.equal(forged.ok, false);
  assert.match(forged.reason, /does not match the enrolled key/);
});

test('a proof is spent, so a captured one opens nothing', async (t) => {
  const { coordinator: c, origin } = await coordinator(t);
  const key = await loadOrCreateKey(scratch());
  const { code } = c.core.enrollment.mint({ purpose: 'host' });
  await enrol({ origin, code, hostId: 'watched', publicJwk: key.publicJwk });

  const { nonce, proof } = await proveIdentity({ origin, hostId: 'watched', privateJwk: key.privateJwk });
  const once = await fetch(`${origin}/api/host/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId: 'watched', nonce, proof }),
  });
  assert.equal(once.status, 200);

  // Replaying the exact bytes that just worked. This is what a listener on a
  // cleartext link, or a log file, actually has.
  const again = await fetch(`${origin}/api/host/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId: 'watched', nonce, proof }),
  });
  assert.equal(again.status, 401);
});

test('guessing pins stops working long before a million tries', () => {
  let clock = 0;
  const enrollment = new Enrollment({ now: () => clock, maxFailures: 5 });
  enrollment.mint({ purpose: 'host' });

  for (let i = 0; i < 5; i++) {
    assert.equal(enrollment.redeem('000000', 'host').ok, false);
  }
  const shut = enrollment.redeem('000000', 'host');
  assert.match(shut.reason, /too many wrong codes/);

  // And it opens again, because the fleet's operators are also the people
  // typing pins, and a permanent lockout would be a permanent outage.
  clock += 61_000;
  assert.match(enrollment.redeem('000000', 'host').reason, /not valid/);
});

test('a code minted for a device cannot enrol a host', () => {
  const enrollment = new Enrollment();
  const { code } = enrollment.mint({ purpose: 'device' });
  const refused = enrollment.redeem(code, 'host');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /issued for a device/);
});

test('enrolments survive a restart', async (t) => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'fleet-state-')), 'state.json');
  const first = new Coordinator({ stateFile: file });
  const port = await first.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const key = await loadOrCreateKey(scratch());
  const { code } = first.core.enrollment.mint({ purpose: 'host' });
  await enrol({ origin, code, hostId: 'persistent', publicJwk: key.publicJwk });
  await first.close();

  // The membership list is the authority, unlike the registry, which is a
  // cache. Losing it on restart means refusing every box in the fleet while
  // looking perfectly healthy.
  const second = new Coordinator({ stateFile: file });
  second.loadState();
  const port2 = await second.listen(0, '127.0.0.1');
  t.after(() => second.close());

  const known = await checkEnrolled({
    origin: `http://127.0.0.1:${port2}`,
    hostId: 'persistent',
    privateJwk: key.privateJwk,
  });
  assert.equal(known.ok, true);
});

test('a corrupt state file is fatal rather than silently empty', async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'fleet-state-')), 'state.json');
  writeFileSync(file, '{ this is not json');
  const c = new Coordinator({ stateFile: file });
  assert.throws(() => c.loadState());
});

test('a device credential gets in; a wrong one does not', async (t) => {
  const { coordinator: c, origin } = await coordinator(t, { apiToken: 'a-token-at-least-16ch' });
  const { token } = await c.core.clients.issue('somebody (a@example.com)');

  const good = await fetch(`${origin}/api/hosts`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(good.status, 200);

  const bad = await fetch(`${origin}/api/hosts`, { headers: { authorization: 'Bearer fwk_dead_beef' } });
  assert.equal(bad.status, 401);

  // Revoking one device leaves every other alone — the entire reason there is
  // more than one credential.
  const id = token.split('_')[1];
  c.core.clients.revoke(id);
  const after = await fetch(`${origin}/api/hosts`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(after.status, 401);
});

test('the admin token is not required to enrol, and is required for everything else', async (t) => {
  const { coordinator: c, origin } = await coordinator(t, { apiToken: 'a-token-at-least-16ch' });

  // Enrolment has to work without a fleet-wide credential, or every host would
  // need the admin token to join — which is the shared secret this replaced.
  const { code } = c.core.enrollment.mint({ purpose: 'host' });
  const key = await loadOrCreateKey(scratch());
  const joined = await enrol({ origin, code, hostId: 'newcomer', publicJwk: key.publicJwk });
  assert.equal(joined.ok, true);

  assert.equal((await fetch(`${origin}/api/hosts/enrolled`)).status, 401);
  assert.equal(
    (await fetch(`${origin}/api/enroll`, { method: 'POST', body: '{}' })).status,
    401,
    'minting a pin needs a credential — it is an invitation, not a way in',
  );
});

// --- signing in -------------------------------------------------------------
//
// The other half of the same idea. A host presents a key; a phone presents
// somebody else's word for who its owner is. Both end up holding a credential
// that is theirs alone.

/** A stand-in identity provider: a signing key, its JWKS, and a fetch stub. */
async function provider({ issuer: iss = 'https://accounts.example.com', audience = 'fleetwright-app' } = {}) {
  // Every provider here is a fresh key under the same issuer name, and jose
  // caches a key set per issuer. Without this the second test in the file
  // verifies against the first test's key and fails for a reason that has
  // nothing to do with what it is testing.
  forgetJwks();
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const keys = [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }];

  // Only the JWKS fetch is stubbed; everything else still goes to the real
  // server under test, which is the point — the sign-in path has to work end
  // to end, not just in the verifier.
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.includes('jwks') || url.includes('certs') || url.includes('/auth/keys')) {
      return new Response(JSON.stringify({ keys }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return real(input, init);
  });

  const b64 = (/** @type {any} */ o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  /** @param {Record<string, any>} claims */
  const token = async (claims) => {
    const h = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const c = b64({
      iss,
      aud: audience,
      sub: 'u1',
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 600,
      ...claims,
    });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${c}`));
    return `${h}.${c}.${Buffer.from(sig).toString('base64url')}`;
  };

  return { token, restore: () => { globalThis.fetch = real; }, issuer: iss, audience };
}

/** @param {import('node:test').TestContext} t */
async function signInFleet(t, allow = '@thetech.network') {
  const p = await provider();
  t.after(p.restore);
  const before = { ...process.env };
  process.env.AGENT_FLEET_AUTH_ISSUERS = p.issuer;
  process.env.AGENT_FLEET_AUTH_AUDIENCES = p.audience;
  process.env.AGENT_FLEET_AUTH_ALLOW = allow;
  t.after(() => {
    process.env.AGENT_FLEET_AUTH_ISSUERS = before.AGENT_FLEET_AUTH_ISSUERS;
    process.env.AGENT_FLEET_AUTH_AUDIENCES = before.AGENT_FLEET_AUTH_AUDIENCES;
    process.env.AGENT_FLEET_AUTH_ALLOW = before.AGENT_FLEET_AUTH_ALLOW;
  });
  const { coordinator: c, origin } = await coordinator(t, { apiToken: 'a-token-at-least-16ch' });
  return { provider: p, coordinator: c, origin };
}

/** @param {string} origin @param {Record<string, any>} body */
async function session(origin, body) {
  const res = await fetch(`${origin}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: /** @type {any} */ (await res.json()) };
}

test('signing in mints a credential for that device alone', async (t) => {
  const { provider: p, coordinator: c, origin } = await signInFleet(t);

  const first = await session(origin, { idToken: await p.token({ email: 'eli@thetech.network' }), deviceName: 'a phone' });
  assert.equal(first.status, 200);
  assert.match(first.body.token, /^fwk_/);

  const second = await session(origin, { idToken: await p.token({ email: 'eli@thetech.network' }), deviceName: 'a tablet' });
  assert.notEqual(second.body.token, first.body.token, 'two devices, two credentials');

  // Losing the tablet must not disturb the phone. That is the whole reason
  // there is more than one credential.
  c.core.clients.revoke(second.body.client.id);
  const phone = await fetch(`${origin}/api/hosts`, { headers: { authorization: `Bearer ${first.body.token}` } });
  assert.equal(phone.status, 200);
  const tablet = await fetch(`${origin}/api/hosts`, { headers: { authorization: `Bearer ${second.body.token}` } });
  assert.equal(tablet.status, 401);
});

test('an address that is not on the list is refused, and told so', async (t) => {
  const { provider: p, origin } = await signInFleet(t);
  const r = await session(origin, { idToken: await p.token({ email: 'stranger@example.com' }) });
  assert.equal(r.status, 403);
  assert.match(r.body.text, /not on this fleet's list/);
});

test('a hidden Apple address is refused with the thing to do about it', async (t) => {
  const { provider: p, origin } = await signInFleet(t);
  const r = await session(origin, { idToken: await p.token({ email: 'abc123@privaterelay.appleid.com' }) });
  assert.equal(r.status, 403);
  // "not on the list" would send somebody to ask why they are missing from a
  // list they are on.
  assert.match(r.body.text, /Share My Email/);
});

test('an unverified address does not count as an identity', async (t) => {
  const { provider: p, origin } = await signInFleet(t);
  const r = await session(origin, {
    idToken: await p.token({ email: 'eli@thetech.network', email_verified: false }),
  });
  assert.equal(r.status, 401);
  assert.match(r.body.text, /not verified/);
});

test('a token for another application is refused', async (t) => {
  const { origin } = await signInFleet(t);
  const other = await provider({ audience: 'somebody-elses-app' });
  t.after(other.restore);
  const r = await session(origin, { idToken: await other.token({ email: 'eli@thetech.network' }) });
  assert.equal(r.status, 401);
});

test('a fleet with no allowlist lets nobody in', async (t) => {
  const { provider: p, origin } = await signInFleet(t, '');
  const r = await session(origin, { idToken: await p.token({ email: 'eli@thetech.network' }) });
  assert.equal(r.status, 403, 'the default for something that controls every machine is nobody');
});

// --- from a chat message ----------------------------------------------------
//
// The point of the hub is that a box can be run without SSHing into it, and
// joining a fleet is exactly the kind of one-off that would otherwise send
// somebody to a terminal.

test('/enroll spends a pin on the box the bot is running on', async (t) => {
  const { coordinator: c, origin } = await coordinator(t);
  const keyFile = scratch();
  const { code } = c.core.enrollment.mint({ purpose: 'host' });

  const cfg = sidecarConfig({
    env: {
      AGENT_FLEET_COORDINATOR_URL: origin,
      AGENT_FLEET_HOST_ID: 'chatted',
      AGENT_FLEET_HOST_KEY: keyFile,
      AGENT_FLEET_SIDECAR_ENV: '/nonexistent',
    },
  });

  const joined = await fleetEnrol(code, { config: cfg, actor: 'telegram:1' });
  assert.equal(joined.ok, true);
  assert.match(joined.text, /Enrolled chatted/);
  assert.deepEqual(c.core.hostIds.list().map((h) => h.hostId), ['chatted']);

  const who = await identity({ config: cfg });
  assert.equal(who.ok, true);
  assert.match(who.text, /Enrolled   yes/);
  assert.match(who.text, new RegExp(joined.fingerprint));
});

test('/enroll says what to do when the box has never joined', async (t) => {
  const { origin } = await coordinator(t);
  const cfg = sidecarConfig({
    env: {
      AGENT_FLEET_COORDINATOR_URL: origin,
      AGENT_FLEET_HOST_ID: 'lonely',
      AGENT_FLEET_HOST_KEY: scratch(),
      AGENT_FLEET_SIDECAR_ENV: '/nonexistent',
    },
  });

  const who = await identity({ config: cfg });
  assert.equal(who.ok, false);
  assert.match(who.text, /not enrolled/);
  assert.match(who.text, /\/enroll 123456/, 'and the next action, not just the diagnosis');

  assert.match((await fleetEnrol('12', { config: cfg })).text, /six digits/);
  assert.match((await fleetEnrol('999999', { config: cfg })).text, /not valid, or has already been used/);
});

test('the sidecar env file is read, and the environment still wins', () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'fleet-env-')), 'sidecar.env');
  writeFileSync(
    file,
    'AGENT_FLEET_COORDINATOR_URL=https://from-the-file\nAGENT_FLEET_HOST_ID="boxy"\n',
  );

  // agent-hub is a different unit with a different EnvironmentFile, so these
  // variables are not in its process — reading the file is the only way it
  // knows which fleet this box belongs to.
  const cfg = sidecarConfig({ env: { AGENT_FLEET_SIDECAR_ENV: file } });
  assert.equal(cfg.coordinatorUrl, 'https://from-the-file');
  assert.equal(cfg.hostId, 'boxy', 'quotes stripped');

  const overridden = sidecarConfig({
    env: { AGENT_FLEET_SIDECAR_ENV: file, AGENT_FLEET_COORDINATOR_URL: 'https://from-the-environment' },
  });
  assert.equal(overridden.coordinatorUrl, 'https://from-the-environment');
});

test('an intent is attributed to the credential, not to what the caller claims', async (t) => {
  const { coordinator: c, origin } = await coordinator(t, { apiToken: 'a-token-at-least-16ch' });
  const { token } = await c.core.clients.issue('a phone (someone@example.com)');
  c.core.clients.clients.values().next().value.email = 'someone@example.com';

  /** @type {any} */
  let seen = null;
  c.core.dispatch = async (/** @type {any} */ spec) => {
    seen = spec;
    return { ok: true };
  };

  await fetch(`${origin}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ verb: 'list', actor: 'somebody-else@example.com' }),
  });
  // An actor a caller can choose is a label, not an attribution — and this is
  // what ends up on the session record.
  assert.equal(seen.actor, 'someone@example.com');
});

test('no command name is also another command\'s alias', async () => {
  // Not identity work, but found by it: the lookup table is built by iterating
  // COMMANDS, so a name that is also somebody else's alias resolves by
  // DECLARATION ORDER. /upgrade was one — it installs system packages, and
  // /update restarts the service, and which one you got depended on where the
  // two entries sat in the object.
  const { COMMANDS } = await import('../src/adapters/commands.js');
  /** @type {Map<string, string>} */
  const seen = new Map();
  const collisions = [];
  for (const [name, def] of Object.entries(COMMANDS)) {
    for (const key of [name, ...(def.aliases || [])]) {
      if (seen.has(key)) collisions.push(`${key}: ${seen.get(key)} and ${name}`);
      seen.set(key, name);
    }
  }
  assert.deepEqual(collisions, []);
});

test('re-enrolling a name disconnects whoever held the old key', async (t) => {
  // The Node coordinator's half of the same rule, tested through a real socket
  // rather than a stub: the machine holding the old key is still connected on
  // that name until something closes it.
  const { coordinator: c, origin } = await coordinator(t);
  const port = Number(new URL(origin).port);
  const original = await enrolledProofFor(c, port, 'rebuilt');

  const { WebSocketTransport } = await import('../src/fleet/host/transports/websocket.js');
  const transport = new WebSocketTransport({ origin, hostId: 'rebuilt', proof: original, maxBackoffMs: 50 });
  // Registered as cleanup BEFORE the assertions, not stopped after them. The
  // retry timer is no longer unref'd — that was the bug that made the sidecar
  // exit instead of reconnecting — so a transport left running now holds the
  // event loop open and the whole suite hangs instead of failing. Cleanup in
  // the happy path is cleanup that does not run when a test fails.
  t.after(() => transport.stop());
  await transport.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(c.registry.hosts.get('rebuilt')?.connected, true);

  // A rebuilt machine presents a new key under the same name.
  const replacement = await loadOrCreateKey(scratch());
  // Bound to that name: replacing the key of a machine that already exists is
  // exactly what an unbound pin may no longer do.
  const { code } = c.core.enrollment.mint({ purpose: 'host', hostId: 'rebuilt' });
  const again = await enrol({ origin, code, hostId: 'rebuilt', publicJwk: replacement.publicJwk });
  assert.equal(again.replaced, true);

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.registry.hosts.get('rebuilt')?.connected, false, 'the old key holder is out');

  // And it is the new key that works now.
  const known = await checkEnrolled({ origin, hostId: 'rebuilt', privateJwk: replacement.privateJwk });
  assert.equal(known.ok, true);
});

/** enrolledProof, but taking the coordinator rather than re-deriving the port. */
async function enrolledProofFor(coordinatorInstance, port, hostId) {
  const key = await loadOrCreateKey(scratch());
  const { code } = coordinatorInstance.core.enrollment.mint({ purpose: 'host' });
  const res = await fetch(`http://127.0.0.1:${port}/api/enroll/host`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, hostId, publicJwk: key.publicJwk }),
  });
  assert.equal(res.status, 200);
  return () => proveIdentity({ origin: `http://127.0.0.1:${port}`, hostId, privateJwk: key.privateJwk });
}

test('a config the hub cannot read is not reported as "no fleet"', async () => {
  // agent-hub runs as the service user; /etc/agent-fleet-sidecar.env is written
  // by root. If it cannot be read, the box HAS a coordinator and the bot cannot
  // see it — and "this box is not part of a fleet" would send somebody to
  // configure something that is already configured.
  const cfg = sidecarConfig({
    env: { AGENT_FLEET_SIDECAR_ENV: '/etc/shadow-does-not-matter-here' },
    readFile: () => {
      const e = new Error('EACCES: permission denied');
      /** @type {any} */ (e).code = 'EACCES';
      throw e;
    },
  });
  assert.match(String(cfg.unreadable), /permission denied/);

  const who = await identity({ config: cfg });
  assert.match(who.text, /Cannot read this box's fleet configuration/);
  assert.match(who.text, /install\.sh/, 'and what to do about it');

  const joined = await fleetEnrol('123456', { config: cfg });
  assert.equal(joined.ok, false);
  assert.match(joined.text, /Cannot read/);
});

test('a missing config file is still just "no fleet"', () => {
  const cfg = sidecarConfig({ env: { AGENT_FLEET_SIDECAR_ENV: '/nonexistent' } });
  assert.equal(cfg.unreadable, null, 'a box running from a checkout has these in its environment');
});

// --- what review turned up --------------------------------------------------

test('a pin can be bound to one host, so it cannot take over another', async (t) => {
  // Re-enrolling an existing name REPLACES its key. So without binding, a pin
  // minted so somebody could add a Raspberry Pi is also a pin that takes over
  // the build server — same six digits, different hostId in the request.
  const { coordinator: c, origin } = await coordinator(t);
  const key = await loadOrCreateKey(scratch());
  const { code } = c.core.enrollment.mint({ purpose: 'host', hostId: 'the-pi' });

  await assert.rejects(
    () => enrol({ origin, code, hostId: 'build-server', publicJwk: key.publicJwk }),
    /minted for the-pi/,
  );
  // And the pin is NOT spent by the attempt, so the person it was minted for
  // can still use it.
  const proper = await enrol({ origin, code, hostId: 'the-pi', publicJwk: key.publicJwk });
  assert.equal(proper.ok, true);
});

test('an unbound pin still enrols whatever name it is given', async (t) => {
  // The ordinary case stays one step. Binding is opt-in.
  const { coordinator: c, origin } = await coordinator(t);
  const key = await loadOrCreateKey(scratch());
  const { code } = c.core.enrollment.mint({ purpose: 'host' });
  assert.equal((await enrol({ origin, code, hostId: 'anything', publicJwk: key.publicJwk })).ok, true);
});

test('revoked means revoked: an ordinary pin cannot bring a host back', async (t) => {
  const { coordinator: c, origin } = await coordinator(t);
  const key = await loadOrCreateKey(scratch());
  const first = c.core.enrollment.mint({ purpose: 'host' });
  await enrol({ origin, code: first.code, hostId: 'condemned', publicJwk: key.publicJwk });
  c.core.hostIds.revoke('condemned');

  // This used to write a fresh record with revokedAt: null over the top, and
  // report it as a brand-new enrolment — so any pin undid any revocation and
  // nothing in the event stream said the removed machine was back.
  const ordinary = c.core.enrollment.mint({ purpose: 'host' });
  await assert.rejects(
    () => enrol({ origin, code: ordinary.code, hostId: 'condemned', publicJwk: key.publicJwk }),
    /was revoked/,
  );
  const still = await checkEnrolled({ origin, hostId: 'condemned', privateJwk: key.privateJwk });
  assert.equal(still.ok, false);

  // Readmission is possible, and it takes a pin minted for it.
  const readmit = c.core.enrollment.mint({ purpose: 'host', readmit: true });
  const back = await enrol({ origin, code: readmit.code, hostId: 'condemned', publicJwk: key.publicJwk });
  assert.match(back.text, /Readmitted/);
  assert.equal((await checkEnrolled({ origin, hostId: 'condemned', privateJwk: key.privateJwk })).ok, true);
});

test('a plus-addressed sign-in can actually send an intent', async (t) => {
  // The actor is the verified email now, and the envelope validator did not
  // allow '+'. Plus-addressing is ordinary, so every intent from that person's
  // phone was refused as a bad envelope — sign-in worked and nothing else did.
  const { coordinator: c, origin } = await coordinator(t, { apiToken: 'a-token-at-least-16ch' });
  const { token, client } = await c.core.clients.issue('a phone (eli+fleet@thetech.network)');
  client.email = 'eli+fleet@thetech.network';

  const res = await fetch(`${origin}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ verb: 'list' }),
  });
  const body = /** @type {any} */ (await res.json());
  assert.notEqual(body?.error?.code, 'bad_envelope', JSON.stringify(body));
});

test('the Node coordinator registers a device for push', async (t) => {
  // The Worker has had these since push was built and the Node one never did,
  // so a phone pointed at a box registered against a 404 and then waited for
  // notifications that had nowhere to come from.
  const { origin } = await coordinator(t, { apiToken: 'a-token-at-least-16ch' });
  const auth = { 'content-type': 'application/json', authorization: 'Bearer a-token-at-least-16ch' };

  const reg = await fetch(`${origin}/api/devices`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ platform: 'ios', token: 'a'.repeat(64) }),
  });
  assert.equal(reg.status, 200);

  const gone = await fetch(`${origin}/api/devices`, {
    method: 'DELETE',
    headers: auth,
    body: JSON.stringify({ token: 'a'.repeat(64) }),
  });
  assert.equal(gone.status, 200);
});

test('the fleet records who asked for what', async (t) => {
  // The single highest-value line in the design review: every intent has
  // carried a verified email since sign-in, and it was forwarded to a host and
  // forgotten. The fleet could tell you a session stopped and never who
  // stopped it.
  const { coordinator: c, origin } = await coordinator(t, { apiToken: 'a-token-at-least-16ch' });
  const { token, client } = await c.core.clients.issue('a phone (eli@thetech.network)');
  client.email = 'eli@thetech.network';

  await fetch(`${origin}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ verb: 'stop', params: { name: 'bigjob' } }),
  });

  const recorded = c.core.snapshot().events.find((e) => e.event === 'intent');
  assert.ok(recorded, 'the intent is in the ring');
  assert.equal(recorded.actor, 'eli@thetech.network');
  assert.equal(recorded.verb, 'stop');
  assert.equal(recorded.name, 'bigjob');
});

test('reads do not fill the ring', async (t) => {
  // A `list` every fifteen seconds from three phones would push everything else
  // out of a 200-entry ring within the hour, and the ring is the only memory
  // this coordinator has.
  const { coordinator: c, origin } = await coordinator(t, { apiToken: 'a-token-at-least-16ch' });
  const { token, client } = await c.core.clients.issue('a phone (eli@thetech.network)');
  client.email = 'eli@thetech.network';

  for (let i = 0; i < 5; i++) {
    await fetch(`${origin}/api/intent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ verb: 'list' }),
    });
  }
  assert.equal(c.core.snapshot().events.filter((e) => e.event === 'intent').length, 0);
});

test('revoking a phone stops the fleet talking to it', async (t) => {
  // Revocation used to do one half of the job: a stolen phone lost the ability
  // to ASK the fleet anything, and kept the ability to be TOLD everything —
  // every session name, every host, and since prompts started carrying the
  // question, the questions themselves. That got worse the day the notification
  // stopped saying "resumed (summary)".
  const { coordinator: c, origin } = await coordinator(t, { apiToken: 'a-token-at-least-16ch' });
  const { token, client } = await c.core.clients.issue('a phone (eli@thetech.network)');
  client.email = 'eli@thetech.network';

  const reg = await fetch(`${origin}/api/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: 'ios', token: 'a'.repeat(64) }),
  });
  assert.equal(reg.status, 200);
  assert.equal(c.core.devices.size, 1);
  assert.equal([...c.core.devices.values()][0].clientId, client.id, 'the registration knows whose it is');

  const gone = await fetch(`${origin}/api/clients/${client.id}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer a-token-at-least-16ch' },
  });
  assert.equal(gone.status, 200);
  assert.match(/** @type {any} */ (await gone.json()).text, /stopped 1 push registration/);
  assert.equal(c.core.devices.size, 0, 'the registration went with the credential');
});

test('a registration that outlives its credential is still not notified', async (t) => {
  // Belt as well as braces: the cascade above is the fix, and this is the
  // filter for a registration that somehow survives it — restored from an old
  // state file, say. A device must never be told what a session is asking on a
  // credential that no longer exists.
  const { coordinator: c } = await coordinator(t);
  const { client } = await c.core.clients.issue('a phone (eli@thetech.network)');
  c.core.registerDevice({ platform: 'ios', token: 'b'.repeat(64), clientId: client.id });

  /** @type {any[]} */
  const sent = [];
  c.core.push = { send: async (/** @type {any[]} */ devices) => { sent.push(...devices); return { ok: true }; } };

  // Sanity: it does notify while the credential is live.
  await c.core.onHostMessage('box', { kind: 'event', event: 'session.awaiting-input', name: 'x', text: 'a question' });
  assert.equal(sent.length, 1, 'a live device is notified');

  sent.length = 0;
  c.core.clients.revoke(client.id); // revoked WITHOUT the cascade
  await c.core.onHostMessage('box', { kind: 'event', event: 'session.awaiting-input', name: 'x', text: 'a question' });
  assert.deepEqual(sent, [], 'nothing reaches a device whose credential is revoked');
});
