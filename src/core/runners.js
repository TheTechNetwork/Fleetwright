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

import { REPO_RE } from '../fleet/protocol/intents.js';

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
  if (!REPO_RE.test(String(repo || ''))) {
    return { ok: false, message: 'The runner repository is not a valid owner/repo.' };
  }
  const wanted = Math.min(MAX_MINUTES, Math.max(5, Math.round(Number(minutes) || DEFAULT_MINUTES)));

  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'fleetwright',
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
          'Update it from github.com/TheTechNetwork/Fleetwright-Runners-Template.',
      };
    }
    return { ok: false, message: refusal(res, `${workflow} in ${repo}`) };
  } catch (e) {
    return { ok: false, message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}

/**
 * @typedef {object} RunnerRepoCheck
 * @property {string} repo           the name as GitHub spells it, which is the
 *   one worth saving: `Owner/Repo` and `owner/repo` reach the same repository
 *   and are two different strings to anything comparing them later
 * @property {boolean|null} public   null when the repository could not be read
 * @property {boolean|null} installed  does the Fleetwright GitHub App reach it.
 *   NULL IS "CANNOT TELL", not "no": a personal token has no view of GitHub App
 *   installations at all, and saying "not installed" to somebody who installed
 *   it is the kind of wrong answer that sends them to reinstall something that
 *   was never the problem
 * @property {boolean|null} actionsWrite  can this connection start a workflow
 *   there — the installation's Actions permission, or for a personal token the
 *   person's own push access
 * @property {string[]} platforms    which of RUNNER_WORKFLOWS the repository has
 * @property {string[]} missing      which it does not, so a screen can say which
 *   operating systems would be refused
 * @property {boolean} ok            every answer is one a dispatch can use
 * @property {string} message        one sentence, naming the first thing to fix
 */

/**
 * Is this a repository somebody's runners can come from?
 *
 * Asked with the person's own connection, for the same reason a dispatch is:
 * the question is "can I start a machine there", and only their token can
 * answer it. NEVER THROWS, like dispatchRunner — each failure is something a
 * person can go and fix, and the message names it.
 *
 * WHY PUBLIC IS REQUIRED. Actions minutes on GitHub's standard runners are free
 * for a public repository and metered for a private one, and free minutes are
 * the reason to have a runner repository at all. A private one would still
 * work, and would bill every machine to its owner without anybody having
 * decided that — so it is refused here and the reason is the message.
 *
 * WHY INSTALLED IS ASKED OF /user/installations. With a GitHub App user token,
 * that lists the installations this person can reach, each with its
 * permissions and whether it covers every repository or a chosen few. The
 * obvious alternative, `GET /repos/{repo}/installation`, needs the App's
 * private key, which this project deliberately has nowhere to keep.
 *
 * @param {{ repo: string, token: string, fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<RunnerRepoCheck>}
 */
export async function checkRunnerRepo({ repo, token, fetchImpl = fetch }) {
  const name = String(repo || '');
  /** @type {RunnerRepoCheck} */
  const out = {
    repo: name,
    public: null,
    installed: null,
    actionsWrite: null,
    platforms: [],
    missing: Object.keys(RUNNER_WORKFLOWS),
    ok: false,
    message: '',
  };
  if (!REPO_RE.test(name)) {
    return { ...out, message: 'That is not a repository name. Write it as owner/repo.' };
  }
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'fleetwright',
  };
  /** @param {string} path */
  const get = async (path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, {
      headers,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    return { res, body: res.ok ? /** @type {any} */ (await res.json()) : null };
  };

  try {
    // 1. CAN THIS PERSON SEE IT, AND IS IT PUBLIC.
    const r = await get(`/repos/${name}`);
    if (!r.res.ok) return { ...out, message: refusal(r.res, `the repository ${name}`) };
    const full = typeof r.body?.full_name === 'string' ? r.body.full_name : name;
    out.repo = full;
    out.public = r.body?.private === false;
    if (!out.public) {
      return {
        ...out,
        message:
          `${full} is private. A runner repository has to be public: Actions minutes on GitHub's standard ` +
          'runners are free only there, and a private one would bill every machine to its owner.',
      };
    }

    // 2. DOES THE FLEETWRIGHT APP REACH IT, WITH ACTIONS WRITE.
    const owner = full.split('/')[0].toLowerCase();
    const inst = await get('/user/installations?per_page=100');
    if (inst.res.status === 401) return { ...out, message: refusal(inst.res, 'the installation list') };
    if (!inst.res.ok) {
      // A PERSONAL TOKEN. GitHub refuses it this list, so whether the App is
      // installed stays unknown; what decides a dispatch with this token is
      // the person's own access, which the repository reply carries.
      out.installed = null;
      out.actionsWrite = r.body?.permissions ? r.body.permissions.push === true || r.body.permissions.admin === true : null;
    } else {
      const found = (Array.isArray(inst.body?.installations) ? inst.body.installations : []).find(
        (/** @type {any} */ i) => String(i?.account?.login || '').toLowerCase() === owner,
      );
      if (!found) {
        return {
          ...out,
          installed: false,
          message:
            `The Fleetwright GitHub App is not installed on ${full.split('/')[0]}. Install it there and pick ` +
            `${full}, then check again.`,
        };
      }
      out.installed = await reaches(found, full, get);
      if (!out.installed) {
        return {
          ...out,
          message:
            `The Fleetwright GitHub App is installed on ${full.split('/')[0]} but ${full} is not one of the ` +
            'repositories it was given. Add it to the installation on github.com, then check again.',
        };
      }
      out.actionsWrite = found?.permissions?.actions === 'write';
    }
    if (out.actionsWrite === false) {
      return {
        ...out,
        message: out.installed === null
          ? `This GitHub connection cannot start workflows in ${full}: it needs push access there.`
          : `The Fleetwright GitHub App reaches ${full} without Actions write, so it cannot start a workflow there. ` +
            'Accept the updated permissions on the installation, then check again.',
      };
    }

    // 3. WHICH RUNNERS IT CAN START.
    const refused = await listRunnerWorkflows(full, get, out);
    if (refused) return refused;
  } catch (e) {
    return { ...out, message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }

  return passed(out);
}

/**
 * The same check, made by the GitHub App rather than by a person — which is
 * how the minting Worker makes it, so that setting a runner repository needs no
 * permanent box holding anybody's GitHub connection.
 *
 * The installation is what GitHub said reaches the repository, permissions
 * and all; `token` is an installation token the caller minted for this one
 * repository with read access and nothing else, used for the two reads below
 * and then dropped. What it cannot say is whether the person setting it can
 * push there — that decides a dispatch, and GitHub answers it when they make
 * one.
 *
 * @param {{ repo: string, installation: { permissions?: Record<string, string> }, token: string,
 *   fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<RunnerRepoCheck>}
 */
export async function checkRunnerRepoAsApp({ repo, installation, token, fetchImpl = fetch }) {
  const name = String(repo || '');
  /** @type {RunnerRepoCheck} */
  const out = {
    repo: name,
    public: null,
    installed: true,
    actionsWrite: installation?.permissions?.actions === 'write',
    platforms: [],
    missing: Object.keys(RUNNER_WORKFLOWS),
    ok: false,
    message: '',
  };
  if (!REPO_RE.test(name)) return { ...out, message: 'That is not a repository name. Write it as owner/repo.' };
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'fleetwright',
  };
  /** @param {string} path */
  const get = async (path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS) });
    return { res, body: res.ok ? /** @type {any} */ (await res.json()) : null };
  };
  try {
    const r = await get(`/repos/${name}`);
    if (!r.res.ok) return { ...out, message: refusal(r.res, `the repository ${name}`) };
    const full = typeof r.body?.full_name === 'string' ? r.body.full_name : name;
    out.repo = full;
    out.public = r.body?.private === false;
    if (!out.public) {
      return {
        ...out,
        message:
          `${full} is private. A runner repository has to be public: Actions minutes on GitHub's standard ` +
          'runners are free only there, and a private one would bill every machine to its owner.',
      };
    }
    if (!out.actionsWrite) {
      return {
        ...out,
        message:
          `The Fleetwright GitHub App reaches ${full} without Actions write, so it cannot start a workflow there. ` +
          'Accept the updated permissions on the installation, then check again.',
      };
    }
    const refused = await listRunnerWorkflows(full, get, out);
    if (refused) return refused;
  } catch (e) {
    return { ...out, message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
  return passed(out);
}

/**
 * WHICH RUNNERS A REPOSITORY CAN START. One listing of the workflows directory
 * rather than four requests, and a missing directory is an ordinary answer: a
 * repository with no workflows yet. Fills in `out`, and returns a refusal when
 * there is not one runner workflow there.
 *
 * @param {string} full
 * @param {(path: string) => Promise<{ res: Response, body: any }>} get
 * @param {RunnerRepoCheck} out
 * @returns {Promise<RunnerRepoCheck|null>}
 */
async function listRunnerWorkflows(full, get, out) {
  const wf = await get(`/repos/${full}/contents/.github/workflows`);
  if (!wf.res.ok && wf.res.status !== 404) return { ...out, message: refusal(wf.res, `the workflows in ${full}`) };
  const files = new Set(
    (Array.isArray(wf.body) ? wf.body : []).map((/** @type {any} */ f) => String(f?.name || '')),
  );
  out.platforms = Object.entries(RUNNER_WORKFLOWS).filter(([, file]) => files.has(file)).map(([p]) => p);
  out.missing = Object.keys(RUNNER_WORKFLOWS).filter((p) => !out.platforms.includes(p));
  if (!out.platforms.length) {
    return {
      ...out,
      message:
        `${full} has none of the runner workflows. Make it from github.com/TheTechNetwork/Fleetwright-Runners-Template, or copy that ` +
        "repository's .github directory into it, then check again.",
    };
  }
  return null;
}

/** @param {RunnerRepoCheck} out @returns {RunnerRepoCheck} */
function passed(out) {
  return {
    ...out,
    ok: true,
    message:
      `${out.repo} can start ${out.platforms.join(', ')} machines` +
      (out.missing.length ? `; it has no workflow for ${out.missing.join(', ')}.` : '.') +
      (out.installed === null
        ? ' This connection is a personal token, so it dispatches with your own access rather than the Fleetwright app.'
        : ''),
  };
}

/**
 * Does one installation cover one repository. `all` covers everything the
 * account owns; `selected` has to be asked, and is paged — an organisation can
 * give an App thousands of repositories.
 *
 * @param {any} installation
 * @param {string} full
 * @param {(path: string) => Promise<{ res: Response, body: any }>} get
 */
async function reaches(installation, full, get) {
  if (installation?.repository_selection === 'all') return true;
  const wanted = full.toLowerCase();
  // Ten pages of a hundred. Past that the answer is "cannot tell", which the
  // caller reports as not reached — rare enough that the sentence it gets
  // still sends them to the right page.
  for (let page = 1; page <= 10; page++) {
    const r = await get(`/user/installations/${Number(installation.id)}/repositories?per_page=100&page=${page}`);
    if (!r.res.ok) return false;
    const repos = Array.isArray(r.body?.repositories) ? r.body.repositories : [];
    if (repos.some((/** @type {any} */ x) => String(x?.full_name || '').toLowerCase() === wanted)) return true;
    if (repos.length < 100) return false;
  }
  return false;
}
