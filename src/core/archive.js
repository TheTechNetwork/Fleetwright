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
//   transcript/NNN.jsonl  the conversation, in PIECE_BYTES pieces cut
//                      between lines. An unsandboxed session's (a
//                      runner's) is the file its hook named; a sandboxed one's
//                      is read out of its own volume, read-only, one file by
//                      its uuid and nothing else (sandboxTranscript) — that
//                      volume also holds its Claude credential. It used to be
//                      left out because `resume` reads it, which is true only
//                      until the recycle bin deletes the volume
//   workspace.patch    what changed in /work — against HEAD when it is a git
//                      checkout, every file when it is not — as a binary
//                      patch, so `git apply` puts it back. session.json says
//                      which commit, branch and remote it applies to. Over a
//                      piece it is workspace.patch.NNN, joined with `cat`
//
// Pieces the branch already holds are not sent again (pushArchive), so a
// growing transcript costs its new last piece, not the whole of it.
//
// WHEN, and the three answer different ways of losing the work:
//
//   before a stop, forget or purge   the container is about to go
//   when it comes back to its prompt  a turn just ended, which is when the
//                                     transcript has something new; at most
//                                     once a PAUSE_GAP_MS (ArchivePacer)
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
import { createHash } from 'node:crypto';
import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { request } from 'node:http';

import { REPO_RE } from '../fleet/protocol/intents.js';
import { capturePane, hasSession } from './tmux.js';
import { sandboxNames, workspaceExists } from './podman.js';
import { sessionImage } from './sandbox-variant.js';
import { usernsArgs } from './sandbox-userns.js';
import { vaultToken, vaultHolder } from './vault-store.js';
import { operatorAccount } from './accounts.js';
import { log } from '../log.js';

/** How often a running session with an archive is pushed again. */
export const ARCHIVE_EVERY_MS = 10 * 60_000;

/** Lines of scrollback kept. The pane's own history limit is usually lower. */
export const PANE_LINES = 20_000;

/**
 * The most of one PIECE a request carries. A file goes to GitHub as base64
 * inside JSON, held in memory twice, so one request is kept to what a small
 * box can make; a file bigger than this is cut into pieces of it that join
 * back with `cat`, each its own blob. GitHub itself takes a blob up to 100MB.
 */
export const PIECE_BYTES = 5 * 1024 * 1024;

/**
 * The most of each a commit carries, in pieces. Over it the file is left out
 * and SAID to be in README.md, never truncated: half a patch does not apply,
 * and a truncated transcript reads as a conversation that ended. The earlier
 * commits on the branch keep what fit then.
 */
export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const MAX_PATCH_BYTES = 50 * 1024 * 1024;

const MB = (/** @type {number} */ b) => `${Math.round(b / 1048576)}MB`;

/**
 * Cut `bytes` into pieces of at most `size`. With `atLines`, only after a
 * newline, so each piece of a JSONL file is JSONL — and, because a transcript
 * only grows at its end, every piece but the last is the same bytes on every
 * push, which pushArchive then does not upload again. A line longer than a
 * piece is a piece of its own, longer than the rest.
 *
 * @param {Buffer} bytes @param {number} size @param {{ atLines?: boolean }} [opts]
 * @returns {Buffer[]}
 */
export function piecesOf(bytes, size, { atLines = false } = {}) {
  /** @type {Buffer[]} */
  const out = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + size, bytes.length);
    if (atLines && end < bytes.length) {
      const nl = bytes.lastIndexOf(10, end - 1);
      if (nl >= start) end = nl + 1;
      else {
        const next = bytes.indexOf(10, end);
        end = next === -1 ? bytes.length : next + 1;
      }
    }
    out.push(bytes.subarray(start, end));
    start = end;
  }
  return out;
}

/** A piece's name: three digits, so `cat` in name order is the file. */
const nth = (/** @type {number} */ i) => String(i).padStart(3, '0');

/** Bounds on the parts that run something: a patch, and each GitHub call. */
const PATCH_TIMEOUT_MS = 120_000;
/** Room for PATCH_SCRIPT's first line: a commit, a branch and a remote, each cut short. */
const BASE_LINE_MAX = 1024;
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
# WHAT THE PATCH APPLIES TO, as the first line: the commit, the branch and
# the remote, tab-separated, "-" for each it does not have. Read-only.
c=$(git rev-parse -q --verify HEAD 2>/dev/null | head -c 64)
b=$(git symbolic-ref -q --short HEAD 2>/dev/null | head -c 300)
o=$(git remote get-url origin 2>/dev/null | head -c 300)
c=\${c:--}; b=\${b:--}; o=\${o:--}
printf 'fleetwright-base\t%s\t%s\t%s\n' "$c" "$b" "$o"
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
 * @returns {Promise<{ ok: true, patch: Buffer, tooBig: boolean, base?: WorkspaceBase|null } | { ok: false, why: string }>}
 */
