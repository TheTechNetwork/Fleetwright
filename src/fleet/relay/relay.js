// The relays: push and the GitHub OAuth callback, for coordinators that are
// not ours. docs/relay-terms.md is the specification, written before this
// file on purpose, and every promise in it is one a log line breaks; read it
// first. Issue #348.
//
// WHY THEY EXIST. A push notification is addressed to a specific app, and
// ours is woken only with our APNs key and our Firebase service account, so
// somebody else's coordinator cannot wake these apps on a phone. And GitHub
// sends a person back only to a `redirect_uri` registered on our App, so
// somebody else's coordinator cannot use the App's sign-in. Those two are the
// only parts of this product that cannot be self-hosted, and this is all of
// what we run for them. There is no shared coordinator here and there will
// not be one (docs/trust.md: a coordinator is trusted absolutely by its hosts).
//
// PORTABLE, like push.js. Nothing imports from `node:`, so the same code runs
// in its Worker (worker/src/relay.js) and in the tests.
//
// WHAT IS KEPT, which is the whole design:
//
//   f:<fleet>     a fleet: a hash of its secret, and, if it uses the OAuth
//                 relay, where its coordinator wants the person sent back and
//                 the public key the token is sealed to, and the day it was
//                 last used. No person, no email, no account: nothing here is
//                 linked to anybody. Forgotten after IDLE unused.
//   n:<scope>     a counter for the current window, which is overwritten when
//                 the window turns. Never appended to, so it is not a log of
//                 when anybody was notified.
//   s:sweep       the last fleet the idle sweep looked at (`sweep` below).
//
// WHAT IS NEVER KEPT: a notification, a device token, an authorization code, a
// token, a `state`. They arrive in a request and leave in a request, and the
// only thing that touches the log is a status code (`quiet` below).
//
// THE OAUTH TOKEN IS SEALED before it leaves, to the key the fleet registered,
// with the same scheme a notification is sealed to a phone with
// (push-crypto.js). This relay makes the exchange, because the App's client
// secret is ours and a secret handed to every self-hoster is not one, and it
// forwards only ciphertext. relay-terms.md names the version that forwards
// the token in the clear, so it is not written by accident: this is not it.

import { apnsPusher, fcmPusher, logPusher, parseServiceAccount, routingPusher } from '../push.js';
import { checkPublicKey, sealTo, toBase64Url } from '../push-crypto.js';

/** Every path this answers is under here. */
export const RELAY_PREFIX = '/relay/v1';

/**
 * The caps, per window, and the reason for each. Both relays send with our
 * credentials, and a loop upstream is indistinguishable from abuse: both end
 * with our APNs key throttled and everybody's notifications stopping. So a
 * fleet over its cap is refused, and nobody else is.
 */
export const LIMITS = Object.freeze({
  /** Notifications per fleet per hour. A busy fleet asks for a person a few dozen times a day; this is a loop, not a fleet. */
  push: Object.freeze({ max: 600, window: 3600_000 }),
  /** Live Activity updates per fleet per hour: a setup's steps, several a minute while one runs. */
  activity: Object.freeze({ max: 1200, window: 3600_000 }),
  /** Sign-ins through the OAuth relay per fleet per hour. */
  oauth: Object.freeze({ max: 60, window: 3600_000 }),
  /** New fleets per hour, across everybody: registering is open, so it is the one cap that is not per fleet. */
  register: Object.freeze({ max: 100, window: 3600_000 }),
});

/** A request is a page of notifications, in bytes. Anything bigger is not one. */
export const MAX_BODY = 64 * 1024;

/**
 * A callback, in bytes as it is kept. Measured after the URL is serialised,
 * because a path of non-ASCII characters is kept percent-encoded, nine bytes
 * for each one that arrived, and a callback is somebody's coordinator, not a
 * page of text.
 */
export const MAX_CALLBACK = 2048;

