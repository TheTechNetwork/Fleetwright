// A person's whole Claude sign-in, kept by the minter and renewed only here.
//
// WHY A SIGN-IN AND NOT ONLY A SETUP-TOKEN. A `claude setup-token` runs
// sessions and nothing else: Remote Control, which is how a phone watches a
// session on a box, needs the login `claude auth login` makes. That login was
// made on each box from its page ("Sign in to Claude"), so every box held its
// own copy with its own refresh token, renewing it on its own clock, which is
// the race the vault exists to end (docs/vault.md): two boxes renewing one
// refresh token, and the loser signed out.
//
// SO THE REFRESH TOKEN LIVES HERE AND NOWHERE ELSE. A box is given the access
// token, its expiry and the account it belongs to, never the refresh token,
// and asks again before it runs out, as it already does every ten minutes. A
// Claude Code with no refresh token in its credentials file does not try to
// renew: it reads the file again, which is where the box has written a fresh
// one (src/core/vault-store.js).
//
// RENEWED THE WAY CLAUDE CODE RENEWS IT, against the same address with the
// same public client and the scopes the sign-in was granted: read off Claude
// Code's own code (2.1.42, and again on 2.1.306, the version the session
// image pins), not guessed, because a renewal that is wrong signs the person
// out everywhere at once. If Anthropic moves it, renewing fails with a sentence, and the boxes
// keep the access token they have until it runs out.
//
// The row it lives in is the one a runner reads (claude.js), sealed at rest to
// the deposit key under the person's GitHub id, the same as a setup-token.

import { atRestAad, seal, open } from '../seal.js';

export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/**
 * Asked for only when a sign-in names no scopes of its own. A renewal asks
 * for the scopes the sign-in was granted, which is what Claude Code falls back
 * to when its own wider ask is refused (2.1.306): asking for one it was never
 * granted is `invalid_scope`, a 400 that would read here as Claude refusing
 * the sign-in, and asking for fewer would hand boxes a narrower token than
 * the person signed in for.
 */
export const CLAUDE_SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers'];

/** Renewed when less than this is left, as the vault's other sign-ins are. */
export const CLAUDE_REFRESH_AHEAD_MS = 30 * 60_000;

/**
 * WHERE EACH RENEWAL IS NOTED, beside the row it renewed, so a sign-in that
 * stops working can be told apart: renewed here, or cancelled from outside.
 * A sign-in on vnic-runner-oci was refused with "Refresh token not found or
 * invalid" and nothing kept said when it had last been renewed, or by whom,
 * so whether the fleet had done it was a reading of code rather than a fact.
 */
export const RENEWALS_PREFIX = 'claude-renewed:';

/** A day of renewals at one every few hours, and the one before a refusal. */
const RENEWALS_KEPT = 12;

/**
 * WHERE A SIGN-IN ENDED OUTSIDE THE FLEET IS NOTED as told, by the time it
 * was kept, so the person is told once per sign-in and told again only about
 * the next one they keep.
 */
export const ENDED_PREFIX = 'claude-ended:';

/**
 * What a sign-in's access token is asked with to see whether it still works:
 * the address `/usage` reads (src/core/usage.js, USAGE_URL, which a test holds
 * this equal to). It costs nothing, unlike a message, and answers 401 to a
 * token Anthropic has ended. Not imported, because usage.js reads files and
 * this runs in a Worker.
 */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** One printable word of a sane length: the format is Anthropic's and undocumented. */
const TOKEN_WORD_RE = /^[A-Za-z0-9._~+/=-]{20,4096}$/;

/** The account fields a box's Claude Code reads beside the credential, and nothing else. */
const ACCOUNT_FIELDS = ['accountUuid', 'emailAddress', 'organizationUuid', 'organizationName', 'organizationRole', 'workspaceRole', 'displayName', 'billingType', 'hasExtraUsageEnabled'];

/**
 * @typedef {object} ClaudeOauth  what `claude auth login` writes as `claudeAiOauth`
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} expiresAt   epoch ms
 * @property {string[]} scopes
 * @property {string|null} subscriptionType
 * @property {string|null} rateLimitTier
 * @property {number|null} [refreshTokenExpiresAt]  epoch ms, when Anthropic said the refresh token stops
 *   working: written by Claude Code from `refresh_token_expires_in`, and read here from a renewal's answer
 */

