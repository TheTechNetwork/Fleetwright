// Which member a task goes to (docs/routing.md): the fleet's routing record,
// the order a decision is made in, what is written on the task, and the one
// question a model may be asked.
//
// WHY IT IS HERE AND NOT IN THE COORDINATOR. The coordinator decides, the MCP
// server and both phones say the decision in words, and a test holds the
// three to the same sentences. One file with no imports of its own beyond
// its neighbours here, so the Worker bundles take it.
//
// ROUTING CHOOSES A MEMBER AND NOTHING ELSE. Nothing in this file starts a
// session, and nothing it returns is signed by anybody. A start as the
// member it chose still needs a person who may start as that member, and a
// box that checks them against the minter's list (docs/members.md).
//
// NEVER THROWS. Every refusal is `{ ok: false, code, text }`.

import { MEMBER_ID_RE } from './members.js';

export const ROUTING_MODES = Object.freeze(['off', 'manual', 'auto']);
/** How a decision was reached, in the order docs/routing.md gives. */
export const ROUTE_HOWS = Object.freeze(['pinned', 'rule', 'only', 'model', 'person', 'waiting', 'nobody']);
/** One rule a kind of work. A fleet with more kinds than this has work types nobody reads. */
export const MAX_RULES = 40;
/** How many candidates a task's record names; past it, `more` says how many are not listed. */
export const MAX_CANDIDATES_KEPT = 12;
/** How many candidates are put to a model. A choice among more than this is a person's. */
export const MAX_MODEL_CHOICES = 12;
/** How much of a brief a model is shown, in bytes of UTF-8. */
export const ROUTE_BRIEF_BYTES = 600;
/** A model's choice below this confidence is a guess, and a guess is not a pick. */
export const ROUTE_CONFIDENCE = 0.7;
/** How many routing asks reach the model in a UTC day, fleet-wide. */
export const ROUTE_ASKS_PER_DAY = 50;

/** A kind of work, as a member's `workTypes` and a task's `workType` spell it. */
const WORK_TYPE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** @param {string} code @param {string} text */
const refuse = (code, text) => /** @type {const} */ ({ ok: false, code, text });

/**
 * @typedef {{ workType: string, member: string }} Rule
 * @typedef {{ mode: 'off'|'manual'|'auto', rules: Rule[], updatedBy: string|null, updatedAt: number }} Routing
 * @typedef {{ id: string, name?: string, role?: string, description?: string, workTypes?: string[] }} Candidate
 * @typedef {object} Route
 * @property {'pinned'|'rule'|'only'|'model'|'person'|'waiting'|'nobody'} how
 * @property {string|null} member
 * @property {'manual'|'auto'} mode
 * @property {string[]} candidates
 * @property {number} [more]
 * @property {string} why
 * @property {string} [asked]       the address being asked, while `how` is `waiting`
 * @property {boolean} [modelAsked] this task has been put to the model once, by this decision or an earlier one
 * @property {number} at
 * @property {string} by
 */

/** A fleet that has set nothing. */
export const NO_ROUTING = Object.freeze({ mode: 'off', rules: Object.freeze([]), updatedBy: null, updatedAt: 0 });

/**
 * The fleet's routing record as an admin wrote it, checked. `partial` keeps
 * what a field left out already was.
 *
 * @param {unknown} input @param {{ mode: string, rules: readonly Rule[] }} [was]
 * @returns {{ ok: true, mode: 'off'|'manual'|'auto', rules: Rule[] } | { ok: false, code: string, text: string }}
 */
export function checkRouting(input, was = { mode: 'off', rules: [] }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('bad_routing', 'Routing is a mode and a list of rules.');
  const v = /** @type {Record<string, any>} */ (input);
  const mode = v.mode === undefined ? was.mode : String(v.mode);
  if (!ROUTING_MODES.includes(mode)) return refuse('bad_routing', 'A routing mode is off, manual or auto.');
  const listed = v.rules === undefined ? [...was.rules] : v.rules;
  if (!Array.isArray(listed)) return refuse('bad_routing', 'Rules are a list, each a kind of work and the member it goes to.');
  if (listed.length > MAX_RULES) return refuse('bad_routing', `A fleet keeps at most ${MAX_RULES} routing rules.`);
  /** @type {Rule[]} */
  const rules = [];
  for (const r of listed) {
    const workType = String(r?.workType ?? '').trim().toLowerCase();
    const member = String(r?.member ?? '').trim().toLowerCase();
    if (!WORK_TYPE_RE.test(workType)) return refuse('bad_routing', 'A rule’s kind of work is a short slug: lowercase letters, digits and hyphens, like “backend”.');
    if (!MEMBER_ID_RE.test(member)) return refuse('bad_routing', `The rule for ${workType} needs a member’s id.`);
    if (rules.some((x) => x.workType === workType)) return refuse('bad_routing', `There are two rules for ${workType}. A kind of work goes to one member.`);
    rules.push({ workType, member });
  }
  return { ok: true, mode: /** @type {'off'|'manual'|'auto'} */ (mode), rules };
}

