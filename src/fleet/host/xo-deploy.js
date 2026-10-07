// Installing Xen Orchestra on a pool that has none, from a machine already in
// the fleet. docs/hypervisors.md, "A pool without Xen Orchestra"; xo-setup.js
// runs this as the first half of one job and goes on into onboarding against
// the Xen Orchestra it made, so the person types two passwords once and gets
// a pool back.
//
// WHY THE INSTALLER'S OWN SCRIPT, and not ours. XenOrchestraInstallerUpdater's
// `xo-remote-deploy.sh` already does the hard part from a workstation: SSH to
// the pool master, a cloud image checked against its publisher's checksum and
// cached on the storage repository, a VM booted with cloud-init that runs
// `xo-install.sh`, and progress read back through xenstore so nothing has to
// reach the VM until it is done. Rewriting that would be a second installer
// to keep current. So the machine runs the script, as a person at a terminal
// would, and does the three things a terminal would have done by hand: type
// the root password, choose a network, and change the default admin password.
//
// THE SCRIPT IS PINNED, like OPNsense's image (edge-router.js) and Debian's
// (vm-image.js). INSTALLER names one commit of the repository, and each file
// the script needs is downloaded from that commit and checked against its own
// SHA-256 before anything runs: the deploy script, `xo-install.sh` (which runs
// inside the VM as root), and the update plugin it bundles. A file that does
// not match stops the job before the pool master is asked for anything. Moving
// the pin is reading the new script, then changing the commit and the hashes
// here, and nothing else; nothing is worked out at run time that could
// disagree with what was read. The script lives in the 00o-sh fork, which is
// the one `docs/hypervisors.md` already cites for the update plugin; ronivay's
// upstream does not have it.
//
// THE ROOT PASSWORD IS TYPED ONCE AND FORGOTTEN, which is the part a terminal
// would have got wrong. The script calls `ssh` many times and expects a person
// to answer a prompt, so this machine opens ONE OpenSSH master connection to
// the pool master itself, answers its password prompt through SSH_ASKPASS
// from a socket only this process can reach, wipes the password the moment the
// master is up, and hands the script an SSH_OPTS whose ControlPath and
// `ControlMaster=no` come first. OpenSSH takes the first value it is given for
// each option, so every `ssh` the script makes rides that master and none of
// them can ask for a password (`BatchMode=yes`). The password is never in an
// environment variable, an argument, a file or the script's process.
//
// THE POOL MASTER IS HELD TO THE HOST KEY THE PERSON ACCEPTED. The probe
// reports what `ssh-keyscan` gets at the address on port 22, beside the
// HTTPS look, whenever Xen Orchestra did not answer there; the phone shows it
// and the person compares it with the pool master's console. The job is
// begun with that key's SHA-256 in hex as its pin. Here the key is scanned
// again, and only a key with that digest is written to a known_hosts file
// of this job's own, with `StrictHostKeyChecking=yes`, so a server answering
// with any other key is refused by ssh before the password is offered.
//
// XEN ORCHESTRA'S CERTIFICATE IS ONE THIS MACHINE MADE, so the pin is known
// before Xen Orchestra exists and nobody is asked to trust a certificate that
// was minted a minute ago inside a VM they cannot see. The script copies every
// file under its `plugins/` directory into the VM through cloud-init, and the
// installer reads its configuration as shell; the configuration this machine
// writes points PATH_TO_HTTPS_CERT and PATH_TO_HTTPS_KEY at a certificate and
// key placed there, with AUTOCERT off and HTTPS on 443. `xo-install.sh` checks
// the pair matches before it starts Xen Orchestra. cloud-init writes those
// files 0644, so the key is readable by every account in that VM; the VM has
// no accounts but root and `xo` (which has sudo), and a daemon inside it that
// could read the key could read Xen Orchestra's own database.
//
// THE DEFAULT ADMIN IS CHANGED BEFORE ANYTHING ELSE TOUCHES IT. The installer
// leaves `admin@admin.net` / `admin`, and says so; anybody on that network can
// sign in with it until it changes. The person chooses the new password on the
// phone, sealed with the root password; the moment the script says Xen
// Orchestra is up, this machine signs in with the default over the pinned
// certificate and sets theirs, and onboarding then signs in with the new one,
// which is the proof it took. If the default no longer works, somebody signed
// in first, and the job stops saying so rather than going on.
//
// THE VM GETS NO LOGIN ANYBODY HOLDS. The script puts a public key on the VM's
// `xo` account, defaulting to the running user's own; this machine gives it a
// key made for the job whose private half is never kept, so the VM's password
// stays locked and nobody can SSH into it. Xen Orchestra is how it is managed.
//
// WHAT HAS RUN, AND WHAT HAS NOT. Run here: the pinned script itself, through
// all six of its stages, against a stand-in `ssh` that runs its remote half
// locally with stand-in `xe` and `xenstore-read`, with the password answered
// through the askpass socket and every client riding the master. NOT RUN: a
// real XCP-ng pool master, a real Debian download, and xo-install.sh building
// Xen Orchestra. The suite's test drives a stand-in script with the same
// command line and output instead, because the real one is GPL and this
// repository does not vendor it.

