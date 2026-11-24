// The fleet's routing record, the count of what was put to a model today,
// and the `/api/routing` routes (docs/routing.md).
//
// The rules themselves are src/fleet/protocol/routing.js, which decides. This
// keeps what an admin set, for the Durable Object and the Node coordinator
// alike, and serves it.
//
// ONE VALUE, under `routing`: a mode, at most forty rules of two short
// strings, and one day's count. A few kilobytes at the widest.
//
// OFF UNTIL SET. A fleet that never wrote this record has mode `off` and no
// rules, and nothing here runs for it.
//
// NEVER THROWS. Every refusal is a code and a sentence.

import { checkRouting, NO_ROUTING, ROUTE_ASKS_PER_DAY } from '../protocol/routing.js';

/** The key the record is stored under. */
export const ROUTING_KEY = 'routing';

/** @param {string} code @param {string} text */
const refuse = (code, text) => /** @type {const} */ ({ ok: false, error: { code }, text });

/** 'YYYY-MM-DD' in UTC, the day the model's own budget resets on (decide.js). */
const utcDay = (/** @type {number} */ t) => new Date(t).toISOString().slice(0, 10);

export class OrgRouting {
  /** @param {{ now?: () => number }} [opts] */
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    /** @type {import('../protocol/routing.js').Routing} */
    this.record = { mode: 'off', rules: [], updatedBy: null, updatedAt: 0 };
    /** How many routing asks reached the model on which UTC day. */
    this.asks = { day: utcDay(now()), n: 0 };
    this.dirty = false;
  }

  /**
   * An admin's change. A rule may name only a member the fleet has: a rule
   * for nobody is a typo, and it is cheaper to say so now than to pass it
   * over on every task.
   *
   * @param {{ email: string, admin: boolean }} who @param {unknown} input
   * @param {(id: string) => { name: string }|null} member
   */
  set(who, input, member) {
    if (!who.admin) return refuse('not_admin', 'The fleet’s routing is set by an admin. Anybody can read it.');
    const checked = checkRouting(input, this.record);
    if (!checked.ok) return refuse(checked.code, checked.text);
    for (const rule of checked.rules) {
      if (!member(rule.member)) return refuse('no_member', `The rule for ${rule.workType} names ${rule.member}, and there is no member called that.`);
    }
    this.record = { mode: checked.mode, rules: checked.rules, updatedBy: who.email || 'an admin', updatedAt: this.now() };
    this.dirty = true;
    const rules = checked.rules.length;
    const said = { off: 'Routing is off. A task with no assignee stays with nobody.', manual: 'Routing is on, and a pick among several members is asked of a person.', auto: 'Routing is on, and a pick among several members is the fleet’s model’s when it has one.' }[checked.mode];
    return { ok: true, routing: this.record, text: `${said} ${rules === 1 ? 'One rule' : `${rules} rules`} by kind of work.` };
  }

  /**
   * May one more routing ask reach the model today? Counted when it says
   * yes, before the call, so a rebuild during the call cannot forget it.
   */
  admitAsk() {
    const day = utcDay(this.now());
    if (this.asks.day !== day) this.asks = { day, n: 0 };
    if (this.asks.n >= ROUTE_ASKS_PER_DAY) return false;
    this.asks.n += 1;
    this.dirty = true;
    return true;
  }

  /** Whether anything changed since this was last asked, and forget that it did. */
  takeChange() {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  serialise() {
    return { ...this.record, asks: { ...this.asks } };
  }

  /**
   * Back from storage, checked as if a stranger wrote it. Anything that does
   * not read as a routing record is a fleet that set none.
   *
   * @param {unknown} saved
   */
  restore(saved) {
    const s = /** @type {any} */ (saved);
    const checked = checkRouting(s && typeof s === 'object' ? { mode: s.mode, rules: s.rules } : null, NO_ROUTING);
    if (!checked.ok) return;
    this.record = { mode: checked.mode, rules: checked.rules, updatedBy: typeof s.updatedBy === 'string' ? s.updatedBy.slice(0, 200) : null, updatedAt: Number(s.updatedAt) || 0 };
    const n = Number(s.asks?.n);
    if (s.asks?.day === utcDay(this.now()) && Number.isInteger(n) && n >= 0) this.asks = { day: s.asks.day, n: Math.min(n, ROUTE_ASKS_PER_DAY) };
  }
}

/** What each refusal answers with. Anything not here is a 400. */
const STATUS = Object.freeze({ not_admin: 403, no_member: 404 });

/**
 * The `/api/routing` routes, for both coordinators.
 *
 *   GET /api/routing   { routing, model, you: { admin } }
 *   PUT /api/routing   { mode?, rules? }, an admin
 *
 * Returns null for a path that is not one of these.
 *
 * @param {{ routingFor: Function, setRouting: Function }} core
 * @param {string} method @param {string} pathname
 * @param {{ email?: string|null, admin?: boolean }|null} requester
 * @param {() => Promise<any>} readBody
 * @returns {Promise<{ status: number, body: any }|null>}
 */
export async function routingRoute(core, method, pathname, requester, readBody) {
  if (pathname !== '/api/routing') return null;
  if (method === 'GET') return { status: 200, body: core.routingFor(requester) };
  if (method !== 'PUT') return { status: 405, body: { ok: false, error: 'method not allowed' } };
  const answer = core.setRouting(requester, await readBody());
  return { status: answer.ok ? 200 : (STATUS[/** @type {keyof typeof STATUS} */ (answer.error?.code)] ?? 400), body: answer };
}
