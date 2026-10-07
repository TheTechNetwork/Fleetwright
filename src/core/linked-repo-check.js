// Is this repository fit for the role somebody is linking it for?
//
// THREE ROLES, ONE CHECK, AND THE ROLE DECIDES THE ANSWER (#346). The same
// repository can be exactly right as one and dangerous as another, which is
// the whole reason a link carries a role rather than being "a linked repo":
//
//   archive    MUST BE PRIVATE, and writable. A session's transcript and
//              workspace are somebody's work and possibly their client's, and
//              the archive is where they are pushed before the container or
//              the machine goes. A public one is refused, not warned about —
//              there is no reading of "push my client's code somewhere
//              world-readable" that a confirmation dialog makes right
//   runners    MUST BE PUBLIC. Delegated whole to checkRunnerRepo in
//              ./runners.js, which already asks everything a dispatch needs;
//              this file only puts the role on its answer
//   templates  EITHER. A Renovate preset has to be public to be extended; a
//              repository of skills naming internal systems should not be. It
//              has to be readable, and the answer says which of the shapes the
//              v3 bootstrap profiles make it carries
//
// ASKED TWO WAYS, like the runner check. With the PERSON'S connection on a
// permanent box (`linkrepo`), which can also say whether they themselves can
// push; and as the GITHUB APP, from the minting Worker, so a fleet with no box
// can link one — that way cannot see the person, and says so rather than
// guessing. Either way null is "cannot tell" and never "no".
//
// NEVER THROWS, and NO node: IMPORTS: the minting Worker imports this file
// through repo-tokens.js.

import { REPO_RE, LINK_ROLES } from '../fleet/protocol/intents.js';
import { checkRunnerRepo, checkRunnerRepoAsApp, reaches } from './runners.js';

/** Same bound and reasoning as runners.js: a few API calls on a bad day. */
const GITHUB_TIMEOUT_MS = 15_000;

/**
 * What a templates repository is recognised as carrying, at its top level.
 * The three things the v3 bootstrap profiles create — a `.claude` directory
 * (skills, settings, commands), a `.github` directory (workflows, community
 * files), and a Renovate preset, which is a `default.json` by Renovate's own
 * convention. A repository carrying none of them still links: a session can
 * read whatever it holds, and this list is what a screen can name.
 */
export const TEMPLATE_SHAPES = Object.freeze(['.claude', '.github', 'default.json']);

/**
 * @typedef {object} LinkedRepoCheck
 * @property {'archive'|'runners'|'templates'} role
 * @property {string} repo         as GitHub spells it, which is the spelling worth saving
 * @property {boolean|null} public null when the repository could not be read
 * @property {boolean|null} installed  does the Fleetwright GitHub App reach it;
 *   null for a personal token, which cannot see installations
 * @property {'write'|'read'|'none'|null} contents  what this connection can do
 *   with the repository's files: the installation's Contents permission, or
 *   for a personal token the person's own access
 * @property {boolean|null} push   can THE PERSON push there. Null when asked as
 *   the App, which knows nothing about who is asking — GitHub answers it the
 *   first time a session of theirs is pushed
 * @property {string[]|null} carries  for templates: which TEMPLATE_SHAPES are
 *   at its top level. Null for the other roles
 * @property {boolean} ok
 * @property {string} message      one sentence, naming the first thing to fix
 * @property {import('./runners.js').RunnerRepoCheck} [runnerRepo]  for runners, the whole runner check
 */

/** @param {Response} res @param {string} what */
function refusal(res, what) {
  if (res.status === 401) {
    return 'GitHub rejected the stored token (401). It has expired or been revoked — reconnect GitHub in the app.';
  }
  if (res.status === 404) {
    return (
      `GitHub answered 404 for ${what}. Either it does not exist or this connection cannot see it — a GitHub App ` +
      'installation only reaches the repositories that were picked when it was installed.'
    );
  }
  return `GitHub answered ${res.status} for ${what}.`;
}

/**
 * @param {string} role @param {string} repo
 * @returns {LinkedRepoCheck}
 */
function blank(role, repo) {
  return {
    role: /** @type {LinkedRepoCheck['role']} */ (role),
    repo,
    public: null,
    installed: null,
    contents: null,
    push: null,
    carries: null,
    ok: false,
    message: '',
  };
}

