// Finding the `claude` binary.
//
// This exists because of a trap that costs a confusing hour on a fresh box.
// Claude Code's installer puts the binary in ~/.local/bin and adds that
// directory to ~/.bashrc. Sessions launch through `bash -lc` (a LOGIN,
// non-interactive shell), and Debian's stock ~/.bashrc begins with
//
//     case $- in *i*) ;; *) return;; esac
//
// which returns immediately for a non-interactive shell — so the PATH line
// never runs. The result is a box where `claude` works perfectly when you SSH
// in and type it, and every launched session dies instantly with "session
// exited immediately". Resolving to an absolute path at startup sidesteps
// shell initialisation entirely.

import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Directories the Claude CLI is commonly installed into, beyond $PATH. */
function candidateDirs() {
  const home = os.homedir();
  return [
    path.join(home, '.local', 'bin'), // the official install.sh target
    path.join(home, '.claude', 'local'),
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin', // macOS on Apple silicon
    path.join(home, '.bun', 'bin'),
    path.join(home, '.npm-global', 'bin'),
  ];
}

/** @param {string} p */
function isExecutableFile(p) {
  try {
    const st = statSync(p);
    if (!st.isFile()) return false;
    // Any execute bit — the hub may run as a different user than the owner.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * Resolve a binary name to an absolute path.
 *
 * A name containing a slash is already a path and is returned untouched, so an
 * operator who sets AGENT_HUB_CLAUDE_BIN explicitly always wins. If nothing is
 * found the original name comes back unchanged — the caller's error message
 * ("is claude on PATH?") is more useful than a synthetic one from here.
 *
 * @param {string} name
 * @returns {string}
 */
export function resolveBin(name) {
  if (!name || name.includes('/')) return name;

  const fromPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of [...fromPath, ...candidateDirs()]) {
    const full = path.join(dir, name);
    if (existsSync(full) && isExecutableFile(full)) return full;
  }
  return name;
}