/**
 * A fleet nothing has used for this long is forgotten, counters and all.
 * Registering is open and every row lives in the one object every fleet
 * shares, so a row that never expires is storage any stranger can fill. A
 * fleet in use is touched at most once a day; one forgotten registers again
 * with scripts/relay-register.mjs.
 */
export const IDLE = 180 * 24 * 3600_000;
const TOUCH_EVERY = 24 * 3600_000;

/** Fleets the sweep looks at per registration: rows are only made there, so it keeps pace. */
const SWEEP_PAGE = 25;

/** The cookie that ties a sign-in to the browser that started it on the relay's page (`githubStart`). */
const SIGN_IN_COOKIE = '__Host-fleetwright-relay';
/** As long as the coordinator keeps its own state (oauth.js, STATE_TTL_MS). */
const SIGN_IN_SECONDS = 600;

/** Notifications in one request: a fleet has tens of phones, not thousands. */
export const MAX_ITEMS = 100;

/** What a fleet id and its secret look like: 16 and 32 random bytes, base64url. */
const FLEET_RE = /^[A-Za-z0-9_-]{22}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/** The coordinator's own `state`, as oauth.js mints it: an id, never a device's `d.` state. */
const INNER_STATE_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * @typedef {object} RelayStore
 * @property {(key: string) => Promise<any>} get
 * @property {(key: string, value: any) => Promise<void>} put
 * @property {(key: string) => Promise<void>} delete
 * @property {(options: { prefix: string, startAfter?: string, limit: number }) => Promise<Map<string, any>>} list
 *   in key order, as Durable Object storage lists
 */

/**
 * @typedef {object} RelayDeps
 * @property {RelayStore} store
 * @property {Record<string, string|undefined>} env
 * @property {import('../push.js').Pusher} [pusher]  injected by tests; otherwise built from env
 * @property {typeof fetch} [fetchImpl]  for GitHub's token endpoint
 * @property {() => number} [now]
 * @property {(n: number) => Uint8Array} [random]
 */

/**
 * One request, answered.
 *
 * @param {Request} request @param {RelayDeps} deps
 * @returns {Promise<Response>}
 */
export async function answerRelay(request, deps) {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(RELAY_PREFIX) ? url.pathname.slice(RELAY_PREFIX.length) : null;
  try {
    if (request.method === 'GET' && path === '/github/callback') return await githubCallback(request, url, deps);
    if (request.method === 'GET' && path === '/github/start') return await githubStartPage(url, deps);
    if (request.method !== 'POST' && request.method !== 'DELETE') return reply(405, { ok: false, text: 'Not a method this relay answers.' });
    const text = await readText(request);
    if (text === undefined) return tooBig();
    if (request.method === 'POST' && path === '/github/start') return await githubStart(request, url, text, deps);
    const body = parseJson(text);
    if (request.method === 'POST' && path === '/fleets') return await register(body, deps);
    const fleet = await authorise(request, deps);
    if (!fleet) return reply(401, { ok: false, text: 'That is not a fleet this relay knows, or not its secret.' });
    if (request.method === 'DELETE' && path === '/fleets/self') {
      await forget(deps, fleet.id);
      return reply(200, { ok: true, text: 'This fleet is forgotten. Nothing about it is kept here any more.' });
    }
    if (request.method === 'POST' && path === '/fleets/self') return await update(fleet, body, deps);
    if (request.method === 'POST' && path === '/push') return await push(fleet, body, deps);
    if (request.method === 'POST' && path === '/activity') return await activity(fleet, body, deps);
    return reply(404, { ok: false, text: 'Not a path this relay answers.' });
  } catch {
    // NOTHING ABOUT THE REQUEST IN THE LOG, including what went wrong with
    // it: an error's message can quote what it failed on.
    console.warn(`relay: ${request.method} ${path ?? 'outside the relay'} failed`);
    return reply(500, { ok: false, text: 'The relay could not do that. Nothing was kept.' });
  }
}

/**
 * A new fleet. Open to anybody, because there is nothing to sign in to and
 * nobody to vouch for a stranger's coordinator, so the cap is across everybody.
 *
 * @param {any} body @param {RelayDeps} deps
 */
