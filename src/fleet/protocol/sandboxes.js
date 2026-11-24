// The sandbox providers a machine can be made at, and the record a vault
// keeps for one (docs/api-engines.md, "A machine from a sandbox provider").
//
// HERE, AND NOT IN THE DRIVER, because two places read it that share no
// other code: the box's driver (src/fleet/host/sandbox-pools.js), which
// calls the provider, and the minter's vault, which keeps the record and
// must refuse one that does not read before it is sealed. No imports, so
// both Worker bundles take this file.

/** The prefix a sandbox provider's record is kept under in a vault. */
export const SANDBOX_ITEM = 'sandbox:';

/** The providers, by id, and what each is called on a screen. */
export const SANDBOX_PROVIDER_NAMES = Object.freeze({ e2b: 'E2B' });
export const SANDBOX_PROVIDER_IDS = /** @type {readonly string[]} */ (Object.freeze(Object.keys(SANDBOX_PROVIDER_NAMES)));

/** How many templates one record may offer. */
export const MAX_SANDBOX_TEMPLATES = 12;

const KEY_RE = /^[\x21-\x7e]{16,512}$/;
const TEMPLATE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * @typedef {{ provider: string, key: string, templates: Array<{ id: string, name: string }> }} SandboxRecord
 */

/** Is this a vault item a sandbox provider's record is kept under? */
export const isSandboxItem = (/** @type {unknown} */ name) => typeof name === 'string' && name.startsWith(SANDBOX_ITEM);

/** The provider a vault item names, when it is one of ours. @param {unknown} name @returns {string|null} */
export function sandboxProviderOf(name) {
  if (!isSandboxItem(name)) return null;
  const provider = String(name).slice(SANDBOX_ITEM.length);
  return SANDBOX_PROVIDER_IDS.includes(provider) ? provider : null;
}

/**
 * A vault item as a sandbox record, or null. The item is JSON: the key, and
 * the templates the person wants offered. A template is listed by the
 * person because the provider's own list is every template on the account,
 * and only some are built to enrol.
 *
 * @param {string} name @param {unknown} value
 * @returns {SandboxRecord|null}
 */
export function sandboxRecord(name, value) {
  const provider = sandboxProviderOf(name);
  if (!provider || typeof value !== 'string') return null;
  /** @type {any} */
  let read;
  try {
    read = JSON.parse(value);
  } catch {
    return null;
  }
  if (!read || typeof read !== 'object' || typeof read.key !== 'string' || !KEY_RE.test(read.key)) return null;
  const templates = (Array.isArray(read.templates) ? read.templates : [])
    .filter((/** @type {any} */ t) => t && typeof t.id === 'string' && TEMPLATE_RE.test(t.id))
    .slice(0, MAX_SANDBOX_TEMPLATES)
    .map((/** @type {any} */ t) => ({ id: t.id, name: typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 60) : t.id }));
  return { provider, key: read.key, templates };
}
