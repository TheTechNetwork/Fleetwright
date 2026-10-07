// A session, pushed to its owner's private archive before it goes (#346, #314).
//
// THE PROBLEM IS ALREADY FILED. A stopped session's console output goes with
// its container; a runner takes its whole workspace with it when the job ends;
// and the only way work left either was a person reading `peek` before the
// clock ran out. A returning beta tester recovered their output by luck — the
// transcript survived a resume — and said a week where they had not been lucky
// would be the one they did not come back after.
//
// THIS IS THE EXIT THAT DOES NOT NEED SOMEBODY WATCHING: an ordinary commit,
// on a branch of the session's own, in the private repository the person who
// started it linked as their archive (src/fleet/coordinator/linked-repos.js).
//
// WHAT GOES IN, as files at the top of the commit:
//
//   README.md          what this is, what is in it and what is not, in words
//   session.json       the record: name, title, brief, host, who, when, why now
//   pane.txt           the console's scrollback — the part #314 is about
//   transcript.jsonl   the conversation, when this box can read it. An
//                      unsandboxed session's (a runner's) can be; a sandboxed
//                      one's is inside a volume that also holds its Claude
//                      credential, which nothing here mounts, and it survives a
//                      stop anyway: `resume` reads it
//   workspace.patch    what changed in /work — against HEAD when it is a git
//                      checkout, every file when it is not — as a binary
//                      patch, so `git apply` puts it back
//
// WHEN, and the three answer different ways of losing the work:
//
//   before a stop, forget or purge   the container is about to go
//   every ARCHIVE_EVERY_MS            a runner is killed when its job ends,
//                                     and nothing gets to run first; a
//                                     checkpoint ten minutes old is the bound
//   when the hub is told to stop, on a runner   best effort, before the job
//                                     takes the machine
//
// A checkpoint that would commit the same tree as the branch already holds is
// skipped, so an idle session costs a few reads every ten minutes, not a
// commit.
//
// PUSHED AS THE PERSON WHO STARTED IT, with their own GitHub credential and
// nothing wider: on a permanent box their connection here (connectors.js), and
// on a runner a one-repository, one-hour token minted for them through the
// runner's broker (src/fleet/host/runner-broker.js) — contents write only if
// GitHub says they can push. So an archive can land only where its owner could
// already push.
//
// AND ONLY SOMEWHERE PRIVATE, CHECKED HERE. The repository name came from the
// coordinator, on `start`, and this project treats the coordinator as
// compromised. So the first thing a push does is ask GitHub, with the owner's
// own credential, whether the repository is private — and refuse a public one,
// whatever the link said when it was made. A repository made public after it
// was linked stops being written to the moment it is.
//
// THROUGH GITHUB'S API, NOT `git push`. A blob, a tree, a commit and a ref are
// four requests a box can make with nothing installed but this process; they
// need no clone of a repository that only ever grows, and no credential helper
// on a command line where `ps` could read it.

import { spawn } from 'node:child_process';
import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { request } from 'node:http';

import { REPO_RE } from '../fleet/protocol/intents.js';
import { capturePane, hasSession } from './tmux.js';
import { sandboxNames, workspaceExists } from './podman.js';
import { sessionImage } from './sandbox-variant.js';
import { usernsArgs } from './sandbox-userns.js';
import { Connections } from './connectors.js';
import { rowForActor, HOST_ROW } from './accounts.js';
import { log } from '../log.js';

/** How often a running session with an archive is pushed again. */
export const ARCHIVE_EVERY_MS = 10 * 60_000;

/** Lines of scrollback kept. The pane's own history limit is usually lower. */
export const PANE_LINES = 20_000;

/**
 * The most of any one file a commit carries. GitHub takes a blob up to 100MB
 * through this API, but the request is the blob in base64 inside JSON, held in
 * memory twice; six megabytes of patch is a very large change and still a
 * request a small box can make. A file over it is left out and SAID to be in
 * README.md, never truncated: half a patch does not apply, and a truncated
 * transcript reads as a conversation that ended.
 */
