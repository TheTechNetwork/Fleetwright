// The intent protocol — the contract between the coordinator and a fleet host.
//
// §5's principle, and the reason this exists before anything that would use it:
// the coordinator sends INTENTS, never commands. Down the socket goes
//
//     {v: 1, kind: "intent", id: "…", verb: "resume", params: {name: "bigjob", choice: "summary"}}
//
// and never a shell string, never a command line, never a path.
//
// The failure this is designed against is not a bug in the coordinator — it is
// the coordinator being compromised outright (a bad deploy, a leaked API token,
// a dependency) while it is driving root-capable boxes. With a fixed verb set
// the blast radius of that is "someone started and stopped some sessions". With
// command strings it is every box in the fleet. It costs almost nothing now and
// cannot be retrofitted once something is passing strings, which is why it is
// the first thing built.
//
// WHERE THE AUTHORITY LIVES
//
// One module, two roles, and only one of them is in the trust path.
//
// The COORDINATOR imports it to build well-formed intents and catch its own
// mistakes before they reach the wire. That is a convenience, not a control — a
// compromised coordinator would simply not call it.
//
// The SIDECAR (`src/fleet/host/sidecar.js`) imports it to validate everything that
// arrives, and THAT is the control. It runs on the host, in a different process
// on a different machine from the coordinator, and it re-validates every field
// rather than trusting a flag or a signature over a payload it did not itself
// parse. Sharing a source file across that boundary is fine; sharing trust
// across it is not.
//
// Behind the sidecar there is a second allowlist — agent-hub's own command
// registry — but do not lean on it. `POST /api/command` runs whatever line it
// is handed, `/login` included, and the sidecar holds the token. The verb set
// below is what stands between a compromised coordinator and that endpoint.
//
// `v` is how the two ends stay in step: change the table, bump the version.
//
// See docs/intents.md for the wire format and the reasoning in full.

export const PROTOCOL_VERSION = 1;

/**
 * Session names, matching agent-hub's charset (`src/core/names.js`).
 *
 * The leading character MUST be alphanumeric, and that is load-bearing rather
 * than cosmetic. agent-hub's command parser treats any whitespace-separated
 * token beginning with `--` as a flag, so a session named `--dangerous` would
 * turn `/stop --dangerous` into a flag with no argument. Anchoring the first
 * character is what makes "a name can never become a flag" true by
 * construction instead of by careful quoting downstream.
 */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** Idempotency keys. Opaque to us — a uuid, a ULID, whatever the coordinator
 * mints — but bounded and charset-checked, because it is used as a map key and
 * echoed back in replies. */
const ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Actor ids, e.g. "telegram:12345" — or, since sign-in, a verified email
 * address, which is what makes `+` load-bearing: plus-addressing is ordinary
 * (eli+fleet@thetech.network) and without it every intent from that person's
 * phone was refused as a bad envelope. The set stays a deliberate allowlist
 * rather than "anything", because this ends up in a state file and in logs. */
const ACTOR_RE = /^[A-Za-z0-9._:@+-]{1,128}$/;

/**
 * @typedef {object} ParamSpec
 * @property {'name'|'enum'|'int'} type
 * @property {boolean} required
 * @property {string[]} [values]  for 'enum'
 * @property {number} [min]       for 'int'
 * @property {number} [max]       for 'int'
 */

/**
 * @typedef {object} VerbSpec
 * @property {Record<string, ParamSpec>} params
 * @property {boolean} mutating   changes host state → needs an idempotency key honoured
 * @property {string} summary
 */

/**
 * THE FIXED VERB SET.
 *
 * Adding a verb is a deliberate act with a version bump, not a convenience. Two
 * exclusions are deliberate and worth stating outright, because both look like
 * oversights:
 *
 *  - **No `login` / `code`.** agent-hub can authenticate its own box from chat,
 *    and that is genuinely useful there. Reachable from the coordinator it
 *    would mean a compromised Worker can point a box at an attacker's Claude
 *    account, or harvest the authorization code mid-flow. That is far outside
 *    "started and stopped some sessions", and it is not worth the blast radius
 *    to save an SSH session on a box that needs re-authenticating.
 *
 *  - **No path parameter anywhere.** agent-hub's `/new <name> <path>` takes any
 *    path with no validation (a known gap, §1), and a sandboxed session's
 *    working directory is a fixed `/work` mount anyway (§2). Leaving the
 *    parameter out entirely removes the question rather than answering it — the
 *    coordinator has no way to express "start a session in /etc", so no
 *    validator on the host has to be correct about it.
 *
 * @type {Readonly<Record<string, VerbSpec>>}
 */
