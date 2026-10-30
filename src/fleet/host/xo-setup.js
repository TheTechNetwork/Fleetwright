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
// set that bounds it, and a token for it, removing the tokens earlier runs
// made (a lost phone's among them); turn on the installer's own update
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
// RECONNECTING A POOL'S SERVERS is a job of its own as well, begun the same
// way, whose sealed sign-in says `purpose: 'reconnect'`. It is for when Xen
// Orchestra answers and shows none of a pool (xo-pools.js notices, from the
// fleet's own token), which reconnecting its servers usually mends, and which
// the limited user cannot do: `server.getAll`, `server.enable` and
// `server.disable` are an admin's. So the person's phone sends the admin
// sign-in once, sealed to this job, and the machine signs in, reads the
// servers, and reconnects only those that are not connected, one at a time:
// a disconnected one is enabled, one stuck connecting or connected with an
// error is disabled and enabled again, and one a person turned off is left
// off and named. It then waits, at most three minutes, for the servers it
// touched to connect and their pools to show. Which servers there were and
// what became of each is sealed to the phone (xosetupReconnectAad); what the
// coordinator relays is counts. The whole job holds the signed-in session,
// never the password, for at most ten minutes, and keeps nothing.
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
import dns from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import { rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { XOSETUP_STEPS, XOPOLICY_STEPS, XODEPLOY_STEPS, XORECONNECT_STEPS, XOWATCHDOG_STEPS, XO_ADDRESS_RE, XOSETUP_JOB_RE, IMAGE_REPORT_STEPS, CERT_PIN_RE } from '../protocol/intents.js';
import { SEAL_KEY_RE, newSealKey, open as openSealed, seal, xodeployAad, xowatchdogAad, xosetupAad, xosetupHandoffAad, xosetupInventoryAad, xosetupPolicyAad, xosetupReconnectAad, xosetupPolicySigninAad, xosetupReconnectSigninAad, xosetupWatchAad } from '../seal.js';
import { signingInput } from '../crypto.js';
import { certSha256, splitAddress, connectXo, connectXoPlain, describeCertificate, CERT_PROBLEM_WORDS } from './xo-ws.js';
import { machineGrantsOf } from '../../core/grants.js';
import { EDGE, EDGE_HA, GROUP_PREFIX, LAB, MAX_GROUPS, edgeLabsOf, ensureEdge, ensureGroups, ensureLabs, ensureUplink, fleetHosts, labsEachOf, srName, wanAddressOf } from './edge-router.js';
import { VM_IMAGE, IMAGES, IMAGE_CHANNELS, ensureImage, removeImage, imageKeyOf, imageChannelOf, isFleetImage } from './vm-image.js';
import { ensureHolder, isHolder } from './xo-holder.js';
import { FLEET_SET, setsOf } from './xo-made.js';
import { HOLDER_SECRET_RE } from '../protocol/holder-join.js';
import { clearExposed, exposedOn, keptFor, newWatch, watchOf } from './edge-credentials.js';
import { DEFAULT_ADMIN, INSTALLER, MIN_ADMIN_PASSWORD, STAGES, jobDir, openPool, prepareInstaller, readPool, runInstaller, sshProbe } from './xo-deploy.js';
import { addToDisk, findXoVm, startXoVm, stopXoVm, waitForXo } from './xo-watchdog.js';

/** The user onboarding makes, by the name Xen Orchestra keys users on. */
export const FLEET_USER = 'fleetwright';
/** The resource set that bounds it, by name: xo-made.js's, which reads it too. */
export { FLEET_SET };
/** The installer's update plugin, as Xen Orchestra names a plugin: its package minus `xo-server-`. */
export const UPDATES_PLUGIN = 'installer-updates';
/** Fleetwright's reconnect watchdog, by the same rule: xo-server-fleetwright-reconnect. */
export const RECONNECT_PLUGIN_ID = 'fleetwright-reconnect';

/**
 * What `inventory` checks the server offers before anything is changed.
 * `token.deleteAll`, which the token step asks for as the limited user, is
 * not here on purpose: a server without it still gets its token, and the
 * summary says the earlier tokens stayed (#revokeOlderTokens).
 */
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
/** What reconnecting a pool's servers asks of the server, checked before anything is changed. */
const RECONNECT_METHODS = Object.freeze(['server.getAll', 'server.enable', 'server.disable', 'xo.getAllObjects']);
/**
 * THE CLOCKS OF A RECONNECT, each a bound and none a guess at how long Xen
 * Orchestra takes. A server disabled to be cycled is given half a minute to
 * let go of its connection; one Xen Orchestra is still connecting is asked
 * again every two seconds for half a minute; the pools are looked for every
 * five seconds for three minutes; and the whole job, signed in as an admin,
 * stops at ten.
 */
const RECONNECT = Object.freeze({ settleMs: 30_000, retryMs: 2_000, retryForMs: 30_000, pollMs: 5_000, waitMs: 3 * 60_000, capMs: 10 * 60_000 });
/** How long a call to Xen Orchestra is waited for where the connection does not say (XoRpc's own default, xo-ws.js). */
const CALL_TIMEOUT_MS = 60_000;
/**
 * THE LONGEST ONE CYCLE CAN TAKE (#cycle), with every call waiting as long
 * as the connection waits for one: the disable; half a minute of letting go,
 * a pause, and the look that ends it; half a minute of asking to be enabled,
 * a pause, and the enable and look that end it; and the one enable a failed
 * cycle asks for. About six minutes at XoRpc's minute a call, which is what
 * the reconnect step leaves room for before it begins one.
 *
 * @param {number} callMs
 */
function cycleMs(callMs) {
  return RECONNECT.settleMs + RECONNECT.retryForMs + 2 * RECONNECT.retryMs + 5 * callMs;
}
/** How often an install that is quiet still says it is going: under the Lock Screen's twenty minutes of silence. */
const DEPLOY_HEARTBEAT_MS = 5 * 60_000;
/** The tag on the network the edge router's WAN goes on: the way out of every lab. */
export const EGRESS_TAG = 'fleetwright-egress';
/** What building the edge router asks of the server, checked before anything is made. */
export const EDGE_METHODS = Object.freeze(['network.create', 'resourceSet.addObject', 'disk.import', 'vm.create', 'vm.attachDisk', 'vif.set', 'vm.start', 'user.getAll', 'user.create', 'user.set']);
/** What making labs asks of the server, beside rebuilding the edge with them. */
export const LAB_METHODS = Object.freeze(['network.create', 'tag.add', 'tag.remove', 'resourceSet.addObject']);
/** What building the machine image asks of the server, checked before anything is made. */
export const IMAGE_METHODS = Object.freeze(['disk.import', 'vm.create', 'vm.attachDisk', 'vm.createCloudInitConfigDrive', 'vdi.delete', 'vm.start', 'vm.set', 'vm.convertToTemplate', 'tag.add', 'resourceSet.addObject']);
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
 * @property {string} [watch]  once a policy job is done: the key the fleet reads
 *   the pool's edge routers with (edge-credentials.js), sealed to the same key
 * @property {string} [inventory]  a policy job waiting on the person: the
 *   pool's storage, networks and capacity (inventoryOf), sealed to the same key
 * @property {string} [result]  once a reconnect job that read the servers
 *   has ended, however it ended: each server, what was done to it and what
 *   it was doing at the last look, and the pools Xen Orchestra showed then
 *   (reconnectResult), sealed to the same key
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
   *   dropImage?: typeof removeImage,
   *   holderPin?: ((job: string, address: string) => Promise<any>)|null,
   *   imageReporter?: ((job: string) => Promise<any>)|null,
   *   installer?: typeof INSTALLER,
   *   fetch?: typeof globalThis.fetch,
   *   xoRetryMs?: number,
   *   relay?: { open: (relay: string) => Promise<import('node:stream').Duplex>, done: (relay: string) => void }|null,
   *   sleep?: (ms: number) => Promise<void>,
   *   onEnd?: ((ended: { job: string, purpose: string, state: string }) => void)|null,
   *   waitXo?: typeof waitForXo,
   *   resolveXo?: (host: string) => Promise<string[]>,
   * }} opts
   */
  constructor({ signer, emit, stateDir, connect = connectXo, connectPlain = connectXoPlain, fingerprint, now = () => Date.now(), log, policyWaitMs = POLICY_WAIT_MS, coordinatorUrl = null, buildImage = ensureImage, dropImage = removeImage, holderPin = null, imageReporter = null, installer = INSTALLER, fetch = globalThis.fetch, xoRetryMs = 5_000, relay = null, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onEnd = null, waitXo = waitForXo, resolveXo = resolveAddresses }) {
    // HOW ADDING THE WATCHDOG FINDS XEN ORCHESTRA'S VM AND WAITS FOR IT TO
    // ANSWER AGAIN: the addresses its name resolves to, and a connection.
    this.waitXo = waitXo;
    this.resolveXo = resolveXo;
    this.policyWaitMs = policyWaitMs;
    // HOW A RECONNECT WAITS between its looks at Xen Orchestra, read against
    // `now`: its bounds (RECONNECT) are times on that clock, not counts of
    // looks, so a clock that is not the wall's moves them together.
    this.sleep = sleep;
    // WHO IS TOLD A JOB HAS ENDED, whichever way: the sidecar, which looks at
    // the pools again with the fleet's own token after a reconnect, so the
    // pools coming back is seen by the eyes that saw them go.
    this.onEnd = onEnd;
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
    /** @type {((job: string, address: string) => Promise<any>)|null} */
    this.holderPin = holderPin;
    // AND FOR THE TOKEN a machine image's build VM reports its install with
    // (vm-image.js). Without it the build goes on, judged by power state.
    /** @type {((job: string) => Promise<any>)|null} */
    this.imageReporter = imageReporter;
    // THE FLEET A MACHINE IMAGE INSTALLS FROM AND ITS MACHINES JOIN: this
    // box's own, as it pinned it. Without one this box does not offer to
    // build an image (`can`).
    this.coordinatorUrl = coordinatorUrl;
    this.buildImage = buildImage;
    this.dropImage = dropImage;
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
        // `image-manage`: it rebuilds or removes an image that is there
        // (`rebuild`, `remove`). An older one keeps every image as it is.
        // `edge-ha`: it builds the edge as a pair sharing its addresses
        // (`edgeHa`, edge-router.js EDGE_HA). An older one builds one.
        // `holder-ask`: the pool's own machine it makes asks to join with the
        // phone's secret (`holderSecret`), and it makes one again
        // (`holderAgain`). An older one ignores both, so a phone offers
        // Make it again only where this is said.
        // `machine-grants`: the pool's own machine it makes is born allowed
        // what its owner chose (`grants`, src/core/grants.js machineGrantsOf),
        // and so is every machine it makes from the pool's record. An older
        // one leaves them the image's answer, so a phone offers the choice
        // only where this is said.
        // `image-channel`: it builds an image from the apt suite chosen
        // (`imageChannel`, `stable` or `rolling`, vm-image.js IMAGE_CHANNELS)
        // and says which each image was built from. An older one builds
        // every image from stable.
        // `reconnect`: it reconnects Xen Orchestra's servers with the admin
        // sign-in (`purpose: 'reconnect'`, #reconnectSteps). An older one
        // would take that sign-in for a whole setup, so a phone seals one
        // only where this is said.
        // `reconnect-signin`: it opens that sign-in under a reconnect's own
        // binding (seal.js, xosetupReconnectSigninAad), and a phone seals
        // one under nothing else. `can` is not signed, so a relay could add
        // `reconnect` to an older machine's list; under its own binding the
        // sign-in does not open there, where under the setup's it was run as
        // a whole setup.
        // `policy-signin`: the same for a policy change's sign-in
        // (xosetupPolicySigninAad), which under the setup's name a machine
        // from before policy changes ran as a whole setup, resetting the
        // pool's resource set (seventh audit).
        can: [
          'policy', 'policy-signin', 'reconnect', 'reconnect-signin', 'edge', 'egress-any', 'edge-disk', 'edge-block', 'edge-ha', 'groups',
          ...(this.coordinatorUrl ? ['image', 'images', 'labs', 'labs-each', 'image-manage', 'machine-grants', 'image-channel'] : []),
          ...(this.coordinatorUrl && this.holderPin ? ['holder', 'holder-ask'] : []),
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
   * Adding the reconnect watchdog to a Xen Orchestra that predates it (phase
   * `watchdog`, XOWATCHDOG_STEPS): begun as an install is, against the pool
   * master that runs Xen Orchestra's VM, pinned to the SSH host key the
   * person compared, and the job's key signed under its own context
   * (`xowatchdog-key`), so neither key can pass for the other's.
   *
   * @param {{ address: string, pin?: string|null, relay?: string|null, actor: string|null }} args
   */
  async beginWatchdog({ address, pin, relay = null, actor }) {
    this.#prune();
    if (!actor) return { ok: false, text: 'Adding the watchdog has to be asked for by a signed-in person.' };
    if (!this.signer) {
      return {
        ok: false,
        text: 'This machine has no enrolment key to sign a job key with, so a phone could not tell the key was this machine’s. Enrol it with a pin first.',
      };
    }
    if (relay !== null) {
      return {
        ok: false,
        text: 'Adding the watchdog needs a machine that reaches the pool: it connects to the pool master over SSH, which this machine does not do through your phone. Ask from a machine on the pool’s network.',
      };
    }
    if (!pin || !CERT_PIN_RE.test(pin)) return { ok: false, text: 'Adding the watchdog needs the pool master’s SSH host key you compared. Find a machine that can reach it from the app first.' };
    if ([...this.jobs.values()].filter((j) => j.state === 'waiting' || j.state === 'running' || j.state === 'choosing').length >= 3) {
      return { ok: false, text: 'This machine is already running three setups. Wait for one to finish.' };
    }
    const signer = /** @type {NonNullable<typeof this.signer>} */ (this.signer);
    const job = randomBytes(6).toString('hex');
    const key = await newSealKey();
    const keySig = await signer.sign(signingInput('xowatchdog-key', { address, job, key: key.publicKey, pin }));
    const hostKey = { kty: 'EC', crv: 'P-256', x: signer.publicJwk.x, y: signer.publicJwk.y };
    this.jobs.set(job, {
      job,
      address,
      hostKeyPin: pin,
      purpose: 'watchdog',
      pin: null,
      plain: false,
      trust: null,
      actor,
      key,
      state: 'waiting',
      step: 0,
      of: XOWATCHDOG_STEPS.length,
      phase: XOWATCHDOG_STEPS[0],
      text: 'Waiting for the root password.',
      at: this.now(),
      cancelled: false,
    });
    return {
      ok: true,
      text: 'Ready for the root password. Check the key is this machine’s, then send it sealed.',
      xosetup: { job, state: 'waiting', key: key.publicKey, keySig, hostKey, fingerprint: await this.fingerprint(hostKey), can: ['watchdog'] },
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
    const watchdog = rec.purpose === 'watchdog';
    const box = { epk: parts[0], iv: parts[1], ct: parts[2] };
    // UNDER THE SETUP'S NAME, OR A RECONNECT'S OR A POLICY CHANGE'S OWN: a
    // phone that knows this machine lists `reconnect-signin` and
    // `policy-signin` seals each under its own name, which a machine too old
    // to know the job cannot open (seal.js).
    /** @type {'setup'|'reconnect'|'policy'} */
    let under = 'setup';
    // ONE RUN AT A TIME, settled before the first await. Two runs of one
    // job arriving together both passed the check above, because the first
    // was still opening its seal when the second looked, and both ran the
    // steps: two admin sign-ins, two tokens. So the key is taken and the job
    // is running from here, and the second run is refused above as one that
    // has its sign-in. A seal that does not open gives both back, so the
    // phone can send the right one; a cancel that landed meanwhile stands.
    // ONE USE: the key goes as soon as it has opened the one thing it exists
    // for, which for a policy job is two things (below).
    const jobKey = rec.key;
    const waitingText = rec.text;
    rec.key = null;
    rec.state = 'running';
    rec.text = 'Opening the sign-in.';
    /** @param {string} text */
    const notOpened = (text) => {
      if (rec.cancelled) {
        rec.state = 'cancelled';
        rec.text = 'Cancelled before it started.';
        this.#report(rec);
        this.#ended(rec);
      } else {
        rec.key = jobKey;
        rec.state = 'waiting';
        rec.text = waitingText;
      }
      return { ok: false, text };
    };
    /** @param {string} aad */
    const tryOpen = (aad) => openSealed({ privateKey: jobKey.privateKey, publicKey: jobKey.publicKey, aad, sealed: box });
    try {
      inside = await tryOpen(deploy ? xodeployAad(job, rec.address) : watchdog ? xowatchdogAad(job, rec.address) : xosetupAad(job, rec.address));
    } catch {
      if (deploy) return notOpened('The passwords did not open with this job’s key. Start again from the app.');
      if (watchdog) return notOpened('The root password did not open with this job’s key. Start again from the app.');
      for (const [name, aad] of /** @type {const} */ ([['reconnect', xosetupReconnectSigninAad(job, rec.address)], ['policy', xosetupPolicySigninAad(job, rec.address)]])) {
        try {
          inside = await tryOpen(aad);
          under = name;
          break;
        } catch { /* the next name, or none */ }
      }
      if (under === 'setup') return notOpened('The sign-in did not open with this setup’s key. Start again from the app.');
    }
    // EACH JOB ONLY UNDER ITS OWN BINDING, and no purpose this machine does
    // not know taken for a whole setup. Under the reconnect's or the policy
    // change's name the phone asked for that and nothing else, so anything
    // else in it is refused. Under the setup's name a setup carries no
    // purpose at all, and a policy change or a reconnect from a phone not yet
    // updated says `policy` or `reconnect` and is run as one, which is safe
    // here because this machine knows both. Checked here, before #execute,
    // which chooses its steps from `rec.purpose` and runs a whole setup for
    // anything else.
    // ADDING THE WATCHDOG: the pool master's root password and the address
    // Xen Orchestra answers on, and nothing handed back, so no reply key.
    if (watchdog) {
      const root = inside?.v === 1 && inside.purpose === 'watchdog' && typeof inside.root?.password === 'string' ? inside.root.password : '';
      const target = inside?.v === 1 && typeof inside.xo?.address === 'string' ? inside.xo.address : '';
      if (!root || root.length > 1024 || !XO_ADDRESS_RE.test(target)) {
        rec.state = 'failed';
        rec.text = !root
          ? 'The sealed message had no root password for the pool master in it, so nothing was started.'
          : 'The sealed message did not say where Xen Orchestra answers, so nothing was started.';
        return { ok: false, text: rec.text, xosetup: status(rec) };
      }
      rec.xoAddress = target;
      rec.state = 'running';
      rec.text = 'Starting.';
      void this.#execute(rec, { root });
      return { ok: true, text: `Adding the reconnect watchdog to Xen Orchestra at ${target}, through the pool master at ${rec.address}.`, xosetup: status(rec) };
    }
    const allowed = under === 'setup' ? [undefined, 'policy', 'reconnect'] : [under];
    if (!deploy && !allowed.includes(inside?.purpose)) {
      rec.state = 'failed';
      rec.text = 'The sign-in was sealed for a kind of job this machine does not run, so nothing was started. Update the app and this machine, then try again.';
      this.#ended(rec);
      return { ok: false, text: rec.text, xosetup: status(rec) };
    }
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
    // A RECONNECT opens nothing more: the reply key above is where its
    // account of the servers goes back to, as a setup's token does.
    if (inside.purpose === 'reconnect') {
      rec.purpose = 'reconnect';
      rec.of = XORECONNECT_STEPS.length;
      rec.phase = XORECONNECT_STEPS[0];
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
    return { ok: true, text: rec.purpose === 'policy' ? `Reading ${rec.address}.` : rec.purpose === 'reconnect' ? `Reconnecting the servers of ${rec.address}.` : `Setting up ${rec.address}.`, xosetup: status(rec) };
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
    if (rec.relay && (checked.policy.edge || checked.policy.image || checked.policy.rebuild.length || checked.policy.labs)) {
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

  /**
   * What a machine image's build VM said, passed on by the coordinator
   * (core.js, imageReport). Kept on the job for the build's next look
   * (vm-image.js), never shown as it came: a step is a word from
   * IMAGE_REPORT_STEPS and the sentence for it is the build's.
   *
   * @param {any} msg  `{ job, step, detail?, got?, of? }`
   */
  imageReport(msg) {
    const job = String(msg?.job || '');
    const rec = XOSETUP_JOB_RE.test(job) ? this.jobs.get(job) : undefined;
    const step = String(msg?.step || '');
    if (!rec || rec.building !== 'image' || !IMAGE_REPORT_STEPS.includes(step)) return;
    // The pull's two counts, as the coordinator checked them; whole bytes or
    // nothing, so the sentence the build makes of them is the build's.
    const count = (/** @type {unknown} */ n) => (step === 'image' && typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null);
    const got = count(msg.got);
    const of = count(msg.of);
    rec.vmReport = {
      step,
      detail: step === 'failed' && typeof msg.detail === 'string' ? msg.detail.slice(-2000) : null,
      ...(got !== null ? { got } : {}),
      ...(of ? { of } : {}),
      at: this.now(),
    };
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
      // A build is the exception, because it is minutes of bytes: its
      // download and upload stop where they are (ensureEdge, ensureImage,
      // the installer). THE JOB'S ONE SIGNAL is what they stop on (#execute):
      // each build used to make its own, so a cancel during the uplink, the
      // labs or between two images aborted nothing, the next build began on
      // a fresh signal and ran in full, and the job ended `done`.
      rec.cancelled = true;
      rec.abort?.abort();
      rec.text = rec.building === 'deploy'
        ? 'Stopping the installer where it is.'
        : rec.building === 'image'
          ? 'Stopping the machine image’s build and removing what it made.'
          : rec.building === 'edge' || rec.building === 'edge-rebuild'
            ? 'Stopping the edge router’s build and removing what it made.'
            : 'Cancelling after this step.';
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
    // A RECONNECT REPORTS FROM `servers` ON, which is where it starts to be
    // about Xen Orchestra rather than about the sign-in the person has just
    // given with Face ID on the screen in front of them.
    const reconnect = rec.purpose === 'reconnect';
    if (reconnect && !['servers', 'reconnect', 'wait', 'done'].includes(rec.phase)) return;
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
        ...(policy ? { purpose: 'policy' } : rec.purpose === 'deploy' ? { purpose: 'deploy' } : rec.purpose === 'watchdog' ? { purpose: 'watchdog' } : reconnect ? { purpose: 'reconnect' } : {}),
        ...(rec.part && rec.state === 'running' ? { fill: rec.part.fill } : {}),
        // THE PART OF A BUILD, and only of a build: an install's download is one
        // bar, and "part 1 of 1" on the Lock Screen would be words about nothing.
        ...(rec.part && rec.state === 'running' && buildKey(rec) ? { build: buildKey(rec), stage: rec.part.stage, stages: rec.part.stages } : {}),
        // WHAT THE BYTES ARE DOING, as a key and two megabyte counts, so the
        // Lock Screen can say it without the sentence (XOBUILD_DOING).
        ...(rec.part && rec.state === 'running' && rec.part.doing ? { doing: rec.part.doing, done: rec.part.done, total: rec.part.total } : {}),
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
    // ONE SIGNAL FOR THE WHOLE JOB, made here and aborted by `cancel`, which
    // every build and every wait is handed. It is not made again: a cancel
    // is a cancel of the job, not of whichever build happened to be running.
    rec.abort = new AbortController();
    // What an error message is scrubbed of, taken before the sign-in step
    // wipes the originals, and wiped with them at the end.
    const secrets = { password: creds.password, token: creds.token, root: creds.root, admin: creds.admin };
    ctx.secrets = secrets;
    const policy = rec.purpose === 'policy';
    const deploy = rec.purpose === 'deploy';
    const reconnect = rec.purpose === 'reconnect';
    const watchdog = rec.purpose === 'watchdog';
    const steps = policy ? this.#policySteps() : deploy ? this.#deploySteps() : watchdog ? this.#watchdogSteps() : reconnect ? this.#reconnectSteps() : this.#steps();
    const keys = policy ? XOPOLICY_STEPS : deploy ? XODEPLOY_STEPS : watchdog ? XOWATCHDOG_STEPS : reconnect ? XORECONNECT_STEPS : XOSETUP_STEPS;
    // TEN MINUTES SIGNED IN AS AN ADMIN, and no more, for a reconnect: read
    // by its steps on `now` between looks, and held by a timer too, which
    // closes the session under whatever call is waiting when the time is up,
    // EXCEPT A CYCLE'S: the middle of one is a server this job turned off, so
    // the session closes when the cycle ends (#cycle). A cycle is bounded by
    // its own windows and call timeouts, and the reconnect step begins one
    // only with room for all of them before the ten minutes are up.
    if (reconnect) {
      ctx.deadline = this.now() + RECONNECT.capMs;
      ctx.cap = setTimeout(() => {
        ctx.expired = true;
        if (ctx.cycling) return;
        try {
          ctx.admin?.close();
        } catch {
          /* closing */
        }
      }, RECONNECT.capMs);
      ctx.cap.unref?.();
    }
    try {
      for (let i = 0; i < steps.length; i++) {
        // A STEP THE ONE BEFORE IT RAN: the installer's six stages are one
        // script, which moves the job through them itself as it says them.
        if (!steps[i]) continue;
        if (rec.cancelled) {
          if (reconnect) await this.#sealReconnect(ctx);
          rec.state = 'cancelled';
          // AN INSTALL SAYS WHAT IS ON THE POOL, not which step was next:
          // "Cancelled before Reaching Xen Orchestra" after the installer had
          // finished hid that fleetwright-xo now exists, with the password
          // the person chose or the default (deployCancelled, C-5).
          rec.text = deploy
            ? deployCancelled(rec.phase, ctx)
            : `Cancelled before ${STEP_WORDS[keys[i]] ?? `step ${i + 1}`}.${policy || (reconnect && !ctx.outcomes) ? ' Nothing was changed.' : ''}`;
          if (watchdog) {
            await this.#restoreXoVm(ctx);
            rec.text = `${rec.text} ${ctx.vmState ?? 'Xen Orchestra’s VM was not touched.'}`;
          }
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
      // THE KEY THE FLEET READS THE ROUTERS WITH goes to the phone that ran
      // the policy, sealed to the key it sent (edge-credentials.js), which
      // keeps it in the person's vault with the pool's token. Every policy
      // job that finds one hands it back, so a phone that missed it once,
      // or a vault that lost it, has it again from the next.
      if (policy && ctx.rec.reply) await this.#handWatch(ctx).catch((e) => this.log.warn(`xosetup: ${rec.job} could not seal the routers' key: ${/** @type {Error} */ (e).message}`));
      rec.step = rec.of;
      rec.phase = 'done';
      rec.part = null;
      rec.text = [ctx.summary || (policy ? `${rec.address}: what the fleet may use is changed.` : `${rec.address} is in the fleet.`), ...ctx.notes].join(' ');
      if (watchdog) rec.text = ctx.summary;
      // A CANCEL THAT LANDED DURING THE LAST THING A POLICY JOB DID, which
      // took no signal (the pool's own machine) and finished: the job was
      // cancelled and says so, with what it had done. Not for a setup or an
      // install, whose last step seals the token to the phone: that token
      // reaches the phone only from a job that is `done`, and a token made
      // and handed to nobody would be the worse outcome.
      if (policy && rec.cancelled) {
        rec.state = 'cancelled';
        rec.text = `Cancelled as it finished: everything you chose was applied before the cancel arrived. ${rec.text}`;
      } else {
        rec.state = 'done';
      }
      this.#report(rec);
      this.log.info(`xosetup: ${rec.job} finished for ${rec.address}`);
    } catch (e) {
      // WHAT A RECONNECT DID BEFORE IT STOPPED is the phone's to see however
      // it stopped: a server turned off and not on again is exactly what the
      // person needs named.
      if (reconnect) await this.#sealReconnect(ctx);
      if (deploy && rec.cancelled) {
        rec.state = 'cancelled';
        rec.text = deployCancelled(rec.phase, ctx);
      } else if (watchdog) {
        // WHAT IS TRUE OF THE VM NOW, which the restore below settles: it is
        // started again before these words are final (#restoreXoVm).
        await this.#restoreXoVm(ctx);
        rec.state = rec.cancelled ? 'cancelled' : 'failed';
        const why = rec.cancelled ? `Cancelled before ${STEP_WORDS[rec.phase]?.toLowerCase() ?? 'the next step'}.` : `${STEP_WORDS[rec.phase] ?? 'Adding the watchdog'} stopped: ${scrub(/** @type {Error} */ (e).message, secrets)}`;
        rec.text = `${why} ${ctx.vmState ?? 'Xen Orchestra’s VM was not touched.'}`.slice(0, 600);
      } else if (reconnect && rec.cancelled) {
        rec.state = 'cancelled';
        rec.text = ctx.outcomes
          ? 'Cancelled while reconnecting the servers. What was already asked of Xen Orchestra stands; which servers were touched is on your phone.'
          : 'Cancelled before anything was changed.';
      } else if (reconnect && (ctx.outcome || ctx.expired)) {
        // ITS OWN SENTENCE, counts and the address, which says what is true
        // now rather than which step it was on.
        rec.state = 'failed';
        rec.text = ctx.outcome ?? `It stopped at the ten minutes this machine holds an admin session for, before any server it had no time to finish. ${ctx.outcomes ? 'Which servers were touched is on your phone.' : 'Nothing was changed.'}`;
      } else if (policy && rec.cancelled) {
        rec.state = 'cancelled';
        // Cancelled during the build, the policy was already in force: say
        // so, rather than that nothing changed. BETWEEN TWO THINGS IT WAS
        // ASKED FOR (`building` is cleared as each ends) nothing is half
        // made: what was built stands and the next was not begun. And what
        // was built before the cancel, in each case, so the person knows
        // what they have rather than only what they do not.
        const before = ctx.built?.length ? ` Before it was cancelled: ${ctx.built.join(' ')}` : '';
        rec.text = rec.phase !== 'apply'
          ? 'Cancelled before anything was changed.'
          : rec.building === 'holder'
            ? `Cancelled while making the pool’s own machine. What the fleet may use was changed, and whatever else you asked for was built.${before}`
            : rec.building === 'image' && rec.replacing
            ? `Cancelled while rebuilding the machine image. What the fleet may use was changed; the new image was not made, what was made of it was removed, and the one that was there is as it was.${before}`
            : rec.building === 'image'
            ? `Cancelled while building the machine image. What the fleet may use was changed; the image was not made, and what was made of it was removed.${before}`
            : rec.building === 'edge-rebuild'
            ? `Cancelled while rebuilding the edge router. What the fleet may use was changed; the new router was removed and the one that was there was started again, as it was.${before}`
            : rec.building === 'edge'
            ? `Cancelled while building the edge router. What the fleet may use was changed; the router was not built, and what was made of it was removed.${before}`
            : ctx.built?.length
              ? `Cancelled between the things you asked for. What the fleet may use was changed, and nothing more was started.${before}`
              : 'Cancelled before it built anything. What the fleet may use was changed; the fleet’s own networks it had made by then are kept, and nothing was built.';
        // THE ROUTERS' KEY STILL GOES TO THE PHONE: a router built before
        // the cancel was built with it, and a job that ended cancelled used
        // to end `done` and hand it over (status reads it from either).
        if (ctx.rec.reply) await this.#handWatch(ctx).catch((err) => this.log.warn(`xosetup: ${rec.job} could not seal the routers' key: ${/** @type {Error} */ (err).message}`));
      } else {
        rec.state = 'failed';
        rec.text = `${STEP_WORDS[rec.phase] ?? 'Setup'} stopped: ${scrub(/** @type {Error} */ (e).message, secrets)}`;
      }
      this.#report(rec);
      // AND WHY, in the journal too: the phone's copy goes when the job does,
      // and an image build that failed on a pool nobody else can see was
      // otherwise "stopped at apply" and nothing more. Scrubbed above.
      this.log.warn(`xosetup: ${rec.job} stopped at ${rec.phase}${rec.state === 'failed' ? `: ${rec.text}` : ''}`);
    } finally {
      if (ctx.cap) clearTimeout(ctx.cap);
      // A policy job's key, its waiter and what it showed the phone go with
      // it, whichever way it ended.
      rec.policyKey = null;
      rec.waiting = null;
      rec.choices = null;
      rec.inventory = null;
      rec.part = null;
      rec.abort = null;
      rec.building = null;
      // A VM THIS JOB STOPPED IS STARTED AGAIN, however the job ended, before
      // the connection that can start it goes (#restoreXoVm does nothing if
      // it is running or was never stopped).
      if (watchdog) await this.#restoreXoVm(ctx);
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
      ctx.secrets = null;
      // AND WHOEVER ASKED TO BE TOLD, once all of that is gone.
      try {
        this.onEnd?.({ job: rec.job, purpose: rec.purpose ?? 'setup', state: rec.state });
      } catch (e) {
        this.log.warn(`xosetup: ${rec.job} ended, and telling the sidecar failed: ${/** @type {Error} */ (e).message}`);
      }
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
        // where there is none: the fleet's, by the lists only an admin writes,
        // and not every template on every pool that carries the tag, which
        // the apply step below used to write into the set for every box's
        // token to clone (vm-image.js, isFleetImage).
        const own = await setsOf(ctx.admin);
        const templates = Object.values((await ctx.admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {});
        ctx.images = templates.filter((/** @type {any} */ t) => Array.isArray(t?.tags) && t.tags.includes(VM_IMAGE.tag) && isFleetImage(t, own));
        // AND EACH POOL'S OWN MACHINE, so the phone offers to make one only
        // where there is none, by the list only an admin writes as well as
        // its tags and where it was made (xo-holder.js, isHolder): the edge
        // router sends its logs to it.
        ctx.holders = vms.filter((/** @type {any} */ v) => isHolder(v, ctx.rec.address, own));
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
        // NOR ANYTHING ELSE THE FLEET PUT IN THE SET: its machine images and
        // its own machines, which are not storage or networks and so are not
        // the phone's to choose. `resourceSet.set` replaces the list, and
        // this used to write storage and networks alone: every change of
        // policy took the images out, and the next machine asked for from one
        // was refused by Xen Orchestra with "not enough permissions".
        // AND EVERY IMAGE OF THE FLEET'S, whether or not it is in the set
        // now, so a pool this already happened to is put right by its next
        // change of policy: a phone keeping an image sends nothing about it.
        // The fleet's is what the choose step found on the lists, so one taken
        // out is put back only when the job made it, and a template that only
        // carries the tag is never put in.
        const chosenKinds = new Set([...(ctx.srs || []), ...(ctx.networks || [])].map((/** @type {any} */ o) => String(o?.id)));
        const rest = (ctx.setObjects || []).filter((/** @type {string} */ id) => !chosenKinds.has(id));
        const images = (ctx.images || []).map((/** @type {any} */ t) => String(t.id));
        await ctx.admin.call('resourceSet.set', { id: ctx.setId, objects: [...new Set([...p.srs, ...p.networks, ...own, ...rest, ...images])], limits: p.limits });
        const said = [`It may use ${plural(p.srs.length, 'storage repository', 'storage repositories')}, ${plural(p.networks.length, 'network')}, ${p.limits.cpus} vCPUs, ${gib(p.limits.memory)} of memory and ${gib(p.limits.disk)} of disk.`];
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
        // WHAT XEN ORCHESTRA SHOWED EVERYBODY (edge-credentials.js, EDGE_KEPT):
        // routers from before carry the pair's password and the key in their
        // xenStoreData, which every signed-in user reads. Taken off every one
        // now, whatever else this job does or fails to do; and where the edge
        // is on the way out's pool it is built again with new ones even when
        // the phone did not ask for the edge, so upgrading closes it.
        const exposedPools = new Set((ctx.edges || []).filter(exposedOn).map((/** @type {any} */ v) => v.$pool));
        await clearExposed(ctx.admin, ctx.edges || []);
        const egressPool = (ctx.networks || []).find((/** @type {any} */ n) => n?.id === p.egress)?.$pool;
        const rotate = egressPool !== undefined && exposedPools.has(egressPool);
        // THE EDGE ROUTER, when the person asked for it: the uplink, then the
        // router on it (edge-router.js). Inside this step and not steps of its
        // own, so a phone that predates it still reads the progress as the
        // step it knows, with the machine's sentence under it saying where the
        // download and the disk have got to.
        if (!p.edge && !rotate && !p.image && !p.groups && !p.holder && p.labs === null && !p.rebuild.length && !p.remove.length) return;
        const rec = ctx.rec;
        // The words every time, for the screen that asks; an event only when
        // the stage changes or the bar has moved a twentieth, so a Lock
        // Screen is not pushed to for every 16 MB.
        // AFTER A CANCEL the words still flow: a build winding down says
        // what it is removing, and the screen used to freeze on "Stopping"
        // until the job ended. Its bar does not: the bytes it counts are
        // being thrown away, and a count of them after "Stopping" would
        // read as the build going on.
        const say = (/** @type {string} */ text, /** @type {any} */ part) => {
          if (rec.cancelled) {
            if (part) return;
            rec.text = text;
            this.#report(rec);
            return;
          }
          rec.text = text;
          if (!part) return;
          const before = rec.part;
          rec.part = part;
          if (!before || before.stage !== part.stage || before.doing !== part.doing || Math.floor(before.fill / 50) !== Math.floor(part.fill / 50)) this.#report(rec);
        };
        const way = (ctx.networks || []).find((/** @type {any} */ n) => n?.id === p.egress);
        if (!way?.$pool) throw new Error('the way out is not in a pool this Xen Orchestra listed. The policy was applied; nothing was built.');
        /** @type {string[]} */
        const built = [];
        ctx.built = built;
        if (p.edge || rotate) {
          const missing = EDGE_METHODS.filter((m) => !Object.hasOwn(ctx.methods, m));
          if (missing.length) throw new Error(`this Xen Orchestra does not offer ${missing.join(', ')}, so the edge router cannot be built. The policy was applied.`);
        }
        if (p.labs !== null) {
          const missing = [...LAB_METHODS, ...EDGE_METHODS].filter((m, i, all) => all.indexOf(m) === i && !Object.hasOwn(ctx.methods, m));
          if (missing.length) throw new Error(`this Xen Orchestra does not offer ${missing.join(', ')}, so the labs cannot be made. The policy was applied.`);
          if (!this.coordinatorUrl) throw new Error('this machine does not know the fleet’s address, which a closed lab must still reach. The policy was applied.');
        }
        if (p.holder && !(this.holderPin && this.coordinatorUrl)) throw new Error('this machine cannot ask the fleet for the pin a pool’s own machine joins with. The policy was applied.');
        if (p.image || p.rebuild.length) {
          const missing = IMAGE_METHODS.filter((m) => !Object.hasOwn(ctx.methods, m));
          if (!RESIZE_METHODS.some((m) => Object.hasOwn(ctx.methods, m))) missing.push(RESIZE_METHODS.join(' or '));
          if (missing.length) throw new Error(`this Xen Orchestra does not offer ${missing.join(', ')}, so the machine image cannot be built. The policy was applied.`);
        }
        if ((p.rebuild.length || p.remove.length) && !Object.hasOwn(ctx.methods, 'vm.delete')) {
          throw new Error('this Xen Orchestra does not offer vm.delete, so no machine image can be removed or replaced. The policy was applied.');
        }
        // GROUP NETWORKS, made before anything is built: quick, and a build
        // that fails should not take them with it.
        if (p.groups) {
          const made = await ensureGroups({ admin: ctx.admin, pool: way.$pool, networks: ctx.networks || [], setId: ctx.setId, inSet: p.networks, count: p.groups });
          if (made.length) built.push(`Made ${made.length === 1 ? 'a group network' : `${made.length} group networks`} for machines that work together.`);
          if (!p.edge && !rotate && !p.image && !p.holder && p.labs === null && !p.rebuild.length && !p.remove.length) return built.join(' ') || undefined;
        }
        // BETWEEN EACH THING IT WAS ASKED FOR, the cancel is looked for: the
        // networks take no signal and are quick, and a cancel during one
        // used to be found only by the next step, of which there is none.
        stopIfCancelled(rec);
        const uplink = await ensureUplink({ admin: ctx.admin, pool: way.$pool, networks: ctx.networks || [], setId: ctx.setId, inSet: p.networks });
        stopIfCancelled(rec);
        // LABS' NETWORKS, made before the edge is (re)built with an interface
        // on each: quick, and kept if the build fails, like group networks.
        /** @type {Array<{ id: string, open: boolean }>|null} */
        let labs = null;
        if (p.labs !== null) {
          const made = await ensureLabs({ admin: ctx.admin, pool: way.$pool, networks: ctx.networks || [], setId: ctx.setId, inSet: p.networks, open: p.labs.open, closed: p.labs.closed, perPerson: p.labsEach });
          labs = made.labs.map((l) => ({ id: l.id, open: l.open }));
          if (made.made.length) built.push(`Made ${made.made.length === 1 ? 'a lab network' : `${made.made.length} lab networks`}.`);
          if (p.labsEach !== undefined && labs.length) built.push(p.labsEach === null ? 'One person may hold any number of labs.' : `One person may hold ${p.labsEach === 1 ? 'one lab' : `${p.labsEach} labs`} at once.`);
          stopIfCancelled(rec);
        }
        const edgeAsked = p.edge || labs !== null || rotate;
        if (rotate) built.push('The edge router’s key, and a pair’s shared password, were readable by everybody signed in to Xen Orchestra: they were taken off it, and it was built again with new ones.');
        // THE MACHINE IMAGE, after the router, on the same pool: it is built
        // on the uplink, so its install leaves through the router like every
        // machine cloned from it will (vm-image.js).
        if (p.image || p.rebuild.length || p.remove.length) {
          const poolName = String((ctx.pools || []).find((/** @type {any} */ x) => x?.id === way.$pool)?.name_label || 'this pool').slice(0, 80);
          const image = async (/** @type {string} */ key, replace = false) => {
            stopIfCancelled(rec);
            rec.building = 'image';
            rec.replacing = replace;
            rec.part = null;
            const said = await this.buildImage({
              image: key,
              replace,
              channel: p.imageChannel,
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
              // A FRESH TOKEN FOR EACH BUILD, and what its VM last said: the
              // coordinator passes each report here (imageReport below).
              reporter: this.imageReporter
                ? async () => {
                  rec.vmReport = null;
                  const answer = await /** @type {(job: string) => Promise<any>} */ (this.imageReporter)(rec.job).catch(() => null);
                  return answer?.ok && typeof answer.token === 'string' ? answer.token : null;
                }
                : null,
              vmReport: () => rec.vmReport ?? null,
            });
            // Over, whichever way: a cancel between this and the next is
            // between two things, not during this one (the catch reads it).
            rec.building = null;
            return said;
          };
          // ONE AFTER ANOTHER, router first: each image is built behind it.
          if (edgeAsked) built.push(await this.#edge(ctx, p, way, uplink, say, labs));
          // REMOVED FIRST, which frees their disks for what is built next;
          // then the new images, then the ones rebuilt.
          for (const key of p.remove) {
            stopIfCancelled(rec);
            built.push(await this.dropImage({ admin: ctx.admin, pool: way.$pool, poolName, image: key }));
          }
          for (const key of p.images) built.push(await image(key));
          for (const key of p.rebuild) built.push(await image(key, true));
        } else if (edgeAsked) {
          built.push(await this.#edge(ctx, p, way, uplink, say, labs));
        }
        // THE POOL'S OWN MACHINE, last: it is cloned from the image, which may
        // have been built a moment ago.
        if (p.holder) {
          stopIfCancelled(rec);
          rec.building = 'holder';
          rec.part = null;
          built.push(await ensureHolder({
            admin: ctx.admin,
            pool: way.$pool,
            egress: { id: String(way.id), name: String(way.name_label || 'the way out').slice(0, 80) },
            address: rec.address,
            coordinatorUrl: /** @type {string} */ (this.coordinatorUrl),
            askPin: () => /** @type {(job: string, address: string) => Promise<any>} */ (this.holderPin)(rec.job, rec.address),
            secret: p.holderSecret,
            again: p.holderAgain,
            grants: p.grants,
            say: (text) => say(text, null),
            // The one it removed, by name, so the coordinator retires that
            // host rather than listing it as "not reporting" for good.
            removed: (hostId) => this.emit({ event: 'xosetup.holder-removed', job: rec.job, hostId }),
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
          } catch (e) {
            // ONLY A REFUSAL MEANS SOMEBODY CHANGED IT. Xen Orchestra turns a
            // wrong password down as `invalid credentials` (xo-common's
            // api-errors, code 3). A call that timed out or a connection that
            // dropped says nothing about the password, and used to be put
            // down to somebody else's doing (C-5): it is said as what it was,
            // with the default still to be changed by hand.
            const err = /** @type {Error & { code?: unknown }} */ (e);
            if (err.code === 3 || /invalid credentials/i.test(err.message)) {
              throw new Error(`Xen Orchestra at ${rec.xoAddress} no longer takes its default admin password, so somebody signed in to it and changed it before this machine could. Nothing more was done; look at it in Xen Orchestra before adding it.`);
            }
            // Short, with the reason bounded: a failure's words are cut at
            // 300 (scrub) and what to do has to be inside them.
            throw new Error(`this machine could not sign in to Xen Orchestra at ${rec.xoAddress} to replace the default admin password (${scrub(err.message, ctx.secrets ?? {}).slice(0, 60)}). Unless somebody changed it, it is still ${DEFAULT_ADMIN.email} / ${DEFAULT_ADMIN.password}: change it, then add it from the app.`);
          }
          if (!user?.id) throw new Error('Xen Orchestra signed its default admin in and did not say which user that is, so its password was not changed.');
          // WHAT A CANCEL FROM HERE ON CAN SAY (deployCancelled): the change
          // was asked for, and then that it took.
          ctx.adminTried = true;
          await admin.call('user.set', { id: user.id, password: ctx.creds.admin });
          ctx.adminChanged = true;
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
   * Adding the watchdog's steps, in XOWATCHDOG_STEPS order. xo-watchdog.js
   * holds the scripts and says why it goes in through the pool master.
   *
   * @returns {Array<(ctx: any) => Promise<any>>}
   */
  #watchdogSteps() {
    return [
      // reach
      async (/** @type {any} */ ctx) => {
        const rec = ctx.rec;
        ctx.dir = jobDir();
        ctx.root = { password: ctx.creds.root };
        ctx.creds.root = undefined;
        ctx.pool = await openPool({ address: rec.address, hostKey: rec.hostKeyPin, secret: ctx.root, dir: ctx.dir, signal: rec.abort.signal });
      },
      // find
      async (/** @type {any} */ ctx) => {
        const rec = ctx.rec;
        const host = String(rec.xoAddress).replace(/^\[?([^\]]+?)\]?(?::\d+)?$/, '$1');
        const ips = await this.resolveXo(host).catch(() => []);
        if (!ips.length) throw new Error(`${host} does not resolve to an address from this machine, so its VM cannot be found by it. Nothing was changed.`);
        ctx.vm = await findXoVm(ctx.pool, ips);
        ctx.vmState = 'Xen Orchestra’s VM was not touched.';
      },
      // stop
      async (/** @type {any} */ ctx) => {
        if (!ctx.vm.running) return;
        // MARKED STOPPED BEFORE ASKING, so a shutdown that half-happens is
        // still started again on the way out.
        ctx.stopped = true;
        ctx.vmState = 'Xen Orchestra’s VM was shut down to add it and has not been started again.';
        await stopXoVm(ctx.pool, ctx.vm.vm);
      },
      // add
      async (/** @type {any} */ ctx) => {
        const added = await addToDisk(ctx.pool, ctx.vm.vdi);
        ctx.added = added;
        if (added.leftover) this.log.warn(`xosetup: ${ctx.rec.job} left a VBD ${added.leftover} on the pool master's own domain`);
      },
      // start
      async (/** @type {any} */ ctx) => {
        const rec = ctx.rec;
        const name = ctx.vm.name || 'Xen Orchestra’s VM';
        if (!ctx.vm.running) {
          ctx.summary = `The reconnect watchdog is on ${name}’s disk. The VM was not running and was left off; Xen Orchestra loads it when it next starts.`;
          return;
        }
        await startXoVm(ctx.pool, ctx.vm.vm);
        ctx.stopped = false;
        ctx.vmState = 'Xen Orchestra’s VM was started again.';
        // WHAT THE WAIT KNOWS is that the port took a connection
        // (xo-watchdog.js, waitForXo): not that Xen Orchestra is up behind
        // it, and not that it loaded the plugin, which this job, holding the
        // pool master's root password and no Xen Orchestra sign-in, cannot
        // ask. It used to say the plugin had loaded (C-5).
        const back = await this.waitXo(rec.xoAddress, { signal: rec.abort?.signal });
        ctx.summary = back
          ? `The reconnect watchdog is on ${name}’s disk, and Xen Orchestra at ${rec.xoAddress} answers on its port again. Whether it loaded the plugin as it started was not checked from here: Settings, Plugins in Xen Orchestra lists it, and once loaded it reconnects a pool it loses by itself.`
          : `The reconnect watchdog is on ${name}’s disk, and ${name} was started again, but nothing answered on Xen Orchestra’s port at ${rec.xoAddress} after five minutes. Look at it in the pool; it may still be starting.`;
      },
    ];
  }

  /**
   * Start Xen Orchestra's VM again if this job stopped it and has not
   * started it. Never throws; says what is true in `ctx.vmState`.
   *
   * @param {any} ctx
   */
  async #restoreXoVm(ctx) {
    if (!ctx.stopped || !ctx.pool) return;
    ctx.stopped = false;
    try {
      await startXoVm(ctx.pool, ctx.vm.vm);
      ctx.vmState = 'Xen Orchestra’s VM was started again, as it was.';
    } catch (e) {
      ctx.vmState = `Xen Orchestra’s VM was shut down and did not start again (${scrub(/** @type {Error} */ (e).message, ctx.secrets ?? {})}): start it from the pool.`;
      this.log.warn(`xosetup: ${ctx.rec.job} could not start Xen Orchestra's VM again`);
    }
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
    stopIfCancelled(rec);
    rec.building = 'edge';
    rec.part = null;
    // THE KEY THE FLEET READS THE ROUTERS WITH (edge-credentials.js): the
    // one they were built with, so a rebuild keeps it and the person's vault
    // stays right, or a new one for routers that have none. Its logs go to
    // this box, which is on the way to Xen Orchestra and so, usually, on the
    // routers' way out, and to the pool's own machine (syslogTo).
    const onPool = (ctx.edges || []).filter((/** @type {any} */ v) => v?.$pool === way.$pool);
    const kept = await keptFor(ctx.admin, way.$pool);
    ctx.watch = onPool.map((/** @type {any} */ v) => watchOf(v, kept.watch)).find(Boolean) ?? newWatch({ now: this.now() });
    ctx.watchPool = way.$pool;
    const syslog = syslogTo(ctx.holders, way.$pool, ctx.admin?.localAddress);
    return ensureEdge({
      admin: ctx.admin,
      pool: way.$pool,
      egress: { id: p.egress, name: String(way.name_label || 'the way out').slice(0, 80) },
      uplink,
      srs: ctx.srs || [],
      fleetSrs: p.srs,
      sr: p.edgeSr,
      block: p.edgeBlock,
      ha: p.edgeHa,
      labs,
      fleet: fleetHosts(this.coordinatorUrl),
      watch: ctx.watch,
      syslog,
      rebuilding: () => {
        rec.building = 'edge-rebuild';
      },
      address: rec.address,
      pin: rec.pin,
      plain: rec.plain === true,
      imageDir: path.join(this.stateDir || '.', 'edge'),
      signal: rec.abort.signal,
      say,
    }).then((said) => {
      rec.building = null;
      return said;
    });
  }

  /**
   * The routers' key, sealed to the phone, with which routers it opens and
   * where Xen Orchestra last saw them. A rebuilt router keeps its WAN MAC
   * (edge-router.js, wanMacFor), so the address it had is the one it is
   * likely to have again; a box that reads them also learns it from their
   * syslog (edge-watch.js).
   *
   * @param {any} ctx
   */
  async #handWatch(ctx) {
    const edges = (ctx.edges || []).filter((/** @type {any} */ v) => !ctx.watchPool || v?.$pool === ctx.watchPool);
    // A JOB THAT BUILT NOTHING hands on the key kept for the routers there,
    // when a router carries its pin: one cleared above carries none.
    let watch = ctx.watch ?? null;
    for (const pool of watch ? [] : new Set(edges.map((/** @type {any} */ v) => v?.$pool))) {
      const kept = await keptFor(ctx.admin, pool);
      watch = edges.filter((/** @type {any} */ v) => v?.$pool === pool).map((/** @type {any} */ v) => watchOf(v, kept.watch)).find(Boolean) ?? null;
      if (watch) break;
    }
    if (!watch) return;
    const routers = edges
      .map((/** @type {any} */ v) => ({ name: v.tags?.includes?.(`${EDGE_HA.nodeTag}1`) ? EDGE_HA.second : EDGE.vm, address: wanAddressOf(v) }))
      .filter((/** @type {any} */ r, /** @type {number} */ i, /** @type {any[]} */ all) => all.findIndex((x) => x.name === r.name) === i);
    const payload = { v: 1, address: ctx.rec.address, key: watch.key, secret: watch.secret, pin: watch.pin, routers };
    const box = await seal({ to: ctx.rec.reply, aad: xosetupWatchAad(ctx.rec.job, ctx.rec.address), payload });
    ctx.rec.watch = `${box.epk}.${box.iv}.${box.ct}`;
  }

  /**
   * A reconnect's steps, in XORECONNECT_STEPS order: onboarding's first two,
   * then the servers, reconnecting them, and waiting for their pools.
   *
   * WHAT XEN ORCHESTRA DOES WITH EACH CALL, read from its source
   * (xo-server's xo-mixins/xen-servers.mjs) and not assumed:
   *   server.enable   connects a server whose status is `disconnected` and
   *                   answers once its objects are in, or fails with why.
   *                   It refuses with `incorrect state` while the status is
   *                   anything else, AND while an attempt of its own is still
   *                   running (`_connectingXenServers`), which leaves the
   *                   status `disconnected` and calls the state `connecting`.
   *                   It sets `enabled` on its way in, whatever then fails.
   *   server.disable  sets `enabled: false` first, then closes the
   *                   connection, and answers once the status is
   *                   `disconnected`.
   * So a server stuck connecting is disabled and enabled again, and the
   * enable is asked again for as long as Xen Orchestra is still busy with
   * an attempt it began itself. Two failures are said and never retried:
   * the pool master refusing the user name and password Xen Orchestra keeps
   * for it, and a pool already connected through another server. Xen
   * Orchestra itself stops retrying on exactly those.
   *
   * @returns {Array<(ctx: any) => Promise<any>>}
   */
  #reconnectSteps() {
    return [
      ...this.#steps().slice(0, 2),
      // servers
      async (/** @type {any} */ ctx) => {
        const methods = await ctx.admin.call('system.getMethodsInfo');
        const missing = RECONNECT_METHODS.filter((m) => !(methods && Object.hasOwn(methods, m)));
        if (missing.length) throw new Error(`this Xen Orchestra does not offer ${missing.join(', ')}, so its servers cannot be reconnected from here. Nothing was changed.`);
        ctx.servers = await this.#xenServers(ctx);
        await this.#poolsNow(ctx);
        if (!ctx.servers.length) throw new Error('Xen Orchestra has no servers to reconnect: no pool was ever added to it. Add one in Xen Orchestra. Nothing was changed.');
      },
      // reconnect
      async (/** @type {any} */ ctx) => {
        /** @type {Map<string, { action: string, error: string|null }>} */
        const outcomes = new Map();
        ctx.outcomes = outcomes;
        const servers = /** @type {XenServer[]} */ (ctx.servers);
        // NOTHING TO DO IS SAID AS THAT, and nothing is asked of Xen
        // Orchestra: every server connected and none with an error.
        for (const [i, s] of servers.entries()) {
          if (s.status === 'connected' && !s.error) {
            outcomes.set(s.id, { action: 'left', error: null });
            continue;
          }
          // ONLY A PERSON TURNS A SERVER OFF, so one that is off stays off,
          // and is named on the phone so they know it is the reason.
          if (!s.enabled) {
            outcomes.set(s.id, { action: 'skipped-disabled', error: null });
            continue;
          }
          // ROOM FOR THE WHOLE OF ONE before beginning it: a cycle turns the
          // server off first, and must not be cut off before it is on again.
          // Its windows and its pauses, and every call it can make waiting
          // as long as the connection waits for one: a Xen Orchestra slow to
          // answer spends the ten minutes in calls, not in pauses, and a
          // cycle begun with room only for its pauses ran past them.
          if (ctx.rec.cancelled) throw new Error('cancelled');
          const cycle = s.status !== 'disconnected';
          const room = cycle ? cycleMs(ctx.admin?.callTimeoutMs ?? CALL_TIMEOUT_MS) : RECONNECT.settleMs + RECONNECT.retryForMs;
          if (ctx.expired || this.now() + room >= ctx.deadline) {
            ctx.expired = true;
            throw new Error('ten minutes were up');
          }
          ctx.rec.text = `Reconnecting server ${i + 1} of ${servers.length}.`;
          try {
            if (cycle) await this.#cycle(ctx, s.id);
            else await this.#enable(ctx, s.id, { stoppable: true });
            outcomes.set(s.id, { action: cycle ? 'cycled' : 'enabled', error: null });
          } catch (e) {
            // A CYCLE THAT BEGAN IS ACCOUNTED FOR, however it ended: its
            // server was turned off, and one left without an outcome is
            // sealed to the phone as left, connected already.
            if (!cycle && (/** @type {any} */ (e)?.stop || ctx.expired)) throw e;
            outcomes.set(s.id, { action: 'failed', error: await this.#failure(ctx, s.id, /** @type {Error} */ (e)) });
            if (ctx.expired) throw e;
          }
        }
      },
      // wait
      async (/** @type {any} */ ctx) => {
        const servers = /** @type {XenServer[]} */ (ctx.servers);
        const tried = servers.filter((s) => ['enabled', 'cycled', 'failed'].includes(String(ctx.outcomes.get(s.id)?.action)));
        const waitedFor = tried.filter((s) => ctx.outcomes.get(s.id)?.action !== 'failed');
        const until = this.now() + RECONNECT.waitMs;
        let back = false;
        for (;;) {
          const now = await this.#xenServers(ctx);
          const pools = await this.#poolsNow(ctx);
          const on = (/** @type {XenServer} */ s) => now.find((x) => x.id === s.id)?.status === 'connected';
          // THE POOLS SHOW when Xen Orchestra lists a pool object for every
          // connected server that names its pool, or any pool where none do.
          const ids = new Set(pools.map((/** @type {any} */ p) => String(p?.id)));
          const named = now.filter((x) => x.status === 'connected' && x.poolId);
          const showing = named.length ? named.every((x) => ids.has(/** @type {string} */ (x.poolId))) : pools.length > 0;
          back = tried.every(on) && showing;
          if (back || !waitedFor.length || this.now() >= until) break;
          ctx.rec.text = `Waiting for the pools: ${waitedFor.filter(on).length} of ${plural(waitedFor.length, 'server')} connected.`;
          await this.#pause(ctx, RECONNECT.pollMs, { stoppable: true });
        }
        await this.#sealReconnect(ctx);
        const said = reconnectSentence(ctx, { back, gaveUp: !back && waitedFor.length > 0 });
        if (!back && tried.length) {
          ctx.outcome = said;
          throw new Error(said);
        }
        ctx.summary = said;
      },
    ];
  }

  /**
   * The servers Xen Orchestra is registered with, as `server.getAll` answers,
   * each reduced to what this job reads. Kept as the last look, which is
   * what the phone is told each server is doing when the job ends.
   *
   * @param {any} ctx
   * @returns {Promise<XenServer[]>}
   */
  async #xenServers(ctx) {
    const all = await ctx.admin.call('server.getAll');
    ctx.lastServers = (Array.isArray(all) ? all : Object.values(all || {})).map(xenServer).filter(Boolean);
    return ctx.lastServers;
  }

  /** The pools Xen Orchestra shows the admin now, kept as the last look. @param {any} ctx */
  async #poolsNow(ctx) {
    ctx.lastPools = Object.values((await ctx.admin.call('xo.getAllObjects', { filter: { type: 'pool' } })) || {});
    return ctx.lastPools;
  }

  /**
   * A pause between looks, against the job's clock. A cancel and the ten
   * minutes are honoured here only where nothing is half done (`stoppable`):
   * in the middle of a cycle the server is turned off, and the cycle is
   * bounded by its own minute, which the reconnect step made room for
   * before it began one.
   *
   * @param {any} ctx @param {number} ms @param {{ stoppable?: boolean }} [opts]
   */
  async #pause(ctx, ms, { stoppable = false } = {}) {
    await this.sleep(ms);
    if (!stoppable) return;
    if (ctx.rec.cancelled) throw Object.assign(new Error('cancelled'), { stop: true });
    if (this.now() >= ctx.deadline || ctx.expired) {
      ctx.expired = true;
      throw Object.assign(new Error('ten minutes were up'), { stop: true });
    }
  }

  /**
   * `server.enable`, asked again every two seconds for half a minute while
   * Xen Orchestra answers `incorrect state` and the server is not connected:
   * the state it is in is then `connecting`, its own attempt not yet over.
   * The error's own `data.actual` does not reach here (XoRpc keeps the
   * message and the code, on purpose), so the state is read back instead.
   * Any other refusal is the answer.
   *
   * @param {any} ctx @param {string} id @param {{ stoppable?: boolean }} [opts]
   */
  async #enable(ctx, id, { stoppable = false } = {}) {
    const until = this.now() + RECONNECT.retryForMs;
    for (;;) {
      try {
        await ctx.admin.call('server.enable', { id });
        return;
      } catch (e) {
        // A CONNECTION SLOWER THAN A CALL WAITS is not a refusal: Xen
        // Orchestra goes on with it, and the wait step sees how it ends.
        if (/did not answer server\.enable in time/.test(/** @type {Error} */ (e).message)) return;
        if (!incorrectState(e)) throw e;
        const now = (await this.#xenServers(ctx)).find((x) => x.id === id);
        if (now?.status === 'connected') return;
        if (this.now() >= until) throw new Error(`Xen Orchestra was still busy connecting it after ${RECONNECT.retryForMs / 1000} seconds`);
        await this.#pause(ctx, RECONNECT.retryMs, { stoppable });
      }
    }
  }

  /**
   * A server stuck connecting, or connected with an error: disabled, given
   * half a minute to reach `disconnected`, then enabled again. Never stopped
   * in the middle, by a cancel or by the clock, because the middle is a
   * server turned off: the ten minutes' timer leaves the session open while
   * a cycle runs and closes it when the cycle ends (#execute).
   *
   * A CYCLE THAT FAILS BEFORE IT ASKED FOR THE ENABLE asks for it once, on
   * the session it still has: a server this job turned off must not be left
   * off by it for want of one call. One whose enable was refused has had its
   * half a minute of asking already. Whatever is still off, or may be, is
   * said on the error (`disabledByJob`), because the read-back that would
   * say it (#failure) needs the connection the failure may have taken.
   *
   * @param {any} ctx @param {string} id
   */
  async #cycle(ctx, id) {
    ctx.cycling = true;
    // Xen Orchestra sets `enabled: false` before it answers a disable, so
    // one sent and not answered may have turned the server off all the same.
    let enabling = false;
    try {
      await ctx.admin.call('server.disable', { id });
      const until = this.now() + RECONNECT.settleMs;
      for (;;) {
        const now = (await this.#xenServers(ctx)).find((x) => x.id === id);
        // Still not let go at the end of it: enabled all the same, because a
        // server this job turned off must not be left off by it.
        if (!now || now.status === 'disconnected' || this.now() >= until) break;
        await this.#pause(ctx, RECONNECT.retryMs);
      }
      enabling = true;
      await this.#enable(ctx, id);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      const on = !enabling && (await ctx.admin.call('server.enable', { id }).then(() => true, (/** @type {Error} */ x) => /did not answer server\.enable in time/.test(x.message)));
      if (!on) Object.assign(err, { disabledByJob: true });
      throw err;
    } finally {
      ctx.cycling = false;
      if (ctx.expired) {
        try {
          ctx.admin?.close();
        } catch {
          /* closing */
        }
      }
    }
  }

  /**
   * Why one server could not be reconnected, for the phone: the two answers
   * Xen Orchestra will not retry put in words, anything else as it said it,
   * and whether the server is left turned off, read back rather than assumed.
   * Where the read-back cannot reach Xen Orchestra, a server this job turned
   * off and could not turn on again (`disabledByJob`, #cycle) is still said
   * to be off, or maybe off, and never left unsaid: a later reconnect leaves
   * a server that is off alone, as a person's choice.
   *
   * @param {any} ctx @param {string} id @param {Error} e
   */
  async #failure(ctx, id, e) {
    const now = await this.#xenServers(ctx).then((all) => all.find((x) => x.id === id)).catch(() => null);
    const why = permanentWords(e) ?? permanentWords(now?.raw) ?? scrub(e.message, ctx.secrets ?? {});
    const off = now
      ? !now.enabled ? '. It is turned off in Xen Orchestra now; turn it on there' : ''
      : /** @type {any} */ (e)?.disabledByJob ? '. This job turned it off to reconnect it and could not turn it on again, so it may be turned off in Xen Orchestra now; turn it on there' : '';
    return `${why.slice(0, 300 - off.length)}${off}`;
  }

  /**
   * Each server, what was done to it and what it is doing at the last look,
   * and the pools Xen Orchestra showed then, sealed to the key the phone sent
   * inside the sign-in. Once, the first time a job that reached its servers
   * ends. The coordinator relays it and cannot read it: server names and
   * pool masters' addresses are the person's, not the fleet's.
   *
   * @param {any} ctx
   */
  async #sealReconnect(ctx) {
    if (!ctx.servers?.length || ctx.rec.result || !ctx.rec.reply) return;
    try {
      const box = await seal({ to: ctx.rec.reply, aad: xosetupReconnectAad(ctx.rec.job, ctx.rec.address), payload: reconnectResult(ctx) });
      ctx.rec.result = `${box.epk}.${box.iv}.${box.ct}`;
    } catch (e) {
      this.log.warn(`xosetup: ${ctx.rec.job} could not seal what it did to the servers: ${/** @type {Error} */ (e).message}`);
    }
  }

  /**
   * Load a plugin that is on the server and keep it loading, signed in as
   * admin. Whether it is there at all is the installer's business: this only
   * turns on what a build already carries. False when it is not there.
   *
   * @param {any} ctx
   * @param {any[]} plugins what `plugin.get` answered
   * @param {string} id
   */
  async #loadPlugin(ctx, plugins, id) {
    const plugin = plugins.find((/** @type {any} */ p) => p?.id === id || p?.name === id);
    if (!plugin) return false;
    if (!plugin.loaded && Object.hasOwn(ctx.methods, 'plugin.load')) await ctx.admin.call('plugin.load', { id: plugin.id });
    if (!plugin.autoload && Object.hasOwn(ctx.methods, 'plugin.enableAutoload')) {
      await ctx.admin.call('plugin.enableAutoload', { id: plugin.id });
    }
    return true;
  }

  /**
   * The installer's update plugin: loaded, and set to update once a day
   * unless a person decided otherwise. The sentence it leaves on the job.
   *
   * @param {any} ctx
   * @param {any[]} plugins what `plugin.get` answered
   */
  async #updates(ctx, plugins) {
    if (!(await this.#loadPlugin(ctx, plugins, UPDATES_PLUGIN))) {
      return 'The installer’s update plugin is not on this Xen Orchestra, so updates stay as they are.';
    }
    const plugin = plugins.find((/** @type {any} */ p) => p?.id === UPDATES_PLUGIN || p?.name === UPDATES_PLUGIN);
    // TURNED ON ONLY WHERE NOBODY DECIDED. A person who switched automatic
    // updates off said so, and setup is not the place to overrule them.
    const configuration = plugin.configuration && typeof plugin.configuration === 'object' ? plugin.configuration : {};
    if (configuration.autoUpdate === false) return 'Automatic updates are off on this Xen Orchestra, and were left that way.';
    if (configuration.autoUpdate !== true && Object.hasOwn(ctx.methods, 'plugin.configure')) {
      await ctx.admin.call('plugin.configure', { id: plugin.id, configuration: { ...configuration, autoUpdate: true } });
      return 'Xen Orchestra now updates itself once a day.';
    }
    return 'Xen Orchestra already updates itself.';
  }

  /**
   * Remove the limited user's tokens from earlier runs, signed in as it,
   * keeping the one this run made. Never throws; what it says is what is
   * true of the old tokens now: gone, or still valid and why (C-5).
   *
   * @param {any} ctx with `limited` signed in as FLEET_USER and `token` just made
   * @returns {Promise<{ removed: boolean, text: string }>}
   */
  async #revokeOlderTokens(ctx) {
    const stayed = 'so any token the fleetwright user had from before still opens the pool until it expires.';
    if (!Object.hasOwn(ctx.methods, 'token.deleteAll')) {
      return { removed: false, text: `This Xen Orchestra does not offer token.deleteAll, ${stayed}` };
    }
    try {
      await ctx.limited.call('token.deleteAll', { except: ctx.token });
      return { removed: true, text: 'Any token the fleetwright user had from before was removed, so only this one opens the pool.' };
    } catch (e) {
      return { removed: false, text: `This Xen Orchestra refused to remove the fleetwright user’s earlier tokens (${scrub(/** @type {Error} */ (e).message, ctx.secrets ?? {})}), ${stayed}` };
    }
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
          throw new Error(`that account is signed in but is not a Xen Orchestra admin, and ${ctx.rec.purpose === 'policy' ? 'changing what the fleet may use' : ctx.rec.purpose === 'reconnect' ? 'reconnecting its servers' : 'adding a pool'} needs one.`);
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
        // THE TOKENS BEFORE THIS ONE GO. Every run minted a token and left
        // the earlier ones valid for their 180 days, so a setup run again
        // for a lost phone left that phone's token opening the pool. Xen
        // Orchestra's `token.deleteAll` removes the signed-in user's tokens
        // but the one named, so it is asked as the limited user, for all but
        // the one just made. Not in REQUIRED_METHODS: a server without it
        // still gets its token, and the summary says the old ones stayed
        // rather than that they went (C-5).
        ctx.tokensRevoked = await this.#revokeOlderTokens(ctx);
        ctx.limited.close();
        ctx.limited = null;
        ctx.password = undefined;
        return ctx.tokensRevoked.text;
      },
      // updates, and the reconnect watchdog
      async (/** @type {any} */ ctx) => {
        if (!Object.hasOwn(ctx.methods, 'plugin.get')) return 'This Xen Orchestra does not list its plugins; updates stay as they are.';
        const plugins = (await ctx.admin.call('plugin.get')) || [];
        const watchdog = await this.#loadPlugin(ctx, plugins, RECONNECT_PLUGIN_ID);
        const after = watchdog ? ' It reconnects a pool it loses by itself.' : ' Fleetwright’s reconnect watchdog is not on it, so a pool it loses waits for Reconnect.';
        return `${await this.#updates(ctx, plugins)}${after}`;
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

/**
 * Stop a step here if the job was cancelled: between two things a step does
 * that take no signal, so a cancel that landed during one ends the job at
 * its end rather than being found by a next step that never comes. The
 * catch in #execute reads `rec.cancelled`, not these words.
 *
 * @param {any} rec
 */
function stopIfCancelled(rec) {
  if (rec.cancelled) throw new Error('cancelled');
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
  // A reconnect's own (XORECONNECT_STEPS), after the first two.
  servers: 'Reading Xen Orchestra’s servers',
  reconnect: 'Reconnecting its servers',
  wait: 'Waiting for the pools',
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
  // Adding the watchdog's own (XOWATCHDOG_STEPS), after `reach`.
  find: 'Finding Xen Orchestra’s VM',
  stop: 'Shutting it down',
  add: 'Adding the watchdog to its disk',
  start: 'Starting it again',
}));

/**
 * How a cancelled install ended, in what is known of the pool by then. Before
 * the installer ran, nothing was made. While it ran, it removes what it made
 * if it is stopped before its VM starts and keeps the VM after, and which of
 * those happened is the installer's to know, so the sentence names what to
 * look for rather than claiming either (C-5). Once it has finished
 * (`rec.xoAddress` is where it said Xen Orchestra is) the VM exists, and
 * what its admin password is comes from the admin step: replaced with the
 * person's (`adminChanged`), asked to be and not answered (`adminTried`,
 * which is the one case this cannot settle), or still the default.
 *
 * @param {string} phase
 * @param {{ rec: { xoAddress?: string|null }, adminTried?: boolean, adminChanged?: boolean }} ctx
 */
function deployCancelled(phase, ctx) {
  if (phase === 'reach' || phase === 'installer') return 'Cancelled before anything was made on the pool.';
  if (!ctx.rec.xoAddress) {
    return 'Cancelled while the installer ran. Anything it had made may still be on the pool: a VM named fleetwright-xo, and disks named for it.';
  }
  const installed = `Cancelled after Xen Orchestra was installed at ${ctx.rec.xoAddress}, as fleetwright-xo on the pool`;
  if (ctx.adminChanged) return `${installed}, and its admin password was replaced with the one you chose, before it was added to the fleet. Add it from the app with that address.`;
  if (ctx.adminTried) {
    return `${installed}, while its default admin password was being replaced. Whether that went through is not known from here: sign in to it as ${DEFAULT_ADMIN.email} with the password you chose, or with ${DEFAULT_ADMIN.password} if yours is refused, change it if it is still ${DEFAULT_ADMIN.password}, then add it from the app with that address.`;
  }
  return `${installed}, before its default admin password was replaced: it is ${DEFAULT_ADMIN.email} with the password ${DEFAULT_ADMIN.password}, and anybody on its network can sign in with it until that is changed. Change it now, then add it from the app with that address.`;
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
  const edges = (ctx.edges || []).filter((/** @type {any} */ v) => !v.tags?.includes?.(`${EDGE_HA.nodeTag}1`)).map((/** @type {any} */ v) => {
    const disk = (ctx.edgeDisks || []).find((/** @type {any} */ d) => d?.$pool === v.$pool && Array.isArray(d?.$VBDs) && d.$VBDs.length);
    const sr = disk ? (ctx.srs || []).find((/** @type {any} */ x) => x?.id === disk.$SR) : null;
    return {
      pool: v.$pool ? String(v.$pool) : null,
      running: v.power_state === 'Running',
      // The storage its disk is on, by name, or null when that cannot be told.
      sr: sr ? srName(sr) : null,
      // Whether it drops what its threat rules match, or only logs it.
      blocks: Array.isArray(v.tags) && v.tags.includes(EDGE.blocksTag),
      // And whether it is one of a pair sharing its addresses (EDGE_HA).
      ha: (ctx.edges || []).some((/** @type {any} */ x) => x?.$pool === v.$pool && x.tags?.includes?.(`${EDGE_HA.nodeTag}1`)),
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
    // Which apt suite it was built from, and so which its machines update
    // along: `stable` or `rolling`.
    channel: imageChannelOf(t),
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
    // And which images each pool has, by key: only those can be rebuilt or
    // removed (checkPolicy).
    imagesOn: (inventory.images || []).reduce((/** @type {Map<string|null, Set<string>>} */ m, /** @type {any} */ i) => m.set(i.pool, (m.get(i.pool) ?? new Set()).add(i.key || 'debian-13')), new Map()),
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
 * `edgeHa` is whether the edge is two routers sharing its addresses, so
 * one carries the machines while the other restarts (true), or one (false);
 * absent, the edge is left as many as it is.
 * `edgeBlock` is whether the edge router drops what its threat rules match
 * (true) or only logs it (false); absent, an edge that is there is left as it
 * is and a new one only logs (edge-router.js, ensureEdge).
 * `labs` is how many labs the edge has, `{ open, closed }`, at most LAB.max
 * together; absent, an edge's labs are left as they are. Labs live on the
 * edge, so they need one there or asked for.
 * `labsEach` is how many of them one person may hold at once: null for no
 * limit, or a whole number from 1 to the labs asked for, and only with them;
 * absent, from a phone that predates it, the labs keep the one they have.
 * `grants` is what the pool's own machine may do from chat once it is made:
 * `{ upgrades, reboot }`, each yes or no (src/core/grants.js, machineGrantsOf).
 *
 * `imageChannel` is the apt suite an image built or rebuilt now installs
 * Fleetwright from: `stable` or `rolling`, or null for as before.
 *
 * @returns {{ ok: true, policy: { srs: string[], networks: string[], egress: string|null, edge: boolean, edgeSr: string|null, edgeBlock: boolean|null, edgeHa: boolean|null, image: boolean, images: string[], rebuild: string[], remove: string[], groups: number, holder: boolean, holderSecret: string|null, holderAgain: boolean, grants: { upgrades?: boolean, reboot?: boolean }|null, imageChannel: string|null, labs: { open: number, closed: number }|null, labsEach?: number|null, limits: { cpus: number, memory: number, disk: number } } } | { ok: false, text: string }}
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
  if (p.edgeHa !== undefined && p.edgeHa !== null && typeof p.edgeHa !== 'boolean') return { ok: false, text: 'Whether the edge is a pair is yes or no. Nothing was changed.' };
  const edgeHa = edge && typeof p.edgeHa === 'boolean' ? p.edgeHa : null;
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
  // REBUILT OR REMOVED: images the way out's pool has, by key, each kept,
  // rebuilt or removed and never two of those. A phone that predates the
  // choice sends neither, and every image stays as it is.
  const keys = (/** @type {unknown} */ v) => (v === undefined || v === null ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...new Set(/** @type {string[]} */ (v))] : null);
  const rebuild = keys(p.rebuild);
  const remove = keys(p.remove);
  if (!rebuild || !remove) return { ok: false, text: 'Which images to rebuild or remove is a list of them. Nothing was changed.' };
  if ((rebuild.length || remove.length) && egress === null) return { ok: false, text: 'Machine images are rebuilt and removed on the way out’s pool: choose the way out. Nothing was changed.' };
  const present = egress === null ? new Set() : choices.imagesOn?.get(choices.networkPools?.get(egress) ?? null) ?? new Set();
  if ([...rebuild, ...remove].some((k) => !present.has(k))) return { ok: false, text: 'That names a machine image this pool does not have. Nothing was changed.' };
  if ([...rebuild, ...asked].some((k) => remove.includes(k)) || rebuild.some((k) => asked.includes(k))) {
    return { ok: false, text: 'A machine image is kept, rebuilt or removed, one of those. Nothing was changed.' };
  }
  if (rebuild.length && !edge && !choices.edgePools?.has(choices.networkPools?.get(/** @type {string} */ (egress)))) {
    return { ok: false, text: 'A machine image is rebuilt behind the edge router, and that pool has none. Build the router with it. Nothing was changed.' };
  }
  const holder = p.holder === true;
  // THE SECRET THE PERSON'S PHONE MADE for the machine to ask to join with
  // (src/fleet/protocol/holder-join.js), and whether to make it again, which
  // the phone offers for one that never joined. Absent, from a phone that
  // predates them, the machine joins with its pin and the one there stays.
  const holderSecret = p.holderSecret === undefined || p.holderSecret === null ? null : String(p.holderSecret);
  if (holderSecret !== null && (!holder || !HOLDER_SECRET_RE.test(holderSecret))) return { ok: false, text: 'That is not a secret for the pool’s own machine. Nothing was changed.' };
  const holderAgain = p.holderAgain === true;
  if (holderAgain && !holder) return { ok: false, text: 'The pool’s own machine is made again only while it is asked for. Nothing was changed.' };
  // WHAT THE POOL'S MACHINES MAY DO FROM CHAT, each yes or no, for the one
  // made now; the phone keeps the same answer in the pool's record for the
  // machines made later. Absent, from a phone that predates it, they keep the
  // machine image's own answer.
  const grants = p.grants === undefined || p.grants === null ? null : machineGrantsOf(p.grants);
  if (p.grants !== undefined && p.grants !== null && !grants) return { ok: false, text: 'What the pool’s machines may do from chat is yes or no for updates and for reboot. Nothing was changed.' };
  // WHAT AN IMAGE BUILT OR REBUILT NOW INSTALLS FLEETWRIGHT FROM: released
  // versions or the newest build of main. Absent, from a phone that predates
  // it, a rebuild keeps what the image was built from and a new one is built
  // from released versions (vm-image.js, ensureImage).
  const imageChannel = p.imageChannel === undefined || p.imageChannel === null ? null : String(p.imageChannel);
  if (imageChannel !== null && !IMAGE_CHANNELS.includes(imageChannel)) return { ok: false, text: 'A machine image is built from released versions or from the newest build of main. Nothing was changed.' };
  if (holder && remove.includes('debian-13')) return { ok: false, text: 'The pool’s own machine is made from the Debian 13 image, so that one stays while it is asked for. Nothing was changed.' };
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
  return { ok: true, policy: { srs, networks, egress, edge, edgeSr: edge || image || labs || rebuild.length ? edgeSr : null, edgeBlock, edgeHa, image, images: asked, rebuild, remove, groups, holder, holderSecret, holderAgain, grants, imageChannel, labs, ...(labsEach !== undefined ? { labsEach } : {}), limits: { cpus, memory, disk } } };
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

/**
 * @typedef {object} XenServer  one of Xen Orchestra's servers, as a reconnect reads it
 * @property {string} id
 * @property {string} label  the name a person gave it, or its pool's
 * @property {string} host  the pool master's address
 * @property {'connected'|'connecting'|'disconnected'} status
 * @property {boolean} enabled  false only when somebody turned it off
 * @property {string|null} error  what Xen Orchestra recorded as wrong with it, or null
 * @property {string|null} poolId  the pool it is the connection of, once connected
 * @property {any} raw  the error as Xen Orchestra recorded it, for permanentWords
 */

/**
 * One entry of `server.getAll`, or null for anything that is not one.
 *
 * THREE STATES, because those are what a phone draws. Xen Orchestra also
 * passes through `disconnecting` on the way down, and may name others; any
 * status that is neither connected nor disconnected is a server on its way
 * somewhere, which is `connecting` to this job (it is cycled, as one stuck
 * would be) and to the phone. `enabled` is Xen Orchestra's own boolean; a
 * record that does not say true is taken as off, because the mistake the
 * other way would be turning on a server a person turned off.
 *
 * @param {any} s @returns {XenServer|null}
 */
function xenServer(s) {
  if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id) return null;
  const e = s.error;
  return {
    id: s.id,
    label: String(s.label ?? s.poolNameLabel ?? '').slice(0, 80),
    host: String(s.host ?? '').slice(0, 200),
    status: s.status === 'connected' || s.status === 'disconnected' ? s.status : 'connecting',
    enabled: s.enabled === true || s.enabled === 'true',
    // Recorded as an object (xo-server's serializeError) on every server
    // the last attempt failed for, and on a connected one whose events have
    // stopped arriving. Any object there is something wrong with it.
    error: e && typeof e === 'object' ? String(e.message || e.code || 'an error').slice(0, 200) : typeof e === 'string' && e ? e.slice(0, 200) : null,
    poolId: typeof s.poolId === 'string' && s.poolId ? s.poolId : null,
    raw: e && typeof e === 'object' ? e : null,
  };
}

/**
 * Whether Xen Orchestra refused a call because of the state something was
 * in: xo-common's `incorrectState`, code 25, "incorrect state".
 *
 * @param {any} e
 */
function incorrectState(e) {
  return e?.code === 25 || /^incorrect state$/i.test(String(e?.message ?? ''));
}

/**
 * The two answers Xen Orchestra itself does not retry a server on, in words,
 * or null for any other. They reach here two ways: as the call's error, where
 * a XAPI SESSION_AUTHENTICATION_FAILED has become xo-common's
 * `authenticationFailed` (code 8) and a PoolAlreadyConnected arrives in its
 * own words; and as the error recorded on the server, which keeps the
 * originals.
 *
 * @param {any} e  an Error from XoRpc, or a server's recorded error
 */
function permanentWords(e) {
  if (!e || typeof e !== 'object') return null;
  const code = String(e.code ?? '');
  const message = String(e.message ?? '');
  if (code === 'SESSION_AUTHENTICATION_FAILED' || code === '8' || /authentication failed/i.test(message)) {
    return 'the pool master refused the user name and password Xen Orchestra keeps for it (SESSION_AUTHENTICATION_FAILED): change them in Xen Orchestra, under this server';
  }
  if (e.name === 'PoolAlreadyConnected' || /pool is already connected/i.test(message)) {
    return 'Xen Orchestra already has this pool connected through another of its servers (PoolAlreadyConnected)';
  }
  return null;
}

/**
 * What a reconnect seals to the phone: each server as the job first read it,
 * what it did, and what the server was doing at the job's last look, and the
 * pools the admin session saw then. A server the job never reached was left.
 *
 * @param {any} ctx
 */
function reconnectResult(ctx) {
  const last = new Map((ctx.lastServers || []).map((/** @type {XenServer} */ s) => [s.id, s]));
  return {
    v: 1,
    servers: /** @type {XenServer[]} */ (ctx.servers).map((s) => {
      const done = ctx.outcomes?.get(s.id);
      return {
        label: s.label,
        host: s.host,
        before: s.status,
        enabled: s.enabled,
        after: last.get(s.id)?.status ?? s.status,
        action: done?.action ?? 'left',
        ...(done?.error ? { error: done.error } : {}),
      };
    }),
    pools: (ctx.lastPools || []).filter((/** @type {any} */ p) => p?.id).map((/** @type {any} */ p) => ({ id: String(p.id), name: String(p.name_label || '').slice(0, 80) })),
  };
}

/**
 * How a reconnect ended, for the coordinator and a Lock Screen: counts and
 * the address, never a server's name or a pool master's address, which are
 * sealed to the phone. "2 of 3 servers are connected again; Xen Orchestra at
 * xo.lan shows 2 pools."
 *
 * @param {any} ctx @param {{ back: boolean, gaveUp: boolean }} how
 */
function reconnectSentence(ctx, { back, gaveUp }) {
  const servers = /** @type {XenServer[]} */ (ctx.servers);
  const actions = servers.map((s) => String(ctx.outcomes?.get(s.id)?.action ?? 'left'));
  const connected = servers.filter((s) => (ctx.lastServers || []).find((/** @type {XenServer} */ x) => x.id === s.id)?.status === 'connected').length;
  const count = (ctx.lastPools || []).length;
  const pools = count ? plural(count, 'pool') : 'no pools';
  const off = actions.filter((a) => a === 'skipped-disabled').length;
  const failed = actions.filter((a) => a === 'failed').length;
  const tried = actions.filter((a) => a === 'enabled' || a === 'cycled' || a === 'failed').length;
  if (!tried && !off) {
    return `${servers.length === 1 ? 'The one server' : `All ${servers.length} servers`} of Xen Orchestra at ${ctx.rec.address} ${servers.length === 1 ? 'was' : 'were'} already connected, so nothing was changed; it shows ${pools}.`;
  }
  const said = [`${gaveUp ? 'After three minutes, ' : ''}${connected} of ${plural(servers.length, 'server')} ${connected === 1 || servers.length === 1 ? 'is' : 'are'} connected${back && tried ? ' again' : ''}; Xen Orchestra at ${ctx.rec.address} shows ${pools}.`];
  if (off) said.push(`${off === 1 ? 'One server is' : `${off} servers are`} turned off in Xen Orchestra and ${off === 1 ? 'was' : 'were'} left that way.`);
  if (failed) said.push(`${failed === 1 ? 'One' : failed} could not be reconnected; which and why are on your phone.`);
  return said.join(' ');
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
  // THE ROUTERS' KEY, SEALED the same way, once a policy job is over: done,
  // or cancelled after it built a router with that key.
  if ((rec.state === 'done' || rec.state === 'cancelled') && rec.watch) return { ...s, watch: rec.watch };
  // THE POOL, SEALED, while the job waits on the person's choice.
  if (rec.state === 'choosing' && rec.inventory) return { ...s, inventory: rec.inventory };
  // WHAT A RECONNECT DID TO EACH SERVER, SEALED, once it has ended, which
  // ever way: a reconnect that failed is when the person most needs it.
  if (rec.state !== 'running' && rec.result) return { ...s, result: rec.result };
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

/**
 * Where a pool's edge router sends its logs: this box first, then the pool's
 * own machines that are up, private IPv4 addresses only and each once. The
 * router keeps two (edge-credentials.js, watchConfig).
 *
 * THIS BOX FIRST, because it is the one address here the job knows rather
 * than was told. A holder's is what its guest agent reports, which whoever
 * runs inside it says; it came first, and with two holders, or one that was
 * not the pool's own, the box watching the router was pushed off its list.
 *
 * @param {any[]|undefined} holders  as isHolder found them
 * @param {string} pool @param {string|null|undefined} localAddress  this box's, on its way to Xen Orchestra
 * @returns {string[]}
 */
export function syslogTo(holders, pool, localAddress) {
  return [
    String(localAddress || ''),
    ...(holders || []).filter((/** @type {any} */ v) => v?.$pool === pool && v.power_state === 'Running').map((/** @type {any} */ v) => String(v.mainIpAddress || '')),
  ].filter((ip, i, all) => isPrivateV4(ip) && all.indexOf(ip) === i);
}

/** A private IPv4 address, the only kind a router's syslog is sent to. @param {string} ip */
function isPrivateV4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128);
}

/** @param {number} n @param {string} word @param {string} [many] the word for more than one, where an s will not do */
function plural(n, word, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

/** @param {number} bytes */
function gib(bytes) {
  return `${Math.round(bytes / 1024 ** 3)} GiB`;
}

/**
 * The addresses a name resolves to, or the address itself.
 *
 * @param {string} host
 * @returns {Promise<string[]>}
 */
async function resolveAddresses(host) {
  if (net.isIP(host)) return [host];
  const found = await dns.lookup(host, { all: true });
  return [...new Set(found.map((a) => a.address))];
}
