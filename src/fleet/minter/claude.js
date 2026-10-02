// A person's Claude login, kept by the minting Worker for their own runners.
//
// WHY THIS IS HERE AND NOT A REPOSITORY SECRET. A runner authenticates with
// the runner repository's ANTHROPIC_API_KEY, which bills to whoever owns that
// repository whoever asked for the machine. A person who would rather run on
// their own Claude subscription makes a token for it with `claude setup-token`
// — Anthropic's own route for running Claude Code where nobody can open a
// browser — and the question is where that token lives. A repository secret
// is readable by every workflow in the repository and, in the fleet's shared
// runner repository, would put one person's subscription under everybody's
// sessions. Every runner has exactly one owner, though, who asked for it
// through the app or MCP, and GitHub says who in the job token. So the token
// lives here, and goes only to a runner that GitHub says its owner started.
//
// NOTHING HERE TRUSTS THE COORDINATOR, which relays both halves:
//
//  - A DEPOSIT is sealed to this Worker's deposit key before it leaves the
//    person's computer, and carries a GitHub token of theirs beside the Claude
//    one. The account is whatever GitHub says that token belongs to — never
//    what the coordinator says — and the GitHub token is used for that one
//    call and not kept. A replayed deposit is refused: each carries the time
//    it was made, and nothing older than ten minutes, or older than the one
//    already held, is accepted.
//  - A HAND-OUT is `answerMintRequest`'s shape without the repository: a job
//    token whose audience binds the runner's one-request key, verified against
//    GitHub's keys; a runner workflow started by a dispatch; a job in a
//    repository the fleet mints for, or the account's own. The login goes to
//    the account that started the job, sealed to that key.
//
// AT REST it is still sealed: to the deposit key, under the GitHub account id
// it belongs to (seal.js, atRestAad). Reading the storage gives ciphertext;
// only this Worker's secret opens it, and a row moved under another id does
// not open at all.
//
// WHAT IT CANNOT NARROW, said plainly because it is the difference from a
// repository token: a setup-token is the person's whole subscription for a
// year. The runner holds it for the length of the job, in memory and in its
// private state directory, and the session running there can read it. That is
// the same reach a session on their permanent box has with their login, and
// it is theirs, on a machine only they were given.
//
// NEVER THROWS. Every refusal is a code and a sentence, relayed to whoever asked.

import { JWT_RE } from '../protocol/intents.js';
import { SEAL_KEY_RE, DEPOSIT_AAD, atRestAad, claudeBindingFor, seal, open } from '../seal.js';
import { verifyRunnerJob } from '../coordinator/oidc.js';
import { runnerJobProblem, githubUser } from '../../core/repo-tokens.js';

/** How old a deposit may be when it arrives. Minutes, because a person made it just now. */
export const DEPOSIT_MAX_AGE_MS = 10 * 60_000;

/**
 * What a setup-token looks like, as far as this will commit to: Anthropic does
 * not document the format, so this is "one printable word of a sane length"
 * and no more — enough to refuse a pasted sentence or a file, not a check that
 * it is a working token. The runner finds that out, and says so.
 */
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{20,2048}$/;

/**
 * @typedef {object} LoginStore  one row per GitHub account id
 * @property {(id: string) => Promise<any>} get
 * @property {(id: string, row: any) => Promise<void>} put
 */

/**
 * @typedef {object} ClaudeConfig
 * @property {(() => Promise<{ privateKey: CryptoKey, publicKey: string }>)|null} depositKey
 *   this Worker's deposit key, imported once; null when it holds none
 * @property {LoginStore|null} logins
 * @property {string[]} owners  the accounts a runner repository may belong to, besides the person's own
 * @property {typeof globalThis.fetch} [fetchImpl]
 * @property {() => number} [now]
 */

/** @param {string} code @param {string} text */
const refuse = (code, text) => ({ ok: false, error: { code }, text });

/** @param {ClaudeConfig} config */
function notConfigured(config) {
  return !config.depositKey || !config.logins
    ? refuse('no_deposit_key', 'The minting Worker holds no deposit key, so it keeps no Claude logins. See docs/runner-central.md, "Your Claude login on a runner".')
    : null;
}

/**
 * The key a person seals a deposit to, for the coordinator to hand out and
 * for them to check against the one their operator gave them.
 *
 * @param {ClaudeConfig} config
 */
export async function depositKeyAnswer(config) {
  const missing = notConfigured(config);
  if (missing) return missing;
  try {
    const { publicKey } = await /** @type {() => Promise<{ publicKey: string }>} */ (config.depositKey)();
    return { ok: true, key: publicKey };
  } catch (e) {
    return refuse('bad_deposit_key', `The deposit key does not load: ${/** @type {Error} */ (e).message}.`);
  }
}

/**
 * A person deposits, replaces or forgets their Claude login.
 *
 * @param {unknown} ask  what the coordinator relayed: `{ sealed }`, opened here to
 *   `{ v: 1, github, claude: string|null, at }`
 * @param {ClaudeConfig} config
 */