export async function workspacePatch(cfg, rec) {
  const cap = MAX_PATCH_BYTES;
  // The base line rides ahead of the patch, outside the script's `head -c`,
  // and is at most about 700 bytes; it gets room of its own, so the patch is
  // still measured against the whole limit and never cut.
  const room = cap + BASE_LINE_MAX;
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
    ], { timeout: PATCH_TIMEOUT_MS, cap: room });
  } else {
    if (!rec.cwd || !existsSync(rec.cwd)) return { ok: false, why: 'its working directory is gone' };
    r = await capture('sh', ['-c', PATCH_SCRIPT, 'sh', rec.cwd, String(cap)], { timeout: PATCH_TIMEOUT_MS, cap: room });
  }
  if (r.status !== 0 && !r.stdout.length) return { ok: false, why: (r.stderr || `the patch exited ${r.status}`).trim().slice(0, 200) };
  const { base, rest } = splitBase(r.stdout);
  if (rest.length > cap) return { ok: true, patch: Buffer.alloc(0), tooBig: true, base };
  return { ok: true, patch: rest, tooBig: false, base };
}

/**
 * @typedef {{ commit: string|null, branch: string|null, remote: string|null }} WorkspaceBase
 *   what a workspace patch applies to, as its own git said
 */

/**
 * The header PATCH_SCRIPT writes first, taken off the patch. A remote URL
 * loses any user and password in it: a clone made with a token in its URL
 * keeps it there, and this goes into a commit.
 *
 * @param {Buffer} out
 * @returns {{ base: WorkspaceBase|null, rest: Buffer }}
 */
export function splitBase(out) {
  const nl = out.indexOf(10);
  const first = nl === -1 ? '' : out.subarray(0, nl).toString('utf8');
  if (!first.startsWith('fleetwright-base\t')) return { base: null, rest: out };
  const [, commit, branch, remote] = first.split('\t');
  const keep = (/** @type {string|undefined} */ v) => (v && v !== '-' ? v.slice(0, 300) : null);
  const sha = keep(commit);
  return {
    base: {
      commit: sha && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null,
      branch: keep(branch),
      remote: keep(remote)?.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1') ?? null,
    },
    rest: out.subarray(nl + 1),
  };
}

/**
 * Reads ONE conversation out of a sandboxed session's own volume: the file
 * named for its uuid under projects/, a regular file and not a link, or
 * nothing. `$1` is the uuid, checked to be one before it gets here, `$2`
 * the most it may be, and `$3` where the volume is (a test's directory). The volume also holds the session's Claude credential,
 * so what leaves is decided here, never by the volume: one name, one file.
 */
export const TRANSCRIPT_SCRIPT = `
u="$1"; max="$2"; d="\${3:-/dest}"
f=$(find "$d/projects" -mindepth 2 -maxdepth 2 -type f -name "$u.jsonl" 2>/dev/null | head -n 1)
[ -n "$f" ] || { echo "no transcript named $u" >&2; exit 3; }
[ -L "$f" ] && { echo "the transcript is a link" >&2; exit 5; }
head -c "$((max + 1))" "$f"
`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A sandboxed session's transcript, read the way volumeAccount (podman.js)
 * reads that volume: mounted read-only, no network, the session's own image,
 * and only the one file TRANSCRIPT_SCRIPT names. It used to be left out with
 * "`resume` brings it back", which stopped being true the day the recycle bin
 * deleted the volume.
 *
 * @param {import('../config.js').Config} cfg
 * @param {import('./registry.js').SessionRecord} rec
 * @returns {Promise<{ ok: true, bytes: Buffer } | { ok: false, why: string }>}
 */
export async function sandboxTranscript(cfg, rec) {
  if (!rec.uuid || !UUID_RE.test(rec.uuid)) return { ok: false, why: 'the session has not started a conversation yet' };
  const { claude } = sandboxNames(rec.name);
  const r = await capture(cfg.podmanBin, [
    'run', '--rm', ...usernsArgs(cfg),
    '-v', `${claude}:/dest:ro`,
    '--network', 'none',
    sessionImage(cfg),
    'sh', '-c', TRANSCRIPT_SCRIPT, 'sh', rec.uuid, String(MAX_TRANSCRIPT_BYTES),
  ], { timeout: PATCH_TIMEOUT_MS, cap: MAX_TRANSCRIPT_BYTES });
  if (r.status !== 0) return { ok: false, why: `it could not be read (${(r.stderr || `exit ${r.status}`).trim().slice(0, 160)})` };
  if (r.stdout.length > MAX_TRANSCRIPT_BYTES) return { ok: false, why: `it is over the ${MB(MAX_TRANSCRIPT_BYTES)} an archive carries` };
  return { ok: true, bytes: r.stdout };
}

