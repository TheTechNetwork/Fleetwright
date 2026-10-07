// Installing Xen Orchestra on a pool that has none, from the machine that runs
// it, and then adding that pool in the same job.
//
//   node --test test/xo-deploy.test.js
//
// ASKED FOR: the ROADMAP's "deploying Xen Orchestra with the installer's
// xo-remote-deploy.sh", so a pool without Xen Orchestra can be added from the
// phone with its master's root password. docs/hypervisors.md.
//
// THE BOUNDARIES ARE REAL; THE FAR SIDE OF THEM IS NOT. The job runs the
// actual xo-deploy.js and xo-setup.js against `ssh`, `ssh-keyscan` and `xe`
// on PATH that play a pool master (helpers/fake-pool-master.mjs: it refuses a
// host key that is not pinned and a password that is wrong, and refuses any
// ssh that does not ride the master), a stand-in for the installer's script
// with its command line, its use of ssh and its output, and the suite's
// stand-in Xen Orchestra serving the certificate the job made. The real
// script is GPL and is not vendored here; it was run through these same
// fakes when it was pinned, through all six of its stages (docs/hypervisors.md
// says so, and what has not run).

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { XoSetups, FLEET_USER } from '../src/fleet/host/xo-setup.js';
import { probe } from '../src/fleet/host/xo-setup.js';
import { INSTALLER, makeCertificate, parseKeyscan, sshFingerprint, sshProbe } from '../src/fleet/host/xo-deploy.js';
import { connectXo, connectPinnedTls } from '../src/fleet/host/xo-ws.js';
import { XODEPLOY_STEPS } from '../src/fleet/protocol/intents.js';
import { seal, open, newSealKey, xodeployAad, xosetupAad, xosetupHandoffAad } from '../src/fleet/seal.js';
import { generateKeyPair, sign, verify, signingInput, fingerprint } from '../src/fleet/crypto.js';

import { standIn } from './helpers/xo-stand-in.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_PASSWORD = 'pool-root-password-7';
const NEW_ADMIN = 'a-new-admin-password-42';
const POOL_MASTER = 'xcp1.test';

