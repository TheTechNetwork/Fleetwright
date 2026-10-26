// Admins a box pins itself, and the verbs that have to be one of them.
//
// docs/signed-intents.md, phase 4. A signature says who asked. It does not
// say they may reboot the box: that was still the coordinator's word, and a
// coordinator this system is built to distrust can name anybody an admin.
//
// The record is a file beside the host key. Empty, or no directory to keep
// one in, is the behaviour from before this: the coordinator's word stands,
// because a box enrolled before anyone could pin has nobody to ask and must
// keep working. Once anybody is pinned, reboot, upgrade, update, and a
// restore of somebody else's work need a signature or a delegation from one
// of them. An unsigned actor is the coordinator naming an admin, so the
// check holds even on a box that does not otherwise require signatures.
//
// The first pin is the person who signs it, naming themselves. After that a
// pinned admin adds or removes. The last one stays: removing them would open
// the box back up to the coordinator's word, which is the hole this closes.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { emailFromActor } from '../../core/accounts.js';
import { actorEmail } from '../protocol/intent-signature.js';

/** @typedef {{ admins: string[], absent: boolean, unreadable: boolean }} PinFile */

export const PIN_FILE = 'pinned-admins.json';

/** Verbs that reach everybody's work on the box. Restore of the asker's own is the exception, decided beside this. */
export const BOX_WIDE = new Set(['reboot', 'upgrade', 'update', 'restore']);

const UNREADABLE = 'The pinned-admin record on this machine cannot be read, so nothing that reaches everybody’s work was done.';
const UNSIGNED_PIN = 'Pinning an admin is a signed intent. This one was not signed, so the record was left as it was.';
const NOWHERE = 'This machine has nowhere to keep a pinned admin, so the record was left as it was.';
const UNSIGNED_ACT = 'This machine has pinned admins, and this request was not signed by one of them. Nothing was done.';
const NOBODY = 'This machine has pinned admins, and this request names nobody. Nothing was done.';
const CANNOT_TELL = 'This machine cannot tell whose that session is, and only a pinned admin may restore somebody else’s work. Nothing was done.';
const NOT_FIRST = 'The first pinned admin is the person who signs for it. This request names somebody else, so the record was left as it was.';
const LAST = 'The last pinned admin cannot be removed. With none pinned, this machine would take the fleet’s word again.';
const NONE_YET = 'Nobody is pinned on this machine yet, so there is nobody to remove.';

/**
 * @param {unknown} err
 * @returns {string}
 */
function codeOf(err) {
  return err && typeof err === 'object' && 'code' in err ? String(/** @type {{ code?: unknown }} */ (err).code ?? '') : '';
}

/**
 * @param {string|null|undefined} dir  the directory beside the host key; null when this process has none
 * @returns {PinFile}
 */
export function readPins(dir) {
  // No directory is not a broken record. The sidecar's tests, and a box that
  // has not been given a state directory, have nowhere to have pinned anyone,
  // and treating that as unreadable would refuse every reboot.
  if (!dir) return { admins: [], absent: true, unreadable: false };
  let text;
  try {
    text = readFileSync(path.join(dir, PIN_FILE), 'utf8');
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return { admins: [], absent: false, unreadable: false };
    return { admins: [], absent: false, unreadable: true };
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { admins: [], absent: false, unreadable: true };
  }
  const raw = parsed && typeof parsed === 'object' && Array.isArray(/** @type {{ admins?: unknown }} */ (parsed).admins)
    ? /** @type {{ admins: unknown[] }} */ (parsed).admins
    : null;
  if (!raw) return { admins: [], absent: false, unreadable: true };
  /** @type {string[]} */
  const admins = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { admins: [], absent: false, unreadable: true };
    const email = actorEmail(item);
    if (!email || email !== item.toLowerCase()) return { admins: [], absent: false, unreadable: true };
    if (!admins.includes(email)) admins.push(email);
  }
  return { admins, absent: false, unreadable: false };
}

