// The one page a member can use without a phone.
//
// WHY THIS EXISTS, and it is not "a web UI would be nice". A person invited to
// a fleet is told, in the invitation, to install the app, and there is no
// second route. If they have no iPhone and no Android device, the invitation
// is the whole of what they get:
//
//   - `/mcp` signs them in from a browser and issues a real credential, so
//     that part already worked. But `connect`, `link`, `unlink` and `renew`
//     are in DEFAULT_DENY (src/mcp/tools.js) and the remote endpoint passes no
//     allow list, so an agent holding that credential can never link an
//     account.
//   - A session whose actor has no linked Claude account is REFUSED, on
//     purpose: docs/one-account-per-person.md removed the box's own login so
//     that a guest cannot quietly spend the org's subscription.
//
// Put together: an invited member with no phone signs in successfully, starts
// a session, is told to connect a Claude account in the app, and has no app.
// A dead end reached by following the instructions.
//
// So this is the credentials half of the browser surface docs/wanted.md asks
// for, and DELIBERATELY ONLY THAT HALF. It signs you in and it adds your
// accounts. It does not list, start, stop or read a session: the apps do that,
// the agent does that, and a second place to drive the fleet is a second place
// for the two to disagree about what is running.
//
// NO BUNDLER, NO FRAMEWORK, NO BUILD STEP, for the same reason
// `mcp/authorize-page.js` has none: this string has to be served identically
// by a Node process and by a Worker, and the only third-party script on it is
// the sign-in script belonging to the provider whose sign-in it is.
//
// It talks to two routes that already existed and adds no others:
// `POST /api/session` for the credential, `POST /api/intent` for everything
// else. Nothing here is a new authority: the coordinator decides what a caller
// may do and has not changed.
//
// THE DESIGN READ, which CLAUDE.md requires before any screen. A signed-in
// utility page for one person's own credentials, in the fleet console's visual
// language (docs/design-system.md), at this product's dials: ENERGY 1,
// RHYTHM 1, MOTION 1. Calm recedes and trouble comes forward, so the cards are
// one uniform shape and the ONLY one that breaks it is the card asking a
// question: a Claude account that is not connected, which is the thing that
// will refuse a session an hour from now.
//
// NO EM DASH IN THE STRINGS ON THIS PAGE, and that is deliberate rather than
// an oversight. CLAUDE.md records an exception to R-02 covering 41 strings in
// the apps and 26 in the host's replies, and says what would delete it. An
// exception measured in existing strings is not a licence for a new surface,
// so this page is written without them and the count in CLAUDE.md stays true.
// The comments are prose for people reading the source and keep the house
// voice.

/** @param {string} s */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

/**
 * JSON for embedding inside a `<script>` element.
 *
 * The same escaping as authorize-page.js and for the same reason: a value that
 * contains `</script>` closes the element, and everything after it is markup.
 * These values come from configuration rather than from a query string, which
 * makes it less likely and not less necessary.
 *
 * @param {unknown} value
 */
const scriptJson = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/**
 * The palette and the scale, from docs/design-system.md.
 *
 * The numbers are the ones in `test/fixtures/parity/design-tokens.json`,
 * copied rather than imported because this file is served to a browser as a
 * string and a build step is exactly what it is avoiding. No value here is off
 * that table: the rule the design system spends a test on is that there is one
 * palette and no stray colours, and a page that invented a grey to make a
 * border pass contrast would be breaking it to satisfy another rule.
 *
 * TWO PLACES THIS DEPARTS FROM THE CONSOLE'S OWN CSS, both to pass WCAG on a
 * page that is mostly form controls:
 *
 *   --accent-deep, not --accent, under white button text. White on #5b8bef is
 *   3.29:1, which fails AA for a 16px label; on #3866d6 it is 5.20:1. That is
 *   the same brand blue in both themes, so the filled button does not change
 *   colour when the theme does.
 *
 *   --ink-dim, not --ring, on the edge of an input or a button. The console's
 *   hairline is 1.24:1 against a card, which is fine for the edge of a
 *   container and not for the edge of a CONTROL: WCAG 1.4.11 asks 3:1 of the
 *   boundary that tells somebody where to type. The card keeps the hairline,
 *   because a card is not something you operate.
 */
