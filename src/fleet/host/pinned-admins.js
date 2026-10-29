// Admins a box pins itself, and the verbs that have to be one of them.
//
// docs/signed-intents.md, "Pinned admins". A signature says who asked. It
// does not say they may reboot the box: who is an admin was still the
// coordinator's word, and a coordinator this system is built to distrust can
// name anybody an admin. Worse, it can name anybody a MEMBER, and the minter
// lists keys for whoever the coordinator says is in the fleet, so a throwaway
// GitHub account it signed up itself signs as `signed`.
//
// SO THE FIRST PIN NEVER COMES OVER THE WIRE. Whoever runs the box sets it
// there, in its env file (FLEETWRIGHT_ADMINS, read while nobody is pinned) or
// with `fleetwright-sidecar pin-admin`, which is the same trust as everything
// else in that env file. Over the wire, `pinadmin` lets an admin this box
// already pins add or remove another, with their own signature for that one
// request. A delegation does not do: it is the coordinator holding a standing
// permission, and changing who may reboot is not one to hand it.
//
// NOBODY PINNED IS THE BEHAVIOUR FROM BEFORE THIS: the coordinator's word
// stands, so every box already deployed keeps working and nobody has to set
// anything up. Once anybody is pinned, reboot, `upgrade apply`, update and a
// restore of somebody else's work need a signature or a delegation from one of
// them. An unsigned actor is the coordinator naming an admin, so the check
// holds on a box that does not otherwise require signatures.
//
// WHEN AN ADMIN LEAVES THE FLEET, `forgetperson` drops their pin, unless they
// are the last one. A last admin stays pinned and this box refuses those verbs
// from everybody: their key stops being listed, so nobody can sign as them,
// and dropping them would hand the box back to the coordinator's word, which
// is the hole this closes. The box's health says so in a sentence, and the way
// back is on the box: `fleetwright-sidecar pin-admin` somebody new.
// `forgetperson` is the coordinator's alone (intent-signature.js), so a forged
// one can drop a pin and never add one: denial of service, which the
// coordinator could always do by not carrying the intents.
//
// The record is `pinned-admins.json` beside the host key. Written by rename,
// one change at a time even when the sidecar and the command line race
// (updatePins).

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, chownSync } from 'node:fs';
import path from 'node:path';

import { emailFromActor } from '../../core/accounts.js';
import { actorEmail } from '../protocol/intent-signature.js';
import { PIN_EMAIL_RE } from '../protocol/intents.js';

/**
 * What the record says. `admins` lowercased, in the order they were pinned.
 * `left`: the last admin, kept pinned after they left the fleet. `absent`:
 * no directory to keep a record in. `unreadable`: there is one and it cannot
 * be read, which refuses everything it guards, because cannot tell is not
 * "nobody".
 *
 * @typedef {{ admins: string[], left: string[], absent: boolean, unreadable: boolean }} PinFile
 */

export const PIN_FILE = 'pinned-admins.json';
const LOCK_FILE = 'pinned-admins.lock';
/** A lock older than this was left by a process that died holding it. A change holds it for milliseconds. */
const STALE_LOCK_MS = 30_000;
/** How long a change waits for the other process's before giving up and saying so. */
const LOCK_WAIT_MS = 5_000;
/** More than a box would pin, and a bound on what a hand-edited file can make health carry. */
export const MAX_PINNED = 64;

const UNREADABLE = 'The record of who is pinned on this machine cannot be read, so nothing that reaches everybody’s work on it was done. On the machine, fleetwright-sidecar admins says what is wrong with it.';
const UNSIGNED_ACT = 'This machine has pinned admins, and this request was not signed by one of them. Nothing was done.';
const NOBODY = 'This machine has pinned admins, and this request names nobody. Nothing was done.';
const CANNOT_TELL = 'This machine cannot tell whose that session is, and only a pinned admin may restore somebody else’s work. Nothing was done.';
const NOWHERE = 'This machine has nowhere to keep a record of its admins, so nothing was changed.';
const NOT_SIGNED_PIN = 'Changing who is pinned on this machine takes the signature of a pinned admin, made for this request. This one was not signed, so nothing was changed.';
const DELEGATED_PIN = 'Changing who is pinned on this machine takes the signature of a pinned admin, made for this request. A delegation does not carry it, so nothing was changed.';
const FIRST_IS_LOCAL = 'Nobody is pinned on this machine yet, and the first admin is pinned on the machine itself, by whoever runs it: fleetwright-sidecar pin-admin with their address. Nothing was changed.';
const LAST_IS_LOCAL = 'That is the last admin pinned on this machine. With none, it would take the fleet’s word again, so that is done on the machine itself: fleetwright-sidecar unpin-admin. Nothing was changed.';
/** Health's sentence when the only admin pinned here has left. Names nobody, so it can go to anybody who sees the box. */
export const LEFT = 'The only admin pinned on this machine has left the fleet, so it updates, upgrades and reboots for nobody. A new admin is pinned on the machine itself: fleetwright-sidecar pin-admin with their address.';

