// The workspace, readable and writable from a phone.
//
// ROADMAP called this "deliberately last — largest new attack surface in the
// product", and that is still the right description. This file is mostly the
// design pass it asked for; docs/filesystem.md is the prose version.
//
// WHAT A SESSION'S FILES ACTUALLY ARE. Not a directory on the host: a named
// podman volume, `work-<session>`, mounted at /work inside the container. There
// is no path on the box to readdir. Every operation here therefore runs a
// short-lived container over that one volume — the same shape podman.js already
// uses to seed credentials — which is a cost and also the confinement: a
// container mounting exactly one volume cannot read anything else.
//
// THE CONVERSATION VOLUME IS NEVER MOUNTED. `claude-<session>` holds the Claude
// credential the session runs as. It is a sibling of the volume this reads, it
// is one word away in sandboxNames(), and mounting it would hand a file browser
// the account. Nothing here takes a volume name as a parameter for that reason:
// the caller names a SESSION and this derives the rest.
//
// THREE THINGS BOUND WHAT A CALLER CAN DO, and they are deliberately redundant,
// because the interesting failures here are the ones where one check was
// thought to cover another:
//
//   1. The path is validated in JS before it reaches a container at all.
//   2. The container re-derives it with realpath and refuses anything that does
//      not land under /work — which is what catches a SYMLINK, the case textual
//      validation cannot see.
//   3. Reads mount :ro. A read path that somehow found a way to write would
//      still be writing to a read-only mount.
//
// Sizes are bounded everywhere. A phone asking for a directory listing must not
// be able to ask for a million entries, and "read a file" must not mean "read
// the 8GB core dump a crashed session left behind".

import { isValidName } from './names.js';
import { podman, sandboxNames, podmanAvailable } from './podman.js';

/** Bytes of a file this will return. Generous for source, refuses a blob. */
export const MAX_READ_BYTES = 256 * 1024;
/** Bytes a caller may write. The same number, for the same reason. */
export const MAX_WRITE_BYTES = 256 * 1024;
/** Entries in one listing. A directory bigger than this is paged by path. */
export const MAX_ENTRIES = 500;
/** Characters of path. Long enough for real trees, short enough to bound. */
export const MAX_PATH = 512;

/**
 * How long any single file operation may take.
 *
 * A container start is the cost here, not the work. Ten seconds is generous for
 * both and short enough that a stuck podman does not hold a phone's request
 * open until the coordinator's own timeout fires.
 */
const TIMEOUT_MS = 10_000;

/**
 * The confinement preamble, run inside the container before anything else.
 *
 * `$1` is the caller's path, passed as an ARGUMENT rather than interpolated —
 * a path containing `;` or `$(...)` is a filename, not a command, and the only
 * way to keep it that way is never to build a command string out of it.
 *
 * realpath -m resolves without requiring existence, so `write` can create a new
 * file while still being checked. The prefix test after it is what catches a
 * symlink pointing out of the workspace: textual validation cannot see through
 * a link, and this does not have to.
 */
const CONFINE = `
p="\${1:-.}"
case "$p" in
  /*) echo "refused: an absolute path is not inside the workspace" >&2; exit 3 ;;
  ..|../*|*/..|*/../*) echo "refused: .. does not go anywhere useful here" >&2; exit 3 ;;
esac
t=$(realpath -m "/work/$p") || { echo "refused: that path cannot be resolved" >&2; exit 3; }
case "$t" in
  /work|/work/*) ;;
  *) echo "refused: that path leaves the workspace" >&2; exit 3 ;;
esac
`;

/**
 * Validate a path before it is worth starting a container for.
 *
 * The container checks again — this is the cheap half, and it exists so that an
 * obviously bad path costs nothing and produces a message that says why.
 *
 * @param {string} p
 * @returns {{ ok: true, path: string } | { ok: false, text: string }}
 */
export function checkPath(p) {
  const path = String(p ?? '').trim();
  if (path.length > MAX_PATH) return { ok: false, text: `That path is longer than ${MAX_PATH} characters.` };
  // A NUL truncates the path for anything written in C, so what gets checked
  // and what gets opened would be different strings.
  if (path.includes('\0')) return { ok: false, text: 'That path contains a null byte.' };
  if (path.startsWith('/')) {
    return { ok: false, text: 'Paths are relative to the session workspace, so they cannot start with "/".' };
  }
  if (path === '..' || path.startsWith('../') || path.endsWith('/..') || path.includes('/../')) {
    return { ok: false, text: 'A path with ".." in it is refused: there is nothing above the workspace to reach.' };
  }
  return { ok: true, path: path || '.' };
}

/**
 * Run one confined operation over a session's workspace volume.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name       the session
 * @param {string} script     shell run after CONFINE, with `$t` as the resolved path
 * @param {string[]} args     `$1` is the caller's path
 * @param {{ write?: boolean, stdin?: string }} [opts]
 */
