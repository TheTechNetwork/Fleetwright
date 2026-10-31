// What the minter keeps, kept a second time outside its Durable Object.
//
// WHY. Everything a person keeps is in one object, sealed to a key that same
// object made and keeps beside it (worker/src/minter.js, depositSecret). An
// object deleted, a namespace renamed, a migration gone wrong, and every
// person's vault is gone with the one key that could open a copy of it. So
// two things are kept elsewhere, each optional and each off until a deploy
// binds it:
//
//  - THE KEYS, in Cloudflare Secrets Store (`DEPOSIT_KEY_STORED`,
//    `SIGNING_KEY_STORED`). Read when the object has none of its own, which
//    is the object lost; never written from here, because a Worker cannot
//    write Secrets Store, and never read back by anybody, because Secrets
//    Store does not give values back. They get there once, by the operator,
//    from a sealed export (exportKeys below, scripts/minter-key-export.mjs).
//  - THE ROWS, in an R2 bucket (`BACKUP`), sealed to the deposit key and
//    written a few minutes after anything changes (snapshot), and read back
//    only into an object that is empty (restore).
//
// A BACKUP NEEDS ITS KEY KEPT OUTSIDE. A copy sealed to a key that was lost
// with the object opens for nobody, so restore runs only when the deposit key
// comes from outside the object: Secrets Store, or the Worker secret.
//
// NEVER OVER ANOTHER KEY'S COPY. Copies are filed under the deposit key's
// fingerprint, so an object that lost its key and made a new one writes
// beside the old copies and not over them, and they stay there for whoever
// still holds the key they open with.

import { seal, open, MINTER_EXPORT_AAD, MINTER_BACKUP_AAD, SEAL_KEY_RE } from '../seal.js';

/** How long dated copies are kept, beside the latest. */
export const BACKUP_KEPT_DAYS = 30;

/** How long after a change the copy is written, so a burst of changes is one copy. */
export const BACKUP_AFTER_MS = 5 * 60_000;

/**
 * A copy this size is said in the log as a warning. It is every row held in
 * memory at once, in a Worker with 128 MiB; a handful of people is kilobytes.
 */
export const BACKUP_WARN_BYTES = 16 * 1024 * 1024;

/**
 * A secret from a Secrets Store binding, or null when none is bound.
 *
 * BOUND AND UNREADABLE THROWS, and does not read as absent: absent is what
 * lets the object make a new key, and a new key made while the old one sat
 * unread in Secrets Store is every vault sealed to the old one lost.
 *
 * @param {{ get: () => Promise<string> }|undefined|null} binding
 * @returns {Promise<string|null>}
 */
export async function storedSecret(binding) {
  if (!binding || typeof binding.get !== 'function') return null;
  const v = await binding.get();
  if (typeof v !== 'string' || !v.trim()) throw new Error('a Secrets Store secret is bound and empty');
  return v.trim();
}

/** Where one deposit key's copies are filed. @param {string} publicKey */
export async function backupPrefix(publicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicKey)));
  return `minter/${[...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')}/`;
}

/**
 * @typedef {object} Bucket  an R2 bucket binding, or a Map in a test
 * @property {(k: string, v: string) => Promise<unknown>} put
 * @property {(k: string) => Promise<{ text: () => Promise<string> }|null>} get
 * @property {(o: { prefix: string }) => Promise<{ objects: Array<{ key: string }> }>} list
 * @property {(k: string|string[]) => Promise<unknown>} delete
 */

/**
 * Write a copy of every row but the keys, sealed to the deposit key: as
 * `latest.json`, and as the day's, and drop days past BACKUP_KEPT_DAYS.
 *
 * @param {Bucket} bucket
 * @param {Map<string, any>} rows  everything the object holds
 * @param {string[]} skip  the rows that are keys, which go to Secrets Store and nowhere else
 * @param {{ publicKey: string }} key
 * @param {number} now
 * @returns {Promise<{ rows: number, bytes: number }>} how many rows the copy holds, and its size
 */
export async function snapshot(bucket, rows, skip, key, now) {
  /** @type {Record<string, any>} */
  const kept = {};
  for (const [k, v] of rows) if (!skip.includes(k)) kept[k] = v;
  const body = JSON.stringify({ v: 1, at: now, depositPublic: key.publicKey, sealed: await seal({ to: key.publicKey, aad: MINTER_BACKUP_AAD, payload: { v: 1, at: now, rows: kept } }) });
  const prefix = await backupPrefix(key.publicKey);
  const day = new Date(now).toISOString().slice(0, 10);
  await bucket.put(`${prefix}${day}.json`, body);
  await bucket.put(`${prefix}latest.json`, body);
  const oldest = new Date(now - BACKUP_KEPT_DAYS * 86_400_000).toISOString().slice(0, 10);
  const listed = await bucket.list({ prefix });
  const old = listed.objects.map((o) => o.key).filter((k) => /\/\d{4}-\d\d-\d\d\.json$/.test(k) && k.slice(prefix.length, prefix.length + 10) < oldest);
  if (old.length) await bucket.delete(old);
  return { rows: Object.keys(kept).length, bytes: body.length };
}

/**
 * The rows of the latest copy made under this deposit key, or null when there
 * is none. Throws when there is one and it does not open: a copy that is
 * there and unreadable is not the same as no copy.
 *
 * @param {Bucket} bucket
 * @param {{ privateKey: CryptoKey, publicKey: string }} key
 * @returns {Promise<{ at: number, rows: Record<string, any> }|null>}
 */
export async function latestCopy(bucket, key) {
  const obj = await bucket.get(`${await backupPrefix(key.publicKey)}latest.json`);
  if (!obj) return null;
  /** @type {any} */
  const copy = JSON.parse(await obj.text());
  if (copy?.v !== 1 || copy.depositPublic !== key.publicKey) throw new Error('the latest copy is not one this deposit key made');
  const inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: MINTER_BACKUP_AAD, sealed: copy.sealed });
  if (!inside?.rows || typeof inside.rows !== 'object') throw new Error('the latest copy holds no rows');
  return { at: Number(inside.at), rows: inside.rows };
}

/**
 * The minter's keys sealed to the operator's key, for them to put in Secrets
 * Store. Only the holder of that key's private half opens it, so it can be
 * fetched at the public address; the Worker secret that names the key is the
 * operator's to set and to delete again.
 *
 * @param {string} to  the operator's seal key, as scripts/minter-key-export.mjs prints it
 * @param {{ depositKey: string, signingKey: Record<string, unknown> }} keys
 * @param {number} now
 */
export async function exportKeys(to, keys, now) {
  if (!SEAL_KEY_RE.test(to)) throw new Error('FLEETWRIGHT_MINTER_EXPORT_TO is not a seal key');
  return seal({ to, aad: MINTER_EXPORT_AAD, payload: { v: 1, at: now, depositKey: keys.depositKey, signingKey: keys.signingKey } });
}
