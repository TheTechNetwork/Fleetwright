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

/**
 * Why a deposit is not a record a vault keeps, as a sentence, or null when
 * it is one. `sandboxRecord` reads leniently, which is right for a box
 * reading what a vault already checked: it leaves out a template whose id
 * does not read as one and stops at a dozen. A vault that kept such a
 * deposit and answered "Kept" would have dropped part of what a person
 * typed without a word (C-5), so what is deposited is held to this first.
 *
 * @param {string} name @param {unknown} value
 * @returns {string|null}
 */
export function sandboxDepositProblem(name, value) {
  const not = 'That is not a sandbox provider’s record: it is the provider’s API key and the templates to offer, each an id and a name.';
  if (!sandboxProviderOf(name) || typeof value !== 'string') return not;
  /** @type {any} */
  let read;
  try {
    read = JSON.parse(value);
  } catch {
    return not;
  }
  if (!read || typeof read !== 'object' || Array.isArray(read)) return not;
  if (typeof read.key !== 'string' || !KEY_RE.test(read.key)) {
    return 'That is not a provider’s API key: one is a single run of 16 or more letters, digits and punctuation, with no spaces. Paste the key alone.';
  }
  const listed = Array.isArray(read.templates) ? read.templates : [];
  if (!listed.length) {
    return 'A sandbox provider is kept with at least one template to offer. A machine is made from a template, and only you know which of your account’s are built to join the fleet.';
  }
  if (listed.length > MAX_SANDBOX_TEMPLATES) return `A sandbox provider is kept with at most ${MAX_SANDBOX_TEMPLATES} templates, and that is ${listed.length}.`;
  for (const t of listed) {
    const id = t && typeof t === 'object' ? t.id : undefined;
    if (typeof id !== 'string' || !TEMPLATE_RE.test(id)) {
      return `${typeof id === 'string' && id ? `“${id.slice(0, 40)}”` : 'One of those'} is not a template’s id: one is letters, digits, dots, hyphens and underscores, at most 64, as the provider names it.`;
    }
    if (t.name !== undefined && (typeof t.name !== 'string' || t.name.trim().length > 60)) return `The name for ${id} is too long: a template’s name is at most 60 characters.`;
  }
  if (new Set(listed.map((/** @type {any} */ t) => t.id)).size !== listed.length) return 'A template is listed twice. Each is offered once.';
  return null;
}
