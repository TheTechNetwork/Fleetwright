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
import { progressOf, partOf, setupCommand } from '../src/fleet/host/pve-setup.js';
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
 * @param {{ steps?: string[], parts?: string[], error?: string, hangs?: boolean, resources?: any[], removed?: string[] }} scenario
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
  const end = [...(scenario.removed ?? []).map((n) => `fleetwright-holder-removed: ${n}`), ...(scenario.parts ?? []).map((l) => `fleetwright-part: ${l}`), ...(scenario.error ? [`fleetwright-error: ${scenario.error}`] : [])];
  const lineFile = `${root}/.fleetwright-pve-line`;
  const config = path.join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ keys: [{ type: 'ssh-ed25519', blob }], password: ROOT_PASSWORD, log: logPath, poolPath: bin, root }));
  const tools = {
    'systemd-run': `echo "systemd-run $*" >> '${asked}'\nprintf '%s\\n' ${[...steps, ...end].map((l) => `'${l}'`).join(' ')} > '${journal}'\n` +
      (scenario.hangs ? `echo active > '${state}'\n` : scenario.error ? `echo failed > '${state}'\n` : `echo inactive > '${state}'\nprintf '%s\\n' '${LINE}' > '${lineFile}'\n`),
    systemctl: `echo "systemctl $*" >> '${asked}'\ncase "$1" in is-active) cat '${state}' 2>/dev/null || echo inactive;; stop) echo inactive > '${state}';; esac\n`,
    journalctl: `cat '${journal}' 2>/dev/null\n`,
    // THE CLUSTER'S GUESTS, as the token-less root sees them, for the look
    // that comes before a pin is asked for.
    hostname: `printf '%s\\n' '10.69.10.10 fd00::10'\n`,
    pvesh: `echo "pvesh $*" >> '${asked}'\nprintf '%s\\n' '${JSON.stringify(scenario.resources ?? [])}'\n`,
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
    /** The file the pin was written to, as the script would read it, or null. */
    holderJoin: () => (existsSync(`${root}/.fleetwright-holder-join`) ? JSON.parse(readFileSync(`${root}/.fleetwright-holder-join`, 'utf8')) : null),
  };
}

