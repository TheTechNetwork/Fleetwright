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
//
// AN ENDING THIS BOX DID NOT HEAR FROM THE RUNNER IS NOT "NOT SIGNED IN". A
// hub that restarted under a code, a container that died after one was out,
// a code this box's own clock ended: the code may have been approved, and
// the sign-in may be in the home. So the box asks, with a short container
// that looks in the home and starts no engine (#ask), and records what it
// learns. Until it has asked it says it cannot tell (`cannot_tell`).
//
// AND WHAT IS IN THE HOME IS NOT, BY ITSELF, WHAT THE ATTEMPT MADE. A
// member's sessions write that home. So each attempt is given a word of its
// own, made here and handed to its sign-in container and to nothing else,
// which the runner leaves beside a sign-in only once the engine has said
// the code was approved. Asked afterwards, a home that does not hold this
// attempt's word did not get its sign-in from this attempt, whatever file
// is in it and whenever that was written (#ask).
//   on disk     `engine-signins.json` in the state directory: for each member
//               and engine, how the last attempt ended, who is signed in and
//               since when, who asked, a mark while an attempt is out with
//               that attempt's word, and the name of the volume the sign-in
//               is in, which is what a removal finds it by (forget,
//               keepMembers).
//               No token, no code and no page. An attempt's word is none of
//               those: it opens nothing, and is in no answer and no report.
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
// the container said. The runner holds the engine to the same pages and
// starts it on an empty home of its own (sandbox/engine.mjs); this is the
// second check, and it does not rest on the runner in the image being the
// one this release shipped. What a container prints is not this box's word
// until this box has held it to something it knows.
//
// NOT RUN ON A BOX. Everything here is driven in tests through a script that
// stands in for Podman and runs the real runner (test/engine-signin-hub.test.js).
// That rootless Podman mounts the volume as written, forwards the signal a
// cancel sends, and removes the container when it ends is read from its
// documentation and has not been seen. Nor has what it answers when asked
// whether a volume exists, to list them, or to remove one (#forgetHome,
// keepMembers): a test's own script answers there, as the documentation
// says Podman does.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { log } from '../log.js';
import { ENGINES, SIGNIN_ENGINES } from '../fleet/protocol/engines.js';
import { MEMBER_ID_RE, accountOfMember, memberOfAccount } from '../fleet/protocol/members.js';
import { normaliseEmail } from './accounts.js';
import { boxEngines } from './engine-box.js';
import { ENGINE_HOME, engineHomeVolume, memberOfEngineHome } from './engine-home.js';
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
/** How long the container that looks in a home for a sign-in may take (#ask). It starts no engine. */
const ASK_MS = 30_000;

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
/**
 * Somebody else's words, to go inside a sentence of ours: without the full
 * stop they ended on, so ours does not end on two.
 *
 * A DETAIL IS A CLAUSE WITH NO SUBJECT AND NO FULL STOP, the runner's and
 * this file's own alike (sandbox/engine.mjs, "Signing in on the machine"):
 * the machine says "Codex was not signed in for debbie on ops-box: " before
 * it and a phone "Codex did not sign in: ", and each puts the full stop
 * after. An engine's own words are passed on as they are, and may end on
 * one, which is what this is for.
 */
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
 * @typedef {{ member: string, engine: string, volume?: string, signedIn: SignedIn|null, last: Last|null, attempt: { startedAt: number, by: string|null, word?: string }|null,
 *   unheard?: { startedAt: number, word?: string } }} Entry
 *   `volume` is the engine home the sign-in is in; an entry written before it was kept has none.
 *   `unheard` is an attempt, begun then, whose ending the runner did not say and the home has not yet been asked about (#ask)
 *   `word` is the attempt's own, which a sign-in it made has beside it (#ask); a mark written before attempts had one has none
 * @typedef {{ key: string, member: string, engine: string, volume: string, by: string|null, box: string, startedAt: number, expiresAt: number, word: string,
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
   * @param {{ now?: () => number, capMs?: number, codeMs?: number, graceMs?: number, stopMs?: number, askMs?: number }} [opts]  the waits, for a test that cannot take fifteen minutes
   */
  constructor(cfg, { now = Date.now, capMs = SIGNIN_MINUTES * 60_000, codeMs = CODE_MS, graceMs = GRACE_MS, stopMs = STOP_MS, askMs = ASK_MS } = {}) {
    this.cfg = cfg;
    this.now = now;
    this.capMs = capMs;
    this.codeMs = codeMs;
    this.graceMs = graceMs;
    this.stopMs = stopMs;
    this.askMs = askMs;
    /** The homes being asked about right now, by member and engine: one asking each, and whoever needs the answer waits on it (#ask). @type {Map<string, Promise<void>>} */
    this.asking = new Map();
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
    // Before anything is asked of it: a code this box's clock says is over
    // is ended here, so that what follows waits for the home's answer (#overdue).
    this.#overdue(key);
    if (action === 'start') return this.#start({ key, member, engine, account, volume, by, box });
    if (action === 'cancel') return this.#cancel(key, box, volume);
    if (action === 'signout') return this.#signout({ key, member, engine, account, volume, by, box });
    return this.#status(key, box, volume);
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
    // Never "waiting" for a code that is over, whoever is asking and by what road.
    this.#overdue(key);
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
    // NOT HEARD, AND NOT YET ASKED: this box cannot say how the last attempt
    // ended, so it says that, as a refusal with what to do, and gives no
    // state for a screen to put its own words to. A phone words `expired` as
    // "the code ran out", which is exactly what is not known here.
    if (entry?.unheard) {
      const how = { lost: 'it restarted while the code was out', expired: 'its own clock ended the code', failed: 'the container stopped without saying', cancelled: 'it was stopped as it was ending' };
      const why = how[/** @type {keyof typeof how} */ (entry.last?.state ?? '')] ?? 'the container stopped without saying';
      const text = `${box} did not hear how the last ${says(engine)} sign-in for ${member} ended (${why}), and has not been able to ask whether the code was approved first. So it cannot tell whether ${says(engine)} is signed in for ${member} there. Ask again in a moment, and it looks again.`;
      return { ok: false, error: { code: 'cannot_tell' }, member, engine, ...extra, text, quietText: text };
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
   * End an attempt whose code is over by this box's clock, though no timer
   * of its own has said so yet.
   *
   * A CODE ENDS BY THE CLOCK ON THE WALL, AND A TIMER DOES NOT COUNT TIME
   * THIS MACHINE WAS NOT RUNNING. The attempt was ended by a timer set when
   * it began (#run) and by nothing else. A box that was suspended for an
   * hour with a code out woke with the timer still fourteen minutes from
   * firing, and went on answering "waiting, about 1 more minute" for a code
   * the provider had ended long before, with a page to open and a code to
   * type that could sign nobody in. So whenever it is asked, the clock is
   * looked at: past the code's life and the little more the runner is given
   * to say so itself (GRACE_MS), the attempt is ended as expired, by what
   * ends one (#run, `end`). That is an ending this box decided with a code
   * out, so the home is asked what became of it, as for the timer's.
   *
   * @param {string} key
   */
  #overdue(key) {
    const live = this.attempts.get(key);
    if (live && live.code && !live.over && this.now() > live.expiresAt + this.graceMs) live.end('expired');
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

  /** @param {string} key @param {string} box @param {string|null} [volume]  the member's engine home, as whoever asked named it */
  async #status(key, box, volume = null) {
    const live = this.attempts.get(key);
    // An attempt that has not given its code yet is about to: its start's own
    // answer is this one's too.
    if (live && !live.code && !live.over) await live.first;
    await this.#heard(key, volume);
    return this.#view(key, box);
  }

  /**
   * Make sure this box has heard how the last attempt ended, or has asked:
   * for an attempt a restart left behind, and for one whose ending was not
   * said and could not be asked about at the time. Waits for an asking that
   * is under way. Does nothing while an attempt is out, and nothing for one
   * that ended in the runner's own words.
   *
   * @param {string} key
   * @param {string|null} [volume]  the engine home, when whoever asked named it; else the one the entry keeps
   */
  async #heard(key, volume = null) {
    if (this.attempts.has(key)) return;
    const under = this.asking.get(key);
    if (under) return under;
    const entry = this.#entry(key);
    if (!entry) return;
    // One this process held, whose ending is owed to the file (#record), is
    // not one a restart lost: its mark is still on disk only because the
    // ending could not be written.
    const orphan = Boolean(entry.attempt) && !this.owed.has(key);
    if (!orphan && !entry.unheard) return;
    const begun = orphan ? entry.attempt : entry.unheard;
    return this.#ask(key, { member: entry.member, engine: entry.engine, volume: volume ?? homeOf(entry), startedAt: Number(begun?.startedAt), word: typeof begun?.word === 'string' ? begun.word : null, orphan });
  }

  /**
   * Ask a member's engine home whether it holds a sign-in made on this
   * machine, and write down what is learned.
   *
   * WHEN: this box did not hear from the runner how an attempt ended, and a
   * code was out, so it may have been approved.
   *
   *  - the hub restarted under it (`orphan`): the file says an attempt is
   *    out and this process holds none. It was written down as lost at once
   *    and the container removed, "so that what nobody could see does not go
   *    on to sign in". But a container outlives the hub that started it
   *    (KillMode=process), and a code approved while the hub was down had
   *    already signed the member in: the box then said the attempt was gone
   *    and reported nobody, with the member's sessions running on the
   *    sign-in and no screen offering to sign it out;
   *  - the container stopped, or was removed, after the code was out and
   *    before the runner's second line: a cancel that lost a race with the
   *    approval, a container killed as it finished, this box's own clock
   *    ending a code at its last moment (#run, `end`).
   *
   * HOW: the attempt's container is removed first, so nothing is still
   * writing, then a short container from the session image looks in the
   * home (`fleetwright-engine --signedin`, sandbox/engine.mjs). It starts no
   * engine and has no network. It says whether a sign-in the engine would
   * start on is there, whether that is the box's copy of a pasted one, when
   * the file was last written, and the attempt's word it found beside it.
   *
   * WHAT IS RECORDED, once it has answered:
   *  - a sign-in made here with THIS attempt's word beside it: the attempt
   *    signed in. `signed_in`, since when it was written. WHO is not known:
   *    the engine was not asked, and the account the record had is no longer
   *    this sign-in's, so it is not said;
   *  - a sign-in with another word beside it, or none: the attempt changed
   *    nothing, and the record of who is signed in stands exactly as it
   *    was, somebody or nobody;
   *  - none, or only a pasted copy: nobody is signed in on this machine, and
   *    the record stops saying somebody is.
   * UNTIL THEN, AND WHEN IT CANNOT ASK (no Podman, no image, no home it can
   * name, a container that would not run, a home the runner could not
   * read), the entry is marked `unheard` and every answer about it is cannot
   * tell (#view). Asked again, it looks again.
   *
   * THE WORD, AND NOT THE TIME ON THE FILE. "Written since the attempt
   * began" was the test, and it said three things that were not so:
   *  - a member's session writes this home. One left a file shaped as a
   *    sign-in, with a string in it that broke the old runner's second line,
   *    and the box recorded a sign-in for a code nobody had approved;
   *  - a session that renews a sign-in rewrites the file. An older sign-in
   *    renewed while a code was out was recorded as that code approved, and
   *    whose it was dropped;
   *  - and a file from before the attempt was taken for a sign-in "this box
   *    had not been told of" and recorded, when what it had been told was
   *    that a session found that sign-in ended (`ended`): the box reported
   *    it again after any ending it did not hear.
   * So a file here is this attempt's only by the word the attempt was given
   * (#start), and a file that is not this attempt's never makes this box
   * say somebody is signed in whom it did not already say.
   *
   * WHAT THAT LEAVES. The home is the member's sessions' to write, so:
   *  - a session can remove the word, or the sign-in. Then an attempt that
   *    did sign in and was not heard is recorded as having signed nobody
   *    in, and somebody starts again. That way round and never the other;
   *  - after a code was approved, a session can put another file where the
   *    sign-in was, keep the word, and this box says the attempt signed in.
   *    It did; what is there now is the session's doing, as it could always
   *    be a moment after any sign-in, and who is not said;
   *  - a session cannot know an attempt's word before the runner writes it,
   *    and the runner writes it only for an approved code.
   * A runner too old to say a word (a session image from before this), and
   * a mark an earlier release left with none in it, never read as this
   * attempt's: an approval this box did not hear is then recorded as lost.
   *
   * One asking a member and engine at a time; whoever needs the answer waits
   * on it (#heard), and a start and a sign out wait for it before they run.
   * Never throws.
   *
   * @param {string} key
   * @param {{ member: string, engine: string, volume: string|null, startedAt: number, word: string|null, orphan?: boolean }} t  `word` is the attempt's own (#start)
   * @returns {Promise<void>}
   */
  #ask(key, t) {
    const under = this.asking.get(key);
    if (under) return under;
    const asking = (async () => {
      // Nothing of the attempt is left running, and so nothing is still writing the home.
      await this.#remove(containerFor(t.member, t.engine));
      /** @type {{ signedIn: boolean, pasted: boolean, writtenAt: number|null, word: string|null }|null} */
      let learned = null;
      try {
        if (t.volume && podmanAvailable(this.cfg) && sandboxImageExists(this.cfg)) {
          const ran = await podmanAsync(this.cfg, this.#askArgv(t.member, t.engine, t.volume), { timeout: this.askMs });
          for (const text of ran.stdout.split('\n')) {
            try {
              const line = JSON.parse(text);
              if (line?.signin === 'is' && typeof line.signedIn === 'boolean') {
                learned = {
                  signedIn: line.signedIn, pasted: line.pasted === true,
                  writtenAt: Number.isFinite(line.writtenAt) && line.writtenAt > 0 ? Math.round(line.writtenAt) : null,
                  word: typeof line.attempt === 'string' ? line.attempt : null,
                };
              }
            } catch { /* not the runner's line */ }
          }
        }
      } catch { /* could not ask: said below as that */ }
      // A new attempt begun meanwhile says how it ends itself; this one's answer is no longer the last word.
      if (this.attempts.has(key)) return;
      const at = this.now();
      let said = t.orphan ? 'lost' : 'not heard';
      this.#record(key, (e) => {
        if (t.orphan && e.attempt) {
          e.last = { state: 'lost', at, detail: null, by: e.attempt.by ?? null };
          e.attempt = null;
        }
        if (!learned) {
          e.unheard = { startedAt: t.startedAt, ...(t.word ? { word: t.word } : {}) };
          said += ', and whether it had signed in could not be asked';
          return;
        }
        delete e.unheard;
        const here = learned.signedIn && !learned.pasted;
        // This attempt's, by its word and by nothing else (above).
        const anew = here && t.word !== null && learned.word === t.word;
        if (anew) {
          e.signedIn = { since: learned.writtenAt ?? at, who: null, by: e.last?.by ?? null };
          e.last = { state: 'signed_in', at, detail: null, by: e.last?.by ?? null };
          said += ', and the code had been approved: signed in';
        } else if (here) {
          // NOTHING IS RECORDED OF A FILE THIS ATTEMPT DID NOT MAKE. Who the
          // record says is signed in stays, with whose it is; and where it
          // says nobody, it goes on saying nobody.
          said += ', and what the home holds is not this attempt’s: the record is as it was';
        } else {
          e.signedIn = null;
          said += ', and no sign-in made here is in the home';
        }
      }, t.volume);
      // A member, an engine and what was learned: nothing of the home.
      log.info(`engines: ${t.engine} sign-in for ${t.member}: ${said}`);
    })().catch(() => {}).finally(() => {
      if (this.asking.get(key) === asking) this.asking.delete(key);
    });
    this.asking.set(key, asking);
    return asking;
  }

  /**
   * The `podman run` that looks in one engine home (#ask). The home and
   * nothing else: no network, because it reads a file, and a name of its
   * own, so that removing an attempt's container never removes this one.
   *
   * @param {string} member @param {string} engine @param {string} volume
   */
  #askArgv(member, engine, volume) {
    const cfg = this.cfg;
    return [
      'run', '--rm', '--name', `${containerFor(member, engine)}-asked`,
      ...usernsArgs(cfg),
      '-v', `${volume}:${ENGINE_HOME}`,
      '-e', `FLEETWRIGHT_ENGINE_HOME=${ENGINE_HOME}`,
      '--network=none',
      ...(cfg.sandboxMemory ? [`--memory=${cfg.sandboxMemory}`] : []),
      ...(cfg.sandboxPidsLimit ? [`--pids-limit=${cfg.sandboxPidsLimit}`] : []),
      ...(cfg.sandboxExtraArgs ?? []),
      sessionImage(cfg),
      'fleetwright-engine', '--signedin', engine,
    ];
  }

  /**
   * Every attempt a restart left behind, found as this hub comes up, and
   * asked about (#ask). Not waited for: each is written down when its home
   * has answered, and until then the file's mark stands, which no answer
   * reads as waiting.
   */
  recover() {
    for (const key of Object.keys(this.#read() ?? {})) void this.#heard(key);
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

  /**
   * The `podman run` for one sign-in or sign out.
   *
   * @param {{ member: string, engine: string, account: string, volume: string }} a @param {'--signin'|'--signout'} mode @param {import('./egress.js').EgressRoute|null} route
   * @param {string|null} [word]  a sign-in attempt's own word (#start), which its container alone is given
   */
  #argv(a, mode, route, word = null) {
    const cfg = this.cfg;
    return [
      'run', '--rm', '--name', containerFor(a.member, a.engine),
      // The session namespace, because a session of this member mounts the same volume (sandbox-userns.js).
      ...usernsArgs(cfg),
      '-v', `${a.volume}:${ENGINE_HOME}`,
      '-e', `FLEETWRIGHT_ENGINE_HOME=${ENGINE_HOME}`,
      // In this container's environment and no session's. While the attempt
      // runs it is also in Podman's own arguments on this box, which whoever
      // can list this machine's processes can read. A session cannot: it is
      // in a container, with that container's processes and no others.
      ...(word ? ['-e', `FLEETWRIGHT_SIGNIN_ATTEMPT=${word}`] : []),
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
    if (!way.ok) return refuse('no_egress', `${box} could not prepare ${a.member}’s way out to the provider: ${inside(oneLine(way.message) ?? 'no reason given')}.`);
    return { ok: /** @type {const} */ (true), route: way };
  }

  /** @param {{ key: string, member: string, engine: string, account: string, volume: string, by: string|null, box: string }} a */
  async #start(a) {
    // What became of the last attempt is asked first, when it was not heard
    // (#heard): the new one runs under the same name and writes the same home.
    await this.#heard(a.key, a.volume);
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
      // THIS ATTEMPT'S OWN WORD: what a sign-in it makes will have beside
      // it, and what tells that sign-in from any other file in the home (#ask).
      word: randomBytes(16).toString('hex'),
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
     * `removed` is whoever it was for being forgotten here (forget,
     * keepMembers): its entry is dropped by what removes it, so nothing is
     * written of how it ended.
     *
     * NOT HEARD FROM THE RUNNER, WITH A CODE OUT, IS ASKED ABOUT (#ask).
     * Every ending but the runner's own second line is this box deciding:
     * the container stopped, its clock ran out, it was stopped and did not
     * answer. Once a code is out the person may have approved it, so the
     * ending is marked `unheard` and the home is asked. Before any code
     * there was nothing to approve, and the ending is what it is.
     *
     * @param {string} state @param {{ detail?: string|null, who?: Who|null, heard?: boolean }} [said]  `heard` is the runner's own word for how it ended
     */
    const end = (state, said = {}) => {
      if (attempt.over) return;
      attempt.over = true;
      for (const t of attempt.timers) clearTimeout(t);
      if (this.attempts.get(a.key) === attempt) this.attempts.delete(a.key);
      const at = this.now();
      const unheard = state !== 'removed' && said.heard !== true && Boolean(attempt.code);
      if (state !== 'removed') {
        this.#record(a.key, (e) => {
          e.last = { state, at, detail: state === 'failed' ? (said.detail ?? null) : null, by: a.by };
          e.attempt = null;
          if (unheard) e.unheard = { startedAt: attempt.startedAt, word: attempt.word };
          else delete e.unheard;
          if (state === 'signed_in') e.signedIn = { since: at, who: said.who ?? null, by: a.by };
        }, a.volume);
      }
      // A member, an engine and a state: nothing the engine said.
      log.info(`engines: ${a.engine} sign-in for ${a.member}, asked by ${a.by ?? 'nobody named'}: ${state}`);
      try {
        attempt.child?.kill?.('SIGTERM');
      } catch { /* gone already */ }
      void this.#remove(containerFor(a.member, a.engine));
      if (unheard) void this.#ask(a.key, { member: a.member, engine: a.engine, volume: a.volume, startedAt: attempt.startedAt, word: attempt.word });
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
    // one was, and asks its home what became of it (#heard).
    //
    // NOT WRITTEN IS NOT BEGUN. This write was not guarded either, and it is
    // made with the attempt already in the map: a disk that was full for one
    // moment left an attempt there that nothing would ever end, and every
    // start and status for that member and engine failed until the hub was
    // restarted, long after the disk was fine.
    try {
      this.#write(a.key, (e) => {
        e.attempt = { startedAt: attempt.startedAt, by: a.by, word: attempt.word };
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
        child = spawn(this.cfg.podmanBin, this.#argv(a, '--signin', ready.route, attempt.word), { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
        end('failed', { detail: `it gave no sign-in code within ${Math.round(this.codeMs / 1000)} seconds` });
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
              end('failed', { detail: `${a.box} could not read the page and the code it gave (${unread})` });
              answer(refused('unreadable_code', this.#view(a.key, a.box), ` Nothing is waiting. That is a fault in fleetwright on ${a.box} and not at ${own.at}: update fleetwright on ${a.box} and start again, or paste a sign-in instead.`));
              continue;
            }
            // THE PAGE IS THE PROVIDER'S OWN, OR THE CODE GOES TO NOBODY
            // (SIGNIN_PAGES). Any https page was passed on as this machine's
            // word, signed by the sidecar and opened from a phone. The engine
            // that named the page ran on the member's engine home, which
            // that member's sessions write; OpenCode loads settings and
            // plugins named there, and a plugin can answer for the sign-in.
            // So a session could choose the page and the code a custodian was
            // sent, under this box's name. The runner no longer starts the
            // engine there and checks the page itself; this check stays, for
            // whatever the container prints. The attempt is ended before
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
            end(state === 'signed_in' && !had ? 'failed' : attempt.stopped && state !== 'signed_in' ? attempt.stopped : state, { detail: state === 'signed_in' && !had ? 'the runner reported a sign-in it gave no code for' : detail, who: cleanWho(said.who), heard: true });
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

  /** @param {string} key @param {string} box @param {string|null} [volume] */
  async #cancel(key, box, volume = null) {
    const live = this.attempts.get(key);
    if (!live || live.over) {
      await this.#heard(key, volume);
      const view = this.#view(key, box);
      // Cannot tell is its own answer, and is not improved by "none was waiting".
      if (!view.ok) return view;
      const [member, engine] = key.split('/');
      const none = `No ${says(engine)} sign-in was waiting for ${member} on ${box}. `;
      return { ...view, text: `${none}${view.text}`, quietText: `${none}${view.quietText}` };
    }
    await this.#stop(live);
    // Stopped without the runner saying so, with a code out: asked about before this answers (#ask).
    await this.asking.get(key);
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
      // A home being asked about is left alone until it has answered (#ask).
      await this.asking.get(a.key);
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
        return refusal('signout_failed', `${says(a.engine)} was not signed out for ${a.member} on ${a.box}: ${inside(oneLine(said?.detail) ?? `the container that asks it ended with no answer (exit ${ran.status})`)}. What ${a.box} knows of the sign-in is unchanged.`);
      }
      const at = this.now();
      // The engine has signed out whether or not this can be written: kept
      // in memory until it can (#record), and the answer below is true either way.
      this.#record(a.key, (e) => {
        e.signedIn = null;
        e.attempt = null;
        // Whatever was not heard before, this is known: the engine signed out.
        delete e.unheard;
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
      delete e.unheard;
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

  // ── Somebody who is gone ──────────────────────────────────────────────────

  /**
   * Everything here that is in one engine home, ended and dropped, and the
   * home itself removed: the attempts that are out for it, the entries that
   * name it, and the volume with whatever an engine kept in it.
   *
   * IN THAT ORDER. An attempt still out would write its ending back into the
   * record after its entry was dropped, and an engine still running would be
   * writing into a volume as it was removed.
   *
   * AN ENTRY FROM BEFORE VOLUMES WERE WRITTEN DOWN names none, and is found
   * by `also`, which says whether an entry that names no volume is this
   * home's all the same. Where nothing can say (a person's, from that one
   * release), the entry stays until a session of theirs finds the sign-in
   * gone, and the volume is removed regardless: it is named by who it
   * belongs to, not by what the record says.
   *
   * @param {string} volume
   * @param {(entry: Entry) => boolean} [also]
   * @param {boolean} [whatever]  `also` decides for every entry, one that names another volume included
   * @returns {Promise<{ ok: boolean, entries: number, attempts: number, removed: boolean, why?: string }>}
   *   `removed` is whether there was a volume and it is gone; `ok` false when
   *   something of theirs may still be here, with why
   */
  async #forgetHome(volume, also = () => false, whatever = false) {
    const theirs = (/** @type {Entry} */ e) => (e?.volume && !whatever ? e.volume === volume : also(e));
    const live = [...this.attempts.values()].filter((attempt) => attempt.volume === volume);
    await Promise.all(live.map((attempt) => this.#stop(attempt, 'removed')));
    let entries = 0;
    try {
      this.#writeAll((all) => {
        for (const [key, entry] of Object.entries(all)) {
          if (!theirs(entry)) continue;
          delete all[key];
          this.owed.delete(key);
          entries += 1;
        }
      });
    } catch (e) {
      // A record that cannot be read or written still names them, or may.
      return { ok: false, entries: 0, attempts: live.length, removed: false, why: `its record of engine sign-ins could not be changed (${oneLine(/** @type {Error} */ (e).message) ?? 'no reason given'})` };
    }
    // NO PODMAN IS NO VOLUME: a box that runs nothing in containers has no
    // engine home to remove, and must not owe a removal it can never make.
    if (!this.#podman()) return { ok: true, entries, attempts: live.length, removed: false };
    // ASKED WHETHER IT IS THERE, so that "removed" is said only of a volume
    // that was: most people a box forgets never signed an engine in on it.
    // `podman volume exists` answers 1 and says nothing for one that is not;
    // anything else it says is Podman failing, which is not a no.
    const there = await podmanAsync(this.cfg, ['volume', 'exists', volume], { timeout: 30_000 });
    const said = (/** @type {{ status: number, stderr: string }} */ r) => oneLine(r.stderr.trim().split('\n').pop()) ?? `exit ${r.status}`;
    if (there.status === 1 && !there.stderr.trim()) return { ok: true, entries, attempts: live.length, removed: false };
    if (there.status !== 0) return { ok: false, entries, attempts: live.length, removed: false, why: `Podman could not say whether the volume ${volume} is there (${said(there)})` };
    // `-f`, because a container that still mounts it must not keep it: by
    // now that is only one this box lost track of.
    const gone = await podmanAsync(this.cfg, ['volume', 'rm', '-f', volume], { timeout: 60_000 });
    if (gone.status === 0) return { ok: true, entries, attempts: live.length, removed: true };
    if (/no such volume/i.test(gone.stderr)) return { ok: true, entries, attempts: live.length, removed: false };
    return { ok: false, entries, attempts: live.length, removed: false, why: `the volume ${volume} could not be removed (${said(gone)})` };
  }

  /** Whether there is a Podman to ask about volumes. A box set up with none, or with nothing named as one, has none: never thrown. */
  #podman() {
    try {
      return typeof this.cfg.podmanBin === 'string' && this.cfg.podmanBin !== '' && podmanAvailable(this.cfg);
    } catch {
      return false;
    }
  }

  /**
   * Somebody removed from the fleet (forget-person.js): the engines signed in
   * for them on this box are theirs no longer.
   *
   * It was not among what a box forgot. A person removed kept a ChatGPT
   * sign-in and a GitHub token in a volume here, this box went on reporting
   * them signed in, and a sign-in of theirs that was waiting for its code
   * went on waiting: approved afterwards, it signed them in again.
   *
   * BY THE ACCOUNT, which names the volume (engine-home.js). Not for an agent
   * member's account, which nobody is removed from the fleet under: an agent
   * goes when the vault's list stops naming it (keepMembers).
   *
   * @param {unknown} account  the address they were in the fleet under
   * @returns {Promise<{ ok: boolean, entries: number, attempts: number, removed: boolean, why?: string }>}
   */
  async forget(account) {
    const who = normaliseEmail(account);
    const volume = who && !memberOfAccount(who) ? engineHomeVolume(who) : null;
    if (!volume) return { ok: true, entries: 0, attempts: 0, removed: false };
    const forgot = await this.#forgetHome(volume);
    if (forgot.entries || forgot.attempts || forgot.removed) {
      log.info(`engines: forgot the engine sign-ins of somebody removed from the fleet: ${forgot.entries} recorded, ${forgot.attempts} that were waiting${forgot.removed ? ', and their engine home' : ''}`);
    }
    return forgot;
  }

  /**
   * The members the vault lists now, as the sidecar read them off the list
   * the minter signed (intent-keys.js): whoever this box holds a sign-in or
   * an engine home for and the list no longer names is gone, and so is what
   * was theirs here.
   *
   * WHY THE LIST, AND NOT A WORD FROM THE COORDINATOR. Removing a member told
   * a box nothing, so `fw-engine-<id>` stayed, this box went on reporting the
   * member signed in, and a member filed later under the same id was handed
   * the first one's sign-in. The coordinator already treats those as two
   * members (core.js, removeMember). The list is the one account of who is a
   * member that this box checks for itself, and it is what a start as a
   * member is already held to.
   *
   * GONE CAN BE TOLD FROM NOT LISTED YET. Nothing is signed in, and no home
   * is made, for a member the list did not name at the time (sidecar.js,
   * #actingAs). So an id this box holds something under, missing from a list
   * it could check, was on an earlier one and has left. A list that could not
   * be checked is not passed here at all: the caller says nothing, and
   * nothing is removed.
   *
   * NO SECOND LOOK. One list without the id removes what was its. Waiting for
   * a second would leave the hour in which an id filed again finds the last
   * member's sign-in, which is the thing this exists to stop. What a wrong
   * list costs is signing in again.
   *
   * WHAT GOES, for an id the list does not name:
   *  - every entry under it, so it is no longer reported, and any attempt out;
   *  - `fw-engine-<id>`, the agent's home, whether or not this box recorded a
   *    sign-in in it (a pasted item is staged there with no entry).
   * A PERSON'S HOME STAYS: it is named by their address and is theirs while
   * they are in the fleet, whatever member records there are (forget).
   *
   * @param {unknown} listed  every member id on the list
   * @returns {Promise<{ ok: boolean, gone: string[], text: string }>}
   */
  async keepMembers(listed) {
    if (!Array.isArray(listed) || listed.some((id) => typeof id !== 'string' || !MEMBER_ID_RE.test(id))) {
      return { ok: false, gone: [], text: 'That is not a list of member ids, so nothing was removed.' };
    }
    const named = new Set(listed);
    this.#settle();
    const kept = this.#read();
    if (!kept) return { ok: false, gone: [], text: 'This machine cannot read its own record of engine sign-ins, so nothing was removed.' };
    /** @type {Set<string>} */
    const gone = new Set();
    for (const entry of Object.values(kept)) {
      if (entry && MEMBER_ID_RE.test(String(entry.member)) && !named.has(entry.member)) gone.add(entry.member);
    }
    for (const attempt of this.attempts.values()) if (!named.has(attempt.member)) gone.add(attempt.member);
    // And the homes with no entry: what a pasted sign-in was staged into.
    if (this.#podman()) {
      const volumes = await podmanAsync(this.cfg, ['volume', 'ls', '--format', '{{.Name}}'], { timeout: 30_000 });
      if (volumes.status === 0) {
        for (const name of volumes.stdout.split('\n')) {
          const id = memberOfEngineHome(name.trim());
          if (id && !named.has(id)) gone.add(id);
        }
      }
    }
    /** @type {string[]} */
    const failed = [];
    for (const id of gone) {
      // Attempts by member, not by volume: one for a person's record that is gone is stopped too, and their home is left.
      await Promise.all([...this.attempts.values()].filter((attempt) => attempt.member === id).map((attempt) => this.#stop(attempt, 'removed')));
      // The agent's home, and every entry under the id whatever volume it names:
      // a person's entries under a record that is gone are dropped, and their own volume is left.
      const forgot = await this.#forgetHome(/** @type {string} */ (engineHomeVolume(accountOfMember(id))), (entry) => entry?.member === id, true);
      if (!forgot.ok) failed.push(`${id}: ${forgot.why}`);
      else log.info(`engines: ${id} is no longer a member the vault lists, so its engine sign-ins here are forgotten${forgot.removed ? ' and its engine home removed' : ''}`);
    }
    const ids = [...gone].sort();
    if (failed.length) return { ok: false, gone: ids, text: `Not everything of ${failed.length} removed member${failed.length === 1 ? '' : 's'} could be removed: ${failed.join('; ')}. Asked again with the next list.` };
    return { ok: true, gone: ids, text: ids.length ? `Forgot the engine sign-ins of ${ids.join(', ')}, no longer listed by the vault.` : 'Every member this machine holds an engine sign-in for is still listed.' };
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

/**
 * The engine home an entry's sign-in is in, or null for an entry from the
 * one release before homes were kept beside it. Such an entry does not say
 * whether it is an agent's or a person's, and a person's home is named by
 * an address it does not hold: it is not known until somebody who may ask
 * about the member does, which names it (#heard).
 *
 * @param {{ volume?: string }} entry
 * @returns {string|null}
 */
function homeOf(entry) {
  return typeof entry.volume === 'string' && entry.volume ? entry.volume : null;
}

/** The container one member's sign-in to one engine runs in. A member's id is letters, digits and hyphens. */
export function containerFor(/** @type {string} */ member, /** @type {string} */ engine) {
  return `fw-signin-${engine}-${member}`;
}