/**
 * A sign-in as a machine read it off `claude auth login` and a phone sent it,
 * held to the fields this keeps and no more: anything else in the file stays
 * on the machine that made it.
 *
 * @param {unknown} v  `{ oauth: { accessToken, refreshToken, expiresAt, scopes, ... }, account: {...} }`
 * @returns {{ oauth: ClaudeOauth, account: Record<string, unknown> } | null}
 */
export function claudeSignIn(v) {
  const o = /** @type {any} */ (v)?.oauth;
  if (!o || typeof o !== 'object') return null;
  const accessToken = String(o.accessToken ?? '');
  const refreshToken = String(o.refreshToken ?? '');
  const expiresAt = Number(o.expiresAt);
  // KEPT, where it was dropped: how long the refresh token lasts, which is
  // the one thing that says whether eight hours of access outlive it.
  const refreshTokenExpiresAt = Number(o.refreshTokenExpiresAt);
  if (!TOKEN_WORD_RE.test(accessToken) || !TOKEN_WORD_RE.test(refreshToken) || !Number.isFinite(expiresAt)) return null;
  const scopes = Array.isArray(o.scopes) ? o.scopes.map(String).filter((/** @type {string} */ s) => /^[a-z_:]{1,64}$/.test(s)).slice(0, 16) : [];
  const short = (/** @type {unknown} */ s) => (typeof s === 'string' && s.length <= 64 ? s : null);
  /** @type {Record<string, unknown>} */
  const account = {};
  const a = /** @type {any} */ (v)?.account;
  if (a && typeof a === 'object') {
    for (const f of ACCOUNT_FIELDS) {
      const x = a[f];
      if ((typeof x === 'string' && x.length <= 256) || typeof x === 'boolean') account[f] = x;
    }
  }
  return {
    oauth: {
      accessToken, refreshToken, expiresAt, scopes, subscriptionType: short(o.subscriptionType), rateLimitTier: short(o.rateLimitTier),
      refreshTokenExpiresAt: Number.isFinite(refreshTokenExpiresAt) && refreshTokenExpiresAt > 0 ? refreshTokenExpiresAt : null,
    },
    account,
  };
}

/**
 * Renew a sign-in, the request Claude Code makes.
 *
 * `refused` is Anthropic saying no (the refresh token was revoked, or used
 * already), which only signing in again mends; anything else is cannot tell,
 * and the access token held is still good until it runs out.
 *
 * @param {ClaudeOauth} oauth
 * @param {{ fetchImpl: typeof fetch, now: () => number }} io
 * @returns {Promise<{ ok: true, oauth: ClaudeOauth, rotated: boolean } | { ok: false, refused: boolean, message: string }>}
 *   `rotated`: a new refresh token came back
 */
export async function renewClaudeSignIn(oauth, { fetchImpl, now }) {
  let res;
  try {
    res = await fetchImpl(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: CLAUDE_CLIENT_ID, scope: (oauth.scopes?.length ? oauth.scopes : CLAUDE_SCOPES).join(' ') }),
    });
  } catch (e) {
    return { ok: false, refused: false, message: `Claude could not be reached to renew it (${/** @type {Error} */ (e).message})` };
  }
  /** @type {any} */
  const body = await res.json().catch(() => null);
  if (res.status === 400 || res.status === 401) {
    const why = typeof body?.error_description === 'string' ? body.error_description : typeof body?.error === 'string' ? body.error : `${res.status}`;
    return { ok: false, refused: true, message: `Claude refused to renew it (${why.slice(0, 160)})` };
  }
  if (!res.ok || typeof body?.access_token !== 'string' || !Number.isFinite(Number(body?.expires_in))) {
    return { ok: false, refused: false, message: `Claude answered ${res.status} to the renewal` };
  }
  const given = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null;
  const rotated = given !== null && given !== oauth.refreshToken;
  return {
    ok: true,
    rotated,
    oauth: {
      ...oauth,
      accessToken: body.access_token,
      // KEPT WHEN NOT GIVEN, as Claude Code does: a renewal may or may not
      // rotate the refresh token.
      refreshToken: given ?? oauth.refreshToken,
      expiresAt: now() + Number(body.expires_in) * 1000,
      scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : oauth.scopes,
      // FROM THE ANSWER WHEN IT SAYS. When it does not, a refresh token that
      // was kept keeps its expiry, which is still true, and a new one has
      // none known. Claude Code carries the old expiry over either way, but
      // never renews because of it; this does (freshClaude), and timing a
      // new refresh token by the one it replaced renewed on every ask once
      // that expiry was inside CLAUDE_REFRESH_AHEAD_MS.
      refreshTokenExpiresAt: Number.isFinite(Number(body.refresh_token_expires_in)) && Number(body.refresh_token_expires_in) > 0
        ? now() + Number(body.refresh_token_expires_in) * 1000
        : rotated ? null : oauth.refreshTokenExpiresAt ?? null,
    },
  };
}

