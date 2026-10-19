// Onboarding a Xen Orchestra pool, from the machine that runs it.
//
//   node --test test/xo-setup.test.js
//
// ASKED FOR: "proxy through an existing host … you don't need the app to stay
// alive", with what github.com/00o-sh/XenOrchestraInstallerUpdater already
// does integrated rather than reimplemented. docs/hypervisors.md.
//
// THE STAND-IN IS REAL WHERE IT MATTERS. A TLS server with a certificate made
// for this run, a real WebSocket upgrade, and frames parsed the way the client
// parses them — so the pin, the handshake and the framing are exercised, not
// assumed. What it cannot prove is that a live Xen Orchestra names its methods
// as these do; that is why `inventory` asks the server for its method list
// before changing anything, and one test below pins that it stops there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { probe, XoSetups, limitsFrom, STEP_WORDS, FLEET_USER, checkPolicy, currentLimits, syslogTo } from '../src/fleet/host/xo-setup.js';
import { XOSETUP_STEPS, XOPOLICY_STEPS, XORECONNECT_STEPS } from '../src/fleet/protocol/intents.js';
import { seal, open, newSealKey, xosetupAad, xosetupHandoffAad, xosetupInventoryAad, xosetupPolicyAad, xosetupPolicySigninAad, xosetupReconnectAad, xosetupReconnectSigninAad, xosetupWatchAad } from '../src/fleet/seal.js';
import { EDGE_WATCH, newWatch } from '../src/fleet/host/edge-credentials.js';
import { generateKeyPair, sign, verify, signingInput, fingerprint } from '../src/fleet/crypto.js';

import { standIn, PASSWORD, skip, xenStoreAsXo } from './helpers/xo-stand-in.js';

/** A machine with an enrolment key, collecting what it reports. */
async function machine(/** @type {{ log?: any, policyWaitMs?: number, coordinatorUrl?: string, buildImage?: any, dropImage?: any, holderPin?: any, imageReporter?: any, relay?: any, now?: () => number, sleep?: (ms: number) => Promise<void>, onEnd?: any }} */ opts = {}) {
  const keys = await generateKeyPair();
  /** @type {any[]} */
  const events = [];
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'xo-state-'));
  const setups = new XoSetups({
    signer: { publicJwk: keys.publicJwk, sign: (m) => sign(keys.privateJwk, m) },
    emit: (e) => events.push(e),
    stateDir,
    fingerprint,
    ...opts,
  });
  return { setups, events, stateDir, keys };
}

/** Wait until a job leaves `running`. */
async function finished(/** @type {XoSetups} */ setups, /** @type {string} */ job, /** @type {string} */ actor) {
  for (let i = 0; i < 400; i++) {
    const s = setups.status({ job, actor });
    if (s.xosetup && s.xosetup.state !== 'running') return s.xosetup;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the job never finished');
}

/**
 * What the phone does with `begin`'s answer: check the signature, make a key
 * for the token to come back to, and seal both the sign-in and that key.
 */
async function phone(/** @type {any} */ begun, /** @type {string} */ address, /** @type {string} */ pin, payload = /** @type {any} */ (null), aad = xosetupAad) {
  const { job, key, keySig, hostKey } = begun.xosetup;
  const signed = await verify(hostKey, keySig, signingInput('xosetup-key', { address, job, key, pin }));
  const reply = await newSealKey();
  const inside = payload ?? { v: 1, xo: { email: 'admin@admin.net', password: PASSWORD }, reply: reply.publicKey };
  const box = await seal({ to: key, aad: aad(job, address), payload: inside });
  return { signed, sealed: `${box.epk}.${box.iv}.${box.ct}`, reply };
}

/** What the phone does with a finished job: open the token record it was handed. */
async function collect(/** @type {any} */ end, /** @type {{ privateKey: CryptoKey, publicKey: string }} */ reply, /** @type {string} */ address) {
  const [epk, iv, ct] = String(end.handoff).split('.');
  return /** @type {any} */ (await open({ ...reply, aad: xosetupHandoffAad(end.job, address), sealed: { epk, iv, ct } }));
}

test('the probe says Xen Orchestra answered, over TLS, and which certificate', { skip }, async (t) => {
  const xo = await standIn(t);
  const found = await probe(xo.address);
  assert.equal(found.reachable, true);
  assert.equal(found.tls, true);
  assert.equal(found.xo, true);
  assert.equal(found.cert, xo.pin);
  // What the person is shown before accepting it: all of what is wrong.
  assert.equal(found.certificate?.trusted, false);
  assert.deepEqual(found.certificate?.problems, ['self-signed', 'name-mismatch']);
  assert.equal(found.certificate?.subject, 'CN=xo.test');
  assert.ok(found.certificate?.notAfter && Date.parse(found.certificate.notAfter) > Date.now());
  const nothing = await probe('127.0.0.1:1', { timeoutMs: 2000 });
  assert.equal(nothing.reachable, false);
});

test('a pool is onboarded end to end, and the limited token goes back to the phone, kept nowhere here', { skip }, async (t) => {
  const xo = await standIn(t);
  const { setups, events, stateDir, keys } = await machine();
  const actor = 'eli@example.com';

  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
  assert.equal(begun.ok, true, begun.text);
  // THE PHONE CAN TELL THE KEY IS THIS MACHINE'S: signed by its enrolment key,
  // over the job, the address, the pin and the key together.
  assert.equal(begun.xosetup.fingerprint, await fingerprint(keys.publicJwk));
  const { signed, sealed, reply } = await phone(begun, xo.address, xo.pin);
  assert.equal(signed, true);
  // A COPY THE FIRST VERSION KEPT for this pool, which the next run removes.
  const old = path.join(stateDir, 'hypervisors', `${xo.address.replace(/[^A-Za-z0-9.-]+/g, '_')}.json`);
  mkdirSync(path.dirname(old), { recursive: true });
  writeFileSync(old, '{"token":"tok-old"}\n');
  const swapped = await verify(begun.xosetup.hostKey, begun.xosetup.keySig, signingInput('xosetup-key', { address: 'evil.lan', job: begun.xosetup.job, key: begun.xosetup.key, pin: xo.pin }));
  assert.equal(swapped, false, 'the signature covers the address');

  const ran = await setups.run({ job: begun.xosetup.job, sealed, actor });
  assert.equal(ran.ok, true, ran.text);
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'done', end.text);

  // Every step reported, in order, then done.
  const steps = events.filter((e) => e.state === 'running').map((e) => e.phase);
  assert.deepEqual(steps, [...XOSETUP_STEPS]);
  assert.equal(events.at(-1).phase, 'done');
  assert.equal(events.at(-1).step, XOSETUP_STEPS.length);

  // The user is limited, bounded by a set, and the token is ITS token.
  const created = xo.calls.find((c) => c.method === 'user.create');
  assert.deepEqual({ email: created?.params.email, permission: created?.params.permission }, { email: FLEET_USER, permission: 'none' });
  const set = xo.calls.find((c) => c.method === 'resourceSet.create');
  assert.deepEqual(set?.params.subjects, [created?.params && xo.users.find((u) => u.email === FLEET_USER).id]);
  assert.deepEqual(set?.params.objects, ['sr1']);
  assert.deepEqual(set?.params.limits, { cpus: 8, memory: 32 * 1024 ** 3, disk: 400 * 1024 ** 3 });
  const token = xo.calls.find((c) => c.method === 'token.create');
  assert.equal(token?.as, FLEET_USER, 'minted signed in as the limited user, never the admin');

  // The installer's update plugin: loaded, kept loaded, and told to update itself.
  assert.ok(xo.calls.some((c) => c.method === 'plugin.load'));
  assert.deepEqual(xo.calls.find((c) => c.method === 'plugin.configure')?.params, { id: 'installer-updates', configuration: { autoUpdate: true } });

  // HANDED BACK, sealed to the phone's key: the token and what it is for.
  const kept = await collect(end, reply, xo.address);
  assert.equal(kept.token, 'tok-limited-123');
  assert.equal(kept.address, xo.address);
  assert.equal(kept.pin, xo.pin);
  assert.equal(kept.user, FLEET_USER);
  // KEPT NOWHERE HERE: not on disk, and not in what the coordinator relays.
  assert.equal(existsSync(old), false, 'the old copy is gone');
  const everything = JSON.stringify({ events, status: end });
  assert.ok(!everything.includes('tok-limited-123'), 'the token is only ever sealed');
  assert.ok(!everything.includes(PASSWORD), 'the admin password went nowhere');
  assert.ok(!JSON.stringify(kept).includes('admin@admin.net'), 'the admin sign-in is not in what was handed back');
  assert.ok(events.every((e) => !('handoff' in e)), 'progress events, which reach a Lock Screen, never carry it');
  // ONLY UNDER ITS OWN BINDING: the sealed token is not a sealed sign-in.
  const [epk, iv, ct] = end.handoff.split('.');
  await assert.rejects(open({ ...reply, aad: xosetupAad(end.job, xo.address), sealed: { epk, iv, ct } }));
  // And only to whoever began it.
  assert.equal(setups.status({ job: end.job, actor: 'sam@example.com' }).ok, false);
});

test('a sign-in with nowhere to hand the token back is refused before anything is made', { skip }, async (t) => {
  // An app older than the hand-off. Running it would make a user and a token
  // in Xen Orchestra that no phone could ever be given.
  const xo = await standIn(t);
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
  const { sealed } = await phone(begun, xo.address, xo.pin, { v: 1, xo: { email: 'admin@admin.net', password: PASSWORD } });
  const ran = await setups.run({ job: begun.xosetup.job, sealed, actor });
  assert.equal(ran.ok, false);
  assert.match(ran.text, /no key to hand the token back to, so nothing was started/);
  assert.equal(ran.xosetup?.state, 'failed');
  assert.equal(xo.calls.length, 0, 'Xen Orchestra was never reached');
});

test('a server with a different certificate is never sent a byte of the sign-in', { skip }, async (t) => {
  const xo = await standIn(t);
  /** @type {string[]} */
  const journal = [];
  const { setups, events } = await machine({ log: { info() {}, warn: (/** @type {string} */ m) => journal.push(m) } });
  const actor = 'eli@example.com';
  const otherPin = 'f'.repeat(64);
  const begun = await setups.begin({ address: xo.address, pin: otherPin, trust: 'accepted', actor });
  const { sealed } = await phone(begun, xo.address, otherPin);
  await setups.run({ job: begun.xosetup.job, sealed, actor });
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'connect');
  assert.match(end.text, /different certificate/);
  assert.equal(xo.calls.length, 0, 'not even a handshake reached the API');
  assert.ok(!JSON.stringify(events).includes(PASSWORD));
  // The journal says why as well, which is what the box's owner can read
  // once the phone has let the job go.
  assert.ok(journal.some((m) => m.includes('stopped at connect') && /different certificate/.test(m)), journal.join('\n'));
  assert.ok(!journal.join('\n').includes(PASSWORD));
});

test('an account that is not an admin is told so, and nothing is made', { skip }, async (t) => {
  const xo = await standIn(t, { admin: false });
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
  await setups.run({ job: begun.xosetup.job, sealed: (await phone(begun, xo.address, xo.pin)).sealed, actor });
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'sign-in');
  assert.match(end.text, /not a Xen Orchestra admin/);
  assert.ok(!xo.calls.some((c) => c.method === 'user.create'));
});

test('a Xen Orchestra without a method setup needs stops before changing anything', { skip }, async (t) => {
  // THE GUARD FOR WHAT THE SUITE CANNOT PROVE: these names come from Xen
  // Orchestra's source and its Terraform provider, not a live pool.
  const xo = await standIn(t, { drop: ['resourceSet.create'] });
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
  await setups.run({ job: begun.xosetup.job, sealed: (await phone(begun, xo.address, xo.pin)).sealed, actor });
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'inventory');
  assert.match(end.text, /resourceSet\.create/);
  assert.match(end.text, /Nothing was changed/);
  assert.ok(!xo.calls.some((c) => /\.(create|set)$/.test(c.method)));
});