async function register(body, deps) {
  const limited = await count(deps, 'register', 'all', LIMITS.register);
  if (limited) return limited;
  const fields = await oauthFields(body ?? {});
  if (typeof fields === 'string') return reply(400, { ok: false, text: fields });
  const now = (deps.now ?? Date.now)();
  await sweep(deps, now);
  const random = deps.random ?? ((/** @type {number} */ n) => crypto.getRandomValues(new Uint8Array(n)));
  const id = toBase64Url(random(16));
  const secret = toBase64Url(random(32));
  await deps.store.put(`f:${id}`, { secret: await sha256(secret), ...fields, made: now, used: now });
  return reply(201, {
    ok: true,
    fleet: id,
    secret,
    text: 'Keep the secret with the coordinator: it is shown once and kept here only as a hash.',
  });
}

/** @param {{ id: string, record: any }} fleet @param {any} body @param {RelayDeps} deps */
async function update(fleet, body, deps) {
  const fields = await oauthFields(body ?? {});
  if (typeof fields === 'string') return reply(400, { ok: false, text: fields });
  const { secret, made } = fleet.record;
  await deps.store.put(`f:${fleet.id}`, { secret, made, used: (deps.now ?? Date.now)(), ...fields });
  return reply(200, { ok: true, text: fields.callback ? 'Changed. Sign-ins come back to the new address.' : 'Changed. This fleet uses the push relay only.' });
}

/**
 * Where the OAuth relay sends a person back, and the key it seals to. Both
 * or neither: a callback with no key would be a token with nowhere sealed to
 * go, and a key with no callback is nothing to send.
 *
 * @param {any} body @returns {Promise<{ callback?: string, key?: string }|string>}
 */
async function oauthFields(body) {
  const { callback, key } = body;
  if (callback === undefined && key === undefined) return {};
  if (typeof callback !== 'string' || typeof key !== 'string') return 'The OAuth relay needs both a callback and a key, or neither.';
  let parsed;
  try {
    parsed = new URL(callback);
  } catch {
    return 'The callback is not an address.';
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return 'The callback is an https address with no query, fragment or credentials.';
  }
  if (new TextEncoder().encode(parsed.toString()).byteLength > MAX_CALLBACK) return `The callback is at most ${MAX_CALLBACK} bytes as an address.`;
  const checked = await checkPublicKey(key);
  if (!checked.ok) return `The key: ${checked.error}.`;
  return { callback: parsed.toString(), key };
}

/**
 * The fleet a request is from, by `Authorization: Bearer <fleet>.<secret>`,
 * or null. Compared as hashes, so the comparison takes the same time however
 * much of a guess was right.
 *
 * @param {Request} request @param {RelayDeps} deps
 */
async function authorise(request, deps) {
  const header = request.headers.get('authorization') ?? '';
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(header);
  if (!m || !FLEET_RE.test(m[1]) || !SECRET_RE.test(m[2])) return null;
  const record = await deps.store.get(`f:${m[1]}`);
  if (!record?.secret) return null;
  return (await sha256(m[2])) === record.secret ? { id: m[1], record: await touch(deps, m[1], record) } : null;
}

/**
 * A fleet, marked used today, so the sweep leaves it alone. At most one write
 * a day, not one a request.
 *
 * @param {RelayDeps} deps @param {string} id @param {any} record
 */
async function touch(deps, id, record) {
  const now = (deps.now ?? Date.now)();
  if (now - (record.used ?? record.made ?? 0) < TOUCH_EVERY) return record;
  const touched = { ...record, used: now };
  await deps.store.put(`f:${id}`, touched);
  return touched;
}

/** A fleet and its counters, gone. @param {RelayDeps} deps @param {string} id */
async function forget(deps, id) {
  await deps.store.delete(`f:${id}`);
  for (const scope of /** @type {(keyof typeof LIMITS)[]} */ (['push', 'activity', 'oauth'])) await deps.store.delete(`n:${scope}:${id}`);
}

