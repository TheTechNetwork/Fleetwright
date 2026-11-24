// A member of the fleet's organization: the record, the tree, and the file
// (docs/members.md).
//
// WHY IT IS HERE AND NOT IN THE COORDINATOR. Three parties hold a copy of the
// tree and each must answer "who manages whom" the same way: the coordinator,
// which keeps the records and refuses first; the minter, which holds custody
// of every member's vault and takes no other party's word for it; and the
// box, which checks a start against the list the minter signed. One function,
// `manages`, on whatever tree the caller holds, is what keeps the three from
// drifting into three rules. No imports beyond text.js, which has none, so
// the Worker bundles and the stdio MCP server can all take this file.
//
// WHAT A RECORD NEVER HOLDS is a credential. A member's sign-ins are in its
// vault, in the minter, under its principal (`principalOf`). Nothing here
// names a token, and `checkMember` drops every field it does not list, so a
// file somebody pasted a key into does not carry it into storage.
//
// NEVER THROWS. Every refusal is `{ ok: false, text }`, in words a person
// editing a member can act on.

import { oneLine, LABEL_RE } from '../../core/text.js';

/** A member's id: a slug, because it is typed in commands and is a file's name. */
export const MEMBER_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** A fleet address, as the minter and the pins take one (intents.js, PIN_EMAIL_RE). */
const ADDRESS_RE = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9.-]{1,63}$/;
const WORK_TYPE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;

/** How many members a fleet holds. One Durable Object value each (members.js in the coordinator). */
export const MAX_MEMBERS = 200;
export const MAX_NAME = 80;
export const MAX_ROLE = 60;
export const MAX_TITLE = 80;
export const MAX_DESCRIPTION = 300;
export const MAX_WORK_TYPES = 12;
/** Bytes, as UTF-8: what a member's sessions open with. */
export const MAX_INSTRUCTIONS = 4096;
/** Extra managers an admin may name on one member, beside the tree. */
export const MAX_MANAGERS = 4;
/** A first message's cap, which a start's `task` already has (intents.js). */
export const MAX_FIRST_MESSAGE = 8000;
const MAX_BUDGET = 1_000_000;

export const MEMBER_KINDS = Object.freeze(['person', 'agent']);

/**
 * The engines a member may name. One this step: every other engine is a later
 * step's adapter (docs/members.md), and a name accepted here before its
 * adapter exists would be a member that looks runnable and is not.
 */
export const MEMBER_ENGINES = Object.freeze(['claude-code']);

/** The prefix an agent member's principal carries, in the minter and on a box. */
export const MEMBER_PREFIX = 'member:';

/** The line between a member's instructions and the task, in a session's first message. */
export const FIRST_MESSAGE_SEPARATOR = '\n\n----------\n\n';

/**
 * @typedef {object} Member
 * @property {string} id
 * @property {string} name
 * @property {'person'|'agent'} kind
 * @property {string} [email]  a person member's fleet address
 * @property {string} role
 * @property {string} title
 * @property {string|null} reportsTo
 * @property {string[]} managers
 * @property {string} description
 * @property {string[]} workTypes
 * @property {string} instructions
 * @property {Array<{ engine: string, model?: string }>} engines
 * @property {{ tag?: string }} hosts
 * @property {number|null} budgetUsdMonth
 * @property {string} [createdBy]
 * @property {number} [createdAt]
 * @property {number} [updatedAt]
 */

/** The least of a member that says who manages whom: what the minter keeps, and what a box is shown. */
/** @typedef {{ id: string, kind: string, email?: string, reportsTo?: string|null, managers?: string[] }} TreeNode */

/** @param {string} text */
const refuse = (text) => /** @type {const} */ ({ ok: false, text });
/** @param {unknown} s */
const lower = (s) => String(s ?? '').trim().toLowerCase();
const bytes = (/** @type {string} */ s) => new TextEncoder().encode(s).length;
// Control characters, and the marks that reorder or hide text on a line.
const UNPRINTABLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * Where a member's sign-ins are kept: its own vault for an agent, the
 * person's own for a person. The one name a box picks credentials by.
 *
 * @param {{ id: string, kind: string, email?: string }} member
 * @returns {string}
 */
export function principalOf(member) {
  return member.kind === 'person' ? lower(member.email) : `${MEMBER_PREFIX}${member.id}`;
}

/** @param {unknown} principal @returns {string|null} the member id of an agent's principal */
export function memberOfPrincipal(principal) {
  const p = String(principal ?? '');
  const id = p.startsWith(MEMBER_PREFIX) ? p.slice(MEMBER_PREFIX.length) : '';
  return MEMBER_ID_RE.test(id) ? id : null;
}