/** An SSH host key blob, as known_hosts and ssh-keyscan write it. */
function hostKeyBlob() {
  const raw = /** @type {Buffer} */ (generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' })).subarray(-32);
  /** @param {Buffer} b */
  const field = (b) => {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return Buffer.concat([n, b]);
  };
  return Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64');
}

/**
 * A pool master on PATH, and the installer the job will be handed.
 *
 * @param {{ password?: string, scanned?: string, mode?: 'done'|'failed', unreachable?: boolean }} [opts]
 *   `scanned` is the key ssh-keyscan reports, when it is not the pool's own.
 */
function poolMaster({ password = ROOT_PASSWORD, scanned, mode = 'done', unreachable = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xo-pool-'));
  const bin = path.join(dir, 'bin');
  const poolPath = path.join(dir, 'pool');
  const seen = path.join(dir, 'seen');
  mkdirSync(bin);
  mkdirSync(poolPath);
  const blob = hostKeyBlob();
  const logPath = path.join(dir, 'log.jsonl');
  const config = path.join(dir, 'config.json');
  const keys = [{ type: 'ssh-ed25519', blob }];
  writeFileSync(config, JSON.stringify({
    keys,
    password,
    unreachable,
    log: logPath,
    poolPath,
    xe: {
      'pool-list': 'pool-1',
      'pool-param-get': 'host-1',
      'sr-list': 'sr-1',
      'sr-param-get': 'Local storage',
      'pif-list': 'net-1',
      'network-param-get': 'Pool-wide network associated with eth0',
      'network-list': 'net-1',
      'vm-list': '',
    },
  }));
  /** @param {string} where @param {string} role @param {string} [file] */
  const wrap = (where, role, file = config) => {
    writeFileSync(path.join(where, role), `#!/bin/sh\nFAKE_POOL_CONFIG='${file}' exec '${process.execPath}' '${path.join(HERE, 'helpers', 'fake-pool-master.mjs')}' ${role} "$@"\n`);
    chmodSync(path.join(where, role), 0o755);
  };
  wrap(bin, 'ssh');
  wrap(poolPath, 'xe');
  if (scanned) {
    // ssh-keyscan reports another key: the one a server in the way presents.
    const other = path.join(dir, 'other.json');
    writeFileSync(other, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), keys: [{ type: 'ssh-ed25519', blob: scanned }] }));
    wrap(bin, 'ssh-keyscan', other);
  } else {
    wrap(bin, 'ssh-keyscan');
  }
  process.env.PATH = `${bin}:${path.dirname(process.execPath)}:${process.env.PATH}`;

  // THE INSTALLER'S SCRIPT, STOOD IN FOR: what xo-deploy.js gives it and
  // reads back. It rides ssh exactly as the real one builds its command,
  // SSH_OPTS first, and leaves what it was handed where the test can see it.
  const script = `#!/bin/bash
set -u
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -H) TARGET="$2" ;;
    --network) NETWORK="$2" ;;
    --name) NAME="$2" ;;
    --os) OS="$2" ;;
    --ssh-key) SSHKEY="$2" ;;
    --config) CONFIG="$2" ;;
    *) echo "unknown option $1"; exit 1 ;;
  esac
  shift 2
done
read -r -a ssh_opts <<<"\${SSH_OPTS:-}"
SSH_CTRL_DIR=$(mktemp -d)
SSH_CMD=(ssh "\${ssh_opts[@]}" -o ControlMaster=auto -o ControlPath="$SSH_CTRL_DIR/cm" -o ControlPersist=120)
mkdir -p '${seen}'
cp "$SCRIPT_DIR/plugins/fleetwright-https/cert.pem" "$SCRIPT_DIR/plugins/fleetwright-https/key.pem" "$CONFIG" "$SSHKEY" '${seen}/'
[ -f "$SCRIPT_DIR/xo-install.sh" ] && printf '%s\\n' "$NETWORK" > '${seen}/network'
echo "Connecting to $TARGET..."
"\${SSH_CMD[@]}" "$TARGET" "bash -s" <<'REMOTE' || exit $?
echo "[1/6] Setting up network"
echo "[2/6] Downloading and importing debian13 image"
echo "  downloaded 40%" >&2
echo "  downloaded 100%" >&2
sleep 0.3 # minutes, on a pool: the bar is drawn before the VM is made
echo "[3/6] Creating and starting VM fleetwright-xo"
echo "  VM 0f0f0f0f-1111-2222-3333-444444444444 created with 2 vCPU, 4096 MiB memory and 20 GiB disk, starting it"
echo "[4/6] Booting VM and running cloud-init (1-3 minutes)"
echo "12:00:01   VM address: 127.0.0.1"
echo "[5/6] Installing dependencies: packages, node.js and yarn (3-6 minutes)"
echo "[6/6] Building and starting Xen Orchestra (about 10 minutes)"
echo "12:09:30   [ok] Starting xo-server..."
REMOTE
if [ '${mode}' = done ]; then
  echo "Xen Orchestra is installed and running"
  echo "Web UI: https://127.0.0.1 (admin@admin.net / admin)"
else
  echo "Xen Orchestra installation failed inside the VM. See /var/log/xo-install.log and /opt/xo-installer/logs in the VM"
  exit 1
fi
`;
  const files = { 'xo-remote-deploy.sh': Buffer.from(script), 'xo-install.sh': Buffer.from('#!/bin/bash\n# stands in for the installer inside the VM\n') };
  const installer = {
    ...INSTALLER,
    base: 'https://installer.test/',
    files: Object.fromEntries(Object.entries(files).map(([f, b]) => [f, createHash('sha256').update(b).digest('hex')])),
  };
  /** @type {typeof globalThis.fetch} */
  const fetch = async (url) => new Response(/** @type {any} */ (files)[String(url).slice('https://installer.test/'.length)]);
  const log = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const pin = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('hex');
  return { blob, sshKey: sshFingerprint(blob), pin, seen, installer, fetch, files, log };
}

