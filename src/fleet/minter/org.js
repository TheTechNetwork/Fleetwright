// Custody: who may act for a member's vault, held and checked here and
// nowhere else (docs/members.md, "A member's vault").
//
// WHY THE MINTER KEEPS A TREE OF ITS OWN. The coordinator keeps the members
// and their tree, and the coordinator is the party this fleet is built to
// distrust (docs/signed-intents.md). If custody were read from its tree, a
// compromised coordinator would make itself a manager and be handed every
// member's sign-ins. So the minter is told the tree the way it is told
// everything else that matters: in a vault request sealed on a person's own
// device, with that person's GitHub sign-in inside, and it takes a change
// only from somebody who already holds the right to make it HERE.
//
// WHO THAT IS:
//
//  - AN ORG ADMIN, which is this file's own list (`org:admins`), because the
//    minter has no other way to know one. The first is whoever files first,
//    and only while the coordinator also says they administer the fleet: its
//    word is used to take away, never to give, after that one moment. First
//    use, as a fleet address is (vault.js, `devicekey`), and said so in the
//    doc's "What it does not stop".
//  - A MANAGER, by the tree already held here: above the member, or named on
//    it or above it (protocol/members.js, `manages`). A manager changes
//    their own team and cannot move a member out of it.
//
// EVERY IDENTITY IS A BOUND ADDRESS. A request names a fleet address, and the
// coordinator vouches for it; neither is enough to hold custody, since a
// dishonest coordinator can vouch for anybody. An address counts here only
// when its signing keys were filed by the GitHub account now asking
// (`dk:<address>`), which is the binding a box already checks signatures by.
// The address is that account's for good (vault.js, `devicekey`), and the one
// way it becomes somebody else's is an org admin releasing it here
// (`releaseaddress`), written in every vault the address could open.
//
// WHOEVER ADDS A PERSON MANAGES THEIR CREDENTIALS, and nobody else does until
// the person says so. Asked for in so many words, after the first build made
// all of it the person's to turn on: "if a manager created the member they
// should be able to manage it." So the one who files a person member is that
// person's custodian, kept on the row as an agent's are.
//
// ONLY FOR A PERSON THE VAULT HAD NOT MET. The tree is filed by admins and
// managers, and any team lead may file a member under their own team. If
// filing a record gave custody of the vault its address already has, a team
// lead could take the sign-ins of anybody in the fleet with no record yet,
// and a first-use admin could take everybody's. So the filer becomes a
// custodian only when no GitHub account has ever filed a key under the
// address: a person who was added, and not one who was already there. Two
// ways round that are closed where they would be tried. An account that
// already has a vault and files its first key under an added address is
// somebody the vault had met, and the custody is dropped at that moment
// (`dropAddedBy`). And a record pointed at another address names another
// person, so its custodians do not follow it. For everybody else, and for
// every manager who did not add the person, the person's own switch
// (`custody`) still decides, as it did.
//
// What a custodian then does to a vault is written beside it where its owner
// reads it (`clog:`), because the push that tells them is the coordinator's
// to drop.
//
// ONE ROW A MEMBER (`orgm:<id>`), for the reason the coordinator has: a row
// is 128 KiB, and 200 members with their managers and custodians are more.
//
// NEVER THROWS. Every refusal is a code and a sentence.

import { MEMBER_ID_RE, MEMBER_KINDS, MEMBER_PREFIX, MEMBER_ACCOUNT_DOMAIN, MAX_MEMBERS, MAX_MANAGERS, checkTree, manages, chainAbove } from '../protocol/members.js';

/** The minter's own list of who may file the tree's roots. */
export const ORG_ADMINS_ROW = 'org:admins';
/** One member of the tree, as custody needs it. */
export const ORG_MEMBER_PREFIX = 'orgm:';
/** What custodians did to a vault, for its owner to read. */
export const CUSTODY_LOG_PREFIX = 'clog:';
/** Org admins a fleet keeps, and explicit custodians one agent member keeps. */
export const MAX_ORG_ADMINS = 8;
export const MAX_CUSTODIANS = 8;
const MAX_LOG = 20;
const ADDRESS_RE = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,63}$/;
const KEY_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * A fleet address a person can hold. NEVER ONE AT `members.invalid`: that is
 * where a box files an agent member's vault (`debbie@members.invalid`,
 * protocol/members.js), and a box runs a person member's session as their
 * address. So a person record at that address was a session on the agent's
 * sign-ins for whoever filed it, with no custody of the agent at all: found
 * by the outsider review of this file, where the coordinator's store refused
 * the address and this one, the one a box believes, did not. Refused for
 * every address taken here, since none of them is a person's.
 *
 * @param {unknown} a
 */