function run(cfg, name, script, args, { write = false, stdin } = {}) {
  const { work } = sandboxNames(name);
  const r = podman(
    cfg,
    [
      'run',
      '--rm',
      '-i',
      // NOTHING ELSE IS MOUNTED, and :ro unless this is a write. The
      // conversation volume — which holds the Claude credential — is a sibling
      // of this one and is deliberately absent.
      '-v',
      `${work}:/work${write ? '' : ':ro'}`,
      // No network. A file browser has no reason to reach anything, and a
      // container that cannot dial out cannot exfiltrate what it just read.
      '--network',
      'none',
      cfg.sandboxImage,
      'sh',
      '-c',
      CONFINE + script,
      'sh',
      ...args,
    ],
    { timeout: TIMEOUT_MS, ...(stdin === undefined ? {} : { input: stdin }) },
  );
  return r;
}

/**
 * List one directory.
 *
 * ONE DIRECTORY, NOT A TREE. A recursive listing of a repository is tens of
 * thousands of entries, most of them in .git and node_modules, and a phone
 * asking "what is in here" wants the answer for here. Depth is the caller's to
 * spend, one tap at a time.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @param {string} dir
 * @returns {{ ok: boolean, text: string, entries?: Array<{ name: string, kind: string, size: number }> }}
 */
export function listFiles(cfg, name, dir = '.') {
  const guard = precheck(cfg, name, dir);
  if (guard) return guard;

  // -printf is GNU find, which debian:13-slim has. The separator is a tab
  // because a filename may contain almost anything else, including a newline —
  // which is why the name comes LAST on each line and is never split on.
  const script = `
cd "$t" 2>/dev/null || { echo "no such directory" >&2; exit 4; }
[ -d "$t" ] || { echo "not a directory" >&2; exit 4; }
find . -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%f\\n' 2>/dev/null | sort -t'\\t' -k1,1r -k3,3f | head -n ${MAX_ENTRIES}
`;
  const r = run(cfg, name, script, [dir]);
  if (r.status !== 0) return { ok: false, text: refusalFor(r, dir) };

  const entries = r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [kind, size, ...rest] = line.split('\t');
      return { name: rest.join('\t'), kind: kindOf(kind), size: Number(size) || 0 };
    })
    .filter((e) => e.name);

  const shown = entries.length;
  const text = shown
    ? entries.map((e) => `${e.kind === 'dir' ? '📁' : '📄'} ${e.name}${e.kind === 'file' ? `  ${human(e.size)}` : ''}`).join('\n') +
      (shown >= MAX_ENTRIES ? `\n\n(first ${MAX_ENTRIES} — this directory has more)` : '')
    : '(empty)';
  return { ok: true, text, entries };
}

/**
 * Read one file.
 *
 * TEXT ONLY, and it says so rather than returning a screenful of control
 * characters. A caller asking for a JPEG has asked the wrong question, and
 * answering it with bytes that reprogram their terminal is not a better answer.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @param {string} file
 */
export function readFile(cfg, name, file) {
  const guard = precheck(cfg, name, file);
  if (guard) return guard;

  const script = `
[ -f "$t" ] || { echo "not a file" >&2; exit 4; }
size=$(stat -c %s "$t")
if [ "$size" -gt ${MAX_READ_BYTES} ]; then echo "too big: $size" >&2; exit 5; fi
# A NUL in the first 8k means binary. grep is doing the classification, which is
# what it is for, rather than a heuristic written here.
if head -c 8192 "$t" | grep -qP '\\x00' 2>/dev/null; then echo "binary" >&2; exit 6; fi
cat "$t"
`;
  const r = run(cfg, name, script, [file]);
  if (r.status === 5) {
    const size = /too big: (\d+)/.exec(r.stderr)?.[1];
    return {
      ok: false,
      text: `${file} is ${human(Number(size))}, and this reads at most ${human(MAX_READ_BYTES)}. Ask a session to summarise it instead.`,
    };
  }
  if (r.status === 6) {
    return { ok: false, text: `${file} is not text. There is nothing useful to show, and showing it would be worse than nothing.` };
  }
  if (r.status !== 0) return { ok: false, text: refusalFor(r, file) };
  return { ok: true, text: r.stdout };
}

/**
 * Write one file, creating it if it does not exist.
 *
 * THE CONTENT TRAVELS ON STDIN, not in the command. It is arbitrary text from a
 * caller and the one thing that must never be parsed as shell.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @param {string} file
 * @param {string} content
 */