/**
 * One record, checked field by field and rebuilt from the fields this file
 * lists, so nothing else a caller sent is kept. The tree is `checkTree`'s:
 * this does not know the other members.
 *
 * @param {unknown} input
 * @returns {{ ok: true, member: Member } | { ok: false, text: string }}
 */
export function checkMember(input) {
  const m = /** @type {any} */ (input);
  if (!m || typeof m !== 'object' || Array.isArray(m)) return refuse('A member is a record with an id, a name, a kind and a role.');
  const id = String(m.id ?? '');
  if (!MEMBER_ID_RE.test(id)) return refuse('A member’s id is lowercase letters, digits and hyphens, at most 40, like “debbie” or “design-lead”.');
  const kind = String(m.kind ?? '');
  if (!MEMBER_KINDS.includes(/** @type {any} */ (kind))) return refuse('A member is a person or an agent. Say which, as kind.');

  /** @param {string} field @param {number} max @param {boolean} required */
  const line = (field, max, required) => {
    const raw = m[field] === undefined || m[field] === null ? '' : String(m[field]);
    if (UNPRINTABLE.test(raw) || /[\r\n\t]/.test(raw)) return { bad: `A member’s ${field} is one line of plain text.` };
    const v = raw.trim();
    if (required && !v) return { bad: `A member needs a ${field}.` };
    if ([...v].length > max) return { bad: `A member’s ${field} is at most ${max} characters.` };
    return { v };
  };
  const name = line('name', MAX_NAME, true);
  if ('bad' in name) return refuse(name.bad);
  const role = line('role', MAX_ROLE, true);
  if ('bad' in role) return refuse(role.bad);
  const title = line('title', MAX_TITLE, false);
  if ('bad' in title) return refuse(title.bad);

  const description = m.description === undefined || m.description === null ? '' : String(m.description).trim();
  if (UNPRINTABLE.test(description) || [...description].length > MAX_DESCRIPTION) {
    return refuse(`A member’s description is plain text, at most ${MAX_DESCRIPTION} characters.`);
  }

  const email = lower(m.email);
  if (kind === 'person' && !ADDRESS_RE.test(email)) return refuse('A person member needs their fleet address, as email.');
  if (kind === 'agent' && email) return refuse('An agent member has no address of its own. Its custodians sign it in.');

  const reportsTo = m.reportsTo === undefined || m.reportsTo === null || m.reportsTo === '' ? null : String(m.reportsTo);
  if (reportsTo !== null && !MEMBER_ID_RE.test(reportsTo)) return refuse('reportsTo is another member’s id, or nothing.');
  if (reportsTo === id) return refuse('A member cannot report to itself.');

  const managersIn = m.managers === undefined || m.managers === null ? [] : m.managers;
  if (!Array.isArray(managersIn) || managersIn.length > MAX_MANAGERS || managersIn.some((a) => !ADDRESS_RE.test(lower(a)))) {
    return refuse(`managers is at most ${MAX_MANAGERS} fleet addresses.`);
  }
  const managers = [...new Set(managersIn.map(lower))].sort();

  const typesIn = m.workTypes === undefined || m.workTypes === null ? [] : m.workTypes;
  if (!Array.isArray(typesIn) || typesIn.length > MAX_WORK_TYPES || typesIn.some((t) => !WORK_TYPE_RE.test(String(t)))) {
    return refuse(`workTypes is at most ${MAX_WORK_TYPES} short names in lowercase letters, digits and hyphens, like “backend” or “code-review”.`);
  }
  const workTypes = [...new Set(typesIn.map(String))];

  const instructions = m.instructions === undefined || m.instructions === null ? '' : String(m.instructions).replace(/\r\n?/g, '\n').trim();
  if (UNPRINTABLE.test(instructions)) return refuse('A member’s instructions are plain text: no control characters.');
  if (bytes(instructions) > MAX_INSTRUCTIONS) return refuse(`A member’s instructions are at most ${MAX_INSTRUCTIONS} bytes. These are ${bytes(instructions)}.`);

  const enginesIn = m.engines === undefined || m.engines === null ? [{ engine: 'claude-code' }] : m.engines;
  if (!Array.isArray(enginesIn) || enginesIn.length !== 1) return refuse('A member has exactly one engine for now: claude-code.');
  const e = enginesIn[0];
  if (!e || typeof e !== 'object' || !MEMBER_ENGINES.includes(String(e.engine))) {
    return refuse(`A member’s engine is ${MEMBER_ENGINES.join(' or ')} for now. Other engines come in a later step.`);
  }
  const model = e.model === undefined || e.model === null || e.model === '' ? null : String(e.model);
  if (model !== null && !MODEL_RE.test(model)) return refuse('An engine’s model is a model name, like “opus” or a full model id.');
  const engines = [{ engine: String(e.engine), ...(model ? { model } : {}) }];

  const hostsIn = m.hosts === undefined || m.hosts === null ? {} : m.hosts;
  if (typeof hostsIn !== 'object' || Array.isArray(hostsIn)) return refuse('hosts says where a member runs: { tag }.');
  const tag = hostsIn.tag === undefined || hostsIn.tag === null || hostsIn.tag === '' ? null : String(hostsIn.tag);
  if (tag !== null && !LABEL_RE.test(tag)) return refuse('hosts.tag is a host tag, like “linux” or “macos”.');

  const budgetIn = m.budgetUsdMonth === undefined || m.budgetUsdMonth === null || m.budgetUsdMonth === '' ? null : Number(m.budgetUsdMonth);
  if (budgetIn !== null && !(Number.isFinite(budgetIn) && budgetIn >= 0 && budgetIn <= MAX_BUDGET)) {
    return refuse('budgetUsdMonth is a number of dollars a month, or nothing.');
  }

  return {
    ok: true,
    member: {
      id, name: name.v, kind: /** @type {'person'|'agent'} */ (kind), ...(kind === 'person' ? { email } : {}),
      role: role.v, title: title.v, reportsTo, managers, description, workTypes, instructions, engines,
      hosts: tag ? { tag } : {}, budgetUsdMonth: budgetIn === null ? null : Math.round(budgetIn * 100) / 100,
    },
  };
}