test('automatic updates switched off by a person stay off', { skip }, async (t) => {
  const xo = await standIn(t, { plugin: { id: 'installer-updates', loaded: true, autoload: true, configuration: { autoUpdate: false } } });
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
  await setups.run({ job: begun.xosetup.job, sealed: (await phone(begun, xo.address, xo.pin)).sealed, actor });
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.ok(!xo.calls.some((c) => c.method === 'plugin.configure'));
  assert.match(end.text, /left that way/);
});

test('a sealed sign-in opens only for its own job and address, and only for whoever began it', async () => {
  const { setups } = await machine();
  const pin = 'a'.repeat(64);
  const one = await setups.begin({ address: 'xo.lan', pin, actor: 'eli@example.com' });
  const two = await setups.begin({ address: 'xo.lan', pin, actor: 'eli@example.com' });
  const forOne = (await phone(one, 'xo.lan', pin)).sealed;

  assert.equal((await setups.run({ job: two.xosetup.job, sealed: forOne, actor: 'eli@example.com' })).ok, false, 'replayed into another job');
  assert.equal((await setups.run({ job: one.xosetup.job, sealed: forOne, actor: 'sam@example.com' })).ok, false, 'somebody else');
  assert.equal(setups.status({ job: one.xosetup.job, actor: 'sam@example.com' }).ok, false);
  // Still waiting: neither attempt spent the key.
  assert.equal(setups.status({ job: one.xosetup.job, actor: 'eli@example.com' }).xosetup?.state, 'waiting');
});

test('a machine with no enrolment key, or no pin, does not begin', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'xo-state-'));
  const none = new XoSetups({ signer: null, emit: () => {}, stateDir, fingerprint });
  assert.equal((await none.begin({ address: 'xo.lan', pin: 'a'.repeat(64), actor: 'eli@example.com' })).ok, false);
  const { setups } = await machine();
  assert.equal((await setups.begin({ address: 'xo.lan', pin: null, actor: 'eli@example.com' })).ok, false);
  assert.equal(existsSync(path.join(stateDir, 'hypervisors')), false);
});

test('the limits are half of what the pool has, and every step has words', () => {
  assert.deepEqual(
    limitsFrom([{ cpus: { cores: 6 } }, { cpus: { cores: 2 } }], [{ id: 's', size: 100, physical_usage: 20 }], [{ default_SR: 's' }]),
    { cpus: 4, memory: 1024 ** 3, disk: 10 * 1024 ** 3 },
  );
  for (const key of [...XOSETUP_STEPS, ...XORECONNECT_STEPS]) assert.ok(STEP_WORDS[key], key);
});

test('a certificate nothing vouches for stops setup unless the person accepted it, before a byte is sent', { skip }, async (t) => {
  const xo = await standIn(t);
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, actor });
  await setups.run({ job: begun.xosetup.job, sealed: (await phone(begun, xo.address, xo.pin)).sealed, actor });
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'connect');
  assert.match(end.text, /is self-signed, is for a different name, and nobody accepted it/);
  assert.equal(xo.calls.length, 0);
});

test('a server that caps tokens lower still gets one, at its own default length', { skip }, async (t) => {
  const xo = await standIn(t, { maxTokenMs: 30 * 24 * 60 * 60_000 });
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
  const { sealed, reply } = await phone(begun, xo.address, xo.pin);
  await setups.run({ job: begun.xosetup.job, sealed, actor });
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'done', end.text);
  const asks = xo.calls.filter((c) => c.method === 'token.create').map((c) => c.params.expiresIn);
  assert.deepEqual(asks, [180 * 24 * 60 * 60_000, undefined]);
  const kept = await collect(end, reply, xo.address);
  assert.equal(kept.tokenExpires, null, 'the length is the server’s, which it does not say');
  assert.deepEqual({ trusted: kept.certificate.trusted, accepted: kept.certificate.accepted }, { trusted: false, accepted: true });
});

test('a setup begun with nobody’s name on it is refused', async () => {
  const { setups } = await machine();
  assert.equal((await setups.begin({ address: 'xo.lan', pin: 'a'.repeat(64), actor: null })).ok, false);
});

test('a Xen Orchestra on plain HTTP is set up once the person accepted it, and kept saying so', { skip }, async (t) => {
  const xo = await standIn(t, { plain: true });
  const found = await probe(xo.address);
  assert.equal(found.reachable, true);
  assert.equal(found.tls, false);
  assert.equal(found.xo, true);
  assert.equal(found.cert, null);
  assert.match(found.text, /over plain HTTP/);

  const { setups } = await machine();
  const actor = 'eli@example.com';
  // No pin and no acceptance is still a refusal.
  assert.equal((await setups.begin({ address: xo.address, pin: null, actor })).ok, false);
  // A pin and `plain` together is a client that cannot decide.
  assert.equal((await setups.begin({ address: xo.address, pin: 'a'.repeat(64), plain: 'accepted', actor })).ok, true, 'a pin wins: it is the HTTPS path');

  const begun = await setups.begin({ address: xo.address, pin: null, plain: 'accepted', actor });
  assert.equal(begun.ok, true, begun.text);
  // Signed over an empty pin, which is what the phone checks it against.
  const { signed, sealed, reply } = await phone(begun, xo.address, '');
  assert.equal(signed, true);
  await setups.run({ job: begun.xosetup.job, sealed, actor });
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.match(end.text, /over plain HTTP, as you accepted/);
  const kept = await collect(end, reply, xo.address);
  assert.equal(kept.plain, true);
  assert.equal(kept.pin, null);
  assert.equal(kept.token, 'tok-limited-123');
});

// --- what the fleet may use: setup's defaults, and the person's own choice ---

/** A resource set an earlier run made and a person has since changed. */
const chosenBefore = () => ({ id: 'rs-0', name: 'fleetwright', subjects: ['u-old'], objects: ['sr2', 'net-lab'], limits: { cpus: { total: 4, available: 4 }, memory: { total: 8 * 1024 ** 3, available: 8 * 1024 ** 3 }, disk: { total: 100 * 1024 ** 3, available: 100 * 1024 ** 3 } } });

/** Begin and run a policy job, and wait until it is waiting on the person. */
async function choosing(/** @type {any} */ xo, /** @type {XoSetups} */ setups, actor = 'eli@example.com') {
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
  assert.deepEqual(
    begun.xosetup.can,
    ['policy', 'policy-signin', 'reconnect', 'reconnect-signin', 'edge', 'egress-any', 'edge-disk', 'edge-block', 'edge-ha', 'groups', ...(setups.coordinatorUrl ? ['image', 'images', 'labs', 'labs-each', 'image-manage', 'machine-grants', 'image-channel'] : []), ...(setups.coordinatorUrl && setups.holderPin ? ['holder', 'holder-ask'] : [])],
    'a machine that can says so before any sign-in is sealed',
  );
  const reply = await newSealKey();
  // Sealed as an updated phone seals a policy change: under its own binding.
  const { sealed } = await phone(begun, xo.address, xo.pin, { v: 1, xo: { email: 'admin@admin.net', password: PASSWORD }, reply: reply.publicKey, purpose: 'policy' }, xosetupPolicySigninAad);
  const ran = await setups.run({ job: begun.xosetup.job, sealed, actor });
  assert.equal(ran.ok, true, ran.text);
  /** @type {any} */
  let s;
  for (let i = 0; i < 400; i++) {
    s = setups.status({ job: begun.xosetup.job, actor }).xosetup;
    if (s.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return { begun, reply, state: s };
}

/** What the phone sends once it has chosen, sealed to the job's key. */
async function choose(/** @type {any} */ begun, /** @type {string} */ address, /** @type {any} */ policy) {
  const box = await seal({ to: begun.xosetup.key, aad: xosetupPolicyAad(begun.xosetup.job, address), payload: policy });
  return `${box.epk}.${box.iv}.${box.ct}`;
}

test('changing the policy keeps the machine images and the fleet\'s own machines in the set, and puts back an image the job made, never one that only carries the tag', { skip }, async (t) => {
  // Every change of policy wrote storage and networks alone into the set,
  // which `resourceSet.set` replaces: the Debian image went with a change
  // that only asked for an Ubuntu one, and the next machine asked for from
  // it was refused with "not enough permissions".
  // And an Ubuntu image already taken out by such a change, which the next
  // change puts back: the phone sends nothing about an image it keeps.
  // But only one the job made and listed (vm-image.js, isFleetImage): every
  // template on any pool carrying the tag used to go into the set, for every
  // approved box's token to clone.
  const xo = await standIn(t, {
    sets: [{ ...chosenBefore(), objects: ['sr2', 'net-lab', 'tpl-debian', 'vm-holder'] }, { id: 'rs-made', name: 'fleetwright-made', objects: ['tpl-ubuntu'] }],
    templates: {
      'tpl-ubuntu': { id: 'tpl-ubuntu', type: 'VM-template', $pool: 'p1', name_label: 'Fleetwright Ubuntu 24.04', tags: ['fleetwright-image', 'fleetwright-image:ubuntu-24.04'] },
      'tpl-planted': { id: 'tpl-planted', type: 'VM-template', $pool: 'p1', name_label: 'Fleetwright Debian 13', tags: ['fleetwright-image', 'fleetwright-image:debian-13'] },
    },
  });
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const { begun, reply, state } = await choosing(xo, setups, actor);
  const [epk, iv, ct] = state.inventory.split('.');
  const inventory = /** @type {any} */ (await open({ ...reply, aad: xosetupInventoryAad(begun.xosetup.job, xo.address), sealed: { epk, iv, ct } }));
  assert.deepEqual(inventory.images.map((/** @type {any} */ i) => i.key), ['ubuntu-24.04'], 'the phone is shown a template that only carries the tag as the pool’s image');
  const good = { v: 1, srs: ['sr1'], networks: ['net-dmz'], egress: 'net-dmz', limits: { cpus: 8, memory: 16 * 1024 ** 3, disk: 500 * 1024 ** 3 } };
  const took = await setups.policy({ job: begun.xosetup.job, sealed: await choose(begun, xo.address, good), actor });
  assert.equal(took.ok, true, took.text);
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'done', end.text);
  // What the phone chose replaces the storage and networks; the rest stays.
  assert.deepEqual(xo.sets[0].objects, ['sr1', 'net-dmz', 'tpl-debian', 'vm-holder', 'tpl-ubuntu'], 'a template that only carries the tag went into the set');
});

test('a setup run again leaves what the fleet may use as a person left it', { skip }, async (t) => {
  const xo = await standIn(t, { sets: [chosenBefore()] });
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
  const { sealed, reply } = await phone(begun, xo.address, xo.pin);
  await setups.run({ job: begun.xosetup.job, sealed, actor });
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'done', end.text);
  const set = xo.calls.find((c) => c.method === 'resourceSet.set');
  assert.deepEqual(Object.keys(set?.params ?? {}).sort(), ['id', 'subjects'], 'only the user is pointed at it; its storage, networks and limits are not touched');
  assert.deepEqual(xo.sets[0].objects, ['sr2', 'net-lab']);
  assert.match(end.text, /already set, and was left as it was/);
  const kept = await collect(end, reply, xo.address);
  assert.deepEqual(kept.limits, { cpus: 4, memory: 8 * 1024 ** 3, disk: 100 * 1024 ** 3 }, 'what the phone keeps is what is in force');
});