export const MAX_FILE_BYTES = 6 * 1024 * 1024;

/** Bounds on the parts that run something: a patch, and each GitHub call. */
const PATCH_TIMEOUT_MS = 120_000;
const GITHUB_TIMEOUT_MS = 30_000;

/**
 * The patch, made by a shell script that writes nothing to the workspace —
 * the session's own repository is not this script's to change, and in a
 * container its mount is read-only anyway.
 *
 * `git diff HEAD` reads; untracked files are diffed against /dev/null one at a
 * time with `--no-index`, which needs no repository and touches no index. A
 * directory that is not a checkout is all untracked. POSIX sh, find, xargs and
 * head only, because the same script runs in the session image (Debian) and
 * on a macOS runner (BSD tools). `$1` is the workspace, passed as an argument
 * and never spliced in. The output is cut at one byte over the limit, so
 * "too big" is measured, not guessed.
 */
export const PATCH_SCRIPT = `
w="$1"; max="$2"
cd "$w" 2>/dev/null || { echo "no workspace at $w" >&2; exit 4; }
# A workspace owned by another uid is "dubious" to git, and a mount seen
# through a user namespace always is. Command-line scope is the one git honours.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'
{
  # A COPY OF THE INDEX, because a diff refreshes the one it reads as a side
  # effect, optional locks or not, and that would be a write into somebody
  # else's repository. The copy is refreshed instead, and thrown away.
  if git rev-parse -q --verify HEAD >/dev/null 2>&1; then
    t=$(mktemp -d)
    cp "$(git rev-parse --git-path index)" "$t/index" 2>/dev/null
    GIT_INDEX_FILE="$t/index" git diff --binary HEAD
    rm -rf "$t"
  fi
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -z --others --exclude-standard
  else
    find . -path ./.git -prune -o -type f -print0
  fi | xargs -0 -n1 sh -c 'git diff --no-index --binary -- /dev/null "$1"; true' _
} 2>/dev/null | head -c "$((max + 1))"
`;

/**
 * Run a command and collect its stdout as bytes, bounded in time and size.
 *
 * @param {string} bin @param {string[]} args @param {{ timeout: number, cap: number }} opts
 * @returns {Promise<{ status: number, stdout: Buffer, stderr: string }>}
 */
function capture(bin, args, { timeout, cap }) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const out = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    /** @param {number} status */
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out), stderr });
    };
    const timer = setTimeout(() => {
      stderr += `\ntimed out after ${Math.round(timeout / 1000)}s`;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish(1);
    }, timeout);
    timer.unref?.();
    child.stdout.on('data', (d) => {
      if (size <= cap) {
        out.push(d);
        size += d.length;
      }
    });
    child.stderr.on('data', (d) => { if (stderr.length < 4096) stderr += d; });
    child.on('error', (e) => { stderr += e.message; finish(1); });
    child.on('close', (code) => finish(code === null ? 1 : code));
  });
}

/**
 * The workspace as a patch, from wherever this session's workspace lives.
 *
 * @param {import('../config.js').Config} cfg
 * @param {import('./registry.js').SessionRecord} rec
 * @returns {Promise<{ ok: true, patch: Buffer, tooBig: boolean } | { ok: false, why: string }>}
 */