/**
 * @param {Iterable<TreeNode>|Map<string, TreeNode>} members
 * @returns {Map<string, TreeNode>}
 */
function byId(members) {
  if (members instanceof Map) return members;
  const map = new Map();
  for (const m of members) if (m && typeof m.id === 'string') map.set(m.id, m);
  return map;
}

/**
 * Whether a member fits the tree it would join: its `reportsTo` exists, the
 * chain above it never comes back to it, and a person's address is not
 * another member's.
 *
 * @param {Iterable<TreeNode>|Map<string, TreeNode>} members  the tree as it is, with or without an older copy of this member
 * @param {TreeNode} candidate
 * @returns {{ ok: true } | { ok: false, text: string }}
 */
export function checkTree(members, candidate) {
  const tree = new Map(byId(members));
  tree.set(candidate.id, candidate);
  if (tree.size > MAX_MEMBERS) return refuse(`This fleet holds ${MAX_MEMBERS} members already.`);
  if (candidate.reportsTo && !tree.has(candidate.reportsTo)) return refuse(`${candidate.reportsTo} is not a member, so nobody can report to it.`);
  const seen = new Set([candidate.id]);
  for (let at = candidate.reportsTo ?? null; at; at = tree.get(at)?.reportsTo ?? null) {
    if (seen.has(at)) return refuse(`${candidate.id} cannot report to ${candidate.reportsTo}: ${candidate.reportsTo} already reports up to ${candidate.id}.`);
    seen.add(at);
  }
  if (candidate.kind === 'person') {
    const address = lower(candidate.email);
    for (const other of tree.values()) {
      if (other.id !== candidate.id && other.kind === 'person' && lower(other.email) === address) {
        return refuse(`${address} is already the member ${other.id}. A person is one member.`);
      }
    }
  }
  return { ok: true };
}

/**
 * The members above one, nearest first. Stops at a missing link or a loop,
 * which `checkTree` never lets in, so a tree read back damaged still ends.
 *
 * @param {Iterable<TreeNode>|Map<string, TreeNode>} members @param {string} id
 * @returns {TreeNode[]}
 */
export function chainAbove(members, id) {
  const tree = byId(members);
  /** @type {TreeNode[]} */
  const chain = [];
  const seen = new Set([id]);
  for (let at = tree.get(id)?.reportsTo ?? null; at && !seen.has(at); at = tree.get(at)?.reportsTo ?? null) {
    const node = tree.get(at);
    if (!node) break;
    chain.push(node);
    seen.add(at);
  }
  return chain;
}

/**
 * Does the person at this fleet address manage this member?
 *
 * By the tree: their own person member is above it. Or by name: an admin
 * listed their address in `managers`, on the member or on anything above it.
 * Never themselves: a person does not manage their own member, which is what
 * stops a team lead moving themselves out from under their manager.
 *
 * `role` is not read. A label gives nothing (docs/members.md).
 *
 * @param {Iterable<TreeNode>|Map<string, TreeNode>} members
 * @param {string|null|undefined} address
 * @param {string} id
 * @returns {boolean}
 */
