// Onboarding a Xen Orchestra pool, run by this machine for somebody on a phone.
// docs/hypervisors.md is the design; this is the half that runs on a host.
//
// THE SHAPE OF ONE JOB, and why each part is there:
//
//   probe   Can this machine reach the address, does it look like Xen
//           Orchestra, and which certificate answered. The person accepts
//           that certificate on the phone; its fingerprint is the PIN every
//           later connection is held to (xo-ws.js).
//   begin   A key pair for this job alone. The public half goes to the phone
//           SIGNED WITH THIS MACHINE'S ENROLMENT KEY, so the phone can tell it
//           is this machine's and not one the coordinator substituted — the
//           coordinator relays it, and is the party this project treats as
//           compromised. The private half never leaves this process.
//   run     The admin sign-in, sealed on the phone to that key with the job
//           and address as the binding, so a sealed sign-in for one job cannot
//           be replayed into another. Opened here, used for the steps below,
//           and wiped when they finish, whichever way they finish. Inside the
//           same seal, a key the phone made for the token to come back to.
//
// THE STEPS (XOSETUP_STEPS) make the limited `fleetwright` user, the resource
// set that bounds it, and a token for it; turn on the installer's own update
// plugin when the pool has it (github.com/00o-sh/XenOrchestraInstallerUpdater);
// and hand the token back. The admin sign-in is never written anywhere.
//
// CHANGING THE POLICY is a job of its own, begun the same way, whose sealed
// sign-in says `purpose: 'policy'`. Setup applies defaults when it first makes
// the resource set (the pools' default storage, half the pool, no networks)
// and never touches an existing one again, so a person's choice survives a
// setup run again for a new token. The policy job signs in, reads the pool,
// and hands the phone its storage repositories, networks and capacity, sealed
// to the phone's key, because a network map is not the coordinator's to read.
// It then waits, at most ten minutes, holding the signed-in connection and not
// the password, for the person's choice sealed to the job's key: which
// storage and networks the fleet may use, which network the edge router's
// WAN goes on (the egress, recorded in Xen Orchestra as a tag on that
// network), and the limits. Xen Orchestra enforces all of it as the resource
// set, which is the bound that holds when everything on our side has failed.
//
// A POOL WITH NO XEN ORCHESTRA is a job of its own too, begun with `deploy`
// and the pool master's SSH host key as its pin instead of a certificate's.
// The probe found that key: at an address with no Xen Orchestra it also says
// what answered SSH there (xo-deploy.js, sshProbe). Its sealed `run`
// carries the pool master's root password and the admin password the person
// chose; the machine installs Xen Orchestra with the installer's own script
// (xo-deploy.js, which says how the password is typed once and forgotten),
// replaces the default admin password with theirs, and then runs the steps
// above against the Xen Orchestra it made, pinned to a certificate it made
// itself, so the person's phone gets a token back exactly as from a setup.
// One job, so the phone can close at the first step.
//
// THROUGH THE PHONE, for a pool no machine in the fleet can reach. The probe
// and the job are the same; what carries them is not. Every connection is a
// stream through the relay the phone holds open (xo-relay.js), and TLS is
// opened over it here and held to the pin, so the phone and the coordinator
// carry ciphertext. The probe through a phone makes one attempt, over HTTPS,
// and takes no look over SSH: the phone carries HTTPS to Xen Orchestra and
// nothing else, and it is this machine's own network that cannot reach the
// pool. Three things are refused over a relay, each before it can start:
// plain HTTP, where the sign-in would be theirs to read; installing Xen
// Orchestra, which is SSH to the pool master and the installer's downloads,
// so it needs a machine that reaches the pool; and building the edge router
// or a machine image, which moves gigabytes over separate HTTP uploads a
// relay does not carry and somebody's mobile data should not. What fits is
// the setup, and a policy change, which can make the pool its own machine
// (xo-holder.js) where the pool has an image: that machine then reaches Xen
// Orchestra itself, and the phone is not needed again.
//
// THIS MACHINE KEEPS NOTHING. It is the one that could reach Xen Orchestra
// when somebody wanted to add it, and that is all it is: the pool must not
// stop being manageable because this machine was retired, rebuilt or offline.
// The first version wrote the token to a file here, which made the machine
// that happened to run the setup the only thing holding the pool's key. Now
// the hand-off seals the token to the phone's key, under its own binding
// (seal.js, xosetupHandoffAad), and `status` carries the sealed copy to that
// person until the job is forgotten. The key came inside the sealed sign-in,
// so a coordinator cannot put its own in its place and be handed the token.
//
// WHAT HAS RUN AGAINST A REAL XEN ORCHESTRA, and what has not. Every step has
// run against Xen Orchestra built from sources, with the installer's update
// plugin added: the pinned TLS, the WebSocket, sign-in, the method list, the
// user and resource set (made, and found again on a second run), a token the
// limited user can sign in with and admin calls refuse, and the plugin turned
// on and left alone the second time. That found two faults the stand-in
// could not: `/` is a redirect with no title, and a year-long token is over
// the server's cap. NOT RUN: a real XCP-ng pool behind it — that Xen
// Orchestra had none, so `inventory` was handed one — which leaves the
// pool, host and SR fields `limitsFrom` reads checked against Xen
// Orchestra's source but not a live answer. `inventory` still asks for the
// method list first and stops, naming what is missing, before changing
// anything.

import tls from 'node:tls';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { XOSETUP_STEPS, XOPOLICY_STEPS, XODEPLOY_STEPS, XOSETUP_JOB_RE, CERT_PIN_RE } from '../protocol/intents.js';
import { SEAL_KEY_RE, newSealKey, open as openSealed, seal, xodeployAad, xosetupAad, xosetupHandoffAad, xosetupInventoryAad, xosetupPolicyAad } from '../seal.js';
import { signingInput } from '../crypto.js';
import { certSha256, splitAddress, connectXo, connectXoPlain, describeCertificate, CERT_PROBLEM_WORDS } from './xo-ws.js';
import { EDGE, GROUP_PREFIX, LAB, MAX_GROUPS, edgeLabsOf, ensureEdge, ensureGroups, ensureLabs, ensureUplink, fleetHosts, labsEachOf, srName } from './edge-router.js';
import { VM_IMAGE, IMAGES, ensureImage, imageKeyOf } from './vm-image.js';
import { HOLDER, ensureHolder } from './xo-holder.js';
import { DEFAULT_ADMIN, INSTALLER, MIN_ADMIN_PASSWORD, STAGES, jobDir, openPool, prepareInstaller, readPool, runInstaller, sshProbe } from './xo-deploy.js';

/** The user onboarding makes, by the name Xen Orchestra keys users on. */
export const FLEET_USER = 'fleetwright';
/** The resource set that bounds it, by name. */
export const FLEET_SET = 'fleetwright';
/** The installer's update plugin, as Xen Orchestra names a plugin: its package minus `xo-server-`. */
export const UPDATES_PLUGIN = 'installer-updates';

/** What `inventory` checks the server offers before anything is changed. */
export const REQUIRED_METHODS = Object.freeze([
  'session.signIn',
  'system.getMethodsInfo',
  'xo.getAllObjects',
  'user.getAll',
  'user.create',
  'user.set',
  'resourceSet.getAll',
  'resourceSet.create',
  'token.create',
]);

/** How long a job waits for its sign-in after `begin`. */
const WAITING_TTL_MS = 10 * 60_000;
/** How long a finished job can still be asked about. */
const FINISHED_TTL_MS = 6 * 60 * 60_000;
/** How long a policy job waits for the person's choice, holding an admin session. */
const POLICY_WAIT_MS = 10 * 60_000;
/** How often an install that is quiet still says it is going: under the Lock Screen's twenty minutes of silence. */
const DEPLOY_HEARTBEAT_MS = 5 * 60_000;
/** The tag on the network the edge router's WAN goes on: the way out of every lab. */
export const EGRESS_TAG = 'fleetwright-egress';
/** What building the edge router asks of the server, checked before anything is made. */
export const EDGE_METHODS = Object.freeze(['network.create', 'resourceSet.addObject', 'disk.import', 'vm.create', 'vm.attachDisk', 'vif.set', 'vm.start']);
/** What making labs asks of the server, beside rebuilding the edge with them. */
export const LAB_METHODS = Object.freeze(['network.create', 'tag.add', 'tag.remove', 'resourceSet.addObject']);
/** What building the machine image asks of the server, checked before anything is made. */
export const IMAGE_METHODS = Object.freeze(['disk.import', 'vm.create', 'vm.attachDisk', 'vm.start', 'vm.set', 'vm.convertToTemplate', 'tag.add', 'resourceSet.addObject']);
/**
 * How the image's disk is grown, whichever of these the server offers, in
 * this order. `disk.resize` is the long-standing name; a Xen Orchestra that
 * does not list it grows a disk through `vdi.set` with a `size`, the call
 * behind the REST API's PATCH /vdis/{id}. Seen on a real one: "this Xen
 * Orchestra does not offer disk.resize, so the machine image cannot be built".
 */
export const RESIZE_METHODS = /** @type {readonly ('disk.resize'|'vdi.set')[]} */ (Object.freeze(['disk.resize', 'vdi.set']));
/** The smallest limits a policy may set: one vCPU, a GiB of memory, ten of disk. */
const MIN_MEMORY = 1024 ** 3;
const MIN_DISK = 10 * 1024 ** 3;
/**
 * What the limited user's token is asked to live: 180 days, under the half a
 * year Xen Orchestra allows out of the box (`maxTokenValidity = '0.5 year'`).
 * Asking for more fails, and as a limited user the refusal arrives as
 * "unknown error from the peer" — so a server configured lower still gets a
 * token, at its own default length, rather than a setup that stops at step
 * six. Renewing it is the next round's.
 */
const TOKEN_LIFETIME_MS = 180 * 24 * 60 * 60_000;

/**
 * Can this machine reach Xen Orchestra at an address? One TLS handshake and
 * one GET of `/signin`, reduced to what a probe is allowed to say.
 *
 * `/signin` AND NOT `/`: Xen Orchestra answers `/` with a redirect to
 * `/signin` and no body, so a probe of `/` called every real one "something
 * that does not look like Xen Orchestra". Found against a running Xen
 * Orchestra, not the suite's stand-in, which had served its title at `/`.
 *
 * @param {string} address
 * @param {{ timeoutMs?: number, through?: (() => Promise<import('node:stream').Duplex>)|null }} [opts]
 * @returns {Promise<{ reachable: boolean, xo: boolean|null, tls: boolean, cert: string|null, certificate: ReturnType<typeof describeCertificate>, version: string|null, text: string, ssh?: any }>}
 */
// FOUR SECONDS AN ATTEMPT, and at most two attempts (HTTPS, then plain HTTP
// on 80, or on the address's own port), so a probe answers inside the
// coordinator's ten-second fan-out deadline even for an address that drops
// packets.
//
// THROUGH A PHONE (`through`, a connection through its relay): one attempt,
// over HTTPS only, because a phone carries nothing else, and no look over
// SSH, which would be this machine's own network answering for an address
// it already could not reach. Something that answered without TLS is said as
// that and not offered, so a person is never asked to send a password a phone
// and the fleet could read.
export async function probe(address, { timeoutMs = 4_000, through = null } = {}) {
  if (through) return probeThrough(address, { timeoutMs, through });
  // OVER SSH TOO, AT THE SAME TIME, for an address with no Xen Orchestra:
  // what a pool is added from when it has none (xo-deploy.js). Started now
  // so it costs no time of its own, stopped as soon as Xen Orchestra answers,
  // and its answer kept only when Xen Orchestra did not.
  const stop = new AbortController();
  const overSsh = sshProbe(address, { signal: stop.signal }).catch(() => null);
  const found = await probeXo(address, { timeoutMs });
  if (found.xo === true) {
    stop.abort();
    return found;
  }
  const ssh = await overSsh;
  return ssh ? { ...found, ssh: ssh.ssh } : found;
}

