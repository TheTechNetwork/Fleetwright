// Error reporting, and everything it must never send.
//
// THIS COORDINATOR HANDLES CREDENTIALS ON ALMOST EVERY REQUEST, and an error
// reporter is a service whose entire job is to copy request context to a third
// party. Wiring one in with its defaults would have shipped, continuously:
//
//   `?token=fwk_…`      — a device credential IN THE URL. Deliberate, because a
//                         Shortcut calls this through "Get Contents of URL" and
//                         cannot set headers (openapi.json says so). Sentry
//                         records the URL of every event by default.
//   Authorization       — the same credential, or the admin token.
//   POST /oauth/token   — an authorization code and its PKCE verifier.
//   POST /api/session   — an Apple or Google ID token.
//   POST /api/intent    — `link github <token>`, which src/core/redact.js
//                         already exists to keep out of this fleet's OWN logs.
//
// Keeping a secret out of the journal and then posting it to sentry.io would be
// the same bug with a longer flight. So this file is mostly refusal: bodies off,
// user info off, headers dropped, and the query string rebuilt rather than
// filtered — a denylist of parameter names is a list somebody forgets to update
// the next time a token learns a new spelling.
//
// docs/security.md treats this coordinator as compromised for custody purposes.
// That argument is about what an attacker could read here; it is not a licence
// to hand the same material to anybody else.

/** Query parameters worth keeping. Everything else is dropped, named or not. */
const KEEP_QUERY = new Set(['host', 'name', 'verb', 'service', 'lines']);

/**
 * A URL with nothing secret left in it.
 *
 * ALLOWLIST, NOT DENYLIST. `?token=` is the one that exists today; the rule has
 * to survive the next parameter somebody adds without anybody remembering this
 * file. Path and origin are kept — they are the whole diagnostic value.
 *
 * @param {string} raw
 */
export function scrubUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return '[unparseable url]';
  }
  const kept = new URLSearchParams();
  for (const [k, v] of url.searchParams) kept.set(k, KEEP_QUERY.has(k) ? v : '[redacted]');
  url.search = kept.toString();
  // A credential can also arrive in the PATH — no route takes one there today,
  // and this costs one regex against the day one does.
  url.pathname = url.pathname.replace(/fwk_[A-Za-z0-9_-]+/g, 'fwk_[redacted]');
  return url.toString();
}

/**
 * Strip everything a request carried that could be a credential.
 *
 * Called on every event and every transaction. It edits in place because Sentry
 * hands over its own event object and expects it back.
 *
 * @param {any} event
 */
export function scrubEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const req = event.request;
  if (req) {
    if (req.url) req.url = scrubUrl(req.url);
    // NO HEADERS AT ALL, rather than "not the Authorization one". Cookies, a
    // proxy's rewritten auth header, and whatever a future client invents are
    // all the same risk, and none of them is worth an incident to have kept.
    delete req.headers;
    delete req.cookies;
    delete req.data;
    if (req.query_string) req.query_string = '[redacted]';
  }
  delete event.user;
  // Breadcrumbs record outbound fetches, and this coordinator's outbound
  // fetches are intents carrying the caller's credential.
  if (Array.isArray(event.breadcrumbs)) {
    for (const crumb of event.breadcrumbs) {
      if (crumb?.data?.url) crumb.data.url = scrubUrl(crumb.data.url);
      if (crumb?.data) delete crumb.data.headers;
    }
  }
  return event;
}

/**
 * The options, from the environment.
 *
 * NO DSN, NO SENTRY. A fresh clone, a contributor's `wrangler dev`, and a
 * self-hosted fleet all run with this unset, and none of them should be posting
 * anywhere. Sentry treats an absent DSN as disabled, so this stays one code
 * path rather than two.
 *
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, SENTRY_TRACES_SAMPLE_RATE?: string }} env
 */
export function sentryOptions(env) {
  const rate = Number(env.SENTRY_TRACES_SAMPLE_RATE);
  return {
    dsn: env.SENTRY_DSN || undefined,
    environment: env.SENTRY_ENVIRONMENT || 'production',
    // NOT 1.0, which the quickstart suggests. Every host in this fleet sends a
    // health frame every fifteen seconds and every phone polls; tracing all of
    // it buys noise and spends quota that an actual incident needs.
    tracesSampleRate: Number.isFinite(rate) ? rate : 0.05,
    sendDefaultPii: false,
    dataCollection: {
      // The two the SDK turns on for you, both off here. See the top of this
      // file for what a request body on this coordinator contains.
      userInfo: false,
      httpBodies: [],
    },
    /** @param {any} event */
    beforeSend: (event) => scrubEvent(event),
    /** @param {any} event */
    beforeSendTransaction: (event) => scrubEvent(event),
    /** @param {any} crumb */
    beforeBreadcrumb: (crumb) => {
      if (crumb?.data?.url) crumb.data.url = scrubUrl(crumb.data.url);
      return crumb;
    },
  };
}