import { createHash, generateKeyPairSync, randomBytes, sign as signWith } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitAddress } from './xo-ws.js';

/**
 * The installer, pinned: one commit, and the SHA-256 of every file the deploy
 * reads from it. `xo-remote-deploy.sh` looks for `xo-install.sh` beside itself
 * and copies its `plugins/` directory into the VM; the update plugin's test
 * directory is the one thing it leaves out, so it is not fetched.
 */
export const INSTALLER = Object.freeze({
  repository: '00o-sh/XenOrchestraInstallerUpdater',
  commit: 'f9b299fccdb34da416498d969e587876768c2cf8',
  base: 'https://raw.githubusercontent.com/00o-sh/XenOrchestraInstallerUpdater/f9b299fccdb34da416498d969e587876768c2cf8/',
  files: Object.freeze({
    'xo-remote-deploy.sh': 'e5f234bae9c6eb9e65d3793c54f151ebfb0271c0b07929a4394ff00cd1ce47c3',
    'xo-install.sh': 'e6d2fd5bec5bb916af8a5d06973d4387f1a40a1c97026b3029796a668c361489',
    'plugins/xo-server-installer-updates/index.js': 'f53b7c95495bc3b2bc0de185f70e8ec65f491487cf3c99df31507cd4085a55bd',
    'plugins/xo-server-installer-updates/package.json': '7466da2f7895ead652a7088062f705aaf891ba553a0a4450fe1d945cb0ba7982',
    'plugins/xo-server-installer-updates/README.md': '8fc76a9b32de83b0b799d691a870f03fef61f97634d896dfb56255ba2dfa9a5c',
  }),
});

/** The VM the installer makes, by name: also its host name, and what a second install looks for. */
export const XO_VM_NAME = 'fleetwright-xo';
/** What the installer leaves Xen Orchestra's admin as, and what is changed first. */
export const DEFAULT_ADMIN = Object.freeze({ email: 'admin@admin.net', password: 'admin' });
/** The shortest admin password the person may choose. The phone says the same. */
export const MIN_ADMIN_PASSWORD = 12;
/** The script's six stages, in its order: `[n/6]` is the n-th. XODEPLOY_STEPS names the same keys. */
export const STAGES = Object.freeze(['network', 'image', 'vm', 'boot', 'packages', 'build']);
/** Where the certificate and key go in the VM: a directory under the script's `plugins/`, which is not a plugin. */
const TLS_DIR = 'fleetwright-https';
/** The longest a file of the installer may be, so a wrong answer cannot fill the disk. */
const MAX_FILE = 2 * 1024 * 1024;
/** How long the script may run. Its own wait is 60 minutes; this is the backstop past it. */
const SCRIPT_LIMIT_MS = 80 * 60_000;

/**
 * What installing Xen Orchestra needs on this machine, as `command -v` finds
 * them. GNU getopt because the script parses long options with it, which the
 * BSD one on macOS cannot.
 */
export const DEPLOY_TOOLS = Object.freeze(['bash', 'ssh', 'ssh-keyscan', 'python3', 'getopt', 'sed', 'mktemp']);

/**
 * An SSH public key blob's fingerprint the way OpenSSH prints it.
 *
 * @param {string} blob  the key's base64, as known_hosts and ssh-keyscan write it
 */
