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
// request, and never removes the last of them who can sign (decidePin). A
// delegation does not do: it is the coordinator holding a standing
// permission, and changing who may reboot is not one to hand it.
//
// NOBODY PINNED IS THE BEHAVIOUR FROM BEFORE THIS: the coordinator's word
// stands, so every box already deployed keeps working and nobody has to set
// anything up. Once anybody is pinned, reboot, `upgrade apply`, update, a new
// `channel` or `sandbox` image, and a restore of somebody else's work need a
// signature or a delegation from one of them (isBoxWide). An unsigned actor is
// the coordinator naming an admin, so the check holds on a box that does not
// otherwise require signatures.
//
// WHEN AN ADMIN LEAVES THE FLEET, `forgetperson` drops their pin, unless they
// are the last one who can still sign. That one stays pinned, recorded under
// `left`, and this box refuses those verbs from everybody: their key stops
// being listed, so nobody can sign as them, and dropping them would hand the
// box back to the coordinator's word, which is the hole this closes. An admin
// already under `left`, or one the minter lists no key for (a mistyped
// address, somebody who never signed in on a phone), is not counted as the one
// who stays, or the last who could sign would be dropped beside them. The
// box's health says it is stranded, by a code the coordinator turns into a
// sentence (pinReport), and the way back is on the box: `fleetwright-sidecar
// pin-admin` somebody new, which also drops the admins who left.
// `forgetperson` is the coordinator's alone (intent-signature.js), so a forged
// one can drop a pin and never add one: denial of service, which the
// coordinator could always do by not carrying the intents.
//
// The record is `pinned-admins.json` beside the host key, in the sidecar
// account's own directory. Written by rename, one change at a time even when
// the sidecar and the command line race (updatePins), and only ever by that
// account: root is refused (rootRefusal) wherever another account could
// change the way in, because what root makes there, that account can swap
// for a link before root's next call (docs/security.md, G10).

import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

import { emailFromActor } from '../../core/accounts.js';
import { actorEmail } from '../protocol/intent-signature.js';
import { PIN_EMAIL_RE, PIN_SENTENCES } from '../protocol/intents.js';

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
const LAST_IS_LOCAL = 'That is the last admin pinned on this machine who can sign. Without them it would take the fleet’s word again, or nobody’s, so that is done on the machine itself: fleetwright-sidecar unpin-admin. Nothing was changed.';

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
 * one and never half of either, and on disk before the rename, so a power cut
 * leaves one of the two and not an empty file that reads as unreadable.
 * Readable by anyone on the box, like `signers.json` beside it: addresses,
 * and nothing that grants anything to a reader. Created exclusively, so a
 * name planted in the directory is never written through.
 *
 * Only ever by the account that owns the directory (updatePins refuses
 * root), so nothing here changes an owner by path.
 *
 * @param {string} dir
 * @param {{ admins: string[], left?: string[] }} record  already lowercased
 */