/**
 * The HTTPS look, then plain HTTP: `probe` without SSH.
 *
 * @param {string} address
 * @param {{ timeoutMs: number }} opts
 */
async function probeXo(address, { timeoutMs }) {
  const { host, port, explicitPort } = splitAddress(address);
  const secure = await getRoot({ host, port, secure: true, timeoutMs });
  if (secure.ok) {
    const xo = looksLikeXo(secure.body);
    return {
      reachable: true,
      xo,
      tls: true,
      cert: secure.cert,
      certificate: secure.certificate,
      version: null,
      text: xo ? `Xen Orchestra answered at ${address}.` : `Something answered at ${address}, and it does not look like Xen Orchestra.`,
    };
  }
  // NO TLS: plain HTTP, on 80 for a bare address and on the address's own port
  // for one that named it — which is what the installer's default PORT="80"
  // gives, and what a person who moved it gave. Setup can run over it once the
  // person has accepted on the phone that the sign-in crosses unencrypted.
  {
    const plain = await getRoot({ host, port: explicitPort ? port : 80, secure: false, timeoutMs });
    if (plain.ok) {
      const xo = looksLikeXo(plain.body);
      return {
        reachable: true,
        xo,
        tls: false,
        cert: null,
        certificate: null,
        version: null,
        text: xo
          ? `Xen Orchestra answered at ${address} over plain HTTP, without HTTPS. It can be set up once you accept that the sign-in crosses the network unencrypted, or given HTTPS first: in the installer's xo-install.cfg, set PORT="443", PATH_TO_HTTPS_CERT, PATH_TO_HTTPS_KEY and AUTOCERT="true", then run it again.`
          : `Something answered at ${address} over plain HTTP, and it does not look like Xen Orchestra.`,
      };
    }
  }
  return { reachable: false, xo: null, tls: false, cert: null, certificate: null, version: null, text: `Nothing answered at ${address} from here (${secure.error}).` };
}

/**
 * The probe through a phone: one TLS handshake and one GET of `/signin`,
 * over a connection through its relay.
 *
 * @param {string} address
 * @param {{ timeoutMs: number, through: () => Promise<import('node:stream').Duplex> }} opts
 */
async function probeThrough(address, { timeoutMs, through }) {
  const { host, port } = splitAddress(address);
  const secure = await getRoot({ host, port, secure: true, timeoutMs, through });
  if (secure.ok) {
    const xo = looksLikeXo(secure.body);
    return {
      reachable: true,
      xo,
      tls: true,
      cert: secure.cert,
      certificate: secure.certificate,
      version: null,
      text: xo
        ? `Xen Orchestra answered at ${address} through your phone.`
        : `Something answered at ${address} through your phone, and it does not look like Xen Orchestra.`,
    };
  }
  return {
    reachable: false,
    xo: null,
    tls: false,
    cert: null,
    certificate: null,
    version: null,
    // REACHED, BUT NO TLS: the phone connected, and what answered did not
    // finish a TLS handshake, because it speaks something else or nothing.
    text: secure.reached
      ? `Something answered at ${address} through your phone, but not over HTTPS${secure.error === 'no answer in time' ? ' in time' : ''}. A phone carries only HTTPS, so that the sign-in stays between this machine and Xen Orchestra.`
      : `Nothing answered at ${address} through your phone (${secure.error}).`,
  };
}

/** @param {string} body */
function looksLikeXo(body) {
  return /<title>[^<]*Xen Orchestra/i.test(body) || /xo-web|xo-server|xen-orchestra/i.test(body);
}

/**
 * @param {{ host: string, port: number, secure: boolean, timeoutMs: number, through?: (() => Promise<import('node:stream').Duplex>)|null }} opts
 * @returns {Promise<{ ok: true, body: string, cert: string|null, certificate: ReturnType<typeof describeCertificate> } | { ok: false, error: string, reached?: boolean }>}
 */
async function getRoot({ host, port, secure, timeoutMs, through = null }) {
  // THROUGH A PHONE, the connection is the phone's to make first: one that
  // could not be made is "nothing answered", and one that was made and then
  // failed TLS is "something answered, not over HTTPS".
  /** @type {import('node:stream').Duplex|null} */
  let via = null;
  if (through) {
    try {
      via = await through();
    } catch (e) {
      return { ok: false, error: /** @type {Error} */ (e).message, reached: false };
    }
  }
  return new Promise((resolve) => {
    let body = '';
    let cert = /** @type {string|null} */ (null);
    /** @type {ReturnType<typeof describeCertificate>} */
    let certificate = null;
    let settled = false;
    /** @param {any} r */
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      // Through a phone, a failure from here on came after the phone had
      // connected: something answered, and did not finish what was asked.
      resolve(via && !r.ok ? { ...r, reached: true } : r);
    };
    // THROUGH A PHONE the handshake runs over the stream the phone carries,
    // and the certificate is read the same way: for the person to compare and
    // accept, not judged here. The line for this machine's own network is
    // left as it was.
    const socket = secure && via
      ? tls.connect({ socket: via, ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized: false })
      : secure
      ? tls.connect({ host, port, ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized: false })
      : net.connect({ host, port });
    const timer = setTimeout(() => done({ ok: false, error: 'no answer in time' }), timeoutMs);
    const request = () => {
      if (secure) {
        const peer = /** @type {import('node:tls').TLSSocket} */ (socket).getPeerCertificate();
        cert = peer?.raw ? certSha256(peer.raw) : null;
        certificate = describeCertificate(/** @type {import('node:tls').TLSSocket} */ (socket), host);
      }
      const hostHeader = net.isIPv6(host) ? `[${host}]` : host;
      socket.write(`GET /signin HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\nAccept: text/html\r\n\r\n`);
    };
    socket.once(secure ? 'secureConnect' : 'connect', request);
    socket.on('data', (chunk) => {
      body += chunk.toString('latin1');
      if (body.length > 64 * 1024) done({ ok: true, body, cert, certificate });
    });
    socket.on('end', () => done({ ok: true, body, cert, certificate }));
    socket.on('close', () => done(body ? { ok: true, body, cert, certificate } : { ok: false, error: 'the connection closed' }));
    socket.on('error', (e) => done({ ok: false, error: /** @type {NodeJS.ErrnoException} */ (e).code || e.message }));
  });
}

/**
 * @typedef {object} SetupStatus
 * @property {string} job
 * @property {'waiting'|'running'|'choosing'|'done'|'failed'|'cancelled'} state
 * @property {number} step
 * @property {number} of
 * @property {string} phase
 * @property {string} text
 * @property {string} [handoff]  once done: the limited user's token record,
 *   sealed to the key the phone sent inside the sign-in, as epk.iv.ct
 * @property {string} [inventory]  a policy job waiting on the person: the
 *   pool's storage, networks and capacity (inventoryOf), sealed to the same key
 */

/**
 * The jobs this machine is running or has run lately.
 */
export class XoSetups {
  /**
   * @param {{
   *   signer: { publicJwk: { kty?: string, crv?: string, x: string, y: string }, sign: (message: string) => Promise<string> }|null,
   *   emit: (event: Record<string, any>) => void,
   *   stateDir?: string|null,
   *   connect?: typeof connectXo,
   *   connectPlain?: typeof connectXoPlain,
   *   fingerprint: (jwk: any) => Promise<string>,
   *   now?: () => number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   *   policyWaitMs?: number,
   *   coordinatorUrl?: string|null,
   *   buildImage?: typeof ensureImage,
   *   holderPin?: ((job: string) => Promise<any>)|null,
   *   installer?: typeof INSTALLER,
   *   fetch?: typeof globalThis.fetch,
   *   xoRetryMs?: number,
   *   relay?: { open: (relay: string) => Promise<import('node:stream').Duplex>, done: (relay: string) => void }|null,
   * }} opts
   */
  constructor({ signer, emit, stateDir, connect = connectXo, connectPlain = connectXoPlain, fingerprint, now = () => Date.now(), log, policyWaitMs = POLICY_WAIT_MS, coordinatorUrl = null, buildImage = ensureImage, holderPin = null, installer = INSTALLER, fetch = globalThis.fetch, xoRetryMs = 5_000, relay = null }) {
    this.policyWaitMs = policyWaitMs;
    // THE INSTALLER AN INSTALL RUNS, pinned (xo-deploy.js), where its files
    // come from, and how long to wait between tries at a Xen Orchestra that
    // has only just started.
    this.installer = installer;
    this.fetch = fetch;
    this.xoRetryMs = xoRetryMs;
    // HOW THIS BOX REACHES AN ADDRESS THROUGH SOMEBODY'S PHONE (xo-relay.js):
    // a connection through a relay, and the word that it is finished with
    // one. Without it a job through a phone is refused at `begin`.
    this.relay = relay;
    // HOW THIS BOX ASKS THE FLEET FOR THE PIN a pool's own machine joins with
    // (xo-holder.js), for one job. Without it this box does not offer to make
    // one (`can`).
    /** @type {((job: string) => Promise<any>)|null} */
    this.holderPin = holderPin;
    // THE FLEET A MACHINE IMAGE INSTALLS FROM AND ITS MACHINES JOIN: this
    // box's own, as it pinned it. Without one this box does not offer to
    // build an image (`can`).
    this.coordinatorUrl = coordinatorUrl;
    this.buildImage = buildImage;
    this.signer = signer;
    this.emit = emit;
    this.stateDir = stateDir;
    this.connect = connect;
    this.connectPlain = connectPlain;
    this.fingerprint = fingerprint;
    this.now = now;
    this.log = log || { info() {}, warn() {} };
    /** @type {Map<string, any>} */
    this.jobs = new Map();
  }

