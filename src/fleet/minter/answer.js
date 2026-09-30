// What the minting Worker answers when the coordinator relays a runner's ask.
//
// THE MINTING WORKER EXISTS SO THAT NOTHING HAS TO BE A HOST TO MINT. It is a
// Worker of its own (worker/src/minter.js) holding the GitHub App's private key
// and nothing else: no public route, reached only by the coordinator through a
// service binding. The coordinator, which this project treats as compromised,
// never holds the key — it hands this Worker a request and relays what comes
// back, which is sealed to a key only the asking runner has.
//
// So this file must not trust the coordinator for anything that decides a
// mint, and it does not. Everything below is checked against GitHub:
//
//  1. the runner's job token, verified against GitHub's own keys, with an
//     audience that binds exactly this repository to exactly this sealing key
//     (src/fleet/seal.js) — so a coordinator that swaps either is refused;
//  2. the job is one of the four runner workflows, started by a dispatch;
//  3. the repository's account is one this Worker may mint into — its own
//     setting, FLEETWRIGHT_GITHUB_MINT_OWNERS, never one the coordinator sends;
//  4. GitHub says the account that started the job can read the repository,
//     and write if it can push (mintForActor in src/core/repo-tokens.js).
//
// What the coordinator adds is only the relay. A compromised one can refuse,
// drop or delay a mint; it cannot obtain a token it can read, or one for a
// repository or a key the runner did not ask for.
//
// NEVER THROWS. Every refusal is a code and a sentence, relayed to the runner
// and the coordinator's record.

import { REPO_RE, JWT_RE } from '../protocol/intents.js';
import { SEAL_KEY_RE, bindingFor, seal } from '../seal.js';
import { verifyRunnerJob } from '../coordinator/oidc.js';
import { runnerJobProblem, ownerAllowed, mintForActor } from '../../core/repo-tokens.js';

/**
 * @typedef {object} MinterConfig
 * @property {(() => Promise<import('../../core/repo-tokens.js').AppKey>)|null} appKey
 *   the App's private key, imported once; null when this Worker holds none
 * @property {string} clientId  the App's client id, the JWT's issuer
 * @property {string[]} owners  accounts whose repositories may be minted into
 * @property {typeof globalThis.fetch} [fetchImpl]
 */

/**
 * @param {unknown} ask  what the coordinator relayed: `{ repo, job, key }`
 * @param {MinterConfig} config
 * @returns {Promise<Record<string, unknown>>}
 */
export async function answerMintRequest(ask, { appKey, clientId, owners, fetchImpl = (...a) => fetch(...a) }) {
  const a = /** @type {any} */ (ask) || {};
  const repo = String(a.repo || '');
  const job = String(a.job || '');
  const key = String(a.key || '');
  /** @param {string} code @param {string} text */
  const refuse = (code, text) => ({ ok: false, error: { code }, text });

  if (!REPO_RE.test(repo) || !JWT_RE.test(job) || job.length > 8192 || !SEAL_KEY_RE.test(key)) {
    return refuse('bad_params', 'That request for a repository token is not in the shape one takes.');
  }
  // NOT CONFIGURED IS ITS OWN ANSWER, as data, so the coordinator can fall back
  // to a permanent box that holds the key instead. Empty owners is "nobody":
  // the App is installable by any account, so a minter that has not been told
  // whose repositories it serves must not guess.
  if (!appKey || !clientId || !owners.length) {
    return {
      ...refuse(
        'not_a_minter',
        'The minting Worker holds no GitHub App key, or has not been told its client id or whose repositories it mints into.',
      ),
      needsMinter: true,
    };
  }

  const audience = await bindingFor({ repo, key });
  let claims;
  try {
    claims = await verifyRunnerJob(job, { audience });
  } catch (e) {
    return refuse('bad_job', `The runner’s job token did not verify: ${/** @type {Error} */ (e).message}.`);
  }
  const notRunner = runnerJobProblem(claims);
  if (notRunner) return refuse('not_a_runner', notRunner);
  if (!ownerAllowed(repo, owners)) {
    return refuse(
      'owner_not_allowed',
      `This fleet mints repository tokens only for ${owners.join(', ')}, and ${repo.split('/')[0]} is not one of them. ` +
        'The GitHub App is installable by anyone, so which accounts it mints into is decided by the minter.',
    );
  }
  if (!claims.actor || !claims.actorId) return refuse('not_the_asker', 'The job token does not say which GitHub account started the runner.');

  let appKeyValue;
  try {
    appKeyValue = await appKey();
  } catch (e) {
    return refuse('mint_failed', `The GitHub App key does not load: ${/** @type {Error} */ (e).message}.`);
  }
  const minted = await mintForActor({ repo, actor: claims.actor, actorId: claims.actorId, clientId, key: appKeyValue, fetchImpl });
  if (!minted.ok) return refuse(minted.code, minted.message);

  const sealed = await seal({
    to: key,
    aad: audience,
    payload: { token: minted.token, expiresAt: minted.expiresAt, repo: minted.repo, permissions: minted.permissions },
  });
  const perms = Object.entries(minted.permissions).map(([k, v]) => `${k}:${v}`).join(', ');
  return {
    ok: true,
    text: `A token for ${minted.repo} (${perms}), good for an hour, sealed to the runner that asked.`,
    sealed,
    repo: minted.repo,
    expiresAt: minted.expiresAt,
    permissions: minted.permissions,
  };
}