/**
 * @typedef {object} HeldClaude
 * @property {'token'|'login'} kind
 * @property {string} bearer     what a session authenticates with: the setup-token, or the access token
 * @property {number|null} expiresAt
 * @property {ClaudeOauth|null} oauth
 * @property {Record<string, unknown>|null} account
 */

/**
 * The person's Claude row opened, and renewed first if it is a sign-in that is
 * due. Call it under the person's lock (vault.js, withLock): renewing rotates
 * the refresh token, and two renewals at once sign the person out.
 *
 * WRITTEN BACK ONLY OVER THE ROW IT READ. A deposit is kept by the Worker in
 * front of the vault's object, outside that lock, so the row is read again
 * after the renewal and left alone if a newer one arrived meanwhile.
 *
 * @param {{ get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void> }} store
 * @param {{ privateKey: CryptoKey, publicKey: string }} key
 * @param {string} userId
 * @param {{ fetchImpl: typeof fetch, now: () => number, by?: string, force?: boolean }} io  `by`: who asked, for the
 *   note a renewal leaves; `force`: renew even if it is not due, when its access token was just refused
 * @returns {Promise<{ held: HeldClaude|null, problem: string|null, refused?: boolean }>}
 */
export async function freshClaude(store, key, userId, io) {
  const row = await store.get(`gh:${userId}`);
  if (!row?.sealed || row.forgotten) return { held: null, problem: null };
  /** @type {any} */
  let inside;
  try {
    inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: atRestAad(userId), sealed: row.sealed });
  } catch {
    return { held: null, problem: 'Your Claude login does not open with this minter’s key; keep it again.' };
  }
  if (!inside?.oauth) {
    return { held: { kind: 'token', bearer: String(inside?.token || ''), expiresAt: null, oauth: null, account: null }, problem: null };
  }
  /** @type {ClaudeOauth} */
  let oauth = inside.oauth;
  const account = inside.account && typeof inside.account === 'object' ? inside.account : {};
  /** @type {string|null} */
  let problem = null;
  let refused = false;
  // DUE when the access token is close to running out, or the refresh token
  // is: a refresh token that runs out first is a sign-in lost with hours of
  // access left, which is how both refusals looked.
  const due = (/** @type {unknown} */ t) => Number.isFinite(Number(t)) && Number(t) > 0 && Number(t) - io.now() < CLAUDE_REFRESH_AHEAD_MS;
  let renew = io.force || due(oauth.expiresAt);
  if (!renew && due(oauth.refreshTokenExpiresAt)) {
    // NOT AGAIN FOR A REFRESH TOKEN A RENEWAL ALREADY KEPT. Its expiry is
    // still true, but renewing cannot move it: the last renewal gave back
    // the same token. Renewing on every ask until it ran out ended the token
    // every box holds each time.
    const last = [...(await claudeRenewals(store, userId, row.at))].reverse().find((n) => n.ok);
    renew = !(last?.rotated === false && Number(last.refreshUntil) === Number(oauth.refreshTokenExpiresAt));
  }
  if (renew) {
    // NOTED BEFORE IT IS ASKED FOR, and settled after. Anthropic rotates the
    // refresh token the moment it answers; a renewal cut off before the new
    // one is written back (a deploy restarting this object, say) loses it,
    // and the note left unsettled is how that is told from a sign-in
    // cancelled somewhere else.
    /** @type {ClaudeRenewal} */
    const note = { at: io.now(), by: io.by ?? null, ok: false, pending: true };
    await noteRenewal(store, userId, note);
    const r = await renewClaudeSignIn(oauth, io);
    delete note.pending;
    note.ok = r.ok;
    if (r.ok) {
      oauth = r.oauth;
      note.until = Number(oauth.expiresAt);
      note.rotated = r.rotated;
      if (oauth.refreshTokenExpiresAt) note.refreshUntil = Number(oauth.refreshTokenExpiresAt);
      const now = await store.get(`gh:${userId}`);
      if (now && Number(now.at) === Number(row.at) && now.sealed === row.sealed) {
        await store.put(`gh:${userId}`, { ...row, sealed: await seal({ to: key.publicKey, aad: atRestAad(userId), payload: { oauth, account } }) });
      } else {
        note.dropped = true;
      }
    } else {
      refused = r.refused;
      note.refused = r.refused;
      note.why = r.message.slice(0, 200);
      problem = r.refused
        ? `${r.message}. Sign in to Claude again from your phone or the signing page; until then nothing can be given your login once it runs out.`
        : `${r.message}; the login held is good until it runs out.`;
    }
    await noteRenewal(store, userId, note, { settles: true });
  }
  if (Number(oauth.expiresAt) <= io.now()) {
    return { held: null, problem: problem ?? 'Your Claude sign-in has run out. Sign in to Claude again from your phone or the signing page.', refused: true };
  }
  return { held: { kind: 'login', bearer: oauth.accessToken, expiresAt: Number(oauth.expiresAt), oauth, account }, problem, refused };
}