/**
 * A machine with an enrolment key, and Xen Orchestra where the installer
 * said: started, as the VM would be, with the certificate and key the job
 * put in the installer's directory, the first time the job reaches for it.
 *
 * @param {import('node:test').TestContext} t
 * @param {ReturnType<typeof poolMaster>} pool
 * @param {{ adminPassword?: string, fetch?: typeof globalThis.fetch }} [opts]
 */
async function machine(t, pool, { adminPassword = 'admin', fetch = pool.fetch } = {}) {
  const keys = await generateKeyPair();
  /** @type {any[]} */
  const events = [];
  /** @type {any} */
  let xo = null;
  const setups = new XoSetups({
    signer: { publicJwk: keys.publicJwk, sign: (m) => sign(keys.privateJwk, m) },
    emit: (e) => events.push(e),
    stateDir: mkdtempSync(path.join(os.tmpdir(), 'xo-state-')),
    fingerprint,
    installer: pool.installer,
    fetch,
    xoRetryMs: 20,
    connect: async ({ address, pin }) => {
      if (address !== '127.0.0.1') return connectXo({ address, pin });
      if (!xo) {
        const cert = readFileSync(path.join(pool.seen, 'cert.pem'), 'utf8');
        const madePin = createHash('sha256').update(new X509Certificate(cert).raw).digest('hex');
        xo = await standIn(t, { tls: { cert, key: readFileSync(path.join(pool.seen, 'key.pem'), 'utf8'), pin: madePin }, adminPassword });
      }
      return connectXo({ address: xo.address, pin });
    },
  });
  return { setups, events, xo: () => xo };
}