test('a policy is chosen on the phone from the pool it was shown, sealed both ways, and Xen Orchestra enforces it', { skip }, async (t) => {
  const xo = await standIn(t, { sets: [chosenBefore()] });
  const { setups, events } = await machine();
  const actor = 'eli@example.com';
  const { begun, reply, state } = await choosing(xo, setups, actor);
  assert.equal(state.state, 'choosing', state.text);
  assert.equal(state.phase, 'choose');
  assert.equal(state.of, XOPOLICY_STEPS.length);

  // THE POOL, opened only with the phone's key and under its own binding.
  const [epk, iv, ct] = state.inventory.split('.');
  const inventory = /** @type {any} */ (await open({ ...reply, aad: xosetupInventoryAad(begun.xosetup.job, xo.address), sealed: { epk, iv, ct } }));
  await assert.rejects(open({ ...reply, aad: xosetupHandoffAad(begun.xosetup.job, xo.address), sealed: { epk, iv, ct } }));
  assert.deepEqual(inventory.srs.map((/** @type {any} */ s) => s.id), ['sr1', 'sr2'], 'an ISO library is not somewhere a disk can go');
  assert.deepEqual(inventory.srs[1], { id: 'sr2', name: 'NFS', pool: 'p1', size: 4000 * 1024 ** 3, free: 3000 * 1024 ** 3, shared: true });
  assert.deepEqual(inventory.networks.map((/** @type {any} */ n) => [n.id, n.vlan, n.egress]), [['net-mgmt', null, true], ['net-lab', null, false], ['net-dmz', 30, false]]);
  assert.deepEqual(inventory.capacity, { cpus: 16, memory: 64 * 1024 ** 3 });
  assert.deepEqual(inventory.current, { srs: ['sr2'], networks: ['net-lab'], limits: { cpus: 4, memory: 8 * 1024 ** 3, disk: 100 * 1024 ** 3 } });

  const job = begun.xosetup.job;
  const good = { v: 1, srs: ['sr1', 'sr2'], networks: ['net-lab', 'net-dmz'], egress: 'net-dmz', limits: { cpus: 8, memory: 16 * 1024 ** 3, disk: 500 * 1024 ** 3 } };
  // A CHOICE THE POOL DID NOT OFFER is refused, and the job goes on waiting.
  const bad = await setups.policy({ job, sealed: await choose(begun, xo.address, { ...good, networks: ['net-elsewhere'] }), actor });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /did not list/);
  assert.equal(setups.status({ job, actor }).xosetup.state, 'choosing');
  // Sealed under the sign-in's binding, it is not a choice at all.
  const box = await seal({ to: begun.xosetup.key, aad: xosetupAad(job, xo.address), payload: good });
  assert.equal((await setups.policy({ job, sealed: `${box.epk}.${box.iv}.${box.ct}`, actor })).ok, false);
  // Nor is it anybody's but theirs.
  assert.equal((await setups.policy({ job, sealed: await choose(begun, xo.address, good), actor: 'sam@example.com' })).ok, false);

  const took = await setups.policy({ job, sealed: await choose(begun, xo.address, good), actor });
  assert.equal(took.ok, true, took.text);
  const end = await finished(setups, job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.deepEqual(xo.calls.filter((c) => c.method === 'resourceSet.set').map((c) => c.params), [
    { id: 'rs-0', objects: ['sr1', 'sr2', 'net-lab', 'net-dmz'], limits: good.limits },
  ]);
  // THE WAY OUT MOVED, not doubled.
  assert.deepEqual(xo.tags.get('net-mgmt'), []);
  assert.deepEqual(xo.tags.get('net-dmz'), ['fleetwright-egress']);
  assert.match(end.text, /Labs leave through dmz\./);
  // Said as a person writes it: two storage repositories, not repositorys.
  assert.match(end.text, /It may use 2 storage repositories, 2 networks,/);
  // Nothing about the fleet's user or token changed, and the password is
  // nowhere. What reached a Lock Screen is the applying and the end, said as
  // a policy job's, and not the steps the person watched on the open screen.
  assert.ok(!xo.calls.some((c) => /^(user|token)\./.test(c.method)));
  assert.deepEqual(events.map((/** @type {any} */ e) => [e.phase, e.state, e.purpose]), [['apply', 'running', 'policy'], ['done', 'done', 'policy']]);
  assert.equal(end.handoff, undefined);
  assert.equal(end.inventory, undefined, 'the pool is not handed out once the choice is made');
  assert.ok(!JSON.stringify(setups.status({ job, actor })).includes(PASSWORD));
  // Its key has opened the one more thing it was for, and opens nothing now.
  assert.equal((await setups.policy({ job, sealed: await choose(begun, xo.address, good), actor })).ok, false);
});

test('the machine image is built after the policy, on the way out’s pool, behind its router, and said in the end', { skip }, async (t) => {
  // ASKED FOR: "Still can't run sessions on it". The image sessions' machines
  // are cloned from is built by the job that already holds the admin sign-in.
  const xo = await standIn(t, {
    sets: [chosenBefore()],
    more: ['network.create', 'resourceSet.addObject', 'disk.import', 'disk.resize', 'vm.create', 'vm.attachDisk', 'vm.createCloudInitConfigDrive', 'vdi.delete', 'vm.start', 'vm.set', 'vm.convertToTemplate'],
    vms: { edge: { id: 'edge', type: 'VM', $pool: 'p1', tags: ['fleetwright-edge', 'fleetwright-edge-updates'], power_state: 'Running' } },
  });
  /** @type {any[]} */
  const asked = [];
  /** @type {string[]} */
  const tokensFor = [];
  /** What the build saw of its VM's reports, as the coordinator passed them on. */
  const heard = /** @type {any[]} */ ([]);
  const box = /** @type {{ setups?: XoSetups, job?: string }} */ ({});
  const { setups, events } = await machine({
    coordinatorUrl: 'https://fleet.test',
    imageReporter: async (/** @type {string} */ job) => (tokensFor.push(job), { ok: true, token: 'fwi_token' }),
    buildImage: async (/** @type {any} */ o) => {
      asked.push(o);
      assert.equal(await o.reporter(), 'fwi_token');
      for (const msg of [{ step: 'installer' }, { step: 'Everything is fine' }, { step: 'failed', detail: 'E: no' }]) {
        box.setups?.imageReport({ job: box.job, ...msg });
        heard.push(o.vmReport()?.step ?? null);
      }
      box.setups?.imageReport({ job: 'ffffffffffff', step: 'done' });
      heard.push(o.vmReport()?.detail ?? null);
      o.say('Writing Debian 13’s disk to Home: 700 of 2048 MB.', { stage: 2, stages: 4, fill: 300, doing: 'keep', done: 700, total: 2048 });
      o.say('Installing Fleetwright on the machine image.', { stage: 3, stages: 4, fill: 600 });
      return 'The machine image is ready on Home.';
    },
  });
  box.setups = setups;
  const actor = 'eli@example.com';
  const { begun, reply, state } = await choosing(xo, setups, actor);
  const [epk, iv, ct] = state.inventory.split('.');
  const inventory = /** @type {any} */ (await open({ ...reply, aad: xosetupInventoryAad(begun.xosetup.job, xo.address), sealed: { epk, iv, ct } }));
  assert.deepEqual(inventory.images, [], 'no image yet, so the phone offers one');
  const job = begun.xosetup.job;
  box.job = job;
  const good = { v: 1, srs: ['sr1', 'sr2'], networks: ['net-lab'], egress: 'net-dmz', image: true, edgeSr: 'sr2', limits: { cpus: 8, memory: 16 * 1024 ** 3, disk: 500 * 1024 ** 3 } };
  const took = await setups.policy({ job, sealed: await choose(begun, xo.address, good), actor });
  assert.equal(took.ok, true, took.text);
  const end = await finished(setups, job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.match(end.text, /The machine image is ready on Home\./);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].pool, 'p1');
  assert.equal(asked[0].poolName, 'Home');
  assert.equal(asked[0].uplink, 'net-uplink', 'on the uplink, behind the router');
  assert.equal(asked[0].setId, 'rs-0');
  assert.equal(asked[0].sr, 'sr2');
  assert.equal(asked[0].coordinatorUrl, 'https://fleet.test');
  // ITS VM REPORTS ITS INSTALL: a token asked for this job, and each step the
  // coordinator passes on kept for the build, a word it does not know dropped
  // and another job's report not this one's.
  assert.deepEqual(tokensFor, [job]);
  assert.deepEqual(heard, ['installer', 'installer', 'failed', 'E: no']);
  // Its bar reaches the Lock Screen, saying what is being built and which
  // part: the phones once called every build's part the edge router's.
  assert.ok(events.some((/** @type {any} */ e) => e.fill === 600 && e.purpose === 'policy' && e.build === 'image' && e.stage === 3 && e.stages === 4), JSON.stringify(events.at(-1)));
  // And what the bytes are doing while they move, as a key and megabytes
  // (XOBUILD_DOING): the event carries them, and a part that moves none
  // carries none, so the Lock Screen says megabytes only while there are some.
  const moving = events.find((/** @type {any} */ e) => e.doing);
  assert.deepEqual([moving?.doing, moving?.done, moving?.total, moving?.stage], ['keep', 700, 2048, 2]);
  assert.ok(events.filter((/** @type {any} */ e) => e.fill === 600).every((/** @type {any} */ e) => !('doing' in e) && !('done' in e)));
  assert.equal(asked[0].image, 'debian-13', 'a phone from before the choice asked for Debian');
  assert.equal(asked[0].channel, null, 'and said nothing about the suite, which builds it as before');
  assert.equal(asked[0].resize, 'disk.resize', 'the long-standing name, where the server offers it');
  assert.deepEqual(inventory.imageKinds.map((/** @type {any} */ k) => k.key), ['debian-13', 'ubuntu-24.04', 'ubuntu-26.04']);
});

