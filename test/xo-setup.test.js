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
import { mkdtempSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import os from 'node:os';
import path from 'node:path';

import { probe, XoSetups, limitsFrom, STEP_WORDS, FLEET_USER } from '../src/fleet/host/xo-setup.js';
import { frame, parseFrame } from '../src/fleet/host/xo-ws.js';
import { XOSETUP_STEPS } from '../src/fleet/protocol/intents.js';
import { seal, xosetupAad } from '../src/fleet/seal.js';
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
 * @param {{ admin?: boolean, drop?: string[], plugin?: any }} [opts]
 */
async function standIn(t, { admin = true, drop = [], plugin = { id: 'installer-updates', loaded: false, autoload: false, configuration: {} } } = {}) {
  const { key, cert, pin } = certificate();
  /** @type {Array<{ conn: number, method: string, params: any, as: string|null }>} */
  const calls = [];
  const users = /** @type {any[]} */ ([{ id: 'u-admin', email: 'admin@admin.net', permission: admin ? 'admin' : 'none' }]);
  const sets = /** @type {any[]} */ ([]);
  const passwords = new Map([['admin@admin.net', PASSWORD]]);
  const methods = Object.fromEntries(
    ['session.signIn', 'system.getMethodsInfo', 'xo.getAllObjects', 'user.getAll', 'user.create', 'user.set', 'resourceSet.getAll', 'resourceSet.create', 'resourceSet.set', 'token.create', 'plugin.get', 'plugin.load', 'plugin.enableAutoload', 'plugin.configure']
      .filter((m) => !drop.includes(m))
      .map((m) => [m, {}]),
  );
  const objects = {
    pool: { p1: { id: 'p1', type: 'pool', name_label: 'Home', default_SR: 'sr1' } },
    host: { h1: { id: 'h1', type: 'host', cpus: { cores: 16 }, memory: { size: 64 * 1024 ** 3 } } },
    SR: { sr1: { id: 'sr1', type: 'SR', size: 1000 * 1024 ** 3, physical_usage: 200 * 1024 ** 3 } },
  };
  let conns = 0;
  const server = tls.createServer({ key, cert }, (socket) => {
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
          case 'xo.getAllObjects': answer(objects[/** @type {'pool'|'host'|'SR'} */ (p.filter?.type)] ?? {}); break;
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
          case 'resourceSet.set': answer(true); break;
          case 'token.create': answer(as === FLEET_USER ? 'tok-limited-123' : 'tok-WRONG-USER'); break;
          case 'plugin.get': answer(plugin ? [plugin] : []); break;
          default: answer(true);
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => server.close());
  const address = `127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  return { address, pin, calls, users, sets };
}

/** A machine with an enrolment key, collecting what it reports. */
async function machine() {
  const keys = await generateKeyPair();
  /** @type {any[]} */
  const events = [];
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'xo-state-'));
  const setups = new XoSetups({
    signer: { publicJwk: keys.publicJwk, sign: (m) => sign(keys.privateJwk, m) },
    emit: (e) => events.push(e),
    stateDir,
    fingerprint,
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

/** What the phone does with `begin`'s answer: check the signature, then seal. */
async function phone(/** @type {any} */ begun, /** @type {string} */ address, /** @type {string} */ pin, payload = { v: 1, xo: { email: 'admin@admin.net', password: PASSWORD } }) {
  const { job, key, keySig, hostKey } = begun.xosetup;
  const signed = await verify(hostKey, keySig, signingInput('xosetup-key', { address, job, key, pin }));
  const box = await seal({ to: key, aad: xosetupAad(job, address), payload });
  return { signed, sealed: `${box.epk}.${box.iv}.${box.ct}` };
}

test('the probe says Xen Orchestra answered, over TLS, and which certificate', { skip }, async (t) => {
  const xo = await standIn(t);
  const found = await probe(xo.address);
  assert.equal(found.reachable, true);
  assert.equal(found.tls, true);
  assert.equal(found.xo, true);
  assert.equal(found.cert, xo.pin);
  const nothing = await probe('127.0.0.1:1', { timeoutMs: 2000 });
  assert.equal(nothing.reachable, false);
});

test('a pool is onboarded end to end, and only the limited token is kept', { skip }, async (t) => {
  const xo = await standIn(t);
  const { setups, events, stateDir, keys } = await machine();
  const actor = 'eli@example.com';

  const begun = await setups.begin({ address: xo.address, pin: xo.pin, actor });
  assert.equal(begun.ok, true, begun.text);
  // THE PHONE CAN TELL THE KEY IS THIS MACHINE'S: signed by its enrolment key,
  // over the job, the address, the pin and the key together.
  assert.equal(begun.xosetup.fingerprint, await fingerprint(keys.publicJwk));
  const { signed, sealed } = await phone(begun, xo.address, xo.pin);
  assert.equal(signed, true);
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

  // KEPT: the token, 0600, and nothing of the admin sign-in anywhere.
  const dir = path.join(stateDir, 'hypervisors');
  const [file] = readdirSync(dir);
  const kept = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
  assert.equal(kept.token, 'tok-limited-123');
  assert.equal(statSync(path.join(dir, file)).mode & 0o777, 0o600);
  const everything = JSON.stringify({ kept, events, status: end });
  assert.ok(!everything.includes(PASSWORD), 'the admin password went nowhere');
  assert.ok(!JSON.stringify(kept).includes('admin@admin.net'), 'the admin sign-in is not in what was kept');
});

test('a server with a different certificate is never sent a byte of the sign-in', { skip }, async (t) => {
  const xo = await standIn(t);
  const { setups, events } = await machine();
  const actor = 'eli@example.com';
  const otherPin = 'f'.repeat(64);
  const begun = await setups.begin({ address: xo.address, pin: otherPin, actor });
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
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, actor });
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
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, actor });
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
  const begun = await setups.begin({ address: xo.address, pin: xo.pin, actor });
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