export async function answerDeposit(ask, config) {
  const missing = notConfigured(config);
  if (missing) return missing;
  const { fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = config;
  const sealed = /** @type {any} */ (ask)?.sealed;
  if (!sealed || typeof sealed !== 'object') return refuse('bad_params', 'That is not a sealed Claude login.');

  let key;
  try {
    key = await /** @type {() => Promise<{ privateKey: CryptoKey, publicKey: string }>} */ (config.depositKey)();
  } catch (e) {
    return refuse('bad_deposit_key', `The deposit key does not load: ${/** @type {Error} */ (e).message}.`);
  }
  /** @type {any} */
  let inside;
  try {
    inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: DEPOSIT_AAD, sealed });
  } catch {
    // Sealed to some other key, or changed on the way. Either way the
    // coordinator in the middle is the likeliest reason, and the person's
    // computer checked the key it sealed to — so this is worth saying.
    return refuse('unsealed', 'That deposit does not open with this minter’s key. It was sealed to a different key, or changed on the way.');
  }
  const at = Number(inside?.at);
  if (inside?.v !== 1 || !Number.isFinite(at)) return refuse('bad_params', 'That deposit is not in the shape one takes.');
  if (Math.abs(now() - at) > DEPOSIT_MAX_AGE_MS) {
    return refuse('stale', 'That deposit was made more than ten minutes ago, so it could be a replay. Make it again.');
  }
  const claude = inside.claude === null ? null : String(inside.claude || '');
  if (claude !== null && !TOKEN_RE.test(claude)) {
    return refuse('bad_token', 'That is not a Claude token. Paste the one line `claude setup-token` printed.');
  }

  const who = await githubUser({ token: String(inside.github || ''), fetchImpl });
  if (!who.ok) return refuse('not_github', `The minter could not tell whose deposit this is: ${who.message}.`);

  const held = await config.logins?.get(who.userId);
  if (held && Number(held.at) >= at) {
    return refuse('stale', `${who.login} has a newer deposit here than this one, so this one could be a replay. Nothing was changed.`);
  }
  if (claude === null) {
    // A TOMBSTONE, not a delete: it keeps the time, so an older deposit that
    // somebody replays inside its ten minutes cannot bring the login back.
    await config.logins?.put(who.userId, { at, login: who.login, forgotten: true });
    return { ok: true, login: who.login, forgotten: true, text: `Forgot ${who.login}’s Claude login. Their runners use the runner repository’s API key from now on.` };
  }
  const stored = await seal({ to: key.publicKey, aad: atRestAad(who.userId), payload: { token: claude } });
  await config.logins?.put(who.userId, { at, login: who.login, sealed: stored });
  return {
    ok: true,
    login: who.login,
    text: `Kept a Claude login for ${who.login}. Runners ${who.login} starts will run on it; nobody else’s will.`,
  };
}

/**
 * A runner asks for its owner's Claude login.
 *
 * @param {unknown} ask  `{ job, key }`: the runner's job token and its one-request key
 * @param {ClaudeConfig} config
 */
export async function answerLogin(ask, config) {
  const a = /** @type {any} */ (ask) || {};
  const job = String(a.job || '');
  const runnerKey = String(a.key || '');
  if (!JWT_RE.test(job) || job.length > 8192 || !SEAL_KEY_RE.test(runnerKey)) {
    return refuse('bad_params', 'That request for a Claude login is not in the shape one takes.');
  }
  const missing = notConfigured(config);
  if (missing) return missing;

  const audience = await claudeBindingFor(runnerKey);
  let claims;
  try {
    claims = await verifyRunnerJob(job, { audience });
  } catch (e) {
    return refuse('bad_job', `The runner’s job token did not verify: ${/** @type {Error} */ (e).message}.`);
  }
  const notRunner = runnerJobProblem(claims);
  if (notRunner) return refuse('not_a_runner', notRunner);
  if (!claims.actorId) return refuse('not_the_asker', 'The job token does not say which GitHub account started the runner.');
  // WHICH REPOSITORY THE JOB RAN IN, because the login goes to that job's
  // code. A runner workflow is known by its file name, so without this a
  // `runner-linux.yml` in anybody's repository that the person could be got to
  // dispatch would be handed their subscription. Theirs, or one the fleet
  // mints for: the two places a runner repository legitimately is.
  const ownRepo = claims.repositoryOwnerId !== '' && claims.repositoryOwnerId === claims.actorId;
  const fleetRepo = config.owners.some((o) => o.toLowerCase() === claims.repositoryOwner.toLowerCase());
  if (!ownRepo && !fleetRepo) {
    return refuse(
      'repo_not_allowed',
      `That runner ran in ${claims.repository}, which is neither ${claims.actor}’s own nor one this fleet mints for, so it is not given a Claude login.`,
    );
  }

  const held = await /** @type {LoginStore} */ (config.logins).get(claims.actorId);
  if (!held || held.forgotten || !held.sealed) {
    // NOT "so this runner uses its repository's API key": this Worker cannot
    // see whether that repository has one, and when it did not, the event
    // log said the runner was running on a key that did not exist.
    return refuse(
      'no_claude_login',
      `${claims.actor} has not kept a Claude login for their runners, so this runner falls back to its repository’s ANTHROPIC_API_KEY if it has one. Keep one under You › Credentials in the app.`,
    );
  }
  let token;
  try {
    const key = await /** @type {() => Promise<{ privateKey: CryptoKey, publicKey: string }>} */ (config.depositKey)();
    const inside = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: atRestAad(claims.actorId), sealed: held.sealed });
    token = String(inside?.token || '');
  } catch {
    // Kept under another account, or under a key since replaced. Not an
    // error to guess past: the person deposits again.
    return refuse('unsealed', `The login kept for ${claims.actor} does not open with this minter’s key. Deposit it again.`);
  }
  const login = String(held.login || claims.actor);
  const sealed = await seal({ to: runnerKey, aad: audience, payload: { token, login } });
  return { ok: true, login, sealed, text: `${login}’s Claude login, sealed to the runner ${login} started.` };
}