test('the pool’s own machine is made last, from its image, with a pin asked for this job, and the person told to approve it', { skip }, async (t) => {
  // ASKED FOR: "dedicated hypervisor VM on the pool". src/fleet/host/xo-holder.js.
  const vms = /** @type {Record<string, any>} */ ({ edge: { id: 'edge', type: 'VM', $pool: 'p1', tags: ['fleetwright-edge', 'fleetwright-edge-updates'], power_state: 'Running' } });
  const xo = await standIn(t, {
    sets: [{ ...chosenBefore(), objects: [...chosenBefore().objects, 'tpl'] }],
    more: ['network.create', 'resourceSet.addObject', 'vm.create', 'vm.start'],
    vms,
    templates: { tpl: { id: 'tpl', type: 'VM-template', name_label: 'Fleetwright Debian 13', $pool: 'p1', tags: ['fleetwright-image', 'fleetwright-image:debian-13'] } },
  });
  // A VM an admin made, in no set, given both tags by somebody with
  // `administrate` on it, which is all tag.add asks. Not on the admin's list,
  // so not the pool's own machine: not shown, not started, not "already there".
  vms.planted = { id: 'planted', type: 'VM', $pool: 'p1', name_label: 'holder-444444', power_state: 'Halted', mainIpAddress: '192.168.1.66', tags: ['fleetwright-holder', `fleetwright-holder-for:${xo.address}`] };
  /** @type {Array<[string, string]>} */
  const pinsFor = [];
  const { setups } = await machine({
    coordinatorUrl: 'https://fleet.test',
    holderPin: async (/** @type {string} */ job, /** @type {string} */ address) => (pinsFor.push([job, address]), { ok: true, pin: '123456', hostId: 'holder-0a1b2c' }),
  });
  const actor = 'eli@example.com';
  const { begun, reply, state } = await choosing(xo, setups, actor);
  const [epk, iv, ct] = state.inventory.split('.');
  const inventory = /** @type {any} */ (await open({ ...reply, aad: xosetupInventoryAad(begun.xosetup.job, xo.address), sealed: { epk, iv, ct } }));
  assert.deepEqual(inventory.holders, [], 'none yet — the planted one is not shown in its place — so the phone offers one');
  const job = begun.xosetup.job;
  // The secret the phone made, sealed with the rest of the choice.
  const secret = 'ab'.repeat(32);
  const good = { v: 1, srs: ['sr1', 'sr2'], networks: ['net-lab'], egress: 'net-dmz', holder: true, holderSecret: secret, limits: { cpus: 8, memory: 16 * 1024 ** 3, disk: 500 * 1024 ** 3 } };
  const took = await setups.policy({ job, sealed: await choose(begun, xo.address, good), actor });
  assert.equal(took.ok, true, took.text);
  const end = await finished(setups, job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.match(end.text, /holder-0a1b2c is starting on dmz\. Once it is up it asks to join/);
  assert.deepEqual(pinsFor, [[job, xo.address]], 'one pin, for this job, naming the pool its name is held for');
  const made = xo.calls.find((/** @type {any} */ c) => c.method === 'vm.create');
  assert.ok(made.params.cloudConfig.includes(`"secret":"${secret}"`), 'it boots with the secret to ask with');
  assert.equal(made.as, 'admin@admin.net', 'with the admin sign-in, outside the fleet’s set');
  assert.equal(made.params.template, 'tpl');
  assert.deepEqual(made.params.VIFs, [{ network: 'net-dmz' }]);
  assert.ok(!xo.calls.some((/** @type {any} */ c) => c.method === 'vm.start' && c.params.id === 'planted'), 'the planted one was started as the pool’s own');
  const listed = xo.sets.find((/** @type {any} */ s) => s.name === 'fleetwright-made');
  assert.deepEqual(listed?.objects, ['vm-made-1'], 'the one made is on the admin’s list, and nothing else is');
});

test('a router’s logs go to this box first, then to the pool’s own machines that are up, two at most kept by the router', () => {
  // A holder's address is what its guest agent reports. It came first, so a
  // second one — or one that was never the pool's own — pushed the box
  // watching the router off a list the router keeps two of.
  const up = (/** @type {string} */ id, /** @type {string} */ ip) => ({ id, $pool: 'p1', power_state: 'Running', mainIpAddress: ip });
  assert.deepEqual(syslogTo([up('a', '192.168.1.66'), up('b', '192.168.1.67')], 'p1', '192.168.1.20'), ['192.168.1.20', '192.168.1.66', '192.168.1.67']);
  assert.deepEqual(syslogTo([up('a', '192.168.1.20'), { ...up('c', '10.0.0.9'), $pool: 'p2' }, { ...up('d', '10.0.0.8'), power_state: 'Halted' }, up('e', '8.8.8.8')], 'p1', '192.168.1.20'), ['192.168.1.20'], 'each once, this pool’s, up, private');
  assert.deepEqual(syslogTo([up('a', '192.168.1.66')], 'p1', null), ['192.168.1.66'], 'a box reaching Xen Orchestra through a relay has no address of its own here');
});

test('a Xen Orchestra without disk.resize builds the image through vdi.set, and one with neither says both names', { skip }, async (t) => {
  for (const [grow, expect] of [[['vdi.set'], 'vdi.set'], [[], null]]) {
    const xo = await standIn(t, {
      sets: [chosenBefore()],
      more: ['network.create', 'resourceSet.addObject', 'disk.import', 'vm.create', 'vm.attachDisk', 'vm.createCloudInitConfigDrive', 'vdi.delete', 'vm.start', 'vm.set', 'vm.convertToTemplate', ...grow],
      vms: { edge: { id: 'edge', type: 'VM', $pool: 'p1', tags: ['fleetwright-edge', 'fleetwright-edge-updates'], power_state: 'Running' } },
    });
    /** @type {any[]} */
    const asked = [];
    const { setups } = await machine({
      coordinatorUrl: 'https://fleet.test',
      buildImage: async (/** @type {any} */ o) => {
        asked.push(o);
        return 'The machine image is ready on Home.';
      },
    });
    const actor = 'eli@example.com';
    const { begun } = await choosing(xo, setups, actor);
    const good = { v: 1, srs: ['sr1', 'sr2'], networks: ['net-lab'], egress: 'net-dmz', image: true, limits: { cpus: 8, memory: 16 * 1024 ** 3, disk: 500 * 1024 ** 3 } };
    assert.equal((await setups.policy({ job: begun.xosetup.job, sealed: await choose(begun, xo.address, good), actor })).ok, true);
    const end = await finished(setups, begun.xosetup.job, actor);
    if (expect) {
      assert.equal(end.state, 'done', end.text);
      assert.equal(asked[0].resize, expect);
    } else {
      assert.equal(end.state, 'failed');
      assert.match(end.text, /does not offer disk\.resize or vdi\.set, so the machine image cannot be built/);
      assert.equal(asked.length, 0);
    }
  }
});

test('an image that is there is rebuilt or removed when the person asks, removed ones first', { skip }, async (t) => {
  // ASKED FOR: "There is no rebuild button or delete button".
  const xo = await standIn(t, {
    sets: [{ ...chosenBefore(), objects: [...chosenBefore().objects, 'deb', 'u24'] }],
    more: ['network.create', 'resourceSet.addObject', 'disk.import', 'disk.resize', 'vm.create', 'vm.attachDisk', 'vm.createCloudInitConfigDrive', 'vdi.delete', 'vm.start', 'vm.set', 'vm.convertToTemplate', 'vm.delete'],
    vms: { edge: { id: 'edge', type: 'VM', $pool: 'p1', tags: ['fleetwright-edge', 'fleetwright-edge-updates'], power_state: 'Running' } },
    templates: {
      deb: { id: 'deb', type: 'VM-template', name_label: 'Fleetwright Debian 13', $pool: 'p1', tags: ['fleetwright-image', 'fleetwright-image:debian-13'] },
      u24: { id: 'u24', type: 'VM-template', name_label: 'Fleetwright Ubuntu 24.04 LTS', $pool: 'p1', tags: ['fleetwright-image', 'fleetwright-image:ubuntu-24.04', 'fleetwright-channel:rolling'] },
    },
  });
  /** @type {string[]} */
  const done = [];
  /** @type {any[]} */
  const channels = [];
  const { setups } = await machine({
    coordinatorUrl: 'https://fleet.test',
    buildImage: async (/** @type {any} */ o) => (done.push(`${o.replace ? 'rebuild' : 'build'} ${o.image}`), channels.push(o.channel), `Rebuilt ${o.image}.`),
    dropImage: async (/** @type {any} */ o) => (done.push(`remove ${o.image} on ${o.pool}`), `Removed ${o.image}.`),
  });
  const actor = 'eli@example.com';
  const { begun, reply, state } = await choosing(xo, setups, actor);
  // WHICH SUITE EACH IMAGE WAS BUILT FROM, so the phone can say it and offer
  // the other: by its tag, and stable for one from before there was a choice.
  const [epk, iv, ct] = state.inventory.split('.');
  const inventory = /** @type {any} */ (await open({ ...reply, aad: xosetupInventoryAad(begun.xosetup.job, xo.address), sealed: { epk, iv, ct } }));
  assert.deepEqual(inventory.images.map((/** @type {any} */ i) => [i.key, i.channel]), [['debian-13', 'stable'], ['ubuntu-24.04', 'rolling']]);
  const good = { v: 1, srs: ['sr1', 'sr2'], networks: ['net-lab'], egress: 'net-dmz', rebuild: ['debian-13'], remove: ['ubuntu-24.04'], imageChannel: 'rolling', limits: { cpus: 8, memory: 16 * 1024 ** 3, disk: 500 * 1024 ** 3 } };
  const took = await setups.policy({ job: begun.xosetup.job, sealed: await choose(begun, xo.address, good), actor });
  assert.equal(took.ok, true, took.text);
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.deepEqual(done, ['remove ubuntu-24.04 on p1', 'rebuild debian-13']);
  assert.deepEqual(channels, ['rolling'], 'the rebuild is told the suite the phone chose');
  assert.match(end.text, /Removed ubuntu-24\.04\. Rebuilt debian-13\./);
});

test('group networks are made by the policy job in the way out’s pool, put in the set, and nothing is built', { skip }, async (t) => {
  // ASKED FOR: "the 3 VMs need to reach each other". A network with no way
  // off the pool, made with the admin sign-in the fleet's user does not have.
  const xo = await standIn(t, { sets: [chosenBefore()], more: ['network.create', 'resourceSet.addObject'] });
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const { begun, reply, state } = await choosing(xo, setups, actor);
  const [epk, iv, ct] = state.inventory.split('.');
  const inventory = /** @type {any} */ (await open({ ...reply, aad: xosetupInventoryAad(begun.xosetup.job, xo.address), sealed: { epk, iv, ct } }));
  assert.deepEqual(inventory.groups, [], 'none yet, so the phone starts at none');
  const job = begun.xosetup.job;
  const good = { v: 1, srs: ['sr1'], networks: ['net-lab'], egress: 'net-dmz', groups: 2, limits: { cpus: 8, memory: 16 * 1024 ** 3, disk: 500 * 1024 ** 3 } };
  const took = await setups.policy({ job, sealed: await choose(begun, xo.address, good), actor });
  assert.equal(took.ok, true, took.text);
  const end = await finished(setups, job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.deepEqual(
    xo.calls.filter((c) => c.method === 'network.create').map((c) => [c.params.pool, c.params.name]),
    [['p1', 'fleetwright-group-1'], ['p1', 'fleetwright-group-2']],
    'and no uplink, which is the router’s',
  );
  assert.ok(xo.calls.some((c) => c.method === 'resourceSet.addObject' && c.params.id === 'rs-0'), 'the fleet may use them');
  assert.ok(!xo.calls.some((c) => /^(vm|disk)\./.test(c.method)), 'no router and no image were asked for');
  assert.match(end.text, /Made 2 group networks for machines that work together\./);
});

test('the uplink and the group networks stay in the set whatever the phone left out', { skip }, async (t) => {
  const xo = await standIn(t, {
    sets: [{ ...chosenBefore(), objects: ['sr2', 'net-lab', 'net-up', 'net-g1'] }],
    nets: { 'net-up': 'fleetwright-uplink', 'net-g1': 'fleetwright-group-1', 'net-other': 'fleetwright-group-2' },
  });
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const { begun } = await choosing(xo, setups, actor);
  const good = { v: 1, srs: ['sr2'], networks: ['net-lab'], egress: null, limits: { cpus: 2, memory: 4 * 1024 ** 3, disk: 50 * 1024 ** 3 } };
  const took = await setups.policy({ job: begun.xosetup.job, sealed: await choose(begun, xo.address, good), actor });
  assert.equal(took.ok, true, took.text);
  assert.equal((await finished(setups, begun.xosetup.job, actor)).state, 'done');
  assert.deepEqual(
    xo.calls.filter((c) => c.method === 'resourceSet.set').map((c) => c.params.objects),
    [['sr2', 'net-lab', 'net-up', 'net-g1']],
    'kept because they were in the set; a group network the set never had is not added by this',
  );
});

test('a policy for a pool that was never added changes nothing', { skip }, async (t) => {
  const xo = await standIn(t);
  const { setups } = await machine();
  const { state } = await choosing(xo, setups);
  assert.equal(state.state, 'failed');
  assert.equal(state.phase, 'choose');
  assert.match(state.text, /has not been added to the fleet yet/);
  assert.ok(!xo.calls.some((c) => /\.(create|set)$|^tag\./.test(c.method)));
});

test('a policy job cancelled, or left, while it waits changes nothing', { skip }, async (t) => {
  const xo = await standIn(t, { sets: [chosenBefore()] });
  const { setups } = await machine();
  const actor = 'eli@example.com';
  const { begun } = await choosing(xo, setups, actor);
  setups.cancel({ job: begun.xosetup.job, actor });
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'cancelled');
  assert.match(end.text, /before anything was changed/);

  const slow = await machine({ policyWaitMs: 50 });
  const left = await choosing(xo, slow.setups, actor);
  assert.equal(left.state.state, 'choosing');
  /** @type {any} */
  let gone;
  for (let i = 0; i < 100 && (!gone || gone.state === 'choosing'); i++) {
    await new Promise((r) => setTimeout(r, 10));
    gone = slow.setups.status({ job: left.begun.xosetup.job, actor }).xosetup;
  }
  assert.equal(gone.state, 'failed');
  assert.match(gone.text, /nobody chose within ten minutes\. Nothing was changed\./);
  assert.ok(!xo.calls.some((c) => c.method === 'resourceSet.set' || c.method.startsWith('tag.')));
});

test('a choice is held to what the pool has, and the way out to a network it listed', () => {
  const choices = {
    srs: new Map([['a', 100 * 1024 ** 3], ['b', 50 * 1024 ** 3]]),
    networks: new Set(['n1', 'n2']),
    capacity: { cpus: 8, memory: 32 * 1024 ** 3 },
  };
  const ok = { v: 1, srs: ['a'], networks: ['n1'], egress: 'n1', limits: { cpus: 2, memory: 4 * 1024 ** 3, disk: 50 * 1024 ** 3 } };
  assert.equal(checkPolicy(ok, choices).ok, true);
  assert.equal(checkPolicy({ ...ok, egress: null }, choices).ok, true, 'no way out yet is a choice');
  // ASKED FOR: a way out the fleet's VMs may not use. The router's WAN is
  // the better for it, since no lab can attach there and skip the router.
  assert.equal(checkPolicy({ ...ok, egress: 'n2' }, choices).ok, true, 'any network the pool listed');
  const refused = [
    [{ ...ok, srs: [] }, /at least one storage/],
    [{ ...ok, egress: 'n3' }, /a network this pool listed/],
    [{ ...ok, limits: { ...ok.limits, cpus: 9 } }, /between 1 and 8/],
    [{ ...ok, limits: { ...ok.limits, cpus: 1.5 } }, /between 1 and 8/],
    [{ ...ok, limits: { ...ok.limits, memory: 512 * 1024 ** 2 } }, /between 1 GiB/],
    [{ ...ok, limits: { ...ok.limits, disk: 101 * 1024 ** 3 } }, /between 10 GiB and 100 GiB/],
    [{ ...ok, v: 2 }, /not a choice/],
  ];
  for (const [p, words] of refused) {
    const r = checkPolicy(p, choices);
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.match(/** @type {any} */ (r).text, /** @type {RegExp} */ (words));
  }
  assert.equal(checkPolicy(ok, null).ok, false, 'nothing to check it against is a refusal');

  // THE MACHINE IMAGE is built behind the edge router, on the way out's pool:
  // with the router asked for, or where that pool already has one.
  const pooled = { ...choices, networkPools: new Map([['n1', 'p1'], ['n2', 'p2']]), edgePools: new Set(['p2']) };
  assert.equal(checkPolicy({ ...ok, image: true, edge: true }, pooled).ok, true);
  assert.equal(checkPolicy({ ...ok, image: true, egress: 'n2' }, pooled).ok, true, 'that pool has its router');
  assert.match(/** @type {any} */ (checkPolicy({ ...ok, image: true }, pooled)).text, /has none yet/);
  assert.match(/** @type {any} */ (checkPolicy({ ...ok, image: true, egress: null }, pooled)).text, /choose the way out/);
  // ASKED FOR: "os selection not just Debian". Any of the catalogue, together.
  const both = /** @type {any} */ (checkPolicy({ ...ok, images: ['ubuntu-24.04', 'debian-13', 'ubuntu-24.04'], edge: true }, pooled));
  assert.deepEqual(both.policy.images, ['ubuntu-24.04', 'debian-13']);
  assert.match(/** @type {any} */ (checkPolicy({ ...ok, images: ['windows-11'], edge: true }, pooled)).text, /cannot build/);
  // BUILT FROM MAIN OR FROM RELEASES, the apt suite an image built now
  // installs from; absent is as before, and nothing else is a suite.
  assert.equal(/** @type {any} */ (checkPolicy({ ...ok, image: true, edge: true, imageChannel: 'rolling' }, pooled)).policy.imageChannel, 'rolling');
  assert.equal(/** @type {any} */ (checkPolicy({ ...ok, image: true, edge: true }, pooled)).policy.imageChannel, null);
  assert.match(/** @type {any} */ (checkPolicy({ ...ok, image: true, edge: true, imageChannel: 'nightly' }, pooled)).text, /released versions or from the newest build of main/);
  const imaged = /** @type {any} */ (checkPolicy({ ...ok, image: true, edge: true, edgeSr: 'b' }, pooled));
  assert.equal(imaged.policy.image, true);
  assert.equal(imaged.policy.edgeSr, 'b', 'where the disks go');

  // REBUILT OR REMOVED, asked for: "There is no rebuild button or delete
  // button". Only an image the way out's pool has, and each one thing.
  const there = { ...pooled, edgePools: new Set(['p1']), imagesOn: new Map([['p1', new Set(['debian-13', 'ubuntu-24.04'])]]) };
  const changed = /** @type {any} */ (checkPolicy({ ...ok, rebuild: ['debian-13'], remove: ['ubuntu-24.04'], images: ['ubuntu-26.04'] }, there));
  assert.equal(changed.ok, true, changed.text);
  assert.deepEqual([changed.policy.rebuild, changed.policy.remove, changed.policy.images], [['debian-13'], ['ubuntu-24.04'], ['ubuntu-26.04']]);
  assert.deepEqual([/** @type {any} */ (checkPolicy(ok, there)).policy.rebuild, /** @type {any} */ (checkPolicy(ok, there)).policy.remove], [[], []], 'a phone that predates it keeps every image');
  for (const [p, words, against = there] of /** @type {Array<[any, RegExp, any?]>} */ ([
    [{ ...ok, rebuild: ['ubuntu-26.04'] }, /does not have/],
    [{ ...ok, remove: ['debian-13'], egress: 'n2' }, /does not have/],
    [{ ...ok, rebuild: ['debian-13'], remove: ['debian-13'] }, /one of those/],
    [{ ...ok, rebuild: ['debian-13'], images: ['debian-13'] }, /one of those/],
    [{ ...ok, remove: ['debian-13'], holder: true }, /Debian 13 image, so that one stays/],
    [{ ...ok, remove: 'debian-13' }, /a list of them/],
    [{ ...ok, rebuild: ['debian-13'], egress: null }, /choose the way out/],
    [{ ...ok, rebuild: ['debian-13'] }, /behind the edge router/, { ...there, edgePools: new Set() }],
  ])) {
    const r = /** @type {any} */ (checkPolicy(p, against));
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.match(r.text, words);
  }
  assert.deepEqual(currentLimits({ limits: { cpus: { total: 4 }, memory: 1024, disk: null } }), { cpus: 4, memory: 1024, disk: null });
});

test('a pair of edge routers is one edge to the phone, said to be a pair', { skip }, async (t) => {
  const xo = await standIn(t, {
    sets: [{ ...chosenBefore(), objects: ['sr2', 'net-lab'] }],
    vms: {
      a: { id: 'a', type: 'VM', $pool: 'p1', tags: ['fleetwright-edge', 'fleetwright-edge-updates', 'fleetwright-edge-node:0'], power_state: 'Running' },
      b: { id: 'b', type: 'VM', $pool: 'p1', tags: ['fleetwright-edge', 'fleetwright-edge-updates', 'fleetwright-edge-node:1'], power_state: 'Running' },
    },
  });
  const { setups } = await machine({ coordinatorUrl: 'https://fleet.test' });
  const { begun, reply, state } = await choosing(xo, setups, 'eli@example.com');
  const [epk, iv, ct] = state.inventory.split('.');
  const inventory = /** @type {any} */ (await open({ ...reply, aad: xosetupInventoryAad(begun.xosetup.job, xo.address), sealed: { epk, iv, ct } }));
  assert.equal(inventory.edges.length, 1, 'two routers would read as two edges in one pool');
  assert.equal(inventory.edges[0].ha, true);
  setups.cancel({ job: begun.xosetup.job, actor: 'eli@example.com' });
});

/** A key a router was built with, as buildEdge keeps it (edge-credentials.js). */
const WATCH = newWatch();

test('labs are made by the policy job, each its kind, kept in the set, and the edge already on them is left as it is', { skip }, async (t) => {
  // docs/hypervisors.md, "Labs". The edge is rebuilt when its labs change
  // (test/edge-router.test.js); here it already has these two.
  const xo = await standIn(t, {
    sets: [{ ...chosenBefore(), objects: ['sr2', 'net-lab', 'net-l1'] }],
    more: ['network.create', 'resourceSet.addObject', 'disk.import', 'vm.create', 'vm.attachDisk', 'vif.set', 'vm.start'],
    nets: { 'net-l1': 'fleetwright-lab-1', 'net-l2': 'fleetwright-lab-2' },
    vms: { edge: { id: 'edge', type: 'VM', $pool: 'p1', tags: ['fleetwright-edge', 'fleetwright-edge-updates', 'fleetwright-edge-watch', 'fleetwright-edge-labs:oc'], power_state: 'Running', xenStoreData: xenStoreAsXo({ [EDGE_WATCH.key]: JSON.stringify(WATCH) }) } },
    vifs: {
      w: { id: 'w', type: 'VIF', $VM: 'edge', device: '0', $network: 'net-dmz' },
      a: { id: 'a', type: 'VIF', $VM: 'edge', device: '2', $network: 'net-l1' },
      b: { id: 'b', type: 'VIF', $VM: 'edge', device: '3', $network: 'net-l2' },
    },
  });
  const { setups } = await machine({ coordinatorUrl: 'https://fleet.test' });
  const actor = 'eli@example.com';
  const { begun, reply, state } = await choosing(xo, setups, actor);
  const [epk, iv, ct] = state.inventory.split('.');
  const inventory = /** @type {any} */ (await open({ ...reply, aad: xosetupInventoryAad(begun.xosetup.job, xo.address), sealed: { epk, iv, ct } }));
  assert.deepEqual(inventory.edges[0].labs, { open: 1, closed: 1 }, 'the phone starts from the labs the edge has');
  assert.equal(inventory.edges[0].labsEach, null, 'labs from before labs per person were read as a limit');
  assert.equal(inventory.edges[0].ha, false, 'one router, said as one');
  assert.equal(inventory.labMax, 4);
  const good = { v: 1, srs: ['sr2'], networks: ['net-lab'], egress: 'net-dmz', edge: true, labs: { open: 1, closed: 1 }, labsEach: 1, limits: { cpus: 8, memory: 16 * 1024 ** 3, disk: 500 * 1024 ** 3 } };
  assert.equal((await setups.policy({ job: begun.xosetup.job, sealed: await choose(begun, xo.address, good), actor })).ok, true);
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.deepEqual(
    xo.calls.filter((c) => c.method === 'tag.add' && c.params.tag.startsWith('fleetwright-lab:')).map((c) => [c.params.id, c.params.tag]),
    [['net-l1', 'fleetwright-lab:open'], ['net-l2', 'fleetwright-lab:closed']],
  );
  // LABS PER PERSON, on each lab, where the box reads it with the fleet's token.
  assert.deepEqual(
    xo.calls.filter((c) => c.method === 'tag.add' && c.params.tag.startsWith('fleetwright-lab-each:')).map((c) => [c.params.id, c.params.tag]),
    [['net-l1', 'fleetwright-lab-each:1'], ['net-l2', 'fleetwright-lab-each:1']],
  );
  assert.match(end.text, /One person may hold one lab at once\./);
  assert.ok(xo.calls.some((c) => c.method === 'resourceSet.addObject' && c.params.object === 'net-l2'), 'the fleet may not put a machine on the new lab');
  const set = xo.calls.find((c) => c.method === 'resourceSet.set')?.params;
  assert.ok(set.objects.includes('net-l1'), 'a lab the phone did not list was taken out of the set');
  assert.ok(!xo.calls.some((c) => c.method === 'disk.import'), 'an edge already on those labs was rebuilt');
  assert.match(end.text, /with one open lab and one closed lab/);
  // THE KEY THE ROUTER HAS goes to the phone that ran the policy, sealed to
  // it, so its vault can hand it to the boxes that read the router.
  const [wEpk, wIv, wCt] = String(end.watch).split('.');
  const watch = /** @type {any} */ (await open({ ...reply, aad: xosetupWatchAad(begun.xosetup.job, xo.address), sealed: { epk: wEpk, iv: wIv, ct: wCt } }));
  assert.deepEqual(watch, { v: 1, address: xo.address, key: WATCH.key, secret: WATCH.secret, pin: WATCH.pin, routers: [{ name: 'fleetwright-edge', address: null }] });
});

test('labs are 0 to 4 in all, on the edge, and a phone that says nothing leaves them as they are', () => {
  const choices = {
    srs: new Map([['a', 100 * 1024 ** 3]]),
    networks: new Set(['n1', 'n2']),
    capacity: { cpus: 8, memory: 32 * 1024 ** 3 },
    networkPools: new Map([['n1', 'p1'], ['n2', 'p2']]),
    edgePools: new Set(['p1']),
  };
  const ok = { v: 1, srs: ['a'], networks: ['n1'], egress: 'n1', limits: { cpus: 2, memory: 4 * 1024 ** 3, disk: 50 * 1024 ** 3 } };
  assert.equal(/** @type {any} */ (checkPolicy(ok, choices)).policy.labs, null);
  assert.deepEqual(/** @type {any} */ (checkPolicy({ ...ok, labs: { open: 3, closed: 1 } }, choices)).policy.labs, { open: 3, closed: 1 });
  assert.deepEqual(/** @type {any} */ (checkPolicy({ ...ok, labs: { open: 0, closed: 0 } }, choices)).policy.labs, { open: 0, closed: 0 }, 'none is an answer: take them away');
  for (const labs of [{ open: 4, closed: 1 }, { open: -1, closed: 0 }, { open: 1.5, closed: 0 }, { open: '1', closed: 0 }, { open: 1 }, true]) {
    assert.match(/** @type {any} */ (checkPolicy({ ...ok, labs }, choices)).text ?? '', /Between 0 and 4 labs/, JSON.stringify(labs));
  }
  assert.match(/** @type {any} */ (checkPolicy({ ...ok, egress: null, labs: { open: 1, closed: 0 } }, choices)).text, /choose the way out/);
  assert.match(/** @type {any} */ (checkPolicy({ ...ok, egress: 'n2', labs: { open: 1, closed: 0 } }, choices)).text, /has none yet/);
  assert.equal(checkPolicy({ ...ok, egress: 'n2', edge: true, labs: { open: 1, closed: 0 } }, choices).ok, true, 'with the router asked for');

  // LABS PER PERSON: no limit, or 1 to as many labs as there will be, and
  // only with the labs; a phone that says nothing leaves it as it is.
  const labs = { open: 2, closed: 1 };
  const each = (/** @type {unknown} */ labsEach, more = {}) => /** @type {any} */ (checkPolicy({ ...ok, labs, labsEach, ...more }, choices));
  assert.equal(each(null).policy.labsEach, null);
  assert.equal(each(3).policy.labsEach, 3);
  assert.equal(Object.hasOwn(/** @type {any} */ (checkPolicy({ ...ok, labs }, choices)).policy, 'labsEach'), false, 'a phone that predates it changed the limit');
  for (const n of [0, 4, -1, 1.5, '2', true]) assert.match(each(n).text ?? '', /no limit, or 1 to 3, the labs there are/, JSON.stringify(n));
  assert.match(each(1, { labs: { open: 0, closed: 0 } }).text, /With no labs, labs per person is no limit/);
  assert.match(/** @type {any} */ (checkPolicy({ ...ok, labsEach: 1 }, choices)).text, /goes with the labs it limits/);
});

test('group networks are 0 to 4, in the way out’s pool, and a phone that says nothing asks for none', () => {
  const choices = { srs: new Map([['a', 100 * 1024 ** 3]]), networks: new Set(['n1']), capacity: { cpus: 8, memory: 32 * 1024 ** 3 } };
  const ok = { v: 1, srs: ['a'], networks: ['n1'], egress: 'n1', limits: { cpus: 2, memory: 4 * 1024 ** 3, disk: 50 * 1024 ** 3 } };
  assert.equal(/** @type {any} */ (checkPolicy(ok, choices)).policy.groups, 0);
  assert.equal(/** @type {any} */ (checkPolicy({ ...ok, groups: 4 }, choices)).policy.groups, 4);
  for (const groups of [5, -1, 1.5, '2', true]) {
    assert.match(/** @type {any} */ (checkPolicy({ ...ok, groups }, choices)).text ?? '', /Between 0 and 4/, String(groups));
  }
  assert.match(/** @type {any} */ (checkPolicy({ ...ok, groups: 1, egress: null }, choices)).text, /choose the way out/);
});

/**
 * A relay as a length of wire: each connection "through the phone" is a TCP
 * socket to the stand-in, which is what the phone makes, and the box is told
 * when a job has finished with it. The coordinator's half is
 * xo-relay-coordinator.test.js, and the whole path relay-end-to-end.test.js.
 *
 * @param {string} address
 */
function wire(address) {
  /** @type {string[]} */
  const opened = [];
  /** @type {string[]} */
  const done = [];
  const [host, port] = address.split(':');
  return {
    opened,
    done,
    open: async (/** @type {string} */ relay) => (opened.push(relay), net.connect(Number(port), host)),
    gone: (/** @type {string} */ relay) => done.push(relay),
  };
}

test('through a phone, the probe is HTTPS or nothing, and plain HTTP is refused before a job begins', { skip }, async (t) => {
  // NEVER OFFERED IN THE CLEAR: something answering without TLS through a
  // phone is said as that and is not reachable, so no screen offers to send
  // a password the phone and the fleet could read.
  const plainXo = await standIn(t, { plain: true });
  const through = await probe(plainXo.address, { through: wire(plainXo.address).open, timeoutMs: 4000 });
  assert.equal(through.reachable, false);
  assert.match(through.text, /through your phone, but not over HTTPS/);
  const xo = await standIn(t);
  const seen = await probe(xo.address, { through: wire(xo.address).open });
  assert.deepEqual([seen.reachable, seen.tls, seen.xo, seen.cert], [true, true, true, xo.pin]);
  assert.match(seen.text, /through your phone/);

  const relay = wire(xo.address);
  const { setups } = await machine({ relay: { open: relay.open, done: relay.gone } });
  const plain = await setups.begin({ address: xo.address, plain: 'accepted', relay: 'a'.repeat(24), actor: 'eli@example.com' });
  assert.equal(plain.ok, false);
  assert.match(plain.text, /carries only HTTPS/);
  // A box with no way to a phone says so rather than reaching on its own.
  const { setups: older } = await machine();
  assert.match((await older.begin({ address: xo.address, pin: xo.pin, relay: 'a'.repeat(24), actor: 'eli@example.com' })).text, /cannot work through a phone/);
  assert.equal(relay.opened.length, 0, 'nothing went through the phone for either');
});

test('through a phone, a policy makes the pool its own machine, and gigabyte builds are refused while it waits', { skip }, async (t) => {
  // THE FIRST MINUTE: the pool's own machine is made over the relay, and from
  // then on it reaches Xen Orchestra itself. The router and the image are
  // uploads of their own the relay does not carry, so they are refused and
  // the job keeps waiting for a choice without them.
  const xo = await standIn(t, {
    sets: [{ ...chosenBefore(), objects: [...chosenBefore().objects, 'tpl'] }],
    more: ['network.create', 'resourceSet.addObject', 'vm.create', 'vm.start', 'disk.import', 'vm.attachDisk', 'vif.set'],
    vms: { edge: { id: 'edge', type: 'VM', $pool: 'p1', tags: ['fleetwright-edge', 'fleetwright-edge-updates'], power_state: 'Running' } },
    templates: { tpl: { id: 'tpl', type: 'VM-template', name_label: 'Fleetwright Debian 13', $pool: 'p1', tags: ['fleetwright-image', 'fleetwright-image:debian-13'] } },
  });
  const relay = wire(xo.address);
  const R = 'b'.repeat(24);
  const { setups } = await machine({
    relay: { open: relay.open, done: relay.gone },
    coordinatorUrl: 'https://fleet.test',
    holderPin: async () => ({ ok: true, pin: '123456', hostId: 'holder-0a1b2c' }),
  });
  const actor = 'eli@example.com';
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', relay: R, actor });
  assert.equal(begun.ok, true, begun.text);
  const job = begun.xosetup.job;
  const reply = await newSealKey();
  const { sealed } = await phone(begun, xo.address, xo.pin, { v: 1, xo: { email: 'admin@admin.net', password: PASSWORD }, reply: reply.publicKey, purpose: 'policy' });
  assert.equal((await setups.run({ job, sealed, actor })).ok, true);
  for (let i = 0; i < 400 && setups.status({ job, actor }).xosetup?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(setups.status({ job, actor }).xosetup?.state, 'choosing');

  const choice = { v: 1, srs: ['sr1', 'sr2'], networks: ['net-lab'], egress: 'net-dmz', limits: { cpus: 8, memory: 16 * 1024 ** 3, disk: 500 * 1024 ** 3 } };
  // Labs too: they are interfaces on the edge router, which is built again.
  for (const big of [{ edge: true }, { images: ['debian-13'] }, { labs: { open: 1, closed: 0 } }]) {
    const refused = await setups.policy({ job, sealed: await choose(begun, xo.address, { ...choice, ...big }), actor });
    assert.equal(refused.ok, false, JSON.stringify(big));
    assert.match(refused.text, /gigabytes/);
    assert.equal(setups.status({ job, actor }).xosetup?.state, 'choosing', 'it goes on waiting');
  }
  const took = await setups.policy({ job, sealed: await choose(begun, xo.address, { ...choice, holder: true }), actor });
  assert.equal(took.ok, true, took.text);
  const end = await finished(setups, job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.match(end.text, /holder-0a1b2c is starting on dmz/);
  assert.ok(!xo.calls.some((c) => c.method === 'disk.import'), 'nothing was uploaded');
  // EVERY CONNECTION WENT THROUGH THE PHONE, and the relay was given up once.
  assert.equal(relay.opened.length, xo.connections());
  assert.deepEqual(relay.done, [R]);
});

// --- reconnecting a pool's servers -------------------------------------------
//
// ASKED FOR: "When Xen shows no pool, reconnecting all hosts usually fixes it.
// Why don't we do it instead of me logging in?" One tap and Face ID on the
// phone, which seals the kept admin sign-in to one job here. The servers are
// the stand-in's, behaving as xo-server's xen-servers.mjs does; the clock is
// the test's, so three minutes of waiting and ten of holding a session are
// times, not counts of looks, and take none of the suite's.

/** A clock the job waits on: a pause moves it on and returns at once. */
function clock() {
  let t = 1_800_000_000_000;
  /** @type {Array<(ms: number) => void>} */
  const onPause = [];
  return {
    now: () => t,
    sleep: async (/** @type {number} */ ms) => {
      t += ms;
      for (const f of onPause) f(ms);
      await new Promise((r) => setImmediate(r));
    },
    onPause,
    get elapsed() {
      return t - 1_800_000_000_000;
    },
  };
}

/**
 * What the phone seals for a reconnect: the admin sign-in, the purpose, and a
 * key for the answer, under the reconnect's own binding, or under the
 * setup's as a phone not yet updated does.
 */
async function reconnecting(/** @type {any} */ xo, /** @type {XoSetups} */ setups, /** @type {string} */ actor, aad = xosetupReconnectSigninAad) {
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
  assert.equal(begun.ok, true, begun.text);
  const reply = await newSealKey();
  const { sealed } = await phone(begun, xo.address, xo.pin, { v: 1, purpose: 'reconnect', xo: { email: 'admin@admin.net', password: PASSWORD }, reply: reply.publicKey }, aad);
  const ran = await setups.run({ job: begun.xosetup.job, sealed, actor });
  assert.equal(ran.ok, true, ran.text);
  assert.equal(ran.text, `Reconnecting the servers of ${xo.address}.`);
  return { begun, reply, job: begun.xosetup.job };
}

/** The per-server account the phone opens, under the reconnect's own binding. */
async function account(/** @type {any} */ end, /** @type {any} */ reply, /** @type {string} */ address) {
  const [epk, iv, ct] = String(end.result).split('.');
  return /** @type {any} */ (await open({ ...reply, aad: xosetupReconnectAad(end.job, address), sealed: { epk, iv, ct } }));
}

/** Every connection the job opened is closed again: the admin session went with it. */
async function letGo(/** @type {any} */ xo) {
  for (let i = 0; i < 200 && xo.live() > 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(xo.live(), 0, 'the admin session was closed');
}

/** A server of Xen Orchestra's, as the stand-in plays it. @param {string} id @param {Record<string, any>} [extra] */
const xenServer = (id, extra = {}) => ({ id, label: `Rack ${id}`, host: `10.0.0.${id.charCodeAt(0) - 96}`, status: 'connected', enabled: true, poolId: `pool-${id}`, poolName: `Pool ${id.toUpperCase()}`, ...extra });

/** How many times each server was asked to do something. @param {any} xo @param {string} method */
const asked = (xo, method) => xo.calls.filter((/** @type {any} */ c) => c.method === method).map((/** @type {any} */ c) => c.params.id);

test('a reconnect leaves a connected server, enables a disconnected one, cycles one stuck or erroring, and leaves one a person turned off', { skip }, async (t) => {
  const xo = await standIn(t, {
    servers: [
      xenServer('a'),
      xenServer('b', { status: 'disconnected', error: { code: 'ECONNRESET', message: 'socket hang up' } }),
      // Stuck: it takes two looks to let go once disabled, and Xen Orchestra
      // is still busy with an attempt of its own for the first two enables.
      xenServer('c', { status: 'connecting', linger: 2, busy: 2 }),
      xenServer('d', { error: { message: 'the event loop stopped' } }),
      xenServer('e', { status: 'disconnected', enabled: false }),
    ],
  });
  const c = clock();
  const { setups, events } = await machine({ now: c.now, sleep: c.sleep });
  const actor = 'eli@example.com';
  const { reply, job } = await reconnecting(xo, setups, actor);
  const end = await finished(setups, job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.equal(end.of, XORECONNECT_STEPS.length);

  // ONE AT A TIME, each as its state asks, and the stuck one's enable asked
  // again while Xen Orchestra was still connecting it.
  assert.deepEqual(asked(xo, 'server.enable'), ['b', 'c', 'c', 'c', 'd']);
  assert.deepEqual(asked(xo, 'server.disable'), ['c', 'd']);
  assert.equal(c.elapsed, 3 * 2_000, 'two seconds before each try again, and no wait once the pools showed');

  // WHAT BECAME OF EACH, for the phone alone, under its own binding.
  const said = await account(end, reply, xo.address);
  assert.deepEqual(said.servers, [
    { label: 'Rack a', host: '10.0.0.1', before: 'connected', enabled: true, after: 'connected', action: 'left' },
    { label: 'Rack b', host: '10.0.0.2', before: 'disconnected', enabled: true, after: 'connected', action: 'enabled' },
    { label: 'Rack c', host: '10.0.0.3', before: 'connecting', enabled: true, after: 'connected', action: 'cycled' },
    { label: 'Rack d', host: '10.0.0.4', before: 'connected', enabled: true, after: 'connected', action: 'cycled' },
    { label: 'Rack e', host: '10.0.0.5', before: 'disconnected', enabled: false, after: 'disconnected', action: 'skipped-disabled' },
  ]);
  assert.deepEqual(said.pools.map((/** @type {any} */ p) => p.id).sort(), ['pool-a', 'pool-b', 'pool-c', 'pool-d']);
  assert.equal(said.v, 1);
  const [epk, iv, ct] = end.result.split('.');
  await assert.rejects(open({ ...reply, aad: xosetupHandoffAad(job, xo.address), sealed: { epk, iv, ct } }), 'not under a setup’s binding');
  await assert.rejects(open({ ...reply, aad: xosetupReconnectAad(job, 'elsewhere.lan'), sealed: { epk, iv, ct } }), 'nor for another address');

  // WHAT THE COORDINATOR CARRIES is counts and the address: no server's
  // name, no pool master's address, no password.
  assert.equal(end.text, `4 of 5 servers are connected again; Xen Orchestra at ${xo.address} shows 4 pools. One server is turned off in Xen Orchestra and was left that way.`);
  const relayed = JSON.stringify({ events, end: { ...end, result: undefined } });
  for (const secret of ['Rack ', '10.0.0.', 'Pool A', PASSWORD]) assert.ok(!relayed.includes(secret), secret);
  // FROM `servers` ON, said as a reconnect's.
  assert.deepEqual(events.map((e) => [e.phase, e.state, e.purpose]), [['servers', 'running', 'reconnect'], ['reconnect', 'running', 'reconnect'], ['wait', 'running', 'reconnect'], ['done', 'done', 'reconnect']]);
  assert.ok(!xo.calls.some((/** @type {any} */ c) => /^(user|token|resourceSet)\./.test(c.method)), 'nothing else is changed');
  assert.ok(!JSON.stringify([...setups.jobs.values()]).includes(PASSWORD), 'the job kept no copy of the sign-in');
  await letGo(xo);
});

test('a server the pool master refuses, or whose pool is already connected, is said and not tried again; one Xen Orchestra stays busy with is tried for half a minute', { skip }, async (t) => {
  const xo = await standIn(t, {
    servers: [
      xenServer('f', { status: 'disconnected', refuse: 'auth' }),
      xenServer('g', { status: 'connecting', refuse: 'pool' }),
      xenServer('h', { status: 'connecting', busy: 1000 }),
    ],
  });
  const c = clock();
  const { setups } = await machine({ now: c.now, sleep: c.sleep });
  const actor = 'eli@example.com';
  const { reply, job } = await reconnecting(xo, setups, actor);
  const end = await finished(setups, job, actor);
  assert.equal(end.state, 'failed');
  assert.equal(end.text, `0 of 3 servers are connected; Xen Orchestra at ${xo.address} shows no pools. 3 could not be reconnected; which and why are on your phone.`);
  const enables = asked(xo, 'server.enable');
  assert.deepEqual([enables.filter((x) => x === 'f').length, enables.filter((x) => x === 'g').length], [1, 1], 'the two Xen Orchestra will not retry are asked once');
  assert.equal(enables.filter((x) => x === 'h').length, 16, 'every two seconds for half a minute, and then no more');
  const said = await account(end, reply, xo.address);
  const [f, g, h] = said.servers;
  assert.equal(f.action, 'failed');
  assert.match(f.error, /refused the user name and password .*SESSION_AUTHENTICATION_FAILED/);
  assert.equal(g.action, 'failed');
  assert.match(g.error, /already has this pool connected .*PoolAlreadyConnected/);
  assert.doesNotMatch(g.error, /turned off/, 'its enable got as far as turning it back on');
  // TURNED OFF TO BE CYCLED, and never back on: said, read back from Xen
  // Orchestra rather than assumed.
  assert.equal(h.action, 'failed');
  assert.match(h.error, /still busy connecting it after 30 seconds\. It is turned off in Xen Orchestra now; turn it on there/);
  assert.equal(h.after, 'disconnected');
  await letGo(xo);
});

test('a reconnect waits three minutes for the pools and no longer, and still hands back what it did', { skip }, async (t) => {
  const xo = await standIn(t, { servers: [xenServer('b', { status: 'disconnected', slow: Infinity })] });
  const c = clock();
  const { setups, events } = await machine({ now: c.now, sleep: c.sleep });
  const actor = 'eli@example.com';
  const { reply, job } = await reconnecting(xo, setups, actor);
  const end = await finished(setups, job, actor);
  assert.equal(end.state, 'failed');
  assert.equal(end.text, `After three minutes, 0 of 1 server is connected; Xen Orchestra at ${xo.address} shows no pools.`);
  assert.equal(c.elapsed, 3 * 60_000, 'a look every five seconds for three minutes');
  assert.equal(xo.calls.filter((/** @type {any} */ x) => x.method === 'server.getAll').length, 1 + 37);
  const said = await account(end, reply, xo.address);
  assert.deepEqual(said.servers.map((/** @type {any} */ s) => [s.action, s.after]), [['enabled', 'connecting']]);
  assert.deepEqual(said.pools, []);
  assert.deepEqual(events.at(-1), { event: 'xosetup.progress', job, step: 4, of: 5, phase: 'wait', state: 'failed', text: end.text, purpose: 'reconnect' });
  await letGo(xo);
});

test('every server already connected changes nothing and says so', { skip }, async (t) => {
  const xo = await standIn(t, { servers: [xenServer('a'), xenServer('b')] });
  const c = clock();
  const { setups } = await machine({ now: c.now, sleep: c.sleep });
  const actor = 'eli@example.com';
  const { reply, job } = await reconnecting(xo, setups, actor);
  const end = await finished(setups, job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.equal(end.text, `All 2 servers of Xen Orchestra at ${xo.address} were already connected, so nothing was changed; it shows 2 pools.`);
  assert.ok(!xo.calls.some((/** @type {any} */ x) => x.method === 'server.enable' || x.method === 'server.disable'));
  assert.equal(c.elapsed, 0);
  assert.deepEqual((await account(end, reply, xo.address)).servers.map((/** @type {any} */ s) => s.action), ['left', 'left']);
  await letGo(xo);
});

test('a reconnect cancelled while it waits stops there, and one that would outrun ten minutes stops before a server it could not finish', { skip }, async (t) => {
  const actor = 'eli@example.com';
  {
    const xo = await standIn(t, { servers: [xenServer('b', { status: 'disconnected', slow: Infinity })] });
    const c = clock();
    const { setups } = await machine({ now: c.now, sleep: c.sleep });
    const { reply, job } = await reconnecting(xo, setups, actor);
    c.onPause.push(() => {
      if (c.elapsed === 15_000) setups.cancel({ job, actor });
    });
    const end = await finished(setups, job, actor);
    assert.equal(end.state, 'cancelled');
    assert.match(end.text, /^Cancelled while reconnecting the servers\. What was already asked of Xen Orchestra stands/);
    assert.equal(c.elapsed, 15_000, 'at the next pause, not three minutes later');
    assert.deepEqual((await account(end, reply, xo.address)).servers.map((/** @type {any} */ s) => s.action), ['enabled']);
    await letGo(xo);
  }
  {
    // Each of these takes a minute of the job's clock: half of it waiting
    // to let go, half asking again to be enabled. A cycle is begun only with
    // room for the longest it could take, every call waiting the minute the
    // connection waits for one, which is about six: so four are begun, at
    // nought, one, two and three minutes, and not a fifth at four.
    const many = 'ijklmnopqrst'.split('');
    const xo = await standIn(t, { servers: many.map((id) => xenServer(id, { status: 'connecting', linger: 1000, busy: 1000 })) });
    const c = clock();
    const { setups } = await machine({ now: c.now, sleep: c.sleep });
    const { reply, job } = await reconnecting(xo, setups, actor);
    const end = await finished(setups, job, actor);
    assert.equal(end.state, 'failed');
    assert.match(end.text, /^It stopped at the ten minutes this machine holds an admin session for, before any server it had no time to finish\. Which servers were touched is on your phone\.$/);
    assert.ok(c.elapsed <= 10 * 60_000, `held for ${c.elapsed / 1000} seconds`);
    const actions = (await account(end, reply, xo.address)).servers.map((/** @type {any} */ s) => s.action);
    const begun = actions.filter((a) => a === 'failed').length;
    assert.equal(begun, 4, actions.join());
    assert.deepEqual(actions.slice(begun), Array(many.length - begun).fill('left'), 'the rest were never touched');
    assert.equal(new Set(asked(xo, 'server.disable')).size, begun, 'no server was turned off that there was no time to turn on again');
    await letGo(xo);
  }
  {
    // Cancelled while it was still reaching Xen Orchestra: before the sign-in.
    const xo = await standIn(t, { servers: [xenServer('b', { status: 'disconnected' })] });
    const c = clock();
    const { setups } = await machine({ now: c.now, sleep: c.sleep });
    const { job } = await reconnecting(xo, setups, actor);
    setups.cancel({ job, actor });
    const end = await finished(setups, job, actor);
    assert.equal(end.state, 'cancelled');
    assert.equal(end.text, 'Cancelled before Signing in. Nothing was changed.');
    assert.equal(end.result, undefined);
    assert.ok(!xo.calls.some((/** @type {any} */ x) => x.method === 'session.signIn'), 'the sign-in was never sent');
    await letGo(xo);
  }
});

test('ten minutes after a reconnect began, its admin session is closed under whatever it is waiting on', { skip }, async (t) => {
  // THE CLOCK ON THE WALL, not the job's: a timer the job cannot be busy
  // through. Everything else here waits on setImmediate, because setTimeout
  // is the test's from now on.
  const xo = await standIn(t, { servers: [xenServer('b', { status: 'disconnected', slow: Infinity })] });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const turn = () => new Promise((r) => setImmediate(r));
  /** Turns until `done` says so, for at most five seconds of the real clock. @param {() => boolean} done */
  const until = async (done) => {
    for (const t0 = performance.now(); !done() && performance.now() - t0 < 5_000;) await turn();
  };
  /** @type {(() => void)|null} */
  let parked = null;
  const { setups } = await machine({ sleep: () => new Promise((r) => { parked = () => r(undefined); }) });
  const actor = 'eli@example.com';
  const { reply, job } = await reconnecting(xo, setups, actor);
  await until(() => parked !== null);
  assert.ok(parked, 'the job is waiting for the pools');
  t.mock.timers.tick(10 * 60_000);
  /** @type {() => void} */ (parked)();
  /** @type {any} */
  let end;
  await until(() => (end = setups.status({ job, actor }).xosetup).state !== 'running');
  assert.equal(end.state, 'failed');
  assert.match(end.text, /^It stopped at the ten minutes this machine holds an admin session for/);
  assert.deepEqual((await account(end, reply, xo.address)).servers.map((/** @type {any} */ s) => s.action), ['enabled']);
  await until(() => xo.live() === 0);
  assert.equal(xo.live(), 0, 'the admin session was closed');
});

test('a reconnect whose account cannot be sealed, or whose listener throws, still ends, and the journal says why', { skip }, async (t) => {
  // A KEY THAT LOOKS LIKE ONE and is not a point on the curve, and a sidecar
  // whose listener throws: neither may leave the job running, or become a
  // rejection nobody catches in the process that holds every pool's token.
  const xo = await standIn(t, { servers: [xenServer('a')] });
  /** @type {string[]} */
  const journal = [];
  const c = clock();
  const { setups } = await machine({ now: c.now, sleep: c.sleep, log: { info() {}, warn: (/** @type {string} */ m) => journal.push(m) }, onEnd: () => { throw new Error('the listener broke'); } });
  const actor = 'eli@example.com';
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
  const { sealed } = await phone(begun, xo.address, xo.pin, { v: 1, purpose: 'reconnect', xo: { email: 'admin@admin.net', password: PASSWORD }, reply: 'B'.repeat(87) });
  assert.equal((await setups.run({ job: begun.xosetup.job, sealed, actor })).ok, true);
  const end = await finished(setups, begun.xosetup.job, actor);
  assert.equal(end.state, 'done', end.text);
  assert.equal(end.result, undefined);
  for (let i = 0; i < 100 && journal.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(journal.some((m) => /could not seal what it did to the servers/.test(m)), journal.join('\n'));
  assert.ok(journal.some((m) => /telling the sidecar failed: the listener broke/.test(m)), journal.join('\n'));
  await letGo(xo);
});

test('a reconnect is refused before anything changes where Xen Orchestra cannot, has no servers, or the account is not an admin', { skip }, async (t) => {
  const actor = 'eli@example.com';
  for (const [opts, phase, words, reported] of /** @type {Array<[any, string, RegExp, boolean]>} */ ([
    [{ servers: [xenServer('b', { status: 'disconnected' })], drop: ['server.enable'] }, 'servers', /does not offer server\.enable, so its servers cannot be reconnected from here\. Nothing was changed\./, true],
    [{ servers: [] }, 'servers', /no servers to reconnect/, true],
    // Before `servers`, nothing is reported: the person is looking at it.
    [{ servers: [xenServer('b', { status: 'disconnected' })], admin: false }, 'sign-in', /not a Xen Orchestra admin, and reconnecting its servers needs one/, false],
  ])) {
    const xo = await standIn(t, opts);
    const c = clock();
    const { setups, events } = await machine({ now: c.now, sleep: c.sleep });
    const { job } = await reconnecting(xo, setups, actor);
    const end = await finished(setups, job, actor);
    assert.equal(end.state, 'failed');
    assert.equal(end.phase, phase);
    assert.match(end.text, words);
    assert.equal(end.result, undefined, 'nothing was done, so there is nothing to hand back');
    assert.equal(events.length > 0, reported);
    assert.ok(!xo.calls.some((/** @type {any} */ x) => x.method === 'server.enable' || x.method === 'server.disable'));
    await letGo(xo);
  }
});

test('the ten minutes running out in the middle of a cycle wait for it to end, so the server is turned on again before the session closes', { skip }, async (t) => {
  // Stuck connecting, and three looks letting go once disabled: the time
  // runs out at the first pause after the disable, which is the middle.
  const servers = [xenServer('c', { status: 'connecting', linger: 3 })];
  const xo = await standIn(t, { servers });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const turn = () => new Promise((r) => setImmediate(r));
  let ticked = false;
  const { setups } = await machine({
    sleep: async () => {
      if (!ticked) {
        ticked = true;
        t.mock.timers.tick(10 * 60_000);
      }
      await turn();
    },
  });
  const actor = 'eli@example.com';
  const { reply, job } = await reconnecting(xo, setups, actor);
  /** @type {any} */
  let end;
  for (const t0 = performance.now(); (end = setups.status({ job, actor }).xosetup).state === 'running' && performance.now() - t0 < 5_000;) await turn();
  assert.ok(ticked, 'the ten minutes ran out during the cycle');
  assert.equal(end.state, 'failed');
  assert.match(end.text, /^It stopped at the ten minutes this machine holds an admin session for/);
  assert.deepEqual([asked(xo, 'server.disable'), asked(xo, 'server.enable')], [['c'], ['c']]);
  assert.deepEqual([servers[0].enabled, servers[0].status], [true, 'connected'], 'turned on again, not left off for a later reconnect to take for a person’s choice');
  assert.deepEqual((await account(end, reply, xo.address)).servers.map((/** @type {any} */ s) => s.action), ['cycled']);
  for (const t0 = performance.now(); xo.live() > 0 && performance.now() - t0 < 5_000;) await turn();
  assert.equal(xo.live(), 0, 'the admin session was closed once the cycle ended');
});

test('a cycle that fails after its disable asks for the enable once, and one whose connection is gone is said to be turned off by this job', { skip }, async (t) => {
  const actor = 'eli@example.com';
  {
    // The look after the disable is refused, and the session is still there.
    const servers = [xenServer('c', { status: 'connecting', stumble: true })];
    const xo = await standIn(t, { servers });
    const c = clock();
    const { setups } = await machine({ now: c.now, sleep: c.sleep });
    const { reply, job } = await reconnecting(xo, setups, actor);
    const end = await finished(setups, job, actor);
    assert.deepEqual(asked(xo, 'server.enable'), ['c']);
    assert.equal(servers[0].enabled, true, 'turned on again');
    const [said] = (await account(end, reply, xo.address)).servers;
    assert.equal(said.action, 'failed');
    assert.equal(said.error, 'the event loop was busy');
    await letGo(xo);
  }
  {
    // The connection ends as soon as the disable has answered.
    const servers = [xenServer('c', { status: 'connecting', cut: true })];
    const xo = await standIn(t, { servers });
    const c = clock();
    const { setups } = await machine({ now: c.now, sleep: c.sleep });
    const { reply, job } = await reconnecting(xo, setups, actor);
    const end = await finished(setups, job, actor);
    assert.equal(end.state, 'failed');
    assert.equal(servers[0].enabled, false, 'off, and nothing here can reach Xen Orchestra to say otherwise');
    const [said] = (await account(end, reply, xo.address)).servers;
    assert.equal(said.action, 'failed', 'never left, connected already');
    assert.match(said.error, /\. This job turned it off to reconnect it and could not turn it on again, so it may be turned off in Xen Orchestra now; turn it on there$/);
    await letGo(xo);
  }
});

test('a reconnect’s sign-in opens under its own binding only as a reconnect, a phone not yet updated still reconnects, and a purpose this machine does not know starts nothing', { skip }, async (t) => {
  const actor = 'eli@example.com';
  // A PHONE NOT YET UPDATED seals under the setup's binding, and this
  // machine, which knows a reconnect, runs it as one and as nothing more.
  {
    const servers = [xenServer('b', { status: 'disconnected' })];
    const xo = await standIn(t, { servers });
    const c = clock();
    const { setups } = await machine({ now: c.now, sleep: c.sleep });
    const { job } = await reconnecting(xo, setups, actor, xosetupAad);
    const end = await finished(setups, job, actor);
    assert.equal(end.state, 'done', end.text);
    assert.deepEqual(asked(xo, 'server.enable'), ['b']);
    assert.ok(!xo.calls.some((/** @type {any} */ x) => /^(user|token|resourceSet|plugin)\./.test(x.method)), 'no part of a setup');
    await letGo(xo);
  }
  for (const [aad, purpose] of /** @type {Array<[typeof xosetupAad, string|undefined]>} */ ([
    [xosetupReconnectSigninAad, undefined],
    [xosetupReconnectSigninAad, 'policy'],
    [xosetupReconnectSigninAad, 'rebuild'],
    [xosetupAad, 'rebuild'],
    // And a policy change's own binding opens only a policy change.
    [xosetupPolicySigninAad, undefined],
    [xosetupPolicySigninAad, 'reconnect'],
    [xosetupPolicySigninAad, 'rebuild'],
  ])) {
    const xo = await standIn(t, { servers: [xenServer('b', { status: 'disconnected' })] });
    const { setups } = await machine();
    const begun = await setups.begin({ address: xo.address, pin: xo.pin, trust: 'accepted', actor });
    const reply = await newSealKey();
    const { sealed } = await phone(begun, xo.address, xo.pin, { v: 1, ...(purpose ? { purpose } : {}), xo: { email: 'admin@admin.net', password: PASSWORD }, reply: reply.publicKey }, aad);
    const ran = await setups.run({ job: begun.xosetup.job, sealed, actor });
    const which = `${aad === xosetupAad ? 'setup' : aad === xosetupPolicySigninAad ? 'policy-signin' : 'reconnect-signin'} / ${purpose}`;
    assert.equal(ran.ok, false, which);
    assert.match(ran.text, /^The sign-in was sealed for a kind of job this machine does not run, so nothing was started\./, which);
    assert.equal(ran.xosetup?.state, 'failed', `${which}: the job is over and its key spent`);
    assert.equal((await setups.run({ job: begun.xosetup.job, sealed, actor })).text, 'That setup has already been given its sign-in.', which);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(xo.connections(), 0, `${which}: Xen Orchestra was never reached`);
  }
});
