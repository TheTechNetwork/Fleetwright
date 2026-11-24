// Machines from a sandbox provider's cloud, behind the seam the two
// hypervisors share (pools.js). docs/api-engines.md, "A machine from a
// sandbox provider".
//
// A THIRD DRIVER, NOT A THIRD DESIGN. To the sidecar, the coordinator and
// both phones this is one more place a machine image can be: it reports the
// shape xo-pools.js and pve-pools.js report, and answers the same verbs.
// What differs is where the machine is and what holds it.
//
// WHAT HOLDS IT IS AN API KEY, which is the provider's whole account. So it
// reaches a box only when the box's operator named the provider and the box
// asked the vault for sandbox items; it is held here in memory, never
// written, never reported and never logged; and it is taken out of the
// vault's answer before the hub sees it, as hypervisor tokens are.
//
// ONE PROVIDER, E2B, from its API reference as read on 24 November 2026:
//
//   POST   /v2/sandboxes              { templateID, timeout, metadata, envVars }  → 201 { sandboxID, … }
//   GET    /v2/sandboxes?metadata=…   → 200 [ { sandboxID, templateID, endAt, state, metadata } ]
//   POST   /sandboxes/{id}/timeout    { timeout }                                → 204
//   DELETE /sandboxes/{id}            → 204
//
// each with `X-API-Key`. Another provider is a row in SANDBOX_PROVIDERS and
// four small functions, not another file.
//
// NOTHING HERE HAS CALLED THE PROVIDER. Every path is run against a server
// that stands in for it (test/sandbox-pools.test.js).
//
// A SANDBOX IS A MACHINE ONLY IF ITS TEMPLATE ENROLS. This starts a template
// with the ticket and the coordinator's address in its environment, and
// trusts the template to run the fleet's installer and join with them.
// Building such a template is not automated: the doc says what one must do.

import { createHash } from 'node:crypto';
import { SANDBOX_ITEM, MAX_SANDBOX_TEMPLATES, sandboxRecord, isSandboxItem } from '../protocol/sandboxes.js';

export { SANDBOX_ITEM, MAX_SANDBOX_TEMPLATES, sandboxRecord, isSandboxItem };
export const SANDBOX_KIND = 'sandbox';

const TICKET_RE = /^fwt_([0-9a-f]{12})_[0-9a-f]{48}$/;
const NAME_RE = /^vm-[0-9a-f]{12}$/;
const DEFAULT_MINUTES = 60;
/** The longest a machine is made or extended for, as on a hypervisor (xo-pools.js). */
export const SANDBOX_MAX_MINUTES = 350;
/** How long any one request to a provider may take. */
const REQUEST_MS = 20_000;

/**
 * The providers. `base` is where its API answers; `says` is its name on a
 * screen. The four calls are the functions below, which read the base and
 * nothing else of a row, so a second provider with another API is a second
 * set of functions chosen by `api`.
 */
export const SANDBOX_PROVIDERS = Object.freeze({
  e2b: Object.freeze({ says: 'E2B', base: 'https://api.e2b.app', api: 'e2b' }),
});

/**
 * @typedef {import('../protocol/sandboxes.js').SandboxRecord} SandboxRecord
 * @typedef {{ id: string, name: string, template: string }} SandboxImage
 */

/**
 * A UUID for a template, from the provider and the template's own id, so a
 * sandbox template is an image id like any other and the coordinator never
 * knows which kind it is. Only a box that saw it turns it back, by looking
 * it up in what it holds (`make`).
 *
 * @param {string} provider @param {string} template
 */