/**
 * @param {string} dir
 * @param {string[]} admins  already lowercased
 */
export function writePins(dir, admins) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PIN_FILE);
  const tmp = path.join(dir, `.${PIN_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify({ admins }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * Whose a binned session is, from the hub's bin row.
 *
 * `createdBy` on a session the fleet started is `fleet:<email>`. A bare
 * address is accepted too. Anything else — `web`, empty, missing — is
 * cannot tell, and the caller refuses rather than guess.
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
 * @param {string|null|undefined} verdict
 */
function signedBy(verdict) {
  return verdict === 'signed' || verdict === 'delegated';
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
 * @param {string|null} verdict
 * @param {boolean|null} [ownsSession]  restore only: true is the asker's own, false is somebody else's, null is cannot tell
 * @returns {{ ok: true } | { ok: false, code: 'pinned_admins', text: string }}
 */
export function decideBoxWide(intent, pins, verdict, ownsSession = null) {
  if (pins.unreadable) return { ok: false, code: 'pinned_admins', text: UNREADABLE };
  if (pins.absent || pins.admins.length === 0) return { ok: true };
  if (!signedBy(verdict)) return { ok: false, code: 'pinned_admins', text: UNSIGNED_ACT };
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
 * Add or remove a pinned admin. A refusal writes nothing.
 *
 * @param {{ actor?: string|null, params?: { email?: unknown, op?: unknown } }} intent
 * @param {PinFile} pins
 * @param {string|null} verdict
 * @returns {{ ok: true, text: string, admins?: string[] } | { ok: false, code: 'pinned_admins', text: string }}
 */
export function decidePin(intent, pins, verdict) {
  if (!signedBy(verdict)) return { ok: false, code: 'pinned_admins', text: UNSIGNED_PIN };
  if (pins.unreadable) return { ok: false, code: 'pinned_admins', text: UNREADABLE };
  if (pins.absent) return { ok: false, code: 'pinned_admins', text: NOWHERE };
  const who = actorEmail(intent.actor);
  if (!who) return { ok: false, code: 'pinned_admins', text: NOBODY };
  const email = actorEmail(intent.params?.email);
  if (!email) return { ok: false, code: 'pinned_admins', text: 'This request does not name an email address, so the record was left as it was.' };
  const op = intent.params?.op;
  const admins = pins.admins;
  if (op === 'add') {
    if (admins.length === 0) {
      if (email !== who) return { ok: false, code: 'pinned_admins', text: NOT_FIRST };
      return {
        ok: true,
        admins: [email],
        text: `Pinned ${who}. Box-wide actions on this machine now require a pinned admin’s signature.`,
      };
    }
    if (!admins.includes(who)) {
      return { ok: false, code: 'pinned_admins', text: `${who} is not a pinned admin on this machine, so the record was left as it was.` };
    }
    if (admins.includes(email)) return { ok: true, text: `${email} is already pinned on this machine.` };
    return {
      ok: true,
      admins: [...admins, email],
      text: `Pinned ${email}. They can reboot, upgrade and update this machine, and restore somebody else’s work on it.`,
    };
  }
  if (op === 'remove') {
    if (admins.length === 0) return { ok: false, code: 'pinned_admins', text: NONE_YET };
    if (!admins.includes(who)) {
      return { ok: false, code: 'pinned_admins', text: `${who} is not a pinned admin on this machine, so the record was left as it was.` };
    }
    if (!admins.includes(email)) return { ok: false, code: 'pinned_admins', text: `${email} is not pinned on this machine.` };
    if (admins.length === 1) return { ok: false, code: 'pinned_admins', text: LAST };
    return {
      ok: true,
      admins: admins.filter((a) => a !== email),
      text: `Removed ${email} from the pinned admins on this machine.`,
    };
  }
  return { ok: false, code: 'pinned_admins', text: 'This request does not say whether to add or remove, so the record was left as it was.' };
}