/**
 * @param {unknown} err
 * @returns {string}
 */
function codeOf(err) {
  return err && typeof err === 'object' && 'code' in err ? String(/** @type {{ code?: unknown }} */ (err).code ?? '') : '';
}

/**
 * A pinnable address, lowercased, or null. The protocol's shape, so the env
 * file and the command line refuse what the wire would.
 *
 * @param {unknown} v
 */
export function pinnable(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return PIN_EMAIL_RE.test(s) ? s : null;
}

/**
 * @param {string|null|undefined} dir  the directory beside the host key; null when this process has none
 * @returns {PinFile}
 */
export function readPins(dir) {
  // No directory is not a broken record. A process given no state directory
  // (the stdio transport, a test) has nowhere to have pinned anyone, and
  // reading that as unreadable would refuse every reboot.
  if (!dir) return { admins: [], left: [], absent: true, unreadable: false };
  let text;
  try {
    text = readFileSync(path.join(dir, PIN_FILE), 'utf8');
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return { admins: [], left: [], absent: false, unreadable: false };
    return { admins: [], left: [], absent: false, unreadable: true };
  }
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { admins: [], left: [], absent: false, unreadable: true };
  }
  const list = (/** @type {unknown} */ raw) => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > MAX_PINNED) return null;
    /** @type {string[]} */
    const out = [];
    for (const item of raw) {
      const email = pinnable(item);
      if (!email || email !== item) return null;
      if (!out.includes(email)) out.push(email);
    }
    return out;
  };
  const admins = parsed && typeof parsed === 'object' && Array.isArray(parsed.admins) ? list(parsed.admins) : null;
  const left = parsed && typeof parsed === 'object' ? list(parsed.left) : null;
  if (!admins || !left) return { admins: [], left: [], absent: false, unreadable: true };
  return { admins, left: left.filter((e) => admins.includes(e)), absent: false, unreadable: false };
}

/**
 * Write the record whole, by rename, so a reader sees the old one or the new
 * one and never half of either. Readable by anyone on the box, like
 * `signers.json` beside it: addresses, and nothing that grants anything to a
 * reader. Run as root (`sudo fleetwright-sidecar pin-admin`), it gives the file
 * to whoever owns the directory, so the sidecar can still replace it.
 *
 * @param {string} dir
 * @param {{ admins: string[], left?: string[] }} record  already lowercased
 */
