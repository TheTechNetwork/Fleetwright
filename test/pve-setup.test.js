// SETTING UP PROXMOX VE THROUGH A MACHINE OF THE FLEET (src/fleet/host/pve-setup.js),
// for a phone that cannot reach the node. The machine reaches a stand-in node
// over the same stand-in SSH an install's tests use (helpers/fake-pool-master.mjs),
// which holds the host key and the password as a real server does; on the
// node, systemd-run, systemctl and journalctl are stand-ins that play the
// script's run from the test's scenario.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { XoSetups } from '../src/fleet/host/xo-setup.js';
import { CONNECTION_PREFIX } from '../src/fleet/host/pve-pools.js';
import { PVESETUP_STEPS } from '../src/fleet/protocol/intents.js';
import { open, seal, newSealKey, pvesetupAad, pvesetupHandoffAad, xowatchdogAad } from '../src/fleet/seal.js';
import { generateKeyPair, sign, verify, signingInput, fingerprint } from '../src/fleet/crypto.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_PASSWORD = 'node-root-password-9';
const NODE = 'pve1.test';
const FLEET = 'https://fleet.example.com';
const ACTOR = 'eli@example.com';
const CA = '-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(120) + '\n-----END CERTIFICATE-----\n';
const LINE = CONNECTION_PREFIX + Buffer.from(JSON.stringify({
  kind: 'proxmox', address: 'pve1.test:8006', token: 'fleetwright@pve!fleet=0b8e6f0e-6a3e-4c55-9f4c-7c5d2b1a9e01', pool: 'fleetwright', ca: CA,
})).toString('base64url');

/** An SSH host key blob, as known_hosts and ssh-keyscan write it. */
function hostKeyBlob() {
  const raw = /** @type {Buffer} */ (generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })).subarray(-32);
  /** @param {Buffer} b */
  const field = (b) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  return Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64');
}

/**
 * A node over SSH, with a run of the setup the scenario describes: the steps
 * it says, then an error, the line, or nothing yet (`hangs`).
 *
 * @param {{ steps?: string[], error?: string, hangs?: boolean }} scenario
 */
function node(scenario) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-pve-node-'));
  const bin = path.join(dir, 'bin');
  const root = path.join(dir, 'root');
  mkdirSync(bin);
  mkdirSync(root);
  const blob = hostKeyBlob();
  const logPath = path.join(dir, 'ssh.jsonl');
  const journal = path.join(dir, 'journal');
  const state = path.join(dir, 'state');
  const asked = path.join(dir, 'asked');
  const steps = (scenario.steps ?? ['pool', 'user', 'token', 'fence', 'networks', 'image', 'line', 'done']).map((s) => `fleetwright-step: ${s}`);
  const end = scenario.error ? [`fleetwright-error: ${scenario.error}`] : [];
  const lineFile = `${root}/.fleetwright-pve-line`;
  const config = path.join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ keys: [{ type: 'ssh-ed25519', blob }], password: ROOT_PASSWORD, log: logPath, poolPath: bin, root }));
  const tools = {
    'systemd-run': `echo "systemd-run $*" >> '${asked}'\nprintf '%s\\n' ${[...steps, ...end].map((l) => `'${l}'`).join(' ')} > '${journal}'\n` +
      (scenario.hangs ? `echo active > '${state}'\n` : scenario.error ? `echo failed > '${state}'\n` : `echo inactive > '${state}'\nprintf '%s\\n' '${LINE}' > '${lineFile}'\n`),
    systemctl: `echo "systemctl $*" >> '${asked}'\ncase "$1" in is-active) cat '${state}' 2>/dev/null || echo inactive;; stop) echo inactive > '${state}';; esac\n`,
    journalctl: `cat '${journal}' 2>/dev/null\n`,
  };
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}`);
    chmodSync(path.join(bin, name), 0o755);
  }
  for (const role of ['ssh', 'ssh-keyscan']) {
    writeFileSync(path.join(bin, role), `#!/bin/sh\nFAKE_POOL_CONFIG='${config}' exec '${process.execPath}' '${path.join(HERE, 'helpers', 'fake-pool-master.mjs')}' ${role} "$@"\n`);
    chmodSync(path.join(bin, role), 0o755);
  }
  process.env.PATH = `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`;
  return {
    pin: createHash('sha256').update(Buffer.from(blob, 'base64')).digest('hex'),
    asked: () => (existsSync(asked) ? readFileSync(asked, 'utf8') : '').trim().split('\n').filter(Boolean),
    sshLog: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    lineLeft: () => existsSync(lineFile),
  };
}

async function machine({ coordinatorUrl = /** @type {string|null} */ (FLEET) } = {}) {
  const keys = await generateKeyPair();
  /** @type {any[]} */
  const events = [];
  const setups = new XoSetups({
    signer: { publicJwk: keys.publicJwk, sign: (m) => sign(keys.privateJwk, m) },
    emit: (e) => events.push(e),
    stateDir: mkdtempSync(path.join(os.tmpdir(), 'pve-state-')),
    fingerprint,
    coordinatorUrl,
    sleep: () => new Promise((r) => setTimeout(r, 5)),
  });
  return { setups, events };
}

/** The phone's half: check the key is this machine's for this node, and seal the root password with a key to hand the line back to. */
async function phone(/** @type {any} */ begun, /** @type {string} */ pin, { aad = pvesetupAad } = {}) {
  const { job, key, keySig, hostKey } = begun.xosetup;
  const signed = await verify(hostKey, keySig, signingInput('pvesetup-key', { address: NODE, job, key, pin }));
  const reply = await newSealKey();
  const box = await seal({ to: key, aad: aad(job, NODE), payload: { v: 1, purpose: 'pve', root: { password: ROOT_PASSWORD }, reply: reply.publicKey } });
  return { signed, reply, sealed: `${box.epk}.${box.iv}.${box.ct}` };
}

