// What runs a member: the engines a member may name, the list a start
// carries, and the one way every engine ends a turn (docs/engines.md).
//
// WHY IT IS HERE AND NOT ON THE BOX. The coordinator checks a member's list
// when it is written and cuts it to what a machine runs; the box runs it;
// the MCP server prints it. One table, so the three cannot come to name
// different engines. No imports, so the Worker bundles take this file.
//
// WHAT AN ENGINE IS NOT is an account. A member has one vault and a vault
// keeps one item of each kind (`credential`, below), so a list falls back
// from one provider to another and has no second account of the same
// provider to rotate to. That is why no engine may be named twice.
//
// NEVER THROWS. Every refusal is `{ ok: false, text }`.

/**
 * The engines, in the order they were built.
 *
 * `credential` is the member's vault item the engine runs on, by the name
 * the vault keeps it under. `adapter` is how the box speaks to it:
 * `claude-code` is its own process in the session's pane, as it always was;
 * the others run behind `fleetwright-engine`, which speaks the protocol
 * named. `model` says whether a member must name one.
 */
export const ENGINES = Object.freeze({
  'claude-code': Object.freeze({ credential: 'claude', adapter: 'pane', model: 'optional', says: 'Claude Code' }),
  codex: Object.freeze({ credential: 'codex', adapter: 'codex-app-server', model: 'optional', says: 'Codex' }),
  // Required, because OpenCode's model also says whose account pays, and
  // because the check before a turn needs something to hold the engine's
  // own report against.
  opencode: Object.freeze({ credential: 'copilot', adapter: 'acp', model: 'required', says: 'OpenCode' }),
});

/** @typedef {keyof typeof ENGINES} EngineId */
/** @typedef {{ engine: string, model?: string }} EngineChoice */

export const ENGINE_IDS = /** @type {readonly string[]} */ (Object.freeze(Object.keys(ENGINES)));
/** How many engines a member names. One of each is all there are. */
export const MAX_ENGINES = 3;
/** The engine every machine runs, and the one a member has when it names none. */
export const DEFAULT_ENGINE = 'claude-code';

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
/**
 * An OpenCode model, `provider/model`. The only provider this step is GitHub
 * Copilot: every other one runs on an API key, which is a later step's
 * (docs/engines.md, "The engines").
 */
const OPENCODE_MODEL_RE = /^github-copilot\/[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/;

/** @param {string} text */
const refuse = (text) => /** @type {const} */ ({ ok: false, text });

/**
 * A member's engines, checked: up to three, each once, each with the model
 * its engine allows. Nothing named is the default, alone.
 *
 * @param {unknown} input
 * @returns {{ ok: true, engines: EngineChoice[] } | { ok: false, text: string }}
 */
export function checkEngines(input) {
  const list = input === undefined || input === null ? [{ engine: DEFAULT_ENGINE }] : input;
  if (!Array.isArray(list) || !list.length) return refuse('A member’s engines are a list, in the order to try them, with at least one.');
  if (list.length > MAX_ENGINES) return refuse(`A member names at most ${MAX_ENGINES} engines.`);
  /** @type {EngineChoice[]} */
  const out = [];
  for (const e of list) {
    const id = e && typeof e === 'object' ? String(/** @type {any} */ (e).engine ?? '') : '';
    if (!Object.hasOwn(ENGINES, id)) return refuse(`A member’s engine is one of ${ENGINE_IDS.join(', ')}.`);
    if (out.some((x) => x.engine === id)) {
      return refuse(`${id} is named twice. A member falls back from one engine to another, never to a second account of the same one.`);
    }
    const raw = /** @type {any} */ (e).model;
    const model = raw === undefined || raw === null || raw === '' ? null : String(raw);
    if (id === 'opencode') {
      if (model === null) return refuse('opencode needs a model, written provider/model, like “github-copilot/gpt-5”: the model says whose account pays.');
      if (!OPENCODE_MODEL_RE.test(model)) {
        return refuse('An opencode model is written github-copilot/<model>. Other providers run on API keys, which are not kept yet.');
      }
    } else if (model !== null && !MODEL_RE.test(model)) {
      return refuse('An engine’s model is a model name, like “opus” or a full model id.');
    }
    out.push({ engine: id, ...(model ? { model } : {}) });
  }
  return { ok: true, engines: out };
}

/** One choice as `engine` or `engine=model`. */
const choiceText = (/** @type {EngineChoice} */ e) => (e.model ? `${e.engine}=${e.model}` : e.engine);

/**
 * A list as the one line a start carries (`memberEngines`): choices joined
 * by commas, a model after `=`. No model holds either character.
 *
 * @param {EngineChoice[]} engines
 */
export function encodeEngines(engines) {
  return engines.map(choiceText).join(',');
}

/** What `memberEngines` may be, as a whole. The box reads it with `decodeEngines`, which checks each choice. */
export const ENGINES_PARAM_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]/=,-]{0,299}$/;