  /**
   * @param {{ address: string, pin?: string|null, trust?: string|null, plain?: string|null, relay?: string|null, actor: string|null }} args
   */
  async begin({ address, pin, trust = null, plain = null, relay = null, actor }) {
    this.#prune();
    // A JOB IS SOMEBODY'S: status, run and cancel are refused to anyone else,
    // and a job begun with no name on it would be everybody's who also had none.
    if (!actor) return { ok: false, text: 'Setup has to be asked for by a signed-in person.' };
    if (!this.signer) {
      return {
        ok: false,
        text: 'This machine has no enrolment key to sign a setup key with, so a phone could not tell the key was this machine’s. Enrol it with a pin first.',
      };
    }
    // NO PIN IS PLAIN HTTP, and only with the person's word for it. A pin and
    // `plain` together is a client that cannot decide, and is refused.
    const overHttp = !pin && plain === 'accepted';
    if (!overHttp && (!pin || !CERT_PIN_RE.test(pin))) {
      return { ok: false, text: 'Setup needs the certificate you accepted, or your acceptance of plain HTTP. Check the address from the app first.' };
    }
    // THROUGH A PHONE: only on a box that can, and never in the clear.
    if (relay !== null) {
      if (!this.relay) return { ok: false, text: 'This machine cannot work through a phone. Update it, or choose one that reaches Xen Orchestra itself.' };
      if (overHttp) return { ok: false, text: 'A phone carries only HTTPS: over plain HTTP the sign-in would cross the phone and the fleet readable. Give Xen Orchestra HTTPS first.' };
    }
    if ([...this.jobs.values()].filter((j) => j.state === 'waiting' || j.state === 'running' || j.state === 'choosing').length >= 3) {
      return { ok: false, text: 'This machine is already running three setups. Wait for one to finish.' };
    }
    const job = randomBytes(6).toString('hex');
    const key = await newSealKey();
    // Over plain HTTP there is no certificate, and the key is signed over an
    // empty pin, which the phone checks it against.
    const keySig = await this.signer.sign(signingInput('xosetup-key', { address, job, key: key.publicKey, pin: overHttp ? '' : pin }));
    const hostKey = { kty: 'EC', crv: 'P-256', x: this.signer.publicJwk.x, y: this.signer.publicJwk.y };
    this.jobs.set(job, {
      job,
      address,
      pin: overHttp ? null : pin,
      plain: overHttp,
      trust: trust === 'accepted' ? 'accepted' : null,
      // The relay every connection of this job goes through, or null for this
      // machine's own network.
      relay,
      actor,
      key,
      state: 'waiting',
      step: 0,
      of: XOSETUP_STEPS.length,
      phase: XOSETUP_STEPS[0],
      text: 'Waiting for the sign-in.',
      at: this.now(),
      cancelled: false,
    });
    return {
      ok: true,
      text: 'Ready for the sign-in. Check the key is this machine’s, then send it sealed.',
      // WHAT ELSE A JOB HERE CAN BE, so a phone sends a policy change only to
      // a machine that will not take it for a whole setup, asks for the edge
      // router only of one that can build it, offers any of the pool's
      // networks as the way out only to one that takes it (`egress-any`,
      // checkPolicy), and asks where the router's disk goes only of one that
      // reads the answer (`edge-disk`). Not signed: a coordinator that strips
      // it makes the phone refuse or not offer, which is safe.
      // And whether it builds the machine image sessions' machines are
      // cloned from (`image`, vm-image.js): only a box that knows which fleet
      // the image should install from.
      xosetup: {
        job,
        state: 'waiting',
        key: key.publicKey,
        keySig,
        hostKey,
        fingerprint: await this.fingerprint(hostKey),
        // `images`: it builds any of the catalogue's operating systems, chosen
        // together, not only Debian (vm-image.js, IMAGES).
        // `groups`: it makes group networks for machines that work together.
        // `holder`: it makes the pool a machine of its own (xo-holder.js),
        // which needs both the fleet to join and a way to ask it for a pin.
        // `labs`: it makes labs on the edge (edge-router.js, LAB), which needs
        // the fleet's address, the one place a closed lab may still reach.
        // `labs-each`: it keeps how many labs one person may hold
        // (`labsEach`, checkPolicy). An older one would drop the number
        // without a word, so a phone offers it only where this is said.
        can: [
          'policy', 'edge', 'egress-any', 'edge-disk', 'edge-block', 'groups',
          ...(this.coordinatorUrl ? ['image', 'images', 'labs', 'labs-each'] : []),
          ...(this.coordinatorUrl && this.holderPin ? ['holder'] : []),
        ],
      },
    };
  }

  /**
   * An install's `begin` (phase `deploy`): the same key for the job, signed
   * under its own context (`xodeploy-key`) over the pool master's SSH host
   * key, whose SHA-256 in hex is the pin, so the phone can tell the key is
   * this machine's for THIS pool master, and a deploy key can never pass for
   * a setup's.
   *
   * @param {{ address: string, pin?: string|null, relay?: string|null, actor: string|null }} args
   */
  async beginDeploy({ address, pin, relay = null, actor }) {
    this.#prune();
    if (!actor) return { ok: false, text: 'Installing Xen Orchestra has to be asked for by a signed-in person.' };
    if (!this.signer) {
      return {
        ok: false,
        text: 'This machine has no enrolment key to sign a job key with, so a phone could not tell the key was this machine’s. Enrol it with a pin first.',
      };
    }
    // NOT THROUGH A PHONE, refused before anything is made, the way building
    // the edge router is: the install is SSH to the pool master and the
    // installer's own downloads, and a relay carries HTTPS to Xen Orchestra
    // and nothing else. Said before the pin, which a probe through a phone
    // never finds, so the person is told the real reason.
    if (relay !== null) {
      return {
        ok: false,
        text: 'Installing Xen Orchestra needs a machine that reaches the pool: it connects to the pool master over SSH, which this machine does not do through your phone. Install it from a machine on the pool’s network.',
      };
    }
    if (!pin || !CERT_PIN_RE.test(pin)) return { ok: false, text: 'An install needs the pool master’s SSH host key you compared. Find a machine that can reach it from the app first.' };
    if ([...this.jobs.values()].filter((j) => j.state === 'waiting' || j.state === 'running' || j.state === 'choosing').length >= 3) {
      return { ok: false, text: 'This machine is already running three setups. Wait for one to finish.' };
    }
    const signer = /** @type {NonNullable<typeof this.signer>} */ (this.signer);
    const job = randomBytes(6).toString('hex');
    const key = await newSealKey();
    const keySig = await signer.sign(signingInput('xodeploy-key', { address, job, key: key.publicKey, pin }));
    const hostKey = { kty: 'EC', crv: 'P-256', x: signer.publicJwk.x, y: signer.publicJwk.y };
    this.jobs.set(job, {
      job,
      address,
      // The pool master's host key, as the hex of its SHA-256: what openPool
      // holds the SSH connection to. Not `pin`, which is Xen Orchestra's.
      hostKeyPin: pin,
      purpose: 'deploy',
      pin: null,
      plain: false,
      trust: null,
      actor,
      key,
      state: 'waiting',
      step: 0,
      of: XODEPLOY_STEPS.length,
      phase: XODEPLOY_STEPS[0],
      text: 'Waiting for the passwords.',
      at: this.now(),
      cancelled: false,
    });
    return {
      ok: true,
      text: 'Ready for the passwords. Check the key is this machine’s, then send them sealed.',
      xosetup: { job, state: 'waiting', key: key.publicKey, keySig, hostKey, fingerprint: await this.fingerprint(hostKey), can: ['deploy'] },
    };
  }

  /**
   * @param {{ job: string, sealed: string, actor: string|null }} args
   */
  async run({ job, sealed, actor }) {
    const rec = this.#mine(job, actor);
    if (!rec) return unknown();
    if (rec.state !== 'waiting' || !rec.key) return { ok: false, text: 'That setup has already been given its sign-in.', xosetup: status(rec) };
    const parts = String(sealed || '').split('.');
    if (parts.length !== 3) return { ok: false, text: 'That is not a sealed sign-in.' };
    /** @type {any} */
    let inside;
    const deploy = rec.purpose === 'deploy';
    try {
      inside = await openSealed({
        privateKey: rec.key.privateKey,
        publicKey: rec.key.publicKey,
        aad: deploy ? xodeployAad(job, rec.address) : xosetupAad(job, rec.address),
        sealed: { epk: parts[0], iv: parts[1], ct: parts[2] },
      });
    } catch {
      return { ok: false, text: deploy ? 'The passwords did not open with this job’s key. Start again from the app.' : 'The sign-in did not open with this setup’s key. Start again from the app.' };
    }
    // ONE USE: the key goes as soon as it has opened the one thing it exists
    // for, which for a policy job is two things (below).
    const jobKey = rec.key;
    rec.key = null;
    // WHERE THE TOKEN GOES BACK TO, checked before anything is made: an app
    // too old to send one would otherwise have a user and a token made for
    // it in Xen Orchestra that nobody could ever be handed.
    if (!SEAL_KEY_RE.test(String(inside?.reply || ''))) {
      rec.state = 'failed';
      rec.text = 'The app gave no key to hand the token back to, so nothing was started. Update the app and try again.';
      this.#ended(rec);
      return { ok: false, text: rec.text, xosetup: status(rec) };
    }
    rec.reply = String(inside.reply);
    // AN INSTALL'S TWO PASSWORDS, checked before anything is asked of the
    // pool: the root password to reach the pool master with, and the admin
    // password Xen Orchestra's default is replaced with, at least as long as
    // the phone asks for.
    if (deploy) {
      const root = inside?.v === 1 && inside.purpose === 'deploy' && typeof inside.root?.password === 'string' ? inside.root.password : '';
      const admin = inside?.v === 1 && typeof inside.xo?.password === 'string' ? inside.xo.password : '';
      if (!root || root.length > 1024 || admin.length < MIN_ADMIN_PASSWORD || admin.length > 256) {
        rec.state = 'failed';
        rec.text = !root
          ? 'The sealed passwords had no root password for the pool master in them, so nothing was started.'
          : `The new admin password has to be ${MIN_ADMIN_PASSWORD} to 256 characters, so nothing was started.`;
        return { ok: false, text: rec.text, xosetup: status(rec) };
      }
      rec.state = 'running';
      rec.text = 'Starting.';
      void this.#execute(rec, { root, admin });
      return { ok: true, text: `Installing Xen Orchestra on the pool at ${rec.address}.`, xosetup: status(rec) };
    }
    // A POLICY JOB keeps the key for the one more thing it must open: the
    // person's choice, sealed to it once they have seen the pool.
    if (inside.purpose === 'policy') {
      rec.purpose = 'policy';
      rec.policyKey = jobKey;
      rec.of = XOPOLICY_STEPS.length;
      rec.phase = XOPOLICY_STEPS[0];
    }
    const xo = inside?.v === 1 && inside.xo && typeof inside.xo === 'object' ? inside.xo : null;
    const creds = xo && typeof xo.email === 'string' && typeof xo.password === 'string'
      ? { email: xo.email, password: xo.password }
      : xo && typeof xo.token === 'string'
        ? { token: xo.token }
        : null;
    if (!creds) {
      rec.state = 'failed';
      rec.text = 'The sealed sign-in was not an email and password, or a token.';
      this.#ended(rec);
      return { ok: false, text: rec.text, xosetup: status(rec) };
    }
    rec.state = 'running';
    rec.text = 'Starting.';
    void this.#execute(rec, creds);
    return { ok: true, text: rec.purpose === 'policy' ? `Reading ${rec.address}.` : `Setting up ${rec.address}.`, xosetup: status(rec) };
  }

  /**
   * The person's choice for a policy job, sealed on the phone to the job's
   * key once `status` had handed them the pool's inventory. Checked against
   * that inventory here, because the phone's screen is not the bound: an id
   * the inventory did not list, or a limit past what the pool has, is
   * refused and the job goes on waiting.
   *
   * @param {{ job: string, sealed: string, actor: string|null }} args
   */
  async policy({ job, sealed, actor }) {
    const rec = this.#mine(job, actor);
    if (!rec) return unknown();
    if (rec.purpose !== 'policy' || rec.state !== 'choosing' || !rec.policyKey || !rec.waiting) {
      return { ok: false, text: 'That job is not waiting for a choice.', xosetup: status(rec) };
    }
    const parts = String(sealed || '').split('.');
    /** @type {any} */
    let inside;
    try {
      if (parts.length !== 3) throw new Error('not sealed');
      inside = await openSealed({
        privateKey: rec.policyKey.privateKey,
        publicKey: rec.policyKey.publicKey,
        aad: xosetupPolicyAad(job, rec.address),
        sealed: { epk: parts[0], iv: parts[1], ct: parts[2] },
      });
    } catch {
      return { ok: false, text: 'That choice did not open with this job’s key. Choose again from the app.', xosetup: status(rec) };
    }
    const checked = checkPolicy(inside, rec.choices);
    if (!checked.ok) return { ok: false, text: checked.text, xosetup: status(rec) };
    // GIGABYTES ARE NOT SENT THROUGH A PHONE. The router's and the image's
    // disks go to Xen Orchestra as HTTP uploads of their own, which a relay
    // does not carry; refused while the job still waits, so the person can
    // choose again without them. Labs are among them: they live on the edge
    // router, which is built again with an interface on each.
    if (rec.relay && (checked.policy.edge || checked.policy.image || checked.policy.labs)) {
      return {
        ok: false,
        text: 'Building the edge router, its labs or a machine image moves gigabytes, which this machine does not send through your phone. Choose them from a machine that reaches the pool, such as the pool’s own once it has joined.',
        xosetup: status(rec),
      };
    }
    rec.policyKey = null;
    rec.state = 'running';
    rec.text = 'Applying what you chose.';
    rec.waiting.resolve(checked.policy);
    return { ok: true, text: rec.text, xosetup: status(rec) };
  }

  /** @param {{ job: string, actor: string|null }} args */
  status({ job, actor }) {
    const rec = this.#mine(job, actor);
    if (!rec) return unknown();
    return { ok: true, text: rec.text, xosetup: status(rec) };
  }