/**
 * The next few fleets, and any of them unused for IDLE, forgotten. Run on
 * every registration, the one place a row is made, and resumed from where
 * the last one stopped, so the fleets kept never outgrow what a sweep at that
 * pace keeps up with, and no request lists the whole store.
 *
 * @param {RelayDeps} deps @param {number} now
 */
async function sweep(deps, now) {
  const after = await deps.store.get('s:sweep');
  const page = await deps.store.list({ prefix: 'f:', ...(typeof after === 'string' ? { startAfter: after } : {}), limit: SWEEP_PAGE });
  for (const [key, row] of page) {
    if (now - (row?.used ?? row?.made ?? 0) > IDLE) await forget(deps, key.slice(2));
  }
  // A short page is the end of the fleets: the next sweep starts again.
  if (page.size < SWEEP_PAGE) {
    if (after !== undefined) await deps.store.delete('s:sweep');
  } else {
    await deps.store.put('s:sweep', [...page.keys()].at(-1));
  }
}

/**
 * Notifications, delivered. Each arrives with its envelope already made by
 * the sending coordinator (push.js, envelopeFor), so a phone that registered
 * a key gets ciphertext this relay cannot read; one that did not gets what
 * its coordinator chose to send it in the clear. Not edited here: a relay
 * that changed a notification could change what somebody is agreeing to.
 *
 * @param {{ id: string }} fleet @param {any} body @param {RelayDeps} deps
 */
async function push(fleet, body, deps) {
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items || !items.length || items.length > MAX_ITEMS || !items.every(isItem)) {
    return reply(400, { ok: false, text: `A push is 1 to ${MAX_ITEMS} items, each a token, a platform and an envelope.` });
  }
  const limited = await count(deps, 'push', fleet.id, LIMITS.push, items.length);
  if (limited) return limited;
  const message = {
    title: '',
    body: '',
    ...(typeof body.category === 'string' && body.category ? { category: body.category } : {}),
    ...(body.drawnByApp === true ? { drawnByApp: true } : {}),
    ...(body.wake === true ? { wake: true } : {}),
  };
  const devices = items.map((/** @type {any} */ i) => ({ token: i.token, platform: i.platform, wire: i.wire }));
  const { sent, dead } = await pusherFor(deps).send(devices, message);
  return reply(200, { ok: true, sent, dead });
}

/** @param {{ id: string }} fleet @param {any} body @param {RelayDeps} deps */
async function activity(fleet, body, deps) {
  const tokens = Array.isArray(body?.tokens) ? body.tokens : null;
  const update = body?.update;
  if (!tokens || !tokens.length || tokens.length > MAX_ITEMS || !tokens.every((/** @type {any} */ t) => isToken(t))
    || (update?.event !== 'update' && update?.event !== 'end') || !update.state || typeof update.state !== 'object') {
    return reply(400, { ok: false, text: `An activity update is 1 to ${MAX_ITEMS} tokens and an update.` });
  }
  const limited = await count(deps, 'activity', fleet.id, LIMITS.activity, tokens.length);
  if (limited) return limited;
  const pusher = pusherFor(deps);
  const { sent, dead } = pusher.activity ? await pusher.activity(tokens, update) : { sent: 0, dead: [] };
  return reply(200, { ok: true, sent, dead });
}

/** @param {unknown} t */
function isToken(t) {
  return typeof t === 'string' && t.length > 0 && t.length <= 400;
}

/** @param {any} i */
function isItem(i) {
  const w = i?.wire;
  return isToken(i?.token) && typeof i?.platform === 'string' && i.platform.length <= 20
    && w && typeof w.encrypted === 'boolean' && typeof w.title === 'string' && typeof w.body === 'string'
    && w.data && typeof w.data === 'object' && Object.values(w.data).every((v) => typeof v === 'string');
}

