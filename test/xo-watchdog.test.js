// Adding the reconnect watchdog to a Xen Orchestra that predates it, from the
// pool master that runs its VM (src/fleet/host/xo-watchdog.js, phase
// `watchdog` in xo-setup.js). docs/hypervisors.md, "When Xen Orchestra loses
// a pool".
//
// The scripts run here with bash against a stand-in for the pool master's own
// domain (helpers/fake-dom0.mjs) that keeps XAPI's rules for what is asked of
// them: a disk plugged into the pool master only while its VM is off, a VM
// started only once its disk is given back. The job runs over the same
// stand-in for SSH an install's tests use (helpers/fake-pool-master.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { XoSetups } from '../src/fleet/host/xo-setup.js';
import { WATCHDOG_FILES, addToDisk, findXoVm, startXoVm, stopXoVm, watchdogFiles } from '../src/fleet/host/xo-watchdog.js';
import { XOWATCHDOG_STEPS } from '../src/fleet/protocol/intents.js';
import { seal, newSealKey, xodeployAad, xowatchdogAad } from '../src/fleet/seal.js';
import { generateKeyPair, sign, verify, signingInput, fingerprint } from '../src/fleet/crypto.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_PASSWORD = 'pool-root-password-7';
const POOL_MASTER = 'xcp1.test';
const XO = '10.10.10.230';
const ADDED = 'Added to /opt/xo/xo-builds/xen-orchestra-202610220000/packages/xo-server.\nNamed in /opt/xo-installer/xo-install.cfg, so updates keep it.\nxo-server was left running. The watchdog starts with it next time.\n';

/**
 * The pool master's domain: its VMs, and the tools on its PATH.
 *
 * @param {Record<string, any>} [over]
 */
