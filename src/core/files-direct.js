// The workspace of a session that runs directly on the box, not in a container.
//
// A Mac has no podman, and neither does a box set up without the sandbox, so
// files.js answered every one of their sessions with "This host has no podman"
// — and a GitHub macOS runner, where the only way to get anything back out of
// a session is to read it, had no way to read it. The workspace there is not a
// volume: it is a directory on the box, the session's own working directory,
// and this reads it with the same five operations and the same bounds.
//
// THE SAME THREE LAYERS, in JS instead of a container:
//
//   1. checkPath (files.js) refuses an absolute path, `..` and a NUL first.
//   2. The target is resolved with realpath — the nearest part of it that
//      exists, for a write — and refused unless it lands under the session's
//      directory. That is what catches a symlink pointing out.
//   3. Instead of a read-only mount, nothing here writes unless the operation
//      is a write.
//
// AND ONE MORE THAT A CONTAINER DID NOT NEED. A volume holds one session's
// work and nothing else; a directory on the box can hold anything, and the
// working directory is the box owner's to choose. If it were the home
// directory, fleetwright's own state would be under it — every person's
// session credentials (`direct/<name>/.credentials.json`) and the vault. A
// session can read its own files already; nobody can read another person's
// login through this. So the state directory and the secrets directory are
// refused wherever they turn up, and left out of listings.
//
// What this does not add: a session running directly already has a shell on
// this box as this user. Whoever can reach its files here could already reach
// them through it. The line drawn above is the one that is not true of: the
// fleet's own state.

import {
  realpathSync, existsSync, lstatSync, statSync, readdirSync, openSync, readSync, closeSync,
  readFileSync, writeFileSync, mkdirSync, cpSync, rmSync,
} from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{ ok: boolean, text: string, entries?: Array<{ name: string, kind: string, size: number }> }} Answer
 * @typedef {{ maxRead: number, maxWrite: number, maxEntries: number, human: (n: number) => string }} Bounds
 */

/** @param {string} p @param {string} root */
function inside(p, root) {
  return p === root || p.startsWith(root + path.sep);
}

/**
 * The directories nobody reaches through a workspace, by their real paths.
 * @param {import('../config.js').Config} cfg
 */
function forbidden(cfg) {
  /** @type {string[]} */
  const out = [];
  for (const dir of [cfg.stateDir, /** @type {any} */ (cfg).secretsDir]) {
    if (!dir) continue;
    try {
      out.push(realpathSync(dir));
    } catch {
      out.push(path.resolve(dir));
    }
  }
  return out;
}

/**
 * Resolve a caller's path against the session's directory, or say why not.
 *
 * `mustExist` false is a write: realpath the deepest part that exists and
 * check THAT, so a new file under a symlinked directory is judged by where the
 * link goes rather than by its name.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} root the session's working directory
 * @param {string} p    already through checkPath
 * @param {{ mustExist?: boolean }} [opts]
 * @returns {{ ok: true, target: string, root: string } | { ok: false, text: string }}
 */
export function confine(cfg, root, p, { mustExist = true } = {}) {
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, text: "That session's working directory is gone from this box." };
  }
  const wanted = path.resolve(realRoot, p);
  let probe = wanted;
  let tail = '';
  while (!existsSync(probe)) {
    if (mustExist) return { ok: false, text: `There is no ${p} in this session's workspace.` };
    const up = path.dirname(probe);
    if (up === probe) break;
    tail = tail ? path.join(path.basename(probe), tail) : path.basename(probe);
    probe = up;
  }
  let real;
  try {
    real = path.join(realpathSync(probe), tail);
  } catch {
    return { ok: false, text: 'that path cannot be resolved' };
  }
  if (!inside(real, realRoot)) return { ok: false, text: 'that path leaves the workspace' };
  // Inside the state, or holding it — a copy or a delete of a folder that has
  // the state in it reaches the state just as surely. The workspace root is
  // the one exception to the second: it may hold it, and its listing leaves
  // the entry out (listDirect).
  for (const no of forbidden(cfg)) {
    if (inside(real, no) || (real !== realRoot && inside(no, real))) {
      return { ok: false, text: "that is fleetwright's own state, which holds other people's logins, and it is not part of any workspace" };
    }
  }
  return { ok: true, target: real, root: realRoot };
}

/** @param {import('node:fs').Stats} st */
function kindOf(st) {
  if (st.isSymbolicLink()) return 'link';
  if (st.isDirectory()) return 'dir';
  return 'file';
}

/**
 * @param {import('../config.js').Config} cfg @param {string} root @param {string} dir @param {Bounds} b
 * @returns {Answer}
 */