export async function workspacePatch(cfg, rec) {
  const cap = MAX_FILE_BYTES;
  let r;
  if (cfg.sandbox) {
    // THE SAME CONFINEMENT files.js runs a file browser in: one volume, read
    // only, no network, the session's own image — so the git that reads it is
    // the git the session used. The conversation volume, which holds the
    // Claude credential, is not mounted.
    if (!workspaceExists(cfg, rec.name)) return { ok: false, why: 'it has no workspace volume' };
    const { work } = sandboxNames(rec.name);
    r = await capture(cfg.podmanBin, [
      'run', '--rm', ...usernsArgs(cfg),
      '-v', `${work}:/work:ro`,
      '--network', 'none',
      sessionImage(cfg),
      'sh', '-c', PATCH_SCRIPT, 'sh', '/work', String(cap),
    ], { timeout: PATCH_TIMEOUT_MS, cap });
  } else {
    if (!rec.cwd || !existsSync(rec.cwd)) return { ok: false, why: 'its working directory is gone' };
    r = await capture('sh', ['-c', PATCH_SCRIPT, 'sh', rec.cwd, String(cap)], { timeout: PATCH_TIMEOUT_MS, cap });
  }
  if (r.status !== 0 && !r.stdout.length) return { ok: false, why: (r.stderr || `the patch exited ${r.status}`).trim().slice(0, 200) };
  if (r.stdout.length > cap) return { ok: true, patch: Buffer.alloc(0), tooBig: true };
  return { ok: true, patch: r.stdout, tooBig: false };
}

/**
 * The transcript, when this box can read it: the file the session's own hook
 * named (cleanTranscriptPath keeps only a path on this box). Read whole or not
 * at all, for the reason MAX_FILE_BYTES gives.
 *
 * @param {string|null|undefined} file
 * @returns {{ ok: true, bytes: Buffer } | { ok: false, why: string }}
 */
export function readTranscript(file) {
  if (!file) return { ok: false, why: 'this box cannot read it — a sandboxed session keeps it in its own volume, and `resume` brings it back' };
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size > MAX_FILE_BYTES) return { ok: false, why: `it is ${Math.round(size / 1048576)}MB, over the ${MAX_FILE_BYTES / 1048576}MB an archive carries` };
    const bytes = Buffer.alloc(size);
    readSync(fd, bytes, 0, size, 0);
    return { ok: true, bytes };
  } catch (e) {
    return { ok: false, why: `it could not be read (${/** @type {Error} */ (e).message})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The branch a session is archived on. One per session, never shared: two
 * sessions pushing to one branch is a race with somebody's output on the
 * losing side. The host is in it because a name is unique per box, and the
 * start time because a name can be used again once forgotten.
 *
 * @param {string} host @param {{ name: string, createdAt?: number|null }} rec
 */
export function branchFor(host, rec) {
  const box = String(host || 'host').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'host';
  const at = new Date(Number(rec.createdAt) || 0).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `fleetwright/${box}/${rec.name}-${at}`;
}

/**
 * Everything that goes into one commit, as path → bytes, and the README that
 * says what is and is not there. Pure: what to collect is decided by the
 * caller, so this is what a test can hold still.
 *
 * @param {{ rec: import('./registry.js').SessionRecord, host: string, reason: string, at: number,
 *   pane: string|null, transcript: { ok: true, bytes: Buffer } | { ok: false, why: string },
 *   patch: { ok: true, patch: Buffer, tooBig: boolean } | { ok: false, why: string } }} parts
 * @returns {Record<string, Buffer>}
 */
export function archiveFiles({ rec, host, reason, at, pane, transcript, patch }) {
  /** @type {Record<string, Buffer>} */
  const files = {};
  /** @type {string[]} */
  const here = [];
  /** @type {string[]} */
  const missing = [];
  if (pane !== null) {
    files['pane.txt'] = Buffer.from(pane);
    here.push('- `pane.txt` — the console, as far back as its scrollback went');
  } else {
    missing.push('- the console: the session was not running, so there was no pane to read');
  }
  if (transcript.ok) {
    files['transcript.jsonl'] = transcript.bytes;
    here.push('- `transcript.jsonl` — the conversation, as Claude Code wrote it');
  } else {
    missing.push(`- the transcript: ${transcript.why}`);
  }
  if (patch.ok && !patch.tooBig && patch.patch.length) {
    files['workspace.patch'] = patch.patch;
    here.push('- `workspace.patch` — what changed in the workspace; `git apply workspace.patch` in a checkout of the same commit puts it back');
  } else if (patch.ok && patch.tooBig) {
    missing.push(`- the workspace: its changes are over the ${MAX_FILE_BYTES / 1048576}MB an archive carries, so none of them are here rather than half`);
  } else if (patch.ok) {
    here.push('- no workspace patch — nothing in the workspace had changed');
  } else {
    missing.push(`- the workspace: ${patch.why}`);
  }
  const when = new Date(at).toISOString();
  files['session.json'] = Buffer.from(`${JSON.stringify({
    name: rec.name,
    title: rec.title ?? null,
    brief: rec.brief ?? null,
    host,
    createdBy: rec.createdBy ?? null,
    createdAt: rec.createdAt ? new Date(rec.createdAt).toISOString() : null,
    status: rec.status,
    uuid: rec.uuid ?? null,
    archivedAt: when,
    reason,
  }, null, 2)}\n`);
  files['README.md'] = Buffer.from(
    [
      `# ${rec.title || rec.name}`,
      '',
      `Session \`${rec.name}\` on \`${host}\`, archived ${REASONS[reason] || reason} at ${when}.`,
      '',
      'Every push to this branch is the whole of what could be collected at that moment, so the newest commit is the one to read.',
      '',
      '## In this commit',
      '',
      ...here,
      '- `session.json` — the record: who started it, when, and why it was pushed now',
      ...(missing.length ? ['', '## Not in it, and why', '', ...missing] : []),
      '',
    ].join('\n'),
  );
  return files;
}