function dom0(over = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-dom0-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const state = path.join(dir, 'state.json');
  writeFileSync(state, JSON.stringify({
    log: path.join(dir, 'log.jsonl'),
    seen: path.join(dir, 'seen'),
    vms: {
      'vm-xo': { name: 'fleetwright-xo', running: true, vdi: 'vdi-xo', networks: `0/ip: ${XO}; 0/ipv4/0: ${XO}; 0/ipv6/0: fe80::1` },
      'vm-other': { name: 'web', running: true, vdi: 'vdi-web', networks: '0/ip: 10.10.10.40' },
    },
    rootPart: '/dev/xvdb1',
    fs: 'ext4',
    mounts: {},
    vbd: null,
    plugged: false,
    chrootSays: ADDED,
    chrootCode: 0,
    ...over,
  }));
  for (const role of ['xe', 'lsblk', 'blkid', 'mount', 'umount', 'mountpoint', 'chroot']) {
    writeFileSync(path.join(bin, role), `#!/bin/sh\nFAKE_DOM0_STATE='${state}' exec '${process.execPath}' '${path.join(HERE, 'helpers', 'fake-dom0.mjs')}' ${role} "$@"\n`);
    chmodSync(path.join(bin, role), 0o755);
  }
  const read = () => JSON.parse(readFileSync(state, 'utf8'));
  const log = () => (existsSync(read().log) ? readFileSync(read().log, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  /** What `xe` was asked, by subcommand, in order. */
  const xe = () => log().filter((e) => e.role === 'xe').map((e) => e.argv[0]);
  return {
    bin,
    read,
    log,
    xe,
    /** A pool link whose scripts run here, as they run on the pool master. */
    pool: {
      remote: async (/** @type {string} */ script) => {
        const r = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
        return { code: r.status, stdout: r.stdout, stderr: r.stderr };
      },
    },
  };
}

test('the files it adds are the ones the deploy builds in', () => {
  const files = watchdogFiles();
  assert.deepEqual(Object.keys(files), [...WATCHDOG_FILES]);
  for (const rel of WATCHDOG_FILES) assert.deepEqual(files[rel], readFileSync(path.join(HERE, '..', 'xo-plugin', rel)));
});

test('Xen Orchestra’s VM is found by the address it answers on, and its disk with it', async () => {
  const d = dom0();
  assert.deepEqual(await findXoVm(d.pool, [XO]), { vm: 'vm-xo', name: 'fleetwright-xo', running: true, vdi: 'vdi-xo', how: 'address' });
  // NOTHING ASKED BUT QUESTIONS.
  assert.deepEqual([...new Set(d.xe())].sort(), ['pbd-list', 'pool-list', 'pool-param-get', 'vbd-list', 'vdi-param-get', 'vm-list', 'vm-param-get']);
});

test('a stopped VM, which reports no address, is found by the name an install gives it, and only then', async () => {
  const d = dom0({ vms: { 'vm-xo': { name: 'fleetwright-xo', running: false, vdi: 'vdi-xo', networks: '' } } });
  assert.deepEqual(await findXoVm(d.pool, [XO]), { vm: 'vm-xo', name: 'fleetwright-xo', running: false, vdi: 'vdi-xo', how: 'name' });
  const none = dom0({ vms: { 'vm-web': { name: 'web', running: false, vdi: 'vdi-web', networks: '' } } });
  await assert.rejects(findXoVm(none.pool, [XO]), /no VM on this pool reports the address .* Nothing was changed/);
});

test('two VMs that could be Xen Orchestra, or a disk the pool master cannot open, are refused before anything is asked of them', async () => {
  const twice = dom0({ vms: { a: { name: 'xo-a', running: true, vdi: 'v1', networks: `0/ip: ${XO}` }, b: { name: 'xo-b', running: true, vdi: 'v2', networks: `0/ip: ${XO}` } } });
  await assert.rejects(findXoVm(twice.pool, [XO]), /more than one VM .* not certain/);
  const local = dom0({ srUnreachable: true });
  await assert.rejects(findXoVm(local.pool, [XO]), /storage the pool master does not reach/);
  for (const d of [twice, local]) assert.ok(!d.xe().some((c) => /shutdown|start|vbd-create/.test(c)));
});

test('the disk is opened, the watchdog put in with the add script inside it, and the disk given back', async () => {
  const d = dom0({ vms: { 'vm-xo': { name: 'fleetwright-xo', running: false, vdi: 'vdi-xo', networks: '' } } });
  const added = await addToDisk(d.pool, 'vdi-xo');
  assert.match(added.output, /Named in \/opt\/xo-installer\/xo-install.cfg/);
  const s = d.read();
  // RUN AS A PERSON WOULD RUN IT INSIDE THE VM, and never with a restart:
  // there is no xo-server running there to restart.
  assert.deepEqual(s.ran, ['/bin/bash', '/root/fleetwright-watchdog/add-reconnect-watchdog.sh', '--no-restart']);
  for (const rel of WATCHDOG_FILES) assert.deepEqual(readFileSync(path.join(s.seen, rel)), readFileSync(path.join(HERE, '..', 'xo-plugin', rel)), rel);
  // GIVEN BACK: nothing mounted, nothing plugged, no VBD left on the pool master.
  assert.deepEqual(s.mounts, {});
  assert.equal(s.plugged, false);
  assert.equal(s.vbd, null);
  // AND THE FILESYSTEM LOOKED AT READ-ONLY before it was opened for writing.
  const mounts = d.log().filter((e) => e.role === 'mount' && e.argv[0] !== '--bind').map((e) => e.argv[0] === '-o' ? 'ro' : 'rw');
  assert.deepEqual(mounts, ['ro', 'rw']);
});

test('a disk that will not open for writing, or a script that refuses, changes nothing and gives the disk back', async () => {
  const off = { vms: { 'vm-xo': { name: 'fleetwright-xo', running: false, vdi: 'vdi-xo', networks: '' } } };
  const unsupported = dom0({ ...off, mountRefuses: true });
  await assert.rejects(addToDisk(unsupported.pool, 'vdi-xo'), /could not be opened for writing .* Its disk was not changed/);
  assert.equal(unsupported.read().ran, undefined);
  const refused = dom0({ ...off, chrootCode: 1, chrootSays: "Not added: /opt/xo/xo-server is not xo-server's directory. Name it with --xo-server.\n" });
  await assert.rejects(addToDisk(refused.pool, 'vdi-xo'), /the watchdog was not added: \/opt\/xo\/xo-server is not xo-server's directory/);
  for (const d of [unsupported, refused]) {
    const s = d.read();
    assert.deepEqual(s.mounts, {});
    assert.equal(s.vbd, null);
  }
});

test('stopping is a clean shutdown, and a VM that will not stop is left as it was', async () => {
  const d = dom0();
  await stopXoVm(d.pool, 'vm-xo');
  assert.equal(d.read().vms['vm-xo'].running, false);
  assert.ok(!d.log().some((e) => e.argv.includes('--force') || e.argv.includes('force=true')));
  await startXoVm(d.pool, 'vm-xo');
  assert.equal(d.read().vms['vm-xo'].running, true);
  const stuck = dom0({ shutdownRefuses: true });
  await assert.rejects(stopXoVm(stuck.pool, 'vm-xo'), /did not shut down cleanly .* its disk was not touched/);
});

// THE JOB, as a phone asks for it.

/** An SSH host key blob, as known_hosts and ssh-keyscan write it. */
function hostKeyBlob() {
  const raw = /** @type {Buffer} */ (generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })).subarray(-32);
  /** @param {Buffer} b */
  const field = (b) => Buffer.concat([Buffer.from([0, 0, 0, b.length]), b]);
  return Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64');
}

/**
 * A pool master reached over SSH (fake-pool-master.mjs), whose own domain is
 * `d`.
 *
 * @param {ReturnType<typeof dom0>} d
 */
function poolMaster(d) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-wd-pool-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const blob = hostKeyBlob();
  const logPath = path.join(dir, 'ssh.jsonl');
  const config = path.join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ keys: [{ type: 'ssh-ed25519', blob }], password: ROOT_PASSWORD, log: logPath, poolPath: d.bin }));
  for (const role of ['ssh', 'ssh-keyscan']) {
    writeFileSync(path.join(bin, role), `#!/bin/sh\nFAKE_POOL_CONFIG='${config}' exec '${process.execPath}' '${path.join(HERE, 'helpers', 'fake-pool-master.mjs')}' ${role} "$@"\n`);
    chmodSync(path.join(bin, role), 0o755);
  }
  process.env.PATH = `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`;
  const pin = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('hex');
  const sshLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { pin, sshLog };
}