export function sshFingerprint(blob) {
  return `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/**
 * The keys in `ssh-keyscan`'s output, each with its fingerprint as OpenSSH
 * prints it and the same digest in hex, the pin a job is begun with. Comment
 * lines and anything not of the shape `host type base64` are skipped.
 *
 * @param {string} text
 * @returns {{ type: string, blob: string, fingerprint: string, sha256: string }[]}
 */
export function parseKeyscan(text) {
  /** @type {{ type: string, blob: string, fingerprint: string, sha256: string }[]} */
  const keys = [];
  for (const line of String(text).split('\n')) {
    const m = /^\S+\s+(ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa)\s+([A-Za-z0-9+/]+={0,2})\s*$/.exec(line.trim());
    if (m && !keys.some((k) => k.blob === m[2])) {
      keys.push({ type: m[1], blob: m[2], fingerprint: sshFingerprint(m[2]), sha256: createHash('sha256').update(Buffer.from(m[2], 'base64')).digest('hex') });
    }
  }
  return keys;
}

/**
 * The pool master's address as ssh takes it: the host without brackets, on
 * port 22. A port in the address is Xen Orchestra's web port, which the
 * probe was asked about, not SSH's, which on an XCP-ng host is 22.
 *
 * @param {string} address
 */
export function sshTarget(address) {
  return { host: splitAddress(address).host, port: 22 };
}

/**
 * Run a program to its end, collecting what it wrote.
 *
 * @param {string} cmd @param {string[]} args
 * @param {{ input?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, error?: string }>}
 */
function run(cmd, args, { input, timeoutMs = 30_000, env = childEnv(), signal } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout, stderr, error: /** @type {Error} */ (e).message });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: /** @type {NodeJS.ErrnoException} */ (e).code || e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ code, stdout, stderr });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

/**
 * The environment every program here runs with: a PATH and a locale, and not
 * this process's own. No SSH_AUTH_SOCK, so no agent key is ever offered to a
 * pool master, and nothing of the sidecar's leaks into a script that prints.
 */
function childEnv(extra = {}) {
  return { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C', ...extra };
}

/** Which of DEPLOY_TOOLS this machine lacks. */
export async function missingTools() {
  const r = await run('bash', ['-c', `for t in ${DEPLOY_TOOLS.join(' ')}; do command -v "$t" >/dev/null 2>&1 || echo "$t"; done; getopt -T >/dev/null 2>&1; [ $? -eq 4 ] || echo getopt`]);
  if (r.code !== 0 && r.error) return [...DEPLOY_TOOLS];
  return DEPLOY_TOOLS.filter((t) => r.stdout.split('\n').includes(t));
}

/**
 * The host keys at an address, from `ssh-keyscan`.
 *
 * @param {string} address @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ ok: true, keys: ReturnType<typeof parseKeyscan> } | { ok: false, missing: boolean, error: string }>}
 */
export async function scanHostKeys(address, { timeoutMs = 5_000, signal } = {}) {
  const { host, port } = sshTarget(address);
  const r = await run('ssh-keyscan', ['-T', String(Math.ceil(timeoutMs / 1000)), '-p', String(port), '-t', 'ed25519,ecdsa,rsa', host], { timeoutMs: timeoutMs + 3_000, signal });
  if (r.code === null && r.error === 'ENOENT') return { ok: false, missing: true, error: 'this machine has no ssh-keyscan' };
  const keys = parseKeyscan(r.stdout);
  if (!keys.length) return { ok: false, missing: false, error: 'no SSH server answered' };
  return { ok: true, keys };
}

/**
 * The SSH half of the probe, for a pool with no Xen Orchestra: can this
 * machine reach SSH at the address, with which host keys, and could it
 * install Xen Orchestra there. `probe` in xo-setup.js runs it beside its
 * HTTPS look and keeps `ssh` when Xen Orchestra did not answer.
 *
 * @param {string} address @param {{ signal?: AbortSignal }} [opts]
 */
export async function sshProbe(address, { signal } = {}) {
  const [scan, missing] = await Promise.all([scanHostKeys(address, { signal }), missingTools()]);
  const keys = scan.ok ? scan.keys.map((k) => ({ type: k.type, fingerprint: k.fingerprint, sha256: k.sha256 })) : [];
  const reachable = scan.ok ? true : scan.missing ? null : false;
  const deploy = missing.length === 0;
  const text = !scan.ok
    ? scan.missing
      ? `This machine cannot look for SSH at ${address}: it has no ssh-keyscan. Install openssh-client on it.`
      : `Nothing answered SSH at ${address} from here.`
    : deploy
      ? `The SSH server at ${address} answered with ${keys.length === 1 ? 'one host key' : `${keys.length} host keys`}.`
      : `The SSH server at ${address} answered, and this machine cannot install Xen Orchestra: it has no ${missing.join(', ')}.`;
  return { reachable: scan.ok, xo: null, tls: false, cert: null, certificate: null, version: null, ssh: { reachable, keys, deploy, missing }, text };
}

// ---------------------------------------------------------------------------
// The certificate Xen Orchestra serves, made here.
//
// DER by hand rather than a dependency or `openssl req`: a self-signed P-256
// certificate is a dozen fixed fields, Node signs and exports the key, and the
// machine then needs nothing it might not have. Parsed back by Node's own
// X509Certificate in the suite, and served over TLS there.

/** @param {number} n */
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** @param {number} tag @param {Buffer[]} parts */
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

/** @param {string} dotted */
function oid(dotted) {
  const arcs = dotted.split('.').map(Number);
  const out = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let v = arc >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return der(0x06, Buffer.from(out));
}

/** @param {Date} d */
function derTime(d) {
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  // UTCTime until 2050 and GeneralizedTime from then, as RFC 5280 requires.
  return d.getUTCFullYear() < 2050 ? der(0x17, Buffer.from(`${iso.slice(2)}Z`)) : der(0x18, Buffer.from(`${iso}Z`));
}

/** @param {string} label @param {Buffer} body */
function pem(label, body) {
  const lines = body.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * A self-signed P-256 certificate and its key, and the pin a connection is
 * held to: the SHA-256 of the certificate, as `certSha256` takes it.
 *
 * No subject alternative name: the VM's address comes from DHCP and is not
 * known until it has booted, and nothing checks the name, because every
 * connection the fleet makes to it compares the whole certificate.
 *
 * @param {{ commonName?: string, days?: number, now?: number }} [opts]
 */
export function makeCertificate({ commonName = 'Xen Orchestra (Fleetwright)', days = 3650, now = Date.now() } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01; // positive, and no leading zero to strip
  const name = der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, Buffer.from(commonName)))));
  const ecdsaSha256 = der(0x30, oid('1.2.840.10045.4.3.2'));
  const notBefore = new Date(now - 5 * 60_000);
  const notAfter = new Date(now + days * 24 * 60 * 60_000);
  const extensions = der(
    0xa3,
    der(
      0x30,
      // basicConstraints, critical: not a certificate authority.
      der(0x30, oid('2.5.29.19'), der(0x01, Buffer.from([0xff])), der(0x04, der(0x30))),
      // extendedKeyUsage: a server.
      der(0x30, oid('2.5.29.37'), der(0x04, der(0x30, oid('1.3.6.1.5.5.7.3.1')))),
    ),
  );
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ecdsaSha256,
    name,
    der(0x30, derTime(notBefore), derTime(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = signWith('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const cert = der(0x30, tbs, ecdsaSha256, der(0x03, Buffer.from([0]), signature));
  return {
    cert: pem('CERTIFICATE', cert),
    key: /** @type {string} */ (privateKey.export({ type: 'pkcs8', format: 'pem' })),
    pin: createHash('sha256').update(cert).digest('hex'),
    notAfter: notAfter.toISOString(),
  };
}

/**
 * The OpenSSH public key line for a key nobody keeps: the `xo` account's, so
 * the VM has a key and a locked password and no login anybody holds.
 */
export function unusableSshKey() {
  const { publicKey } = generateKeyPairSync('ed25519');
  // The last 32 bytes of Ed25519's SPKI are the key itself.
  const raw = /** @type {Buffer} */ (publicKey.export({ type: 'spki', format: 'der' })).subarray(-32);
  // SSH's wire format: each field a 32-bit length and its bytes.
  /** @param {Buffer} b */
  const field = (b) => {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    return Buffer.concat([n, b]);
  };
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64')} fleetwright-xo-nobody\n`;
}