export const VERBS = Object.freeze({
  list: {
    params: {},
    mutating: false,
    summary: 'Every session this host knows about, running or resumable.',
  },
  status: {
    params: { name: { type: 'name', required: false } },
    mutating: false,
    summary: 'Host health, or one session in detail.',
  },
  peek: {
    params: {
      name: { type: 'name', required: true },
      lines: { type: 'int', required: false, min: 1, max: 500 },
    },
    mutating: false,
    summary: "Read the last lines of a session's pane.",
  },
  health: {
    params: {},
    mutating: false,
    summary: 'Capacity and load, for the scheduler. Never routed through the command registry.',
  },
  start: {
    params: {
      name: { type: 'name', required: false },
      mode: { type: 'enum', required: false, values: ['safe', 'dangerous'] },
    },
    mutating: true,
    summary: 'Start a new session. No path — see the note above.',
  },
  resume: {
    params: {
      name: { type: 'name', required: true },
      choice: { type: 'enum', required: false, values: ['summary', 'full'] },
    },
    mutating: true,
    summary: 'Resume a stopped session, optionally answering the resume dialog.',
  },
  stop: {
    params: { name: { type: 'name', required: true } },
    mutating: true,
    summary: 'Stop a running session, keeping its conversation resumable.',
  },
  forget: {
    params: { name: { type: 'name', required: true } },
    mutating: true,
    summary: 'Stop a session and erase its record, so it can no longer be resumed.',
  },
});

/** @param {string} verb */
export function isMutating(verb) {
  return VERBS[verb]?.mutating === true;
}

/**
 * @typedef {object} Intent
 * @property {number} v
 * @property {'intent'} kind
 * @property {string} id
 * @property {string} verb
 * @property {Record<string, string|number>} params
 * @property {number} issuedAt
 * @property {string} [actor]
 */

/**
 * @typedef {{ ok: true, intent: Intent }} ValidOk
 * @typedef {{ ok: false, code: string, error: string }} ValidErr
 */

/**
 * Validate one envelope off the wire.
 *
 * Unknown parameters are REJECTED rather than ignored. Ignoring them is the
 * friendlier default and the wrong one here: a parameter the host silently
 * drops is a coordinator and a host that disagree about what a command means,
 * and the whole point of a fixed verb set is that they cannot.
 *
 * @param {unknown} raw
 * @param {{ now?: number, maxSkewMs?: number }} [opts] maxSkewMs bounds replay;
 *   omit it where the transport already guarantees freshness.
 * @returns {ValidOk | ValidErr}
 */
