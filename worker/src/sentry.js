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
 * Called on every event. It edits in place because Sentry
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

/** Span attributes worth keeping, beside the SDK's own `sentry.*`. Everything else is dropped, named or not. */
const KEEP_ATTRIBUTES = new Set([
  'http.request.method',
  'http.method',
  'http.response.status_code',
  'http.status_code',
  'url.path',
  'url.scheme',
  'server.address',
  'cloud.provider',
]);

/** The attributes that hold a whole URL, kept through scrubUrl. */
const URL_ATTRIBUTES = new Set(['url.full', 'http.url', 'url']);

/**
 * Strip a span's attributes, because a span never passes scrubEvent.
 *
 * The request span carried the whole URL twice (`url.full`, `url.query`, so
 * an OAuth callback's code, state and sealed token), every request header as
 * `http.request.header.*`, the caller's address among them, and the user
 * agent. So the same rule as the URL, an allowlist: the SDK's own `sentry.*`
 * bookkeeping, the method, the status and where it happened, and nothing a
 * later SDK decides to add.
 *
 * @param {any} attributes  edited in place
 */
function scrubAttributes(attributes) {
  if (!attributes || typeof attributes !== 'object') return;
  for (const key of Object.keys(attributes)) {
    if (URL_ATTRIBUTES.has(key)) attributes[key] = scrubUrl(attributes[key]);
    else if (key === 'url.path') attributes[key] = String(attributes[key]).replace(/fwk_[A-Za-z0-9_-]+/g, 'fwk_[redacted]');
    else if (!key.startsWith('sentry.') && !KEEP_ATTRIBUTES.has(key)) delete attributes[key];
  }
}

/**
 * A streamed span, which goes out through beforeSendSpan and nothing else.
 *
 * @param {any} span  the SDK's span JSON, edited in place like an event
 */
export function scrubSpan(span) {
  scrubAttributes(span?.attributes);
  return span;
}

/**
 * The same request span when it leaves as a transaction instead.
 *
 * STREAMING IS NOT A PROMISE. Under Node 26 the SDK loses its client by the
 * time the request span ends, takes the transaction path it keeps for
 * "static", and sends the span as a transaction event: the same attributes,
 * in `contexts.trace.data` and each `spans[].data`, through
 * beforeSendTransaction and not beforeSendSpan. Which path a span takes is
 * the SDK's business; that both are scrubbed is this file's.
 *
 * @param {any} event
 */
export function scrubTransaction(event) {
  scrubEvent(event);
  scrubAttributes(event?.contexts?.trace?.data);
  if (Array.isArray(event?.spans)) for (const span of event.spans) scrubAttributes(span?.data);
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
      // Off here, all of what the SDK collects from a request. See the top
      // of this file for what a request body on this coordinator contains;
      // headers and the query are where its credentials travel.
      userInfo: false,
      httpBodies: [],
      httpHeaders: false,
      cookies: false,
      urlQueryParams: false,
    },
    // WRITTEN OUT, not inherited, so a change of the SDK's default cannot
    // quietly move spans somewhere else. Both span hooks are wired anyway:
    // see scrubTransaction for the runtime that sends transactions under
    // "stream", and the SDK's warning that beforeSendTransaction is ignored
    // there is true only of the path it meant to take.
    traceLifecycle: 'stream',
    /** @param {any} event */
    beforeSend: (event) => scrubEvent(event),
    /** @param {any} span */
    beforeSendSpan: (span) => scrubSpan(span),
    /** @param {any} event */
    beforeSendTransaction: (event) => scrubTransaction(event),
    /** @param {any} crumb */
    beforeBreadcrumb: (crumb) => {
      if (crumb?.data?.url) crumb.data.url = scrubUrl(crumb.data.url);
      return crumb;
    },
  };
}