/** @param {string} token */
function getter(token, fetchImpl = fetch) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'fleetwright',
  };
  /** @param {string} path */
  return async (path) => {
    const res = await fetchImpl(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    return { res, body: res.ok ? /** @type {any} */ (await res.json()) : null };
  };
}

/** A runner check, as a linked-repository one. @param {import('./runners.js').RunnerRepoCheck} r @returns {LinkedRepoCheck} */
export function runnersCheck(r) {
  return {
    role: 'runners',
    repo: r.repo,
    public: r.public,
    installed: r.installed,
    contents: null,
    push: null,
    carries: null,
    ok: r.ok,
    message: r.message,
    runnerRepo: r,
  };
}

/** @param {unknown} role @param {unknown} repo @returns {LinkedRepoCheck|null} a refusal, or null to go on */
function malformed(role, repo) {
  const r = String(role || '');
  if (!LINK_ROLES.includes(r)) {
    return { ...blank('archive', String(repo || '')), message: `A linked repository is one of ${LINK_ROLES.join(', ')}, not "${r.slice(0, 40)}".` };
  }
  if (!REPO_RE.test(String(repo || ''))) return { ...blank(r, String(repo || '')), message: 'That is not a repository name. Write it as owner/repo.' };
  return null;
}

/**
 * Check a repository for a role, with the PERSON's own GitHub connection.
 *
 * @param {{ role: string, repo: string, token: string, fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<LinkedRepoCheck>}
 */