  /** @param {{ job: string, actor: string|null }} args */
  cancel({ job, actor }) {
    const rec = this.#mine(job, actor);
    if (!rec) return unknown();
    if (rec.state === 'waiting') {
      rec.key = null;
      rec.state = 'cancelled';
      rec.text = 'Cancelled before it started.';
      this.#report(rec);
      this.#ended(rec);
    } else if (rec.state === 'running') {
      // Between steps: a call already sent to Xen Orchestra is not unsent.
      // The edge router's build is the exception, because it is minutes of
      // bytes: its download and upload stop where they are (ensureEdge).
      rec.cancelled = true;
      if (rec.abort) {
        rec.abort.abort();
        rec.text = rec.building === 'deploy'
          ? 'Stopping the installer where it is.'
          : rec.building === 'image'
            ? 'Stopping the machine image’s build and removing what it made.'
            : 'Stopping the edge router’s build and removing what it made.';
      } else {
        rec.text = 'Cancelling after this step.';
      }
    } else if (rec.state === 'choosing') {
      // Nothing has been changed yet, so this is the whole of it.
      rec.cancelled = true;
      rec.policyKey = null;
      rec.state = 'cancelled';
      rec.text = 'Cancelled before anything was changed.';
      rec.waiting?.reject(new Error('cancelled'));
    }
    return { ok: true, text: rec.text, xosetup: status(rec) };
  }