/** The phone's half: check the key against the pool master's host key, and seal both passwords and a reply key. */
async function phone(/** @type {any} */ begun, /** @type {string} */ pin, adminPassword = NEW_ADMIN) {
  const { job, key, keySig, hostKey } = begun.xosetup;
  const signed = await verify(hostKey, keySig, signingInput('xodeploy-key', { address: POOL_MASTER, job, key, pin }));
  const reply = await newSealKey();
  const box = await seal({ to: key, aad: xodeployAad(job, POOL_MASTER), payload: { v: 1, purpose: 'deploy', root: { password: ROOT_PASSWORD }, xo: { password: adminPassword }, reply: reply.publicKey } });
  return { signed, sealed: `${box.epk}.${box.iv}.${box.ct}`, reply };
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

/** Begin, check, send: the job running, as a phone would leave it. */
async function install(/** @type {Awaited<ReturnType<typeof machine>>} */ m, /** @type {ReturnType<typeof poolMaster>} */ pool, adminPassword = NEW_ADMIN) {
  const actor = 'eli@example.com';
  const begun = await m.setups.beginDeploy({ address: POOL_MASTER, pin: pool.pin, actor });
  assert.equal(begun.ok, true, begun.text);
  const { signed, sealed, reply } = await phone(begun, pool.pin, adminPassword);
  const ran = await m.setups.run({ job: begun.xosetup.job, sealed, actor });
  return { begun, signed, ran, reply, end: ran.ok ? await finished(m.setups, begun.xosetup.job) : ran.xosetup };
}

test('a pool with no Xen Orchestra gets one, and is added with it, from two passwords', async (t) => {
  const pool = poolMaster();
  const m = await machine(t, pool);
  const { begun, signed, ran, reply, end } = await install(m, pool);
  // THE PHONE CAN TELL THE KEY IS THIS MACHINE'S, FOR THIS POOL MASTER: its
  // own context, over the host key the person accepted, so a setup's key
  // check cannot pass for it.
  assert.equal(signed, true);
  assert.equal(await verify(begun.xosetup.hostKey, begun.xosetup.keySig, signingInput('xosetup-key', { address: POOL_MASTER, job: begun.xosetup.job, key: begun.xosetup.key, pin: '' })), false);
  assert.equal(ran.ok, true, ran.text);
  assert.equal(end.state, 'done', end.text);

  // EVERY STEP IN ORDER: its own, the installer's six as the script said
  // them, then onboarding's, under the install's own purpose.
  const running = m.events.filter((e) => e.state === 'running');
  assert.deepEqual([...new Set(running.map((e) => e.phase))], [...XODEPLOY_STEPS]);
  assert.ok(m.events.every((e) => e.purpose === 'deploy'));
  assert.ok(running.some((e) => e.phase === 'image' && e.fill === 1000), 'the download moves the bar');

  // THE INSTALLER WAS HANDED what this machine made: HTTPS with its own
  // certificate, the pool master's own network, and a key nobody holds.
  const config = readFileSync(path.join(pool.seen, 'xo-install.cfg'), 'utf8');
  assert.match(config, /^PATH_TO_HTTPS_CERT="\/opt\/xo-installer\/plugins\/fleetwright-https\/cert.pem"$/m);
  assert.match(config, /^AUTOCERT="false"$/m);
  assert.equal(readFileSync(path.join(pool.seen, 'network'), 'utf8').trim(), 'Pool-wide network associated with eth0');
  assert.match(readFileSync(path.join(pool.seen, 'xo.pub'), 'utf8'), /^ssh-ed25519 [A-Za-z0-9+/=]+ /);

  // THE DEFAULT ADMIN PASSWORD IS GONE, and onboarding signed in with the
  // new one, which is how the job knows it took.
  const xo = m.xo();
  assert.equal(xo.passwords.get('admin@admin.net'), NEW_ADMIN);
  const signIns = xo.calls.filter((/** @type {any} */ c) => c.method === 'session.signIn' && c.params.email === 'admin@admin.net');
  assert.deepEqual(signIns.map((/** @type {any} */ c) => c.params.password), ['admin', NEW_ADMIN]);
  assert.equal(xo.calls.find((/** @type {any} */ c) => c.method === 'token.create')?.as, FLEET_USER);

  // HANDED BACK AS A SETUP'S IS, under the pool master the phone began with,
  // naming the Xen Orchestra the installer put there and the pin made for it.
  const [epk, iv, ct] = String(end.handoff).split('.');
  const kept = /** @type {any} */ (await open({ ...reply, aad: xosetupHandoffAad(end.job, POOL_MASTER), sealed: { epk, iv, ct } }));
  assert.equal(kept.address, '127.0.0.1');
  assert.equal(kept.poolMaster, POOL_MASTER);
  assert.equal(kept.pin, xo.pin);
  assert.equal(kept.certificate.made, true);
  assert.equal(kept.token, 'tok-limited-123');

  // THE ROOT PASSWORD WAS TYPED ONCE, into the master, through the askpass
  // socket: in no argument and no environment, and every other ssh rode
  // the master unable to ask for one.
  const ssh = pool.log().filter((e) => e.role === 'ssh');
  const masters = ssh.filter((e) => e.argv.includes('ControlMaster=yes'));
  assert.equal(masters.length, 1);
  for (const e of ssh) {
    assert.equal(e.password, false, 'no password in any environment');
    assert.ok(!e.argv.join(' ').includes(ROOT_PASSWORD), 'no password in any argument');
  }
  const riders = ssh.filter((e) => !e.argv.includes('ControlMaster=yes') && !e.argv.includes('-O') && e.argv.includes('ControlMaster=no'));
  assert.ok(riders.length >= 2, 'the pool was read, and the installer ran, through the master');
  for (const e of riders) {
    const auto = e.argv.indexOf('ControlMaster=auto');
    assert.ok(auto === -1 || e.argv.indexOf('ControlMaster=no') < auto, 'this machine’s options come first, and the first wins');
    assert.ok(e.argv.includes('BatchMode=yes'));
  }
  // The installer's own ControlPath came after this machine's, so it lost.
  const control = masters[0].argv.find((/** @type {string} */ a) => a.startsWith('ControlPath='));
  assert.ok(riders.every((e) => e.argv.find((/** @type {string} */ a) => a.startsWith('ControlPath=')) === control));
  // And the job's directory, with the certificate's key and the SSH files, is gone.
  assert.equal(existsSync(path.dirname(control.slice('ControlPath='.length))), false);

  // NEITHER PASSWORD IN ANYTHING THE COORDINATOR RELAYS.
  const relayed = JSON.stringify({ events: m.events, end });
  assert.ok(!relayed.includes(ROOT_PASSWORD) && !relayed.includes(NEW_ADMIN));
});

test('an install stops before anything reaches a pool master it cannot vouch for', async (t) => {
  for (const [name, opts, where, words] of /** @type {const} */ ([
    ['a different host key', { scanned: hostKeyBlob() }, 'reach', /different SSH host key/],
    ['a wrong root password', { password: 'not-the-one' }, 'reach', /refused the root password/],
  ])) {
    const pool = poolMaster(opts);
    const m = await machine(t, pool);
    const { end } = await install(m, pool);
    assert.equal(end.state, 'failed', name);
    assert.equal(end.phase, where, name);
    assert.match(end.text, words, name);
    // Nothing rode a master that never came up: the pool was not read, and
    // the installer was neither fetched nor run.
    assert.equal(pool.log().filter((e) => e.role === 'xe').length, 0, name);
    assert.equal(existsSync(pool.seen), false, name);
    assert.ok(!JSON.stringify({ events: m.events, end }).includes(ROOT_PASSWORD), name);
  }
});

test('an installer that is not the pinned one is not run', async (t) => {
  const pool = poolMaster();
  const m = await machine(t, pool, {
    fetch: async (url) => new Response(String(url).endsWith('xo-remote-deploy.sh') ? '#!/bin/bash\necho something else\n' : /** @type {any} */ (pool.files)['xo-install.sh']),
  });
  const { end } = await install(m, pool);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'installer');
  assert.match(end.text, /not the one pinned for commit/);
  assert.equal(existsSync(pool.seen), false, 'the script never ran');
});

