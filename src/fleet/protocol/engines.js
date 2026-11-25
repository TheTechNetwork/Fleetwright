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
/**
 * The engines a machine signs in on itself, with the engine's own device
 * code (docs/engines.md, "Signing in on the machine"). Claude Code is not
 * one: its sign-in is the vault's.
 */
export const SIGNIN_ENGINES = Object.freeze(['codex', 'opencode']);
/**
 * How an attempt to sign one in, or a sign-in, last ended on a machine: what
 * a box keeps, reports and says in `engine.signin`. `waiting` and `none` are
 * answered to whoever asks and are never one of these.
 */
export const SIGNIN_OUTCOMES = Object.freeze(['signed_in', 'expired', 'failed', 'cancelled', 'lost', 'signed_out', 'ended']);

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
/**
 * The providers an engine may run on with a metered API key
 * (docs/api-engines.md). `opencode` is OpenCode's own name for the
 * provider, which is the prefix of a model and the entry its key is filed
 * under; `item` is the member's vault item; `env` is the variable
 * OpenCode's documentation names for the key, where it names one.
 *
 * Mirrored in sandbox/engine.mjs, which a session's image carries alone;
 * test/api-engines.test.js says if the two stop agreeing.
 */
export const API_PROVIDERS = Object.freeze({
  openrouter: Object.freeze({ says: 'OpenRouter', opencode: 'openrouter', item: 'apikey:openrouter', env: 'OPENROUTER_API_KEY' }),
  'ai-gateway': Object.freeze({ says: 'Vercel AI Gateway', opencode: 'vercel', item: 'apikey:ai-gateway', env: null }),
});
export const API_PROVIDER_IDS = /** @type {readonly string[]} */ (Object.freeze(Object.keys(API_PROVIDERS)));
/** The vault items API keys are kept under. */
export const API_KEY_ITEMS = /** @type {readonly string[]} */ (Object.freeze(Object.values(API_PROVIDERS).map((p) => p.item)));

/**
 * An OpenCode model, `provider/model`. GitHub Copilot's is one name. An API
 * provider's is that provider's own model id, which may itself hold a
 * slash (`openrouter/anthropic/claude-sonnet-5.5`). No model holds a comma
 * or an equals sign, which is what lets a list travel as one line.
 */