/**
 * @typedef {object} ClaudeRenewal  one renewal of a person's sign-in, as noted
 * @property {number} at          when it was asked for, epoch ms
 * @property {string|null} by     who asked: a box, a runner, a test
 * @property {boolean} ok
 * @property {number} [until]     the new access token's expiry, when it worked
 * @property {number} [refreshUntil]  the refresh token's, when Anthropic said
 * @property {boolean} [rotated]  a new refresh token came back, when it worked
 * @property {boolean} [refused]  Anthropic said no, which only signing in again mends
 * @property {string} [why]       what was said, when it did not work
 * @property {boolean} [dropped]  renewed while a new sign-in was being kept, so not written back
 * @property {boolean} [pending]  asked for and never settled: cut off before its answer was kept
 */

/**
 * Note one renewal, under the lock the renewal ran under, or settle the note
 * it began with. Holds no token: when, who asked and what came back, so it
 * is kept in the clear.
 *
 * @param {{ get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void> }} store
 * @param {string} userId @param {ClaudeRenewal} note
 * @param {{ settles?: boolean }} [opts]  replace the unsettled note made at `note.at`
 */
async function noteRenewal(store, userId, note, { settles = false } = {}) {
  try {
    const before = await store.get(`${RENEWALS_PREFIX}${userId}`);
    const list = Array.isArray(before) ? before : [];
    const open = settles ? list.findIndex((n) => n?.pending && Number(n.at) === note.at) : -1;
    const next = open >= 0 ? list.map((n, i) => (i === open ? { ...note } : n)) : [...list, { ...note }];
    await store.put(`${RENEWALS_PREFIX}${userId}`, next.slice(-RENEWALS_KEPT));
  } catch {
    // A NOTE THAT CANNOT BE KEPT costs only the history. The renewal it
    // describes has already been written back, and failing here would hand
    // every box an error for a sign-in that works.
  }
}

/**
 * The renewals of the sign-in kept at `keptAt`, oldest first. Earlier ones
 * were of a sign-in since replaced, and would say nothing true about this one.
 *
 * @param {{ get: (k: string) => Promise<any> }} store
 * @param {string} userId @param {number} keptAt
 * @returns {Promise<ClaudeRenewal[]>}
 */
export async function claudeRenewals(store, userId, keptAt) {
  const list = await store.get(`${RENEWALS_PREFIX}${userId}`).catch(() => null);
  return Array.isArray(list) ? list.filter((n) => Number(n?.at) >= Number(keptAt)) : [];
}

/**
 * @typedef {object} RenewalVerdict  what the record says ended a refused sign-in
 * @property {'cut'|'dropped'|'expired'|'outside'} kind  `cut`, `dropped` and `expired` are this fleet losing it
 * @property {number|null} at  the renewal that lost it, or the last good one before the refusal
 */

