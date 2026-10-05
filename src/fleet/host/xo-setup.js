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
//           and wiped when they finish, whichever way they finish.
//
// THE STEPS (XOSETUP_STEPS) make the limited `fleetwright` user, the resource
// set that bounds it, and a token for it; turn on the installer's own update
// plugin when the pool has it (github.com/00o-sh/XenOrchestraInstallerUpdater);
// and keep only the token. The admin sign-in is never written anywhere.
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
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

import { XOSETUP_STEPS, XOSETUP_JOB_RE, CERT_PIN_RE } from '../protocol/intents.js';
import { newSealKey, open as openSealed, xosetupAad } from '../seal.js';
import { signingInput } from '../crypto.js';
import { certSha256, splitAddress, connectXo, connectXoPlain, describeCertificate, CERT_PROBLEM_WORDS } from './xo-ws.js';

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
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ reachable: boolean, xo: boolean|null, tls: boolean, cert: string|null, certificate: ReturnType<typeof describeCertificate>, version: string|null, text: string }>}
 */
// FOUR SECONDS AN ATTEMPT, and at most two attempts (HTTPS, then plain HTTP
// on 80, or on the address's own port), so a probe answers inside the
// coordinator's ten-second fan-out deadline even for an address that drops
// packets.
export async function probe(address, { timeoutMs = 4_000 } = {}) {
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

/** @param {string} body */
function looksLikeXo(body) {
  return /<title>[^<]*Xen Orchestra/i.test(body) || /xo-web|xo-server|xen-orchestra/i.test(body);
}

/**
 * @param {{ host: string, port: number, secure: boolean, timeoutMs: number }} opts
 * @returns {Promise<{ ok: true, body: string, cert: string|null, certificate: ReturnType<typeof describeCertificate> } | { ok: false, error: string }>}
 */
function getRoot({ host, port, secure, timeoutMs }) {
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
      resolve(r);
    };
    const socket = secure
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
 * @property {'waiting'|'running'|'done'|'failed'|'cancelled'} state
 * @property {number} step
 * @property {number} of
 * @property {string} phase
 * @property {string} text
 */

/**
 * The jobs this machine is running or has run lately.
 */
export class XoSetups {
  /**
   * @param {{
   *   signer: { publicJwk: { kty?: string, crv?: string, x: string, y: string }, sign: (message: string) => Promise<string> }|null,
   *   emit: (event: Record<string, any>) => void,
   *   stateDir: string,
   *   connect?: typeof connectXo,
   *   connectPlain?: typeof connectXoPlain,
   *   fingerprint: (jwk: any) => Promise<string>,
   *   now?: () => number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   * }} opts
   */
  constructor({ signer, emit, stateDir, connect = connectXo, connectPlain = connectXoPlain, fingerprint, now = () => Date.now(), log }) {
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
   * @param {{ address: string, pin?: string|null, trust?: string|null, plain?: string|null, actor: string|null }} args
   */
  async begin({ address, pin, trust = null, plain = null, actor }) {
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
    if ([...this.jobs.values()].filter((j) => j.state === 'waiting' || j.state === 'running').length >= 3) {
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
      xosetup: { job, state: 'waiting', key: key.publicKey, keySig, hostKey, fingerprint: await this.fingerprint(hostKey) },
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
    try {
      inside = await openSealed({
        privateKey: rec.key.privateKey,
        publicKey: rec.key.publicKey,
        aad: xosetupAad(job, rec.address),
        sealed: { epk: parts[0], iv: parts[1], ct: parts[2] },
      });
    } catch {
      return { ok: false, text: 'The sign-in did not open with this setup’s key. Start again from the app.' };
    }
    // ONE USE: the key goes as soon as it has opened the one thing it exists for.
    rec.key = null;
    const xo = inside?.v === 1 && inside.xo && typeof inside.xo === 'object' ? inside.xo : null;
    const creds = xo && typeof xo.email === 'string' && typeof xo.password === 'string'
      ? { email: xo.email, password: xo.password }
      : xo && typeof xo.token === 'string'
        ? { token: xo.token }
        : null;
    if (!creds) {
      rec.state = 'failed';
      rec.text = 'The sealed sign-in was not an email and password, or a token.';
      return { ok: false, text: rec.text, xosetup: status(rec) };
    }
    rec.state = 'running';
    rec.text = 'Starting.';
    void this.#execute(rec, creds);
    return { ok: true, text: `Setting up ${rec.address}.`, xosetup: status(rec) };
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
    } else if (rec.state === 'running') {
      // Between steps: a call already sent to Xen Orchestra is not unsent.
      rec.cancelled = true;
      rec.text = 'Cancelling after this step.';
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
  #open(rec) {
    return rec.plain ? this.connectPlain({ address: rec.address }) : this.connect({ address: rec.address, pin: rec.pin });
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
      if ((rec.state === 'waiting' && age > WAITING_TTL_MS) || (rec.state !== 'running' && age > FINISHED_TTL_MS)) {
        this.jobs.delete(job);
      }
    }
  }

  /** @param {any} rec */
  #report(rec) {
    try {
      this.emit({ event: 'xosetup.progress', job: rec.job, step: rec.step, of: rec.of, phase: rec.phase, state: rec.state, text: rec.text });
    } catch (e) {
      this.log.warn(`xosetup: could not report progress: ${/** @type {Error} */ (e).message}`);
    }
  }

  /**
   * Run the steps. Never throws: every way out sets the job's state, reports
   * it, closes what it opened and wipes the sign-in.
   *
   * @param {any} rec
   * @param {{ email?: string, password?: string, token?: string }} creds
   */
  async #execute(rec, creds) {
    /** @type {any} */
    const ctx = { rec, creds, admin: null, limited: null, notes: /** @type {string[]} */ ([]) };
    const steps = this.#steps();
    try {
      for (let i = 0; i < steps.length; i++) {
        if (rec.cancelled) {
          rec.state = 'cancelled';
          rec.text = `Cancelled before ${STEP_WORDS[XOSETUP_STEPS[i]] ?? `step ${i + 1}`}.`;
          this.#report(rec);
          return;
        }
        rec.step = i;
        rec.phase = XOSETUP_STEPS[i];
        rec.text = `${STEP_WORDS[rec.phase]}.`;
        this.#report(rec);
        const said = await steps[i](ctx);
        // What a step found, kept for the summary rather than reported on its
        // own: one event per step is what the phone shows, and a second one
        // saying what the first found would double every buzz on Android.
        if (typeof said === 'string') ctx.notes.push(said);
      }
      rec.step = rec.of;
      rec.phase = 'done';
      rec.state = 'done';
      rec.text = [ctx.summary || `${rec.address} is in the fleet.`, ...ctx.notes].join(' ');
      this.#report(rec);
      this.log.info(`xosetup: ${rec.job} finished for ${rec.address}`);
    } catch (e) {
      rec.state = 'failed';
      rec.text = `${STEP_WORDS[rec.phase] ?? 'Setup'} stopped: ${scrub(/** @type {Error} */ (e).message, creds)}`;
      this.#report(rec);
      this.log.warn(`xosetup: ${rec.job} stopped at ${rec.phase}`);
    } finally {
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
      ctx.password = undefined;
      ctx.token = undefined;
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
        if (user?.permission !== 'admin') {
          throw new Error('that account is signed in but is not a Xen Orchestra admin, and adding a pool needs one.');
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
        const limits = limitsFrom(ctx.hosts, ctx.srs, ctx.pools);
        const objects = ctx.pools.map((/** @type {any} */ p) => p.default_SR).filter((/** @type {any} */ id) => typeof id === 'string' && id);
        const sets = (await ctx.admin.call('resourceSet.getAll')) || [];
        const existing = sets.find((/** @type {any} */ s) => s?.name === FLEET_SET);
        if (existing) {
          if (Object.hasOwn(ctx.methods, 'resourceSet.set')) {
            await ctx.admin.call('resourceSet.set', { id: existing.id, subjects: [ctx.userId], objects, limits });
          }
          ctx.setId = existing.id;
        } else {
          const made = await ctx.admin.call('resourceSet.create', { name: FLEET_SET, subjects: [ctx.userId], objects, limits });
          ctx.setId = made?.id ?? made;
        }
        ctx.limits = limits;
        return `It may use ${limits.cpus} vCPUs, ${gib(limits.memory)} of memory and ${gib(limits.disk)} of disk.`;
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
        this.#keep({
          address: ctx.rec.address,
          pin: ctx.rec.pin,
          user: FLEET_USER,
          userId: ctx.userId,
          resourceSet: ctx.setId ?? null,
          token: ctx.token,
          // null is the server's default length, which it does not say.
          tokenExpires: ctx.tokenExpires ? new Date(ctx.tokenExpires).toISOString() : null,
          certificate: ctx.certificate
            ? { trusted: ctx.certificate.trusted, accepted: ctx.rec.trust === 'accepted', notAfter: ctx.certificate.notAfter }
            : null,
          // Every later call with this token crosses the network as it is.
          plain: ctx.rec.plain === true,
          limits: ctx.limits,
          pools: ctx.pools.map((/** @type {any} */ p) => ({ id: p.id, name: String(p.name_label || '').slice(0, 80) })),
          savedAt: new Date(this.now()).toISOString(),
        });
        ctx.summary = `${ctx.rec.address} is in the fleet: ${plural(ctx.pools.length, 'pool')}, worked through a limited user. The admin sign-in was not kept.`;
      },
    ];
  }

  /**
   * The one thing kept: the limited user's token, beside the address and pin
   * it is for. 0600 in a 0700 directory, written whole then renamed, so a
   * reader never sees half a file.
   *
   * @param {Record<string, any>} record
   */
  #keep(record) {
    const dir = path.join(this.stateDir, 'hypervisors');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = record.address.replace(/[^A-Za-z0-9.-]+/g, '_');
    const file = path.join(dir, `${name}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
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
}));

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
  return { job: rec.job, state: rec.state, step: rec.step, of: rec.of, phase: rec.phase, text: rec.text };
}

function unknown() {
  return { ok: false, text: 'No setup with that id is running here for you.' };
}

/**
 * An error's words, with anything from the sign-in taken out. Xen Orchestra
 * does not echo a password back, and this does not rely on it.
 *
 * @param {string} message @param {{ password?: string, token?: string }} creds
 */
function scrub(message, creds) {
  let out = String(message || 'an error');
  for (const secret of [creds.password, creds.token]) {
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