async function machine({ coordinatorUrl = /** @type {string|null} */ (FLEET), holderPin = /** @type {any} */ (undefined) } = {}) {
  const keys = await generateKeyPair();
  /** @type {any[]} */
  const events = [];
  const setups = new XoSetups({
    holderPin,
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
async function phone(/** @type {any} */ begun, /** @type {string} */ pin, { aad = pvesetupAad, vmids = /** @type {string|undefined} */ (undefined), options = /** @type {any} */ (undefined) } = {}) {
  const { job, key, keySig, hostKey } = begun.xosetup;
  const signed = await verify(hostKey, keySig, signingInput('pvesetup-key', { address: NODE, job, key, pin }));
  const reply = await newSealKey();
  const box = await seal({ to: key, aad: aad(job, NODE), payload: { v: 1, purpose: 'pve', root: { password: ROOT_PASSWORD }, reply: reply.publicKey, ...(vmids === undefined ? {} : { vmids }), ...(options === undefined ? {} : { options }) } });
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
  const started = n.asked().find((a) => a.startsWith('systemd-run')) ?? '';
  assert.ok(started.startsWith('systemd-run --unit=fleetwright-pve-setup --collect /bin/bash -c '), started);
  assert.ok(started.includes(` --coordinator ${FLEET} --line-file `), started);
  // EVERY STEP, reported as Proxmox's, and the password only through askpass.
  assert.deepEqual([...new Set(m.events.filter((e) => e.state === 'running').map((e) => e.phase))], [...PVESETUP_STEPS]);
  assert.ok(m.events.every((e) => e.purpose === 'pve'));
  assert.ok(!n.sshLog().some((e) => e.password || String(e.script ?? '').includes(ROOT_PASSWORD)));
});

// THE IMAGE IS MOST OF THE WAIT, asked for in so many words: "Where is step
// progress?" What the script says of how far into a step it is reaches the
// phone as the step's words and, when it measured one, a bar.
test('how far into the image the node is reaches the phone as words and a bar', async () => {
  const n = node({ steps: ['pool', 'user', 'token', 'fence', 'networks', 'image'], parts: ['120 downloading: 50 of 416 MB', '432 downloading: 180 of 416 MB'], hangs: true });
  const m = await machine();
  const { job } = await setUp(m, n.pin);
  const mid = await settled(m.setups, job, (s) => s.phase === 'image' && /180 of 416/.test(s.text));
  assert.equal(mid.text, 'Building the machine image: downloading: 180 of 416 MB');
  assert.equal(mid.part.fill, 432);
  assert.ok(m.events.some((e) => e.phase === 'image' && e.fill === 432), 'the Lock Screen was not told how far');
  await m.setups.cancel({ job, actor: ACTOR });
  await settled(m.setups, job);
  // Only the step it is on: once a later step has begun, its part is gone.
  assert.equal(progressOf('fleetwright-step: image\nfleetwright-part: 432 x\nfleetwright-step: line\nstate=active').part, null);
  assert.deepEqual(progressOf('fleetwright-step: image\nfleetwright-part: - VM 104 is building the image (3 min so far)').part, { fill: null, text: 'VM 104 is building the image (3 min so far)' });
  assert.equal(partOf('fleetwright-part: lots of it'), null);
});

// THE PERSON'S RANGE OF MACHINE NUMBERS reaches the script on the node, and
// only as digits and a dash: it goes into a command.
test('a range of machine numbers from the phone is passed to the script, and anything else refuses the job', async () => {
  const n = node({});
  const m = await machine();
  const begun = await m.setups.beginPve({ address: NODE, pin: n.pin, actor: ACTOR });
  const p = await phone(begun, n.pin, { vmids: '9000-9099' });
  const ran = await m.setups.run({ job: begun.xosetup.job, sealed: p.sealed, actor: ACTOR });
  assert.equal(ran.ok, true, ran.text);
  assert.equal((await settled(m.setups, begun.xosetup.job)).state, 'done');
  assert.ok(n.asked().some((l) => l.startsWith('systemd-run') && l.includes(' --vmids 9000-9099 --line-file ')), n.asked().join('\n'));
  for (const bad of ['9000-9099; rm -rf /', '12-40', 'nine-ten']) {
    const again = await m.setups.beginPve({ address: NODE, pin: n.pin, actor: ACTOR });
    const q = await phone(again, n.pin, { vmids: bad });
    const refused = await m.setups.run({ job: again.xosetup.job, sealed: q.sealed, actor: ACTOR });
    assert.equal(refused.ok, false, bad);
    assert.match(refused.text, /range of machine numbers/);
  }
  assert.equal(setupCommand('https://f.example', '9000-9099; x'), setupCommand('https://f.example'));
});

// THE SETUP'S OTHER OPTIONS travel the same way, sealed with the password,
// and reach the node's command; a set the script would refuse refuses the job.
test('the setup\'s options from the phone reach the node, and a set it would not take refuses the job', async () => {
  const n = node({});
  const m = await machine();
  const begun = await m.setups.beginPve({ address: NODE, pin: n.pin, actor: ACTOR });
  const p = await phone(begun, n.pin, { options: { firewall: true, channel: 'rolling', storage: 'local-zfs' } });
  const ran = await m.setups.run({ job: begun.xosetup.job, sealed: p.sealed, actor: ACTOR });
  assert.equal(ran.ok, true, ran.text);
  assert.equal((await settled(m.setups, begun.xosetup.job)).state, 'done');
  assert.ok(n.asked().some((l) => l.startsWith('systemd-run') && l.includes(' --enable-firewall --channel rolling --storage local-zfs --line-file ')), n.asked().join('\n'));
  const again = await m.setups.beginPve({ address: NODE, pin: n.pin, actor: ACTOR });
  const q = await phone(again, n.pin, { options: { storage: 'x; rm -rf /' } });
  const refused = await m.setups.run({ job: again.xosetup.job, sealed: q.sealed, actor: ACTOR });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /options were not ones it takes: the storage/);
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

// EVERY OPTION THE SETUP TAKES, from the app. Asked for: "Everything should be
// in app". Each is checked before it goes into a command, and each flag it
// becomes is one the script reads.
test('the setup\'s options are checked, become the script\'s flags, and the script reads every one', async () => {
  const { pveOptionsOf, optionArgs, setupCommand } = await import('../src/fleet/host/pve-setup.js');
  const all = { firewall: true, rebuildImage: true, images: ['ubuntu-24.04', 'debian-13'], channel: 'rolling', storage: 'local-zfs', bridge: 'vmbr1', expireDays: 90, groups: 2, labsOpen: 1, labsClosed: 1 };
  assert.deepEqual(pveOptionsOf(all), { options: all, problem: null });
  assert.equal(optionArgs(all), ' --enable-firewall --rebuild-image --images ubuntu-24.04,debian-13 --channel rolling --storage local-zfs --bridge vmbr1 --expire-days 90 --groups 2 --labs-open 1 --labs-closed 1');
  // NONE GIVEN runs the node exactly as before, and false is not a flag.
  assert.equal(optionArgs(null), '');
  assert.equal(optionArgs({ firewall: false, channel: '', storage: '' }), '');
  assert.match(setupCommand('https://fleet.example.com', '9000-9999', { firewall: true }), /--coordinator https:\/\/fleet\.example\.com --vmids 9000-9999 --enable-firewall$/);
  // REFUSED, with what is wrong, and never a flag from a refused set.
  for (const [bad, said] of /** @type {Array<[any, RegExp]>} */ ([
    [{ firewall: 'yes' }, /yes or no/],
    [{ rebuildImage: true, noImage: true }, /built again and not built/],
    [{ channel: 'nightly' }, /stable or rolling/],
    [{ images: ['rocky-10'] }, /debian-13, ubuntu-24\.04, ubuntu-26\.04/],
    [{ images: [] }, /one or more/],
    [{ images: ['debian-13', 'debian-13'] }, /once/],
    [{ images: 'debian-13;reboot' }, /one or more/],
    [{ storage: 'local; rm -rf /' }, /storage/],
    [{ bridge: 'vmbr0 && x' }, /bridge/],
    [{ expireDays: 0 }, /1 to 3650/],
    [{ groups: 5 }, /0 to 4/],
    [{ labsOpen: 3, labsClosed: 2 }, /four labs/],
    [[], /not a set/],
  ])) {
    const r = pveOptionsOf(bad);
    assert.equal(r.options, null, JSON.stringify(bad));
    assert.match(r.problem ?? '', said);
    assert.equal(optionArgs(bad), '', JSON.stringify(bad));
  }
  const script = readFileSync(new URL('../install/fleetwright-pve-setup', import.meta.url), 'utf8');
  for (const flag of optionArgs({ ...all, rebuildImage: false, noImage: true }).match(/--[a-z-]+/g) ?? []) {
    assert.ok(script.includes(`    ${flag})`), `the script does not read ${flag}`);
  }
});


// A MACHINE OF ITS OWN ON THE CLUSTER, asked for after Proxmox shipped
// without one: "No holder vm". The pin is asked for only when the cluster has
// none to keep, and goes to the node root-only, where the script reads it.
test('the cluster’s own machine: a pin only when there is none, written root-only for the script', async () => {
  /** @type {Array<[string, string]>} */
  const asked = [];
  const holderPin = async (/** @type {string} */ job, /** @type {string} */ address) => {
    asked.push([job, address]);
    return { ok: true, pin: '482913', hostId: 'holder-0a0b0c' };
  };
  const secret = 'ab'.repeat(32);
  const n = node({ resources: [] });
  const m = await machine({ holderPin });
  const begun = await m.setups.beginPve({ address: NODE, pin: n.pin, actor: ACTOR });
  assert.ok(begun.xosetup.can.includes('pve-holder'), 'a phone offers it only where the machine says it can');
  const p = await phone(begun, n.pin, { options: { holder: true, holderSecret: secret, grants: { upgrades: false } } });
  assert.equal((await m.setups.run({ job: begun.xosetup.job, sealed: p.sealed, actor: ACTOR })).ok, true);
  assert.equal((await settled(m.setups, begun.xosetup.job)).state, 'done');
  // RESERVED FOR THE ADDRESS THE LINE WILL CARRY, worked out on the node as
  // the script works it out, so the proof and the vault item agree with it.
  assert.deepEqual(asked, [[begun.xosetup.job, '10.69.10.10:8006']]);
  assert.deepEqual(n.holderJoin(), { hostId: 'holder-0a0b0c', pin: '482913', address: '10.69.10.10:8006', secret, grants: { upgrades: false } });
  assert.ok(n.asked().some((l) => l.startsWith('systemd-run') && / --holder-join \S*\/\.fleetwright-holder-join --line-file /.test(l)), n.asked().join('\n'));
  assert.ok(!JSON.stringify(m.events).includes('482913'), 'the pin is never in the progress the coordinator relays');

  // ONE THERE ALREADY: no pin, no file, and the script starts it if it is off.
  const there = node({ resources: [{ type: 'qemu', vmid: 120, node: 'pve1', name: 'holder-0a0b0c', status: 'stopped', tags: 'fleetwright-holder' }] });
  const again = await m.setups.beginPve({ address: NODE, pin: there.pin, actor: ACTOR });
  const q = await phone(again, there.pin, { options: { holder: true } });
  await m.setups.run({ job: again.xosetup.job, sealed: q.sealed, actor: ACTOR });
  assert.equal((await settled(m.setups, again.xosetup.job)).state, 'done');
  assert.equal(asked.length, 1, 'a setup run again spends no pin on a machine already there');
  assert.ok(!there.asked().some((l) => l.includes('--holder-join')));
});

test('made again: the one there goes, and the fleet is told the name it had', async () => {
  const holderPin = async () => ({ ok: true, pin: '482913', hostId: 'holder-1a1b1c' });
  const n = node({ resources: [{ type: 'qemu', vmid: 120, node: 'pve1', name: 'holder-0a0b0c', status: 'running', tags: 'fleetwright-holder' }], removed: ['holder-0a0b0c', 'not-ours'] });
  const m = await machine({ holderPin });
  const begun = await m.setups.beginPve({ address: NODE, pin: n.pin, actor: ACTOR });
  const p = await phone(begun, n.pin, { options: { holder: true, holderAgain: true } });
  await m.setups.run({ job: begun.xosetup.job, sealed: p.sealed, actor: ACTOR });
  assert.equal((await settled(m.setups, begun.xosetup.job)).state, 'done');
  assert.ok(n.asked().some((l) => /--holder-join \S*\/\.fleetwright-holder-join --holder-again --line-file /.test(l)), n.asked().join('\n'));
  assert.deepEqual(m.events.filter((e) => e.event === 'xosetup.holder-removed').map((e) => e.hostId), ['holder-0a0b0c'], 'only a name of the fleet’s shape, once');
});

test('asked for by a machine that cannot get a pin, or given none, nothing is started', async () => {
  const n = node({ resources: [] });
  const old = await machine();
  const begun = await old.setups.beginPve({ address: NODE, pin: n.pin, actor: ACTOR });
  assert.ok(!begun.xosetup.can.includes('pve-holder'));
  const p = await phone(begun, n.pin, { options: { holder: true } });
  await old.setups.run({ job: begun.xosetup.job, sealed: p.sealed, actor: ACTOR });
  const end = await settled(old.setups, begun.xosetup.job);
  assert.equal(end.state, 'failed');
  assert.match(end.text, /cannot ask the fleet for the pin/);
  const refusing = await machine({ holderPin: async () => ({ ok: false, text: 'This setup has asked for a pin 3 times already.' }) });
  const b2 = await refusing.setups.beginPve({ address: NODE, pin: n.pin, actor: ACTOR });
  const q = await phone(b2, n.pin, { options: { holder: true } });
  await refusing.setups.run({ job: b2.xosetup.job, sealed: q.sealed, actor: ACTOR });
  const e2 = await settled(refusing.setups, b2.xosetup.job);
  assert.match(e2.text, /gave no pin for the cluster’s own machine: This setup has asked for a pin 3 times already/);
  assert.ok(!n.asked().some((l) => l.startsWith('systemd-run')), 'nothing was started on the node');
});

test('the holder options are checked, and the script reads its flags and writes the same cloud-init as Xen Orchestra’s', async () => {
  const pveSetupMod = await import('../src/fleet/host/pve-setup.js');
  const { pveOptionsOf, startCommand, holdersIn, holderJoinCommand, HOLDER_JOIN_FILE } = pveSetupMod;
  const { UPGRADE_RUNCMD, JOIN_RUNCMD } = await import('../src/fleet/host/vm-image.js');
  const { holderCloudConfig } = await import('../src/fleet/host/xo-holder.js');
  assert.deepEqual(pveOptionsOf({ holder: true, holderAgain: true, holderSecret: 'f'.repeat(64), grants: { upgrades: true, reboot: false } }).options, { holder: true, holderAgain: true, holderSecret: 'f'.repeat(64), grants: { upgrades: true, reboot: false } });
  for (const [bad, said] of /** @type {Array<[any, RegExp]>} */ ([
    [{ holderAgain: true }, /only while it is asked for/],
    [{ holderSecret: 'f'.repeat(64) }, /not a secret/],
    [{ holder: true, holderSecret: 'zz' }, /not a secret/],
    [{ holder: 'yes' }, /yes or no/],
    [{ holder: true, grants: { upgrades: 'no' } }, /yes or no/],
  ])) assert.match(pveOptionsOf(bad).problem ?? '', said, JSON.stringify(bad));
  // The flags only with the file: the script refuses one without the other.
  assert.ok(!startCommand(FLEET, null, { holder: true, holderAgain: true }).includes('--holder'));
  assert.ok(startCommand(FLEET, null, { holder: true, holderAgain: true }, true).includes(` --holder-join ${HOLDER_JOIN_FILE} --holder-again --line-file `));
  // ITS OWN, AND ONLY ITS OWN: outside the pool, tagged, not a template.
  const res = JSON.stringify([
    { type: 'qemu', vmid: 130, name: 'holder-0a0b0c', status: 'running', tags: 'fleetwright-holder' },
    { type: 'qemu', vmid: 131, name: 'planted', status: 'running', tags: 'fleetwright-holder', pool: 'fleetwright' },
    { type: 'qemu', vmid: 132, name: 'tpl', template: 1, tags: 'fleetwright-holder' },
    { type: 'lxc', vmid: 133, name: 'ct', tags: 'fleetwright-holder' },
  ]);
  assert.deepEqual(holdersIn(res), [{ vmid: 130, name: 'holder-0a0b0c', running: true }]);
  assert.deepEqual(holdersIn('not json'), []);
 const { lineAddressOf } = await import('../src/fleet/host/pve-setup.js');
  assert.equal(lineAddressOf('10.69.10.10 fd00::10\n'), '10.69.10.10:8006');
  assert.equal(lineAddressOf(''), null);
  assert.equal(lineAddressOf('$(reboot)'), null);
  assert.throws(() => holderJoinCommand({ hostId: 'build', pin: '482913', address: 'a:8006' }), /not a name/);
  assert.throws(() => holderJoinCommand({ hostId: 'holder-0a0b0c', pin: '48291; reboot', address: 'a:8006' }), /not an enrolment pin/);
  assert.throws(() => holderJoinCommand({ hostId: 'holder-0a0b0c', pin: '482913', address: 'a b' }), /not the address/);
  assert.match(holderJoinCommand({ hostId: 'holder-0a0b0c', pin: '482913', address: '10.69.10.10:8006' }), /^umask 077; printf %s [A-Za-z0-9+/=]+ \| base64 -d >\/root\/\.fleetwright-holder-join$/);
  // THE SCRIPT: its flags, its step, the line it says a removed machine with,
  // and the same first-boot lines as a Xen Orchestra pool's own machine.
  const script = readFileSync(new URL('../install/fleetwright-pve-setup', import.meta.url), 'utf8');
  for (const flag of ['--holder-join', '--holder-again']) assert.ok(script.includes(`    ${flag})`), `the script does not read ${flag}`);
  assert.match(script, /^step holder$/m);
  assert.match(script, /printf 'fleetwright-holder-removed: %s\\n'/);
  assert.match(script, /role FleetwrightHolder "VM\.Audit"/);
  assert.match(script, /unless \(\$j->\{address\} \/\/ ""\) eq \$ENV\{ADDRESS\}/, 'the script takes a pin reserved for another address');
  assert.equal(pveSetupMod.ADDRESS_FIND, "hostname -I | awk '{print $1}'");
  assert.match(script, /ip="\$\(hostname -I \| awk '\{print \$1\}'\)"\n[^\n]*\n\s*ADDRESS="\$ip:8006"/, 'the script works the address out another way than the box asks it');
  const heredoc = (/** @type {string} */ tag) => new RegExp(`<<'${tag}'\\n([\\s\\S]*?)\\n${tag}\\n`).exec(script)?.[1];
  assert.equal(heredoc('UPGRADE'), UPGRADE_RUNCMD);
  assert.equal(heredoc('JOIN'), JOIN_RUNCMD);
  const xo = holderCloudConfig({ hostId: 'holder-0a0b0c', pin: '482913', coordinatorUrl: FLEET, address: NODE });
  assert.ok(xo.includes(UPGRADE_RUNCMD) && xo.includes(JOIN_RUNCMD), 'Xen Orchestra’s holder boots with other lines than these');
  assert.match(script, /printf '#cloud-config\\nhostname: %s\\nwrite_files:\\n  - path: \/run\/fleetwright\/join\.json\\n'/);
  assert.ok(xo.startsWith('#cloud-config\nhostname: holder-0a0b0c\nwrite_files:\n  - path: /run/fleetwright/join.json\n    permissions: \'0600\'\n    owner: root:root\n    content: |\n'));
});

test('the options carry what the machines may do from chat to the script, both answers or neither', async () => {
  const { optionArgs } = await import('../src/fleet/host/pve-setup.js');
  assert.equal(optionArgs({ grants: { upgrades: true, reboot: true } }), ' --grants upgrades,reboot');
  assert.equal(optionArgs({ grants: { upgrades: false, reboot: true } }), ' --grants reboot');
  assert.equal(optionArgs({ grants: { upgrades: false, reboot: false } }), ' --grants none');
  assert.equal(optionArgs({ grants: { upgrades: true } }), '', 'half an answer went to the script');
  assert.equal(optionArgs({}), '');
});