const STYLE = `
:root {
  color-scheme: dark light;
  --font: 'Inter Tight', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --t-greeting: 1.625rem; --t-section: 1.1875rem; --t-body: 1rem;
  --t-body-small: 0.875rem; --t-label: 0.8125rem;
  --s-page: 26px; --s-group: 22px; --s-group-tight: 16px; --s-inside: 12px;
  --s-inside-tight: 8px; --s-hair: 4px;
  --r-card-small: 18px; --r-row: 14px; --r-chip: 8px;
  --bg: #0b0d10; --card: #12151a; --inner: #171b22;
  --ink: #e6e9ef; --ink-dim: #8b93a3;
  --accent: #5b8bef; --accent-deep: #3866d6;
  --ok: #4ade80; --attention: #fbbf24; --bad: #f87171;
  --ring: rgba(255, 255, 255, 0.07);
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f7f8fa; --card: #ffffff; --inner: #f1f3f7;
    --ink: #12151a; --ink-dim: #5b6474;
    --accent: #3866d6;
    --ok: #0f7a52; --attention: #a15c00; --bad: #c02b2b;
    --ring: rgba(16, 20, 28, 0.09);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: var(--t-body)/1.5 var(--font);
  /* The bottom is generous so a focused field is never the last thing above
   * an on-screen keyboard with nothing under it to scroll into. */
  padding: var(--s-page) var(--s-group-tight) 96px;
}
main { max-width: 34rem; margin: 0 auto; }
h1 { font-size: var(--t-greeting); letter-spacing: -0.9px; margin: 0 0 var(--s-inside); }
h2 { font-size: var(--t-section); letter-spacing: -0.7px; margin: 0; }
p { margin: 0 0 var(--s-inside); }
.lede { color: var(--ink-dim); font-size: var(--t-body-small); }
.card {
  background: var(--card); border: 1px solid var(--ring);
  border-radius: var(--r-card-small); padding: var(--s-group-tight);
  margin-bottom: var(--s-group-tight);
}
/* The one shape that breaks the uniform stack, spent on the one card that is
 * asking a question. docs/design-system.md: amber means waiting for you, and
 * nothing else. */
.card.asking { border-color: color-mix(in srgb, var(--attention) 55%, transparent); }
.row { display: flex; align-items: center; gap: var(--s-inside); justify-content: space-between; flex-wrap: wrap; }
.row > div { min-width: 0; }
.state { font-size: var(--t-body-small); color: var(--ink-dim); margin-top: var(--s-hair); }
.state.on { color: var(--ok); }
.state.off { color: var(--attention); }
button, .btn {
  font: 600 var(--t-body)/1 var(--font); min-height: 44px; padding: 0 var(--s-group-tight);
  border-radius: var(--r-row); border: 1px solid var(--ink-dim);
  background: var(--inner); color: var(--ink); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; text-decoration: none;
}
button.primary { background: var(--accent-deep); border-color: var(--accent-deep); color: #ffffff; }
button:hover, .btn:hover { border-color: var(--accent); }
/* WCAG exempts a disabled control from the contrast minimum, and this one is
 * disabled for the second a provider takes to answer. What says so is the line
 * of text under it, not the dimming. */
button:disabled { opacity: 0.6; cursor: default; }
button.link {
  background: none; border: none; color: var(--accent); padding: 0 var(--s-inside-tight);
  min-height: 44px; font-weight: 400; font-size: var(--t-body-small);
}
input {
  font: var(--t-body)/1 var(--font); min-height: 44px; width: 100%;
  padding: 0 var(--s-inside); border-radius: var(--r-row);
  border: 1px solid var(--ink-dim); background: var(--inner); color: var(--ink);
  /* So focusing the last field on a phone scrolls it clear of the keyboard
   * rather than leaving it under one. */
  scroll-margin-bottom: 160px;
}
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.step { margin-top: var(--s-group-tight); display: grid; gap: var(--s-inside); }
.say { font-size: var(--t-body-small); margin: var(--s-inside) 0 0; white-space: pre-wrap; }
.say.bad { color: var(--bad); }
.hosts { display: flex; gap: var(--s-inside-tight); flex-wrap: wrap; }
.chip {
  font-size: var(--t-label); font-weight: 400; padding: 0 var(--s-inside);
  border-radius: var(--r-chip); background: var(--inner);
}
footer { color: var(--ink-dim); font-size: var(--t-body-small); margin-top: var(--s-group); }
footer p { margin: 0 0 var(--s-inside-tight); }
[hidden] { display: none !important; }
/* Forced colours drops every custom colour, and the states above are carried
 * by colour AND by their words, so what has to come back is the edges. */
@media (forced-colors: active) {
  .card, button, .btn, input { border: 1px solid; }
}
`;

