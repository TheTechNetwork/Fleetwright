// Git credentials for one repository, for one hour, for a runner.
//
// THE PROBLEM. A runner is a machine ninety seconds old with an empty
// credential store, so it can check out public code and nothing else — which is
// the wrong way round for most of the reason somebody wants a Mac. See
// docs/runner-central.md, "What this does not solve".
//
// THE ANSWER IS A NARROWER CREDENTIAL, NOT A BIGGER ONE. Pushing the person's
// own GitHub token to the runner would put their whole installation, for eight
// hours, on a machine they do not own inside a job in a public repository.
// GitHub has exactly the primitive this wants instead: an INSTALLATION TOKEN,
// minted with the App's private key, restricted at mint time to named
// repositories and a subset of permissions, and dead in an hour.
//
// WHERE THE KEY LIVES, which is the question underneath. Not the coordinator,
// which this project treats as compromised, and not every host. By default
// it is a MINTING WORKER of its own (worker/src/minter.js): no public route,
// reached only by the coordinator through a service binding, holding the key
// and nothing else. A fleet that would rather keep the key off Cloudflare can
// put it on ONE permanent box instead (src/fleet/host/minter-config.js). The
// runner cannot tell which answered. Nothing in this file moves the key; it
// only signs with it.
//
// NO node: IMPORTS, because the minting Worker imports this file.

// WHAT BOUNDS A MINT, in the order they are checked by the sidecar:
//
//  1. GitHub's own signature on the runner's job token, whose audience is a
//     hash of this exact request (src/fleet/seal.js). Not the coordinator's
//     word — the box checks it.
//  2. The job is one of the four runner workflows, started by workflow_dispatch.
//  3. The repository's owner is on FLEETWRIGHT_GITHUB_MINT_OWNERS. The App is
//     installable by any account, so "this key never mints into somebody else's
//     account" is kept by what the fleet does rather than by what GitHub allows
//     — github-app.md says so and this list is where it is done.
//  4. The GitHub account that started the job (`actor_id`) can reach the
//     repository. A box asks the person's own connection; the minting Worker,
//     which holds nobody's, asks GitHub about that account directly. Either
//     way the token cannot exceed the person: it is at most what they could
//     already do there, in one repository, for an hour.
//  5. Write only if they have push. Otherwise read.
//
// NEVER THROWS. Every refusal is a sentence a person can act on, and the
// sidecar forwards it to the runner and the coordinator's record.

import { SignJWT } from 'jose';
import { REPO_RE, LINK_ROLES } from '../fleet/protocol/intents.js';
import { RUNNER_WORKFLOWS, checkRunnerRepoAsApp } from './runners.js';
import { checkLinkedRepoAsApp, runnersCheck } from './linked-repo-check.js';

/** Same bound and reasoning as runners.js: two API calls on a bad day. */
const GITHUB_TIMEOUT_MS = 15_000;

/**
 * What a runner may be given. Contents for the clone and the push, pull
 * requests so `gh pr create` works from where the branch was pushed. Not
 * workflows, not issues, not administration: a session that needs more is
 * asking for something this was not built to hand out, and saying no is the
 * correct answer rather than a limitation to fix.
 *
 * @param {{ push: boolean }} access
 * @returns {Record<string, 'read'|'write'>}
 */
export function permissionsFor(access) {
  return access.push ? { contents: 'write', pull_requests: 'write' } : { contents: 'read' };
}

/**
 * @param {string} token
 * @returns {Record<string, string>}
 */
function headers(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'fleetwright',
  };
}

/**
 * @typedef {object} RepoAccess
 * @property {boolean} ok
 * @property {string} message
 * @property {string} [userId]   the GitHub account id this connection belongs to, as a string
 * @property {string} [login]
 * @property {string} [repo]     as GitHub spells it
 * @property {boolean} [pull]
 * @property {boolean} [push]
 */

/**
 * What this person's own GitHub connection can do in one repository, and whose
 * connection it is. Run by the HUB, which holds the connection — the answer is
 * facts about the person, never the token, so it can cross to the sidecar.
 *
 * @param {{ repo: string, token: string, fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<RepoAccess>}
 */