/** @param {XoSetups} setups @param {string} job */
async function settled(setups, job, until = (/** @type {any} */ s) => s.state !== 'running') {
  for (let i = 0; i < 1500; i++) {
    const s = setups.status({ job, actor: ACTOR });
    if (s.xosetup && until(s.xosetup)) return s.xosetup;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the job never got there');
}

/** @param {Awaited<ReturnType<typeof machine>>} m @param {string} pin */
async function setUp(m, pin) {
  const begun = await m.setups.beginPve({ address: NODE, pin, actor: ACTOR });
  assert.equal(begun.ok, true, begun.text);
  const p = await phone(begun, pin);
  const ran = await m.setups.run({ job: begun.xosetup.job, sealed: p.sealed, actor: ACTOR });
  return { begun, ...p, ran, job: begun.xosetup.job };
}

test('through a machine: the node is set up with the phones’ own command, and the line comes back sealed to the phone alone', async () => {
  const n = node({});
  const m = await machine();
  const { signed, reply, ran, job } = await setUp(m, n.pin);
  assert.equal(signed, true, 'the phone can tell the key is this machine’s, for this node');
  assert.equal(ran.ok, true, ran.text);
  const end = await settled(m.setups, job);
  assert.equal(end.state, 'done', end.text);
  // THE LINE, opened only with the phone's key and only under the hand-off's name.
  const [epk, iv, ct] = end.handoff.split('.');
  const opened = await open({ privateKey: reply.privateKey, publicKey: reply.publicKey, aad: pvesetupHandoffAad(job, NODE), sealed: { epk, iv, ct } });
  assert.deepEqual(opened, { v: 1, line: LINE });
  await assert.rejects(open({ privateKey: reply.privateKey, publicKey: reply.publicKey, aad: pvesetupAad(job, NODE), sealed: { epk, iv, ct } }));
  // READ ONCE AND REMOVED from the node; never in the progress the coordinator relays.
  assert.equal(n.lineLeft(), false);
  assert.ok(!JSON.stringify(m.events).includes(LINE.slice(CONNECTION_PREFIX.length, CONNECTION_PREFIX.length + 40)));
  // THE COMMAND BOTH PHONES RUN, naming this machine's fleet.
  assert.match(n.asked().find((a) => a.startsWith('systemd-run')) ?? '', new RegExp(`--unit=fleetwright-pve-setup --collect /bin/bash -c .*--coordinator ${FLEET} --line-file `));
  // EVERY STEP, reported as Proxmox's, and the password only through askpass.
  assert.deepEqual([...new Set(m.events.filter((e) => e.state === 'running').map((e) => e.phase))], [...PVESETUP_STEPS]);
  assert.ok(m.events.every((e) => e.purpose === 'pve'));
  assert.ok(!n.sshLog().some((e) => e.password || String(e.script ?? '').includes(ROOT_PASSWORD)));
});

test('a setup the node stops is said in the node’s words, at the step it stopped', async () => {
  const n = node({ steps: ['pool', 'user', 'token'], error: 'pvesm has no storage called local-lvm' });
  const m = await machine();
  const { job } = await setUp(m, n.pin);
  const end = await settled(m.setups, job);
  assert.equal(end.state, 'failed');
  assert.match(end.text, /^Making its token stopped: the node said: pvesm has no storage called local-lvm/);
  assert.equal(end.handoff, undefined);
});

test('a cancel stops the run on the node, which the script is written to be run again after', async () => {
  const n = node({ steps: ['pool', 'user'], hangs: true });
  const m = await machine();
  const { job } = await setUp(m, n.pin);
  await settled(m.setups, job, (s) => s.phase === 'user');
  m.setups.cancel({ job, actor: ACTOR });
  const end = await settled(m.setups, job);
  assert.equal(end.state, 'cancelled');
  assert.match(end.text, /The setup on the node was stopped; what it made by then stays, and running it again finds it\./);
  assert.ok(n.asked().includes('systemctl stop fleetwright-pve-setup'));
});

test('a root password sealed for another job is not opened as this one, and its key is signed under its own name', async () => {
  const n = node({});
  const m = await machine();
  const begun = await m.setups.beginPve({ address: NODE, pin: n.pin, actor: ACTOR });
  const { sealed } = await phone(begun, n.pin, { aad: xowatchdogAad });
  const ran = await m.setups.run({ job: begun.xosetup.job, sealed, actor: ACTOR });
  assert.equal(ran.ok, false);
  assert.match(ran.text, /did not open with this job’s key/);
  const watchdog = await m.setups.beginWatchdog({ address: NODE, pin: n.pin, actor: ACTOR });
  const { job, key, keySig, hostKey } = watchdog.xosetup;
  assert.equal(await verify(hostKey, keySig, signingInput('pvesetup-key', { address: NODE, job, key, pin: n.pin })), false);
  assert.equal(n.sshLog().length, 0, 'nothing reached the node');
});

test('it is refused without the compared host key, through a phone, or by a machine that does not know its fleet', async () => {
  const m = await machine();
  assert.match((await m.setups.beginPve({ address: NODE, pin: null, actor: ACTOR })).text, /SSH host key you compared/);
  assert.match((await m.setups.beginPve({ address: NODE, pin: 'a'.repeat(64), relay: 'b'.repeat(24), actor: ACTOR })).text, /reaches the node itself/);
  const lost = await machine({ coordinatorUrl: null });
  assert.match((await lost.setups.beginPve({ address: NODE, pin: 'a'.repeat(64), actor: ACTOR })).text, /does not know its fleet’s address/);
});