/**
 * Which client ids the sign-in buttons use.
 *
 * ONE IMPLEMENTATION, because there are two coordinators and this derivation
 * is a rule rather than a value: the Google client is picked OUT of the
 * audience list by its suffix, since the same list is what an ID token is
 * verified against and a deployment should not have to write the id twice.
 * Apple is separate because its Services ID is not an audience the app uses.
 *
 * It lived in server.js and the Worker was about to get a second copy of it,
 * which is how `/api/devices` came to 404 on a box for months.
 *
 * @param {{ audiences: string[], appleService?: string|null }} env
 * @returns {{ google: string|null, apple: string|null }}
 */
export function signInClients({ audiences, appleService = null }) {
  return {
    google: (audiences || []).find((a) => a.endsWith('.apps.googleusercontent.com')) || null,
    apple: appleService || null,
  };
}

/**
 * The address bits of the page, in one place.
 *
 * `/me` because it is what the person is here about, their own credentials,
 * and because every other path on this coordinator is either `/api/…`, a host
 * route, or part of an OAuth flow, so there is nothing to collide with.
 */
export const MEMBER_PATH = '/me';

/** @param {string} path */
export function isMemberPath(path) {
  return (
    path === MEMBER_PATH ||
    path === `${MEMBER_PATH}/` ||
    path === `${MEMBER_PATH}/manifest.webmanifest` ||
    path === `${MEMBER_PATH}/icon.svg` ||
    path === `${MEMBER_PATH}/sw.js`
  );
}

/**
 * Serve one of this page's requests.
 *
 * Written once and called by both coordinators, the same arrangement (and for
 * the same reason) as `mcpRoutes`: a route added to one and forgotten on the
 * other is a bug this repository has already shipped.
 *
 * Everything here is static. There is no state, no credential and no fleet
 * lookup, which is why it sits above the token gate on both sides without that
 * being a hole: an anonymous caller gets a form and a stylesheet.
 *
 * @param {{ method: string, path: string }} req
 * @param {{ fleet: string, signIn: { google?: string|null, apple?: string|null } }} deps
 * @returns {{ status: number, body: string, contentType: string, headers?: Record<string, string> } | null}
 *   null when the path is not ours, so the caller falls through.
 */
export function memberRoutes(req, deps) {
  if (!isMemberPath(req.path)) return null;
  if (req.method !== 'GET') {
    return {
      status: 405,
      body: JSON.stringify({ ok: false, error: { code: 'method_not_allowed' }, text: 'this page is a GET' }),
      contentType: 'application/json; charset=utf-8',
    };
  }
  if (req.path === `${MEMBER_PATH}/manifest.webmanifest`) {
    return { status: 200, body: JSON.stringify(manifest(deps.fleet)), contentType: 'application/manifest+json; charset=utf-8' };
  }
  if (req.path === `${MEMBER_PATH}/icon.svg`) {
    return { status: 200, body: ICON, contentType: 'image/svg+xml; charset=utf-8' };
  }
  if (req.path === `${MEMBER_PATH}/sw.js`) {
    return {
      status: 200,
      body: SERVICE_WORKER,
      contentType: 'text/javascript; charset=utf-8',
      // WITHOUT THIS HEADER THE WORKER NEVER REGISTERS, and nothing says so
      // except one line in a console nobody has open. A worker served from
      // `/me/sw.js` may by default control only `/me/`, and the page is at
      // `/me` — one character outside it — so the browser refuses the
      // registration and the page is simply not installable. Found by opening
      // it in a real browser; every test that only fetched the routes passed.
      headers: { 'service-worker-allowed': MEMBER_PATH },
    };
  }
  return { status: 200, body: memberPage(deps), contentType: 'text/html; charset=utf-8' };
}