/**
 * A task's own toggle: a mode, or nothing for "as the fleet is set".
 *
 * @param {unknown} value
 * @returns {{ ok: true, routing: 'off'|'manual'|'auto'|null } | { ok: false, code: string, text: string }}
 */
export function checkTaskRouting(value) {
  if (value === undefined || value === null || value === '') return { ok: true, routing: null };
  const mode = String(value);
  if (!ROUTING_MODES.includes(mode)) return refuse('bad_task', 'A task’s routing is off, manual or auto, or left out to follow the fleet’s setting.');
  return { ok: true, routing: /** @type {'off'|'manual'|'auto'} */ (mode) };
}

/**
 * The mode a task is routed under: its own when it names one, the fleet's
 * otherwise. A person who marked one task asked for that on that task, so it
 * holds whatever the fleet's setting is (docs/routing.md).
 *
 * @param {{ routing?: string|null }} task @param {{ mode: string }} routing
 * @returns {'off'|'manual'|'auto'}
 */
export function modeFor(task, routing) {
  const own = task.routing;
  if (own === 'off' || own === 'manual' || own === 'auto') return own;
  return routing.mode === 'manual' || routing.mode === 'auto' ? routing.mode : 'off';
}

/**
 * The members a task may go to: the ones the person asking could have
 * assigned it to by hand, and of those the ones that take its kind of work.
 * A task with no kind of work excludes nobody.
 *
 * @param {{ workType?: string }} task
 * @param {Candidate[]} members  every member of the fleet
 * @param {{ admin: boolean, acts: string[] }} who  the person asking
 * @returns {Candidate[]} in id order, so the same question has the same list
 */
export function candidatesFor(task, members, who) {
  return members
    .filter((m) => who.admin || who.acts.includes(m.id))
    .filter((m) => !task.workType || (m.workTypes ?? []).includes(task.workType))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The decision as far as rules alone can make it, in the order
 * docs/routing.md gives. `several` is the one outcome that is not an
 * answer: a model or a person picks among `candidates`.
 *
 * @param {{ id: string, assignee: string|null, workType?: string }} task
 * @param {{ routing: { rules: Rule[] }, members: Candidate[], who: { admin: boolean, acts: string[] } }} with_
 * @returns {{ how: 'pinned'|'rule'|'only'|'nobody'|'several', member: string|null, candidates: Candidate[], why: string }}
 */
export function decide(task, { routing, members, who }) {
  const named = (/** @type {string} */ id) => members.find((m) => m.id === id);
  const says = (/** @type {string} */ id) => named(id)?.name || id;
  if (task.assignee) {
    return { how: 'pinned', member: task.assignee, candidates: [], why: `${says(task.assignee)} was given this task, and routing never moves a task somebody was given.` };
  }
  const candidates = candidatesFor(task, members, who);
  let passed = '';
  const rule = task.workType ? routing.rules.find((r) => r.workType === task.workType) : undefined;
  if (rule) {
    const m = named(rule.member);
    if (!m) passed = `The rule for ${rule.workType} names ${rule.member}, who is not a member any more, so it was passed over. `;
    else if (!who.admin && !who.acts.includes(m.id)) passed = `The rule for ${rule.workType} names ${m.name || m.id}, who is not a member you can hand work to, so it was passed over. `;
    else return { how: 'rule', member: m.id, candidates, why: `The fleet’s rule sends ${rule.workType} work to ${m.name || m.id}.` };
  }
  const kind = task.workType ? `${task.workType} work` : 'work of any kind';
  if (!candidates.length) {
    return { how: 'nobody', member: null, candidates, why: `${passed}No member you can hand work to takes ${kind}.` };
  }
  if (candidates.length === 1) {
    return { how: 'only', member: candidates[0].id, candidates, why: `${passed}${candidates[0].name || candidates[0].id} is the only member you can hand work to who takes ${kind}.` };
  }
  return { how: 'several', member: null, candidates, why: `${passed}${candidates.length} members take ${kind}.` };
}

/** One printable line, at most `max`. */
function line(/** @type {unknown} */ v, /** @type {number} */ max) {
  return String(v ?? '').split('\n')[0].replace(/[^\x20-\x7e\u00a0-\uffff]/g, '').trim().slice(0, max);
}

/**
 * A decision as the record a task keeps, bounded. Also how a stored one is
 * read back: anything that is not one comes back null.
 *
 * @param {any} value
 * @returns {Route|null}
 */
export function cleanRoute(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!ROUTE_HOWS.includes(value.how)) return null;
  if (value.mode !== 'manual' && value.mode !== 'auto') return null;
  const member = typeof value.member === 'string' && MEMBER_ID_RE.test(value.member) ? value.member : null;
  const all = Array.isArray(value.candidates) ? value.candidates.map((/** @type {any} */ c) => (typeof c === 'string' ? c : c?.id)).filter((/** @type {unknown} */ c) => typeof c === 'string' && MEMBER_ID_RE.test(c)) : [];
  const more = Math.max(0, all.length - MAX_CANDIDATES_KEPT) + (Number.isInteger(value.more) && value.more > 0 ? value.more : 0);
  const asked = value.how === 'waiting' ? line(value.asked, 200).toLowerCase() : '';
  return {
    how: value.how,
    member,
    mode: value.mode,
    candidates: all.slice(0, MAX_CANDIDATES_KEPT),
    ...(more ? { more } : {}),
    why: line(value.why, 300),
    ...(asked ? { asked } : {}),
    ...(value.modelAsked === true ? { modelAsked: true } : {}),
    at: Number(value.at) || 0,
    by: line(value.by, 200),
  };
}

