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
//                 the public key the token is sealed to. No person, no email,
//                 no account: nothing here is linked to anybody.
//   n:<scope>     a counter for the current window, which is overwritten when
//                 the window turns. Never appended to, so it is not a log of
//                 when anybody was notified.
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

/** A request is a page of notifications. Anything bigger is not one. */
export const MAX_BODY = 64 * 1024;

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
    if (request.method === 'GET' && path === '/github/callback') return await githubCallback(url, deps);
    if (request.method !== 'POST' && request.method !== 'DELETE') return reply(405, { ok: false, text: 'Not a method this relay answers.' });
    const body = await readBody(request);
    if (body === undefined) return reply(413, { ok: false, text: `A request is at most ${MAX_BODY} bytes.` });
    if (request.method === 'POST' && path === '/fleets') return await register(body, deps);
    const fleet = await authorise(request, deps);
    if (!fleet) return reply(401, { ok: false, text: 'That is not a fleet this relay knows, or not its secret.' });
    if (request.method === 'DELETE' && path === '/fleets/self') {
      await deps.store.delete(`f:${fleet.id}`);
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
  const random = deps.random ?? ((/** @type {number} */ n) => crypto.getRandomValues(new Uint8Array(n)));
  const id = toBase64Url(random(16));
  const secret = toBase64Url(random(32));
  await deps.store.put(`f:${id}`, { secret: await sha256(secret), ...fields, made: (deps.now ?? Date.now)() });
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
  await deps.store.put(`f:${fleet.id}`, { secret, made, ...fields });
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
  return (await sha256(m[2])) === record.secret ? { id: m[1], record } : null;
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
 * GitHub, sending a person back. `state` is `<fleet>.<the coordinator's own
 * state>`: the fleet says where the result goes, and the rest is the
 * coordinator's to redeem, which it does once (oauth.js). The code is
 * exchanged here with the client secret, the answer sealed to the fleet's
 * key, and the person sent on with only ciphertext.
 *
 * Nothing is kept: a replayed callback is refused by GitHub, which takes a
 * code once, and then by the coordinator, which takes a state once.
 *
 * @param {URL} url @param {RelayDeps} deps
 */
async function githubCallback(url, deps) {
  const state = url.searchParams.get('state') ?? '';
  const dot = state.indexOf('.');
  const id = dot > 0 ? state.slice(0, dot) : '';
  const inner = dot > 0 ? state.slice(dot + 1) : '';
  const record = FLEET_RE.test(id) && INNER_STATE_RE.test(inner) ? await deps.store.get(`f:${id}`) : null;
  // One page for every way of not being one of ours: telling a stranger
  // which it was is telling them whether a fleet exists.
  if (!record?.callback || !record?.key) return page(400, 'That sign-in did not come from a fleet this relay knows. Start again from the app.');
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
  const sealed = await sealTo(record.key, {
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

/** The body, parsed, or null for none, or undefined for too big. @param {Request} request */
async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return undefined;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
  return new Response(null, { status: 303, headers: { location: to.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

/** @param {number} status @param {string} text */
function page(status, text) {
  const safe = text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fleetwright</title><p>${safe}</p>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
  });
}