  /**
   * A connection for this job: pinned TLS, or plain HTTP when the person
   * accepted it — the same each time it is asked, so the limited user's token
   * is made over what the admin's sign-in went over.
   *
   * @param {any} rec
   */
  async #open(rec) {
    // THROUGH THE PHONE: a new connection through its relay for each, and
    // the same pinned TLS over it as over this machine's own network.
    if (rec.relay && this.relay) return this.connect({ address: rec.address, pin: rec.pin, via: await this.relay.open(rec.relay) });
    // An install's Xen Orchestra is not at the address the job began with,
    // which is the pool master's, but where the installer said it is.
    return rec.plain ? this.connectPlain({ address: rec.address }) : this.connect({ address: rec.xoAddress ?? rec.address, pin: rec.pin });
  }

  /**
   * A job that is over gives up the relay it ran through, once: the
   * coordinator closes it at both ends, so the phone stops carrying it.
   *
   * @param {any} rec
   */
  #ended(rec) {
    if (!rec.relay || rec.relayGiven) return;
    rec.relayGiven = true;
    try {
      this.relay?.done(rec.relay);
    } catch {
      /* the coordinator closes it on its own clock too */
    }
  }

  /** @param {string} job @param {string|null} actor */
  #mine(job, actor) {
    if (!XOSETUP_JOB_RE.test(String(job))) return null;
    const rec = this.jobs.get(job);
    return rec && rec.actor === actor ? rec : null;
  }

  #prune() {
    const now = this.now();
    for (const [job, rec] of this.jobs) {
      const age = now - rec.at;
      const live = rec.state === 'running' || rec.state === 'choosing';
      if ((rec.state === 'waiting' && age > WAITING_TTL_MS) || (!live && age > FINISHED_TTL_MS)) {
        this.#ended(rec);
        this.jobs.delete(job);
      }
    }
  }

  /** @param {any} rec */
  #report(rec) {
    // A POLICY JOB REPORTS ONCE IT IS APPLYING. Until then it is driven from
    // a screen that is open and waiting on the person; from then on it may be
    // building the edge router, which is minutes of download, and the person
    // has every reason to put the phone down. The report says its purpose,
    // so it is not drawn as a hypervisor being added; a coordinator that
    // predates `purpose` refuses its steps and draws nothing, which is how
    // it was.
    const policy = rec.purpose === 'policy';
    if (policy && rec.phase !== 'apply' && rec.phase !== 'done') return;
    rec.reportedAt = this.now();
    try {
      this.emit({
        event: 'xosetup.progress',
        job: rec.job,
        step: rec.step,
        of: rec.of,
        phase: rec.phase,
        state: rec.state,
        text: rec.text,
        ...(policy ? { purpose: 'policy' } : rec.purpose === 'deploy' ? { purpose: 'deploy' } : {}),
        ...(rec.part && rec.state === 'running' ? { fill: rec.part.fill } : {}),
        // THE PART OF A BUILD, and only of a build: an install's download is one
        // bar, and "part 1 of 1" on the Lock Screen would be words about nothing.
        ...(rec.part && rec.state === 'running' && buildKey(rec) ? { build: buildKey(rec), stage: rec.part.stage, stages: rec.part.stages } : {}),
      });
    } catch (e) {
      this.log.warn(`xosetup: could not report progress: ${/** @type {Error} */ (e).message}`);
    }
  }

  /**
   * Run the steps. Never throws: every way out sets the job's state, reports
   * it, closes what it opened and wipes the sign-in.
   *
   * @param {any} rec
   * @param {{ email?: string, password?: string, token?: string, root?: string, admin?: string }} creds
   */
  async #execute(rec, creds) {
    /** @type {any} */
    const ctx = { rec, creds, admin: null, limited: null, notes: /** @type {string[]} */ ([]) };
    // What an error message is scrubbed of, taken before the sign-in step
    // wipes the originals, and wiped with them at the end.
    const secrets = { password: creds.password, token: creds.token, root: creds.root, admin: creds.admin };
    const policy = rec.purpose === 'policy';
    const deploy = rec.purpose === 'deploy';
    const steps = policy ? this.#policySteps() : deploy ? this.#deploySteps() : this.#steps();
    const keys = policy ? XOPOLICY_STEPS : deploy ? XODEPLOY_STEPS : XOSETUP_STEPS;
    try {
      for (let i = 0; i < steps.length; i++) {
        // A STEP THE ONE BEFORE IT RAN: the installer's six stages are one
        // script, which moves the job through them itself as it says them.
        if (!steps[i]) continue;
        if (rec.cancelled) {
          rec.state = 'cancelled';
          rec.text = `Cancelled before ${STEP_WORDS[keys[i]] ?? `step ${i + 1}`}.${policy ? ' Nothing was changed.' : ''}`;
          this.#report(rec);
          return;
        }
        rec.step = i;
        rec.phase = keys[i];
        rec.part = null;
        rec.text = `${STEP_WORDS[rec.phase]}.`;
        this.#report(rec);
        const said = await /** @type {(ctx: any) => Promise<any>} */ (steps[i])(ctx);
        // What a step found, kept for the summary rather than reported on its
        // own: one event per step is what the phone shows, and a second one
        // saying what the first found would double every buzz on Android.
        if (typeof said === 'string') ctx.notes.push(said);
      }
      rec.step = rec.of;
      rec.phase = 'done';
      rec.state = 'done';
      rec.part = null;
      rec.text = [ctx.summary || (policy ? `${rec.address}: what the fleet may use is changed.` : `${rec.address} is in the fleet.`), ...ctx.notes].join(' ');
      this.#report(rec);
      this.log.info(`xosetup: ${rec.job} finished for ${rec.address}`);
    } catch (e) {
      if (deploy && rec.cancelled) {
        rec.state = 'cancelled';
        rec.text = deployCancelled(rec.phase);
      } else if (policy && rec.cancelled) {
        rec.state = 'cancelled';
        // Cancelled during the build, the policy was already in force: say
        // so, rather than that nothing changed.
        rec.text = rec.phase !== 'apply'
          ? 'Cancelled before anything was changed.'
          : rec.building === 'holder'
            ? 'Cancelled while making the pool’s own machine. What the fleet may use was changed, and whatever else you asked for was built.'
            : rec.building === 'image'
            ? 'Cancelled while building the machine image. What the fleet may use was changed; the image was not made, and what was made of it was removed.'
            : rec.building === 'edge-rebuild'
            ? 'Cancelled while rebuilding the edge router. What the fleet may use was changed; the new router was removed and the one that was there was started again, as it was.'
            : 'Cancelled while building the edge router. What the fleet may use was changed; the router was not built, and what was made of it was removed.';
      } else {
        rec.state = 'failed';
        rec.text = `${STEP_WORDS[rec.phase] ?? 'Setup'} stopped: ${scrub(/** @type {Error} */ (e).message, secrets)}`;
      }
      this.#report(rec);
      this.log.warn(`xosetup: ${rec.job} stopped at ${rec.phase}`);
    } finally {
      // A policy job's key, its waiter and what it showed the phone go with
      // it, whichever way it ended.
      rec.policyKey = null;
      rec.waiting = null;
      rec.choices = null;
      rec.inventory = null;
      rec.part = null;
      rec.abort = null;
      rec.building = null;
      // AN INSTALL'S CONNECTION TO THE POOL MASTER, and the directory that
      // held the installer, the certificate's key and the SSH files, go
      // whichever way it ended.
      try {
        await ctx.pool?.close();
      } catch {
        /* closing */
      }
      if (ctx.dir) rmSync(ctx.dir, { recursive: true, force: true });
      this.#ended(rec);
      try {
        ctx.admin?.close();
      } catch {
        /* closing */
      }
      try {
        ctx.limited?.close();
      } catch {
        /* closing */
      }
      // WIPED, not merely dropped: a closure somewhere holding `creds` would
      // otherwise keep the password alive for as long as it lived.
      creds.password = undefined;
      creds.token = undefined;
      secrets.password = undefined;
      secrets.token = undefined;
      secrets.root = undefined;
      secrets.admin = undefined;
      creds.root = undefined;
      creds.admin = undefined;
      if (ctx.root) ctx.root.password = undefined;
      ctx.password = undefined;
      ctx.token = undefined;
    }
  }

  /**
   * A policy job's steps, in XOPOLICY_STEPS order: onboarding's first three,
   * then the person's choice and applying it.
   */
  #policySteps() {
    return [
      ...this.#steps().slice(0, 3),
      // choose
      async (/** @type {any} */ ctx) => {
        const sets = (await ctx.admin.call('resourceSet.getAll')) || [];
        const set = sets.find((/** @type {any} */ s) => s?.name === FLEET_SET);
        if (!set) throw new Error('this pool has not been added to the fleet yet, so there is no policy to change. Add it first. Nothing was changed.');
        ctx.setId = set.id;
        ctx.setObjects = Array.isArray(set.objects) ? set.objects.map(String) : [];
        // WHETHER EACH POOL HAS ITS EDGE ROUTER, so the phone can say so and
        // offer to build one only where there is none.
        const vms = Object.values((await ctx.admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {});
        ctx.edges = vms.filter((/** @type {any} */ v) => Array.isArray(v?.tags) && v.tags.includes(EDGE.tag));
        // AND WHICH STORAGE ITS DISK IS ON, by the disk's name, which the
        // build gives it: "which disk did it put it on?" is answered on the
        // phone, not only in Xen Orchestra.
        ctx.edgeDisks = ctx.edges.length
          ? Object.values((await ctx.admin.call('xo.getAllObjects', { filter: { type: 'VDI', name_label: EDGE.vm } })) || {})
          : [];
        // AND EACH POOL'S MACHINE IMAGE, so the phone offers to build one only
        // where there is none.
        const templates = Object.values((await ctx.admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {});
        ctx.images = templates.filter((/** @type {any} */ t) => Array.isArray(t?.tags) && t.tags.includes(VM_IMAGE.tag));
        // AND EACH POOL'S OWN MACHINE, so the phone offers to make one only
        // where there is none (xo-holder.js).
        ctx.holders = vms.filter((/** @type {any} */ v) => Array.isArray(v?.tags) && v.tags.includes(HOLDER.tag));
        const inventory = inventoryOf(ctx, set);
        ctx.rec.choices = choicesOf(inventory);
        const box = await seal({ to: ctx.rec.reply, aad: xosetupInventoryAad(ctx.rec.job, ctx.rec.address), payload: inventory });
        ctx.rec.inventory = `${box.epk}.${box.iv}.${box.ct}`;
        ctx.chosen = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('nobody chose within ten minutes. Nothing was changed.')), this.policyWaitMs);
          timer.unref?.();
          ctx.rec.waiting = {
            resolve: (/** @type {any} */ v) => { clearTimeout(timer); resolve(v); },
            reject: (/** @type {Error} */ e) => { clearTimeout(timer); reject(e); },
          };
          ctx.rec.state = 'choosing';
          ctx.rec.text = 'Waiting for your choice.';
        });
        ctx.rec.inventory = null;
      },
      // apply
      async (/** @type {any} */ ctx) => {
        const p = ctx.chosen;
        // THE FLEET'S OWN NETWORKS STAY: the uplink and the group networks
        // are this job's to put in the set, not choices on the phone, and a
        // machine on one would lose it if a choice left it out.
        const own = (ctx.networks || [])
          .filter((/** @type {any} */ n) => (n?.name_label === EDGE.uplink || String(n?.name_label || '').startsWith(GROUP_PREFIX) || String(n?.name_label || '').startsWith(LAB.prefix)) && ctx.setObjects?.includes(n.id))
          .map((/** @type {any} */ n) => String(n.id))
          .filter((/** @type {string} */ id) => !p.networks.includes(id));
        await ctx.admin.call('resourceSet.set', { id: ctx.setId, objects: [...p.srs, ...p.networks, ...own], limits: p.limits });
        const said = [`It may use ${plural(p.srs.length, 'storage repository')}, ${plural(p.networks.length, 'network')}, ${p.limits.cpus} vCPUs, ${gib(p.limits.memory)} of memory and ${gib(p.limits.disk)} of disk.`];
        // THE EGRESS, as a tag on that network, so the edge router is built
        // on the network the person named and the choice can be seen in Xen
        // Orchestra itself. Moved, never doubled: one network carries it.
        const tagged = (ctx.networks || []).filter((/** @type {any} */ n) => Array.isArray(n?.tags) && n.tags.includes(EGRESS_TAG)).map((/** @type {any} */ n) => n.id);
        const changes = tagged.filter((/** @type {string} */ id) => id !== p.egress).length + (p.egress && !tagged.includes(p.egress) ? 1 : 0);
        if (changes && !(Object.hasOwn(ctx.methods, 'tag.add') && Object.hasOwn(ctx.methods, 'tag.remove'))) {
          said.push('This Xen Orchestra cannot tag a network, so the way out was not recorded.');
        } else {
          for (const id of tagged) if (id !== p.egress) await ctx.admin.call('tag.remove', { id, tag: EGRESS_TAG });
          if (p.egress && !tagged.includes(p.egress)) await ctx.admin.call('tag.add', { id: p.egress, tag: EGRESS_TAG });
          if (p.egress) {
            const name = (ctx.networks || []).find((/** @type {any} */ n) => n?.id === p.egress)?.name_label;
            said.push(`Labs leave through ${name ? String(name).slice(0, 80) : 'the network you chose'}.`);
          } else {
            said.push('No network is the way out yet, so labs have none.');
          }
        }
        ctx.summary = said.join(' ');
        // THE EDGE ROUTER, when the person asked for it: the uplink, then the
        // router on it (edge-router.js). Inside this step and not steps of its
        // own, so a phone that predates it still reads the progress as the
        // step it knows, with the machine's sentence under it saying where the
        // download and the disk have got to.
        if (!p.edge && !p.image && !p.groups && !p.holder && p.labs === null) return;
        const rec = ctx.rec;
        // The words every time, for the screen that asks; an event only when
        // the stage changes or the bar has moved a twentieth, so a Lock
        // Screen is not pushed to for every 16 MB.
        const say = (/** @type {string} */ text, /** @type {any} */ part) => {
          if (rec.cancelled) return;
          rec.text = text;
          if (!part) return;
          const before = rec.part;
          rec.part = part;
          if (!before || before.stage !== part.stage || Math.floor(before.fill / 50) !== Math.floor(part.fill / 50)) this.#report(rec);
        };
        const way = (ctx.networks || []).find((/** @type {any} */ n) => n?.id === p.egress);
        if (!way?.$pool) throw new Error('the way out is not in a pool this Xen Orchestra listed. The policy was applied; nothing was built.');
        /** @type {string[]} */
        const built = [];
        if (p.edge) {
          const missing = EDGE_METHODS.filter((m) => !Object.hasOwn(ctx.methods, m));
          if (missing.length) throw new Error(`this Xen Orchestra does not offer ${missing.join(', ')}, so the edge router cannot be built. The policy was applied.`);
        }
        if (p.labs !== null) {
          const missing = [...LAB_METHODS, ...EDGE_METHODS].filter((m, i, all) => all.indexOf(m) === i && !Object.hasOwn(ctx.methods, m));
          if (missing.length) throw new Error(`this Xen Orchestra does not offer ${missing.join(', ')}, so the labs cannot be made. The policy was applied.`);
          if (!this.coordinatorUrl) throw new Error('this machine does not know the fleet’s address, which a closed lab must still reach. The policy was applied.');
        }
        if (p.holder && !(this.holderPin && this.coordinatorUrl)) throw new Error('this machine cannot ask the fleet for the pin a pool’s own machine joins with. The policy was applied.');
        if (p.image) {
          const missing = IMAGE_METHODS.filter((m) => !Object.hasOwn(ctx.methods, m));
          if (!RESIZE_METHODS.some((m) => Object.hasOwn(ctx.methods, m))) missing.push(RESIZE_METHODS.join(' or '));
          if (missing.length) throw new Error(`this Xen Orchestra does not offer ${missing.join(', ')}, so the machine image cannot be built. The policy was applied.`);
        }
        // GROUP NETWORKS, made before anything is built: quick, and a build
        // that fails should not take them with it.
        if (p.groups) {
          const made = await ensureGroups({ admin: ctx.admin, pool: way.$pool, networks: ctx.networks || [], setId: ctx.setId, inSet: p.networks, count: p.groups });
          if (made.length) built.push(`Made ${made.length === 1 ? 'a group network' : `${made.length} group networks`} for machines that work together.`);
          if (!p.edge && !p.image && !p.holder && p.labs === null) return built.join(' ') || undefined;
        }
        const uplink = await ensureUplink({ admin: ctx.admin, pool: way.$pool, networks: ctx.networks || [], setId: ctx.setId, inSet: p.networks });
        // LABS' NETWORKS, made before the edge is (re)built with an interface
        // on each: quick, and kept if the build fails, like group networks.
        /** @type {Array<{ id: string, open: boolean }>|null} */
        let labs = null;
        if (p.labs !== null) {
          const made = await ensureLabs({ admin: ctx.admin, pool: way.$pool, networks: ctx.networks || [], setId: ctx.setId, inSet: p.networks, open: p.labs.open, closed: p.labs.closed, perPerson: p.labsEach });
          labs = made.labs.map((l) => ({ id: l.id, open: l.open }));
          if (made.made.length) built.push(`Made ${made.made.length === 1 ? 'a lab network' : `${made.made.length} lab networks`}.`);
          if (p.labsEach !== undefined && labs.length) built.push(p.labsEach === null ? 'One person may hold any number of labs.' : `One person may hold ${p.labsEach === 1 ? 'one lab' : `${p.labsEach} labs`} at once.`);
        }
        const edgeAsked = p.edge || labs !== null;
        // THE MACHINE IMAGE, after the router, on the same pool: it is built
        // on the uplink, so its install leaves through the router like every
        // machine cloned from it will (vm-image.js).
        if (p.image) {
          const poolName = String((ctx.pools || []).find((/** @type {any} */ x) => x?.id === way.$pool)?.name_label || 'this pool').slice(0, 80);
          const image = async (/** @type {string} */ key) => {
            rec.building = 'image';
            rec.part = null;
            rec.abort = new AbortController();
            return this.buildImage({
              image: key,
              admin: ctx.admin,
              resize: RESIZE_METHODS.find((m) => Object.hasOwn(ctx.methods, m)),
              pool: way.$pool,
              poolName,
              uplink,
              setId: ctx.setId,
              srs: ctx.srs || [],
              fleetSrs: p.srs,
              sr: p.edgeSr,
              address: rec.address,
              pin: rec.pin,
              plain: rec.plain === true,
              imageDir: path.join(this.stateDir || '.', 'images'),
              coordinatorUrl: /** @type {string} */ (this.coordinatorUrl),
              signal: rec.abort.signal,
              say,
            });
          };
          // ONE AFTER ANOTHER, router first: each image is built behind it.
          if (edgeAsked) built.push(await this.#edge(ctx, p, way, uplink, say, labs));
          for (const key of p.images) built.push(await image(key));
        } else if (edgeAsked) {
          built.push(await this.#edge(ctx, p, way, uplink, say, labs));
        }
        // THE POOL'S OWN MACHINE, last: it is cloned from the image, which may
        // have been built a moment ago.
        if (p.holder) {
          rec.building = 'holder';
          rec.part = null;
          rec.abort = null;
          built.push(await ensureHolder({
            admin: ctx.admin,
            pool: way.$pool,
            egress: { id: String(way.id), name: String(way.name_label || 'the way out').slice(0, 80) },
            address: rec.address,
            coordinatorUrl: /** @type {string} */ (this.coordinatorUrl),
            askPin: () => /** @type {(job: string) => Promise<any>} */ (this.holderPin)(rec.job),
            say: (text) => say(text, null),
          }));
        }
        return built.join(' ');
      },
    ];
  }

  /**
   * An install's steps, in XODEPLOY_STEPS order: reach the pool master,
   * fetch the pinned installer, run it (its six stages, as it says them),
   * replace the default admin password, then onboarding's own steps against
   * the Xen Orchestra it made.
   *
   * @returns {Array<((ctx: any) => Promise<any>)|null>}
   */
  #deploySteps() {
    /** @param {any} rec @param {string} key */
    const move = (rec, key) => {
      rec.step = XODEPLOY_STEPS.indexOf(key);
      rec.phase = key;
      rec.part = null;
      rec.text = `${STEP_WORDS[key]}.`;
      this.#report(rec);
    };
    return [
      // reach
      async (/** @type {any} */ ctx) => {
        const rec = ctx.rec;
        rec.building = 'deploy';
        rec.abort = new AbortController();
        ctx.dir = jobDir();
        // The password moves into an object openPool wipes on every way out.
        ctx.root = { password: ctx.creds.root };
        ctx.creds.root = undefined;
        ctx.pool = await openPool({ address: rec.address, hostKey: rec.hostKeyPin, secret: ctx.root, dir: ctx.dir, signal: rec.abort.signal });
        const pool = await readPool(ctx.pool);
        if (pool.existing) {
          throw new Error('this pool already has a VM named fleetwright-xo, which an earlier install made. If it runs Xen Orchestra, add it with its address; otherwise remove it, then try again. Nothing was changed.');
        }
        ctx.network = pool.network;
        return `Xen Orchestra went on ${pool.network.slice(0, 80)}, the pool master’s own network${pool.sr ? `, with its disk on ${pool.sr.slice(0, 80)}` : ''}.`;
      },
      // installer
      async (/** @type {any} */ ctx) => {
        ctx.prepared = await prepareInstaller({ dir: ctx.dir, installer: this.installer, fetch: this.fetch, signal: ctx.rec.abort.signal });
        // THE PIN, before Xen Orchestra exists: the certificate made here is
        // the only one any later connection to it will take.
        ctx.rec.pin = ctx.prepared.pin;
      },
      // network, and the five stages after it, as the script says them
      async (/** @type {any} */ ctx) => {
        const rec = ctx.rec;
        const found = await runInstaller({
          pool: ctx.pool,
          prepared: ctx.prepared,
          network: ctx.network,
          signal: rec.abort.signal,
          on: {
            stage: (key) => {
              if (!rec.cancelled && key !== rec.phase && XODEPLOY_STEPS.indexOf(key) > rec.step) move(rec, key);
            },
            say: (text, fill) => {
              if (rec.cancelled) return;
              rec.text = `${STEP_WORDS[rec.phase] ?? 'Installing'}: ${text}`.slice(0, 200);
              const before = rec.part;
              rec.part = fill === null ? null : { stage: 1, stages: 1, fill };
              // An event when the download has moved a twentieth, and one
              // every few minutes while the build is quiet, so the Lock
              // Screen is not left saying it has heard nothing.
              const moved = rec.part && (!before || Math.floor(before.fill / 50) !== Math.floor(rec.part.fill / 50));
              if (moved || this.now() - (rec.reportedAt ?? 0) >= DEPLOY_HEARTBEAT_MS) this.#report(rec);
            },
          },
        });
        rec.xoAddress = found.address;
        rec.vm = found.vm;
        rec.building = null;
        rec.abort = null;
        rec.part = null;
        // The pool master is not needed again: its connection goes now
        // rather than at the end of onboarding.
        await ctx.pool.close();
        ctx.pool = null;
      },
      null, // image
      null, // vm
      null, // boot
      null, // packages
      null, // build
      // admin
      async (/** @type {any} */ ctx) => {
        const rec = ctx.rec;
        const admin = await this.#reachNewXo(rec);
        try {
          let user;
          try {
            user = await admin.call('session.signIn', { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password });
          } catch {
            throw new Error(`Xen Orchestra at ${rec.xoAddress} no longer takes its default admin password, so somebody signed in to it and changed it before this machine could. Nothing more was done; look at it in Xen Orchestra before adding it.`);
          }
          if (!user?.id) throw new Error('Xen Orchestra signed its default admin in and did not say which user that is, so its password was not changed.');
          await admin.call('user.set', { id: user.id, password: ctx.creds.admin });
        } finally {
          admin.close();
        }
        // ONBOARDING SIGNS IN WITH THE NEW ONE, which is the proof it took.
        ctx.creds.email = DEFAULT_ADMIN.email;
        ctx.creds.password = ctx.creds.admin;
        ctx.creds.admin = undefined;
      },
      ...this.#steps(),
    ];
  }

  /**
   * The Xen Orchestra an install just made, over the certificate made for
   * it. Tried for a minute: the installer says it is up once its service
   * is, and the first connection can still land a moment early.
   *
   * @param {any} rec
   */
  async #reachNewXo(rec) {
    /** @type {Error|null} */
    let last = null;
    for (let i = 0; i < 12; i++) {
      if (rec.cancelled) throw new Error('cancelled');
      try {
        return await this.connect({ address: rec.xoAddress, pin: rec.pin });
      } catch (e) {
        last = /** @type {Error} */ (e);
        await new Promise((r) => setTimeout(r, this.xoRetryMs));
      }
    }
    throw new Error(`Xen Orchestra is installed at ${rec.xoAddress} and this machine cannot reach it (${last?.message ?? 'no answer'}). Its admin is still ${DEFAULT_ADMIN.email} with the password ${DEFAULT_ADMIN.password}: sign in to it and change that now, then add it from the app.`);
  }

  /**
   * The edge router, for the apply step.
   *
   * @param {any} ctx @param {any} p @param {any} way @param {string} uplink
   * @param {(text: string, part?: any) => void} say
   * @param {Array<{ id: string, open: boolean }>|null} [labs] null leaves the edge's labs as they are
   */
  async #edge(ctx, p, way, uplink, say, labs = null) {
    const rec = ctx.rec;
    rec.building = 'edge';
    rec.part = null;
    rec.abort = new AbortController();
    return ensureEdge({
      admin: ctx.admin,
      pool: way.$pool,
      egress: { id: p.egress, name: String(way.name_label || 'the way out').slice(0, 80) },
      uplink,
      srs: ctx.srs || [],
      fleetSrs: p.srs,
      sr: p.edgeSr,
      block: p.edgeBlock,
      labs,
      fleet: fleetHosts(this.coordinatorUrl),
      rebuilding: () => {
        rec.building = 'edge-rebuild';
      },
      address: rec.address,
      pin: rec.pin,
      plain: rec.plain === true,
      imageDir: path.join(this.stateDir || '.', 'edge'),
      signal: rec.abort.signal,
      say,
    });
  }

  /** The steps, in XOSETUP_STEPS order. Each may return the sentence it leaves on the job. */
  #steps() {
    return [
      // connect
      async (/** @type {any} */ ctx) => {
        ctx.admin = await this.#open(ctx.rec);
        // Over plain HTTP the person already accepted that there is no
        // certificate at all, so there is nothing to ask of one.
        if (ctx.rec.plain) return 'It was set up over plain HTTP, as you accepted: the sign-in crossed the network unencrypted.';
        // AN INSTALL'S CERTIFICATE IS THIS MACHINE'S OWN, made before Xen
        // Orchestra existed, and the pin already held this connection to it:
        // there is nobody's word to ask for.
        if (ctx.rec.purpose === 'deploy') {
          ctx.certificate = ctx.admin.certificate;
          return;
        }
        // THE PERSON'S WORD, for a certificate nothing vouches for. The pin
        // already held this connection to the certificate they saw; this
        // holds the setup to their having been told what was wrong with it.
        const c = ctx.admin.certificate;
        if (!c?.trusted && ctx.rec.trust !== 'accepted') {
          const wrong = c?.problems?.length ? c.problems.map((/** @type {string} */ k) => CERT_PROBLEM_WORDS[k] ?? k).join(', ') : 'could not be checked';
          throw new Error(`the certificate ${wrong}, and nobody accepted it on the phone. Nothing was sent.`);
        }
        ctx.certificate = c;
      },
      // sign-in
      async (/** @type {any} */ ctx) => {
        const params = ctx.creds.token ? { token: ctx.creds.token } : { email: ctx.creds.email, password: ctx.creds.password };
        const user = await ctx.admin.call('session.signIn', params);
        // USED ONCE, and gone now rather than when the job ends: the session
        // is what the later steps work through, and a policy job can sit for
        // ten minutes waiting on a person.
        ctx.creds.password = undefined;
        ctx.creds.token = undefined;
        if (user?.permission !== 'admin') {
          throw new Error(`that account is signed in but is not a Xen Orchestra admin, and ${ctx.rec.purpose === 'policy' ? 'changing what the fleet may use' : 'adding a pool'} needs one.`);
        }
      },
      // inventory
      async (/** @type {any} */ ctx) => {
        const methods = await ctx.admin.call('system.getMethodsInfo');
        const missing = REQUIRED_METHODS.filter((m) => !(methods && Object.hasOwn(methods, m)));
        if (missing.length) {
          throw new Error(`this Xen Orchestra does not offer ${missing.join(', ')}. Nothing was changed.`);
        }
        ctx.methods = methods;
        ctx.pools = Object.values((await ctx.admin.call('xo.getAllObjects', { filter: { type: 'pool' } })) || {});
        ctx.hosts = Object.values((await ctx.admin.call('xo.getAllObjects', { filter: { type: 'host' } })) || {});
        ctx.srs = Object.values((await ctx.admin.call('xo.getAllObjects', { filter: { type: 'SR' } })) || {});
        ctx.networks = Object.values((await ctx.admin.call('xo.getAllObjects', { filter: { type: 'network' } })) || {});
        ctx.pifs = Object.values((await ctx.admin.call('xo.getAllObjects', { filter: { type: 'PIF' } })) || {});
        if (!ctx.pools.length) throw new Error('this Xen Orchestra has no pool connected to it yet. Add one in Xen Orchestra first.');
        return `Found ${plural(ctx.pools.length, 'pool')} and ${plural(ctx.hosts.length, 'host')}.`;
      },
      // user
      async (/** @type {any} */ ctx) => {
        // A PASSWORD NOBODY SEES. It exists to sign in once and mint the
        // token, and is replaced on every run, so a forgotten one is not a
        // credential anybody holds.
        ctx.password = randomBytes(24).toString('base64url');
        const users = (await ctx.admin.call('user.getAll')) || [];
        const existing = users.find((/** @type {any} */ u) => u?.email === FLEET_USER);
        if (existing) {
          await ctx.admin.call('user.set', { id: existing.id, password: ctx.password, permission: 'none' });
          ctx.userId = existing.id;
          return 'The fleetwright user was already there; its password was replaced.';
        }
        ctx.userId = await ctx.admin.call('user.create', { email: FLEET_USER, password: ctx.password, permission: 'none' });
      },
      // resource-set
      async (/** @type {any} */ ctx) => {
        const sets = (await ctx.admin.call('resourceSet.getAll')) || [];
        const existing = sets.find((/** @type {any} */ s) => s?.name === FLEET_SET);
        if (existing) {
          // A PERSON'S CHOICE IS KEPT. Defaults are for a set this run makes;
          // one that is already there was made by an earlier run, or changed
          // since by the policy job or by somebody in Xen Orchestra, and a
          // setup run again for a new token is no reason to undo that.
          if (Object.hasOwn(ctx.methods, 'resourceSet.set')) {
            await ctx.admin.call('resourceSet.set', { id: existing.id, subjects: [ctx.userId] });
          }
          ctx.setId = existing.id;
          ctx.limits = currentLimits(existing);
          return 'What it may use was already set, and was left as it was.';
        }
        const limits = limitsFrom(ctx.hosts, ctx.srs, ctx.pools);
        const objects = ctx.pools.map((/** @type {any} */ p) => p.default_SR).filter((/** @type {any} */ id) => typeof id === 'string' && id);
        const made = await ctx.admin.call('resourceSet.create', { name: FLEET_SET, subjects: [ctx.userId], objects, limits });
        ctx.setId = made?.id ?? made;
        ctx.limits = limits;
        return `It may use ${limits.cpus} vCPUs, ${gib(limits.memory)} of memory and ${gib(limits.disk)} of disk, on each pool's default storage. Change it from the app, under Hypervisors.`;
      },
      // token
      async (/** @type {any} */ ctx) => {
        ctx.limited = await this.#open(ctx.rec);
        await ctx.limited.call('session.signIn', { email: FLEET_USER, password: ctx.password });
        const description = 'fleetwright';
        try {
          ctx.token = await ctx.limited.call('token.create', { description, expiresIn: TOKEN_LIFETIME_MS });
          ctx.tokenExpires = this.now() + TOKEN_LIFETIME_MS;
        } catch {
          // A server whose maximum is under 180 days: its own default, which
          // is never over its maximum.
          ctx.token = await ctx.limited.call('token.create', { description });
          ctx.tokenExpires = null;
        }
        if (typeof ctx.token !== 'string' || !ctx.token) throw new Error('Xen Orchestra did not hand back a token.');
        ctx.limited.close();
        ctx.limited = null;
        ctx.password = undefined;
      },
      // updates
      async (/** @type {any} */ ctx) => {
        if (!Object.hasOwn(ctx.methods, 'plugin.get')) return 'This Xen Orchestra does not list its plugins; updates stay as they are.';
        const plugins = (await ctx.admin.call('plugin.get')) || [];
        const plugin = plugins.find((/** @type {any} */ p) => p?.id === UPDATES_PLUGIN || p?.name === UPDATES_PLUGIN);
        if (!plugin) {
          return 'The installer’s update plugin is not on this Xen Orchestra, so updates stay as they are.';
        }
        if (!plugin.loaded && Object.hasOwn(ctx.methods, 'plugin.load')) await ctx.admin.call('plugin.load', { id: plugin.id });
        if (!plugin.autoload && Object.hasOwn(ctx.methods, 'plugin.enableAutoload')) {
          await ctx.admin.call('plugin.enableAutoload', { id: plugin.id });
        }
        // TURNED ON ONLY WHERE NOBODY DECIDED. A person who switched automatic
        // updates off said so, and setup is not the place to overrule them.
        const configuration = plugin.configuration && typeof plugin.configuration === 'object' ? plugin.configuration : {};
        if (configuration.autoUpdate === false) return 'Automatic updates are off on this Xen Orchestra, and were left that way.';
        if (configuration.autoUpdate !== true && Object.hasOwn(ctx.methods, 'plugin.configure')) {
          await ctx.admin.call('plugin.configure', { id: plugin.id, configuration: { ...configuration, autoUpdate: true } });
          return 'Xen Orchestra now updates itself once a day.';
        }
        return 'Xen Orchestra already updates itself.';
      },
      // hand-off
      async (/** @type {any} */ ctx) => {
        const deployed = ctx.rec.purpose === 'deploy';
        const record = {
          v: 1,
          // An install's Xen Orchestra, where the installer put it; the pool
          // master it was installed through is beside it, which is what the
          // phone began the job with and opens the record under.
          address: deployed ? ctx.rec.xoAddress : ctx.rec.address,
          ...(deployed ? { poolMaster: ctx.rec.address } : {}),
          pin: ctx.rec.pin,
          user: FLEET_USER,
          userId: ctx.userId,
          resourceSet: ctx.setId ?? null,
          token: ctx.token,
          // null is the server's default length, which it does not say.
          tokenExpires: ctx.tokenExpires ? new Date(ctx.tokenExpires).toISOString() : null,
          certificate: ctx.certificate
            ? { trusted: ctx.certificate.trusted, accepted: ctx.rec.trust === 'accepted', ...(deployed ? { made: true } : {}), notAfter: ctx.certificate.notAfter }
            : null,
          // Every later call with this token crosses the network as it is.
          plain: ctx.rec.plain === true,
          limits: ctx.limits,
          pools: ctx.pools.map((/** @type {any} */ p) => ({ id: p.id, name: String(p.name_label || '').slice(0, 80) })),
          savedAt: new Date(this.now()).toISOString(),
        };
        const box = await seal({ to: ctx.rec.reply, aad: xosetupHandoffAad(ctx.rec.job, ctx.rec.address), payload: record });
        ctx.rec.handoff = `${box.epk}.${box.iv}.${box.ct}`;
        this.#forgetOldCopy(record.address);
        ctx.summary = deployed
          ? `Xen Orchestra is installed at ${record.address} and in the fleet: ${plural(ctx.pools.length, 'pool')}, worked through a limited user. Sign in to it as ${DEFAULT_ADMIN.email} with the password you chose. Its token was sealed to your phone; this machine kept no copy, and the root password was used once and not kept.`
          : `${ctx.rec.address} is in the fleet: ${plural(ctx.pools.length, 'pool')}, worked through a limited user. Its token was sealed to your phone and this machine kept no copy; the admin sign-in was not kept either.`;
      },
    ];
  }

  /**
   * The file the first version kept the token in, removed when the same pool
   * is set up again, so a machine that once held a pool's key stops holding
   * it the next time anybody runs the setup there. Nothing else reads it.
   *
   * @param {string} address
   */
  #forgetOldCopy(address) {
    if (!this.stateDir) return;
    const name = address.replace(/[^A-Za-z0-9.-]+/g, '_');
    try {
      unlinkSync(path.join(this.stateDir, 'hypervisors', `${name}.json`));
      this.log.info(`xosetup: removed the token the first version kept here for ${address}`);
    } catch {
      /* never kept here */
    }
  }
}

