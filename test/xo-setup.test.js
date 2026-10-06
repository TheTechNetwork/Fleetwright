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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { probe, XoSetups, limitsFrom, STEP_WORDS, FLEET_USER, checkPolicy, currentLimits } from '../src/fleet/host/xo-setup.js';
import { frame, parseFrame } from '../src/fleet/host/xo-ws.js';
import { XOSETUP_STEPS, XOPOLICY_STEPS } from '../src/fleet/protocol/intents.js';
import { seal, open, newSealKey, xosetupAad, xosetupHandoffAad, xosetupInventoryAad, xosetupPolicyAad } from '../src/fleet/seal.js';
import { generateKeyPair, sign, verify, signingInput, fingerprint } from '../src/fleet/crypto.js';

const openssl = spawnSync('openssl', ['version']).status === 0;
const skip = !openssl && 'needs openssl to make a certificate for the stand-in';
const PASSWORD = 'correct-horse-battery-staple-9';

/** A certificate and key for this run only, and the pin a phone would accept. */
function certificate() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xo-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=xo.test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const pem = readFileSync(cert, 'utf8');
  return { key: readFileSync(key, 'utf8'), cert: pem, pin: createHash('sha256').update(new X509Certificate(pem).raw).digest('hex') };
}

/**
 * A stand-in Xen Orchestra: HTML on `/`, JSON-RPC on `/api/`. Records every
 * call, per connection, so a test can say what was asked and as whom.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ admin?: boolean, drop?: string[], plugin?: any, maxTokenMs?: number, plain?: boolean, sets?: any[] }} [opts]
 */