/**
 * What makes it installable, and nothing beyond that.
 *
 * `display: standalone` and a start URL are the whole of it. There is no
 * offline story on purpose (see SERVICE_WORKER) and no screenshots or
 * categories, which are store metadata for a thing that is not in a store.
 *
 * @param {string} fleet
 */
function manifest(fleet) {
  return {
    name: `${fleet}: your credentials`,
    short_name: 'Fleetwright',
    start_url: MEMBER_PATH,
    scope: MEMBER_PATH,
    display: 'standalone',
    background_color: '#0b0d10',
    theme_color: '#0b0d10',
    icons: [
      // ONE SVG, AT "any". Every browser that will install this renders SVG,
      // and a pair of hand-rolled PNGs would be two more copies of the mark to
      // keep in step with the one the apps ship.
      { src: `${MEMBER_PATH}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: `${MEMBER_PATH}/icon.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}

/**
 * The service worker, which caches NOTHING, deliberately.
 *
 * A worker with a fetch handler is what browsers ask for before they will
 * offer to install a page, so there is one. What there is not is a cache: this
 * page holds a live fleet credential in localStorage, and a service worker
 * that kept copies of its responses would be a second place that credential's
 * surroundings live, surviving a sign-out, invisible to the person who did it,
 * and evicted on nobody's schedule but the browser's.
 *
 * So it passes every request through. An offline shell would be a real feature
 * and it is not this one: there is nothing useful to do with this page while
 * the fleet is unreachable.
 */
const SERVICE_WORKER = `// Passthrough. This page caches nothing on purpose, see member-page.js.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });
`;

/**
 * The product's own mark, redrawn.
 *
 * NOT AN ICON INVENTED FOR THIS PAGE. It is the shape already shipping as
 * `apps/android/store/icon-512.png` and the iOS AppIcon: three stacked bars on
 * the dark ground, the third one amber. Redrawn as SVG rather than embedded as
 * base64 because a Worker has no filesystem, and the colours are read off
 * docs/design-system.md, which is where the original came from: `--accent` and
 * `--chart-5` for the two blues, `--attention` for the third bar, which is the
 * one thing on the mark that means something.
 */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Fleetwright">
<rect width="512" height="512" rx="112" fill="#12151a"/>
<rect x="96" y="152" width="316" height="52" rx="26" fill="#5b8bef"/>
<rect x="96" y="236" width="398" height="52" rx="26" fill="#7aa7f7"/>
<rect x="96" y="320" width="254" height="52" rx="26" fill="#fbbf24"/>
</svg>`;

/**
 * The page.
 *
 * @param {{ fleet: string, signIn: { google?: string|null, apple?: string|null } }} deps
 */
function memberPage({ fleet, signIn }) {
  const configured = Boolean(signIn.google || signIn.apple);
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your credentials: ${esc(fleet)}</title>
<link rel="manifest" href="${MEMBER_PATH}/manifest.webmanifest">
<link rel="icon" href="${MEMBER_PATH}/icon.svg" type="image/svg+xml">
<meta name="theme-color" content="#0b0d10">
<style>${STYLE}</style>
${signIn.google ? '<script src="https://accounts.google.com/gsi/client" async></script>' : ''}
${signIn.apple ? '<script src="https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js" async></script>' : ''}
</head><body>
<main>
  <h1>Your credentials</h1>

  <!-- SIGNED OUT ------------------------------------------------------------
       Says what the page is for before asking anybody to sign in to it. A
       consent screen that does not say what it is consenting to is one nobody
       can refuse meaningfully. -->
  <section id="out" hidden>
    <p class="lede">A session on ${esc(fleet)} runs on <strong>your</strong> Claude account, and uses your
      GitHub or Cloudflare token when it needs one. This page is where you add them, and it is the whole
      of what it does. Nothing here starts, stops or reads a session.</p>
    <div class="card">
      <div class="step">
        ${signIn.google ? '<div id="g"></div>' : ''}
        ${signIn.apple ? '<div id="appleid-signin" data-color="black" data-border="true" data-type="sign in" style="height:44px"></div>' : ''}
        ${configured ? '' : '<p class="say bad">This fleet has no sign-in configured, so there is nothing here to sign in with. Whoever runs it sets AGENT_FLEET_AUTH_ISSUERS and AGENT_FLEET_AUTH_AUDIENCES.</p>'}
      </div>
      <p class="say" id="out-say" role="status"></p>
    </div>
    <footer>
      <p>Apple and Google do the signing in. This page never sees a password.</p>
      <p>Sign in with the address you were invited at. A fleet recognises the address, not the account.</p>
    </footer>
  </section>

  <!-- SIGNED IN -------------------------------------------------------------
       The provider list is NOT in this file. It arrives from the host, with
       the real URLs and the real scopes, which is the entire reason the verbs
       are connect/link/unlink rather than one verb per vendor. -->
  <section id="in" hidden>
    <div class="card">
      <div class="row">
        <div>
          <h2>Signed in</h2>
          <div class="state" id="who"></div>
        </div>
        <button class="link" id="signout">Sign out of this browser</button>
      </div>
    </div>
    <div id="providers"></div>
    <p class="say" id="say" role="status"></p>
    <footer>
      <p>Every account here stays yours. It is stored on the machines in this fleet for your sessions to
        use, it is never shown back to you or to anybody else, and you can take it off at the provider
        whenever you like.</p>
      <p>This browser holds a credential for ${esc(fleet)} until you sign out. It is listed as a device
        like any phone, and whoever runs the fleet can revoke it.</p>
    </footer>
  </section>
</main>
<script>
${pageScript(signIn)}
</script>
</body></html>`;
}

/**
 * The behaviour, as one string.
 *
 * Written with string concatenation rather than template literals throughout:
 * the whole document above IS a template literal, and a backtick in here
 * closes it. That is not hypothetical, it is how the same comment came to be
 * in authorize-page.js.
 *
 * @param {{ google?: string|null, apple?: string|null }} signIn
 */
function pageScript(signIn) {
  return `
// WHERE THE CREDENTIAL LIVES, which docs/wanted.md correctly calls the harder
// question on the web than it is on a phone. localStorage: it survives the tab
// closing, which is what makes an installed page worth installing, and it is
// readable by script on this origin, so the only script on this origin is this
// file and the sign-in script of whichever provider signs you in. Sign out
// removes it here; the credential itself stays in the fleet's device list
// until somebody revokes it there, and the page says so rather than implying a
// local delete reached the fleet.
//
// EVERY ACCESS IS WRAPPED. Safari in private browsing throws on setItem, and
// an exception here would leave a signed-in person looking at a signed-out
// page with no error anywhere.
var KEY = 'fleetwright.credential';
var WHO = 'fleetwright.device';
var token = null;
var who = '';
try { token = localStorage.getItem(KEY); who = localStorage.getItem(WHO) || ''; } catch (e) { token = null; }

var out = document.getElementById('out');
var inn = document.getElementById('in');
var say = document.getElementById('say');
var outSay = document.getElementById('out-say');
var providers = document.getElementById('providers');

// The host a Claude sign-in was started on, so the code goes back to the same
// box. A login is a pane on ONE machine: a second step that landed elsewhere
// would type a live credential into a box that never asked for one.
var pendingHost = null;

function tell(el, text, bad) {
  el.textContent = text || '';
  el.className = 'say' + (bad ? ' bad' : '');
}

function show() {
  out.hidden = !!token;
  inn.hidden = !token;
  if (token) {
    document.getElementById('who').textContent = who || 'this browser';
    load();
  }
}

/**
 * One intent, with this browser's credential. Refusals arrive as data and name
 * a reason; only the transport throws.
 */
async function intent(verb, params, host) {
  var body = { verb: verb, params: params || {} };
  if (host) body.host = host;
  var res;
  try {
    res = await fetch('/api/intent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // NAMES THE LAYER. "TypeError: Failed to fetch" is a true sentence about
    // the wrong thing: it sends somebody looking at their account when the
    // browser never reached the coordinator.
    throw new Error('This browser could not reach the coordinator, so nothing was sent. Check the connection and try again.');
  }
  if (res.status === 401 || res.status === 403) {
    // REVOKED IS A SIGNED-OUT STATE, not an error to read. A page that kept
    // showing a credential the fleet has forgotten would fail every action
    // with a different message each time.
    forget();
    throw new Error('This browser is no longer signed in to the fleet. Sign in again.');
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error('The coordinator answered with something that was not an intent reply (HTTP ' + res.status + ').');
  }
}

function forget() {
  token = null;
  who = '';
  try { localStorage.removeItem(KEY); localStorage.removeItem(WHO); } catch (e) {}
  show();
}

document.getElementById('signout').addEventListener('click', function () {
  forget();
  tell(outSay, 'Signed out of this browser. The credential is still in the fleet\\u2019s device list until it is revoked there.');
});

/**
 * What is connected, asked of the fleet rather than remembered here.
 *
 * Bare \`connect\` fans out, and the interesting part is where the hosts
 * DISAGREE: a token reaches the machines that were reachable when it was
 * stored, so one enrolled later has none.
 */
async function load() {
  providers.textContent = '';
  tell(say, 'Asking the fleet what you have connected.');
  var reply;
  try {
    reply = await intent('connect', {});
  } catch (e) {
    tell(say, e.message, true);
    return;
  }
  if (!reply || reply.ok === false) {
    tell(say, (reply && reply.text) || 'The fleet did not answer, so what you have connected cannot be read right now.', true);
    return;
  }
  tell(say, '');
  render(reply.connections || {});
}

/** @param {any} c */
function render(c) {
  var catalogue = c.catalogue || [];
  var connected = {};
  (c.connected || []).forEach(function (x) { connected[x.provider] = x; });
  var hosts = c.hosts || [];

  providers.textContent = '';
  if (!catalogue.length) {
    // NULL IS CANNOT TELL, NEVER NOTHING. No catalogue means no machine
    // answered, which is a fact about the fleet and not about this person's
    // accounts, so it must not render as an empty list of providers.
    tell(say, 'No machine in this fleet answered, so what you have connected cannot be read right now. Try again in a moment.', true);
    return;
  }
  catalogue.forEach(function (entry) {
    providers.appendChild(card(entry, connected[entry.provider], hosts));
  });
}

function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** @param {any} entry @param {any} have @param {string[]} hosts */
function card(entry, have, hosts) {
  var asking = !have && entry.provider === 'claude';
  var box = el('div', 'card' + (asking ? ' asking' : ''));
  var row = el('div', 'row');
  var left = el('div');
  left.appendChild(el('h2', null, entry.label || entry.provider));

  var state = el('div', 'state');
  if (have) {
    state.className = 'state on';
    var line = 'Connected' + (have.account ? ' as ' + have.account : '');
    // ABSENT FROM, not "missing": a connected credential already carries a
    // \`missing\`, which is the PERMISSIONS it was not granted. Two different
    // absences, and one word for both tells somebody the wrong thing.
    if (have.absentFrom && have.absentFrom.length) line += '. Not yet on ' + have.absentFrom.join(', ');
    if (have.missing && have.missing.length) line += '. Not granted: ' + have.missing.join(', ');
    state.textContent = line;
  } else if (asking) {
    state.className = 'state off';
    state.textContent = 'Not connected. A session you start will be refused until it is.';
  } else {
    state.textContent = 'Not connected';
  }
  left.appendChild(state);
  row.appendChild(left);

  var go = el('button', null, have ? 'Replace' : 'Connect');
  if (!have) go.className = 'primary';
  go.setAttribute('aria-expanded', 'false');
  row.appendChild(go);
  box.appendChild(row);

  var step = el('div', 'step');
  step.hidden = true;
  box.appendChild(step);
  go.addEventListener('click', function () {
    step.hidden = !step.hidden;
    go.setAttribute('aria-expanded', String(!step.hidden));
    if (!step.hidden) begin(entry, hosts, step);
  });
  return box;
}

/**
 * Start a connection. Two shapes, and the difference is not cosmetic.
 *
 * A TOKEN belongs to the person: it is minted on the provider's own page and
 * pasted back, and it goes to every host at once. A CLAUDE SIGN-IN is a login
 * the CLI drives in a pane on one machine, so both halves have to reach the
 * same box, which is why this asks which one rather than guessing.
 *
 * @param {any} entry @param {string[]} hosts @param {HTMLElement} step
 */
async function begin(entry, hosts, step) {
  step.textContent = '';
  if (entry.provider !== 'claude') {
    // The catalogue carries the provider's own page with the scopes already
    // ticked, and the hint that says what they are for.
    if (entry.hint) step.appendChild(el('p', 'lede', entry.hint));
    step.appendChild(paste(entry, entry.url, 'Open ' + (entry.label || entry.provider), 'Paste the token', 'Connect', null));
    return;
  }

  if (hosts.length > 1 && !pendingHost) {
    step.appendChild(el('p', 'lede', 'A Claude sign-in happens on one machine, and the code goes back to that same machine. Which one?'));
    var picker = el('div', 'hosts');
    hosts.forEach(function (h) {
      var chip = el('button', 'chip', h);
      chip.addEventListener('click', function () {
        pendingHost = h;
        begin(entry, hosts, step);
      });
      picker.appendChild(chip);
    });
    step.appendChild(picker);
    return;
  }

  if (!pendingHost) pendingHost = hosts[0] || null;
  step.appendChild(el('p', 'lede', 'Starting a Claude sign-in on ' + (pendingHost || 'this fleet') + '.'));
  var reply;
  try {
    reply = await intent('connect', { provider: 'claude', scope: 'me' }, pendingHost);
  } catch (e) {
    step.textContent = '';
    step.appendChild(el('p', 'say bad', e.message));
    pendingHost = null;
    return;
  }
  step.textContent = '';
  if (!reply || reply.ok === false) {
    step.appendChild(el('p', 'say bad', (reply && reply.text) || 'That was refused.'));
    pendingHost = null;
    return;
  }
  var url = null;
  var cat = (reply.connections && reply.connections.catalogue) || [];
  cat.forEach(function (x) { if (x.provider === 'claude' && x.url) url = x.url; });
  if (!url) {
    // A REPLY WITH NO URL IS NOT A FAILURE TO HIDE. The pane may still be
    // opening, and the honest answer names what to do rather than showing an
    // empty box with a paste field under it.
    step.appendChild(el('p', 'say', reply.text || 'The sign-in started, and that machine has not published its address yet. Press Connect again in a moment.'));
    return;
  }
  step.appendChild(paste(entry, url, 'Open the Claude sign-in', 'Paste the code it gives you', 'Link', pendingHost));
}

/**
 * The two halves of every connection: a link out, and a field to paste into.
 *
 * A FORM, so Enter submits. A paste field with a button beside it that only
 * answers a click is a form nobody can finish from a keyboard, and pressing
 * Enter is what everybody does after pasting.
 *
 * @param {any} entry @param {string|null} url @param {string} open
 * @param {string} placeholder @param {string} action @param {string|null} host
 */
function paste(entry, url, open, placeholder, action, host) {
  var form = document.createElement('form');
  form.className = 'step';
  if (url) {
    var a = el('a', 'btn', open);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    form.appendChild(a);
  }
  var field = document.createElement('input');
  field.type = 'password';
  field.autocomplete = 'off';
  field.spellcheck = false;
  field.setAttribute('autocapitalize', 'off');
  field.setAttribute('autocorrect', 'off');
  field.setAttribute('aria-label', placeholder);
  field.placeholder = placeholder;
  // An on-screen keyboard covers the bottom third of a phone, and this field
  // is at the bottom of a card near the bottom of the page.
  field.addEventListener('focus', function () {
    if (field.scrollIntoView) field.scrollIntoView({ block: 'center' });
  });
  form.appendChild(field);

  var send = el('button', 'primary', action);
  send.type = 'submit';
  form.appendChild(send);
  var result = el('p', 'say');
  result.setAttribute('role', 'status');
  form.appendChild(result);

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var secret = field.value.trim();
    if (!secret) { tell(result, 'Nothing to send yet.', true); field.focus(); return; }
    send.disabled = true;
    tell(result, 'Checking it with ' + (entry.label || entry.provider) + '.');
    var reply;
    try {
      reply = await intent('link', { provider: entry.provider, secret: secret, scope: 'me' }, host);
    } catch (e2) {
      send.disabled = false;
      tell(result, e2.message, true);
      return;
    }
    send.disabled = false;
    // THE FIELD IS CLEARED EITHER WAY. A token left in an input is a token in
    // the DOM for as long as the page is open, and a refusal is the case where
    // somebody is most likely to leave the tab and come back to it.
    field.value = '';
    if (!reply || reply.ok === false) {
      tell(result, (reply && reply.text) || 'That was refused.', true);
      return;
    }
    pendingHost = null;
    tell(result, reply.text || 'Connected.');
    load();
  });
  return form;
}

// --- signing in -------------------------------------------------------------

/** One ID token, exchanged for a credential of this browser's own. */
async function finish(idToken) {
  tell(outSay, 'Signing in.');
  var res;
  try {
    res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: idToken, deviceName: 'a browser' }),
    });
  } catch (e) {
    tell(outSay, 'This browser could not reach the coordinator, so the sign-in was not sent anywhere.', true);
    return;
  }
  var body = await res.json().catch(function () { return {}; });
  if (!res.ok || !body.token) {
    tell(outSay, body.text || 'That sign-in was refused.', true);
    return;
  }
  token = body.token;
  who = (body.client && body.client.name) || '';
  try { localStorage.setItem(KEY, token); localStorage.setItem(WHO, who); } catch (e) {}
  show();
}

${
  signIn.google
    ? `window.addEventListener('load', function () {
  // A SILENT RETURN HERE IS A BLANK PAGE. If Google's script does not load,
  // blocked or offline or filtered upstream, the button area is empty and
  // nothing says why, which reads as a broken fleet rather than a blocked
  // script.
  if (!window.google) {
    tell(outSay, "Google's sign-in script did not load, so there is no button to press. Check that accounts.google.com is reachable from this browser.", true);
    return;
  }
  google.accounts.id.initialize({ client_id: ${scriptJson(signIn.google)}, callback: function (r) { finish(r.credential); } });
  google.accounts.id.renderButton(document.getElementById('g'), { theme: 'outline', size: 'large', width: 320 });
});`
    : ''
}
${
  signIn.apple
    ? `window.addEventListener('load', function () {
  if (!window.AppleID) return;
  AppleID.auth.init({ clientId: ${scriptJson(signIn.apple)}, scope: 'email', redirectURI: location.origin + '${MEMBER_PATH}', usePopup: true });
});
document.addEventListener('AppleIDSignInOnSuccess', function (e) { finish(e.detail.authorization.id_token); });
document.addEventListener('AppleIDSignInOnFailure', function () { tell(outSay, 'Apple sign-in was cancelled.', true); });`
    : ''
}

// Registered last, and its failure is silent on purpose: a browser that will
// not take a service worker is a browser that cannot install this page, which
// costs nothing that matters. Everything above works without one.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('${MEMBER_PATH}/sw.js', { scope: '${MEMBER_PATH}' }).catch(function () {});
}

show();
`;
}