/**
 * The installer's configuration for this VM. Only what differs from
 * `xo-install.sh`'s own defaults, which are the sample configuration's:
 * HTTPS on 443 with this machine's certificate, port 80 redirecting to it.
 * The script appends SELFUPGRADE=false and the update plugin itself.
 */
export function installerConfig() {
  const dir = `/opt/xo-installer/plugins/${TLS_DIR}`;
  return [
    '# Written by Fleetwright for the Xen Orchestra it installs on this pool.',
    '# HTTPS with a certificate the fleet made, so its fingerprint was known before',
    '# this VM existed. Replace the two files to use your own.',
    'PORT="80"',
    'HTTPS_REDIRECT="true"',
    `PATH_TO_HTTPS_CERT="${dir}/cert.pem"`,
    `PATH_TO_HTTPS_KEY="${dir}/key.pem"`,
    'AUTOCERT="false"',
    '',
  ].join('\n');
}

/**
 * The installer's files at the pinned commit, each checked before it is
 * written, laid out as the script expects to find them beside itself.
 *
 * @param {{ dir: string, installer?: typeof INSTALLER, fetch?: typeof globalThis.fetch, signal?: AbortSignal }} opts
 */
export async function fetchInstaller({ dir, installer = INSTALLER, fetch = globalThis.fetch, signal }) {
  for (const [file, sha256] of Object.entries(installer.files)) {
    const res = await fetch(new URL(file, installer.base), { signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`the installer's ${file} could not be downloaded (${res.status}). Nothing was asked of the pool.`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > MAX_FILE) throw new Error(`the installer's ${file} is larger than any version of it. Nothing was asked of the pool.`);
    const got = createHash('sha256').update(body).digest('hex');
    if (got !== sha256) {
      throw new Error(`the installer's ${file} is not the one pinned for commit ${installer.commit.slice(0, 12)}, so it was not run. Nothing was asked of the pool.`);
    }
    const to = path.join(dir, ...file.split('/'));
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, body, { mode: file.endsWith('.sh') ? 0o755 : 0o644 });
  }
}