/**
 * The transcript from wherever this session keeps it: the file its hook named
 * on this box, or its own volume when it is sandboxed.
 *
 * @param {import('../config.js').Config} cfg
 * @param {import('./registry.js').SessionRecord} rec
 */
export async function collectTranscript(cfg, rec) {
  if (rec.transcriptPath) return readTranscript(rec.transcriptPath);
  if (cfg.sandbox) return sandboxTranscript(cfg, rec);
  return readTranscript(null);
}

/**
 * The transcript, when this box can read it: the file the session's own hook
 * named (cleanTranscriptPath keeps only a path on this box). Read whole or not
 * at all, for the reason MAX_TRANSCRIPT_BYTES gives.
 *
 * @param {string|null|undefined} file
 * @returns {{ ok: true, bytes: Buffer } | { ok: false, why: string }}
 */
export function readTranscript(file) {
  if (!file) return { ok: false, why: 'its hook never said where it is' };
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size > MAX_TRANSCRIPT_BYTES) return { ok: false, why: `it is ${MB(size)}, over the ${MB(MAX_TRANSCRIPT_BYTES)} an archive carries` };
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
 *   patch: { ok: true, patch: Buffer, tooBig: boolean, base?: WorkspaceBase|null } | { ok: false, why: string } }} parts
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
    // ALWAYS IN PIECES, one or many, so the layout does not change the day a
    // conversation passes PIECE_BYTES.
    const pieces = piecesOf(transcript.bytes, PIECE_BYTES, { atLines: true });
    pieces.forEach((b, i) => { files[`transcript/${nth(i)}.jsonl`] = b; });
    here.push(pieces.length > 1
      ? `- \`transcript/\` — the conversation, as Claude Code wrote it, in ${pieces.length} pieces cut between lines; \`cat transcript/*.jsonl\` is the whole of it`
      : '- `transcript/000.jsonl` — the conversation, as Claude Code wrote it. A long one is in more pieces; `cat transcript/*.jsonl` is the whole of it');
  } else {
    missing.push(`- the transcript: ${transcript.why}`);
  }
  const base = patch.ok ? patch.base ?? null : null;
  if (patch.ok && !patch.tooBig && patch.patch.length) {
    // ONE FILE WHEN IT FITS, the common case; pieces that `cat` joins when
    // it does not. A patch is not read line by line, so it is cut anywhere.
    const pieces = piecesOf(patch.patch, PIECE_BYTES);
    const names = pieces.length > 1 ? pieces.map((_, i) => `workspace.patch.${nth(i)}`) : ['workspace.patch'];
    pieces.forEach((b, i) => { files[names[i]] = b; });
    const join = pieces.length > 1 ? `\`cat workspace.patch.* > workspace.patch\` (${pieces.length} pieces), then ` : '';
    here.push(base?.commit
      ? `- \`${pieces.length > 1 ? 'workspace.patch.*' : 'workspace.patch'}\` — what changed in the workspace; ${join}\`git checkout ${base.commit}\`${base.remote ? ` in a clone of ${base.remote}` : ''} and \`git apply --binary workspace.patch\` puts it back`
      : `- \`${pieces.length > 1 ? 'workspace.patch.*' : 'workspace.patch'}\` — what changed in the workspace, every file of it: it was not a git checkout, so ${join}\`git apply --binary workspace.patch\` in an empty directory puts it back`);
  } else if (patch.ok && patch.tooBig) {
    missing.push(`- the workspace: its changes are over the ${MB(MAX_PATCH_BYTES)} an archive carries, so none of them are here rather than half. The earlier commits on this branch have what fit then`);
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
    // What workspace.patch applies to. Null when there was no patch to make.
    workspace: base,
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
  pause: 'as it came back to its prompt',
  shutdown: 'as its machine was shutting down',
  asked: 'because somebody asked',
});

/**
 * The id git gives a file's contents: SHA-1 of "blob <length>\0" and the
 * bytes, which is what GitHub names the blob it would make of them.
 *
 * @param {Buffer} bytes
 */