test('a Xen Orchestra whose default password somebody else changed first is left alone', async (t) => {
  const pool = poolMaster();
  const m = await machine(t, pool, { adminPassword: 'changed-by-somebody-else' });
  const { end } = await install(m, pool);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'admin');
  assert.match(end.text, /no longer takes its default admin password/);
  assert.equal(m.xo().calls.filter((/** @type {any} */ c) => c.method === 'user.set' || c.method === 'user.create').length, 0);
});

test('an install that failed inside its VM says so and where the VM is', async (t) => {
  const pool = poolMaster({ mode: 'failed' });
  const m = await machine(t, pool);
  const { end } = await install(m, pool);
  assert.equal(end.state, 'failed');
  assert.equal(end.phase, 'build');
  assert.match(end.text, /failed inside its VM\. Its VM, fleetwright-xo \(0f0f0f0f-1111-2222-3333-444444444444\), was kept/);
  assert.equal(m.xo(), null, 'nothing reached for a Xen Orchestra that is not there');
});

test('an install is refused what it cannot use, before the pool is asked anything', async (t) => {
  const pool = poolMaster();
  const m = await machine(t, pool);
  const actor = 'eli@example.com';
  // Not a host key's digest: nothing to pin the SSH connection to.
  const none = await m.setups.beginDeploy({ address: POOL_MASTER, pin: pool.sshKey, actor });
  assert.equal(none.ok, false);
  // An admin password shorter than the phone allows.
  const { end } = await install(m, pool, 'short');
  assert.equal(end.state, 'failed');
  assert.match(end.text, /12 to 256 characters/);
  // A setup's sign-in does not open as an install's passwords.
  const begun = await m.setups.beginDeploy({ address: POOL_MASTER, pin: pool.pin, actor });
  const reply = await newSealKey();
  const box = await seal({ to: begun.xosetup.key, aad: xosetupAad(begun.xosetup.job, POOL_MASTER), payload: { v: 1, purpose: 'deploy', root: { password: ROOT_PASSWORD }, xo: { password: NEW_ADMIN }, reply: reply.publicKey } });
  const wrong = await m.setups.run({ job: begun.xosetup.job, sealed: `${box.epk}.${box.iv}.${box.ct}`, actor });
  assert.equal(wrong.ok, false);
  assert.equal(pool.log().length, 0, 'nothing was asked of the pool master');
});