/**
 * One connection to a pool master, as root, for one job.
 *
 * @typedef {object} PoolLink
 * @property {string} host
 * @property {number} port
 * @property {string[]} clientOpts  what every ssh riding the master is given, first
 * @property {(script: string, opts?: { timeoutMs?: number }) => Promise<{ code: number|null, stdout: string, stderr: string }>} remote
 * @property {() => Promise<void>} close
 */

/**
 * Open the master connection: the host key held to the one the person
 * accepted, the root password answered once through the askpass socket and
 * wiped, and every later ssh made unable to ask for one.
 *
 * `secret.password` is wiped here, on every way out.
 *
 * `hostKey` is the SHA-256 of the key the person accepted, in hex.
 *
 * @param {{ address: string, hostKey: string, secret: { password?: string }, dir: string, signal?: AbortSignal, timeoutMs?: number }} opts
 * @returns {Promise<PoolLink>}
 */
export async function openPool({ address, hostKey, secret, dir, signal, timeoutMs = 30_000 }) {
  try {
    const { host, port } = sshTarget(address);
    if (/\s/.test(dir)) throw new Error(`this machine's temporary directory has a space in its path (${dir}), which the installer cannot pass to ssh.`);
    const scan = await scanHostKeys(address);
    if (!scan.ok) throw new Error(scan.missing ? 'this machine has no ssh-keyscan. Install openssh-client on it.' : `nothing answered SSH at ${address} from here.`);
    const key = scan.keys.find((k) => k.sha256 === hostKey);
    if (!key) {
      throw new Error(`the pool master answered with a different SSH host key than the one you accepted (${scan.keys.map((k) => k.fingerprint).join(', ')}), so nothing was sent to it.`);
    }
    const knownHosts = path.join(dir, 'known_hosts');
    writeFileSync(knownHosts, `${port === 22 ? host : `[${host}]:${port}`} ${key.type} ${key.blob}\n`, { mode: 0o600 });
    const control = path.join(dir, 'cm');
    const common = ['-F', '/dev/null', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'StrictHostKeyChecking=yes', '-o', 'CheckHostIP=no', '-o', 'UpdateHostKeys=no'];
    const clientOpts = [...common, '-o', `ControlPath=${control}`, '-o', 'ControlMaster=no', '-o', 'BatchMode=yes', '-p', String(port)];

    // THE PASSWORD, through a socket in this job's own directory, answered
    // once and only to a password prompt.
    const socketPath = path.join(dir, 'pw.sock');
    const asked = await new Promise((resolve, reject) => {
      const server = net.createServer((c) => {
        let prompt = '';
        c.on('error', () => {});
        c.on('data', (d) => {
          prompt += d;
          if (!prompt.includes('\n')) return;
          if (/password/i.test(prompt) && secret.password) {
            c.end(`${secret.password}\n`);
            secret.password = undefined;
            server.close();
          } else {
            c.end();
          }
        });
      });
      server.on('error', reject);
      server.listen(socketPath, () => {
        chmodSync(socketPath, 0o600);
        resolve(server);
      });
    });
    const askpass = path.join(dir, 'askpass');
    const helper = fileURLToPath(new URL('./xo-askpass.js', import.meta.url));
    writeFileSync(askpass, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} "$@"\n`, { mode: 0o700 });

    // THE MASTER, backgrounded by ssh itself once it has authenticated (-f),
    // so its exit is the answer: 0 is signed in, anything else is the
    // reason, which -E writes to a file of this job's.
    const log = path.join(dir, 'ssh.log');
    const master = await run(
      'ssh',
      [
        ...common,
        '-o', `ControlPath=${control}`, '-o', 'ControlMaster=yes', '-o', 'ControlPersist=no',
        '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive,password',
        '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
        '-E', log, '-f', '-N', '-p', String(port), '-l', 'root', host,
      ],
      {
        timeoutMs,
        signal,
        env: childEnv({ SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'fleetwright', FLEETWRIGHT_ASKPASS_SOCKET: socketPath }),
      },
    );
    /** @type {import('node:net').Server} */ (asked).close();
    secret.password = undefined;
    rmSync(socketPath, { force: true });
    if (master.code !== 0) {
      let said = '';
      try {
        said = readFileSync(log, 'utf8');
      } catch {
        /* nothing written */
      }
      const why = /Permission denied|Authentication failed/i.test(said + master.stderr)
        ? 'the pool master refused the root password.'
        : /Host key verification failed|REMOTE HOST IDENTIFICATION/i.test(said + master.stderr)
          ? 'the pool master answered with a different SSH host key than the one you accepted, so the password was not sent.'
          : `SSH to the pool master did not connect: ${lastLine(said || master.stderr || master.error || 'no reason given')}`;
      throw new Error(why);
    }
    return {
      host,
      port,
      clientOpts,
      remote: (script, { timeoutMs: limit = 60_000 } = {}) => run('ssh', [...clientOpts, '-l', 'root', host, 'bash -s'], { input: script, timeoutMs: limit, signal }),
      close: async () => {
        await run('ssh', [...clientOpts, '-O', 'exit', '-l', 'root', host], { timeoutMs: 10_000 });
      },
    };
  } finally {
    secret.password = undefined;
  }
}

/** @param {string} s */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** @param {string} text */
function lastLine(text) {
  return printable(String(text).trim().split('\n').filter(Boolean).at(-1) ?? '').slice(0, 200);
}

/** @param {string} s */
function printable(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/**
 * What the pool master says about its pool, read before the installer is
 * asked for anything: that it is a pool master, its default storage, the
 * network its own management interface is on (where Xen Orchestra goes, so
 * it is on the network this machine reached the pool master on), and whether
 * an earlier install's VM is already there. Each value comes back in base64
 * so a name with anything in it is read as a name.
 *
 * @param {PoolLink} pool
 * @returns {Promise<{ network: string, sr: string, existing: boolean }>}
 */
export async function readPool(pool) {
  const r = await pool.remote(POOL_SCRIPT);
  /** @type {Record<string, string>} */
  const said = {};
  for (const line of r.stdout.split('\n')) {
    const m = /^fw-([a-z]+)=([A-Za-z0-9+/=]*)$/.exec(line.trim());
    if (m) said[m[1]] = Buffer.from(m[2], 'base64').toString('utf8');
  }
  if (said.error) throw new Error(printable(said.error).slice(0, 240));
  if (r.code !== 0 || !said.network) throw new Error(`the pool master did not say what its pool has: ${lastLine(r.stderr || r.stdout || 'no answer')}`);
  return { network: said.network, sr: said.sr || '', existing: said.existing === 'yes' };
}

const POOL_SCRIPT = String.raw`
say() { printf 'fw-%s=%s\n' "$1" "$(printf %s "$2" | base64 | tr -d '\n')"; }
fail() { say error "$1"; exit 0; }
command -v xe >/dev/null 2>&1 || fail "this is not an XCP-ng or XenServer host: it has no xe command."
pool=$(xe pool-list --minimal 2>&1) || fail "$pool"
master=$(xe pool-param-get uuid="$pool" param-name=master 2>&1) || fail "$master"
if [ -r /etc/xensource-inventory ]; then
  self=$(sed -n "s/^INSTALLATION_UUID='\(.*\)'$/\1/p" /etc/xensource-inventory)
  if [ -n "$self" ] && [ "$self" != "$master" ]; then
    fail "this host is a member of its pool, not the master: give the pool master's address, $(xe host-param-get uuid="$master" param-name=address 2>/dev/null)."
  fi
fi
sr=$(xe pool-param-get uuid="$pool" param-name=default-SR 2>/dev/null)
[ -n "$sr" ] && [ -n "$(xe sr-list uuid="$sr" --minimal 2>/dev/null)" ] || fail "the pool has no default storage repository, which the installer puts Xen Orchestra's disk on. Set one, then try again."
net=$(xe pif-list host-uuid="$master" management=true params=network-uuid --minimal 2>&1) || fail "$net"
[ -n "$net" ] || fail "the pool master has no management interface the installer could put Xen Orchestra beside."
name=$(xe network-param-get uuid="$net" param-name=name-label 2>&1) || fail "$name"
same=$(xe network-list name-label="$name" --minimal 2>/dev/null)
case "$same" in *,*) fail "the pool master's management network, $name, shares its name with another network, and the installer chooses a network by name. Rename one of them, then try again." ;; esac
say network "$name"
say sr "$(xe sr-param-get uuid="$sr" param-name=name-label 2>/dev/null)"
if [ -n "$(xe vm-list name-label=${XO_VM_NAME} --minimal 2>/dev/null)" ]; then say existing yes; else say existing no; fi
`;

/**
 * Lay out the installer for one run: the pinned files, this machine's
 * configuration, the certificate and key Xen Orchestra will serve, and the
 * `xo` account's key nobody holds.
 *
 * @param {{ dir: string, installer?: typeof INSTALLER, fetch?: typeof globalThis.fetch, signal?: AbortSignal }} opts
 */
export async function prepareInstaller({ dir, installer, fetch, signal }) {
  const root = path.join(dir, 'installer');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  await fetchInstaller({ dir: root, installer, fetch, signal });
  const tls = makeCertificate();
  const tlsDir = path.join(root, 'plugins', TLS_DIR);
  mkdirSync(tlsDir, { recursive: true });
  writeFileSync(path.join(tlsDir, 'cert.pem'), tls.cert, { mode: 0o644 });
  writeFileSync(path.join(tlsDir, 'key.pem'), tls.key, { mode: 0o600 });
  const config = path.join(dir, 'xo-install.cfg');
  writeFileSync(config, installerConfig(), { mode: 0o600 });
  const sshKey = path.join(dir, 'xo.pub');
  writeFileSync(sshKey, unusableSshKey(), { mode: 0o600 });
  return { root, script: path.join(root, 'xo-remote-deploy.sh'), config, sshKey, pin: tls.pin, notAfter: tls.notAfter };
}

/**
 * Run the installer's script and follow it. `on.stage` is called when the
 * script names one of its six stages, `on.say` with each line worth showing
 * and how far through the download it is, in thousandths, when it says.
 *
 * @param {{ pool: PoolLink, prepared: Awaited<ReturnType<typeof prepareInstaller>>, network: string, signal?: AbortSignal, on: { stage: (key: string) => void, say: (text: string, fill: number|null) => void } }} opts
 * @returns {Promise<{ address: string, vm: string|null }>}
 */
export function runInstaller({ pool, prepared, network, signal, on }) {
  return new Promise((resolve, reject) => {
    const args = [prepared.script, '-H', `root@${pool.host}`, '--network', network, '--name', XO_VM_NAME, '--os', 'debian13', '--ssh-key', prepared.sshKey, '--config', prepared.config];
    const child = spawn('bash', args, {
      cwd: prepared.root,
      // ITS OWN PROCESS GROUP, so a cancel stops the script and every ssh,
      // curl and python3 it started, not only bash.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({ SSH_OPTS: pool.clientOpts.join(' '), HOME: path.dirname(prepared.root), TMPDIR: path.dirname(prepared.root) }),
    });
    const stop = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    };
    const limit = setTimeout(stop, SCRIPT_LIMIT_MS);
    signal?.addEventListener('abort', stop, { once: true });
    /** @type {string[]} */
    const tail = [];
    /** @type {string|null} */
    let vm = null;
    /** @type {string|null} */
    let url = null;
    let outcome = /** @type {'done'|'failed'|'timeout'|'checksum'|null} */ (null);
    let stage = -1;
    /** @param {string} raw */
    const line = (raw) => {
      const text = printable(raw);
      if (!text) return;
      tail.push(text);
      if (tail.length > 6) tail.shift();
      const st = /^\[([1-6])\/6\]\s+(.*)$/.exec(text);
      if (st) {
        const n = Number(st[1]) - 1;
        if (n > stage) {
          stage = n;
          on.stage(STAGES[n]);
        }
        on.say(st[2], null);
        return;
      }
      // THE DOWNLOAD'S PERCENTAGES COME ON STDERR, and the stages on stdout,
      // each its own channel across ssh, so one can overtake the other. A
      // percentage is the image stage whatever has been read of stdout: it
      // starts that stage if its line has not arrived yet, and is dropped if
      // a later stage's already has, rather than drawn on the wrong bar.
      const pct = /^downloaded (\d{1,3})%$/.exec(text);
      if (pct) {
        if (stage > 1) return;
        if (stage < 1) {
          stage = 1;
          on.stage('image');
        }
        return void on.say(`Downloading Debian 13: ${Math.min(100, Number(pct[1]))}%.`, Math.min(1000, Number(pct[1]) * 10));
      }
      const made = /^VM ([0-9a-f-]{36}) created/.exec(text);
      if (made) vm = made[1];
      const web = /^Web UI: (https?:\/\/\S+)/.exec(text);
      if (web) url = web[1];
      if (/^Xen Orchestra is installed and running/.test(text)) outcome = 'done';
      else if (/^Xen Orchestra installation failed inside the VM/.test(text)) outcome = 'failed';
      else if (/^Didn't get a result from the VM within/.test(text)) outcome = 'timeout';
      else if (/checksum verification failed/i.test(text)) outcome = 'checksum';
      // A step the VM is on, timestamped by the script: the sentence under the bar.
      const step = /^\d\d:\d\d:\d\d\s+(.+)$/.exec(text);
      if (step) on.say(step[1].slice(0, 160), null);
    };
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (d) => {
        buf += d;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop() ?? '';
        lines.forEach(line);
      });
      stream?.on('end', () => buf && line(buf));
    }
    child.on('error', (e) => {
      clearTimeout(limit);
      reject(new Error(`the installer could not be started: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(limit);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(new Error('cancelled'));
      const where = vm ? `Its VM, ${XO_VM_NAME} (${vm}), was kept` : `A VM named ${XO_VM_NAME}, if one was made, was kept`;
      if (outcome === 'failed') return reject(new Error(`Xen Orchestra's install failed inside its VM. ${where}; its log is /var/log/xo-install.log there.`));
      if (outcome === 'timeout') return reject(new Error(`Xen Orchestra had not said it was installed after an hour. ${where}, and may still be installing.`));
      if (outcome === 'checksum') return reject(new Error('Debian\u2019s image did not match the checksum Debian publishes for it, so nothing was made from it.'));
      if (code !== 0 || outcome !== 'done' || !url) {
        return reject(new Error(`the installer stopped${stage >= 0 ? ` at its stage ${stage + 1} of 6` : ''}: ${tail.at(-1) ?? 'it said nothing'}`));
      }
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return reject(new Error(`the installer said Xen Orchestra is at ${url.slice(0, 80)}, which is not an address.`));
      }
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.hostname === 'unknown') {
        return reject(new Error(`Xen Orchestra is installed and the installer did not say an HTTPS address for it (${url.slice(0, 80)}). Its admin is still ${DEFAULT_ADMIN.email} with the password ${DEFAULT_ADMIN.password}: change it in Xen Orchestra now.`));
      }
      resolve({ address: parsed.host, vm });
    });
  });
}

/**
 * A temporary directory for one job, 0700, short enough for a unix socket
 * path and the ControlPath inside it.
 */
export function jobDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'fwxd-'));
}