export function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

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
    // WHAT THE BRANCH ALREADY HOLDS, by content. A piece whose git id is in
    // the last commit's tree is not sent again: a long transcript is a new
    // last piece each push, not the whole conversation, and an idle session's
    // checkpoint uploads nothing at all. Cannot-tell (a failed or truncated
    // listing) only means uploading what might have been reused.
    /** @type {Set<string>} */
    const held = new Set();
    if (parentTree) {
      const listed = await call('GET', `/git/trees/${parentTree}?recursive=1`);
      for (const e of Array.isArray(listed.body?.tree) ? listed.body.tree : []) {
        if (e?.type === 'blob' && typeof e.sha === 'string') held.add(e.sha);
      }
    }
    /** @type {Array<{ path: string, mode: string, type: string, sha: string }>} */
    const tree = [];
    let seeded = false;
    for (const [path, bytes] of Object.entries(files)) {
      const id = gitBlobId(bytes);
      if (held.has(id)) {
        tree.push({ path, mode: '100644', type: 'blob', sha: id });
        continue;
      }
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
 * row: an archive is pushed AS the person who started the session. On a vault
 * box a session started on the box itself is the operator's, a named person
 * whose vault gives this box their GitHub (vault-store.js, vaultHolder).
 *
 * @param {import('../config.js').Config} cfg @param {string|null|undefined} owner @param {string} repo
 * @param {{ broker?: string }} [opts]
 * @returns {Promise<{ token: string } | { token: null, why: string }>}
 */
export async function ownerToken(cfg, owner, repo, { broker = process.env.FLEETWRIGHT_RUNNER_BROKER || '' } = {}) {
  const holder = vaultHolder(cfg, owner);
  if (!holder) return { token: null, why: 'nobody signed in started it, so there is no one to push as' };
  if (!holder.email) return { token: null, why: operatorAccount(cfg).why };
  // FROM THEIR VAULT, as everything of a fleet person's is (vault-store.js).
  const own = vaultToken(cfg, holder.email, 'github');
  if (own) return { token: own };
  if (broker) {
    const minted = await runnerToken(broker, repo);
    if (minted) return { token: minted };
    return { token: null, why: 'this runner could not be given a token for it — the fleet’s events say why' };
  }
  return { token: null, why: 'its owner’s vault gives this box no GitHub sign-in' };
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
  // ONE PUSH PER SESSION AT A TIME. Two would both read the same branch head,
  // and the second to move it would be refused as not a fast-forward. A stop
  // that arrives during a pause's push waits for it, because the stop is the
  // last chance and must not be the one dropped.
  while (pushing.has(name)) {
    if (reason === 'pause' || reason === 'checkpoint') return { ok: true, skipped: true, text: 'already being pushed' };
    await pushing.get(name);
  }
  /** @type {() => void} */
  let done = () => {};
  pushing.set(name, new Promise((resolve) => { done = () => resolve(undefined); }));
  try {
    return await archiveOnce({ cfg, registry, rec, repo, name, reason, fetchImpl, now, broker });
  } finally {
    pushing.delete(name);
    done();
  }
}

/** Sessions with a push under way, and the promise that settles when it ends. */
/** @type {Map<string, Promise<unknown>>} */
const pushing = new Map();

/** The reasons a session is not coming back from, which put it in the index. */
const ENDINGS = new Set(['stop', 'forget', 'purge', 'shutdown']);

/**
 * @param {{ cfg: import('../config.js').Config, registry: import('./registry.js').Registry,
 *   rec: import('./registry.js').SessionRecord, repo: string, name: string, reason: string,
 *   fetchImpl: typeof globalThis.fetch, now: () => number, broker?: string }} args
 * @returns {Promise<{ ok: boolean, text: string, skipped?: boolean }>}
 */
async function archiveOnce({ cfg, registry, rec, repo, name, reason, fetchImpl, now, broker }) {
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
    transcript: await collectTranscript(cfg, rec),
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
  if (!pushed.ok) return note({ ok: false, text: `Not archived to ${repo}: ${pushed.text}` });
  // THE TABLE OF CONTENTS, when it ends: one line on the default branch per
  // session. Never the session's files — every branch has the same names at
  // its top, and a main that took them all would grow by every transcript.
  if (ENDINGS.has(reason)) {
    const indexed = await updateIndex({ repo, token: cred.token, branch, line: indexLine(rec, host, at, branch), fetchImpl });
    if (!indexed.ok) log.warn(`archive: ${name} → ${repo} INDEX.md: ${indexed.text}`);
  }
  return note({ ok: true, commit: pushed.commit, text: pushed.unchanged ? pushed.text : `Archived to ${repo} on ${branch}.` });
}

/**
 * A session's line in INDEX.md. The title is the session's, so it is held to
 * one line with nothing Markdown would read as a link or emphasis.
 *
 * @param {import('./registry.js').SessionRecord} rec @param {string} host @param {number} at @param {string} branch
 */
export function indexLine(rec, host, at, branch) {
  const title = String(rec.title || rec.name).replace(/[\s]+/g, ' ').replace(/[[\]()<>*_`|\\#!]/g, '').trim().slice(0, 80) || rec.name;
  const when = new Date(Number(rec.createdAt) || at).toISOString().slice(0, 16).replace('T', ' ');
  const link = branch.split('/').map(encodeURIComponent).join('/');
  return `- ${when} UTC · ${title} · \`${host}\` · [${rec.name}](../../tree/${link})`;
}

const INDEX_HEAD = '# Sessions\n\nOne line per session, newest first. Each links to its branch, where the session is.\n\n';

/**
 * Put a session's line at the top of INDEX.md on the default branch, or
 * replace the line it already has there (a resumed session ends again). Retried
 * on a conflict, because two sessions ending together both write this file.
 * NEVER THROWS, and never blocks the archive it follows: the branch is the
 * record, this is only the way to find it.
 *
 * @param {{ repo: string, token: string, branch: string, line: string, fetchImpl?: typeof globalThis.fetch }} args
 * @returns {Promise<{ ok: boolean, text: string }>}
 */
export async function updateIndex({ repo, token, branch, line, fetchImpl = fetch }) {
  const url = `https://api.github.com/repos/${repo}/contents/INDEX.md`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'fleetwright',
  };
  const mark = `(../../tree/${branch.split('/').map(encodeURIComponent).join('/')})`;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const got = await fetchImpl(url, { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
      if (!got.ok && got.status !== 404) return { ok: false, text: `GitHub answered ${got.status} reading it` };
      const now = got.ok ? /** @type {any} */ (await got.json()) : null;
      const text = now ? Buffer.from(String(now.content || ''), 'base64').toString('utf8') : INDEX_HEAD;
      const lines = text.split('\n').filter((l) => !l.endsWith(mark));
      const at = lines.findIndex((l) => l.startsWith('- '));
      const body = at === -1
        ? `${lines.join('\n').replace(/\n*$/, '\n\n')}${line}\n`
        : [...lines.slice(0, at), line, ...lines.slice(at)].join('\n');
      const put = await fetchImpl(url, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ message: `INDEX: ${line.slice(2, 120)}`, content: Buffer.from(body).toString('base64'), ...(now?.sha ? { sha: now.sha } : {}) }),
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
      if (put.ok) return { ok: true, text: 'indexed' };
      if (put.status !== 409 && put.status !== 422) return { ok: false, text: `GitHub answered ${put.status} writing it` };
    }
    return { ok: false, text: 'it kept changing under this write' };
  } catch (e) {
    return { ok: false, text: `could not reach GitHub: ${/** @type {Error} */ (e).message}` };
  }
}

/** The least time between two pushes of one session for coming back to its prompt. */
export const PAUSE_GAP_MS = 60_000;

/**
 * Pushes a session each time it comes back to its prompt, at most once a
 * PAUSE_GAP_MS: a turn that ends inside the gap is pushed when the gap is
 * over, once, however many ended in it. That is the live copy — a session
 * answering every few seconds is a commit a minute, not one per answer — and
 * the ten-minute checkpoint stays behind it for a session that works for an
 * hour without stopping.
 */
export class ArchivePacer {
  /**
   * @param {{ push: (name: string) => unknown, gapMs?: number, now?: () => number,
   *   later?: (fn: () => void, ms: number) => unknown }} opts
   */
  constructor({ push, gapMs = PAUSE_GAP_MS, now = () => Date.now(), later = (fn, ms) => setTimeout(fn, ms).unref?.() }) {
    this.push = push;
    this.gapMs = gapMs;
    this.now = now;
    this.later = later;
    /** @type {Map<string, number>} */
    this.last = new Map();
    /** @type {Set<string>} */
    this.waiting = new Set();
  }

  /** @param {string} name */
  poke(name) {
    if (this.waiting.has(name)) return;
    const wait = (this.last.get(name) ?? -Infinity) + this.gapMs - this.now();
    if (wait <= 0) return this.#run(name);
    this.waiting.add(name);
    this.later(() => this.#run(name), wait);
  }

  /** @param {string} name */
  forget(name) {
    this.last.delete(name);
    this.waiting.delete(name);
  }

  /** @param {string} name */
  #run(name) {
    this.waiting.delete(name);
    this.last.set(name, this.now());
    void this.push(name);
  }
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
