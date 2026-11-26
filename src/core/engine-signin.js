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
//               since when, who asked, a mark while an attempt is out, and
//               the name of the volume the sign-in is in, which is what a
//               removal finds it by.
//               No token, no code and no page.
//
// A FILE THAT CANNOT BE READ, OR DOES NOT READ AS ONE, IS CANNOT TELL. It is
// never nothing: a box that cannot say who is signed in does not say nobody
// is. And one that cannot be written ends the attempt that needed it, in
// words, and leaves nothing waiting on it.
//
// THE PAGE AND THE CODE ARE NOT SECRETS, AND THEY ARE NOBODY ELSE'S. They go
// back in the answer to whoever asked, and into no file, no log line and
// nothing this box reports. A log line here names a member, an engine and a
// state, and nothing the engine or the runner said.
//
// ONE ATTEMPT A MEMBER AND ENGINE AT A TIME. A second start while one waits
// is answered with the one in flight.
//
// THE PAGE IS THE PROVIDER'S OWN, OR THE CODE GOES TO NOBODY. What a person
// is sent to open is checked here against the one page each engine's
// sign-in is made at (SIGNIN_PAGES), whatever the runner or the engine in
// the container said. That container reads a volume the member's sessions
// write, so what it prints is not this box's word until this box has held it
// to something it knows.
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

/**
 * The one page each engine's code is entered at, and whose it is in words.
 *
 * EXACTLY THESE, AND NOTHING THAT ONLY LOOKS LIKE THEM. A code typed at
 * another page signs somebody else in, or signs this person in to something
 * else: an attempt whose engine names another page is stopped and its code
 * is given to nobody (#run).
 *
 *   codex     the page Codex builds from its own issuer:
 *             `{issuer}/codex/device`, where the issuer is
 *             `https://auth.openai.com` unless the app server's environment
 *             says otherwise, which a sign-in's container never does
 *             (codex-rs/login/src/server.rs DEFAULT_ISSUER,
 *             login/src/device_code_auth.rs request_device_code, at
 *             rust-v0.171.0)
 *   opencode  GitHub's own `verification_uri` for a device code asked of
 *             github.com, which OpenCode passes on as it was given
 *             (packages/opencode/src/plugin/github-copilot/copilot.ts at
 *             v1.19.6). The address is GitHub's and is not in OpenCode's
 *             source: it is the one GitHub documents for its device flow.
 *             A GitHub Enterprise deployment has another, and is not signed
 *             in here (the runner asks for github.com).
 *
 * An engine that moves its page is refused here until this says the new one,
 * which is the cost of the check and is said in the refusal.
 */
export const SIGNIN_PAGES = Object.freeze({
  codex: Object.freeze({ page: 'https://auth.openai.com/codex/device', at: 'OpenAI' }),
  opencode: Object.freeze({ page: 'https://github.com/login/device', at: 'GitHub' }),
});

