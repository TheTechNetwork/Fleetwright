// The GitHub App's user-to-server flow, shared by both coordinators.
//
// WHY THE COORDINATOR AND NOT THE HOST. GitHub redirects a browser, and a
// browser cannot reach a host — hosts dial out and have no inbound route. The
// coordinator is the only publicly addressable part of this system, so the
// callback lands there and the result is relayed down the socket the host
// already holds open. That is the same shape as everything else here: the
// public edge holds no state and the host holds no port.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not mint installation tokens,
// which would need the App's private key — an object that mints for EVERY
// installation of the App and therefore cannot live in a party this design
// treats as compromised. See docs/github-app.md. What it does is the half that
// works without it: an eight-hour user access token, scoped to the
// repositories the person chose, with a refresh token that belongs to them
// alone.

/** How long somebody has to finish authorizing before the state is refused. */
const STATE_TTL_MS = 10 * 60_000;

/** Bounded, because an abandoned flow costs memory until it expires. */
const MAX_PENDING = 200;

/**
 * A pending authorization, and the whole security of the callback.
 *
 * `state` is the only thing tying a request arriving from the open internet to
 * a flow this coordinator started. It therefore has to be:
 *
 *  - **unguessable** — a uuid, not a counter
 *  - **single-use** — redeemed exactly once, so a replayed callback is refused
 *  - **short-lived** — ten minutes is longer than anybody takes and shorter
 *    than a link left open in a tab
 *  - **bound to both the host and the person**, so the token that comes back
 *    can only be delivered where the flow started and stored under the
 *    identity that asked
 *
 * Without those four the callback is an open door for anyone who can guess a
 * URL — and the thing behind the door writes a credential onto a machine.
 */
export class PendingAuthorizations {
  /** @param {{ now?: () => number, ttlMs?: number }} [opts] */
  constructor({ now = () => Date.now(), ttlMs = STATE_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {Map<string, { hostId: string, email: string|null, at: number }>} */
    this.pending = new Map();
  }

  /** Drop everything past its window. Called on both paths, not on a timer. */
  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const [state, rec] of this.pending) if (rec.at <= cutoff) this.pending.delete(state);
  }

  /**
   * @param {{ state: string, hostId: string, email: string|null }} flow
   */
  mint({ state, hostId, email }) {
    this.sweep();
    // Oldest first, so a flood of abandoned flows cannot evict a live one that
    // somebody is in the middle of.
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    this.pending.set(state, { hostId, email, at: this.now() });
    return state;
  }

  /**
   * Redeem once. Returns the flow, or null for unknown, expired or replayed.
   * @param {unknown} state
   */
  redeem(state) {
    this.sweep();
    const key = typeof state === 'string' ? state : '';
    const found = this.pending.get(key);
    if (!found) return null;
    // Deleted before the caller does anything with it: a callback that arrives
    // twice, or is replayed from a browser history entry, must not exchange a
    // second time.
    this.pending.delete(key);
    return found;
  }
}

/**
 * The origin, parsed rather than trimmed.
 *
 * This was `origin.replace(/\/+$/, '')`, which CodeQL flagged the day after
 * CodeQL started running, and it was right twice over.
 *
 * **The regex backtracks.** `\/+$` against a long run of slashes that does not
 * end the string is polynomial: 60,000 slashes with one character after them
 * took three seconds, measured. Anchoring at the end is what makes it
 * quadratic rather than linear.
 *
 * **And the input is not ours.** The Node coordinator built its origin from
 * `req.headers.host`, which is whatever the client sent. So the slow string
 * was one header away, and — separately — a forged Host would have been
 * assembled into a `redirect_uri`. GitHub refuses a redirect that is not on the
 * App's registered list, so that was never a token leak, but building a URL out
 * of an attacker's header and sending it to a provider is not a thing to leave
 * standing because the provider happens to catch it.
 *
 * `new URL(...).origin` is linear, and cannot produce a trailing slash at all —
 * so the trimming this replaced is not merely faster, it is unnecessary.
 *
 * @param {unknown} value
 * @returns {string|null} the normalised origin, or null if it is not one
 */
export function normaliseOrigin(value) {
  const raw = String(value ?? '');
  // A bound before parsing: a megabyte of Host header is not a URL anybody
  // meant to send, and refusing it costs nothing.
  if (!raw || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Where to send somebody to authorize.
 *
 * `redirect_uri` is sent explicitly rather than relying on the App's default,
 * so a deployment on a different origin cannot silently send its users to
 * somebody else's coordinator — GitHub matches it against the registered list
 * and refuses a mismatch, which is the behaviour we want to depend on.
 *
 * @param {{ clientId: string, origin: string, state: string }} args
 */
export function authorizeUrl({ clientId, origin, state }) {
  const base = normaliseOrigin(origin);
  if (!base) return null;
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', `${base}/oauth/github/callback`);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Exchange the code for tokens.
 *
 * Never throws: a provider that is down, slow, or answering something
 * unexpected must produce a message somebody can act on rather than a stack
 * trace in a Worker log and a blank page in a browser.
 *
 * @param {{ clientId: string, clientSecret: string, code: string, origin: string, fetch?: typeof globalThis.fetch }} args
 */
export async function exchangeCode({ clientId, clientSecret, code, origin, fetch: doFetch = globalThis.fetch }) {
  const base = normaliseOrigin(origin);
  if (!base) return { ok: false, message: 'This coordinator could not work out its own address.' };
  let body;
  try {
    const res = await doFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${base}/oauth/github/callback`,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    body = /** @type {any} */ (await res.json());
  } catch (e) {
    return { ok: false, message: `Could not reach GitHub to finish signing in: ${/** @type {Error} */ (e).message}` };
  }

  // GitHub answers 200 with an `error` field rather than a status code, which
  // is the kind of thing that turns into "undefined" on a screen if nobody
  // looks for it.
  if (!body || body.error) {
    return { ok: false, message: `GitHub refused the authorization: ${body?.error_description || body?.error || 'no reason given'}` };
  }
  if (typeof body.access_token !== 'string' || !body.access_token) {
    return { ok: false, message: 'GitHub returned no access token.' };
  }
  return {
    ok: true,
    accessToken: body.access_token,
    // Present only when "Expire user authorization tokens" is on. Absent means
    // the App is configured for non-expiring tokens, which is a setting worth
    // naming rather than silently tolerating — an access token that never
    // expires is the PAT problem with extra steps.
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresIn: Number(body.expires_in) || null,
  };
}

/**
 * The page a browser lands on afterwards.
 *
 * Deliberately plain and self-closing in tone: the person is in a browser they
 * opened from an app, and the useful thing is to tell them it worked and that
 * they can go back. No styling, no script, nothing to load — this is served by
 * the coordinator and must not become a page that fetches anything.
 *
 * @param {{ ok: boolean, text: string }} result
 */
export function callbackPage({ ok, text }) {
  const safe = String(text).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] || c);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Connected' : 'Not connected'}</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem}</style>
<h1>${ok ? 'GitHub connected' : 'Not connected'}</h1>
<p>${safe}</p>
<p>You can close this and go back to the app.</p>`;
}