export function manages(members, address, id) {
  const who = lower(address);
  const tree = byId(members);
  const member = tree.get(id);
  if (!who || !member) return false;
  if (member.kind === 'person' && lower(member.email) === who) return false;
  const above = chainAbove(tree, id);
  if (above.some((n) => n.kind === 'person' && lower(n.email) === who)) return true;
  return [member, ...above].some((n) => Array.isArray(n.managers) && n.managers.some((a) => lower(a) === who));
}

/**
 * Every member this address manages, ids in the tree's order.
 *
 * @param {Iterable<TreeNode>|Map<string, TreeNode>} members @param {string|null|undefined} address
 * @returns {string[]}
 */
export function teamOf(members, address) {
  const tree = byId(members);
  return [...tree.keys()].filter((id) => manages(tree, address, id));
}

/**
 * The first message of a member's session: its instructions, a line, the
 * task. Refused past the cap a first message already has, because a brief cut
 * short is a task the session was never given.
 *
 * @param {string} instructions @param {string} task
 * @returns {{ ok: true, text: string } | { ok: false, text: string }}
 */
export function composeFirstMessage(instructions, task) {
  const brief = String(instructions ?? '').trim();
  const asked = String(task ?? '').trim();
  const text = brief && asked ? `${brief}${FIRST_MESSAGE_SEPARATOR}${asked}` : brief || asked;
  const size = bytes(text);
  if (size > MAX_FIRST_MESSAGE) {
    return refuse(`This member’s instructions and the task come to ${size} bytes, and a session’s first message is at most ${MAX_FIRST_MESSAGE}. Shorten the task, or the member’s instructions.`);
  }
  return { ok: true, text };
}

// ── The file ────────────────────────────────────────────────────────────────
//
// A member as markdown with YAML front matter: the record's fields, and the
// instructions as the body. The front matter is the small subset this needs
// and no more, read by the few lines below rather than a YAML library: a
// library reads anchors, tags and multi-document streams, and a member's file
// is pasted in by people from wherever they keep it.

const FILE_KEYS = Object.freeze(['id', 'name', 'kind', 'email', 'role', 'title', 'reportsTo', 'managers', 'description', 'workTypes', 'engines', 'hosts', 'budgetUsdMonth']);
const PLAIN_SCALAR = /^[A-Za-z0-9_@.+/-](?:[A-Za-z0-9_@.+/ -]*[A-Za-z0-9_@.+/-])?$/;

/** @param {unknown} v */
function scalarOut(v) {
  if (typeof v === 'number') return String(v);
  const s = String(v);
  // Quoted as JSON, which YAML reads as written, unless it is plainly a word
  // or two that no YAML reader takes for a number, a boolean or a null.
  return PLAIN_SCALAR.test(s) && !/^(?:true|false|null|yes|no|on|off|~|[-+.0-9].*)$/i.test(s) ? s : JSON.stringify(s);
}

/**
 * @param {Member} member
 * @returns {string}
 */