const isAddress = (a) => ADDRESS_RE.test(String(a)) && !lower(a).endsWith(`@${MEMBER_ACCOUNT_DOMAIN}`) && !lower(a).endsWith(`.${MEMBER_ACCOUNT_DOMAIN}`);

/** The ops this file answers, so vault.js sends them here under one lock. */
export const ORG_OPS = Object.freeze(['org', 'orgadmin', 'orgmember', 'custodian', 'releaseaddress']);

/**
 * @typedef {object} OrgNode
 * @property {string} id
 * @property {'person'|'agent'} kind
 * @property {string} [email]        a person member's fleet address
 * @property {string|null} reportsTo
 * @property {string[]} managers     addresses an admin named beside the tree
 * @property {string[]} [custodians] an agent member's own custodians; for a person, whoever added them before they had a vault
 * @property {number} at             when this row last changed, by the request's clock
 * @property {boolean} [removed]     a tombstone, so a replayed older change cannot bring it back
 */

/** @typedef {{ get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void>, list?: (o: { prefix: string }) => Promise<Map<string, any>> }} Store */

/** @param {string} code @param {string} text */
const refuse = (code, text) => /** @type {const} */ ({ ok: false, error: { code }, text });
/** @param {unknown} s */
const lower = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Is this fleet address the GitHub account now asking? True only when that
 * account filed the address's signing keys and still keeps one.
 *
 * @param {Store} store @param {string} email @param {string} userId
 */
export async function isBound(store, email, userId) {
  const row = await store.get(`dk:${lower(email)}`);
  return Boolean(row && row.github === userId && Array.isArray(row.keys) && row.keys.some((/** @type {any} */ k) => k && !k.removed && KEY_HASH_RE.test(String(k.kid))));
}

/**
 * Whether the vault has met whoever this address is: a GitHub account has
 * filed a signing key under it, at any time. Wider than `accountOf` on
 * purpose. Somebody whose keys were all removed (a lost phone) still has a
 * vault here, and a record filed for them in that gap must not make its
 * filer their custodian.
 *
 * @param {Store} store @param {string} email
 */
async function addressMet(store, email) {
  const row = await store.get(`dk:${lower(email)}`);
  return Boolean(row && typeof row.github === 'string');
}

/**
 * A GITHUB ACCOUNT THAT ALREADY HAS A VAULT FILES ITS FIRST KEY UNDER AN
 * ADDRESS SOMEBODY ADDED. The vault has met this person after all, under
 * another address, so whoever filed the record did not create them, and
 * their custody would reach what was kept before the record existed. It is
 * dropped here, at the one moment the vault learns whose the address is
 * (vault.js, `devicekey`), and the person's own switch decides from then on.
 * Under the `org` lock, like every other change to the tree.
 *
 * @param {Store} store @param {string} email
 */
export async function dropAddedBy(store, email) {
  const address = lower(email);
  for (const node of (await loadTree(store)).values()) {
    if (node.kind !== 'person' || node.email !== address || !node.custodians?.length) continue;
    const { custodians: _gone, ...rest } = node;
    await store.put(`${ORG_MEMBER_PREFIX}${node.id}`, rest);
  }
}

/** @param {Store} store @param {string} email @returns {Promise<string|null>} the GitHub account an address is bound to */
async function accountOf(store, email) {
  const row = await store.get(`dk:${lower(email)}`);
  return row && typeof row.github === 'string' && Array.isArray(row.keys) && row.keys.some((/** @type {any} */ k) => k && !k.removed) ? row.github : null;
}

/**
 * The tree as it is held here: every member not removed.
 *
 * @param {Store} store
 * @returns {Promise<Map<string, OrgNode>>}
 */