/**
 * What came between the last renewal that worked and a refusal, read off the
 * record. A note left unsettled, or a good renewal not written back, is this
 * fleet losing the refresh token itself; only with neither is the cause
 * somewhere else. Null when the last renewal was not refused.
 *
 * ONE ANSWER for the test's sentence and the phone's notification, which said
 * "ended outside the fleet" from the refusal alone, whatever the record held.
 *
 * @param {ClaudeRenewal[]} list
 * @returns {RenewalVerdict|null}
 */
export function renewalVerdict(list) {
  const last = list[list.length - 1];
  if (!last?.refused) return null;
  const goodAt = list.map((n) => n.ok).lastIndexOf(true);
  const between = list.slice(Math.max(goodAt, 0), -1);
  const lost = between.find((n) => n.pending);
  if (lost) return { kind: 'cut', at: Number(lost.at) };
  const dropped = between.find((n) => n.ok && n.dropped);
  if (dropped) return { kind: 'dropped', at: Number(dropped.at) };
  // RUN OUT, by the lifetime Anthropic gave it, before anything renewed it.
  const refreshUntil = goodAt >= 0 ? Number(list[goodAt].refreshUntil) : NaN;
  if (Number.isFinite(refreshUntil) && refreshUntil <= Number(last.at)) return { kind: 'expired', at: refreshUntil };
  return { kind: 'outside', at: goodAt >= 0 ? Number(list[goodAt].at) : null };
}

/**
 * What a test says about how a sign-in has been renewed: the last renewal, and
 * when the last one was refused after a good one, that nothing in the fleet
 * renewed it in between. That is the sentence that tells a sign-in renewed
 * here from one cancelled outside, and only the record can say it.
 *
 * @param {ClaudeRenewal[]} list @param {number} keptAt @param {number} now
 * @returns {string}
 */
export function describeRenewals(list, keptAt, now) {
  const when = (/** @type {number} */ t) => {
    const d = new Date(t).toISOString();
    return `${new Date(now).toISOString().slice(0, 10) === d.slice(0, 10) ? '' : `${d.slice(0, 10)} `}${d.slice(11, 16)} UTC`;
  };
  const asked = (/** @type {ClaudeRenewal} */ n) => (n.by ? `, asked for by ${n.by}` : '');
  const last = list[list.length - 1];
  if (!last) return `It has not been renewed since it was kept at ${when(keptAt)}.`;
  const cut = (/** @type {ClaudeRenewal} */ n) => `A renewal at ${when(n.at)}${n.by ? `, asked for by ${n.by},` : ''} was cut off before its answer was kept, which loses the refresh token Claude had just issued.`;
  if (last.pending) return cut(last);
  if (last.ok) {
    const refresh = last.refreshUntil ? `, and its refresh token until ${when(Number(last.refreshUntil))}` : '';
    return `Last renewed at ${when(last.at)}${asked(last)}; that access token is good until ${when(Number(last.until))}${refresh}.`;
  }
  const said = `The last renewal, at ${when(last.at)}${asked(last)}, ${last.refused ? 'was refused' : 'did not get an answer'}: ${last.why}.`;
  const verdict = renewalVerdict(list);
  if (!verdict) return said;
  if (verdict.kind === 'cut') return `${said} ${cut(/** @type {ClaudeRenewal} */ (list.find((n) => n.pending && Number(n.at) === verdict.at)))}`;
  if (verdict.kind === 'dropped') return `${said} The renewal at ${when(Number(verdict.at))} was not kept, because a new sign-in was being kept at the same moment.`;
  if (verdict.kind === 'expired') return `${said} Its refresh token ran out at ${when(Number(verdict.at))}, the lifetime Anthropic gave it, before anything renewed it.`;
  const since = verdict.at !== null ? `the last good renewal at ${when(verdict.at)}` : `its keeping at ${when(keptAt)}`;
  return `${said} Nothing in the fleet renewed it between ${since} and then, so it was ended outside the fleet: on claude.ai, or by Anthropic.`;
}