/**
 * The line back into a list, held to the same rules as a member's own.
 *
 * @param {unknown} text
 * @returns {{ ok: true, engines: EngineChoice[] } | { ok: false, text: string }}
 */
export function decodeEngines(text) {
  if (typeof text !== 'string' || !text) return refuse('No engines were named.');
  return checkEngines(text.split(',').map((part) => {
    const at = part.indexOf('=');
    return at < 0 ? { engine: part } : { engine: part.slice(0, at), model: part.slice(at + 1) };
  }));
}

/**
 * A member's list cut to what one machine runs, in the member's order.
 *
 * @param {EngineChoice[]} engines
 * @param {unknown} runs  the machine's `health.engines`; anything but a list is a machine from before this, which runs the default alone
 * @returns {{ kept: EngineChoice[], dropped: EngineChoice[], runs: string[] }}
 */
export function enginesOn(engines, runs) {
  const has = Array.isArray(runs) ? runs.filter((r) => typeof r === 'string' && Object.hasOwn(ENGINES, r)) : [DEFAULT_ENGINE];
  if (!has.includes(DEFAULT_ENGINE)) has.unshift(DEFAULT_ENGINE);
  return { kept: engines.filter((e) => has.includes(e.engine)), dropped: engines.filter((e) => !has.includes(e.engine)), runs: has };
}

/** Is this the list a host from before engines already runs: the default, alone, with no model named? */
export function isPlainDefault(/** @type {EngineChoice[]} */ engines) {
  return engines.length === 1 && engines[0].engine === DEFAULT_ENGINE && !engines[0].model;
}

/** How a list is said: “Claude Code, then Codex (gpt-5.1-codex)”. */
export function enginesWords(/** @type {EngineChoice[]} */ engines) {
  return engines.map((e) => `${ENGINES[/** @type {EngineId} */ (e.engine)]?.says ?? e.engine}${e.model ? ` (${e.model})` : ''}`).join(', then ');
}

// ── One event ───────────────────────────────────────────────────────────────

/** Why a turn ended (docs/engines.md, "One event: TurnEnded"). */
export const TURN_REASONS = Object.freeze(['done', 'limit', 'auth', 'model', 'refused', 'cut', 'cancelled', 'error']);
/**
 * The endings another engine is the answer to. A limit, a sign-in that is
 * not there, and a model that is not the one asked for are all "this
 * provider cannot do this turn now". A refusal is not, and neither is a
 * failure nobody understands: neither is retried on somebody else's account.
 */
export const HANDS_ON = Object.freeze(['limit', 'auth', 'model']);

/**
 * @typedef {object} TurnEnded
 * @property {string} engine
 * @property {'done'|'limit'|'auth'|'model'|'refused'|'cut'|'cancelled'|'error'} reason
 * @property {string|null} detail    the engine's own first line about it, bounded
 * @property {string|null} model     the model the engine said it ran, when it said
 * @property {{ input: number, output: number }|null} usage  tokens as the engine counted them
 * @property {number|null} resetsAt  epoch ms a limit lifts, when the engine said
 */

/**
 * Words that mean an account's limit, for the engines with no field for it
 * (Claude Code's StopFailure, an ACP agent's error). Mirrored in
 * sandbox/engine.mjs, which a session's image carries alone;
 * test/engines.test.js says if the two stop agreeing. A limit worded some
 * way nobody has seen is an `error`, and hands nothing on: the safe side.
 */
