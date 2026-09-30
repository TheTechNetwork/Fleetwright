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
// WHERE THE KEY LIVES, which is the question underneath. docs/github-app.md
// refuses it a home on every host (N copies of a key that mints for every
// installation) and in the coordinator (treated as compromised), and decided
// that its blast radius is the host it sits on — so bounding it is host
// hardening (docs/hardening.md). So: ONE permanent box an operator chooses,
// read from a file only that box's sidecar can open, never sent anywhere.
// Nothing in this file moves the key; it only signs with it.
//
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
//  4. The person's OWN GitHub connection can see the repository, and the job
//     was started by that same GitHub account (`actor_id`). So the token cannot
//     exceed the person: it is at most what their own connection could already
//     do there, in one repository, for an hour.
//  5. Write only if they have push. Otherwise read.
//
// NEVER THROWS. Every refusal is a sentence a person can act on, and the
// sidecar forwards it to the runner and the coordinator's record.

import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { REPO_RE } from '../fleet/protocol/intents.js';
import { RUNNER_WORKFLOWS } from './runners.js';

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

/**
 * The App's own credential, for ten minutes: the one thing the private key is
 * used for. `iss` is the client id, which GitHub accepts in place of the App id.
 *
 * @param {{ clientId: string, key: import('node:crypto').KeyObject, now?: () => number }} args
 */
export async function appJwt({ clientId, key, now = () => Date.now() }) {
  const t = Math.floor(now() / 1000);
  // Sixty seconds in the past, as GitHub recommends, for a clock that is a
  // little ahead of theirs; nine minutes forward, under their ten-minute cap.
  return new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(clientId).setIssuedAt(t - 60).setExpirationTime(t + 540).sign(key);
}

/**
 * Mint a token for one repository with the App's key.
 *
 * @param {{ repo: string, permissions: Record<string, string>, clientId: string,
 *   key: import('node:crypto').KeyObject, fetchImpl?: typeof globalThis.fetch, now?: () => number }} args
 * @returns {Promise<{ ok: true, token: string, expiresAt: number, permissions: Record<string, string> }
 *   | { ok: false, message: string }>}
 */
export async function mintRepoToken({ repo, permissions, clientId, key, fetchImpl = fetch, now = () => Date.now() }) {
  const [, name] = String(repo).split('/');
  try {
    const jwt = await appJwt({ clientId, key, now });
    const inst = await fetchImpl(`https://api.github.com/repos/${repo}/installation`, {
      headers: headers(jwt),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (inst.status === 404) {
      return { ok: false, message: `The Fleetwright GitHub App is not installed on ${repo}, so there is nothing to mint from. Add it to the installation.` };
    }
    if (inst.status === 401) {
      return { ok: false, message: 'GitHub rejected this box’s App key (401). The key or the client id configured here is wrong, or the key was revoked.' };
    }
    if (!inst.ok) return { ok: false, message: `GitHub would not say which installation reaches ${repo} (${inst.status}).` };
    const id = Number((/** @type {any} */ (await inst.json()))?.id);
    if (!Number.isSafeInteger(id)) return { ok: false, message: 'GitHub answered without an installation id.' };

    const res = await fetchImpl(`https://api.github.com/app/installations/${id}/access_tokens`, {
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
  } catch (e) {
    return { ok: false, message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}

/**
 * @typedef {object} Minter
 * @property {import('node:crypto').KeyObject} key
 * @property {string} clientId
 * @property {string[]} owners
 */

/**
 * The minter this box is configured to be, if any.
 *
 * Three settings, all on the box and none from the coordinator — the key cannot
 * come down the socket (the coordinator must never hold it), and the other two
 * say what that key may be used for, which is not the coordinator's to decide.
 * Read by loadSidecarConfig (src/fleet/host/config.js):
 *
 *   FLEETWRIGHT_GITHUB_APP_KEY        the App's private key, a PEM file. Or leave
 *                                     it unset and give systemd the key as the
 *                                     credential `github-app-key`
 *                                     (LoadCredentialEncrypted=), which puts it
 *                                     under $CREDENTIALS_DIRECTORY
 *   FLEETWRIGHT_GITHUB_APP_CLIENT_ID  the App's client id, the JWT's issuer
 *   FLEETWRIGHT_GITHUB_MINT_OWNERS    accounts whose repositories may be minted
 *                                     into, comma separated. Empty is nobody
 *
 * A box with none of them is not a minter and that is the normal case. A box
 * with some of them is misconfigured, and says which.
 *
 * @param {{ keyFile?: string, credentialsDirectory?: string, clientId?: string, owners?: string[] }} settings
 * @param {(file: string) => string} [read]
 * @returns {{ minter: Minter|null, problem: string|null }}
 */
export function loadMinter(settings, read = (f) => readFileSync(f, 'utf8')) {
  const file = String(settings.keyFile || '');
  const fromSystemd = settings.credentialsDirectory ? `${settings.credentialsDirectory}/github-app-key` : '';
  const clientId = String(settings.clientId || '').trim();
  const owners = (settings.owners || []).map((s) => String(s).trim()).filter(Boolean);
  let pem = '';
  for (const candidate of [file, fromSystemd].filter(Boolean)) {
    try {
      pem = read(candidate);
      break;
    } catch (e) {
      if (candidate === file) return { minter: null, problem: `FLEETWRIGHT_GITHUB_APP_KEY: ${/** @type {Error} */ (e).message}` };
    }
  }
  if (!pem && !clientId && !owners.length) return { minter: null, problem: null };
  if (!pem) return { minter: null, problem: 'repository tokens: no GitHub App key (FLEETWRIGHT_GITHUB_APP_KEY, or the systemd credential github-app-key)' };
  if (!clientId) return { minter: null, problem: 'repository tokens: FLEETWRIGHT_GITHUB_APP_CLIENT_ID is not set' };
  if (!owners.length) return { minter: null, problem: 'repository tokens: FLEETWRIGHT_GITHUB_MINT_OWNERS is empty, so there is nobody to mint for' };
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') return { minter: null, problem: 'repository tokens: the GitHub App key is not an RSA key' };
    return { minter: { key, clientId, owners }, problem: null };
  } catch (e) {
    return { minter: null, problem: `repository tokens: the GitHub App key does not load (${/** @type {Error} */ (e).message})` };
  }
}