test('the certificate made for Xen Orchestra is one TLS serves, and the pin holds a connection to it', async (t) => {
  const made = makeCertificate({ now: Date.parse('2026-10-07T00:00:00Z') });
  const x = new X509Certificate(made.cert);
  assert.equal(createHash('sha256').update(x.raw).digest('hex'), made.pin);
  assert.ok(x.verify(x.publicKey), 'self-signed with its own key');
  assert.equal(x.ca, false);
  assert.equal(made.notAfter, '2036-10-04T00:00:00.000Z');
  const server = tls.createServer({ key: made.key, cert: made.cert }, (s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => server.close());
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const socket = await connectPinnedTls({ host: '127.0.0.1', port, pin: made.pin });
  socket.destroy();
  await assert.rejects(connectPinnedTls({ host: '127.0.0.1', port, pin: makeCertificate().pin }));
});

test('an SSH host key fingerprint is the one OpenSSH prints', () => {
  // GitHub's published ed25519 host key and the fingerprint it publishes for it.
  const github = 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
  assert.equal(sshFingerprint(github), 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU');
  const keys = parseKeyscan(`# github.com:22 SSH-2.0-babeld\ngithub.com ssh-ed25519 ${github}\ngithub.com ssh-dss AAAAB3NzaC1kc3M=\nnoise\n`);
  assert.deepEqual(keys.map((k) => [k.type, k.fingerprint]), [['ssh-ed25519', 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU']]);
});

test('the probe of an address with no Xen Orchestra reports its SSH host key, and nothing answering is not a key', async () => {
  const pool = poolMaster();
  // Nothing answers HTTPS or HTTP at port 1, which is a pool master that
  // serves no Xen Orchestra; its SSH server is the fake's.
  const found = /** @type {any} */ (await probe('127.0.0.1:1', { timeoutMs: 1000 }));
  assert.equal(found.reachable, false);
  assert.equal(found.ssh.reachable, true);
  assert.deepEqual(found.ssh.keys, [{ type: 'ssh-ed25519', fingerprint: pool.sshKey, sha256: pool.pin }]);
  assert.equal(found.ssh.deploy, found.ssh.missing.length === 0);
  poolMaster({ unreachable: true });
  const none = await sshProbe(POOL_MASTER);
  assert.equal(none.ssh.reachable, false);
  assert.deepEqual(none.ssh.keys, []);
});

test('through a phone the probe makes one attempt over HTTPS, and takes no look over SSH', async () => {
  // A pool master whose SSH server answers this machine. Through a phone the
  // question is what the PHONE's network reaches, and it carries HTTPS only,
  // so this machine's own ssh-keyscan answering would be a wrong answer.
  const pool = poolMaster();
  let attempts = 0;
  const through = async () => {
    attempts += 1;
    return net.connect(1, '127.0.0.1');
  };
  const found = /** @type {any} */ (await probe('127.0.0.1:1', { through, timeoutMs: 1000 }));
  assert.equal(found.reachable, false);
  assert.equal(found.ssh, undefined);
  assert.equal(attempts, 1, 'one connection through the phone, and no plain HTTP after it');
  assert.deepEqual(pool.log(), [], 'ssh-keyscan was not run');
});