export async function checkLinkedRepo({ role, repo, token, fetchImpl = fetch }) {
  const bad = malformed(role, repo);
  if (bad) return bad;
  if (role === 'runners') return runnersCheck(await checkRunnerRepo({ repo, token, fetchImpl }));
  const out = blank(role, String(repo));
  const get = getter(token, fetchImpl);
  try {
    const r = await get(`/repos/${out.repo}`);
    if (!r.res.ok) return { ...out, message: refusal(r.res, `the repository ${out.repo}`) };
    seen(out, r.body);
    if (role === 'archive' && out.public) return publicArchive(out);
    // The person's own access, which a GitHub App user token is bounded by
    // as much as by the installation: it can do what both allow.
    const perms = r.body?.permissions;
    out.push = perms ? perms.push === true || perms.admin === true : null;

    const owner = out.repo.split('/')[0].toLowerCase();
    const inst = await get('/user/installations?per_page=100');
    if (inst.res.status === 401) return { ...out, message: refusal(inst.res, 'the installation list') };
    if (!inst.res.ok) {
      // A PERSONAL TOKEN: the installation list is refused it, so whether the
      // App reaches the repository stays unknown, and what a push with this
      // token can do is the person's own access.
      out.installed = null;
      out.contents = out.push === null ? null : out.push ? 'write' : perms?.pull === false ? 'none' : 'read';
    } else {
      const found = (Array.isArray(inst.body?.installations) ? inst.body.installations : []).find(
        (/** @type {any} */ i) => String(i?.account?.login || '').toLowerCase() === owner,
      );
      if (!found) {
        return {
          ...out,
          installed: false,
          message: `The Fleetwright GitHub App is not installed on ${out.repo.split('/')[0]}. Install it there and pick ${out.repo}, then check again.`,
        };
      }
      out.installed = await reaches(found, out.repo, get);
      if (!out.installed) {
        return {
          ...out,
          message:
            `The Fleetwright GitHub App is installed on ${out.repo.split('/')[0]} but ${out.repo} is not one of the ` +
            'repositories it was given. Add it to the installation on github.com, then check again.',
        };
      }
      out.contents = contentsOf(found?.permissions);
    }
    return await decide(out, get);
  } catch (e) {
    return { ...out, message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}

/**
 * The same check made by the GitHub App, which is how the minting Worker makes
 * it: `installation` is what GitHub said reaches the repository, and `token`
 * an installation token the caller minted for this one repository, metadata
 * and contents read, used for the reads below and dropped.
 *
 * @param {{ role: string, repo: string, installation: { permissions?: Record<string, string> }, token: string,
 *   fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<LinkedRepoCheck>}
 */
export async function checkLinkedRepoAsApp({ role, repo, installation, token, fetchImpl = fetch }) {
  const bad = malformed(role, repo);
  if (bad) return bad;
  if (role === 'runners') return runnersCheck(await checkRunnerRepoAsApp({ repo, installation, token, fetchImpl }));
  const out = { ...blank(role, String(repo)), installed: true, contents: contentsOf(installation?.permissions) };
  const get = getter(token, fetchImpl);
  try {
    const r = await get(`/repos/${out.repo}`);
    if (!r.res.ok) return { ...out, message: refusal(r.res, `the repository ${out.repo}`) };
    seen(out, r.body);
    if (role === 'archive' && out.public) return publicArchive(out);
    return await decide(out, get);
  } catch (e) {
    return { ...out, message: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}

/** @param {LinkedRepoCheck} out @param {any} body */
function seen(out, body) {
  if (typeof body?.full_name === 'string') out.repo = body.full_name;
  out.public = body?.private === false ? true : body?.private === true ? false : null;
}

/** @param {Record<string, string>|undefined} permissions @returns {LinkedRepoCheck['contents']} */
function contentsOf(permissions) {
  const c = permissions?.contents;
  return c === 'write' ? 'write' : c === 'read' ? 'read' : 'none';
}

/** @param {LinkedRepoCheck} out @returns {LinkedRepoCheck} */
function publicArchive(out) {
  return {
    ...out,
    message:
      `${out.repo} is public. An archive holds what a session read and wrote — your work, and possibly a ` +
      "client's — so it has to be private. Make it private on github.com, or link a private one.",
  };
}

/**
 * What decides each role once the repository is known and reached.
 *
 * @param {LinkedRepoCheck} out
 * @param {(path: string) => Promise<{ res: Response, body: any }>} get
 * @returns {Promise<LinkedRepoCheck>}
 */
async function decide(out, get) {
  if (out.role === 'archive') {
    // CANNOT TELL IS NOT PRIVATE. The one property the archive cannot do
    // without is the one an answer missing `private` leaves open.
    if (out.public === null) {
      return { ...out, message: `GitHub did not say whether ${out.repo} is private, so it is not linked as an archive.` };
    }
    if (out.contents !== 'write' && out.contents !== null) {
      return {
        ...out,
        message: out.installed === null
          ? `This GitHub connection cannot push to ${out.repo}, so a session could not be archived there.`
          : `The Fleetwright GitHub App reaches ${out.repo} without Contents write, so it cannot push a session there. ` +
            'Accept the updated permissions on the installation, then check again.',
      };
    }
    if (out.push === false) {
      return { ...out, message: `You cannot push to ${out.repo}, so a session of yours could not be archived there.` };
    }
    return {
      ...out,
      ok: true,
      message:
        `${out.repo} is private and can be written to. Sessions you start are pushed there, each on a branch of ` +
        'its own, before they stop.' +
        (out.push === null && out.installed === true
          ? ' Whether you yourself can push there is answered by GitHub the first time a session of yours is archived.'
          : ''),
    };
  }

  // TEMPLATES. Readable is the whole requirement; what it carries is
  // reported, never required.
  if (out.contents === 'none') {
    return {
      ...out,
      message: `The Fleetwright GitHub App reaches ${out.repo} without Contents read, so a session could not read it. ` +
        'Accept the updated permissions on the installation, then check again.',
    };
  }
  const top = await get(`/repos/${out.repo}/contents`);
  if (!top.res.ok && top.res.status !== 404) return { ...out, message: refusal(top.res, `the files in ${out.repo}`) };
  const names = new Set((Array.isArray(top.body) ? top.body : []).map((/** @type {any} */ f) => String(f?.name || '')));
  out.carries = TEMPLATE_SHAPES.filter((s) => names.has(s));
  return {
    ...out,
    ok: true,
    message:
      `${out.repo} is ${out.public ? 'public, so anyone can read it' : 'private'} and readable. ` +
      (out.carries.length
        ? `It carries ${out.carries.join(', ')}.`
        : 'It has none of .claude, .github or a Renovate default.json at its top level; a session can still read what it holds.') +
      ' Nothing in it is run or given to a session unless somebody asks for it.',
  };
}