/** The word each way of deciding is said with, the same on every surface. */
export const HOW_WORDS = Object.freeze({
  pinned: 'Given to its member by hand',
  rule: 'Routed by the fleet’s rule',
  only: 'Routed to the only member who takes it',
  model: 'Routed by the fleet’s model',
  person: 'Chosen by a person',
  waiting: 'Waiting for a person to choose',
  nobody: 'No member takes this kind of work',
});

/**
 * A decision as the sentences a person reads on a task.
 *
 * @param {Route} route @param {(id: string) => string} [name]
 */
export function routeWords(route, name = (id) => id) {
  const head = HOW_WORDS[route.how];
  const among = route.how === 'waiting' && route.candidates.length
    ? ` Choose among ${route.candidates.map(name).join(', ')}${route.more ? ` and ${route.more} more` : ''}.`
    : '';
  return `${head}${route.member ? `: ${name(route.member)}` : ''}. ${route.why}${among}`.trim();
}

/**
 * The one question a model is asked (docs/routing.md, "The model's pick"):
 * the task's title, its kind of work and the top of its brief as the state,
 * and a multiple-choice question whose choices are the candidates' ids.
 *
 * WHAT IS IN IT is the whole of what leaves the coordinator: no
 * instructions, no session, nobody's address.
 *
 * @param {{ title: string, workType?: string, brief: string }} task
 * @param {Candidate[]} candidates
 * @returns {{ state: string, questions: { member: { type: 'choice', instructions: string, criteria: Record<string, string> } } }}
 */
export function routeQuestion(task, candidates) {
  const brief = new TextDecoder('utf-8', { fatal: false }).decode(new TextEncoder().encode(task.brief ?? '').slice(0, ROUTE_BRIEF_BYTES)).replace(/\ufffd+$/, '');
  const state = [`Task: ${line(task.title, 200)}`, `Kind of work: ${task.workType || 'not stated'}`, '', brief].join('\n');
  /** @type {Record<string, string>} */
  const criteria = {};
  for (const c of candidates.slice(0, MAX_MODEL_CHOICES)) {
    criteria[c.id] = [line(c.role, 60), line(c.description, 300), (c.workTypes ?? []).length ? `Takes: ${(c.workTypes ?? []).join(', ')}` : '']
      .map((part) => part.replace(/\.+$/, ''))
      .filter(Boolean)
      .join('. ') || c.id;
  }
  return {
    state,
    questions: {
      member: {
        type: 'choice',
        instructions: 'This is a piece of work to hand to one member of a team. Each option is a member, described by their role and what they are for. Which member is the best fit for this work?',
        criteria,
      },
    },
  };
}

/**
 * A model's answer, as one of the candidates or as nothing. Anybody who was
 * not on the list, and any choice below the confidence a label needs, is no
 * answer: the model cannot name a stranger, and a guess is not a pick.
 *
 * @param {any} result @param {string[]} candidateIds
 * @returns {{ member: string, confidence: number, inputTokens: number|null }|null}
 */
export function readRouteAnswer(result, candidateIds) {
  const answer = result?.answers?.member;
  const member = typeof answer?.choice === 'string' ? answer.choice : '';
  const confidence = typeof answer?.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : NaN;
  if (!candidateIds.includes(member) || !(confidence >= ROUTE_CONFIDENCE) || confidence > 1) return null;
  const tokens = result?.usage?.input_tokens;
  return { member, confidence, inputTokens: Number.isInteger(tokens) && tokens >= 0 ? tokens : null };
}