/** The words a job leaves on itself while it runs: the same keys the apps word. */
export const STEP_WORDS = Object.freeze(/** @type {Record<string, string>} */ ({
  connect: 'Reaching Xen Orchestra',
  'sign-in': 'Signing in',
  inventory: 'Reading the pool',
  user: 'Making the fleetwright user',
  'resource-set': 'Setting what it may use',
  token: 'Making its token',
  updates: 'Turning on updates',
  'hand-off': 'Handing over',
  choose: 'Waiting for your choice',
  apply: 'Applying what you chose',
  // An install's own (XODEPLOY_STEPS); the apps say the same.
  reach: 'Reaching the pool master',
  installer: 'Fetching the installer',
  network: 'Setting up its network',
  image: 'Getting Debian 13',
  vm: 'Making its VM',
  boot: 'Booting it',
  packages: 'Installing packages',
  build: 'Building Xen Orchestra',
  admin: 'Replacing the default admin password',
}));

/**
 * How a cancelled install ended, in what is known of the pool by then. Before
 * the installer ran, nothing was made. While it ran, it removes what it made
 * if it is stopped before its VM starts and keeps the VM after, and which of
 * those happened is the installer's to know, so the sentence names what to
 * look for rather than claiming either (C-5).
 *
 * @param {string} phase
 */