export function validateIntent(raw, { now = Date.now(), maxSkewMs = 0 } = {}) {
  /** @param {string} code @param {string} error @returns {ValidErr} */
  const bad = (code, error) => ({ ok: false, code, error });

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad('bad_envelope', 'intent must be a JSON object');
  }
  const env = /** @type {Record<string, unknown>} */ (raw);

  if (env.v !== PROTOCOL_VERSION) {
    return bad('unsupported_version', `unsupported protocol version ${JSON.stringify(env.v)}, this host speaks ${PROTOCOL_VERSION}`);
  }
  if (env.kind !== 'intent') {
    return bad('bad_envelope', `not an intent: kind=${JSON.stringify(env.kind)}`);
  }
  if (typeof env.id !== 'string' || !ID_RE.test(env.id)) {
    return bad('bad_envelope', 'id must be an idempotency key of 8-128 characters from [A-Za-z0-9._:-]');
  }
  if (typeof env.verb !== 'string' || !Object.prototype.hasOwnProperty.call(VERBS, env.verb)) {
    // Deliberately does not list the valid verbs: this reply may travel back to
    // whoever sent it, and the verb set is not a secret but it is not an
    // invitation either.
    return bad('unknown_verb', `unknown verb ${JSON.stringify(String(env.verb).slice(0, 40))}`);
  }
  const spec = VERBS[env.verb];

  if (env.actor !== undefined && (typeof env.actor !== 'string' || !ACTOR_RE.test(env.actor))) {
    return bad('bad_envelope', 'actor must be a short id like "telegram:12345"');
  }

  if (!Number.isSafeInteger(env.issuedAt)) {
    return bad('bad_envelope', 'issuedAt must be an epoch-millisecond integer');
  }
  if (maxSkewMs > 0 && Math.abs(now - /** @type {number} */ (env.issuedAt)) > maxSkewMs) {
    return bad('stale', `issuedAt is more than ${maxSkewMs}ms from now`);
  }

  const params = env.params === undefined ? {} : env.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return bad('bad_params', 'params must be a JSON object');
  }

  /** @type {Record<string, string|number>} */
  const clean = {};
  for (const [key, value] of Object.entries(params)) {
    const ps = spec.params[key];
    if (!ps) return bad('bad_params', `${env.verb} takes no parameter "${key.slice(0, 40)}"`);
    const checked = checkParam(env.verb, key, ps, value);
    if (checked.ok === false) return checked;
    clean[key] = checked.value;
  }
  for (const [key, ps] of Object.entries(spec.params)) {
    if (ps.required && clean[key] === undefined) return bad('bad_params', `${env.verb} requires "${key}"`);
  }

  return {
    ok: true,
    intent: {
      v: PROTOCOL_VERSION,
      kind: 'intent',
      id: env.id,
      verb: env.verb,
      params: clean,
      issuedAt: /** @type {number} */ (env.issuedAt),
      ...(env.actor ? { actor: /** @type {string} */ (env.actor) } : {}),
    },
  };
}

/**
 * @param {string} verb @param {string} key @param {ParamSpec} ps @param {unknown} value
 * @returns {{ ok: true, value: string|number } | ValidErr}
 */
function checkParam(verb, key, ps, value) {
  /** @param {string} error @returns {ValidErr} */
  const bad = (error) => ({ ok: false, code: 'bad_params', error });

  if (ps.type === 'name') {
    if (typeof value !== 'string' || !NAME_RE.test(value)) {
      return bad(
        `${verb}.${key} must start with a letter or digit and contain only letters, digits, "-" and "_" (max 40)`,
      );
    }
    return { ok: true, value };
  }
  if (ps.type === 'enum') {
    if (typeof value !== 'string' || !(ps.values || []).includes(value)) {
      return bad(`${verb}.${key} must be one of ${(ps.values || []).join(', ')}`);
    }
    return { ok: true, value };
  }
  // 'int'
  if (!Number.isSafeInteger(value)) return bad(`${verb}.${key} must be an integer`);
  const n = /** @type {number} */ (value);
  if (ps.min !== undefined && n < ps.min) return bad(`${verb}.${key} must be at least ${ps.min}`);
  if (ps.max !== undefined && n > ps.max) return bad(`${verb}.${key} must be at most ${ps.max}`);
  return { ok: true, value: n };
}

/**
 * Build an intent the coordinator can send.
 *
 * `id` is required rather than generated here. An idempotency key that this
 * function mints is a new key on every retry, which makes it decoration: the
 * point is that the RETRY of a `start` carries the key the first attempt did,
 * so the host can recognise it. Whoever owns the retry owns the key.
 *
 * @param {{ id: string, verb: string, params?: Record<string, string|number>, actor?: string, issuedAt?: number }} opts
 * @returns {Intent}
 */
export function buildIntent({ id, verb, params = {}, actor, issuedAt = Date.now() }) {
  const intent = {
    v: PROTOCOL_VERSION,
    kind: /** @type {'intent'} */ ('intent'),
    id,
    verb,
    params,
    issuedAt,
    ...(actor ? { actor } : {}),
  };
  const checked = validateIntent(intent);
  if (checked.ok === false) throw new Error(`refusing to send a malformed intent: ${checked.error}`);
  return checked.intent;
}