/**
 * The fleet a sign-in `state` names, if it is one that can be signed in to:
 * `<fleet>.<the coordinator's own state>`, a fleet with a callback and a key.
 *
 * @param {string} state @param {RelayDeps} deps
 * @returns {Promise<{ id: string, inner: string, record: any }|null>}
 */
async function signInFleet(state, deps) {
  const dot = state.indexOf('.');
  const id = dot > 0 ? state.slice(0, dot) : '';
  const inner = dot > 0 ? state.slice(dot + 1) : '';
  const record = FLEET_RE.test(id) && INNER_STATE_RE.test(inner) ? await deps.store.get(`f:${id}`) : null;
  return record?.callback && record?.key ? { id, inner, record } : null;
}

/** The words for a sign-in this relay will not finish or start. One for every reason, so a stranger learns nothing from which. */
const NOT_STARTED = 'This relay cannot tell that this sign-in started here, in this browser. Start again from the app.';

/**
 * WHERE A SIGN-IN STARTS, and the reason it starts here and not at GitHub.
 * Registering is open, so anybody can register a fleet with a callback and a
 * key of their own, and every fleet shares our App: its consent screen says
 * Fleetwright whichever fleet the `state` names, and GitHub skips it for
 * somebody who has said yes once. A github.com link naming a stranger's fleet
 * would send that person's token to the stranger. So the coordinator sends a
 * person here first (oauth.js, relayAuthorizeUrl), this page names the
 * coordinator the token will go to, and only its button, posted from this
 * page, sends them on to GitHub.
 *
 * @param {URL} url @param {RelayDeps} deps
 */
async function githubStartPage(url, deps) {
  const state = url.searchParams.get('state') ?? '';
  const flow = await signInFleet(state, deps);
  if (!flow) return page(400, NOT_STARTED);
  const host = new URL(flow.record.callback).host;
  return html(200, `<p>You are connecting GitHub to the coordinator at <strong>${escape(host)}</strong>. The access GitHub grants is sent there and nowhere else.</p>`
    + `<p>Continue only if ${escape(host)} is the coordinator you are setting up. If a link you did not ask for brought you here, close this page.</p>`
    + `<form method="post" action="${RELAY_PREFIX}/github/start"><input type="hidden" name="state" value="${escape(state)}"><button type="submit">Continue to GitHub</button></form>`);
}

/**
 * The button on that page. Posted from it, or from nowhere: a form on some
 * other site that posts here would skip the page, so the Origin has to be
 * the relay's own. The cookie it sets is what the callback asks for, so a
 * code reaches a fleet only in the browser that saw that fleet named.
 *
 * @param {Request} request @param {URL} url @param {string} text @param {RelayDeps} deps
 */