function deployCancelled(phase) {
  if (phase === 'reach' || phase === 'installer') return 'Cancelled before anything was made on the pool.';
  if (STAGES.includes(phase)) {
    return 'Cancelled while the installer ran. Anything it had made may still be on the pool: a VM named fleetwright-xo, and disks named for it.';
  }
  return 'Cancelled after Xen Orchestra was installed, as fleetwright-xo on the pool, before it was added. If this got past replacing its admin password, the password is the one you chose; add it from the app with its address.';
}

/**
 * What the phone is shown to choose from: the pool's storage and networks,
 * what it has, and what the fleet may use now. Names and sizes, never a
 * credential, and sealed to the phone all the same.
 *
 * @param {any} ctx @param {any} set  the resource set as `resourceSet.getAll` answers
 */
export function inventoryOf(ctx, set) {
  const pools = (ctx.pools || []).map((/** @type {any} */ p) => ({ id: String(p.id), name: String(p.name_label || '').slice(0, 80) }));
  // Storage a VM's disk can go on: not an ISO library, not a removable drive.
  const srs = (ctx.srs || [])
    .filter((/** @type {any} */ sr) => sr?.id && sr.content_type !== 'iso' && sr.content_type !== 'udev')
    .map((/** @type {any} */ sr) => ({
      id: String(sr.id),
      name: String(sr.name_label || '').slice(0, 80),
      pool: sr.$pool ? String(sr.$pool) : null,
      size: Math.max(0, Number(sr.size) || 0),
      free: Math.max(0, (Number(sr.size) || 0) - (Number(sr.physical_usage) || 0)),
      shared: sr.shared === true,
    }));
  const vlanOf = (/** @type {string} */ id) => {
    const pif = (ctx.pifs || []).find((/** @type {any} */ f) => f?.$network === id && Number(f.vlan) >= 0);
    return pif ? Number(pif.vlan) : null;
  };
  const networks = (ctx.networks || [])
    .filter((/** @type {any} */ n) => n?.id)
    .map((/** @type {any} */ n) => ({
      id: String(n.id),
      name: String(n.name_label || '').slice(0, 80),
      pool: n.$pool ? String(n.$pool) : null,
      vlan: vlanOf(n.id),
      egress: Array.isArray(n.tags) && n.tags.includes(EGRESS_TAG),
    }));
  const objects = new Set(Array.isArray(set?.objects) ? set.objects.map(String) : []);
  // Each pool's edge router, by pool, and whether it is running: what the
  // phone needs to say "it is there" rather than offer to build another.
  const edges = (ctx.edges || []).map((/** @type {any} */ v) => {
    const disk = (ctx.edgeDisks || []).find((/** @type {any} */ d) => d?.$pool === v.$pool && Array.isArray(d?.$VBDs) && d.$VBDs.length);
    const sr = disk ? (ctx.srs || []).find((/** @type {any} */ x) => x?.id === disk.$SR) : null;
    return {
      pool: v.$pool ? String(v.$pool) : null,
      running: v.power_state === 'Running',
      // The storage its disk is on, by name, or null when that cannot be told.
      sr: sr ? srName(sr) : null,
      // Whether it drops what its threat rules match, or only logs it.
      blocks: Array.isArray(v.tags) && v.tags.includes(EDGE.blocksTag),
      // And the labs it was built with, by kind.
      labs: { open: [...edgeLabsOf(v)].filter((c) => c === 'o').length, closed: [...edgeLabsOf(v)].filter((c) => c === 'c').length },
      // And how many of them one person may hold at once, from the labs'
      // own networks: a number, or null for no limit, which is what a
      // policy from before the setting has.
      labsEach: labsEachOf(ctx.networks || [], v.$pool ?? null),
    };
  });
  // Each pool's machine image, by pool and name: what the phone needs to say
  // "it is there" rather than offer to build another.
  const images = (ctx.images || []).map((/** @type {any} */ t) => ({
    pool: t.$pool ? String(t.$pool) : null,
    name: String(t.name_label || VM_IMAGE.name).slice(0, 80),
    key: imageKeyOf(t),
  }));
  // Each pool's own machine, by pool and name, and whether it is up.
  const holders = (ctx.holders || []).map((/** @type {any} */ v) => ({
    pool: v.$pool ? String(v.$pool) : null,
    name: String(v.name_label || '').slice(0, 80),
    running: v.power_state === 'Running',
  }));
  return {
    v: 1,
    address: ctx.rec.address,
    pools,
    srs,
    networks,
    edges,
    images,
    holders,
    // WHICH OPERATING SYSTEMS AN IMAGE CAN BE MADE OF, from this machine's
    // catalogue, so the phone offers each and never one it cannot build.
    imageKinds: Object.values(IMAGES).map((/** @type {any} */ i) => ({ key: i.key, os: i.os })),
    // THE GROUP NETWORKS each pool has, by name, so the phone starts from
    // how many there are and a policy never asks for fewer than exist.
    groups: (ctx.networks || [])
      .filter((/** @type {any} */ n) => typeof n?.name_label === 'string' && n.name_label.startsWith(GROUP_PREFIX))
      .map((/** @type {any} */ n) => ({ id: String(n.id), name: String(n.name_label).slice(0, 80), pool: n.$pool ? String(n.$pool) : null })),
    // THE MOST LABS AN EDGE HAS ROOM FOR, so the phone never offers more.
    labMax: LAB.max,
    capacity: {
      cpus: (ctx.hosts || []).reduce((/** @type {number} */ n, /** @type {any} */ h) => n + (Number(h?.cpus?.cores) || 0), 0),
      memory: (ctx.hosts || []).reduce((/** @type {number} */ n, /** @type {any} */ h) => n + (Number(h?.memory?.size) || 0), 0),
    },
    current: {
      srs: srs.filter((/** @type {any} */ x) => objects.has(x.id)).map((/** @type {any} */ x) => x.id),
      networks: networks.filter((/** @type {any} */ x) => objects.has(x.id)).map((/** @type {any} */ x) => x.id),
      limits: currentLimits(set),
    },
  };
}

/** What a choice is checked against: the ids the phone was shown, and the pool's size. @param {any} inventory */
function choicesOf(inventory) {
  return {
    srs: new Map(inventory.srs.map((/** @type {any} */ x) => [x.id, x.size])),
    networks: new Set(inventory.networks.map((/** @type {any} */ x) => x.id)),
    capacity: inventory.capacity,
    // Which pool each network is in, and which pools have their edge router:
    // a machine image is built behind one (checkPolicy).
    networkPools: new Map(inventory.networks.map((/** @type {any} */ x) => [x.id, x.pool])),
    edgePools: new Set((inventory.edges || []).map((/** @type {any} */ e) => e.pool)),
    imageKeys: new Set((inventory.imageKinds || []).map((/** @type {any} */ k) => k.key)),
    // Which pools have a machine image already: the pool's own machine is
    // cloned from one (checkPolicy).
    imagePools: new Set((inventory.images || []).map((/** @type {any} */ i) => i.pool)),
  };
}

/**
 * A resource set's limits as numbers. `resourceSet.getAll` answers each as
 * `{ total, available }` and `create` takes the number, so either is read.
 *
 * @param {any} set
 */
export function currentLimits(set) {
  /** @param {any} v */
  const n = (v) => {
    const x = Number(v && typeof v === 'object' ? v.total : v);
    return Number.isFinite(x) && x > 0 ? x : null;
  };
  return { cpus: n(set?.limits?.cpus), memory: n(set?.limits?.memory), disk: n(set?.limits?.disk) };
}