export async function loadTree(store) {
  /** @type {Map<string, OrgNode>} */
  const tree = new Map();
  if (!store.list) return tree;
  for (const [key, row] of await store.list({ prefix: ORG_MEMBER_PREFIX })) {
    const id = key.slice(ORG_MEMBER_PREFIX.length);
    if (!row || row.removed || row.id !== id || !MEMBER_ID_RE.test(id) || !MEMBER_KINDS.includes(row.kind)) continue;
    // A person row at an agent's box account, kept from before that was
    // refused (isAddress), is nobody: no box is told of it.
    if (row.kind === 'person' && !isAddress(lower(row.email))) continue;
    tree.set(id, {
      id, kind: row.kind, ...(row.kind === 'person' ? { email: lower(row.email) } : {}), reportsTo: typeof row.reportsTo === 'string' ? row.reportsTo : null,
      managers: Array.isArray(row.managers) ? row.managers.map(lower) : [],
      // An agent always has the list. A person has one only when somebody
      // added them before they had a vault, and a row from before that rule
      // has none, which reads as nobody.
      ...(row.kind === 'agent' || (Array.isArray(row.custodians) && row.custodians.length) ? { custodians: Array.isArray(row.custodians) ? row.custodians.map(lower) : [] } : {}),
      at: Number(row.at) || 0,
    });
  }
  return tree;
}

/** @param {Store} store @returns {Promise<string[]>} */
async function orgAdmins(store) {
  const row = await store.get(ORG_ADMINS_ROW);
  return Array.isArray(row?.admins) ? row.admins.map(lower).filter((/** @type {string} */ a) => isAddress(a)) : [];
}

/**
 * Everybody the tree makes a manager of this member: the people above it,
 * and whoever an admin named on it or above it.
 *
 * @param {Map<string, OrgNode>} tree @param {string} id
 * @returns {string[]}
 */
function managersOf(tree, id) {
  const node = tree.get(id);
  if (!node) return [];
  const above = chainAbove(tree, id);
  const own = node.kind === 'person' ? lower(node.email) : '';
  return [...new Set([
    ...above.filter((n) => n.kind === 'person' && n.email).map((n) => lower(n.email)),
    ...[node, ...above].flatMap((n) => n.managers ?? []),
  ])].filter((a) => a && a !== own);
}

/** @param {Store} store @param {string} account  a person's GitHub account id */
async function allowsCustody(store, account) {
  const row = await store.get(`v:${account}`);
  return row?.custody?.allow === true;
}

/**
 * Who may start a session as each member, and so who holds its vault: for an
 * agent, its custodians and its managers; for a person, the person, whoever
 * added them, and their other managers once they allowed it. What a box is
 * shown, signed
 * (vault.js, answerVaultKeys), and what this file checks a custodian by.
 *
 * @param {Store} store
 * @param {Map<string, OrgNode>} tree
 * @param {string} id
 * @returns {Promise<string[]>}
 */
export async function mayActFor(store, tree, id) {
  const node = tree.get(id);
  if (!node) return [];
  const managers = managersOf(tree, id);
  if (node.kind === 'agent') return [...new Set([...(node.custodians ?? []), ...managers])];
  const address = lower(node.email);
  const account = await accountOf(store, address);
  return [...new Set([address, ...(node.custodians ?? []), ...(account && (await allowsCustody(store, account)) ? managers : [])])];
}

/**
 * Whose vault a request "for" a member opens, and whether this person may.
 *
 * @param {Store} store
 * @param {unknown} forId  the member's id, from inside the seal
 * @param {string} email   the asker's fleet address
 * @param {{ userId: string, login: string }} who  the asker's GitHub account
 * @returns {Promise<
 *   | { ok: true, own: true }
 *   | { ok: true, own: false, vault: { userId: string, login: string }, acting: { by: string, member: string, kind: 'person'|'agent', owner: string } }
 *   | { ok: false, error: { code: string }, text: string }>}
 */