export function writeFile(cfg, name, file, content) {
  const guard = precheck(cfg, name, file);
  if (guard) return guard;
  const body = String(content ?? '');
  if (Buffer.byteLength(body) > MAX_WRITE_BYTES) {
    return { ok: false, text: `That is larger than ${human(MAX_WRITE_BYTES)}, which is the most this will write.` };
  }

  const script = `
case "$t" in /work) echo "refused: that is the workspace itself" >&2; exit 3 ;; esac
[ -d "$t" ] && { echo "is a directory" >&2; exit 4; }
mkdir -p "$(dirname "$t")" || exit 4
cat > "$t"
`;
  const r = run(cfg, name, script, [file], { write: true, stdin: body });
  if (r.status !== 0) return { ok: false, text: refusalFor(r, file) };
  return { ok: true, text: `Wrote ${human(Buffer.byteLength(body))} to ${file}.` };
}

/**
 * Copy a file or directory within the workspace.
 *
 * BOTH ENDS ARE CONFINED. The destination goes through the same resolution as
 * the source — a copy is a write, and a write that lands outside is the same
 * problem as a read that starts outside.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @param {string} from
 * @param {string} to
 */
export function copyFile(cfg, name, from, to) {
  const guard = precheck(cfg, name, from);
  if (guard) return guard;
  const dest = checkPath(to);
  if (!dest.ok) return { ok: false, text: dest.text };

  const script = `
src="$t"
[ -e "$src" ] || { echo "no such file" >&2; exit 4; }
d="$2"
case "$d" in
  /*) echo "refused: an absolute path is not inside the workspace" >&2; exit 3 ;;
  ..|../*|*/..|*/../*) echo "refused: .. does not go anywhere useful here" >&2; exit 3 ;;
esac
dt=$(realpath -m "/work/$d") || exit 3
case "$dt" in /work/*) ;; *) echo "refused: the destination leaves the workspace" >&2; exit 3 ;; esac
mkdir -p "$(dirname "$dt")" || exit 4
cp -R "$src" "$dt"
`;
  const r = run(cfg, name, script, [from, dest.path], { write: true });
  if (r.status !== 0) return { ok: false, text: refusalFor(r, from) };
  return { ok: true, text: `Copied ${from} to ${to}.` };
}

/**
 * Delete a file or directory.
 *
 * THE WORKSPACE ITSELF IS NOT DELETABLE. `delete .` would empty the session's
 * work with one tap and no undo, which is what `forget` is for — and `forget`
 * is recoverable for seven days while this is not.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @param {string} target
 */
export function deleteFile(cfg, name, target) {
  const guard = precheck(cfg, name, target);
  if (guard) return guard;

  const script = `
case "$t" in /work) echo "refused: root" >&2; exit 3 ;; esac
[ -e "$t" ] || { echo "no such file" >&2; exit 4; }
rm -rf "$t"
`;
  const r = run(cfg, name, script, [target], { write: true });
  if (r.status === 3 && /refused: root/.test(r.stderr)) {
    return {
      ok: false,
      text: 'That would delete the whole workspace. `forget` does that, keeps it for seven days, and can be undone; this cannot.',
    };
  }
  if (r.status !== 0) return { ok: false, text: refusalFor(r, target) };
  return { ok: true, text: `Deleted ${target}.` };
}

// --- shared -----------------------------------------------------------------

/**
 * The checks every operation makes before it is worth starting a container.
 * @param {import('../config.js').Config} cfg @param {string} name @param {string} p
 */
function precheck(cfg, name, p) {
  if (!isValidName(name)) return { ok: false, text: `"${name}" is not a valid session name.` };
  const checked = checkPath(p);
  if (!checked.ok) return { ok: false, text: checked.text };
  if (!podmanAvailable(cfg)) {
    // A session that never ran sandboxed has no volume to browse, and saying
    // "no such directory" would send somebody looking for a path.
    return { ok: false, text: 'This host has no podman, so sessions here have no workspace volume to browse.' };
  }
  return null;
}

/** @param {{ status: number, stderr: string }} r @param {string} p */
function refusalFor(r, p) {
  const said = r.stderr.trim().split('\n').filter(Boolean).pop() || '';
  if (/^refused: /.test(said)) return said.replace(/^refused: /, '');
  if (/no such (file|directory)/i.test(said)) return `There is no ${p} in this session's workspace.`;
  if (/not a directory/i.test(said)) return `${p} is a file, not a directory.`;
  if (/is a directory/i.test(said)) return `${p} is a directory, not a file.`;
  if (/no such volume|not exist/i.test(said)) {
    return 'That session has no workspace — it may never have started, or it may have been forgotten.';
  }
  return said || `Could not read ${p}.`;
}

/** @param {string} c find's %y */
function kindOf(c) {
  if (c === 'd') return 'dir';
  if (c === 'l') return 'link';
  return 'file';
}

/** @param {number} n */
function human(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}