/**
 * The person's choice, checked against what they were shown. Every id must
 * be one the inventory listed, and each limit must be at least a usable
 * machine and at most what is there.
 *
 * THE WAY OUT IS ANY NETWORK THE POOL LISTED, not only one the fleet may
 * use. The first version held it to those, when the router was to be a
 * fleet VM that could attach to nothing else; it is built with the admin
 * sign-in now (edge-router.js), and a WAN the fleet's VMs may not attach
 * to is the better place for it, since a lab on it would leave without
 * passing through the router. Asked for: a way out that was not one of
 * the fleet's networks could not be picked at all.
 *
 * @param {any} p @param {ReturnType<typeof choicesOf>|null} choices
 * `edge` asks for the edge router on the way out; it needs one. `image` asks
 * for the machine image sessions' machines are cloned from, on the way out's
 * pool; it is built behind the edge router, so it needs one there or asked
 * for with it. `holder` asks for the pool's own machine (xo-holder.js) on
 * the way out, cloned from the pool's machine image, there or asked for.
 * `edgeBlock` is whether the edge router drops what its threat rules match
 * (true) or only logs it (false); absent, an edge that is there is left as it
 * is and a new one only logs (edge-router.js, ensureEdge).
 * `labs` is how many labs the edge has, `{ open, closed }`, at most LAB.max
 * together; absent, an edge's labs are left as they are. Labs live on the
 * edge, so they need one there or asked for.
 * `labsEach` is how many of them one person may hold at once: null for no
 * limit, or a whole number from 1 to the labs asked for, and only with them;
 * absent, from a phone that predates it, the labs keep the one they have.
 *
 * @returns {{ ok: true, policy: { srs: string[], networks: string[], egress: string|null, edge: boolean, edgeSr: string|null, edgeBlock: boolean|null, image: boolean, images: string[], groups: number, holder: boolean, labs: { open: number, closed: number }|null, labsEach?: number|null, limits: { cpus: number, memory: number, disk: number } } } | { ok: false, text: string }}
 */
export function checkPolicy(p, choices) {
  if (!choices || p?.v !== 1) return { ok: false, text: 'That is not a choice this job can take.' };
  const ids = (/** @type {unknown} */ v) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...new Set(/** @type {string[]} */ (v))] : null);
  const srs = ids(p.srs);
  const networks = ids(p.networks);
  if (!srs || !networks) return { ok: false, text: 'That choice is not lists of storage and networks.' };
  if (!srs.length) return { ok: false, text: 'Choose at least one storage repository: a VM needs somewhere for its disk.' };
  if (srs.some((id) => !choices.srs.has(id)) || networks.some((id) => !choices.networks.has(id))) {
    return { ok: false, text: 'That names storage or a network this pool did not list. Nothing was changed.' };
  }
  const egress = p.egress === null || p.egress === undefined ? null : String(p.egress);
  if (egress !== null && !choices.networks.has(egress)) {
    return { ok: false, text: 'The way out has to be a network this pool listed. Nothing was changed.' };
  }
  const edge = p.edge === true;
  if (edge && egress === null) return { ok: false, text: 'The edge router needs a way out: choose the network its WAN goes on.' };
  // WHERE ITS DISK GOES, when the phone asked: storage the pool listed. That
  // it is in the way out's pool and has room is checked where it is used.
  const edgeSr = p.edgeSr === null || p.edgeSr === undefined ? null : String(p.edgeSr);
  if (edgeSr !== null && !choices.srs.has(edgeSr)) return { ok: false, text: 'The edge router’s disk has to go on storage this pool listed. Nothing was changed.' };
  if (p.edgeBlock !== undefined && p.edgeBlock !== null && typeof p.edgeBlock !== 'boolean') return { ok: false, text: 'Whether the edge blocks is yes or no. Nothing was changed.' };
  const edgeBlock = edge && typeof p.edgeBlock === 'boolean' ? p.edgeBlock : null;
  // WHICH IMAGES: a list of the catalogue's keys, or `image: true` from a
  // phone that predates the choice, which is Debian.
  const asked = Array.isArray(p.images) ? [...new Set(p.images.map(String))] : p.image === true ? ['debian-13'] : [];
  if (asked.some((k) => !(choices.imageKeys ?? new Set(Object.keys(IMAGES))).has(k))) {
    return { ok: false, text: 'That names a machine image this machine cannot build. Nothing was changed.' };
  }
  const image = asked.length > 0;
  // GROUP NETWORKS, in the way out's pool: how many to have, 0 to MAX_GROUPS.
  const groups = p.groups === undefined || p.groups === null ? 0 : p.groups;
  if (typeof groups !== 'number' || !Number.isInteger(groups) || groups < 0 || groups > MAX_GROUPS) {
    return { ok: false, text: `Between 0 and ${MAX_GROUPS} group networks. Nothing was changed.` };
  }
  if (groups && egress === null) return { ok: false, text: 'Group networks are made in the way out’s pool: choose the way out. Nothing was changed.' };
  if (image && egress === null) return { ok: false, text: 'The machine image is built behind the edge router: choose the way out it leaves through.' };
  if (image && !edge && !choices.edgePools?.has(choices.networkPools?.get(/** @type {string} */ (egress)))) {
    return { ok: false, text: 'The machine image is built behind the edge router, and that pool has none yet. Build the router with it. Nothing was changed.' };
  }
  // LABS, on the edge: how many of each kind, together at most LAB.max.
  /** @type {{ open: number, closed: number }|null} */
  let labs = null;
  if (p.labs !== undefined && p.labs !== null) {
    const open = p.labs?.open;
    const closed = p.labs?.closed;
    const whole = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
    if (!whole(open) || !whole(closed) || open + closed > LAB.max) return { ok: false, text: `Between 0 and ${LAB.max} labs in all. Nothing was changed.` };
    if (egress === null) return { ok: false, text: 'Labs are on the edge router: choose the way out it is on. Nothing was changed.' };
    if (!edge && !choices.edgePools?.has(choices.networkPools?.get(egress))) {
      return { ok: false, text: 'Labs are on the edge router, and that pool has none yet. Build the router with them. Nothing was changed.' };
    }
    labs = { open, closed };
  }
  // LABS PER PERSON: no limit (null), or one to as many labs as there are.
  /** @type {number|null|undefined} */
  let labsEach;
  if (p.labsEach !== undefined) {
    if (labs === null) return { ok: false, text: 'Labs per person goes with the labs it limits. Nothing was changed.' };
    const all = labs.open + labs.closed;
    const n = p.labsEach;
    if (n !== null && !(typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= all)) {
      return { ok: false, text: all ? `Labs per person is no limit, or 1 to ${all}, the labs there are. Nothing was changed.` : 'With no labs, labs per person is no limit. Nothing was changed.' };
    }
    labsEach = n;
  }
  const holder = p.holder === true;
  if (holder && egress === null) return { ok: false, text: 'The pool’s own machine goes on the way out: choose the network it is on.' };
  if (holder && !image && !choices.imagePools?.has(choices.networkPools?.get(/** @type {string} */ (egress)))) {
    return { ok: false, text: 'The pool’s own machine is made from its machine image, and that pool has none yet. Build one with it. Nothing was changed.' };
  }
  const cpus = Number(p.limits?.cpus);
  const memory = Number(p.limits?.memory);
  const disk = Number(p.limits?.disk);
  const room = srs.reduce((n, id) => n + (Number(choices.srs.get(id)) || 0), 0);
  const maxCpus = Math.max(1, Number(choices.capacity?.cpus) || 0);
  const maxMemory = Math.max(MIN_MEMORY, Number(choices.capacity?.memory) || 0);
  const maxDisk = Math.max(MIN_DISK, room);
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > maxCpus) return { ok: false, text: `vCPUs are between 1 and ${maxCpus}, what the pool has.` };
  if (!Number.isInteger(memory) || memory < MIN_MEMORY || memory > maxMemory) return { ok: false, text: `Memory is between 1 GiB and ${gib(maxMemory)}, what the pool has.` };
  if (!Number.isInteger(disk) || disk < MIN_DISK || disk > maxDisk) return { ok: false, text: `Disk is between 10 GiB and ${gib(maxDisk)}, the size of the storage chosen.` };
  return { ok: true, policy: { srs, networks, egress, edge, edgeSr: edge || image || labs ? edgeSr : null, edgeBlock, image, images: asked, groups, holder, labs, ...(labsEach !== undefined ? { labsEach } : {}), limits: { cpus, memory, disk } } };
}

/**
 * Half of what the pool has, as a resource set's limits: enough for the
 * fleet's VMs to be useful, never enough to starve what was already there.
 * The person can change it in Xen Orchestra; a later run puts it back.
 *
 * @param {any[]} hosts @param {any[]} srs @param {any[]} pools
 */
export function limitsFrom(hosts, srs, pools) {
  const cpus = hosts.reduce((n, h) => n + (Number(h?.cpus?.cores) || 0), 0);
  const memory = hosts.reduce((n, h) => n + (Number(h?.memory?.size) || 0), 0);
  const defaults = new Set(pools.map((p) => p?.default_SR));
  const disk = srs.filter((s) => defaults.has(s?.id)).reduce((n, s) => n + Math.max(0, (Number(s?.size) || 0) - (Number(s?.physical_usage) || 0)), 0);
  return {
    cpus: Math.max(1, Math.floor(cpus / 2)),
    memory: Math.max(1024 ** 3, Math.floor(memory / 2)),
    disk: Math.max(10 * 1024 ** 3, Math.floor(disk / 2)),
  };
}

/** @param {any} rec @returns {SetupStatus} */
function status(rec) {
  // `part` while a step that can say how far it has got is running: the edge
  // router's build, its stage of three and how far through, in thousandths.
  // `part.build` says WHAT the part is of, so the phone does not call an
  // image's disk the edge router's: the first version had one sentence for
  // every build, written when the router was the only thing built in parts.
  const s = { job: rec.job, state: rec.state, step: rec.step, of: rec.of, phase: rec.phase, text: rec.text, ...(rec.part && rec.state === 'running' ? { part: { ...rec.part, ...(buildKey(rec) ? { build: buildKey(rec) } : {}) } } : {}) };
  // THE TOKEN, SEALED, to the person who began the job (`#mine` already
  // checked) and only once it is done. Asked for as often as the phone likes
  // until the job is forgotten, because a phone that was closed at the end
  // collects it whenever it next looks.
  if (rec.state === 'done' && rec.handoff) return { ...s, handoff: rec.handoff };
  // THE POOL, SEALED, while the job waits on the person's choice.
  if (rec.state === 'choosing' && rec.inventory) return { ...s, inventory: rec.inventory };
  return s;
}

/**
 * What the step now running is building, as the fixed key a Live Activity
 * may carry (narrowProgress in core.js): `edge`, `image` or `holder`, or null.
 * A rebuilt edge is still the edge router.
 *
 * @param {any} rec
 */
function buildKey(rec) {
  const b = String(rec.building ?? '');
  if (b === 'edge-rebuild') return 'edge';
  return ['edge', 'image', 'holder'].includes(b) ? b : null;
}

function unknown() {
  return { ok: false, text: 'No setup with that id is running here for you.' };
}

/**
 * An error's words, with anything from the sign-in taken out. Xen Orchestra
 * does not echo a password back, and this does not rely on it.
 *
 * @param {string} message @param {{ password?: string, token?: string, root?: string, admin?: string }} creds
 */
function scrub(message, creds) {
  let out = String(message || 'an error');
  for (const secret of [creds.password, creds.token, creds.root, creds.admin]) {
    if (secret && secret.length >= 4) out = out.split(secret).join('…');
  }
  return out.slice(0, 300);
}

/** @param {number} n @param {string} word */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** @param {number} bytes */
function gib(bytes) {
  return `${Math.round(bytes / 1024 ** 3)} GiB`;
}