const says = (/** @type {string} */ engine) => ENGINES[/** @type {keyof typeof ENGINES} */ (engine)]?.says ?? engine;
/** One printable line, bounded: the runner's `detail` is the engine's own words. */
const oneLine = (/** @type {unknown} */ v, max = 200) => (typeof v === 'string' ? v.split('\n')[0].replace(/[^\x20-\x7e]/g, '').trim().slice(0, max) : '') || null;
const when = (/** @type {number} */ at) => `${new Date(at).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
/** Somebody else's sentence, to go inside one of ours: without the full stop it ended on, so ours does not end on two. */
const inside = (/** @type {unknown} */ words) => String(words ?? '').replace(/[.\s]+$/, '');
/** A promise that settles as `value` after `ms`, and the way to stop waiting on it. @param {number} ms @param {unknown} value */
function after(ms, value) {
  /** @type {any} */
  let timer = null;
  const done = new Promise((resolve) => {
    timer = setTimeout(() => resolve(value), ms);
  });
  return { done, clear: () => clearTimeout(timer) };
}

/**
 * @typedef {{ email: string|null, plan: string|null }} Who  the account, as the engine itself says
 * @typedef {{ since: number, who: Who|null, by: string|null }} SignedIn
 * @typedef {{ state: string, at: number, detail: string|null, by: string|null }} Last
 * @typedef {{ member: string, engine: string, volume?: string, signedIn: SignedIn|null, last: Last|null, attempt: { startedAt: number, by: string|null }|null }} Entry
 *   `volume` is the engine home the sign-in is in; an entry written before it was kept has none
 * @typedef {{ key: string, member: string, engine: string, volume: string, by: string|null, box: string, startedAt: number, expiresAt: number,
 *   url: string|null, code: string|null, child: any, stopped: 'cancelled'|'lost'|'removed'|null, over: boolean,
 *   first: Promise<Record<string, any>>, ended: Promise<void>, end: (state: string) => void, timers: any[] }} Attempt
 *   `end` writes down how it ended and lets go of everything it held, whatever state it is in (#run)
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
    /** The removal of each container's name that is under way, so the next one waits for it (#remove). @type {Map<string, Promise<void>>} */
    this.removing = new Map();
    /**
     * What happened and could not be written down, by member and engine, to
     * be written the next time anything here is asked (#settle). Memory only:
     * a hub that stops with one of these has lost it, and the mark the file
     * still holds then says so (`lost`).
     *
     * @type {Map<string, (entry: Entry) => void>}
     */
    this.owed = new Map();
    /** Whether the file has been said not to read as one. Once a process, not once a read: the state is asked for every few seconds. */
    this.saidUnreadable = false;
  }

  // ── What is kept on disk ──────────────────────────────────────────────────

  /** Where it is kept. Asked each time, and not at construction: a state directory that cannot be named must not stop a hub coming up. */
  get file() {
    return path.join(String(this.cfg.stateDir), 'engine-signins.json');
  }

  /**
   * Everything kept, or NULL WHEN IT CANNOT BE TOLD, which is never nothing:
   * a box that cannot read what it was told must not say nobody is signed
   * in. No file yet is nothing kept.
   *
   * A FILE THAT IS NOT WHAT THIS WRITES IS CANNOT TELL TOO. It used to read
   * as nothing kept, so a file cut short was reported as an empty list, and
   * an empty list is this box saying nobody is signed in here: the one thing
   * it did not know. The log line that says so was written on every read,
   * and the state is read every few seconds; it is said once a process.
   *
   * Nothing here repairs such a file or writes over it (#write): what it held
   * may be readable by a person, and is not this code's to throw away.
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
    if (!this.saidUnreadable) {
      this.saidUnreadable = true;
      log.warn(`engines: ${this.file} does not read as this machine’s record of engine sign-ins, so who is signed in here cannot be told and no sign-in is begun until somebody moves it aside`);
    }
    return null;
  }

  /**
   * Entries changed and written, all in one file. Beside the file and moved
   * into place, so a reader never meets half of it.
   *
   * THROWS when the record cannot be read, or the file cannot be written.
   * Every caller says what it does then: none may be left holding an attempt
   * nothing will end (#run), and none writes over a record it could not read.
   *
   * @param {(all: Record<string, Entry>) => void} change
   */
  #writeAll(change) {
    const all = this.#read();
    if (!all) throw new Error('the record of engine sign-ins cannot be read, so it was not written over');
    change(all);
    mkdirSync(path.dirname(this.file), { recursive: true });
    const next = `${this.file}.${process.pid}`;
    writeFileSync(next, `${JSON.stringify({ v: 1, signins: all }, null, 2)}\n`, { mode: 0o600 });
    renameSync(next, this.file);
  }

  /** One entry, changed and written (#writeAll). `volume` is the engine home it is about, when the caller knows it. */
  #write(/** @type {string} */ key, /** @type {(entry: Entry) => void} */ change, /** @type {string|null} */ volume = null) {
    this.#writeAll((all) => {
      const [member, engine] = key.split('/');
      const entry = all[key] ?? { member, engine, signedIn: null, last: null, attempt: null };
      if (volume) entry.volume = volume;
      change(entry);
      all[key] = entry;
    });
  }

  /**
   * Write an entry, or OWE IT when the file cannot be written: what happened
   * is kept in memory and written the next time anything is asked (#settle).
   * Never throws. For what has already happened and must not be lost to a
   * full disk: how an attempt ended, a sign out the engine made, a sign-in a
   * session found ended.
   *
   * @param {string} key @param {(entry: Entry) => void} change @param {string|null} [volume]
   * @returns {boolean} whether it is on disk now
   */
  #record(key, change, volume = null) {
    const before = this.owed.get(key);
    const both = before ? (/** @type {Entry} */ e) => (before(e), change(e)) : change;
    try {
      this.#write(key, both, volume);
      this.owed.delete(key);
      return true;
    } catch (e) {
      this.owed.set(key, both);
      log.warn(`engines: what became of the ${key.split('/')[1]} sign-in for ${key.split('/')[0]} could not be written down, and is kept in memory until it can be: ${oneLine(/** @type {Error} */ (e).message) ?? 'no reason given'}`);
      return false;
    }
  }

  /** Write down whatever is owed (#record), now that it may be possible. Never throws. */
  #settle() {
    for (const [key, change] of [...this.owed]) {
      try {
        this.#write(key, change);
        this.owed.delete(key);
      } catch { /* still not possible: asked again the next time */ }
    }
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
   * WHICH WORDS. `sealed` is the sidecar saying the page, the code and the
   * account will go to whoever asked sealed, and in the clear not at all
   * (sidecar.js, #signAnswer). The answer's sentence then spells none of
   * them. The fields still come back whole: they are what gets sealed, and
   * this is the box's own loopback.
   *
   * @param {{ member?: unknown, account?: unknown, engine?: unknown, action?: unknown, by?: unknown, box?: unknown, sealed?: unknown }} ask
   * @returns {Promise<Record<string, any>>}
   */
  async ask(ask) {
    const { quietText, ...said } = await this.#answer(ask);
    return ask?.sealed === true && typeof quietText === 'string' ? { ...said, text: quietText } : said;
  }

  /**
   * The answer, said both ways where the two differ: `text`, and `quietText`
   * with no page, code or account in it (ask picks one and drops the other).
   *
   * @param {{ member?: unknown, account?: unknown, engine?: unknown, action?: unknown, by?: unknown, box?: unknown }} ask
   * @returns {Promise<Record<string, any>>}
   */
  async #answer(ask) {
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
    // What happened while the record could not be written, now that it may be (#record).
    this.#settle();
    // WHAT THIS BOX KNOWS CANNOT BE READ: it cannot say where a sign-in
    // stands, and it does not begin one it could not write down. That is a
    // file it cannot open, and one that opens and is not a record.
    if (this.#read() === null) {
      return {
        ok: false, error: { code: 'state_unreadable' }, member, engine,
        text: `${box} cannot read its own record of engine sign-ins, so it cannot say where this one stands or begin another. Whoever runs ${box} looks at engine-signins.json in its state directory: moved aside, the record starts again, and a sign-in made before is not known here until it is made again.`,
      };
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
    const entry = this.#entry(key);
    const signedIn = entry?.signedIn ? { since: entry.signedIn.since, who: entry.signedIn.who ?? null } : null;
    // The account, in words, and the same sentence without it (ask).
    const named = signedIn?.who?.email ? ` as ${signedIn.who.email}` : '';
    const live = this.attempts.get(key);
    if (live && live.code && !live.over) {
      const left = Math.max(1, Math.ceil((live.expiresAt - this.now()) / 60_000));
      const lasts = `about ${left} more minute${left === 1 ? '' : 's'}`;
      const stays = (/** @type {string} */ as) => (signedIn ? ` Until it is approved, ${says(engine)} stays signed in${as} there.` : '');
      return {
        ok: true, state: 'waiting', member, engine, url: live.url, code: live.code,
        startedAt: live.startedAt, expiresAt: live.expiresAt, expiresInMinutes: left, signedIn, ...extra,
        text: `Open ${live.url} and enter ${live.code} to sign ${says(engine)} in for ${member} on ${box}. The code lasts ${lasts}.${stays(named)}`,
        quietText: `A code is out to sign ${says(engine)} in for ${member} on ${box}, and lasts ${lasts}. It and its page are sealed to whoever asked.${stays('')}`,
      };
    }
    const last = entry?.last ?? null;
    const state = last?.state ?? 'none';
    const sentence = (/** @type {string} */ as) => {
      // A new attempt that did not complete replaces nothing: say so, where it is true.
      const still = signedIn && state !== 'signed_in' ? ` ${says(engine)} is still signed in${as} there, since ${when(signedIn.since)}.` : '';
      const words = {
        none: `${box} knows of no ${says(engine)} sign-in for ${member}.`,
        signed_in: `${says(engine)} is signed in for ${member} on ${box}${as}, since ${when(signedIn?.since ?? last?.at ?? 0)}.`,
        expired: `The code ran out before anybody approved it, so ${says(engine)} was not signed in for ${member} on ${box}. Start again for a new code.`,
        failed: `${says(engine)} was not signed in for ${member} on ${box}: ${inside(last?.detail ?? 'the engine gave no reason')}.`,
        cancelled: `The ${says(engine)} sign-in for ${member} on ${box} was cancelled.`,
        lost: `${box} restarted while a ${says(engine)} sign-in for ${member} was waiting, so that attempt is gone. Start again for a new code.`,
        signed_out: `${says(engine)} is signed out for ${member} on ${box}.`,
        ended: `${says(engine)} said its sign-in for ${member} on ${box} no longer works. Sign it in again.`,
      };
      return `${words[/** @type {keyof typeof words} */ (state)] ?? words.none}${still}`;
    };
    return {
      ok: true, state, member, engine,
      ...(last ? { at: last.at } : {}),
      ...(state === 'failed' ? { detail: last?.detail ?? null } : {}),
      signedIn, ...extra,
      text: sentence(named), quietText: sentence(''),
    };
  }

  /**
   * One entry as it stands: what the file holds, with whatever happened
   * since and could not be written (#record) laid over it, so an answer is
   * true while the disk is not.
   *
   * @param {string} key
   * @returns {Entry|null}
   */
  #entry(key) {
    const kept = this.#read()?.[key] ?? null;
    const owed = this.owed.get(key);
    if (!owed) return kept;
    const [member, engine] = key.split('/');
    const entry = /** @type {Entry} */ (structuredClone(kept ?? { member, engine, signedIn: null, last: null, attempt: null }));
    owed(entry);
    return entry;
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
    // One this process held, whose ending is owed to the file (#record), is
    // not one a restart lost: its mark is still on disk only because the
    // ending could not be written.
    if (this.attempts.has(key) || this.owed.has(key)) return;
    const entry = this.#read()?.[key];
    if (!entry?.attempt) return;
    try {
      this.#write(key, (e) => {
        e.last = { state: 'lost', at: this.now(), detail: null, by: e.attempt?.by ?? null };
        e.attempt = null;
      });
    } catch {
      // Not written, so not said: it is found again the next time anybody asks.
      return;
    }
    log.warn(`engines: the ${entry.engine} sign-in that was waiting for ${entry.member} did not outlive a restart of this hub, and is recorded as lost`);
    void this.#remove(containerFor(entry.member, entry.engine));
  }

  /** Every attempt a restart left behind, found as this hub comes up. */
  recover() {
    for (const key of Object.keys(this.#read() ?? {})) this.#lostIfOrphan(key);
  }

  /**
   * Remove a sign-in's container, whatever state it is in. Never throws.
   *
   * ONE AT A TIME FOR ONE NAME. An attempt's container and the next
   * attempt's run under the same name, and the removal that follows an
   * attempt is not waited for by whoever is told how it ended. Left to race,
   * a slow one found the next attempt's container under the name and removed
   * that: a start answered with a code, and failed a moment later for no
   * reason anybody could see. So each removal of a name waits for the one
   * before it, and a new attempt, which removes before it runs, starts only
   * once every earlier removal is done.
   *
   * @param {string} container
   * @returns {Promise<void>}
   */
  #remove(container) {
    const before = this.removing.get(container) ?? Promise.resolve();
    const done = before.then(async () => {
      try {
        await podmanAsync(this.cfg, ['rm', '-f', container], { timeout: 20_000 });
      } catch { /* gone already, or no podman: either way there is nothing running under that name */ }
    });
    this.removing.set(container, done);
    void done.then(() => {
      if (this.removing.get(container) === done) this.removing.delete(container);
    });
    return done;
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
      key: a.key, member: a.member, engine: a.engine, volume: a.volume, by: a.by, box: a.box, startedAt, expiresAt: startedAt + this.capMs,
      url: null, code: null, child: null, stopped: null, over: false,
      first: /** @type {any} */ (null), ended: /** @type {any} */ (null), end: () => {}, timers: [],
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
    /**
     * How it ended, written down once, and the attempt forgotten.
     *
     * NEVER THROWS, AND ALWAYS LETS GO. The write was not guarded, so a disk
     * that was full when an attempt ended left its container running and
     * `ended` unsettled, and everything that waits on that (a cancel, a sign
     * out, this hub stopping) waited for ever. What happened is now kept in
     * memory until it can be written (#record), and the rest runs whatever
     * became of the write.
     *
     * `removed` is whoever it was for being forgotten here: its entry is
     * dropped by what removes it, so nothing is written of how it ended.
     *
     * @param {string} state @param {{ detail?: string|null, who?: Who|null }} [said]
     */
    const end = (state, said = {}) => {
      if (attempt.over) return;
      attempt.over = true;
      for (const t of attempt.timers) clearTimeout(t);
      if (this.attempts.get(a.key) === attempt) this.attempts.delete(a.key);
      const at = this.now();
      if (state !== 'removed') {
        this.#record(a.key, (e) => {
          e.last = { state, at, detail: state === 'failed' ? (said.detail ?? null) : null, by: a.by };
          e.attempt = null;
          if (state === 'signed_in') e.signedIn = { since: at, who: said.who ?? null, by: a.by };
        }, a.volume);
      }
      // A member, an engine and a state: nothing the engine said.
      log.info(`engines: ${a.engine} sign-in for ${a.member}, asked by ${a.by ?? 'nobody named'}: ${state}`);
      try {
        attempt.child?.kill?.('SIGTERM');
      } catch { /* gone already */ }
      void this.#remove(containerFor(a.member, a.engine));
      finished();
    };
    attempt.end = end;
    const refusal = (/** @type {string} */ code, /** @type {string} */ text, /** @type {Record<string, any>} */ extra = {}) => ({ ok: false, error: { code }, member: a.member, engine: a.engine, ...extra, text });
    /** A refusal in the words of where the sign-in now stands, said both ways as a view is (#view). @param {string} code @param {Record<string, any>} view @param {string} [more] @param {Record<string, any>} [extra] */
    const refused = (code, view, more = '', extra = {}) => ({ ...refusal(code, `${view.text}${more}`, { state: 'failed', ...extra }), quietText: `${view.quietText}${more}` });
    /** Nothing was run, so nothing ended: the attempt is let go of, and the last attempt's word stands. */
    const neverBegan = () => {
      attempt.over = true;
      if (this.attempts.get(a.key) === attempt) this.attempts.delete(a.key);
      finished();
    };

    const ready = await this.#ready(a, a.box);
    // GIVEN UP ON WHILE THAT WAS ASKED (#stop, which does not wait for ever):
    // it is written down as over already, and must not go on to run.
    if (attempt.over) return this.#view(a.key, a.box);
    if (!ready.ok) {
      neverBegan();
      return ready;
    }
    // A MARK THAT AN ATTEMPT IS OUT, so a hub that restarts under it knows
    // one was, and says it is gone (#lostIfOrphan).
    //
    // NOT WRITTEN IS NOT BEGUN. This write was not guarded either, and it is
    // made with the attempt already in the map: a disk that was full for one
    // moment left an attempt there that nothing would ever end, and every
    // start and status for that member and engine failed until the hub was
    // restarted, long after the disk was fine.
    try {
      this.#write(a.key, (e) => {
        e.attempt = { startedAt: attempt.startedAt, by: a.by };
      }, a.volume);
    } catch (e) {
      neverBegan();
      log.warn(`engines: ${a.engine} sign-in for ${a.member} was not begun, because this machine could not write down that one was: ${oneLine(/** @type {Error} */ (e).message) ?? 'no reason given'}`);
      return refusal('state_unwritable', `${a.box} could not write to its own record of engine sign-ins (${oneLine(/** @type {any} */ (e)?.code, 20) ?? 'no reason given'}), so it began no ${says(a.engine)} sign-in for ${a.member} and nothing is waiting. Whoever runs ${a.box} looks at its state directory and the room on its disk. Then start again.`);
    }
    // Whatever an attempt this hub lost track of left under the name.
    await this.#remove(containerFor(a.member, a.engine));
    if (attempt.over) return this.#view(a.key, a.box);
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
        return answer(refused('signin_failed', this.#view(a.key, a.box)));
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
        answer(refused('no_code', this.#view(a.key, a.box), ' Nothing is waiting; start again.'));
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
            const own = SIGNIN_PAGES[/** @type {keyof typeof SIGNIN_PAGES} */ (a.engine)];
            // A FIRST LINE THAT IS NOT A PAGE AND A CODE ENDS THE ATTEMPT, IN
            // WORDS. It was skipped without a word, and the start then waited
            // out its 45 seconds and said the engine gave no code. The engine
            // had: the runner took a piece of the page for a secret and cut
            // it out, on every machine whose engine home already held a Codex
            // sign-in, so nobody there could be signed in a second time and
            // the refusal sent them to look at the wrong thing. What this box
            // could not read is its own fault or its runner's, and it says
            // which half it could not read. Neither half is repeated: what
            // was given is not known to be anybody's page.
            const unread = !url || !/^https:\/\/[^\s]+$/.test(url)
              ? 'what it was given as the page does not begin https://'
              : !code || !/^[A-Za-z0-9-]{4,40}$/.test(code)
                ? 'what it was given as the code is not letters, digits and hyphens'
                : null;
            if (unread) {
              log.warn(`engines: ${a.engine} sign-in for ${a.member}: the runner’s first line did not read as a page and a code (${unread}), so the attempt was ended`);
              end('failed', { detail: `${a.box} could not read the page and the code ${says(a.engine)} gave it (${unread})` });
              answer(refused('unreadable_code', this.#view(a.key, a.box), ` Nothing is waiting. That is a fault in fleetwright on ${a.box} and not at ${own.at}: update fleetwright on ${a.box} and start again, or paste a sign-in instead.`));
              continue;
            }
            // THE PAGE IS THE PROVIDER'S OWN, OR THE CODE GOES TO NOBODY
            // (SIGNIN_PAGES). Any https page was passed on as this machine's
            // word, signed by the sidecar and opened from a phone. The engine
            // that names the page runs on the member's engine home, which
            // that member's sessions write; OpenCode loads settings and
            // plugins named there, and a plugin can answer for the sign-in.
            // So a session could choose the page and the code a custodian was
            // sent, under this box's name. The attempt is ended before
            // anybody is answered with either.
            if (url !== own.page) {
              log.warn(`engines: ${a.engine} sign-in for ${a.member}: the page it named is not ${own.at}’s own, so the attempt was ended and its code given to nobody`);
              end('failed', { detail: `its sign-in named a page that is not ${own.at}’s own, so ${a.box} stopped it and gave nobody the code` });
              answer(refused('wrong_page', this.#view(a.key, a.box), ` Nothing is waiting. Whoever runs ${a.box} looks at what its session image runs as ${says(a.engine)} and at what is in ${a.member}’s engine home there (${a.volume}), before anybody starts again.`));
              continue;
            }
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
              answer(view.state !== 'failed'
                ? view
                : off
                  ? refusal('device_code_off', `${says(a.engine)} says device code sign-in is not turned on for this account or its workspace, in its words: ${inside(view.detail)}. Turn it on there, or paste a sign-in instead.`, { state: 'failed', detail: view.detail })
                  : refused('signin_failed', view, '', { detail: view.detail }));
            }
          }
        }
      });
      child.on('close', (/** @type {number|null} */ status) => {
        if (attempt.over) return;
        const had = Boolean(attempt.code);
        if (attempt.stopped) end(attempt.stopped);
        else end('failed', { detail: had ? 'the sign-in container stopped before it said how the sign-in ended' : `the sign-in container stopped before it gave a code${complaint ? `: ${complaint}` : ` (exit ${status ?? 'unknown'})`}` });
        if (!had) {
          const view = this.#view(a.key, a.box);
          answer(attempt.stopped ? view : refused('signin_failed', view, '', { detail: view.detail }));
        }
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
      const none = `No ${says(engine)} sign-in was waiting for ${member} on ${box}. `;
      return { ...view, text: `${none}${view.text}`, quietText: `${none}${view.quietText}` };
    }
    await this.#stop(live);
    return this.#view(key, box);
  }

  /**
   * Stop an attempt that is out, and wait until it is written down as over:
   * as cancelled when somebody asked, as lost when it is this hub going away.
   *
   * IT DOES NOT WAIT FOR EVER. After the removal it waited on the attempt
   * with no bound, and an attempt that had not yet run anything (still
   * asking for its way out), or whose process never reported its end, held a
   * cancel, a sign out and this hub's own stop open for good: systemd then
   * killed a hub that could not exit. Nothing runs under the name once it is
   * removed, so an attempt that has not ended a little after that is ended
   * here, by what ends one (#run, `end`).
   *
   * @param {Attempt} live @param {'cancelled'|'lost'|'removed'} [as]
   */
  async #stop(live, as = 'cancelled') {
    live.stopped = live.stopped ?? as;
    // The signal reaches the runner through Podman, which tells the engine to
    // stop asking for a sign-in nobody is waiting on. Then, if it has not
    // gone, the container is removed.
    try {
      live.child?.kill?.('SIGTERM');
    } catch { /* gone already */ }
    const soon = after(this.stopMs, false);
    const gone = await Promise.race([live.ended.then(() => true), soon.done]);
    soon.clear();
    // REMOVED BY NAME EITHER WAY, and waited for, so that when this answers
    // nothing is running under the name: a container that said it stopped and
    // one that said nothing are both gone.
    await this.#remove(containerFor(live.member, live.engine));
    if (gone) return;
    try {
      live.child?.kill?.('SIGKILL');
    } catch { /* gone already */ }
    const last = after(this.stopMs, false);
    const ended = await Promise.race([live.ended.then(() => true), last.done]);
    last.clear();
    if (!ended) live.end(live.stopped);
  }

  /** @param {{ key: string, member: string, engine: string, account: string, volume: string, by: string|null, box: string }} a */
  async #signout(a) {
    const refusal = (/** @type {string} */ code, /** @type {string} */ text) => ({ ok: false, error: { code }, member: a.member, engine: a.engine, text });
    if (this.signingOut.has(a.key)) return refusal('busy', `${says(a.engine)} is already being signed out for ${a.member} on ${a.box}, so this asked for nothing more. Ask where it stands in a moment.`);
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
      // The engine has signed out whether or not this can be written: kept
      // in memory until it can (#record), and the answer below is true either way.
      this.#record(a.key, (e) => {
        e.signedIn = null;
        e.attempt = null;
        e.last = { state: 'signed_out', at, detail: null, by: a.by };
      }, a.volume);
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
    if (!this.#entry(key)?.signedIn) return false;
    // Never thrown into the session's event that told it (sessions.js): a
    // record that cannot be written is owed, not a reason to drop the event.
    const at = this.now();
    this.#record(key, (e) => {
      e.signedIn = null;
      e.last = { state: 'ended', at, detail: null, by: null };
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
   * NULL WHEN IT CANNOT TELL: a record this hub cannot read, or one that does
   * not read as a record, is not an empty one, and the frame a sidecar builds
   * from this then carries no list.
   *
   * @returns {Array<{ member: string, engine: string, state: string|null, at: number|null, since: number|null }>|null}
   */
  report() {
    this.#settle();
    const kept = this.#read();
    if (!kept) return null;
    // What is on disk, and what happened since that could not be put there.
    return [...new Set([...Object.keys(kept), ...this.owed.keys()])]
      .map((key) => /** @type {Entry} */ (this.#entry(key)))
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
