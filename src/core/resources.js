// Where the install lives, found rather than assumed.
//
// Four places computed a path by counting `..` from their own source file:
//
//   config.js    dirname(config.js)/..              -> the install root
//   http.js      dirname(http.js)/../web            -> src/web
//   server.js    ../../../openapi.json              -> openapi.json
//
// Each was correct, and each was correct ONLY for a checkout — the count is a
// statement about how deep that particular file sits in the source tree. Bundle
// the code into one file at a different depth and every one of them silently
// resolves somewhere else. Not to an error: to a path that does not exist, or
// worse, to one that does.
//
// So the root is DISCOVERED: walk up from here to the first directory holding a
// package.json. In a checkout that is the repository root. In a released
// package it is the release directory, which ships a package.json for exactly
// this reason (and so `--version` has something true to say).
//
// The released layout deliberately MIRRORS the repository for everything that
// is not code:
//
//   <root>/package.json
//   <root>/openapi.json
//   <root>/src/web/…          same path as the checkout, so one expression works
//   <root>/lib/agent-hub.mjs  the bundle, which is the only thing that moved
//
// Keeping `src/web` rather than flattening it to `web` costs nothing and means
// no caller needs to know which of the two shapes it is running in.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The install root.
 *
 * Computed once: it cannot change while the process runs, and a released tree
 * is swapped by moving a symlink rather than by editing under a running one.
 */
export const INSTALL_ROOT = findRoot(path.dirname(fileURLToPath(import.meta.url)));

/** @param {string} from */
function findRoot(from) {
  let dir = from;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    // FALL BACK RATHER THAN THROW. This runs at module load, and a throw here
    // takes the whole process down before any logging exists — the failure
    // would be a box that stops starting with no message. Two levels up is what
    // the old code assumed, so the fallback is exactly the previous behaviour.
    if (up === dir) return path.resolve(from, '..', '..');
    dir = up;
  }
}

/**
 * A file that ships with the install.
 *
 * @param {...string} parts  repository-relative, e.g. resource('openapi.json')
 */
export function resource(...parts) {
  return path.join(INSTALL_ROOT, ...parts);
}