async function githubStart(request, url, text, deps) {
  if (request.headers.get('origin') !== url.origin) return page(403, NOT_STARTED);
  const state = new URLSearchParams(text).get('state') ?? '';
  const flow = await signInFleet(state, deps);
  if (!flow) return page(400, NOT_STARTED);
  const clientId = deps.env.FLEETWRIGHT_GITHUB_CLIENT_ID;
  if (!clientId) return page(503, 'Signing in through this relay is not available right now. Nothing was sent to GitHub.');
  const to = new URL('https://github.com/login/oauth/authorize');
  to.searchParams.set('client_id', clientId);
  to.searchParams.set('redirect_uri', `${url.origin}${RELAY_PREFIX}/github/callback`);
  to.searchParams.set('state', state);
  // A hash of the state, not the state: the browser holds the binding, and
  // the relay still holds nothing (relay-terms.md, "What is written down").
  // Lax, because GitHub sends the person back with a top-level GET.
  return new Response(null, {
    status: 303,
    headers: {
      location: to.toString(),
      'set-cookie': `${SIGN_IN_COOKIE}=${await sha256(state)}; Path=/; Max-Age=${SIGN_IN_SECONDS}; Secure; HttpOnly; SameSite=Lax`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

/**
 * GitHub, sending a person back. `state` is `<fleet>.<the coordinator's own
 * state>`: the fleet says where the result goes, and the rest is the
 * coordinator's to redeem, which it does once (oauth.js). The code is
 * exchanged here with the client secret, the answer sealed to the fleet's
 * key, and the person sent on with only ciphertext.
 *
 * Only for a sign-in this browser started on the relay's page for that
 * fleet (`githubStart`), checked before the code goes anywhere: a code that
 * arrives any other way is refused, unexchanged, and nobody is sent on.
 *
 * Nothing is kept: a replayed callback is refused by GitHub, which takes a
 * code once, and then by the coordinator, which takes a state once.
 *
 * @param {Request} request @param {URL} url @param {RelayDeps} deps
 */
async function githubCallback(request, url, deps) {
  const state = url.searchParams.get('state') ?? '';
  const started = cookie(request, SIGN_IN_COOKIE);
  const flow = started && started === (await sha256(state)) ? await signInFleet(state, deps) : null;
  // One page for every way of not being one of ours: telling a stranger
  // which it was is telling them whether a fleet exists.
  if (!flow) return page(400, NOT_STARTED);
  const { id, inner } = flow;
  const record = await touch(deps, id, flow.record);
  const back = new URL(record.callback);
  back.searchParams.set('state', inner);
  const limited = await count(deps, 'oauth', id, LIMITS.oauth);
  if (limited) return redirect(back, { error: 'limited' });
  const code = url.searchParams.get('code');
  // Denied on GitHub's page: said to the coordinator in one word, never in
  // the query's own words, which anybody could have written.
  if (!code) return redirect(back, { error: 'denied' });
  const { FLEETWRIGHT_GITHUB_CLIENT_ID: clientId, FLEETWRIGHT_GITHUB_CLIENT_SECRET: clientSecret } = deps.env;
  if (!clientId || !clientSecret) return redirect(back, { error: 'unavailable' });
  const res = await (deps.fetchImpl ?? fetch)('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${url.origin}${RELAY_PREFIX}/github/callback`,
    }),
  });
  const tokens = /** @type {any} */ (res.ok ? await res.json().catch(() => null) : null);
  if (typeof tokens?.access_token !== 'string' || !tokens.access_token) return redirect(back, { error: 'exchange' });
  // THE STATE GOES INSIDE TOO. The fleet's key is public, so anybody can seal
  // something to it; what they cannot do is seal it for a state they never
  // saw, and the coordinator takes a sealed token only for the state it came
  // back with (core.js, finishRelayedGithubAuthorization).
  const sealed = await sealTo(record.key, {
    state: inner,
    accessToken: tokens.access_token,
    expiresIn: Number.isFinite(tokens.expires_in) ? tokens.expires_in : null,
    scope: typeof tokens.scope === 'string' ? tokens.scope : null,
  });
  return redirect(back, { sealed });
}

/**
 * The senders, from the relay's own secrets: our APNs key and our Firebase
 * service account. Built per request, because a Worker isolate is not
 * promised to outlive one, and logging through `quiet`.
 *
 * @param {RelayDeps} deps
 */
function pusherFor(deps) {
  if (deps.pusher) return deps.pusher;
  const env = deps.env;
  const ios = env.FLEETWRIGHT_APNS_KEY && env.FLEETWRIGHT_APNS_KEY_ID && env.FLEETWRIGHT_APNS_TEAM_ID
    ? apnsPusher({
      keyId: env.FLEETWRIGHT_APNS_KEY_ID,
      teamId: env.FLEETWRIGHT_APNS_TEAM_ID,
      privateKey: env.FLEETWRIGHT_APNS_KEY,
      bundleId: env.FLEETWRIGHT_APNS_BUNDLE_ID || 'network.thetech.fleetwright',
      production: env.FLEETWRIGHT_APNS_SANDBOX !== '1',
    }, { logger: quiet })
    : logPusher(quiet);
  const account = env.FLEETWRIGHT_FCM_SERVICE_ACCOUNT ? parseServiceAccount(env.FLEETWRIGHT_FCM_SERVICE_ACCOUNT) : null;
  const other = account?.client_email && account.private_key && account.project_id ? fcmPusher(account, { logger: quiet }) : logPusher(quiet);
  return routingPusher({ ios, other, logger: quiet });
}

/**
 * The only logger the senders get here. They log a provider's answer, and an
 * answer can quote what it was sent, so this keeps the HTTP status and drops
 * every other word.
 */
export const quiet = Object.freeze({
  info() {},
  /** @param {unknown} message */
  warn(message) {
    const status = /\b[45]\d\d\b/.exec(String(message))?.[0];
    console.warn(`relay: a provider refused one${status ? ` (${status})` : ''}`);
  },
});

/**
 * One more of `n` in this window, or the refusal that says the cap and when
 * it resets. The record is overwritten when the window turns, never appended.
 *
 * @param {RelayDeps} deps @param {string} scope @param {string} id
 * @param {{ max: number, window: number }} limit @param {number} [n]
 * @returns {Promise<Response|null>}
 */
async function count(deps, scope, id, limit, n = 1) {
  const now = (deps.now ?? Date.now)();
  const window = now - (now % limit.window);
  const key = `n:${scope}:${id}`;
  const was = await deps.store.get(key);
  const used = was?.window === window ? Number(was.used) || 0 : 0;
  const resetAt = window + limit.window;
  if (used + n > limit.max) {
    return reply(429, {
      ok: false,
      limited: true,
      limit: limit.max,
      resetAt,
      text: `This fleet is over the relay's ${scope} limit of ${limit.max} an hour. It resets at ${new Date(resetAt).toISOString()}.`,
    }, { 'retry-after': String(Math.ceil((resetAt - now) / 1000)) });
  }
  await deps.store.put(key, { window, used: used + n });
  return null;
}

/**
 * The body's bytes, or undefined for more than MAX_BODY of them.
 *
 * READ NO FURTHER THAN THE CAP. This runs before anybody is authorised, in
 * the one object every fleet shares, so a body read whole and measured
 * afterwards is memory any stranger can spend there. A declared length over
 * the cap is refused unread; anything else is read until it ends or passes
 * the cap, and counted in bytes, not in UTF-16 units.
 *
 * @param {Request} request @returns {Promise<Uint8Array|undefined>}
 */
export async function readBytes(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) return undefined;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return bytes;
}