export async function checkRepoAccess({ repo, token, fetchImpl = fetch }) {
  const name = String(repo || '');
  if (!REPO_RE.test(name)) return { ok: false, message: 'That is not a repository name. Write it as owner/repo.' };
  /** @param {string} path */
  const get = async (path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers: headers(token),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    return { res, body: res.ok ? /** @type {any} */ (await res.json()) : null };
  };
  try {
    const me = await get('/user');
    if (me.res.status === 401) {
      return { ok: false, message: 'GitHub rejected your connection on this box (401). Reconnect GitHub in the app.' };
    }
    if (!me.res.ok || me.body?.id === undefined) {
      return { ok: false, message: `GitHub would not say whose connection this is (${me.res.status}).` };
    }
    const r = await get(`/repos/${name}`);
    if (r.res.status === 404) {
      // GitHub's way of declining to admit a private repository exists to a
      // token that cannot see it. Said as that, because "does not exist" would
      // send somebody to check a spelling that is fine.
      return { ok: false, message: `Your GitHub connection cannot see ${name}. A runner is given no more than you can reach.` };
    }
    if (!r.res.ok) return { ok: false, message: `GitHub refused to describe ${name} (${r.res.status}).` };
    const p = r.body?.permissions || {};
    const push = p.push === true || p.admin === true || p.maintain === true;
    const pull = push || p.pull === true || p.triage === true;
    return {
      ok: true,
      message: `${String(me.body.login || 'this account')} can ${push ? 'push to' : pull ? 'read' : 'see but not read'} ${r.body.full_name || name}.`,
      userId: String(me.body.id),
      login: String(me.body.login || ''),
      repo: typeof r.body?.full_name === 'string' ? r.body.full_name : name,
      pull,
      push,
    };
  } catch (e) {
    return { ok: false, message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}

/**
 * Whose GitHub token this is: the numeric account id and the login, or why
 * GitHub would not say. For the minting Worker, which is handed a person's
 * token inside a sealed Claude-login deposit and uses it for this one call,
 * to learn which runners the login may go to without asking the coordinator.
 *
 * @param {{ token: string, fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<{ ok: true, userId: string, login: string } | { ok: false, message: string }>}
 */
export async function githubUser({ token, fetchImpl = fetch }) {
  try {
    const res = await fetchImpl('https://api.github.com/user', {
      headers: headers(token),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (res.status === 401) return { ok: false, message: 'GitHub rejected that token (401)' };
    const body = res.ok ? /** @type {any} */ (await res.json()) : null;
    if (!res.ok || body?.id === undefined) return { ok: false, message: `GitHub would not say whose token that is (${res.status})` };
    return { ok: true, userId: String(body.id), login: String(body.login || '') };
  } catch (e) {
    return { ok: false, message: `could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}

/**
 * Is this job one that may ask for a repository token? A runner workflow,
 * started by a dispatch. The same four files `provision` dispatches; anything
 * else in a runner repository — a workflow a pull request added, a scheduled
 * one — is not a runner and gets nothing.
 *
 * @param {{ repository: string, workflowRef: string, eventName: string }} job
 * @returns {string|null} why not, or null when it may
 */
export function runnerJobProblem(job) {
  if (job.eventName !== 'workflow_dispatch') {
    return `That job was started by ${job.eventName || 'something unknown'}, not by a dispatch, so it is not a runner.`;
  }
  const files = /** @type {string[]} */ (Object.values(RUNNER_WORKFLOWS));
  const prefix = `${job.repository}/.github/workflows/`;
  const file = job.workflowRef.startsWith(prefix) ? job.workflowRef.slice(prefix.length).split('@')[0] : '';
  if (!files.includes(file)) {
    return `That job runs ${job.workflowRef || 'an unknown workflow'}, which is not one of the runner workflows.`;
  }
  return null;
}

/**
 * Whose repositories this box may mint into. Lowercased, because GitHub
 * compares account names that way.
 *
 * @param {string} repo @param {string[]} owners
 */
export function ownerAllowed(repo, owners) {
  const owner = String(repo).split('/')[0].toLowerCase();
  return owners.some((o) => o.toLowerCase() === owner);
}

/** @typedef {import('node:crypto').KeyObject | CryptoKey} AppKey */

/**
 * The App's private key, as WebCrypto can sign with it, from the PEM GitHub
 * hands out. For the minting Worker, which has no node:crypto.
 *
 * GITHUB GIVES PKCS#1 ("BEGIN RSA PRIVATE KEY") AND WEBCRYPTO READS ONLY PKCS#8,
 * so a key pasted straight from the download would be refused with an error
 * about formats that sends somebody to openssl. The wrapping is fixed bytes —
 * a version, the rsaEncryption algorithm identifier, and the PKCS#1 key as an
 * octet string — so it is done here rather than asked of whoever sets it.
 *
 * @param {string} pem
 * @returns {Promise<CryptoKey>}
 */
export async function importAppKey(pem) {
  const text = String(pem || '');
  const pkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(text);
  const body = text.replace(/-----(BEGIN|END) [A-Z ]+-----/g, '').replace(/\s+/g, '');
  if (!body) throw new Error('the GitHub App key is empty');
  const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    /** @type {any} */ (pkcs1 ? wrapPkcs1(bytes) : bytes),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

/** @param {number} n */
function derLength(n) {
  if (n < 0x80) return [n];
  /** @type {number[]} */
  const out = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

/** @param {number} tag @param {Uint8Array|number[]} content */
function der(tag, content) {
  return Uint8Array.from([tag, ...derLength(content.length), ...content]);
}

/** PKCS#8 around a PKCS#1 RSA key: SEQUENCE { 0, rsaEncryption, OCTET STRING key }. @param {Uint8Array} pkcs1 */
function wrapPkcs1(pkcs1) {
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return der(0x30, [...version, ...rsaEncryption, ...der(0x04, pkcs1)]);
}

/**
 * The App's own credential, for ten minutes: the one thing the private key is
 * used for. `iss` is the client id, which GitHub accepts in place of the App id.
 *
 * @param {{ clientId: string, key: AppKey, now?: () => number }} args
 */
export async function appJwt({ clientId, key, now = () => Date.now() }) {
  const t = Math.floor(now() / 1000);
  // Sixty seconds in the past, as GitHub recommends, for a clock that is a
  // little ahead of theirs; nine minutes forward, under their ten-minute cap.
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(clientId).setIssuedAt(t - 60).setExpirationTime(t + 540).sign(key);
}

/**
 * Which installation of the App reaches a repository.
 *
 * @param {{ repo: string, jwt: string, fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<{ ok: true, id: number, permissions: Record<string, string> } | { ok: false, message: string, notInstalled?: true }>}
 */
export async function installationFor({ repo, jwt, fetchImpl = fetch }) {
  const inst = await fetchImpl(`https://api.github.com/repos/${repo}/installation`, {
    headers: headers(jwt),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (inst.status === 404) {
    return { ok: false, notInstalled: true, message: `The Fleetwright GitHub App is not installed on ${repo}, so there is nothing to mint from. Add it to the installation.` };
  }
  if (inst.status === 401) {
    return { ok: false, message: 'GitHub rejected the App key (401). The key or the client id configured beside it is wrong, or the key was revoked.' };
  }
  if (!inst.ok) return { ok: false, message: `GitHub would not say which installation reaches ${repo} (${inst.status}).` };
  const body = /** @type {any} */ (await inst.json());
  const id = Number(body?.id);
  if (!Number.isSafeInteger(id)) return { ok: false, message: 'GitHub answered without an installation id.' };
  return { ok: true, id, permissions: body?.permissions && typeof body.permissions === 'object' ? body.permissions : {} };
}

/**
 * An installation token for exactly one repository and exactly these
 * permissions.
 *
 * @param {{ installationId: number, repo: string, permissions: Record<string, string>, jwt: string,
 *   fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<{ ok: true, token: string, expiresAt: number, permissions: Record<string, string> }
 *   | { ok: false, message: string }>}
 */
export async function mintInstallationToken({ installationId, repo, permissions, jwt, fetchImpl = fetch }) {
  const [, name] = String(repo).split('/');
  const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: { ...headers(jwt), 'content-type': 'application/json' },
    // ONE REPOSITORY, BY NAME, AND NAMED PERMISSIONS. Omit either and GitHub
    // hands back the whole installation, which is the thing this is for not
    // doing.
    body: JSON.stringify({ repositories: [name], permissions }),
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  if (res.status === 422) {
    return {
      ok: false,
      message: `GitHub refused to mint for ${repo} with ${Object.entries(permissions).map(([k, v]) => `${k}:${v}`).join(', ')} (422) — the installation has not been granted those permissions.`,
    };
  }
  if (!res.ok) return { ok: false, message: `GitHub refused to mint a token for ${repo} (${res.status}).` };
  const body = /** @type {any} */ (await res.json());
  const token = typeof body?.token === 'string' ? body.token : '';
  const expiresAt = Date.parse(String(body?.expires_at || ''));
  // CHECKED, NOT ASSUMED. The request named one repository; an answer that
  // reaches any other, or all of them, is not what was asked for, and the
  // safe thing to do with a token that is wider than asked is not use it.
  const repos = Array.isArray(body?.repositories) ? body.repositories : null;
  if (!token || !Number.isFinite(expiresAt)) return { ok: false, message: 'GitHub answered without a token.' };
  if (!repos || repos.length !== 1 || String(repos[0]?.full_name || '').toLowerCase() !== repo.toLowerCase()) {
    return { ok: false, message: `GitHub minted a token that does not reach exactly ${repo}; it was not used.` };
  }
  return { ok: true, token, expiresAt, permissions: body.permissions && typeof body.permissions === 'object' ? body.permissions : permissions };
}

/**
 * Mint a token for one repository with the App's key: the installation, then
 * the token. What a minting BOX does, once the person's own connection has
 * said what they can reach.
 *
 * @param {{ repo: string, permissions: Record<string, string>, clientId: string,
 *   key: AppKey, fetchImpl?: typeof globalThis.fetch, now?: () => number }} args
 * @returns {Promise<{ ok: true, token: string, expiresAt: number, permissions: Record<string, string> }
 *   | { ok: false, message: string }>}
 */
export async function mintRepoToken({ repo, permissions, clientId, key, fetchImpl = fetch, now = () => Date.now() }) {
  try {
    const jwt = await appJwt({ clientId, key, now });
    const inst = await installationFor({ repo, jwt, fetchImpl });
    if (!inst.ok) return inst;
    return await mintInstallationToken({ installationId: inst.id, repo, permissions, jwt, fetchImpl });
  } catch (e) {
    return { ok: false, message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}

/**
 * Mint for the GitHub account that started a runner, with no connection of
 * theirs to ask: what the MINTING WORKER does, since it holds nobody's.
 *
 * Two mints. The first is a probe — this repository, metadata read, nothing
 * else — spent on asking GitHub what permission that account has there. The
 * second is the token itself, write if they can push and read if they can
 * read. So "can this person reach it" is answered by GitHub, about the account
 * GitHub itself says started the job, and the token is never wider than that.
 *
 * @param {{ repo: string, actor: string, actorId: string, clientId: string, key: AppKey,
 *   fetchImpl?: typeof globalThis.fetch, now?: () => number }} args
 * @returns {Promise<{ ok: true, token: string, expiresAt: number, permissions: Record<string, string>, repo: string }
 *   | { ok: false, code: string, message: string }>}
 */
export async function mintForActor({ repo, actor, actorId, clientId, key, fetchImpl = fetch, now = () => Date.now() }) {
  try {
    const jwt = await appJwt({ clientId, key, now });
    const inst = await installationFor({ repo, jwt, fetchImpl });
    if (!inst.ok) return { ok: false, code: 'not_installed', message: inst.message };
    const probe = await mintInstallationToken({ installationId: inst.id, repo, permissions: { metadata: 'read' }, jwt, fetchImpl });
    if (!probe.ok) return { ok: false, code: 'mint_failed', message: probe.message };
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(actor)}/permission`, {
      headers: headers(probe.token),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) {
      return { ok: false, code: 'no_access', message: `GitHub would not say what ${actor} can do in ${repo} (${res.status}), so nothing was minted.` };
    }
    const body = /** @type {any} */ (await res.json());
    // THE SAME ACCOUNT, by id rather than by login: a login can be renamed and
    // then taken by somebody else; the id cannot.
    if (String(body?.user?.id ?? '') !== String(actorId)) {
      return { ok: false, code: 'not_the_asker', message: `GitHub answered for a different account than the one that started the runner (${actor}).` };
    }
    const role = String(body?.permission || 'none');
    const push = role === 'admin' || role === 'maintain' || role === 'write';
    const pull = push || role === 'read' || role === 'triage';
    if (!pull) return { ok: false, code: 'no_access', message: `${actor} cannot read ${repo}, so neither can a runner.` };
    const minted = await mintInstallationToken({ installationId: inst.id, repo, permissions: permissionsFor({ push }), jwt, fetchImpl });
    if (!minted.ok) return { ok: false, code: 'mint_failed', message: minted.message };
    return { ...minted, repo };
  } catch (e) {
    return { ok: false, code: 'mint_failed', message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}

/**
 * Is this a repository a runner can be started from, asked by the GitHub App
 * itself — so that setting one needs no permanent box (checkRunnerRepoAsApp in
 * ./runners.js has the questions and why each is asked).
 *
 * The token it mints reads one repository's metadata and contents, lives for
 * the length of the check, and never leaves the process that minted it. That
 * is why this is not held to FLEETWRIGHT_GITHUB_MINT_OWNERS the way a minted
 * token is: the list decides whose repositories the App's key may hand anyone
 * access to, and this hands nobody anything — it reads a public repository's
 * workflow list and says what it found.
 *
 * @param {{ repo: string, clientId: string, key: AppKey, fetchImpl?: typeof globalThis.fetch, now?: () => number }} args
 * @returns {Promise<import('./runners.js').RunnerRepoCheck>}
 */
export async function checkRunnerRepoForApp({ repo, clientId, key, fetchImpl = fetch, now = () => Date.now() }) {
  const name = String(repo || '');
  /** @param {string} message @param {Partial<import('./runners.js').RunnerRepoCheck>} [extra] */
  const no = (message, extra = {}) => ({
    repo: name, public: null, installed: null, actionsWrite: null,
    platforms: [], missing: Object.keys(RUNNER_WORKFLOWS), ok: false, message, ...extra,
  });
  if (!REPO_RE.test(name)) return no('That is not a repository name. Write it as owner/repo.');
  try {
    const jwt = await appJwt({ clientId, key, now });
    const inst = await installationFor({ repo: name, jwt, fetchImpl });
    if (!inst.ok) {
      return inst.notInstalled
        ? no(`The Fleetwright GitHub App is not installed on ${name}. Install it there and pick ${name}, then check again.`, { installed: false })
        : no(inst.message);
    }
    const read = await mintInstallationToken({
      installationId: inst.id,
      repo: name,
      permissions: { metadata: 'read', contents: 'read' },
      jwt,
      fetchImpl,
    });
    if (!read.ok) return no(read.message, { installed: true });
    return await checkRunnerRepoAsApp({ repo: name, installation: inst, token: read.token, fetchImpl });
  } catch (e) {
    return no(`Could not reach GitHub: ${/** @type {Error} */ (e).message}`);
  }
}


/**
 * Is this repository fit for a linked role, asked by the GitHub App itself —
 * so a fleet with no permanent box can link an archive or a templates
 * repository (checkLinkedRepoAsApp in ./linked-repo-check.js has the
 * questions). `runners` is the runner check above, with the role on it.
 *
 * HELD TO FLEETWRIGHT_GITHUB_MINT_OWNERS for the other two, unlike the runner
 * check, and the difference is visibility. A runner repository is public, so
 * reading it tells nobody anything; an archive is private by definition, and a
 * templates repository may be. Answering "does this private repository exist,
 * and does the App reach it" for any account at all would make the App's key
 * an oracle over every installation of an App anybody may install. Inside the
 * owners list it is the fleet's own accounts, which this key already mints
 * into — and outside it a runner could never be minted a token to push there
 * anyway. So outside it this answers NULL, "not mine to say", and the
 * coordinator asks a box with the person's own connection instead.
 *
 * @param {{ role: string, repo: string, clientId: string, key: AppKey, owners: string[],
 *   fetchImpl?: typeof globalThis.fetch, now?: () => number }} args
 * @returns {Promise<import('./linked-repo-check.js').LinkedRepoCheck|null>}
 */
export async function checkLinkedRepoForApp({ role, repo, clientId, key, owners, fetchImpl = fetch, now = () => Date.now() }) {
  const name = String(repo || '');
  if (role === 'runners') {
    return runnersCheck(await checkRunnerRepoForApp({ repo: name, clientId, key, fetchImpl, now }));
  }
  /** @param {string} message @param {Partial<import('./linked-repo-check.js').LinkedRepoCheck>} [extra] */
  const no = (message, extra = {}) => ({
    role: /** @type {any} */ (role), repo: name, public: null, installed: null, contents: null, push: null, carries: null,
    ok: false, message, ...extra,
  });
  if (!LINK_ROLES.includes(String(role))) return no(`A linked repository is one of ${LINK_ROLES.join(', ')}.`);
  if (!REPO_RE.test(name)) return no('That is not a repository name. Write it as owner/repo.');
  if (!ownerAllowed(name, owners)) return null;
  try {
    const jwt = await appJwt({ clientId, key, now });
    const inst = await installationFor({ repo: name, jwt, fetchImpl });
    if (!inst.ok) {
      return inst.notInstalled
        ? no(`The Fleetwright GitHub App is not installed on ${name}. Install it there and pick ${name}, then check again.`, { installed: false })
        : no(inst.message);
    }
    const read = await mintInstallationToken({
      installationId: inst.id,
      repo: name,
      permissions: { metadata: 'read', contents: 'read' },
      jwt,
      fetchImpl,
    });
    if (!read.ok) return no(read.message, { installed: true });
    return await checkLinkedRepoAsApp({ role, repo: name, installation: inst, token: read.token, fetchImpl });
  } catch (e) {
    return no(`Could not reach GitHub: ${/** @type {Error} */ (e).message}`);
  }
}