export function sandboxImageId(provider, template) {
  const h = createHash('sha256').update(`sandbox\0${provider}\0${template}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** One printable line of a provider's own words, bounded: an error body could be anything. */
function line(/** @type {unknown} */ v) {
  return String(v ?? '').split('\n')[0].replace(/[^\x20-\x7e]/g, '').trim().slice(0, 160);
}

export class SandboxPools {
  /**
   * @param {{ providers?: string[], fetchImpl?: typeof fetch, now?: () => number, log?: { info: Function, warn: Function }, base?: Record<string, string> }} [opts]
   *   `providers` is what this box's operator turned on; with none this holds
   *   nothing and reports nothing. `base` replaces a provider's address, for
   *   the stand-in a test runs.
   */
  constructor({ providers = [], fetchImpl = fetch, now = () => Date.now(), log = { info() {}, warn() {} }, base = {} } = {}) {
    this.allowed = [...new Set(providers.map((p) => String(p).trim().toLowerCase()).filter((p) => Object.hasOwn(SANDBOX_PROVIDERS, p)))];
    this.fetch = fetchImpl;
    this.now = now;
    this.log = log;
    this.base = base;
    /** @type {Map<string, { owner: string, record: SandboxRecord }>} `owner provider` */
    this.held = new Map();
    /** What each was last seen as. @type {Map<string, any>} */
    this.seen = new Map();
  }

  /** Whether this box takes sandbox items at all: what it tells the vault it accepts. */
  get takes() {
    return this.allowed.length > 0;
  }

  /** @param {string} owner */
  holdsFor(owner) {
    const who = String(owner || '').toLowerCase();
    return [...this.held.values()].some((h) => h.owner === who);
  }

  /**
   * Keep the sandbox records in a vault answer, for the providers this box's
   * operator turned on, and take every `sandbox:` item out of the answer:
   * the hub files what it is handed, and a provider's key is not something
   * to file.
   *
   * @param {Array<{ email: string, items?: Array<{ name: string, value?: string }> }>} accounts
   */
  adopt(accounts) {
    /** @type {Map<string, { owner: string, record: SandboxRecord }>} */
    const held = new Map();
    const out = (Array.isArray(accounts) ? accounts : []).map((a) => {
      const owner = String(a?.email || '').toLowerCase();
      const items = Array.isArray(a?.items) ? a.items : [];
      for (const i of items) {
        const record = owner ? sandboxRecord(String(i?.name || ''), i?.value) : null;
        if (record && this.allowed.includes(record.provider)) held.set(`${owner} ${record.provider}`, { owner, record });
      }
      return items.some((i) => isSandboxItem(i?.name)) ? { ...a, items: items.filter((i) => !isSandboxItem(i?.name)) } : a;
    });
    for (const k of [...this.seen.keys()]) if (!held.has(k)) this.seen.delete(k);
    const added = [...held.keys()].filter((k) => !this.held.has(k));
    this.held = held;
    if (added.length) this.log.info(`sidecar: holding a sandbox provider’s key for ${added.map((k) => k.split(' ')[1]).join(', ')}`);
    return out;
  }

  /** @param {SandboxRecord} record @returns {SandboxImage[]} */
  #images(record) {
    return record.templates.map((t) => ({ id: sandboxImageId(record.provider, t.id), name: t.name, template: t.id }));
  }

  /** For the health frame, in the shape the hypervisor drivers report, with `kind`. Never the key. */
  report() {
    return [...this.held.entries()].map(([k, h]) => this.seen.get(k) ?? this.#entry(h, { reachable: null, machines: [] }));
  }

  /** @param {{ owner: string, record: SandboxRecord }} h @param {{ reachable: boolean|null, machines: any[], problem?: string }} now */
  #entry(h, now) {
    const provider = SANDBOX_PROVIDERS[/** @type {keyof typeof SANDBOX_PROVIDERS} */ (h.record.provider)];
    return {
      address: h.record.provider,
      owner: h.owner,
      kind: SANDBOX_KIND,
      provider: provider.says,
      reachable: now.reachable,
      pools: [],
      images: this.#images(h.record).map(({ id, name }) => ({ id, name })),
      networks: [],
      machines: now.machines,
      ...(now.problem ? { problem: now.problem } : {}),
    };
  }

  /** Whether this box holds a record of this person's that offers the image. @param {string} owner @param {string} template */
  hasImage(owner, template) {
    const who = String(owner || '').toLowerCase();
    return [...this.held.values()].some((h) => h.owner === who && this.#images(h.record).some((i) => i.id === template));
  }

  /**
   * One request to a provider. Answers the status and the body read as JSON
   * when it is JSON. Throws only what `fetch` throws.
   *
   * @param {SandboxRecord} record @param {string} method @param {string} path @param {unknown} [body] @param {Record<string, string>} [headers]
   */
  async #call(record, method, path, body, headers = {}) {
    const provider = SANDBOX_PROVIDERS[/** @type {keyof typeof SANDBOX_PROVIDERS} */ (record.provider)];
    const base = this.base[record.provider] ?? provider.base;
    const res = await this.fetch(`${base}${path}`, {
      method,
      headers: { 'X-API-Key': record.key, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_MS),
      // A provider that redirects is not sent this account's key somewhere else.
      redirect: 'error',
    });
    /** @type {any} */
    let read = null;
    try {
      read = await res.json();
    } catch { /* 204, or not JSON: the status is the answer */ }
    // A PROVIDER'S OWN WORDS REACH A SCREEN (#why), and an error that quoted
    // the key back would put the key there. Taken out here, where every
    // answer passes, so no caller has to remember to.
    if (read && typeof read === 'object' && typeof read.message === 'string') read.message = read.message.split(record.key).join('[the key]');
    return { status: res.status, body: read };
  }

  /** Why a provider refused, in its own first line, bounded. @param {{ status: number, body: any }} r */
  #why(r) {
    const said = line(r.body?.message);
    if (r.status === 401 || r.status === 403) return `it refused the key (${r.status}${said ? `: ${said}` : ''})`;
    if (r.status === 429) return 'it is being asked too often just now';
    return `it answered ${r.status}${said ? `: ${said}` : ''}`;
  }

  /** The sandboxes this fleet made for this person at this provider, as machines. @param {{ owner: string, record: SandboxRecord }} h */
  async #machines(h) {
    // FOUND BY THEIR OWN MARK: the account may hold sandboxes this fleet
    // never made, and those are not machines of anybody's here.
    const r = await this.#call(h.record, 'GET', `/v2/sandboxes?metadata=${encodeURIComponent(`fleetwright=1&owner=${h.owner}`)}&limit=100`);
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(this.#why(r));
    return r.body
      .filter((/** @type {any} */ s) => s && typeof s.sandboxID === 'string' && NAME_RE.test(String(s.metadata?.name ?? '')) && String(s.metadata?.owner ?? '') === h.owner)
      .map((/** @type {any} */ s) => {
        const until = Date.parse(String(s.endAt ?? ''));
        const template = h.record.templates.find((t) => t.id === s.templateID || t.id === s.alias);
        const made = Date.parse(String(s.startedAt ?? ''));
        // A MACHINE AS A HYPERVISOR'S DRIVER REPORTS ONE, so every screen
        // that lists machines lists these with no new case: the same names
        // for state, when it ends and when it was made, in milliseconds.
        // `id` is the provider's own, which ending and extending are asked
        // by; the coordinator does not pass it on.
        return {
          name: String(s.metadata.name),
          id: String(s.sandboxID),
          state: s.state === 'running' ? 'Running' : s.state === 'paused' ? 'Paused' : null,
          until: Number.isFinite(until) ? until : null,
          madeAt: Number.isFinite(made) ? made : null,
          cpus: Number.isInteger(s.cpuCount) ? s.cpuCount : null,
          memory: Number.isFinite(Number(s.memoryMB)) && Number(s.memoryMB) > 0 ? Number(s.memoryMB) * 1024 * 1024 : null,
          image: template ? template.name : null,
        };
      });
  }

  /** Ask each provider what it has. One that does not answer is kept as not reachable, with why. */
  async refresh() {
    await Promise.all([...this.held.entries()].map(async ([k, h]) => {
      try {
        this.seen.set(k, this.#entry(h, { reachable: true, machines: await this.#machines(h) }));
      } catch (e) {
        this.seen.set(k, this.#entry(h, { reachable: false, machines: [], problem: line(/** @type {Error} */ (e)?.message) || 'it did not answer' }));
      }
    }));
  }

  /**
   * Make a machine from a template, for the person whose key it is, started
   * with a ticket to enrol itself. The answers are the hypervisor drivers'.
   *
   * @param {{ owner: string, template: string, ticket: string, minutes?: number|null, network?: string|null, group?: string|null, lab?: boolean, coordinatorUrl: string }} ask
   */
  async make({ owner, template, ticket, minutes = null, network = null, group = null, lab = false, coordinatorUrl }) {
    const who = String(owner || '').toLowerCase();
    const m = TICKET_RE.exec(String(ticket || ''));
    if (!m) return { ok: false, text: 'That machine came without the ticket it enrols with, so it was not made.' };
    const found = [...this.held.values()].find((h) => h.owner === who && this.#images(h.record).some((i) => i.id === template));
    if (!found) return { ok: false, text: 'This machine holds no sandbox provider of yours with that template.' };
    const says = SANDBOX_PROVIDERS[/** @type {keyof typeof SANDBOX_PROVIDERS} */ (found.record.provider)].says;
    // A SANDBOX IS ON THE PROVIDER'S NETWORK AND NO OTHER. A network, a group
    // or a lab is a thing of a pool's, and asking for one here is a mistake
    // to say, not to ignore: the machine would not be where it was asked to be.
    if (network || group || lab) return { ok: false, text: `A machine at ${says} is on ${says}’s own network. It joins no network, group or lab of a pool’s, so it was not made.` };
    if (!/^https:\/\//.test(String(coordinatorUrl || ''))) return { ok: false, text: 'This machine does not know the fleet’s address to give the new one, so it was not made.' };
    const image = /** @type {SandboxImage} */ (this.#images(found.record).find((i) => i.id === template));
    const name = `vm-${m[1]}`;
    const life = Math.max(5, Math.min(SANDBOX_MAX_MINUTES, Number(minutes) || DEFAULT_MINUTES));
    let r;
    try {
      r = await this.#call(found.record, 'POST', '/v2/sandboxes', {
        templateID: image.template,
        timeout: life * 60,
        // WHAT THE TEMPLATE ENROLS WITH, and nothing else: no sign-in, no key.
        envVars: { FLEETWRIGHT_TICKET: ticket, FLEETWRIGHT_COORDINATOR: coordinatorUrl },
        metadata: { fleetwright: '1', name, owner: who },
      // THE SAME TICKET IS THE SAME MACHINE: a retry of this request makes
      // nothing new. The key is the ticket's public half, never its secret.
      }, { 'Idempotency-Key': `fleetwright-${m[1]}` });
    } catch (e) {
      return { ok: false, unreachable: true, text: `${says} could not be reached from here, so whether ${name} was made is not known: ${line(/** @type {Error} */ (e)?.message) || 'no answer'}. Look at Machines before trying again.` };
    }
    if (r.status !== 201 && r.status !== 200) return { ok: false, text: `${says} did not make the machine: ${this.#why(r)}.` };
    if (typeof r.body?.sandboxID !== 'string') return { ok: false, text: `${says} answered without the machine’s id, so it may have been made and cannot be named. Look at your ${says} dashboard.` };
    this.log.info(`sidecar: made ${name} at ${found.record.provider} for ${who}, for ${life} minutes`);
    return {
      ok: true,
      name,
      minutes: life,
      text: `Made ${name} at ${says}, for ${life} minutes. It joins when its template has started and enrolled; a template that does not enrol leaves it running there until its time is up.`,
    };
  }

  /**
   * Find one of this person's machines, at whichever provider has it.
   *
   * @param {string} who @param {string} name
   * @returns {Promise<{ found: { h: { owner: string, record: SandboxRecord }, machine: any }|null, unreachable: string[], held: number }>}
   */
  async #find(who, name) {
    /** @type {string[]} */
    const unreachable = [];
    const mine = [...this.held.values()].filter((h) => h.owner === who);
    for (const h of mine) {
      try {
        const machine = (await this.#machines(h)).find((x) => x.name === name);
        if (machine) return { found: { h, machine }, unreachable, held: mine.length };
      } catch (e) {
        unreachable.push(`${SANDBOX_PROVIDERS[/** @type {keyof typeof SANDBOX_PROVIDERS} */ (h.record.provider)].says} (${line(/** @type {Error} */ (e)?.message)})`);
      }
    }
    return { found: null, unreachable, held: mine.length };
  }

  /**
   * End a machine, or give it more time. A sandbox has no restart and no
   * resize, and saying so is the answer to being asked for one.
   *
   * @param {{ owner: string, name: string, action: string, minutes?: number|null }} ask
   */
  async control({ owner, name, action, minutes = null }) {
    const who = String(owner || '').toLowerCase();
    if (!NAME_RE.test(String(name))) return { ok: false, text: 'That is not the name of a machine this fleet made.' };
    if (!this.holdsFor(who)) return { ok: false, notHere: true, text: 'This machine holds no sandbox provider of yours.' };
    const { found, unreachable, held } = await this.#find(who, String(name));
    if (!found) {
      return unreachable.length
        ? { ok: false, unreachable: true, text: unreachable.length === held ? `Your sandbox providers could not be reached from here: ${unreachable.join('; ')}` : `${name} is not at the providers of yours that answered, and the rest could not be reached: ${unreachable.join('; ')}` }
        : { ok: false, notHere: true, text: `${name} is not at any sandbox provider of yours this machine holds.` };
    }
    const { h, machine } = found;
    const says = SANDBOX_PROVIDERS[/** @type {keyof typeof SANDBOX_PROVIDERS} */ (h.record.provider)].says;
    try {
      if (action === 'stop') {
        const r = await this.#call(h.record, 'DELETE', `/sandboxes/${encodeURIComponent(machine.id)}`);
        // Gone already is ended.
        if (r.status !== 204 && r.status !== 404) return { ok: false, text: `${says} did not end ${name}: ${this.#why(r)}.` };
        return { ok: true, text: `Ended ${name}. ${says} has removed it.` };
      }
      if (action === 'extend') {
        const more = Math.max(5, Math.min(SANDBOX_MAX_MINUTES, Number(minutes) || DEFAULT_MINUTES));
        // The provider's timeout counts from now, not from when it would have ended.
        const r = await this.#call(h.record, 'POST', `/sandboxes/${encodeURIComponent(machine.id)}/timeout`, { timeout: more * 60 });
        if (r.status !== 204 && r.status !== 200) return { ok: false, text: `${says} did not extend ${name}: ${this.#why(r)}.` };
        return { ok: true, minutes: more, text: `${name} now ends ${more} minutes from now.` };
      }
    } catch (e) {
      return { ok: false, unreachable: true, text: `${says} could not be reached from here: ${line(/** @type {Error} */ (e)?.message) || 'no answer'}.` };
    }
    return { ok: false, text: `A machine at ${says} can be ended or given more time. It has no ${action === 'reboot' ? 'restart' : action === 'resize' ? 'resize' : `“${line(action).slice(0, 20)}”`}.` };
  }

  /**
   * Hand a person's Claude sign-in to one of their machines. Never, here: a
   * sandbox is given nothing after it is made, and what a machine on a
   * provider's cloud holds, the provider can read (docs/api-engines.md).
   *
   * @param {{ owner: string, name: string }} ask
   */
  async handLogin({ owner, name }) {
    if (!this.holdsFor(owner)) return { ok: false, notHere: true, text: 'This machine holds no sandbox provider of yours.' };
    return { ok: false, text: `${NAME_RE.test(String(name)) ? name : 'That machine'} is at a sandbox provider, and a sign-in is not handed to a machine on somebody else’s cloud from here. It runs on what its own template was given.` };
  }
}