export function listDirect(cfg, root, dir, b) {
  const c = confine(cfg, root, dir);
  if (!c.ok) return { ok: false, text: c.text };
  let names;
  try {
    if (!statSync(c.target).isDirectory()) return { ok: false, text: `${dir} is a file, not a directory.` };
    names = readdirSync(c.target);
  } catch (e) {
    return { ok: false, text: `Could not list ${dir}: ${/** @type {Error} */ (e).message}` };
  }
  const no = forbidden(cfg);
  const entries = [];
  for (const name of names) {
    const full = path.join(c.target, name);
    // Left out, not shown and refused: a listing that offers a folder and then
    // refuses it is a button that does not work.
    if (no.some((d) => inside(d, full))) continue;
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    entries.push({ name, kind: kindOf(st), size: st.isFile() ? st.size : 0 });
  }
  // Directories first, then by name without case — the order the container's
  // `sort -k1,1 -k3,3f` gives, so a phone sees the same list either way.
  const rank = (/** @type {string} */ k) => (k === 'dir' ? 0 : k === 'file' ? 1 : 2);
  entries.sort((x, y) => rank(x.kind) - rank(y.kind) || x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
  const shown = entries.slice(0, b.maxEntries);
  const text = shown.length
    ? shown.map((e) => `${e.kind === 'dir' ? '📁' : '📄'} ${e.name}${e.kind === 'file' ? `  ${b.human(e.size)}` : ''}`).join('\n') +
      (entries.length > b.maxEntries ? `\n\n(first ${b.maxEntries} — this directory has more)` : '')
    : `${dir === '.' ? 'The workspace' : dir} exists and has nothing in it.`;
  return { ok: true, text, entries: shown };
}

/**
 * @param {import('../config.js').Config} cfg @param {string} root @param {string} file @param {Bounds} b
 * @returns {Answer}
 */
export function readDirect(cfg, root, file, b) {
  const c = confine(cfg, root, file);
  if (!c.ok) return { ok: false, text: c.text };
  let st;
  try {
    st = statSync(c.target);
  } catch (e) {
    return { ok: false, text: `Could not read ${file}: ${/** @type {Error} */ (e).message}` };
  }
  if (st.isDirectory()) return { ok: false, text: `${file} is a directory, not a file.` };
  if (!st.isFile()) return { ok: false, text: `${file} is not a regular file.` };
  if (st.size > b.maxRead) {
    return { ok: false, text: `${file} is ${b.human(st.size)}, and this reads at most ${b.human(b.maxRead)}. Ask a session to summarise it instead.` };
  }
  // A NUL in the first 8k means binary, as in the container.
  const head = Buffer.alloc(Math.min(8192, st.size));
  const fd = openSync(c.target, 'r');
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  if (head.includes(0)) {
    return { ok: false, text: `${file} is not text. There is nothing useful to show, and showing it would be worse than nothing.` };
  }
  return { ok: true, text: readFileSync(c.target, 'utf8') };
}

/**
 * @param {import('../config.js').Config} cfg @param {string} root @param {string} file @param {string} body @param {Bounds} b
 * @returns {Answer}
 */
export function writeDirect(cfg, root, file, body, b) {
  const c = confine(cfg, root, file, { mustExist: false });
  if (!c.ok) return { ok: false, text: c.text };
  if (c.target === c.root) return { ok: false, text: 'that is the workspace itself' };
  if (existsSync(c.target) && statSync(c.target).isDirectory()) return { ok: false, text: `${file} is a directory, not a file.` };
  try {
    mkdirSync(path.dirname(c.target), { recursive: true });
    writeFileSync(c.target, body);
  } catch (e) {
    return { ok: false, text: `Could not write ${file}: ${/** @type {Error} */ (e).message}` };
  }
  return { ok: true, text: `Wrote ${b.human(Buffer.byteLength(body))} to ${file}.` };
}

/**
 * @param {import('../config.js').Config} cfg @param {string} root @param {string} from @param {string} to
 * @returns {Answer}
 */
export function copyDirect(cfg, root, from, to) {
  const src = confine(cfg, root, from);
  if (!src.ok) return { ok: false, text: src.text };
  const dest = confine(cfg, root, to, { mustExist: false });
  if (!dest.ok) return { ok: false, text: dest.text.replace('that path', 'the destination') };
  if (dest.target === dest.root) return { ok: false, text: 'the destination is the workspace itself' };
  try {
    mkdirSync(path.dirname(dest.target), { recursive: true });
    cpSync(src.target, dest.target, { recursive: true, errorOnExist: false, force: true });
  } catch (e) {
    return { ok: false, text: `Could not copy ${from}: ${/** @type {Error} */ (e).message}` };
  }
  return { ok: true, text: `Copied ${from} to ${to}.` };
}

/**
 * @param {import('../config.js').Config} cfg @param {string} root @param {string} target
 * @returns {Answer}
 */
export function deleteDirect(cfg, root, target) {
  const c = confine(cfg, root, target);
  if (!c.ok) return { ok: false, text: c.text };
  if (c.target === c.root) {
    return {
      ok: false,
      text: 'That would delete the whole workspace. `forget` does that, keeps it for seven days, and can be undone; this cannot.',
    };
  }
  try {
    rmSync(c.target, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, text: `Could not delete ${target}: ${/** @type {Error} */ (e).message}` };
  }
  return { ok: true, text: `Deleted ${target}.` };
}