export async function resolveFor(store, forId, email, who) {
  const id = String(forId ?? '');
  if (!MEMBER_ID_RE.test(id)) return refuse('bad_params', 'That is not a member’s id.');
  const tree = await loadTree(store);
  const node = tree.get(id);
  if (!node) {
    return refuse('no_member', `Custody of ${id} has not been filed with the vault yet. Whoever manages it files it from the Org screen, on a phone or the signing page.`);
  }
  if (node.kind === 'person' && lower(node.email) === email) return { ok: true, own: true };
  if (!(await isBound(store, email, who.userId))) {
    return refuse('not_bound', `No signing key for ${email} is filed by ${who.login}, so the vault cannot tell you are who manages ${id}. Sign in to GitHub under Runners from this phone, or list this browser, and ask again.`);
  }
  const may = await mayActFor(store, tree, id);
  if (node.kind === 'agent') {
    if (!may.includes(email)) {
      return refuse('not_custodian', `You are not one of ${id}’s custodians. ${may.length ? `They are ${may.join(', ')}; one of them can add you.` : 'It has none yet.'}`);
    }
    return { ok: true, own: false, vault: { userId: `${MEMBER_PREFIX}${id}`, login: `${MEMBER_PREFIX}${id}` }, acting: { by: email, member: id, kind: 'agent', owner: '' } };
  }
  const address = lower(node.email);
  // WHOEVER ADDED THEM, or a manager by the tree. The first needs no place
  // above the person: an org admin files anybody anywhere.
  if (!may.includes(email) && !manages(tree, email, id)) return refuse('not_custodian', `${address} is not on your team, so their credentials are not yours to manage.`);
  const account = await accountOf(store, address);
  if (!account) return refuse('no_vault', `${address} has not signed in on a phone or the signing page yet, so they have no vault to manage.`);
  if (!may.includes(email)) {
    return refuse('custody_not_allowed', `${address} has not let their managers manage their credentials. They turn it on themselves, under You › Credentials, and it is theirs to turn off.`);
  }
  const row = await store.get(`v:${account}`);
  return { ok: true, own: false, vault: { userId: account, login: String(row?.login || address) }, acting: { by: email, member: id, kind: 'person', owner: address } };
}

/**
 * What a custodian did to a vault, kept beside it for its owner: the last
 * twenty, by name and never by value.
 *
 * @param {Store} store @param {string} vaultId
 * @param {{ at: number, by: string, op: string, name?: string }} entry
 */
export async function logCustody(store, vaultId, entry) {
  const kept = await store.get(`${CUSTODY_LOG_PREFIX}${vaultId}`);
  const list = Array.isArray(kept) ? kept : [];
  list.push({ at: entry.at, by: entry.by, op: entry.op, ...(entry.name ? { name: String(entry.name).slice(0, 96) } : {}) });
  await store.put(`${CUSTODY_LOG_PREFIX}${vaultId}`, list.slice(-MAX_LOG));
}

/** @param {Store} store @param {string} vaultId @returns {Promise<Array<{ at: number, by: string, op: string, name?: string }>>} */
export async function custodyLog(store, vaultId) {
  const kept = await store.get(`${CUSTODY_LOG_PREFIX}${vaultId}`);
  return Array.isArray(kept) ? kept : [];
}

/**
 * A person's own custody: whether their managers may manage their vault, who
 * those managers are by the tree held here, and what custodians did.
 *
 * @param {Store} store @param {string} email @param {string} account @param {any} row  their vault row
 */
export async function ownCustody(store, email, account, row) {
  const tree = await loadTree(store);
  const mine = [...tree.values()].find((n) => n.kind === 'person' && lower(n.email) === email);
  return {
    allow: row?.custody?.allow === true,
    member: mine?.id ?? null,
    // WHO ADDED THEM, and so manages what they keep without being asked:
    // shown to the person first, before they keep anything.
    custodians: mine?.custodians ?? [],
    // Everybody else the tree puts above them, who wait on the switch.
    managers: mine ? managersOf(tree, mine.id).filter((a) => !(mine.custodians ?? []).includes(a)) : [],
    log: await custodyLog(store, account),
  };
}

/**
 * Every member and who may act as it, for the signed key list a box takes.
 * `listed` is the coordinator's word for who is in the fleet, and can only
 * take away, as it does for keys: an address it leaves off is on no list.
 *
 * @param {Store} store @param {Set<string>} listed
 * @returns {Promise<Array<{ id: string, kind: string, email?: string, may: string[] }>>}
 */