export const LIMIT_WORDS = /rate.?limit|usage.?limit|quota|too many requests|\b429\b|credit balance|limit (?:reached|exceeded)|out of (?:credits|usage)/i;
/** Words that mean the sign-in is missing or ended. Mirrored the same way. */
export const AUTH_WORDS = /not (?:logged|signed) in|unauthori[sz]ed|authentication|\b401\b|invalid (?:api key|token|credentials)|(?:token|credentials|session) (?:has |have )?expired|log ?in required|please (?:log|sign) in/i;

/**
 * Claude Code's own two hooks, as a TurnEnded. `Stop` is a turn that ended;
 * `StopFailure` is one that ended on an error, whose first line is `detail`.
 * Any other hook is not a turn's end.
 *
 * @param {string} event @param {string|null} [detail]
 * @returns {TurnEnded|null}
 */
export function turnFromHook(event, detail = null) {
  if (event === 'Stop') return { engine: DEFAULT_ENGINE, reason: 'done', detail: null, model: null, usage: null, resetsAt: null };
  if (event !== 'StopFailure') return null;
  const said = String(detail ?? '');
  const reason = LIMIT_WORDS.test(said) ? 'limit' : AUTH_WORDS.test(said) ? 'auth' : 'error';
  return { engine: DEFAULT_ENGINE, reason, detail: line(detail, 200), model: null, usage: null, resetsAt: null };
}

/** One line, printable, at most `max`. */
function line(/** @type {unknown} */ v, /** @type {number} */ max) {
  if (v === undefined || v === null) return null;
  const s = String(v).split('\n')[0].replace(/[^\x20-\x7e]/g, '').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * A TurnEnded from anywhere, as the shape above or null: an engine this
 * does not know, or a reason that is not one, is not a turn's end.
 *
 * It arrives over a session's socket, from a process inside the session, so
 * every field is held to a type and a bound. What it can do with a lie is
 * put a wrong word on a screen, or start the member's own next engine.
 *
 * @param {unknown} value
 * @returns {TurnEnded|null}
 */
export function cleanTurn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = /** @type {Record<string, any>} */ (value);
  if (!Object.hasOwn(ENGINES, String(v.engine)) || !TURN_REASONS.includes(v.reason)) return null;
  const count = (/** @type {unknown} */ n) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 1_000_000_000 ? n : null);
  const input = count(v.usage?.input);
  const output = count(v.usage?.output);
  const resetsAt = typeof v.resetsAt === 'number' && Number.isFinite(v.resetsAt) && v.resetsAt > 0 && v.resetsAt < 4_102_444_800_000 ? Math.round(v.resetsAt) : null;
  return {
    engine: String(v.engine),
    reason: v.reason,
    detail: line(v.detail, 200),
    model: line(v.model, 80),
    usage: input !== null && output !== null ? { input, output } : null,
    resetsAt,
  };
}

/**
 * Why a turn ended, as a sentence a person reads on a session or a task.
 *
 * @param {TurnEnded} turn
 */
export function turnWords(turn) {
  const who = ENGINES[/** @type {EngineId} */ (turn.engine)]?.says ?? turn.engine;
  const lifts = turn.resetsAt ? ` It says the limit lifts at ${new Date(turn.resetsAt).toISOString().replace('T', ' ').slice(0, 16)} UTC.` : '';
  switch (turn.reason) {
    case 'done': return `${who} finished its turn.`;
    case 'limit': return `${who} stopped at its account’s limit.${lifts}`;
    case 'auth': return `${who} is not signed in on this machine, or its sign-in has ended.`;
    case 'model': return `${who} was not on the model that was asked for${turn.model ? `: it said ${turn.model}` : ', or did not say which it was on'}, so nothing was asked of it.`;
    case 'refused': return `${who}’s provider declined the work.`;
    case 'cut': return `${who} ran out of room in its turn.`;
    case 'cancelled': return `${who}’s turn was stopped.`;
    default: return `${who} stopped on an error${turn.detail ? `: ${turn.detail}` : ''}.`;
  }
}