async function machine({ answers = true } = {}) {
  const keys = await generateKeyPair();
  /** @type {any[]} */
  const events = [];
  /** @type {string[]} */
  const waited = [];
  const setups = new XoSetups({
    signer: { publicJwk: keys.publicJwk, sign: (m) => sign(keys.privateJwk, m) },
    emit: (e) => events.push(e),
    stateDir: mkdtempSync(path.join(os.tmpdir(), 'xo-state-')),
    fingerprint,
    waitXo: async (address) => {
      waited.push(address);
      return answers;
    },
  });
  return { setups, events, waited };
}

/** The phone's half: check the key is this machine's for this pool master, and seal the root password and Xen Orchestra's address. */
async function phone(/** @type {any} */ begun, /** @type {string} */ pin, { aad = xowatchdogAad } = {}) {
  const { job, key, keySig, hostKey } = begun.xosetup;
  const signed = await verify(hostKey, keySig, signingInput('xowatchdog-key', { address: POOL_MASTER, job, key, pin }));
  const box = await seal({ to: key, aad: aad(job, POOL_MASTER), payload: { v: 1, purpose: 'watchdog', root: { password: ROOT_PASSWORD }, xo: { address: XO } } });
  return { signed, sealed: `${box.epk}.${box.iv}.${box.ct}` };
}