/** How README.md says why a commit was made. */
const REASONS = /** @type {Record<string, string>} */ ({
  stop: 'as it was stopped',
  forget: 'as it was forgotten',
  purge: 'as it was purged',
  checkpoint: 'on its ten-minute checkpoint',
  shutdown: 'as its machine was shutting down',
  asked: 'because somebody asked',
});

/**
 * Push one commit of `files` to `branch` in `repo`, with `token`, refusing a
 * repository that is not private. NEVER THROWS: every failure is a sentence,
 * and the stop that called this goes ahead whatever it says.
 *
 * @param {{ repo: string, branch: string, files: Record<string, Buffer>, message: string, token: string,
 *   fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<{ ok: true, commit: string, unchanged: boolean, text: string }
 *   | { ok: false, text: string }>}
 */
export async function pushArchive({ repo, branch, files, message, token, fetchImpl = fetch }) {
  if (!REPO_RE.test(repo)) return { ok: false, text: 'That is not a repository name.' };
  const base = `https://api.github.com/repos/${repo}`;
  /** @param {string} method @param {string} path @param {unknown} [body] */
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'fleetwright',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    return { res, body: res.ok ? /** @type {any} */ (await res.json()) : null };
  };
  const ref = branch.split('/').map(encodeURIComponent).join('/');
  try {
    // 1. PRIVATE, ASKED NOW, with the owner's own credential.
    const r = await call('GET', '');
    if (r.res.status === 401) return { ok: false, text: `GitHub rejected the credential for ${repo} (401). Reconnect GitHub.` };
    if (!r.res.ok) return { ok: false, text: `GitHub answered ${r.res.status} for ${repo}, so nothing was pushed.` };
    if (r.body?.private !== true) {
      return { ok: false, text: `${repo} is not private, so nothing was pushed to it. An archive has to be private; link a private one.` };
    }

    // 2. WHERE THE BRANCH IS NOW, so this commit follows the last one.
    const head = await call('GET', `/git/ref/heads/${ref}`);
    let parent = null;
    let parentTree = null;
    if (head.res.ok) {
      parent = String(head.body?.object?.sha || '') || null;
      if (parent) parentTree = String((await call('GET', `/git/commits/${parent}`)).body?.tree?.sha || '') || null;
    } else if (head.res.status !== 404) {
      return { ok: false, text: `GitHub answered ${head.res.status} for the branch ${branch}, so nothing was pushed.` };
    }

    // 3. THE FILES. An EMPTY repository refuses a blob (409) — GitHub's API
    // cannot write into a repository with no commits — so it gets one first: a
    // README on its default branch saying what the branches are.
    /** @type {Array<{ path: string, mode: string, type: string, sha: string }>} */
    const tree = [];
    let seeded = false;
    for (const [path, bytes] of Object.entries(files)) {
      let blob = await call('POST', '/git/blobs', { content: bytes.toString('base64'), encoding: 'base64' });
      if (blob.res.status === 409 && !seeded) {
        seeded = true;
        const put = await call('PUT', '/contents/README.md', {
          message: 'Fleetwright archive',
          content: Buffer.from(
            '# Fleetwright archive\n\nEach branch under `fleetwright/` is one session, pushed before it stopped and every ten minutes while it ran.\n',
          ).toString('base64'),
        });
        if (!put.res.ok) return { ok: false, text: `${repo} is empty and GitHub would not take its first commit (${put.res.status}).` };
        blob = await call('POST', '/git/blobs', { content: bytes.toString('base64'), encoding: 'base64' });
      }
      if (!blob.res.ok) {
        return {
          ok: false,
          text: blob.res.status === 403 || blob.res.status === 404
            ? `GitHub would not let this credential write to ${repo} (${blob.res.status}). It needs push access there.`
            : `GitHub answered ${blob.res.status} for a file of the archive, so nothing was pushed.`,
        };
      }
      tree.push({ path, mode: '100644', type: 'blob', sha: String(blob.body?.sha || '') });
    }
    const made = await call('POST', '/git/trees', { tree });
    if (!made.res.ok) return { ok: false, text: `GitHub answered ${made.res.status} for the archive's tree, so nothing was pushed.` };
    const treeSha = String(made.body?.sha || '');

    // NOTHING NEW SINCE THE LAST PUSH is not a commit.
    if (parent && parentTree === treeSha) {
      return { ok: true, commit: parent, unchanged: true, text: `Nothing had changed since the last push to ${branch}.` };
    }

    // 4. THE COMMIT, AND THE BRANCH MOVED TO IT — never forced: a branch that
    // moved under this push is one somebody else wrote, and this does not
    // write over them.
    const commit = await call('POST', '/git/commits', { message, tree: treeSha, parents: parent ? [parent] : [] });
    if (!commit.res.ok) return { ok: false, text: `GitHub answered ${commit.res.status} for the archive's commit, so nothing was pushed.` };
    const sha = String(commit.body?.sha || '');
    const moved = parent
      ? await call('PATCH', `/git/refs/heads/${ref}`, { sha, force: false })
      : await call('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
    if (!moved.res.ok) return { ok: false, text: `GitHub answered ${moved.res.status} moving ${branch}, so the push did not land.` };
    return { ok: true, commit: sha, unchanged: false, text: `Pushed to ${repo} on ${branch} (${sha.slice(0, 7)}).` };
  } catch (e) {
    return { ok: false, text: `Could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}

/**
 * Ask a runner's broker for a token for one repository — the socket the
 * runner workflow names in FLEETWRIGHT_RUNNER_BROKER, which this process
 * inherits like the sessions it starts. The same route and answer as
 * sandbox/credential.mjs; the sidecar behind it mints a one-hour token for the
 * runner's owner and that repository only.
 *
 * @param {string} socketPath @param {string} repo
 * @returns {Promise<string|null>}
 */
export function runnerToken(socketPath, repo) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ provider: 'github', repo });
    const req = request(
      { socketPath, path: '/internal/credential', method: 'POST', timeout: 30_000,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          try {
            const a = JSON.parse(text);
            resolve(a?.ok === true && typeof a.env?.GH_TOKEN === 'string' ? a.env.GH_TOKEN : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

/**
 * The owner's GitHub credential for this repository: their connection on this
 * box, or on a runner a token its broker mints for them. Never the box's own
 * row: an archive is pushed AS the person who started the session.
 *
 * @param {import('../config.js').Config} cfg @param {string|null|undefined} owner @param {string} repo
 * @param {{ broker?: string }} [opts]
 * @returns {Promise<{ token: string } | { token: null, why: string }>}
 */
export async function ownerToken(cfg, owner, repo, { broker = process.env.FLEETWRIGHT_RUNNER_BROKER || '' } = {}) {
  const row = rowForActor(owner);
  if (row === null || row === HOST_ROW) return { token: null, why: 'nobody signed in started it, so there is no one to push as' };
  const own = new Connections(cfg.stateDir).tokenFor(row, 'github');
  if (own) return { token: own };
  if (broker) {
    const minted = await runnerToken(broker, repo);
    if (minted) return { token: minted };
    return { token: null, why: 'this runner could not be given a token for it — the fleet’s events say why' };
  }
  return { token: null, why: 'GitHub is not connected for its owner on this box' };
}

/**
 * Archive one session now: collect, push, and write the outcome on its record
 * so `list` and the phones can say what happened. NEVER THROWS.
 *
 * @param {{ cfg: import('../config.js').Config, registry: import('./registry.js').Registry, name: string,
 *   reason: string, fetchImpl?: typeof globalThis.fetch, now?: () => number, broker?: string }} args
 * @returns {Promise<{ ok: boolean, text: string, skipped?: boolean }>}
 */
export async function archiveSession({ cfg, registry, name, reason, fetchImpl = fetch, now = () => Date.now(), broker }) {
  const rec = registry.get(name);
  const repo = rec?.archive;
  if (!rec || !repo || !REPO_RE.test(repo)) return { ok: true, skipped: true, text: '' };
  const host = cfg.hostname;
  const branch = branchFor(host, rec);
  const at = now();
  /** @param {{ ok: boolean, text: string, commit?: string }} r */
  const note = (r) => {
    registry.upsert(name, {
      archiveBranch: branch,
      archiveAt: at,
      archiveOk: r.ok,
      archiveText: r.text,
      ...(r.commit ? { archiveCommit: r.commit } : {}),
    });
    if (r.ok) log.info(`archive: ${name} → ${repo} ${branch}: ${r.text}`);
    else log.warn(`archive: ${name} → ${repo}: ${r.text}`);
    return r;
  };
  const cred = await ownerToken(cfg, rec.createdBy, repo, broker === undefined ? {} : { broker });
  if (cred.token === null) return note({ ok: false, text: `Not archived to ${repo}: ${cred.why}.` });
  const running = hasSession(name);
  const files = archiveFiles({
    rec,
    host,
    reason,
    at,
    pane: running ? capturePane(name, PANE_LINES) : null,
    transcript: readTranscript(rec.transcriptPath),
    patch: await workspacePatch(cfg, rec),
  });
  const pushed = await pushArchive({
    repo,
    branch,
    files,
    message: `${rec.title || name}: archived ${REASONS[reason] || reason}`,
    token: cred.token,
    fetchImpl,
  });
  return pushed.ok
    ? note({ ok: true, commit: pushed.commit, text: pushed.unchanged ? pushed.text : `Archived to ${repo} on ${branch}.` })
    : note({ ok: false, text: `Not archived to ${repo}: ${pushed.text}` });
}

/** One pass at a time: a slow GitHub must not stack passes on top of each other. */
let passing = false;

/**
 * Push every running session that has an archive, one after another: the
 * ten-minute checkpoint, and the last pass when a runner's hub is told to
 * stop. Unchanged sessions cost reads and no commit (pushArchive). A pass
 * already under way is not doubled; it answers 0.
 *
 * @param {{ cfg: import('../config.js').Config, registry: import('./registry.js').Registry, reason?: string,
 *   fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<number>} how many sessions were tried
 */
export async function archiveRunning({ cfg, registry, reason = 'checkpoint', fetchImpl }) {
  if (passing) return 0;
  passing = true;
  try {
    let tried = 0;
    for (const rec of registry.list()) {
      if (rec.status !== 'running' || !rec.archive || !hasSession(rec.name)) continue;
      tried++;
      await archiveSession({ cfg, registry, name: rec.name, reason, ...(fetchImpl ? { fetchImpl } : {}) });
    }
    return tried;
  } catch (e) {
    log.warn('archive: a pass failed', e);
    return 0;
  } finally {
    passing = false;
  }
}
