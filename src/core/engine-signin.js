// A box's side of signing an engine in on itself (docs/engines.md, "Signing
// in on the machine").
//
// A custodian asks; the sidecar checks that they may (sidecar.js) and posts
// here; this runs a short container from the session image with that
// member's engine home mounted and the runner in its sign-in mode
// (sandbox/engine.mjs, `--signin`), and reads two lines of JSON from it: the
// page and the code, then how it ended. The engine writes its own sign-in
// into the home. Nothing here ever reads that file.
//
// WHAT IS KEPT, AND WHERE:
//
//   in memory   an attempt that is waiting: its page, its code, its process.
//               A hub that restarts loses it, and says so (`lost`); it never
//               says an attempt it cannot see is waiting.
//   on disk     `engine-signins.json` in the state directory: for each member
//               and engine, how the last attempt ended, who is signed in and
//               since when, who asked, and a mark while an attempt is out.
//               No token, no code and no page.
//
// THE PAGE AND THE CODE ARE NOT SECRETS, AND THEY ARE NOBODY ELSE'S. They go
// back in the answer to whoever asked, and into no file, no log line and
// nothing this box reports. A log line here names a member, an engine and a
// state, and nothing the engine or the runner said.
//
// ONE ATTEMPT A MEMBER AND ENGINE AT A TIME. A second start while one waits
// is answered with the one in flight.
//
// NOT RUN ON A BOX. Everything here is driven in tests through a script that
// stands in for Podman and runs the real runner (test/engine-signin-hub.test.js).
// That rootless Podman mounts the volume as written, forwards the signal a
// cancel sends, and removes the container when it ends is read from its
// documentation and has not been seen.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { log } from '../log.js';
import { ENGINES, SIGNIN_ENGINES } from '../fleet/protocol/engines.js';
import { MEMBER_ID_RE, memberOfAccount } from '../fleet/protocol/members.js';
import { normaliseEmail } from './accounts.js';
import { boxEngines } from './engine-box.js';
import { ENGINE_HOME, engineHomeVolume } from './engine-home.js';
import { ensureEgress, egressArgs } from './egress.js';
import { podmanAsync, podmanAvailable, sandboxImageExists } from './podman.js';
import { sessionImage } from './sandbox-variant.js';
import { usernsArgs } from './sandbox-userns.js';

/** What may be asked. */
const SIGNIN_ACTIONS = Object.freeze(['start', 'status', 'cancel', 'signout']);
/** How long a device code lasts, in minutes: Codex's own bound, and GitHub's. */
export const SIGNIN_MINUTES = 15;
/** How long a start waits for the engine to give a code before it is stopped. Under the fleet's own wait for a box's answer. */
const CODE_MS = 45_000;
/** How long past the code's life the container is given to say it expired, before this box says so itself. */
const GRACE_MS = 30_000;
/** How long a sign out may take. */
const SIGNOUT_MS = 45_000;
/** How long a container told to stop is given before it is removed. */
const STOP_MS = 5_000;