export function writePins(dir, { admins, left = [] }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PIN_FILE);
  const tmp = path.join(dir, `.${PIN_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, `${JSON.stringify({ admins, ...(left.length ? { left } : {}) }, null, 2)}\n`, { mode: 0o644 });
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    try {
      const owner = statSync(dir);
      chownSync(tmp, owner.uid, owner.gid);
    } catch { /* left as root's, still readable */ }
  }
  renameSync(tmp, file);
}

/** @type {Map<string, Promise<unknown>>} the change in flight in this process, per directory */
const queues = new Map();

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Take the lock file, which is what keeps a `pin-admin` typed on the box and a
 * `pinadmin` arriving over the wire from each reading the record before the
 * other wrote it.
 *
 * @param {string} dir
 * @returns {Promise<() => void>} its release
 */
async function lock(dir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_FILE);
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(file, 'wx', 0o644));
      return () => rmSync(file, { force: true });
    } catch (err) {
      if (codeOf(err) !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(file).mtimeMs > STALE_LOCK_MS) rmSync(file, { force: true });
      } catch { /* released between the two calls */ }
      if (Date.now() > until) throw new Error(`another change to who is pinned is holding ${file}`);
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
}

/**
 * Change the record, one change at a time: `change` is handed what the record
 * says NOW, read under the lock, and returns what to write (or nothing) and
 * what to say. Without this, two changes that each read the record before the
 * other wrote it lose one of them.
 *
 * @template T
 * @param {string} dir
 * @param {(pins: PinFile) => { write?: { admins: string[], left?: string[] }, result: T }} change
 * @returns {Promise<T>}
 */
export function updatePins(dir, change) {
  const key = path.resolve(dir);
  const run = async () => {
    const release = await lock(dir);
    try {
      const decided = change(readPins(dir));
      if (decided.write) writePins(dir, decided.write);
      return decided.result;
    } finally {
      release();
    }
  };
  const next = (queues.get(key) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

/**
 * Whose a binned session is, from the hub's bin row.
 *
 * `createdBy` on a session the fleet started is `fleet:<email>`. A bare
 * address is accepted too. Anything else (`web`, empty, missing) is cannot
 * tell, and the caller refuses rather than guess.
 *
 * @param {unknown} createdBy
 * @returns {string|null}
 */
export function ownerOf(createdBy) {
  const prefixed = emailFromActor(createdBy);
  if (prefixed) return prefixed;
  if (typeof createdBy === 'string' && !createdBy.startsWith('fleet:')) return actorEmail(createdBy);
  return null;
}

/**
 * Does this intent reach everybody's work on the box? `upgrade` only when it
 * applies: without `apply` it reports what is waiting, and the person who may
 * not install it may still be told.
 *
 * @param {{ verb: string, params?: Record<string, unknown> }} intent
 */
export function isBoxWide(intent) {
  if (intent.verb === 'upgrade') return intent.params?.apply === 'yes';
  return intent.verb === 'reboot' || intent.verb === 'update' || intent.verb === 'restore';
}

/**
 * @param {string} who
 * @param {string} verb
 */
function notPinned(who, verb) {
  const reach = verb === 'restore' ? 'that session is somebody else’s' : 'this reaches everybody’s work on it';
  return `${who} is not a pinned admin on this machine, and ${reach}. Nothing was done.`;
}

/**
 * May this box-wide verb proceed?
 *
 * @param {{ verb: string, actor?: string|null }} intent
 * @param {PinFile} pins
 * @param {string|null} verdict  what the signature check said, or null when this box could not check
 * @param {boolean|null} [ownsSession]  restore only: true is the asker's own, false is somebody else's, null is cannot tell
 * @returns {{ ok: true } | { ok: false, code: 'pinned_admins', text: string }}
 */
export function decideBoxWide(intent, pins, verdict, ownsSession = null) {
  if (pins.unreadable) return { ok: false, code: 'pinned_admins', text: UNREADABLE };
  if (pins.absent || pins.admins.length === 0) return { ok: true };
  if (verdict !== 'signed' && verdict !== 'delegated') return { ok: false, code: 'pinned_admins', text: UNSIGNED_ACT };
  const who = actorEmail(intent.actor);
  if (!who) return { ok: false, code: 'pinned_admins', text: NOBODY };
  if (intent.verb === 'restore') {
    if (ownsSession === null) return { ok: false, code: 'pinned_admins', text: CANNOT_TELL };
    if (ownsSession === true) return { ok: true };
  }
  if (!pins.admins.includes(who)) return { ok: false, code: 'pinned_admins', text: notPinned(who, intent.verb) };
  return { ok: true };
}

/**
 * A `pinadmin` that arrived over the wire: what to write, and what to say. A
 * refusal writes nothing.
 *
 * Never the first pin, never the last removal, and only from an admin this box
 * already pins, signed for this request.
 *
 * @param {{ actor?: string|null, params?: { email?: unknown, op?: unknown } }} intent
 * @param {PinFile} pins
 * @param {string|null} verdict
 * @returns {{ ok: true, text: string, write?: { admins: string[] } } | { ok: false, code: 'pinned_admins', text: string }}
 */
export function decidePin(intent, pins, verdict) {
  if (verdict === 'delegated') return { ok: false, code: 'pinned_admins', text: DELEGATED_PIN };
  if (verdict !== 'signed') return { ok: false, code: 'pinned_admins', text: NOT_SIGNED_PIN };
  if (pins.absent) return { ok: false, code: 'pinned_admins', text: NOWHERE };
  if (pins.unreadable) return { ok: false, code: 'pinned_admins', text: UNREADABLE };
  if (pins.admins.length === 0) return { ok: false, code: 'pinned_admins', text: FIRST_IS_LOCAL };
  const who = actorEmail(intent.actor);
  if (!who || !pins.admins.includes(who)) {
    return { ok: false, code: 'pinned_admins', text: `${who ?? 'This request'} is not a pinned admin on this machine, so nothing was changed.` };
  }
  const email = pinnable(intent.params?.email);
  if (!email) return { ok: false, code: 'pinned_admins', text: 'This request does not name an address, so nothing was changed.' };
  const admins = pins.admins;
  if (intent.params?.op === 'add') {
    if (admins.includes(email)) return { ok: true, text: `${email} is already pinned on this machine.` };
    if (admins.length >= MAX_PINNED) return { ok: false, code: 'pinned_admins', text: `This machine already pins ${MAX_PINNED} admins, so nothing was changed.` };
    return {
      ok: true,
      write: { admins: [...admins, email] },
      text: `Pinned ${email}. This machine now takes reboot, upgrade, update and restoring somebody else’s work from them too.`,
    };
  }
  if (intent.params?.op === 'remove') {
    if (!admins.includes(email)) return { ok: false, code: 'pinned_admins', text: `${email} is not pinned on this machine, so nothing was changed.` };
    if (admins.length === 1) return { ok: false, code: 'pinned_admins', text: LAST_IS_LOCAL };
    return { ok: true, write: { admins: admins.filter((a) => a !== email) }, text: `${email} is no longer pinned on this machine.` };
  }
  return { ok: false, code: 'pinned_admins', text: 'This request does not say whether to add or remove, so nothing was changed.' };
}

/**
 * Somebody removed from the fleet (`forgetperson`): their pin goes, unless
 * they are the last admin, who stays pinned and is noted as left (top of
 * file).
 *
 * @param {PinFile} pins
 * @param {string} email
 * @returns {{ write?: { admins: string[], left: string[] }, result: string|null }}  the sentence to add to the reply, or null for nothing to say
 */
export function forgetPinned(pins, email) {
  if (pins.absent || pins.unreadable || !pins.admins.includes(email)) return { result: null };
  if (pins.admins.length > 1) {
    const admins = pins.admins.filter((a) => a !== email);
    return { write: { admins, left: pins.left.filter((a) => admins.includes(a)) }, result: `${email} is no longer pinned as an admin here.` };
  }
  return {
    write: { admins: pins.admins, left: [email] },
    result: `${email} was the only admin pinned here and stays pinned, so this machine updates, upgrades and reboots for nobody until a new admin is pinned on it.`,
  };
}

/**
 * What this box's health says about its pins, or null for a box with nowhere
 * to keep them, which offers nothing (core.js adminsSeenBy).
 *
 * `left` only while every admin pinned is one who left, and none of them is
 * on the key list again: somebody let back into the fleet has keys listed
 * once more and can sign as themselves, so the sentence would no longer be
 * true (C-5).
 *
 * @param {PinFile} pins
 * @param {{ has: (email: string) => boolean }|null} [listed]  the people the minter lists keys for now, when this box has a list
 * @returns {{ pinned: string[]|null, left?: string, problem?: string }|null}
 */
export function pinReport(pins, listed = null) {
  if (pins.absent) return null;
  if (pins.unreadable) return { pinned: null, problem: UNREADABLE };
  const stranded = pins.admins.length > 0 && pins.admins.every((a) => pins.left.includes(a) && !listed?.has(a));
  return { pinned: pins.admins, ...(stranded ? { left: LEFT } : {}) };
}

/**
 * FLEETWRIGHT_ADMINS, applied when the sidecar starts: the addresses it names
 * are pinned when NOBODY is, and the setting is left alone otherwise. Once
 * somebody is pinned the record is the box's word and changes with the
 * commands below; an env file that overruled it at every restart would undo
 * them. A record that cannot be read is left as it is, refusing, rather than
 * written over.
 *
 * @param {string} dir
 * @param {string[]} wanted  already checked by config.js
 * @returns {Promise<string[]|null>} who was pinned, or null for nothing done
 */
export function seedPins(dir, wanted) {
  return updatePins(dir, (pins) => {
    const admins = [...new Set(wanted.map((w) => pinnable(w)).filter((w) => w !== null))];
    if (pins.unreadable || pins.admins.length > 0 || admins.length === 0) return { result: null };
    return { write: { admins }, result: admins };
  });
}

/**
 * `fleetwright-sidecar admins | pin-admin | unpin-admin | reset-admins`, run on
 * the box by whoever runs it. The recovery for every way a box's pins can be
 * wrong, so nobody edits the file by hand: a lost admin, a record that will
 * not read, an admin nobody wants. Unlike the wire it may pin the first admin
 * and remove the last, because whoever is at this prompt already holds what
 * the pins guard.
 *
 * @param {string} dir
 * @param {string} sub
 * @param {string[]} args
 * @param {{ envAdmins?: string[] }} [opts]  FLEETWRIGHT_ADMINS, so a reset can say it will apply again
 * @returns {Promise<{ code: number, text: string }>}
 */
export async function adminCommand(dir, sub, args, { envAdmins = [] } = {}) {
  const nobody = 'Nobody is pinned on this machine. It takes the fleet’s word for who is an admin, as every machine did before pinning.';
  /** @param {PinFile} pins */
  const describe = (pins) =>
    pins.admins.length === 0
      ? nobody
      : [`Pinned admins on this machine: ${pins.admins.join(', ')}.`, ...(pinReport(pins)?.left ? [LEFT] : [])].join('\n');

  if (sub === 'admins') {
    const pins = readPins(dir);
    if (pins.unreadable) {
      return {
        code: 1,
        text: `${path.join(dir, PIN_FILE)} cannot be read, so this machine refuses update, upgrade, reboot and restoring somebody else’s work from everybody. fleetwright-sidecar reset-admins replaces it with nobody pinned, and pin-admin pins somebody.`,
      };
    }
    return { code: 0, text: describe(pins) };
  }

  if (sub === 'pin-admin') {
    const wanted = args.map((a) => [a, pinnable(a)]);
    const bad = wanted.filter(([, ok]) => !ok).map(([a]) => a);
    if (!wanted.length || bad.length) return { code: 2, text: `pin-admin takes the fleet addresses of the people to pin${bad.length ? `, and ${bad.join(', ')} is not one` : ''}.` };
    const emails = wanted.map(([, ok]) => /** @type {string} */ (ok));
    return updatePins(dir, (pins) => {
      // A RECORD THAT WILL NOT READ IS REPLACED, by exactly what was asked
      // for: it is refusing everything until somebody here says who.
      const before = pins.unreadable ? [] : pins.admins;
      const admins = [...new Set([...before, ...emails])];
      if (admins.length > MAX_PINNED) return { result: { code: 1, text: `That would pin more than ${MAX_PINNED} admins, so nothing was changed.` } };
      return { write: { admins }, result: { code: 0, text: describe({ ...pins, admins, left: [], unreadable: false }) } };
    });
  }

  if (sub === 'unpin-admin') {
    const email = pinnable(args[0]);
    if (!email || args.length !== 1) return { code: 2, text: 'unpin-admin takes the fleet address of one person to unpin.' };
    return updatePins(dir, (pins) => {
      if (pins.unreadable) return { result: { code: 1, text: 'The record of who is pinned cannot be read. fleetwright-sidecar reset-admins replaces it.' } };
      if (!pins.admins.includes(email)) return { result: { code: 1, text: `${email} is not pinned on this machine.\n${describe(pins)}` } };
      const admins = pins.admins.filter((a) => a !== email);
      return { write: { admins, left: pins.left.filter((a) => a !== email) }, result: { code: 0, text: describe({ ...pins, admins, left: [] }) } };
    });
  }

  if (sub === 'reset-admins') {
    return updatePins(dir, () => ({
      write: { admins: [] },
      result: {
        code: 0,
        text: envAdmins.length
          ? `${nobody}\nFLEETWRIGHT_ADMINS in this machine’s env file pins ${envAdmins.join(', ')} again when the sidecar next starts.`
          : nobody,
      },
    }));
  }

  return { code: 2, text: `${sub} is not an admin command: admins, pin-admin, unpin-admin or reset-admins.` };
}