/** @param {XoSetups} setups @param {string} job */
async function finished(setups, job, actor = 'eli@example.com') {
  for (let i = 0; i < 1500; i++) {
    const s = setups.status({ job, actor });
    if (s.xosetup && s.xosetup.state !== 'running') return s.xosetup;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('the job never finished');
}

/** @param {Awaited<ReturnType<typeof machine>>} m @param {string} pin */
async function addWatchdog(m, pin) {
  const actor = 'eli@example.com';
  const begun = await m.setups.beginWatchdog({ address: POOL_MASTER, pin, actor });
  assert.equal(begun.ok, true, begun.text);
  const { signed, sealed } = await phone(begun, pin);
  const ran = await m.setups.run({ job: begun.xosetup.job, sealed, actor });
  return { begun, signed, ran, end: ran.ok ? await finished(m.setups, begun.xosetup.job) : ran.xosetup };
}

test('from the phone: shut down, added, started again, and Xen Orchestra waited for', async () => {
  const d = dom0();
  const pool = poolMaster(d);
  const m = await machine();
  const { signed, ran, end } = await addWatchdog(m, pool.pin);
  assert.equal(signed, true, 'the phone can tell the key is this machine’s, for this pool master');
  assert.equal(ran.ok, true, ran.text);
  assert.equal(end.state, 'done', end.text);
  // WHAT IT SAYS IS WHAT IT CHECKED: a TCP connect to the port, not the
  // plugin loading, which it used to claim (C-5).
  assert.equal(end.text, 'The reconnect watchdog is on fleetwright-xo’s disk, and Xen Orchestra at 10.10.10.230 answers on its port again. Whether it loaded the plugin as it started was not checked from here: Settings, Plugins in Xen Orchestra lists it, and once loaded it reconnects a pool it loses by itself.');
  assert.deepEqual(m.waited, [XO]);

  // IN THIS ORDER, and only this: the disk is never opened while the VM
  // runs, and the VM is never started while the disk is the pool master's.
  const acts = d.xe().filter((c) => ['vm-shutdown', 'vbd-create', 'vbd-destroy', 'vm-start'].includes(c));
  assert.deepEqual(acts, ['vm-shutdown', 'vbd-create', 'vbd-destroy', 'vm-start']);
  assert.equal(d.read().vms['vm-xo'].running, true);
  assert.equal(d.read().vms['vm-other'].running, true, 'no other VM is touched');

  // EVERY STEP, reported as the watchdog's.
  const running = m.events.filter((e) => e.state === 'running');
  assert.deepEqual([...new Set(running.map((e) => e.phase))], [...XOWATCHDOG_STEPS]);
  assert.ok(m.events.every((e) => e.purpose === 'watchdog'));
  // THE ROOT PASSWORD only ever reached ssh through its askpass.
  assert.ok(!pool.sshLog().some((e) => e.password));
});

test('a watchdog that cannot be added leaves Xen Orchestra running, and says so', async () => {
  const d = dom0({ mountRefuses: true });
  const pool = poolMaster(d);
  const m = await machine();
  const { end } = await addWatchdog(m, pool.pin);
  assert.equal(end.state, 'failed');
  assert.match(end.text, /^Adding the watchdog to its disk stopped: .*could not be opened for writing.* Xen Orchestra’s VM was started again, as it was\.$/);
  assert.equal(d.read().vms['vm-xo'].running, true);
  assert.deepEqual(d.xe().filter((c) => ['vm-shutdown', 'vm-start'].includes(c)), ['vm-shutdown', 'vm-start']);
});

test('a VM that will not start again is named, rather than called fine', async () => {
  const d = dom0({ mountRefuses: true, startRefuses: true });
  const pool = poolMaster(d);
  const m = await machine();
  const { end } = await addWatchdog(m, pool.pin);
  assert.equal(end.state, 'failed');
  assert.match(end.text, /Xen Orchestra’s VM was shut down and did not start again .*HOST_NOT_ENOUGH_FREE_MEMORY.*start it from the pool\.$/);
});

test('a VM that was off is left off, with the watchdog on its disk', async () => {
  const d = dom0({ vms: { 'vm-xo': { name: 'fleetwright-xo', running: false, vdi: 'vdi-xo', networks: '' } } });
  const pool = poolMaster(d);
  const m = await machine();
  const { end } = await addWatchdog(m, pool.pin);
  assert.equal(end.state, 'done', end.text);
  assert.match(end.text, /was not running and was left off/);
  assert.ok(!d.xe().some((c) => c === 'vm-shutdown' || c === 'vm-start'));
  assert.deepEqual(m.waited, []);
});

test('a root password sealed for an install is not opened as this, or the other way round', async () => {
  const d = dom0();
  const pool = poolMaster(d);
  const m = await machine();
  const actor = 'eli@example.com';
  const begun = await m.setups.beginWatchdog({ address: POOL_MASTER, pin: pool.pin, actor });
  const { sealed } = await phone(begun, pool.pin, { aad: xodeployAad });
  const ran = await m.setups.run({ job: begun.xosetup.job, sealed, actor });
  assert.equal(ran.ok, false);
  assert.match(ran.text, /did not open with this job’s key/);
  // AND A DEPLOY'S KEY IS SIGNED UNDER ANOTHER CONTEXT, so a phone checking
  // for this job could not take an install's key for it.
  const deploy = await m.setups.beginDeploy({ address: POOL_MASTER, pin: pool.pin, actor });
  const { job, key, keySig, hostKey } = deploy.xosetup;
  assert.equal(await verify(hostKey, keySig, signingInput('xowatchdog-key', { address: POOL_MASTER, job, key, pin: pool.pin })), false);
  assert.equal(d.log().length, 0, 'nothing reached the pool master');
});

test('through a phone it is refused, as an install is: it needs SSH to the pool master', async () => {
  const m = await machine();
  const r = await m.setups.beginWatchdog({ address: POOL_MASTER, pin: 'a'.repeat(64), relay: 'b'.repeat(24), actor: 'eli@example.com' });
  assert.equal(r.ok, false);
  assert.match(r.text, /needs a machine that reaches the pool/);
});