export function toMarkdown(member) {
  const lines = ['---'];
  /** @type {Record<string, unknown>} */
  const m = /** @type {any} */ (member);
  for (const key of FILE_KEYS) {
    const v = m[key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (key === 'engines') {
      lines.push('engines:');
      for (const e of /** @type {Array<{ engine: string, model?: string }>} */ (v)) {
        lines.push(`  - engine: ${scalarOut(e.engine)}`);
        if (e.model) lines.push(`    model: ${scalarOut(e.model)}`);
      }
    } else if (key === 'hosts') {
      const tag = /** @type {{ tag?: string }} */ (v).tag;
      if (tag) lines.push('hosts:', `  tag: ${scalarOut(tag)}`);
    } else if (Array.isArray(v)) {
      lines.push(`${key}: [${v.map(scalarOut).join(', ')}]`);
    } else {
      lines.push(`${key}: ${scalarOut(v)}`);
    }
  }
  lines.push('---', '');
  return `${lines.join('\n')}${member.instructions ? `${member.instructions}\n` : ''}`;
}

/** @param {string} raw @returns {{ ok: true, v: string|number|null } | { ok: false }} */
function scalarIn(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return { ok: true, v: null };
  if (s.startsWith('"')) {
    try {
      const v = JSON.parse(s);
      return typeof v === 'string' ? { ok: true, v } : { ok: false };
    } catch {
      return { ok: false };
    }
  }
  if (s.startsWith("'")) return s.length >= 2 && s.endsWith("'") ? { ok: true, v: s.slice(1, -1).replace(/''/g, "'") } : { ok: false };
  if (/^[[\]{}&*!|>%@`]/.test(s) || / #/.test(s)) return { ok: false };
  return /^-?\d+(?:\.\d+)?$/.test(s) ? { ok: true, v: Number(s) } : { ok: true, v: s };
}

/** @param {string} raw @returns {{ ok: true, v: Array<string|number|null> } | { ok: false }} */
function inlineListIn(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return { ok: true, v: [] };
  /** @type {Array<string|number|null>} */
  const out = [];
  // Split on commas outside double quotes. A quoted item may hold a comma.
  for (const part of inner.match(/"(?:[^"\\]|\\.)*"|[^,]+/g) ?? []) {
    const one = scalarIn(part);
    if (!one.ok) return { ok: false };
    out.push(one.v);
  }
  return { ok: true, v: out };
}

/**
 * A member's file, read into the record `checkMember` takes. Anything this
 * does not read is refused by name, never dropped: a key that was skipped is
 * a setting somebody believes they made.
 *
 * @param {unknown} text
 * @returns {{ ok: true, member: Record<string, unknown> } | { ok: false, text: string }}
 */
export function fromMarkdown(text) {
  const src = String(text ?? '').replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  if (src.length > 64 * 1024) return refuse('A member’s file is at most 64 KiB.');
  const opened = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(src);
  if (!opened) return refuse('A member’s file starts with its fields between two lines of three dashes, then the instructions.');
  /** @type {Record<string, any>} */
  const out = { instructions: src.slice(opened[0].length).trim() };
  const lines = opened[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z][A-Za-z0-9]*):(.*)$/.exec(line);
    if (!top) return refuse(`Line ${i + 2} of the file’s fields is not “name: value”: ${oneLine(line, 60)}`);
    const [, key, rest] = top;
    if (!FILE_KEYS.includes(key)) return refuse(`A member’s file has no field called “${key}”. It takes: ${FILE_KEYS.join(', ')}.`);
    if (Object.hasOwn(out, key)) return refuse(`The file says “${key}” twice.`);
    // What follows, indented: a block list or a small map.
    /** @type {string[]} */
    const block = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || !lines[i + 1].trim())) block.push(lines[++i]);
    const body = block.filter((b) => b.trim());
    const bad = () => refuse(`The file’s “${key}” is not written in a way this reads. See docs/members.md, “The file”.`);
    if (rest.trim()) {
      if (body.length) return bad();
      const got = rest.trim().startsWith('[') && rest.trim().endsWith(']') ? inlineListIn(rest) : scalarIn(rest);
      if (!got.ok) return bad();
      out[key] = got.v;
      continue;
    }
    if (!body.length) {
      out[key] = null;
    } else if (key === 'hosts') {
      /** @type {Record<string, unknown>} */
      const map = {};
      for (const b of body) {
        const kv = /^\s+([A-Za-z]+):(.*)$/.exec(b);
        const got = kv ? scalarIn(kv[2]) : { ok: false };
        if (!kv || !got.ok || kv[1] !== 'tag') return bad();
        map[kv[1]] = /** @type {any} */ (got).v;
      }
      out[key] = map;
    } else if (key === 'engines') {
      /** @type {Array<Record<string, unknown>>} */
      const list = [];
      for (const b of body) {
        const first = /^\s+-\s+([A-Za-z]+):(.*)$/.exec(b);
        const more = first ? null : /^\s+([A-Za-z]+):(.*)$/.exec(b);
        const kv = first ?? more;
        const got = kv ? scalarIn(kv[2]) : { ok: false };
        if (!kv || !got.ok || !['engine', 'model'].includes(kv[1]) || (more && !list.length)) return bad();
        if (first) list.push({});
        list[list.length - 1][kv[1]] = /** @type {any} */ (got).v;
      }
      out[key] = list;
    } else {
      /** @type {Array<string|number|null>} */
      const list = [];
      for (const b of body) {
        const item = /^\s+-\s+(.*)$/.exec(b);
        const got = item ? scalarIn(item[1]) : { ok: false };
        if (!item || !got.ok) return bad();
        list.push(/** @type {any} */ (got).v);
      }
      out[key] = list;
    }
  }
  // A scalar where a list is wanted is one item: `workTypes: backend`.
  for (const key of ['managers', 'workTypes']) {
    if (out[key] !== undefined && out[key] !== null && !Array.isArray(out[key])) out[key] = [out[key]];
  }
  for (const key of ['id', 'name', 'kind', 'email', 'role', 'title', 'reportsTo', 'description']) {
    if (typeof out[key] === 'number') out[key] = String(out[key]);
  }
  return { ok: true, member: out };
}