export async function membersForBoxes(store, listed) {
  const tree = await loadTree(store);
  const out = [];
  for (const node of tree.values()) {
    const may = (await mayActFor(store, tree, node.id)).filter((a) => listed.has(a)).sort();
    out.push({ id: node.id, kind: node.kind, ...(node.kind === 'person' ? { email: lower(node.email) } : {}), may });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * The tree's ops. Called under the one `org` lock.
 *
 * @param {any} inside  the opened request
 * @param {{ store: Store, email: string, who: { userId: string, login: string }, at: number, fleetAdmin: boolean }} ctx
 * @returns {Promise<{ ok: true, answer?: any, text: string, empty?: string, released?: { address: string, account: string } } | { ok: false, error: { code: string }, text: string }>}
 *   `empty` names an agent member whose vault the caller empties; `released`
 *   an address and the account it was taken from, whose approvals under it
 *   the caller takes back
 */
export async function runOrgOp(inside, ctx) {
  const { store, email, who, at } = ctx;
  const tree = await loadTree(store);
  const admins = await orgAdmins(store);
  const bound = await isBound(store, email, who.userId);
  const isOrgAdmin = bound && admins.includes(email);

  if (inside.op === 'org') {
    const members = [];
    for (const node of tree.values()) {
      const account = node.kind === 'person' ? await accountOf(store, lower(node.email)) : null;
      members.push({
        id: node.id, kind: node.kind, ...(node.kind === 'person' ? { email: lower(node.email) } : {}), reportsTo: node.reportsTo, managers: node.managers,
        ...(node.kind === 'agent' ? { custodians: node.custodians ?? [] } : { custodians: node.custodians ?? [], custody: !account ? 'no_vault' : (await allowsCustody(store, account)) ? 'allowed' : 'off' }),
        may: await mayActFor(store, tree, node.id),
      });
    }
    return { ok: true, answer: { admins, you: { admin: isOrgAdmin, bound }, members }, text: admins.length ? 'The organization, as the vault holds it.' : 'Nobody has filed the organization with the vault yet.' };
  }

  if (!bound) {
    return refuse('not_bound', `No signing key for ${email} is filed by ${who.login}, so the vault cannot take a change to the organization from you. Sign in to GitHub under Runners from this phone, or list this browser, and ask again.`);
  }

  if (inside.op === 'orgadmin') {
    const address = lower(inside.address);
    const remove = inside.remove === true;
    if (!isAddress(address)) return refuse('bad_params', 'An org admin is a fleet address.');
    if (!admins.length) {
      // THE FIRST, and the one moment the coordinator's word gives anything:
      // the person filing must be who it says administers the fleet.
      if (remove || address !== email) return refuse('not_admin', 'Nobody administers the organization in the vault yet. The first admin files themselves.');
      if (!ctx.fleetAdmin) return refuse('not_admin', 'The first org admin is somebody who administers the fleet. Ask one of them to open the Org screen first.');
      await store.put(ORG_ADMINS_ROW, { admins: [email], at });
      return { ok: true, answer: { admins: [email] }, text: `${email} now administers the organization in the vault.` };
    }
    if (!isOrgAdmin) return refuse('not_admin', `Org admins are ${admins.join(', ')}. One of them adds or removes another.`);
    if (remove) {
      if (!admins.includes(address)) return refuse('bad_params', `${address} is not an org admin.`);
      if (admins.length === 1) return refuse('last_admin', 'The last org admin stays: without one nobody could file the tree’s roots. Add another first.');
      const next = admins.filter((a) => a !== address);
      await store.put(ORG_ADMINS_ROW, { admins: next, at });
      return { ok: true, answer: { admins: next }, text: `${address} no longer administers the organization.` };
    }
    if (admins.includes(address)) return { ok: true, answer: { admins }, text: `${address} already administers the organization.` };
    if (admins.length >= MAX_ORG_ADMINS) return refuse('too_many', `The organization keeps ${MAX_ORG_ADMINS} admins. Remove one first.`);
    if (!(await accountOf(store, address))) {
      return refuse('not_bound', `${address} has not signed in on a phone or the signing page yet. An admin is added once they have, so the address cannot be claimed by somebody else first.`);
    }
    const next = [...admins, address];
    await store.put(ORG_ADMINS_ROW, { admins: next, at });
    return { ok: true, answer: { admins: next }, text: `${address} now administers the organization too.` };
  }

  if (inside.op === 'orgmember') {
    const id = String(inside.id ?? '');
    if (!MEMBER_ID_RE.test(id)) return refuse('bad_params', 'That is not a member’s id.');
    const stored = await store.get(`${ORG_MEMBER_PREFIX}${id}`);
    if (stored && Number(stored.at) >= at) return refuse('stale', `${id} has a newer change than this one, so this could be a replay. Nothing was changed.`);
    const prior = tree.get(id) ?? null;
    const own = [...tree.values()].find((n) => n.kind === 'person' && lower(n.email) === email) ?? null;
    /** Is this place under the asker: their own member, or one they manage? @param {string|null} parent */
    const underThem = (parent) => parent !== null && (parent === own?.id || manages(tree, email, parent));

    if (inside.remove === true) {
      if (!prior) return refuse('no_member', `${id} is not in the organization the vault holds.`);
      if (!isOrgAdmin && !manages(tree, email, id)) return refuse('not_manager', `${id} is not on your team, so removing it from the vault’s tree is not yours to do.`);
      const reports = [...tree.values()].filter((n) => n.reportsTo === id).map((n) => n.id);
      if (reports.length) return refuse('has_reports', `${reports.join(', ')} still ${reports.length === 1 ? 'reports' : 'report'} to ${id}. Move ${reports.length === 1 ? 'it' : 'them'} first.`);
      // WHAT THE TOMBSTONE REMEMBERS. Whose address a person was, so filing
      // them again is not adding somebody new (below, `again`).
      await store.put(`${ORG_MEMBER_PREFIX}${id}`, { id, at, removed: true, kind: prior.kind, ...(prior.kind === 'person' ? { email: lower(prior.email) } : {}) });
      // AN AGENT'S VAULT GOES WITH IT (`empty`, done by vault.js under the
      // vault's own lock). It used to stay "until a custodian forgets it",
      // and that could not happen: nobody is the custodian of a member that
      // is not in the tree, so the sign-ins were kept, renewed, and handed to
      // whoever filed the id next. A person's vault is their own and is not
      // touched.
      return prior.kind === 'agent'
        ? { ok: true, empty: id, text: `Removed ${id} from the organization.` }
        : { ok: true, text: `Removed ${id} from the organization. What ${lower(prior.email)} keeps is their own, and stays theirs.` };
    }

    const kind = String(inside.kind ?? '');
    if (!MEMBER_KINDS.includes(/** @type {any} */ (kind))) return refuse('bad_params', 'A member is a person or an agent.');
    const address = lower(inside.address);
    if (kind === 'person' ? !isAddress(address) : Boolean(address)) return refuse('bad_params', 'A person member has a fleet address, and an agent member has none.');
    const reportsTo = inside.reportsTo === undefined || inside.reportsTo === null || inside.reportsTo === '' ? null : String(inside.reportsTo);
    if (reportsTo !== null && !MEMBER_ID_RE.test(reportsTo)) return refuse('bad_params', 'reportsTo is another member’s id, or nothing.');
    const managersIn = inside.managers === undefined ? (prior?.managers ?? []) : inside.managers;
    if (!Array.isArray(managersIn) || managersIn.length > MAX_MANAGERS || managersIn.some((a) => !isAddress(lower(a)))) {
      return refuse('bad_params', `managers is at most ${MAX_MANAGERS} fleet addresses.`);
    }
    const managers = [...new Set(managersIn.map(lower))].sort();
    if (prior && prior.kind !== kind) return refuse('bad_params', `${id} is ${prior.kind === 'agent' ? 'an agent' : 'a person'} here, and a member does not change kind: its vault is kept under what it is.`);

    if (!isOrgAdmin) {
      // A MANAGER, inside their own team and nowhere else: the same three
      // rules the coordinator's store has (org-members.js), decided here on
      // the tree held here.
      if (prior ? !manages(tree, email, id) : !underThem(reportsTo)) {
        return refuse('not_manager', prior
          ? `${id} is not on your team in the vault’s tree, so its place there is not yours to change. An org admin, or whoever it reports to, can.`
          : 'You can file a member under your own team. An org admin files one anywhere.');
      }
      if (!underThem(reportsTo)) return refuse('not_manager', `You can move ${id} within your own team. Moving it out is an org admin’s to do: your custody of it would end with the move.`);
      const same = managers.length === (prior?.managers ?? []).length && managers.every((a, i) => a === (prior?.managers ?? [])[i]);
      if (!same) return refuse('not_admin', 'Naming extra managers on a member is an org admin’s to do.');
      if (prior && prior.kind === 'person' && lower(prior.email) !== address) return refuse('not_admin', 'Whose address a person member is, is an org admin’s to change.');
    }
    // WHOEVER ADDS A PERSON THE VAULT HAS NOT MET is that person's custodian
    // (the header). Decided once, when the member is first filed, and kept:
    // a later change to their place neither gives it nor takes it. An address
    // a GitHub account has ever filed a key under is somebody who was there
    // first, whether or not a key of theirs is still listed, and filing a
    // record for them gives nothing. Nobody is their own custodian.
    //
    // KEPT ONLY FOR THE SAME PERSON. A record whose address is changed, or
    // an agent's turned into a person's, names somebody else, and what the
    // old one's custodians held must not follow it to them.
    const met = kind === 'person' ? await addressMet(store, address) : false;
    const samePerson = Boolean(prior && prior.kind === 'person' && lower(prior.email) === address);
    // REMOVED AND FILED AGAIN is not somebody new either. Without this,
    // custody an org admin took away came back by removing the record and
    // filing it again.
    const again = Boolean(stored?.removed && stored.kind === 'person' && lower(stored.email) === address);
    const added = kind === 'person' && !samePerson && !met && !again && address !== email ? [email] : [];
    const personCustodians = kind === 'person' ? (samePerson ? prior?.custodians ?? [] : added) : [];
    /** @type {OrgNode} */
    const next = {
      id, kind: /** @type {'person'|'agent'} */ (kind), ...(kind === 'person' ? { email: address } : {}), reportsTo, managers,
      // THE FIRST CUSTODIAN is whoever files an agent member. Kept across
      // every later change to its place: the tree moves, its own do not.
      ...(kind === 'agent' ? { custodians: prior?.custodians?.length ? prior.custodians : [email] } : personCustodians.length ? { custodians: personCustodians } : {}),
      at,
    };
    const live = new Map(tree);
    if (!prior && live.size >= MAX_MEMBERS) return refuse('too_many', `The organization holds ${MAX_MEMBERS} members already.`);
    const fits = checkTree(live, next);
    if (!fits.ok) return refuse('bad_params', fits.text);
    await store.put(`${ORG_MEMBER_PREFIX}${id}`, next);
    const after = new Map(tree).set(id, next);
    return {
      ok: true,
      // A NEW AGENT STARTS WITH AN EMPTY VAULT, whatever a member that had
      // this id before left under it (a removal from before removals emptied
      // one, or a write that raced one).
      ...(kind === 'agent' && !prior ? { empty: id } : {}),
      answer: { id, may: await mayActFor(store, after, id) },
      text: prior
        ? `Filed ${id}’s place in the organization. Custody follows it from now.`
        : kind === 'agent'
          ? `Filed ${id}. You are its first custodian.`
          : added.length
            ? `Filed ${id}. You added ${address}, so you manage their credentials from their first sign-in, and they are shown that before they keep anything. Their other managers wait until ${address} allows it.`
            : met
              ? `Filed ${id}. ${address} already keeps their own sign-ins here, so managing them is theirs to allow, under You › Credentials.`
              : `Filed ${id}. Their managers hold their credentials only once ${address} allows it.`,
    };
  }

  if (inside.op === 'custodian') {
    const id = String(inside.member ?? '');
    const node = tree.get(id);
    if (!node) return refuse('no_member', `${MEMBER_ID_RE.test(id) ? id : 'That'} is not in the organization the vault holds.`);
    if (node.kind !== 'agent') {
      // A PERSON'S CUSTODIAN CAN ONLY BE TAKEN AWAY, and only by an org admin
      // or by the custodian. Nobody is added to a person this way after the
      // one who added them: the next manager is let in by the person.
      const address = lower(inside.address);
      const held = node.custodians ?? [];
      if (inside.remove !== true) return refuse('bad_params', `Nobody is made a custodian of a person after whoever added them. ${lower(node.email)} lets their other managers in themselves, under You › Credentials.`);
      if (!held.includes(address)) return refuse('bad_params', `${address} is not ${id}’s custodian. A manager’s custody of a person comes from that person’s own switch.`);
      if (!isOrgAdmin && address !== email) return refuse('not_admin', `Whoever added ${id} gives up managing their credentials themselves, or an org admin takes it away.`);
      const { custodians: _gone, ...rest } = node;
      const left = held.filter((a) => a !== address);
      await store.put(`${ORG_MEMBER_PREFIX}${id}`, { ...rest, ...(left.length ? { custodians: left } : {}), at });
      return { ok: true, text: `${address} no longer manages ${lower(node.email)}’s credentials. Their managers hold them only once ${lower(node.email)} allows it.` };
    }
    const may = await mayActFor(store, tree, id);
    if (!may.includes(email)) return refuse('not_custodian', `Only one of ${id}’s custodians changes who they are. They are ${may.join(', ') || 'nobody yet'}.`);
    const stored = await store.get(`${ORG_MEMBER_PREFIX}${id}`);
    if (stored && Number(stored.at) >= at) return refuse('stale', `${id} has a newer change than this one. Nothing was changed.`);
    const address = lower(inside.address);
    if (!isAddress(address)) return refuse('bad_params', 'A custodian is a fleet address.');
    const own = node.custodians ?? [];
    if (inside.remove === true) {
      if (!own.includes(address)) return refuse('bad_params', `${address} is not one of ${id}’s own custodians. A manager’s custody comes from the tree and ends when the tree changes.`);
      if (own.length === 1) return refuse('last_custodian', `${address} is ${id}’s last custodian, and the last one stays. Add another first.`);
      await store.put(`${ORG_MEMBER_PREFIX}${id}`, { ...node, custodians: own.filter((a) => a !== address), at });
      return { ok: true, text: `${address} is no longer one of ${id}’s custodians.` };
    }
    if (own.includes(address)) return { ok: true, text: `${address} is already one of ${id}’s custodians.` };
    if (own.length >= MAX_CUSTODIANS) return refuse('too_many', `${id} keeps ${MAX_CUSTODIANS} custodians of its own. Remove one first.`);
    if (!(await accountOf(store, address))) {
      return refuse('not_bound', `${address} has not signed in on a phone or the signing page yet. A custodian is added once they have, so the address cannot be claimed by somebody else first.`);
    }
    await store.put(`${ORG_MEMBER_PREFIX}${id}`, { ...node, custodians: [...own, address], at });
    return { ok: true, text: `${address} is now one of ${id}’s custodians: they can sign it in, test and renew what it keeps, approve its machines, and start sessions as it.` };
  }

  // AN ADDRESS, RELEASED FROM THE GITHUB ACCOUNT IT BELONGS TO. An address
  // is the first account's that listed a key under it, for good (vault.js,
  // `devicekey`), so a person who now signs in to GitHub as somebody else, or
  // an address handed on to a new person, needs somebody to say so. An org
  // admin does, and nobody else: this is the one way an address changes
  // hands, and it is the step a coordinator that lies about who is signing
  // in used to take by itself.
  //
  // WHAT IT LEAVES. The address is nobody's: no account, no keys, and the
  // delegations it revoked gone with the keys that signed them. The tree is
  // not changed, so whoever signs in under the address next holds what the
  // tree gives it, exactly as for an address nobody has signed in under yet
  // (docs/members.md, "What it does not stop"). That is why it is written in
  // every vault the address may open, where its owner reads it, and why an
  // org admin's own address is not released while it is one: the next
  // account under it would administer the organization.
  if (inside.op === 'releaseaddress') {
    const address = lower(inside.address);
    if (!isAddress(address)) return refuse('bad_params', 'An address to release is a fleet address.');
    if (!isOrgAdmin) return refuse('not_admin', `Releasing an address is an org admin’s to do. ${admins.length ? `They are ${admins.join(', ')}.` : 'Nobody administers the organization in the vault yet.'}`);
    if (admins.includes(address)) {
      return refuse('is_admin', `${address} administers the organization, and whoever signed in under it next would too. Another org admin removes it as an admin first, then releases it.`);
    }
    const row = await store.get(`dk:${address}`);
    if (row?.released && Number(row.released.at) >= at) return refuse('stale', `${address} has a newer release than this one. Nothing was changed.`);
    if (!row || typeof row.github !== 'string') return refuse('not_taken', `No GitHub account holds ${address}, so there is nothing to release. Whoever signs in under it first holds it.`);
    // EVERY VAULT IT MAY OPEN, worked out before the row is cleared, because
    // a person's managers count only while the address is somebody's.
    /** @type {string[]} */
    const vaults = [];
    for (const node of tree.values()) {
      if (node.kind === 'person' && lower(node.email) === address) continue;
      if (!(await mayActFor(store, tree, node.id)).includes(address)) continue;
      const vaultId = node.kind === 'agent' ? `${MEMBER_PREFIX}${node.id}` : await accountOf(store, lower(node.email));
      if (vaultId) vaults.push(vaultId);
    }
    await store.put(`dk:${address}`, { keys: [], released: { at, by: email } });
    for (const vaultId of vaults) await logCustody(store, vaultId, { at, by: email, op: 'release', name: address });
    const was = String(row.login || 'a GitHub account');
    return {
      ok: true,
      released: { address, account: row.github },
      answer: { address, vaults: vaults.length },
      text: `Released ${address}. It was ${was}’s and is nobody’s now: its signing keys are gone, so machines stop taking them when they next ask. ` +
        `Whoever signs in under it next holds it, with whatever the organization gives that address` +
        `${vaults.length ? `, which is written in the ${vaults.length === 1 ? 'vault' : `${vaults.length} vaults`} it may manage` : ''}.`,
    };
  }

  return refuse('bad_params', `The organization does not do “${String(inside.op).slice(0, 40)}”.`);
}