async function standIn(t, { admin = true, drop = [], plugin = { id: 'installer-updates', loaded: false, autoload: false, configuration: {} }, maxTokenMs = 0.5 * 365.25 * 24 * 60 * 60_000, plain = false, sets: given = [], more = /** @type {string[]} */ ([]), vms = /** @type {Record<string, any>} */ ({}) } = {}) {
  const { key, cert, pin } = certificate();
  /** @type {Array<{ conn: number, method: string, params: any, as: string|null }>} */
  const calls = [];
  const users = /** @type {any[]} */ ([{ id: 'u-admin', email: 'admin@admin.net', permission: admin ? 'admin' : 'none' }]);
  const sets = /** @type {any[]} */ (given);
  /** @type {Map<string, string[]>} the tags each network carries, as tag.add and tag.remove leave them */
  const tags = new Map([['net-mgmt', ['fleetwright-egress']], ['net-lab', []], ['net-dmz', []]]);
  const passwords = new Map([['admin@admin.net', PASSWORD]]);
  const methods = Object.fromEntries(
    ['session.signIn', 'system.getMethodsInfo', 'xo.getAllObjects', 'user.getAll', 'user.create', 'user.set', 'resourceSet.getAll', 'resourceSet.create', 'resourceSet.set', 'token.create', 'plugin.get', 'plugin.load', 'plugin.enableAutoload', 'plugin.configure', 'tag.add', 'tag.remove']
      .concat(more)
      .filter((m) => !drop.includes(m))
      .map((m) => [m, {}]),
  );
  const objects = {
    pool: { p1: { id: 'p1', type: 'pool', name_label: 'Home', default_SR: 'sr1' } },
    host: { h1: { id: 'h1', type: 'host', cpus: { cores: 16 }, memory: { size: 64 * 1024 ** 3 } } },
    SR: {
      sr1: { id: 'sr1', type: 'SR', name_label: 'Local storage', $pool: 'p1', size: 1000 * 1024 ** 3, physical_usage: 200 * 1024 ** 3, content_type: 'user', shared: false },
      sr2: { id: 'sr2', type: 'SR', name_label: 'NFS', $pool: 'p1', size: 4000 * 1024 ** 3, physical_usage: 1000 * 1024 ** 3, content_type: 'user', shared: true },
      iso: { id: 'iso', type: 'SR', name_label: 'ISOs', $pool: 'p1', size: 50 * 1024 ** 3, physical_usage: 10 * 1024 ** 3, content_type: 'iso', shared: true },
    },
    get network() {
      return Object.fromEntries(['net-mgmt', 'net-lab', 'net-dmz'].map((id, i) => [id, { id, type: 'network', name_label: ['Pool-wide network associated with eth0', 'lab', 'dmz'][i], $pool: 'p1', tags: [...(tags.get(id) ?? [])] }]));
    },
    PIF: {
      pif1: { id: 'pif1', type: 'PIF', $network: 'net-mgmt', vlan: -1 },
      pif2: { id: 'pif2', type: 'PIF', $network: 'net-dmz', vlan: 30 },
    },
    VM: vms,
  };
  let conns = 0;
  /** @param {import('node:net').Socket} socket */
  const serve = (socket) => {
    const conn = ++conns;
    /** @type {string|null} */
    let as = null;
    let buf = Buffer.alloc(0);
    let upgraded = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = buf.subarray(0, end).toString('latin1');
        buf = buf.subarray(end + 4);
        if (head.startsWith('GET /api/')) {
          const k = /sec-websocket-key: (.+)/i.exec(head)?.[1]?.trim() ?? '';
          const accept = createHash('sha1').update(k + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
          upgraded = true;
          // A notification before any answer, the way Xen Orchestra pushes object changes.
          socket.write(frame(0x1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'all', params: {} })), { mask: false }));
        } else {
          socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n<html><head><title>Xen Orchestra</title></head></html>');
          return;
        }
      }
      for (;;) {
        const f = parseFrame(buf);
        if (!f || f === 'too-big') return;
        buf = buf.subarray(f.length);
        if (f.opcode === 0x8) return void socket.end();
        const msg = JSON.parse(f.payload.toString('utf8'));
        calls.push({ conn, method: msg.method, params: msg.params, as });
        /** @param {any} result */
        const answer = (result) => socket.write(frame(0x1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })), { mask: false }));
        /** @param {string} message */
        const refuse = (message) => socket.write(frame(0x1, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: 1, message } })), { mask: false }));
        const p = msg.params || {};
        switch (msg.method) {
          case 'session.signIn': {
            const u = users.find((x) => x.email === p.email);
            if (!u || passwords.get(p.email) !== p.password) refuse('invalid credentials');
            else {
              as = u.email;
              answer(u);
            }
            break;
          }
          case 'system.getMethodsInfo': answer(methods); break;
          case 'xo.getAllObjects': answer(/** @type {any} */ (objects)[p.filter?.type] ?? {}); break;
          case 'user.getAll': answer(users); break;
          case 'user.create': {
            const u = { id: `u-${users.length}`, email: p.email, permission: p.permission };
            users.push(u);
            passwords.set(p.email, p.password);
            answer(u.id);
            break;
          }
          case 'user.set': passwords.set(users.find((x) => x.id === p.id)?.email, p.password); answer(true); break;
          case 'resourceSet.getAll': answer(sets); break;
          case 'resourceSet.create': {
            const set = { id: `rs-${sets.length}`, ...p };
            sets.push(set);
            answer(set);
            break;
          }
          case 'resourceSet.set': {
            const set = sets.find((x) => x.id === p.id);
            if (set) Object.assign(set, p);
            answer(true);
            break;
          }
          case 'network.create': answer('net-uplink'); break;
          case 'tag.add': tags.set(p.id, [...(tags.get(p.id) ?? []), p.tag]); answer(true); break;
          case 'tag.remove': tags.set(p.id, (tags.get(p.id) ?? []).filter((x) => x !== p.tag)); answer(true); break;
          case 'token.create':
            // Xen Orchestra's own cap, and the words a limited user is given for going over it.
            if (p.expiresIn !== undefined && p.expiresIn > maxTokenMs) refuse('unknown error from the peer');
            else answer(as === FLEET_USER ? 'tok-limited-123' : 'tok-WRONG-USER');
            break;
          case 'plugin.get': answer(plugin ? [plugin] : []); break;
          default: answer(true);
        }
      }
    });
  };
  // PLAIN HTTP is the installer's default; the same stand-in, without TLS.
  const server = plain ? net.createServer(serve) : tls.createServer({ key, cert }, serve);
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => server.close());
  const address = `127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return { address, pin, calls, users, sets, tags };
}

/** A machine with an enrolment key, collecting what it reports. */
async function machine(/** @type {{ policyWaitMs?: number, coordinatorUrl?: string, buildImage?: any }} */ opts = {}) {
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
async function phone(/** @type {any} */ begun, /** @type {string} */ address, /** @type {string} */ pin, payload = /** @type {any} */ (null)) {
  const { job, key, keySig, hostKey } = begun.xosetup;
  const signed = await verify(hostKey, keySig, signingInput('xosetup-key', { address, job, key, pin }));
  const reply = await newSealKey();
  const inside = payload ?? { v: 1, xo: { email: 'admin@admin.net', password: PASSWORD }, reply: reply.publicKey };
  const box = await seal({ to: key, aad: xosetupAad(job, address), payload: inside });
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
  const { setups, events } = await machine();
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
  for (const key of XOSETUP_STEPS) assert.ok(STEP_WORDS[key], key);
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
    ['policy', 'edge', 'egress-any', 'edge-disk', ...(setups.coordinatorUrl ? ['image', 'images'] : [])],
    'a machine that can says so before any sign-in is sealed',
  );
  const reply = await newSealKey();
  const { sealed } = await phone(begun, xo.address, xo.pin, { v: 1, xo: { email: 'admin@admin.net', password: PASSWORD }, reply: reply.publicKey, purpose: 'policy' });
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
    more: ['network.create', 'resourceSet.addObject', 'disk.import', 'disk.resize', 'vm.create', 'vm.attachDisk', 'vm.start', 'vm.set', 'vm.convertToTemplate'],
    vms: { edge: { id: 'edge', type: 'VM', $pool: 'p1', tags: ['fleetwright-edge'], power_state: 'Running' } },
  });
  /** @type {any[]} */
  const asked = [];
  const { setups, events } = await machine({
    coordinatorUrl: 'https://fleet.test',
    buildImage: async (/** @type {any} */ o) => {
      asked.push(o);
      o.say('Installing Fleetwright on the machine image.', { stage: 3, stages: 4, fill: 600 });
      return 'The machine image is ready on Home.';
    },
  });
  const actor = 'eli@example.com';
  const { begun, reply, state } = await choosing(xo, setups, actor);
  const [epk, iv, ct] = state.inventory.split('.');
  const inventory = /** @type {any} */ (await open({ ...reply, aad: xosetupInventoryAad(begun.xosetup.job, xo.address), sealed: { epk, iv, ct } }));
  assert.deepEqual(inventory.images, [], 'no image yet, so the phone offers one');
  const job = begun.xosetup.job;
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
  assert.ok(events.some((/** @type {any} */ e) => e.fill === 600 && e.purpose === 'policy'), 'its bar reaches the Lock Screen');
  assert.equal(asked[0].image, 'debian-13', 'a phone from before the choice asked for Debian');
  assert.equal(asked[0].resize, 'disk.resize', 'the long-standing name, where the server offers it');
  assert.deepEqual(inventory.imageKinds.map((/** @type {any} */ k) => k.key), ['debian-13', 'ubuntu-24.04', 'ubuntu-26.04']);
});

test('a Xen Orchestra without disk.resize builds the image through vdi.set, and one with neither says both names', { skip }, async (t) => {
  for (const [grow, expect] of [[['vdi.set'], 'vdi.set'], [[], null]]) {
    const xo = await standIn(t, {
      sets: [chosenBefore()],
      more: ['network.create', 'resourceSet.addObject', 'disk.import', 'vm.create', 'vm.attachDisk', 'vm.start', 'vm.set', 'vm.convertToTemplate', ...grow],
      vms: { edge: { id: 'edge', type: 'VM', $pool: 'p1', tags: ['fleetwright-edge'], power_state: 'Running' } },
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
  const imaged = /** @type {any} */ (checkPolicy({ ...ok, image: true, edge: true, edgeSr: 'b' }, pooled));
  assert.equal(imaged.policy.image, true);
  assert.equal(imaged.policy.edgeSr, 'b', 'where the disks go');
  assert.deepEqual(currentLimits({ limits: { cpus: { total: 4 }, memory: 1024, disk: null } }), { cpus: 4, memory: 1024, disk: null });
});