export function writePins(dir, { admins, left = [] }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PIN_FILE);
  const tmp = path.join(dir, `.${PIN_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    writeSync(fd, `${JSON.stringify({ admins, ...(left.length ? { left } : {}) }, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  // The rename itself, on disk. Not every filesystem lets a directory be
  // synced, and the record is already whole either way.
  try {
    const d = openSync(dir, 'r');
    try { fsyncSync(d); } finally { closeSync(d); }
  } catch { /* best effort */ }
}

/** @param {number} uid  a name `sudo -u` takes: the account's, or `#1001` when the box has none for it */
function accountName(uid) {
  try {
    const line = readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.split(':')[2] === String(uid));
    if (line) return line.split(':')[0];
  } catch { /* no passwd file to name it from */ }
  return `'#${uid}'`;
}

/**
 * The first entry on the way from `at` up to `/` that somebody other than
 * root could change, or null when there is none. `at` exists.
 *
 * `at` itself must be root's and writable by root alone. Above it, a
 * directory root owns that others may write to passes only with the sticky
 * bit (`/tmp`): there nobody else can rename or remove what root put there,
 * so the way down cannot be swapped. A link is judged by its owner, and its
 * target is walked on its own (rootRefusal).
 *
 * @param {string} at
 * @returns {{ path: string, uid: number }|null}
 */
function changeableAlong(at) {
  for (let leaf = true; ; leaf = false) {
    const st = lstatSync(at);
    const others = !st.isSymbolicLink() && (st.mode & 0o022) !== 0 && (leaf || (st.mode & 0o1000) === 0);
    if (st.uid !== 0 || others) return { path: at, uid: st.uid };
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/**
 * Why this process may not change the record, or null when it may.
 *
 * ROOT MAY NOT, anywhere another account could change the way to it. What
 * root makes there (the lock, the temp file) sits where that account can
 * replace it, or a directory above it, with a link between two of root's
 * calls, and the next call then lands wherever the link points,
 * `/etc/shadow` included (docs/security.md, G10). Checking the directory's
 * own owner was not enough: a link the account owns pointing at a directory
 * root owns, or root's directory inside the account's, both passed. So the
 * directory, or the nearest one above it that exists when it does not yet
 * (root would make the rest), and every directory above that up to `/`,
 * are root's and changeable by root alone, both as the path is written and
 * as it resolves. Refused otherwise, and the sentence names the form that
 * runs as the account instead, which needs nothing special: the record is
 * that account's. A directory only root can reach (a sidecar that runs as
 * root) is root's to change.
 *
 * @param {string} dir
 * @param {string} [command]  what was typed, so the sentence can be pasted back
 * @returns {string|null}
 */
export function rootRefusal(dir, command = 'pin-admin ADDRESS') {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  let at = path.resolve(dir);
  for (;;) {
    try {
      lstatSync(at);
      break;
    } catch (err) {
      const up = path.dirname(at);
      if (codeOf(err) !== 'ENOENT' || up === at) throw err;
      at = up;
    }
  }
  const bad = changeableAlong(at) ?? changeableAlong(realpathSync(at));
  if (!bad) return null;
  const where = bad.path === path.resolve(dir) ? dir : `${dir} leads through ${bad.path}, which`;
  if (bad.uid !== 0) {
    const name = accountName(bad.uid);
    return `${where} belongs to ${name}, and root does not write where another account can change the way in, so nothing was changed. Run it as that account: sudo -u ${name} fleetwright-sidecar ${command}, or runuser -u ${name} -- fleetwright-sidecar ${command} where there is no sudo.`;
  }
  return `${where} can be written by accounts other than root, and root does not write where another account can change the way in, so nothing was changed. Run it as the account the sidecar runs as, or keep its directory where only root can write.`;
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
  // WHOSE LOCK IT IS, written into it, so a release removes only its own: a
  // change that outlived STALE_LOCK_MS and had its lock broken must not then
  // remove the lock the next change took.
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  /** @param {string} at */
  const tokenAt = (at) => {
    try { return readFileSync(at, 'utf8'); } catch { return null; }
  };
  for (;;) {
    try {
      const fd = openSync(file, 'wx', 0o644);
      try { writeSync(fd, token); } finally { closeSync(fd); }
      return () => {
        if (tokenAt(file) === token) rmSync(file, { force: true });
      };
    } catch (err) {
      if (codeOf(err) !== 'EEXIST') throw err;
      breakIfStale(file, tokenAt);
      if (Date.now() > until) throw new Error(`another change to who is pinned is holding ${file}`);
      await sleep(10 + Math.floor(Math.random() * 20));
    }
  }
}

/**
 * Remove a lock left by a process that died holding it, and nothing else.
 *
 * ONE BREAKER AT A TIME. Two waiters can both find the same dead lock, and
 * the slower one must not then remove the lock the faster one has just
 * taken: it found the lock stale before the faster one replaced it, so
 * nothing it read before that tells it which lock is there now. So breaking
 * is done under a second file, `pinned-admins.lock.break`, created
 * exclusively, and under it the lock is read again: still stale, and still
 * the token this waiter saw, or it is left alone. A lock is then only ever
 * removed by its holder (lock's release, by its token) or by the one waiter
 * holding the break file, and a fresh one has a fresh mtime, so no breaker
 * takes it for the dead one.
 *
 * WHAT IS LEFT is a holder that is alive but held the lock past
 * STALE_LOCK_MS, released it, and had a new one taken, all between the
 * breaker's second read and its remove. A change holds the lock for
 * milliseconds; that needs a process stopped for half a minute and then
 * woken within microseconds of a breaker.
 *
 * A BREAKER THAT DIED leaves its file, and every waiter would then wait for a
 * break that never comes. So a break file older than STALE_LOCK_MS is
 * removed, by whoever finds it, and that waiter breaks nothing on that pass
 * and goes round again. Holding it takes microseconds; half a minute is a
 * breaker that is not coming back, and changes wait LOCK_WAIT_MS each, so
 * the box is without changes for that half minute and no longer. Two waiters
 * that find the same dead breaker can both remove its file, the second
 * removing the first's new one; each still reads the lock again under its
 * own before removing anything, so that needs both of them in the same
 * microseconds as well.
 *
 * @param {string} file
 * @param {(at: string) => string|null} tokenAt
 */
function breakIfStale(file, tokenAt) {
  /** @param {string} at */
  const stale = (at) => Date.now() - statSync(at).mtimeMs > STALE_LOCK_MS;
  let seen;
  try {
    if (!stale(file)) return;
    seen = tokenAt(file);
  } catch {
    return; // released between the two calls
  }
  const breaker = `${file}.break`;
  let fd;
  try {
    fd = openSync(breaker, 'wx', 0o644);
  } catch (err) {
    if (codeOf(err) !== 'EEXIST') throw err;
    try {
      if (stale(breaker)) rmSync(breaker, { force: true });
    } catch { /* the breaker finished between the two calls */ }
    return;
  }
  try {
    closeSync(fd);
    if (seen !== null && stale(file) && tokenAt(file) === seen) rmSync(file, { force: true });
  } catch {
    // Gone already, which is what this was for.
  } finally {
    rmSync(breaker, { force: true });
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
    const refused = rootRefusal(dir);
    if (refused) throw new Error(refused);
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
 * not install it may still be told. `channel` and `sandbox` the same, only
 * with a `to`: the channel decides what code `update` installs, and the
 * sandbox the image every next session here runs in, so changing either is
 * as box-wide as an update, and asking which one it is reaches nobody.
 *
 * The coordinator's own gate for these is hosts.js administers, by the same
 * names (scheduler.js); this narrows it on a box that pins its admins.
 *
 * @param {{ verb: string, params?: Record<string, unknown> }} intent
 */
export function isBoxWide(intent) {
  if (intent.verb === 'upgrade') return intent.params?.apply === 'yes';
  if (intent.verb === 'channel' || intent.verb === 'sandbox') return typeof intent.params?.to === 'string' && intent.params.to !== '';
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
 * THE LAST WHO CAN SIGN STAYS, by the rule forgetPinned keeps (canSign):
 * a removal that leaves only addresses the minter lists no key for (a typo,
 * somebody who never signed in on a phone) strands the box as surely as
 * removing the last name, and it is done on the box or not at all.
 *
 * @param {{ actor?: string|null, params?: { email?: unknown, op?: unknown } }} intent
 * @param {PinFile} pins
 * @param {string|null} verdict
 * @param {{ has: (email: string) => boolean }|null} [listed]  the people the minter lists keys for now, or null when this box has no list
 * @returns {{ ok: true, text: string, write?: { admins: string[], left: string[] } } | { ok: false, code: 'pinned_admins', text: string }}
 */
export function decidePin(intent, pins, verdict, listed = null) {
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
  // WHO HAS LEFT STAYS NOTED, through every change made here, so the next
  // forgetperson still counts them out (forgetPinned).
  /** @param {string[]} next */
  const leftOf = (next) => pins.left.filter((a) => next.includes(a));
  if (intent.params?.op === 'add') {
    if (admins.includes(email)) return { ok: true, text: `${email} is already pinned on this machine.` };
    if (admins.length >= MAX_PINNED) return { ok: false, code: 'pinned_admins', text: `This machine already pins ${MAX_PINNED} admins, so nothing was changed.` };
    const next = [...admins, email];
    return {
      ok: true,
      write: { admins: next, left: leftOf(next) },
      text: `Pinned ${email}. This machine now takes updates, upgrades, reboots, a new release channel or session image, and restoring somebody else’s work from them too.`,
    };
  }
  if (intent.params?.op === 'remove') {
    if (!admins.includes(email)) return { ok: false, code: 'pinned_admins', text: `${email} is not pinned on this machine, so nothing was changed.` };
    // The last who can sign, not the last on the list: removing them leaves
    // only people nobody can sign as, which is the same box.
    if (!admins.some((a) => a !== email && canSign(pins, a, listed))) return { ok: false, code: 'pinned_admins', text: LAST_IS_LOCAL };
    const next = admins.filter((a) => a !== email);
    return { ok: true, write: { admins: next, left: leftOf(next) }, text: `${email} is no longer pinned on this machine.` };
  }
  return { ok: false, code: 'pinned_admins', text: 'This request does not say whether to add or remove, so nothing was changed.' };
}

/**
 * May this pinned admin still sign? Listed by the minter now, when this box
 * has the list; without it, not noted as having left. A key that is listed
 * again outranks the note: somebody let back into the fleet signs as
 * themselves.
 *
 * @param {PinFile} pins
 * @param {string} email
 * @param {{ has: (email: string) => boolean }|null} listed
 */
function canSign(pins, email, listed) {
  return listed ? listed.has(email) : !pins.left.includes(email);
}

/**
 * Somebody removed from the fleet (`forgetperson`): their pin goes, unless
 * they are the last admin pinned here who can still sign, who stays pinned
 * and is noted as left (top of file).
 *
 * THE LAST WHO CAN SIGN, not the last on the list. Counting an admin who left
 * already, or an address no key is listed for, as somebody who stays drops
 * the last real one and writes no `left`: the box then refuses everybody and
 * says nothing about why.
 *
 * @param {PinFile} pins
 * @param {string} email
 * @param {{ has: (email: string) => boolean }|null} [listed]  the people the minter lists keys for now, or null when this box has no list yet
 * @returns {{ write?: { admins: string[], left: string[] }, result: string|null }}  the sentence to add to the reply, or null for nothing to say
 */
export function forgetPinned(pins, email, listed = null) {
  if (pins.absent || pins.unreadable || !pins.admins.includes(email)) return { result: null };
  if (pins.admins.some((a) => a !== email && canSign(pins, a, listed))) {
    const admins = pins.admins.filter((a) => a !== email);
    return { write: { admins, left: pins.left.filter((a) => admins.includes(a)) }, result: `${email} is no longer pinned as an admin here.` };
  }
  return {
    write: { admins: pins.admins, left: [...new Set([...pins.left, email])] },
    result: `${email} was the last admin pinned here who could sign and stays pinned, so this machine takes its box-wide changes from nobody until a new admin is pinned on it.`,
  };
}

/**
 * What this box's health says about its pins, or null for a box with nowhere
 * to keep them, which offers nothing (core.js adminsSeenBy).
 *
 * STRANDED when it pins somebody and nobody pinned can sign, which refuses
 * the box-wide verbs from everybody (C-5: a phone must not draw them, and
 * the person must be told why). `stranded` is why, a code; the sentence
 * beside it is intents.js PIN_SENTENCES, which is also what the coordinator
 * shows in its place, so nothing the box writes reaches every viewer.
 *
 *  - `unchecked`: this box can check no signature at all (`checks` false),
 *    or holds no key list it may check with (`listed` null): none fetched
 *    yet, or one older than IntentKeys.check takes (intent-keys.js
 *    `current`). It refuses every signature then, so it is stranded, even
 *    though the list it last had named somebody pinned.
 *  - `left` or `unlisted`: none of the pinned is on the minter's list now,
 *    `left` when every one of them is noted as having left, which is also
 *    what is said without a list, being the more useful of the two there.
 *    Somebody let back in is listed again and can sign, so the box is not
 *    stranded.
 *
 * @param {PinFile} pins
 * @param {{ has: (email: string) => boolean }|null} [listed]  the people the minter lists keys for, from a list this box may still check with, or null
 * @param {{ checks?: boolean }} [opts]  false on a box with no key of its own to fetch the list with
 * @returns {{ pinned: string[]|null, stranded?: 'left'|'unlisted'|'unchecked', left?: string, problem?: string }|null}
 */
export function pinReport(pins, listed = null, { checks = true } = {}) {
  if (pins.absent) return null;
  if (pins.unreadable) return { pinned: null, problem: PIN_SENTENCES.unreadable };
  if (pins.admins.length === 0) return { pinned: pins.admins };
  const allLeft = pins.admins.every((a) => pins.left.includes(a));
  /** @type {'left'|'unlisted'|'unchecked'|null} */
  let stranded = null;
  if (!checks) stranded = 'unchecked';
  else if (listed) stranded = pins.admins.some((a) => listed.has(a)) ? null : allLeft ? 'left' : 'unlisted';
  else stranded = allLeft ? 'left' : 'unchecked';
  return { pinned: pins.admins, ...(stranded ? { stranded, left: PIN_SENTENCES[stranded] } : {}) };
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
  const describe = (pins) => {
    if (pins.admins.length === 0) return nobody;
    const left = pins.admins.filter((a) => pins.left.includes(a));
    return [
      `Pinned admins on this machine: ${pins.admins.join(', ')}.`,
      ...(left.length ? [`Noted as having left the fleet: ${left.join(', ')}.`] : []),
      // The command line holds no key list, so only the note is said here.
      ...(pins.admins.every((a) => pins.left.includes(a)) ? [PIN_SENTENCES.left] : []),
    ].join('\n');
  };
  /** What FLEETWRIGHT_ADMINS will do once nobody is pinned. */
  const again = envAdmins.length
    ? `\nFLEETWRIGHT_ADMINS in this machine’s env file pins ${envAdmins.join(', ')} again when the sidecar next starts.`
    : '';
  // ROOT IS TURNED AWAY BEFORE ANYTHING IS TOUCHED, with the command to run
  // instead (rootRefusal). Reading the record is not refused.
  if (sub === 'pin-admin' || sub === 'unpin-admin' || sub === 'reset-admins') {
    const refused = rootRefusal(dir, [sub, ...args].join(' '));
    if (refused) return { code: 1, text: refused };
  }

  if (sub === 'admins') {
    const pins = readPins(dir);
    if (pins.unreadable) {
      return {
        code: 1,
        text: `${path.join(dir, PIN_FILE)} cannot be read, so this machine refuses updates, upgrades, reboots, a new release channel or session image, and restoring somebody else’s work from everybody. fleetwright-sidecar reset-admins replaces it with nobody pinned, and pin-admin pins somebody.`,
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
      //
      // AND THE ADMINS WHO LEFT GO, said in the reply. Somebody pinning a
      // new admin here is replacing them; kept, they would sit beside the
      // new one unable to sign. Named again here, one of them is pinned
      // afresh and their note goes.
      const kept = pins.unreadable ? [] : pins.admins.filter((a) => !pins.left.includes(a) || emails.includes(a));
      const gone = pins.unreadable ? [] : pins.admins.filter((a) => !kept.includes(a));
      const admins = [...new Set([...kept, ...emails])];
      if (admins.length > MAX_PINNED) return { result: { code: 1, text: `That would pin more than ${MAX_PINNED} admins, so nothing was changed.` } };
      const text = [describe({ ...pins, admins, left: [], unreadable: false }), ...(gone.length ? [`No longer pinned, as they had left the fleet: ${gone.join(', ')}.`] : [])].join('\n');
      return { write: { admins }, result: { code: 0, text } };
    });
  }

  if (sub === 'unpin-admin') {
    const email = pinnable(args[0]);
    if (!email || args.length !== 1) return { code: 2, text: 'unpin-admin takes the fleet address of one person to unpin.' };
    return updatePins(dir, (pins) => {
      if (pins.unreadable) return { result: { code: 1, text: 'The record of who is pinned cannot be read. fleetwright-sidecar reset-admins replaces it.' } };
      if (!pins.admins.includes(email)) return { result: { code: 1, text: `${email} is not pinned on this machine.\n${describe(pins)}` } };
      const admins = pins.admins.filter((a) => a !== email);
      const left = pins.left.filter((a) => a !== email);
      return { write: { admins, left }, result: { code: 0, text: `${describe({ ...pins, admins, left })}${admins.length ? '' : again}` } };
    });
  }

  if (sub === 'reset-admins') {
    return updatePins(dir, () => ({ write: { admins: [] }, result: { code: 0, text: `${nobody}${again}` } }));
  }

  return { code: 2, text: `${sub} is not an admin command: admins, pin-admin, unpin-admin or reset-admins.` };
}