const OPENCODE_COPILOT_RE = /^github-copilot\/[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/;
const OPENCODE_API_RE = new RegExp(`^(?:${Object.values(API_PROVIDERS).map((p) => p.opencode).join('|')})/[A-Za-z0-9][A-Za-z0-9._:-]{0,39}(?:/[A-Za-z0-9][A-Za-z0-9._:-]{0,39}){0,2}$`);

/**
 * The API provider a choice bills to, or null: a subscription engine bills
 * to nobody here.
 *
 * @param {{ engine: string, model?: string }|null|undefined} choice
 * @returns {string|null} a key of API_PROVIDERS
 */
export function providerOf(choice) {
  if (choice?.engine !== 'opencode' || typeof choice.model !== 'string') return null;
  const prefix = choice.model.split('/')[0];
  return API_PROVIDER_IDS.find((id) => API_PROVIDERS[/** @type {keyof typeof API_PROVIDERS} */ (id)].opencode === prefix) ?? null;
}

/**
 * The member's vault item a choice runs on: the engine's own, or the key of
 * the provider its model names.
 *
 * @param {{ engine: string, model?: string }|null|undefined} choice
 * @returns {string|null}
 */
export function credentialOf(choice) {
  const provider = providerOf(choice);
  if (provider) return API_PROVIDERS[/** @type {keyof typeof API_PROVIDERS} */ (provider)].item;
  return ENGINES[/** @type {keyof typeof ENGINES} */ (String(choice?.engine))]?.credential ?? null;
}

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
      // The example is a model OpenCode's catalog lists for Copilot
      // (models.dev). It is an example: the account's own list decides, and
      // the box finds out before a turn (docs/engines.md, "Before a turn").
      if (model === null) return refuse('OpenCode needs a model, written provider/model, like “github-copilot/claude-sonnet-5.5”: the model says whose account pays.');
      if (model.length > 120) return refuse('That model’s name is too long to be one.');
      if (!OPENCODE_COPILOT_RE.test(model) && !OPENCODE_API_RE.test(model)) {
        return refuse(`An OpenCode model is written github-copilot/<model>, or ${Object.values(API_PROVIDERS).map((p) => `${p.opencode}/<model>`).join(' or ')} for one that runs on an API key.`);
      }
    } else if (model !== null && !MODEL_RE.test(model)) {
      return refuse('An engine’s model is a model name, like “opus” or a full model id.');
    }
    out.push({ engine: id, ...(model ? { model } : {}) });
  }
  // THE WHOLE LIST TRAVELS AS ONE LINE on a start (`memberEngines`), and a
  // box takes a line of at most 300 characters. Three long model names can
  // pass each on its own and not fit together, and a record that every
  // start would then be refused for is refused here, where it is written.
  if (encodeEngines(out).length > MAX_ENGINES_LINE) {
    return refuse(`Those engines’ model names are too long together: written as one line they are ${encodeEngines(out).length} characters, and a machine takes ${MAX_ENGINES_LINE}. Shorten a model’s name or name fewer engines.`);
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

/** How long `memberEngines` may be, as a box from protocol 21 on checks it. */
export const MAX_ENGINES_LINE = 300;
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
 * An engine on an API key is kept only for a machine that reports that
 * provider (docs/api-engines.md). A machine that reports none, which is
 * every machine from before API keys, is never sent one.
 *
 * @param {EngineChoice[]} engines
 * @param {unknown} runs  the machine's `health.engines`; anything but a list is a machine from before this, which runs the default alone
 * @param {unknown} [apiProviders]  the machine's `health.apiProviders`
 * @returns {{ kept: EngineChoice[], dropped: EngineChoice[], runs: string[], providers: string[] }}
 */
export function enginesOn(engines, runs, apiProviders = null) {
  const has = Array.isArray(runs) ? runs.filter((r) => typeof r === 'string' && Object.hasOwn(ENGINES, r)) : [DEFAULT_ENGINE];
  if (!has.includes(DEFAULT_ENGINE)) has.unshift(DEFAULT_ENGINE);
  const providers = Array.isArray(apiProviders) ? apiProviders.filter((p) => typeof p === 'string' && API_PROVIDER_IDS.includes(p)) : [];
  const runsIt = (/** @type {EngineChoice} */ e) => {
    if (!has.includes(e.engine)) return false;
    const provider = providerOf(e);
    return provider === null || providers.includes(provider);
  };
  return { kept: engines.filter(runsIt), dropped: engines.filter((e) => !runsIt(e)), runs: has, providers };
}

/** Is any engine in this list on a metered API key? */
export function anyPaid(/** @type {EngineChoice[]|null|undefined} */ engines) {
  return (engines ?? []).some((e) => providerOf(e) !== null);
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
 * An account out of money is at its limit, in each provider's own wording
 * (the runner's copy says whose).
 */
export const LIMIT_WORDS = /rate.?limit|usage.?limit|quota|too many requests|\b429\b|credit balance|limit (?:reached|exceeded)|out of (?:credits|usage)|insufficient (?:credits?|funds|balance)|more credits|payment.?required|\b402\b|exceeded your [a-z ]{0,40}allowance/i;
/** Words that mean the sign-in is missing or ended. Mirrored the same way. */
export const AUTH_WORDS = /not (?:logged|signed) in|unauthori[sz]ed|authentication|\b401\b|invalid (?:api key|token|credentials)|(?:token|credentials|session) (?:has |have )?expired|log ?in required|please (?:log|sign) in/i;

/**
 * Claude Code's own names for why a turn failed, as reasons: the `error`
 * field its StopFailure hook is given
 * (https://code.claude.com/docs/en/hooks, "StopFailure input"), which the
 * session's hook sends as `detail` (sandbox/hook.mjs).
 *
 * An account that cannot pay is at its limit, and one that is on hold, not
 * allowed by its organization, or whose cloud credential did not load has
 * no sign-in this turn can use. Those four were read by their words alone
 * and came out `error`, so nothing was handed on. `server_error` (which is
 * also an overloaded provider), `invalid_request` and `unknown` are not
 * here: they are errors.
 */
const CLAUDE_ERRORS = Object.freeze(/** @type {Record<string, TurnEnded['reason']>} */ ({
  rate_limit: 'limit',
  billing_error: 'limit',
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  cloud_credential_error: 'auth',
  model_not_found: 'model',
  max_output_tokens: 'cut',
}));

/**
 * Claude Code's own two hooks, as a TurnEnded. `Stop` is a turn that ended;
 * `StopFailure` is one that ended on an error, whose `detail` is Claude
 * Code's name for the error, or from a version that sent none, the error's
 * first line, which is read by its words. Any other hook is not a turn's end.
 *
 * @param {string} event @param {string|null} [detail]
 * @returns {TurnEnded|null}
 */
export function turnFromHook(event, detail = null) {
  if (event === 'Stop') return { engine: DEFAULT_ENGINE, reason: 'done', detail: null, model: null, usage: null, resetsAt: null };
  if (event !== 'StopFailure') return null;
  const said = String(detail ?? '');
  const named = Object.hasOwn(CLAUDE_ERRORS, said.trim()) ? CLAUDE_ERRORS[said.trim()] : null;
  const reason = named ?? (LIMIT_WORDS.test(said) ? 'limit' : AUTH_WORDS.test(said) ? 'auth' : 'error');
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
