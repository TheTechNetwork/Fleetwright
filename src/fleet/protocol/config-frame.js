// Values the coordinator may push to a host, and the very short list of them.
//
// THIS IS A COMMAND CHANNEL WEARING A DIFFERENT HAT, which is why it is a
// protocol module with a fixed vocabulary and not a map. "The coordinator can
// push configuration to hosts" is, unconstrained, exactly what design.md §5
// refuses when it refuses shell strings: arbitrary key/value delivery from the
// party this system treats as compromised. A host that stores whatever it is
// sent is a host whose behaviour the coordinator writes.
//
// So: named keys from a fixed set, each with a declared shape, and a key the
// host does not recognise is DROPPED rather than stored. Same discipline as the
// verb set — the coordinator can send what the protocol names and cannot invent
// a new thing to send. The list should grow slowly and never become a map.
//
// WHY THIS EXISTS AT ALL. The GitHub App client secret has to reach a host: it
// is what turns a refresh token into a new access token, and the refresh has to
// happen on the box because that is where trust.md puts the minting material.
// The alternative shapes are both worse. A file on every host is a thing
// somebody has to place, re-place on rotation, and forget on one box — which is
// the exact chore this project exists to remove. Writing it into the credential
// store, which is what shipped first and which docs/github-app.md flatly denies,
// puts the fleet-wide secret at rest once per member per host, and makes
// rotation silently break every renewal eight hours later.
//
// In memory, delivered on connect, is the shape that has none of those: nothing
// to place, nothing at rest, and rotation is a deploy. The cost is honest and
// small — a host that cannot reach the coordinator cannot renew, and a host in
// that state cannot be asked to do anything either.

import { PROTOCOL_VERSION } from './intents.js';

/**
 * The fixed set. Each entry says what a value must look like; anything that
 * fails is dropped with a warning rather than stored, because a malformed
 * secret stored is a renewal that fails hours later somewhere else.
 *
 * @type {Readonly<Record<string, { max: number, secret: boolean, what: string }>>}
 */
export const CONFIG_KEYS = Object.freeze({
  githubClientSecret: {
    max: 4096,
    secret: true,
    what: "the GitHub App's client secret, for exchanging refresh tokens",
  },
});

/**
 * Same charset as a protocol `secret`, and for the same reasons: printable
 * ASCII, no whitespace, no quote, no backslash.
 *
 * The narrowness is deliberate even though today's one value goes into a JSON
 * body rather than onto a command line. A value that arrives here may end up
 * anywhere a credential ends up, and the env-file readers this project already
 * has disagree about quoting — refusing the characters that make them disagree
 * means there is nothing to get right twice. A GitHub client secret is hex; it
 * loses nothing.
 */
const VALUE_RE = /^[\x21-\x7e]+$/;
const FORBIDDEN_RE = /['"\\]/;

/**
 * Read a config frame, keeping only what the protocol names.
 *
 * NEVER THROWS AND NEVER PARTIALLY APPLIES. A frame with one good key and one
 * unknown one yields the good key and a note about the other — the alternative
 * is a coordinator able to make a host reject its own configuration by adding a
 * field, which is a denial primitive handed over for free.
 *
 * @param {unknown} msg
 * @returns {{ ok: boolean, values: Record<string, string>, dropped: string[], error?: string }}
 */
export function readConfigFrame(msg) {
  const frame = /** @type {any} */ (msg);
  if (!frame || typeof frame !== 'object' || frame.kind !== 'config') {
    return { ok: false, values: {}, dropped: [], error: 'not a config frame' };
  }
  // Exact-match, like every other frame: a version we do not know is a frame we
  // do not understand, and guessing is how a protocol stops being one.
  if (frame.v !== PROTOCOL_VERSION) {
    return { ok: false, values: {}, dropped: [], error: `config frame is v${frame.v}, this host speaks v${PROTOCOL_VERSION}` };
  }
  const given = frame.values;
  if (!given || typeof given !== 'object' || Array.isArray(given)) {
    return { ok: false, values: {}, dropped: [], error: 'config frame has no values object' };
  }

  /** @type {Record<string, string>} */
  const values = {};
  /** @type {string[]} */
  const dropped = [];
  for (const [key, value] of Object.entries(given)) {
    const spec = CONFIG_KEYS[key];
    if (!spec) { dropped.push(key); continue; }
    if (
      typeof value !== 'string'
      || value.length === 0
      || value.length > spec.max
      || !VALUE_RE.test(value)
      || FORBIDDEN_RE.test(value)
    ) {
      // The value is NOT quoted back. These are credentials, and a refusal
      // travels to a log the way every other refusal does.
      dropped.push(key);
      continue;
    }
    values[key] = value;
  }
  return { ok: true, values, dropped };
}

/**
 * Build one. Only the coordinator calls this; it is here so both
 * implementations of the coordinator build the identical frame.
 *
 * @param {Record<string, string|null|undefined>} values
 * @returns {{ v: number, kind: 'config', values: Record<string, string> } | null}
 */
export function buildConfigFrame(values) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of Object.keys(CONFIG_KEYS)) {
    const value = values[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  // Nothing to say is not the same as saying nothing: a frame with no values
  // would make a host log a delivery that carried nothing.
  return Object.keys(out).length ? { v: PROTOCOL_VERSION, kind: 'config', values: out } : null;
}