const says = (/** @type {string} */ engine) => ENGINES[/** @type {keyof typeof ENGINES} */ (engine)]?.says ?? engine;
/** One printable line, bounded: the runner's `detail` is the engine's own words. */
const oneLine = (/** @type {unknown} */ v, max = 200) => (typeof v === 'string' ? v.split('\n')[0].replace(/[^\x20-\x7e]/g, '').trim().slice(0, max) : '') || null;
const when = (/** @type {number} */ at) => `${new Date(at).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

/**
 * @typedef {{ email: string|null, plan: string|null }} Who  the account, as the engine itself says
 * @typedef {{ since: number, who: Who|null, by: string|null }} SignedIn
 * @typedef {{ state: string, at: number, detail: string|null, by: string|null }} Last
 * @typedef {{ member: string, engine: string, signedIn: SignedIn|null, last: Last|null, attempt: { startedAt: number, by: string|null }|null }} Entry
 * @typedef {{ key: string, member: string, engine: string, by: string|null, box: string, startedAt: number, expiresAt: number,
 *   url: string|null, code: string|null, child: any, stopped: 'cancelled'|'lost'|null, over: boolean,
 *   first: Promise<Record<string, any>>, ended: Promise<void>, timers: any[] }} Attempt
 */

/** Who the runner says is signed in, held to an address and a plan's name. @param {any} who @returns {Who|null} */
function cleanWho(who) {
  if (!who || typeof who !== 'object') return null;
  const email = oneLine(who.email, 120);
  const plan = oneLine(who.plan, 40);
  const clean = { email: email && /^[^\s@]{1,64}@[^\s@]{1,100}$/.test(email) ? email : null, plan: plan && /^[A-Za-z0-9 ._-]+$/.test(plan) ? plan : null };
  return clean.email || clean.plan ? clean : null;
}

export class EngineSignins {
  /**
   * @param {import('../config.js').Config} cfg
   * @param {{ now?: () => number, capMs?: number, codeMs?: number, graceMs?: number, stopMs?: number }} [opts]  the waits, for a test that cannot take fifteen minutes
   */
  constructor(cfg, { now = Date.now, capMs = SIGNIN_MINUTES * 60_000, codeMs = CODE_MS, graceMs = GRACE_MS, stopMs = STOP_MS } = {}) {
    this.cfg = cfg;
    this.now = now;
    this.capMs = capMs;
    this.codeMs = codeMs;
    this.graceMs = graceMs;
    this.stopMs = stopMs;
    /** Attempts that are out, by member and engine. Memory only. @type {Map<string, Attempt>} */
    this.attempts = new Map();
    /** Members and engines being signed out right now. @type {Set<string>} */
    this.signingOut = new Set();
  }

  // ── What is kept on disk ──────────────────────────────────────────────────

  /** Where it is kept. Asked each time, and not at construction: a state directory that cannot be named must not stop a hub coming up. */
  get file() {
    return path.join(String(this.cfg.stateDir), 'engine-signins.json');
  }

  /**
   * Everything kept, or NULL WHEN IT CANNOT BE READ AT ALL, which is cannot
   * tell and never nothing: a box that cannot read what it was told must not
   * say nobody is signed in. No file yet is nothing kept. A file that is not
   * what this writes is nothing kept either, said once in the log: what it
   * held is no longer known, and that is what is then reported.
   *
   * @returns {Record<string, Entry>|null}
   */
  #read() {
    let text;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if (/** @type {any} */ (e)?.code === 'ENOENT') return {};
      return null;
    }
    try {
      const signins = JSON.parse(text)?.signins;
      if (signins && typeof signins === 'object' && !Array.isArray(signins)) return signins;
    } catch { /* said below */ }
    log.warn('engines: the record of engine sign-ins on this machine does not read as one, so nothing is known of them until one is made again');
    return {};
  }

  /** One entry, changed and written. Beside the file and moved into place, so a reader never meets half of it. */
  #write(/** @type {string} */ key, /** @type {(entry: Entry) => void} */ change) {
    const all = this.#read() ?? {};
    const [member, engine] = key.split('/');
    const entry = all[key] ?? { member, engine, signedIn: null, last: null, attempt: null };
    change(entry);
    all[key] = entry;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const next = `${this.file}.${process.pid}`;
    writeFileSync(next, `${JSON.stringify({ v: 1, signins: all }, null, 2)}\n`, { mode: 0o600 });
    renameSync(next, this.file);
    return entry;
  }

  // ── What is asked ─────────────────────────────────────────────────────────

  /**
   * One request, as the sidecar posts it once it has checked who may.
   *
   * `account` is what the member's sessions run as on this box, which the
   * sidecar took from the list the minter signed: the member's own address
   * for a person, `<id>@members.invalid` for an agent. It names the volume,
   * through engineHomeVolume and never as text.
   *
   * @param {{ member?: unknown, account?: unknown, engine?: unknown, action?: unknown, by?: unknown, box?: unknown }} ask
   * @returns {Promise<Record<string, any>>}
   */
  async ask(ask) {
    const member = String(ask?.member ?? '');
    const engine = String(ask?.engine ?? '');
    const action = String(ask?.action ?? '');
    const account = normaliseEmail(ask?.account);
    const box = oneLine(ask?.box, 64) ?? oneLine(this.cfg.hostname, 64) ?? 'this machine';
    const by = normaliseEmail(ask?.by);
    if (!MEMBER_ID_RE.test(member) || !SIGNIN_ENGINES.includes(engine) || !SIGNIN_ACTIONS.includes(action) || !account) {
      return { ok: false, error: { code: 'bad_params' }, text: 'An engine sign-in names a member, the account its sessions run as here, codex or opencode, and start, status, cancel or signout.' };
    }
    // An agent's account says which agent it is, and it must be this one: a
    // request for one member must never open another's engine home.
    const agent = memberOfAccount(account);
    if (agent && agent !== member) {
      return { ok: false, error: { code: 'bad_params' }, text: `${account} is another member’s account, not ${member}’s.` };
    }
    const volume = engineHomeVolume(account);
    if (!volume) return { ok: false, error: { code: 'bad_params' }, text: `No engine home can be named for ${member}.` };
    // A BOX THAT DOES NOT RUN THE ENGINE SAYS SO, for every action: there is
    // nothing here to sign in, and nothing to report on.
    if (!boxEngines(this.cfg).includes(engine)) {
      return {
        ok: false, error: { code: 'no_engine' }, member, engine,
        text: `${box} does not run ${says(engine)}, so it cannot be signed in here. Its operator adds ${says(engine)} to the session image and names it in FLEETWRIGHT_ENGINES, or the sign-in is made on a machine that runs it.`,
      };
    }
    // WHAT THIS BOX KNOWS CANNOT BE READ: it cannot say where a sign-in
    // stands, and it does not begin one it could not write down.
    if (this.#read() === null) {
      return { ok: false, error: { code: 'state_unreadable' }, member, engine, text: `${box} cannot read its own record of engine sign-ins, so it cannot say where this one stands or begin another. Whoever runs ${box} looks at its state directory.` };
    }
    const key = `${member}/${engine}`;
    if (action === 'start') return this.#start({ key, member, engine, account, volume, by, box });
    if (action === 'cancel') return this.#cancel(key, box);
    if (action === 'signout') return this.#signout({ key, member, engine, account, volume, by, box });
    return this.#status(key, box);
  }

  /**
   * Where a sign-in stands, as an answer: the attempt that is out, or how
   * the last one ended, and beside either who is signed in.
   *
   * @param {string} key @param {string} box
   * @param {Record<string, any>} [extra]
   * @returns {Record<string, any>}
   */
  #view(key, box, extra = {}) {
    const [member, engine] = key.split('/');
    const entry = this.#read()?.[key] ?? null;
    const signedIn = entry?.signedIn ? { since: entry.signedIn.since, who: entry.signedIn.who ?? null } : null;
    const as = signedIn?.who?.email ? ` as ${signedIn.who.email}` : '';
    const live = this.attempts.get(key);
    if (live && live.code && !live.over) {
      const left = Math.max(1, Math.ceil((live.expiresAt - this.now()) / 60_000));
      return {
        ok: true, state: 'waiting', member, engine, url: live.url, code: live.code,
        startedAt: live.startedAt, expiresAt: live.expiresAt, expiresInMinutes: left, signedIn, ...extra,
        text: `Open ${live.url} and enter ${live.code} to sign ${says(engine)} in for ${member} on ${box}. The code lasts about ${left} more minute${left === 1 ? '' : 's'}.` +
          (signedIn ? ` Until it is approved, ${says(engine)} stays signed in${as} there.` : ''),
      };
    }
    const last = entry?.last ?? null;
    const state = last?.state ?? 'none';
    // A new attempt that did not complete replaces nothing: say so, where it is true.
    const still = signedIn && state !== 'signed_in' ? ` ${says(engine)} is still signed in${as} there, since ${when(signedIn.since)}.` : '';
    const words = {
      none: `${box} knows of no ${says(engine)} sign-in for ${member}.`,
      signed_in: `${says(engine)} is signed in for ${member} on ${box}${as}, since ${when(signedIn?.since ?? last?.at ?? 0)}.`,
      expired: `The code ran out before anybody approved it, so ${says(engine)} was not signed in for ${member} on ${box}. Start again for a new code.`,
      failed: `${says(engine)} was not signed in for ${member} on ${box}: ${last?.detail ?? 'the engine gave no reason'}.`,
      cancelled: `The ${says(engine)} sign-in for ${member} on ${box} was cancelled.`,
      lost: `${box} restarted while a ${says(engine)} sign-in for ${member} was waiting, so that attempt is gone. Start again for a new code.`,
      signed_out: `${says(engine)} is signed out for ${member} on ${box}.`,
      ended: `${says(engine)} said its sign-in for ${member} on ${box} no longer works. Sign it in again.`,
    };
    return {
      ok: true, state, member, engine,
      ...(last ? { at: last.at } : {}),
      ...(state === 'failed' ? { detail: last?.detail ?? null } : {}),
      signedIn, ...extra,
      text: `${words[/** @type {keyof typeof words} */ (state)] ?? words.none}${still}`,
    };
  }

  /** @param {string} key @param {string} box */
  async #status(key, box) {
    const live = this.attempts.get(key);
    // An attempt that has not given its code yet is about to: its start's own
    // answer is this one's too.
    if (live && !live.code && !live.over) await live.first;
    this.#lostIfOrphan(key);
    return this.#view(key, box);
  }

  /**
   * An attempt the file says is out and this process does not hold: the hub
   * restarted under it. Written down as lost, and its container removed so
   * that what is said stays true: an attempt nobody can see does not go on
   * to sign in.
   *
   * @param {string} key
   */
  #lostIfOrphan(key) {
    if (this.attempts.has(key)) return;
    const entry = this.#read()?.[key];
    if (!entry?.attempt) return;
    this.#write(key, (e) => {
      e.last = { state: 'lost', at: this.now(), detail: null, by: e.attempt?.by ?? null };
      e.attempt = null;
    });
    log.warn(`engines: the ${entry.engine} sign-in that was waiting for ${entry.member} did not outlive a restart of this hub, and is recorded as lost`);
    void this.#remove(containerFor(entry.member, entry.engine));
  }

  /** Every attempt a restart left behind, found as this hub comes up. */
  recover() {
    for (const key of Object.keys(this.#read() ?? {})) this.#lostIfOrphan(key);
  }

  /** Remove a sign-in's container, whatever state it is in. Never throws. @param {string} container */
  async #remove(container) {
    try {
      await podmanAsync(this.cfg, ['rm', '-f', container], { timeout: 20_000 });
    } catch { /* gone already, or no podman: either way there is nothing running under that name */ }
  }

  /** The `podman run` for one sign-in or sign out. @param {{ member: string, engine: string, account: string, volume: string }} a @param {'--signin'|'--signout'} mode @param {import('./egress.js').EgressRoute|null} route */
  #argv(a, mode, route) {
    const cfg = this.cfg;
    return [
      'run', '--rm', '--name', containerFor(a.member, a.engine),
      // The session namespace, because a session of this member mounts the same volume (sandbox-userns.js).
      ...usernsArgs(cfg),
      '-v', `${a.volume}:${ENGINE_HOME}`,
      '-e', `FLEETWRIGHT_ENGINE_HOME=${ENGINE_HOME}`,
      // Behind an egress list, the member's own way out, as their sessions have.
      ...egressArgs(cfg, route),
      ...(cfg.sandboxMemory ? [`--memory=${cfg.sandboxMemory}`] : []),
      ...(cfg.sandboxCpus ? [`--cpus=${cfg.sandboxCpus}`] : []),
      ...(cfg.sandboxPidsLimit ? [`--pids-limit=${cfg.sandboxPidsLimit}`] : []),
      ...(cfg.sandboxExtraArgs ?? []),
      sessionImage(cfg),
      'fleetwright-engine', mode, a.engine,
    ];
  }

  /** What has to be true before a container is run, or the refusal. @param {{ member: string, engine: string, account: string }} a @param {string} box */
  async #ready(a, box) {
    /** @param {string} code @param {string} text */
    const refuse = (code, text) => /** @type {const} */ ({ ok: false, error: { code }, member: a.member, engine: a.engine, text });
    if (!podmanAvailable(this.cfg)) return refuse('no_podman', `${box} has no ${this.cfg.podmanBin} to run a sign-in in.`);
    // Not fetched here: a pull is minutes, and the answer is waited on for less.
    if (!sandboxImageExists(this.cfg)) {
      return refuse('no_image', `${box} has not fetched its session image yet, so there is nothing to run the sign-in in. Start a session there first, then ask again.`);
    }
    const way = await ensureEgress(this.cfg, a.account);
    if (!way.ok) return refuse('no_egress', `${box} could not prepare ${a.member}’s way out to the provider: ${oneLine(way.message) ?? 'no reason given'}.`);
    return { ok: /** @type {const} */ (true), route: way };
  }

  /** @param {{ key: string, member: string, engine: string, account: string, volume: string, by: string|null, box: string }} a */
  async #start(a) {
    // THE ONE IN FLIGHT, when there is one: its answer, marked as that.
    const live = this.attempts.get(a.key);
    if (live && !live.over) {
      const first = await live.first;
      return first.ok && this.attempts.get(a.key) === live && !live.over ? this.#view(a.key, a.box, { already: true }) : first;
    }
    if (this.signingOut.has(a.key)) {
      return { ok: false, error: { code: 'busy' }, member: a.member, engine: a.engine, text: `${says(a.engine)} is being signed out for ${a.member} on ${a.box} right now. Ask again in a moment.` };
    }
    const startedAt = this.now();
    /** @type {Attempt} */
    const attempt = {
      key: a.key, member: a.member, engine: a.engine, by: a.by, box: a.box, startedAt, expiresAt: startedAt + this.capMs,
      url: null, code: null, child: null, stopped: null, over: false,
      first: /** @type {any} */ (null), ended: /** @type {any} */ (null), timers: [],
    };
    // In the map before anything is awaited, so a second start arriving now finds it.
    this.attempts.set(a.key, attempt);
    attempt.first = this.#run(attempt, a);
    return attempt.first;
  }

  /**
   * Run one attempt's container, and answer its start: with the page and the
   * code when the runner gives them, or with why it gave none.
   *
   * @param {Attempt} attempt
   * @param {{ key: string, member: string, engine: string, account: string, volume: string, by: string|null, box: string }} a
   * @returns {Promise<Record<string, any>>}
   */
  async #run(attempt, a) {
    /** @type {() => void} */
    let finished = () => {};
    attempt.ended = new Promise((resolve) => {
      finished = resolve;
    });
    /** How it ended, written down once, and the attempt forgotten. @param {string} state @param {{ detail?: string|null, who?: Who|null }} [said] */
    const end = (state, said = {}) => {
      if (attempt.over) return;
      attempt.over = true;
      for (const t of attempt.timers) clearTimeout(t);
      if (this.attempts.get(a.key) === attempt) this.attempts.delete(a.key);
      const at = this.now();
      this.#write(a.key, (e) => {
        e.last = { state, at, detail: state === 'failed' ? (said.detail ?? null) : null, by: a.by };
        e.attempt = null;
        if (state === 'signed_in') e.signedIn = { since: at, who: said.who ?? null, by: a.by };
      });
      // A member, an engine and a state: nothing the engine said.
      log.info(`engines: ${a.engine} sign-in for ${a.member}, asked by ${a.by ?? 'nobody named'}: ${state}`);
      try {
        attempt.child?.kill?.('SIGTERM');
      } catch { /* gone already */ }
      void this.#remove(containerFor(a.member, a.engine));
      finished();
    };
    const refusal = (/** @type {string} */ code, /** @type {string} */ text, /** @type {Record<string, any>} */ extra = {}) => ({ ok: false, error: { code }, member: a.member, engine: a.engine, ...extra, text });

    const ready = await this.#ready(a, a.box);
    if (!ready.ok) {
      // Nothing was run, so nothing ended: the last attempt's word stands.
      attempt.over = true;
      this.attempts.delete(a.key);
      finished();
      return ready;
    }
    // A MARK THAT AN ATTEMPT IS OUT, so a hub that restarts under it knows
    // one was, and says it is gone (#lostIfOrphan).
    this.#write(a.key, (e) => {
      e.attempt = { startedAt: attempt.startedAt, by: a.by };
    });
    // Whatever an attempt this hub lost track of left under the name.
    await this.#remove(containerFor(a.member, a.engine));
    if (attempt.stopped) {
      end(attempt.stopped);
      return this.#view(a.key, a.box);
    }

    return new Promise((answer) => {
      /** The last thing Podman itself said, for a container that never ran. Said to whoever asked, and never logged. */
      let complaint = '';
      let child;
      try {
        // Its own process group, as every long Podman call here has
        // (podman.js, podmanAsync): what ends it is this box, by name.
        child = spawn(this.cfg.podmanBin, this.#argv(a, '--signin', ready.route), { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      } catch (e) {
        end('failed', { detail: `the sign-in container could not be started: ${oneLine(/** @type {Error} */ (e).message) ?? 'no reason given'}` });
        return answer(refusal('signin_failed', this.#view(a.key, a.box).text, { state: 'failed' }));
      }
      attempt.child = child;
      child.on('error', (e) => {
        complaint = oneLine(e?.message) ?? complaint;
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (/** @type {string} */ text) => {
        // Kept only until the code is out. After that nothing the container
        // prints is kept at all: a code is out there, and so may a sign-in be.
        if (!attempt.code) complaint = oneLine(text.trim().split('\n').pop()) ?? complaint;
      });

      // NO CODE IN TIME is a start that is stopped and refused, not one that
      // is left to answer later with nobody asking.
      attempt.timers.push(setTimeout(() => {
        if (attempt.code || attempt.over) return;
        end('failed', { detail: `${says(a.engine)} gave no sign-in code within ${Math.round(this.codeMs / 1000)} seconds` });
        answer(refusal('no_code', `${this.#view(a.key, a.box).text} Nothing is waiting; start again.`, { state: 'failed' }));
      }, this.codeMs));
      // THE CODE'S LIFE, and a little more for the runner to say so itself.
      attempt.timers.push(setTimeout(() => end('expired'), this.capMs + this.graceMs));

      let held = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (/** @type {string} */ chunk) => {
        held += chunk;
        // The runner's two lines are short. Anything longer is not them.
        if (held.length > 16 * 1024) held = held.slice(-16 * 1024);
        for (let at = held.indexOf('\n'); at >= 0; at = held.indexOf('\n')) {
          const text = held.slice(0, at);
          held = held.slice(at + 1);
          /** @type {any} */
          let said = null;
          try {
            said = JSON.parse(text);
          } catch { /* not one of the runner's lines */ }
          if (!said || typeof said !== 'object' || attempt.over) continue;
          if (said.signin === 'code' && !attempt.code) {
            const url = oneLine(said.url, 300);
            const code = oneLine(said.code, 40);
            if (!url || !/^https:\/\/[^\s]+$/.test(url) || !code || !/^[A-Za-z0-9-]{4,40}$/.test(code)) continue;
            attempt.url = url;
            attempt.code = code;
            complaint = '';
            answer(this.#view(a.key, a.box));
          } else if (said.signin === 'done') {
            const state = ['signed_in', 'expired', 'cancelled'].includes(said.state) ? String(said.state) : 'failed';
            const had = Boolean(attempt.code);
            const detail = state === 'failed' ? (oneLine(said.detail) ?? 'the engine gave no reason') : null;
            // A sign-in the runner reports with no code ever given is not one.
            end(state === 'signed_in' && !had ? 'failed' : attempt.stopped && state !== 'signed_in' ? attempt.stopped : state, { detail: state === 'signed_in' && !had ? 'the runner reported a sign-in it gave no code for' : detail, who: cleanWho(said.who) });
            if (!had) {
              // It ended before any code: that is the start's answer.
              const off = said.why === 'device_code_off';
              const view = this.#view(a.key, a.box);
              answer(view.state === 'failed'
                ? refusal(off ? 'device_code_off' : 'signin_failed', off
                  ? `${says(a.engine)} says device code sign-in is not turned on for this account or its workspace, in its words: ${view.detail}. Turn it on there, or paste a sign-in instead.`
                  : view.text, { state: 'failed', detail: view.detail })
                : view);
            }
          }
        }
      });
      child.on('close', (/** @type {number|null} */ status) => {
        if (attempt.over) return;
        const had = Boolean(attempt.code);
        if (attempt.stopped) end(attempt.stopped);
        else end('failed', { detail: had ? 'the sign-in container stopped before it said how the sign-in ended' : `the sign-in container stopped before it gave a code${complaint ? `: ${complaint}` : ` (exit ${status ?? 'unknown'})`}` });
        if (!had) answer(attempt.stopped ? this.#view(a.key, a.box) : refusal('signin_failed', this.#view(a.key, a.box).text, { state: 'failed', detail: this.#view(a.key, a.box).detail }));
      });
    });
  }

  /** @param {string} key @param {string} box */
  async #cancel(key, box) {
    const live = this.attempts.get(key);
    if (!live || live.over) {
      this.#lostIfOrphan(key);
      const view = this.#view(key, box);
      const [member, engine] = key.split('/');
      return { ...view, text: `No ${says(engine)} sign-in was waiting for ${member} on ${box}. ${view.text}` };
    }
    await this.#stop(live);
    return this.#view(key, box);
  }

  /**
   * Stop an attempt that is out, and wait until it is written down as over:
   * as cancelled when somebody asked, as lost when it is this hub going away.
   *
   * @param {Attempt} live @param {'cancelled'|'lost'} [as]
   */
  async #stop(live, as = 'cancelled') {
    live.stopped = live.stopped ?? as;
    // The signal reaches the runner through Podman, which tells the engine to
    // stop asking for a sign-in nobody is waiting on. Then, if it has not
    // gone, the container is removed.
    try {
      live.child?.kill?.('SIGTERM');
    } catch { /* gone already */ }
    /** @type {any} */
    let timer = null;
    const gone = await Promise.race([live.ended.then(() => true), new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), this.stopMs);
    })]);
    clearTimeout(timer);
    // REMOVED BY NAME EITHER WAY, and waited for, so that when this answers
    // nothing is running under the name: a container that said it stopped and
    // one that said nothing are both gone.
    await this.#remove(containerFor(live.member, live.engine));
    if (!gone) {
      try {
        live.child?.kill?.('SIGKILL');
      } catch { /* gone already */ }
      await live.ended;
    }
  }

  /** @param {{ key: string, member: string, engine: string, account: string, volume: string, by: string|null, box: string }} a */
  async #signout(a) {
    const refusal = (/** @type {string} */ code, /** @type {string} */ text) => ({ ok: false, error: { code }, member: a.member, engine: a.engine, text });
    if (this.signingOut.has(a.key)) return refusal('busy', `${says(a.engine)} is already being signed out for ${a.member} on ${a.box}.`);
    this.signingOut.add(a.key);
    try {
      const live = this.attempts.get(a.key);
      if (live && !live.over) await this.#stop(live);
      const ready = await this.#ready(a, a.box);
      if (!ready.ok) return ready;
      await this.#remove(containerFor(a.member, a.engine));
      const ran = await podmanAsync(this.cfg, this.#argv(a, '--signout', ready.route), { timeout: SIGNOUT_MS });
      /** @type {any} */
      let said = null;
      for (const text of ran.stdout.split('\n')) {
        try {
          const line = JSON.parse(text);
          if (line?.signin === 'done') said = line;
        } catch { /* not one of the runner's lines */ }
      }
      if (said?.state !== 'signed_out') {
        // Nothing is recorded: what this box knows of the sign-in is what it knew.
        log.warn(`engines: ${a.engine} was not signed out for ${a.member}`);
        return refusal('signout_failed', `${says(a.engine)} was not signed out for ${a.member} on ${a.box}: ${oneLine(said?.detail) ?? `the container that asks it ended with no answer (exit ${ran.status})`}. What ${a.box} knows of the sign-in is unchanged.`);
      }
      const at = this.now();
      this.#write(a.key, (e) => {
        e.signedIn = null;
        e.attempt = null;
        e.last = { state: 'signed_out', at, detail: null, by: a.by };
      });
      log.info(`engines: ${a.engine} signed out for ${a.member}, asked by ${a.by ?? 'nobody named'}`);
      return this.#view(a.key, a.box);
    } finally {
      this.signingOut.delete(a.key);
    }
  }

  // ── What the box itself notices, and what it reports ─────────────────────

  /**
   * A session of this member found the engine not signed in (TurnEnded with
   * reason `auth`, sessions.js). When this box was told of a sign-in for it,
   * that sign-in has ended, and is no longer reported.
   *
   * @param {unknown} member @param {unknown} engine
   * @returns {boolean} whether there was one to end
   */
  ended(member, engine) {
    const key = `${String(member ?? '')}/${String(engine ?? '')}`;
    if (!this.#read()?.[key]?.signedIn) return false;
    this.#write(key, (e) => {
      e.signedIn = null;
      e.last = { state: 'ended', at: this.now(), detail: null, by: null };
    });
    log.info(`engines: a session found ${key.split('/')[1]} no longer signed in for ${key.split('/')[0]}`);
    return true;
  }

  /**
   * What this box knows, for its own state (`/api/state`): for each member
   * and engine, how the last attempt ended and when, and since when it is
   * signed in. Member ids, engine names, states and times. No account, no
   * code, no page and nothing an engine said.
   *
   * NULL WHEN IT CANNOT TELL: a record this hub cannot read is not an empty
   * one, and the frame a sidecar builds from this then carries no list.
   *
   * @returns {Array<{ member: string, engine: string, state: string|null, at: number|null, since: number|null }>|null}
   */
  report() {
    const kept = this.#read();
    if (!kept) return null;
    return Object.values(kept)
      .filter((e) => e && MEMBER_ID_RE.test(String(e.member)) && SIGNIN_ENGINES.includes(String(e.engine)))
      .map((e) => ({ member: e.member, engine: e.engine, state: e.last?.state ?? null, at: e.last?.at ?? null, since: e.signedIn?.since ?? null }));
  }

  /**
   * End every attempt that is out, as this hub stops. Nobody cancelled them:
   * each is written down as lost, which is what its asker is then told, and
   * its container is ended now and not left asking a provider for a sign-in
   * this hub will not be there to hear of.
   */
  async close() {
    await Promise.all([...this.attempts.values()].map((live) => this.#stop(live, 'lost')));
  }
}

/** The container one member's sign-in to one engine runs in. A member's id is letters, digits and hyphens. */
export function containerFor(/** @type {string} */ member, /** @type {string} */ engine) {
  return `fw-signin-${engine}-${member}`;
}