/**
 * @typedef {object} ClaudeEnded  a sign-in Anthropic will no longer renew, for the person to be told
 * @property {string} userId
 * @property {string|null} email  the fleet account it was kept from, when the row says
 * @property {string} login       the GitHub login it is kept under
 * @property {number} at          when the renewal was refused, epoch ms
 * @property {string} why         what Anthropic said
 * @property {RenewalVerdict} verdict  what the record says ended it: this fleet, or something outside it
 */

/**
 * Whether a person's kept sign-in still works, and if Anthropic has ended it,
 * who to tell. Under the person's lock, as a renewal is (vault.js, withLock).
 *
 * WHY THIS ASKS AT ALL. A sign-in ended on claude.ai, or by a new sign-in
 * somewhere else, was found out only when a session failed to start, hours
 * later on vnic-runner-oci, and nothing told its person. So every kept
 * sign-in is asked after on a clock the coordinator keeps
 * (core.js, checkClaudeSignIns):
 *
 *  - A RENEWAL ALREADY REFUSED, by whoever asked for it, is the answer.
 *  - OTHERWISE ITS ACCESS TOKEN IS TRIED at the usage address, which costs
 *    nothing. Refused there, it is renewed at once rather than when due, and
 *    only that renewal being refused says the sign-in is over: an access
 *    token can be refused for reasons a refresh token survives, and Anthropic
 *    refusing the refresh token is the one thing only signing in again mends.
 *  - ONE THAT IS DUE is renewed, as a box asking would renew it, so a person
 *    with no box asking still has an answer.
 *  - NOTHING ELSE IS RENEWED. This renewed ten minutes after keeping and
 *    hourly after that, to test the refresh token early. But a renewal here
 *    ends the access token every box already holds: a session on another box
 *    failed with "OAuth access token has been revoked" after one (vault.md,
 *    "Renewing revokes the token every holder has"). Renewing hourly cut every
 *    box off hourly. A refresh token is now tested when it is needed, and an
 *    access token is tried every check, which costs nothing.
 *
 * Anything that is not Anthropic saying no to the refresh token is cannot
 * tell, and says nothing. A setup-token is not asked: it has no refresh token
 * to end, and its scope does not reach the usage address.
 *
 * @param {{ get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void> }} store
 * @param {{ privateKey: CryptoKey, publicKey: string }} key
 * @param {string} userId
 * @param {{ fetchImpl: typeof fetch, now: () => number }} io
 * @returns {Promise<ClaudeEnded|null>}  null when it works, cannot tell, or was told already
 */
export async function checkClaude(store, key, userId, io) {
  const row = await store.get(`gh:${userId}`);
  if (!row?.sealed || row.forgotten || row.kind !== 'login') return null;
  const told = await store.get(`${ENDED_PREFIX}${userId}`).catch(() => null);
  if (told && Number(told.keptAt) === Number(row.at)) return null;
  const refusedLast = async () => (await claudeRenewals(store, userId, row.at)).at(-1)?.refused === true;
  if (!(await refusedLast())) {
    const asked = { ...io, by: 'a check' };
    const { held } = await freshClaude(store, key, userId, asked);
    if (held?.kind === 'login' && (await accessRefused(held.bearer, io.fetchImpl))) {
      await freshClaude(store, key, userId, { ...asked, force: true });
    }
    if (!(await refusedLast())) return null;
  }
  const list = await claudeRenewals(store, userId, row.at);
  const last = /** @type {ClaudeRenewal} */ (list.at(-1));
  await store.put(`${ENDED_PREFIX}${userId}`, { keptAt: Number(row.at), at: io.now() });
  return {
    userId,
    email: typeof row.email === 'string' && row.email ? row.email : null,
    login: String(row.login || ''),
    at: Number(last.at),
    why: String(last.why || ''),
    verdict: /** @type {RenewalVerdict} */ (renewalVerdict(list)),
  };
}

/**
 * Whether Anthropic refuses this access token, asked at the usage address.
 * False for anything but a refusal: unreachable, or any other answer, is not
 * a reason to renew.
 *
 * @param {string} token @param {typeof fetch} fetchImpl
 */
async function accessRefused(token, fetchImpl) {
  try {
    const res = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel?.().catch(() => {});
    return res.status === 401 || res.status === 403;
  } catch {
    return false;
  }
}
