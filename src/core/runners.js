// Asking GitHub for a machine, with the asking person's own token.
//
// WHICH CREDENTIAL, AND WHY IT IS THIS ONE
//
// A dispatch needs a GitHub credential with Actions write on the runner
// repository. There were three candidates and only one of them is allowed to
// exist where it would have to:
//
//   the App's private key      mints installation tokens for EVERY
//                              installation of the App. docs/github-app.md and
//                              docs/trust.md both refuse it a home on a host or
//                              in the coordinator; it waits for the broker
//   a stored dispatch token    one credential, held by the coordinator, able to
//                              start runners for anybody. A stored secret in the
//                              party this design treats as compromised, and it
//                              still could not say who asked
//   THE PERSON'S OWN TOKEN     already stored here, per person, renewed here,
//                              revocable by them from a screen they know
//
// The third needs nothing new to exist and answers the ownership question for
// free: a dispatch made with somebody's token is a dispatch they could have
// made themselves, from a repository they can already run workflows in. It
// cannot exceed them, so nothing here has to be careful on their behalf.
//
// The token never leaves this process. It authenticates two calls to
// api.github.com and is not passed to the workflow, not written to the run, and
// not readable from the runner — the machine that comes up authenticates to the
// fleet with its own key and to Claude with the repository's API key.
//
// WHAT TRAVELS INSTEAD is the ticket: single-use, minutes long, and worth only
// an attribution. See src/fleet/coordinator/runner-tickets.js for what a leaked
// one costs, which is the calculation that makes it safe to put in a workflow
// input that anybody able to read the run can read.

/** Long enough for two API calls on a bad day, short enough that a hung
 * provider does not hold a session's request open. Same value and the same
 * reasoning as connectors.js. */
const DISPATCH_TIMEOUT_MS = 15_000;

/**
 * One workflow file per operating system, and the mapping is here rather than
 * in the protocol for a reason worth stating: the protocol's job is to refuse
 * anything that is not one of four words, and this file's job is to know what
 * those four words mean in a repository. A caller can therefore never name a
 * file, and adding a platform is one line in two places rather than a new kind
 * of parameter.
 */
export const RUNNER_WORKFLOWS = Object.freeze({
  macos: 'runner-macos.yml',
  windows: 'runner-windows.yml',
  linux: 'runner-linux.yml',
  android: 'runner-android.yml',
});

/** What a runner costs if nobody says. An hour is long enough for a build and
 * a look at the result, and short enough that forgetting about one is not
 * expensive. */
export const DEFAULT_MINUTES = 60;

/** GitHub kills any job at 360 minutes. The protocol's ceiling is below that,
 * so a runner ends itself rather than being killed mid-sentence — a killed job
 * never closes its socket, and the coordinator waits on a heartbeat from a
 * machine that has already gone. */
export const MAX_MINUTES = 350;

/** @param {Response} res @param {string} what */
function refusal(res, what) {
  if (res.status === 401) {
    return `GitHub rejected the stored token (401). It has expired or been revoked — reconnect GitHub in the app.`;
  }
  if (res.status === 403) {
    return (
      `GitHub refused ${what} (403). The connection is missing Actions write on that repository: ` +
      'open the Fleetwright installation on github.com and check the repository is selected and the permission granted.'
    );
  }
  if (res.status === 404) {
    return (
      `GitHub answered 404 for ${what}. Either the repository is not one this connection can see — ` +
      'a GitHub App installation only reaches the repositories that were picked when it was installed — ' +
      'or it does not have that workflow file.'
    );
  }
  return `GitHub answered ${res.status} for ${what}.`;
}

/**
 * Start a runner.
 *
 * NEVER THROWS. Every failure here is something a person can act on — a token
 * that expired, a repository nobody picked at install time, a workflow file
 * that is not in the repository yet — and a stack trace names none of them.
 *
 * TWO CALLS, NOT ONE, and the first one earns its keep twice. GitHub's dispatch
 * endpoint needs a `ref` and answers 404 for a repository it cannot see, a
 * workflow file that does not exist, and a branch that is wrong — three
 * different problems behind one status code. Asking for the repository first
 * gets the default branch (so nothing here has to assume `main`, which is wrong
 * for older repositories and for anybody who renamed theirs) and turns the
 * commonest failure into a sentence about the repository rather than about a
 * file.
 *
 * @param {{
 *   repo: string,
 *   platform: string,
 *   minutes?: number,
 *   ticket: string,
 *   coordinator: string,
 *   token: string,
 *   fetchImpl?: typeof globalThis.fetch,
 * }} args
 * @returns {Promise<{ ok: true, workflow: string, ref: string, minutes: number }
 *   | { ok: false, message: string }>}
 */
export async function dispatchRunner({
  repo,
  platform,
  minutes = DEFAULT_MINUTES,
  ticket,
  coordinator,
  token,
  fetchImpl = fetch,
}) {
  const workflow = Object.hasOwn(RUNNER_WORKFLOWS, String(platform))
    ? RUNNER_WORKFLOWS[/** @type {keyof typeof RUNNER_WORKFLOWS} */ (platform)]
    : null;
  if (!workflow) {
    return { ok: false, message: `"${String(platform).slice(0, 20)}" is not a platform this fleet can start.` };
  }
  // CHECKED AGAIN HERE, and not because the protocol did not. This module is
  // called from a command registry that anything on the box can reach, and a
  // repository name goes into a URL path — a value that is validated only by a
  // caller is a value that is validated only until there are two callers.
  if (!/^[A-Za-z0-9._-]{1,80}\/[A-Za-z0-9._-]{1,80}$/.test(String(repo || ''))) {
    return { ok: false, message: 'The runner repository is not a valid owner/repo.' };
  }
  const wanted = Math.min(MAX_MINUTES, Math.max(5, Math.round(Number(minutes) || DEFAULT_MINUTES)));

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'agent-hub',
  };

  /** @type {any} */
  let repository;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}`, {
      headers,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, message: refusal(res, `the repository ${repo}`) };
    repository = await res.json();
  } catch (e) {
    return { ok: false, message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
  const ref = typeof repository?.default_branch === 'string' && repository.default_branch
    ? repository.default_branch
    : 'main';

  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          ref,
          inputs: {
            // Strings, all of them: GitHub types every workflow_dispatch input
            // as a string unless the workflow declares otherwise, and sending a
            // number is a 422 that reads as the workflow being wrong.
            minutes: String(wanted),
            ticket: String(ticket),
            // WHICH FLEET TO JOIN, told by the host rather than baked into the
            // workflow. The host knows the coordinator it is pinned to from its
            // own configuration — not from anything the coordinator said — so
            // a runner repository needs no edit to serve a different fleet, and
            // a fork of it works as it is.
            coordinator: String(coordinator),
          },
        }),
        signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      },
    );
    if (res.status === 204) return { ok: true, workflow, ref, minutes: wanted };
    if (res.status === 422) {
      // The one status GitHub uses for "your request was understood and is
      // wrong", which here is almost always a runner repository whose workflow
      // does not take these inputs — an old copy, or one edited by hand.
      return {
        ok: false,
        message:
          `GitHub refused the dispatch (422). ${repo} has ${workflow}, but it does not accept the inputs this ` +
          'fleet sends — it needs `minutes`, `ticket` and `coordinator`, and a `workflow_dispatch` trigger. ' +
          'Update it from install/runner-central/ in the Fleetwright repository.',
      };
    }
    return { ok: false, message: refusal(res, `${workflow} in ${repo}`) };
  } catch (e) {
    return { ok: false, message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}