/** The body as text, or undefined for over the cap. @param {Request} request */
async function readText(request) {
  const bytes = await readBytes(request);
  return bytes && new TextDecoder().decode(bytes);
}

/** The refusal for a body over MAX_BODY, here and in the Worker in front of this. */
export function tooBig() {
  return reply(413, { ok: false, text: `A request is at most ${MAX_BODY} bytes.` });
}

/** The body, parsed, or null for none or not JSON. @param {string} text */
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** One cookie's value from the request, or null. @param {Request} request @param {string} name */
function cookie(request, name) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** @param {string} value */
async function sha256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {number} status @param {any} body @param {Record<string, string>} [headers] */
function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}

/** @param {URL} back @param {Record<string, string>} params */
function redirect(back, params) {
  const to = new URL(back);
  for (const [k, v] of Object.entries(params)) to.searchParams.set(k, v);
  // Referrer-Policy so the coordinator's page is not told the relay's URL
  // with the code still in it.
  // The sign-in is over either way, so its cookie goes with it.
  return new Response(null, {
    status: 303,
    headers: {
      location: to.toString(),
      'set-cookie': `${SIGN_IN_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** @param {string} text */
function escape(text) {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

/** @param {number} status @param {string} text */
function page(status, text) {
  return html(status, `<p>${escape(text)}</p>`);
}

/**
 * Never in a frame: the sign-in page is a button somebody else's page could
 * lay its own words over.
 *
 * @param {number} status @param {string} body  already escaped
 */
function html(status, body) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fleetwright</title>${body}`, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    },
  });
}
