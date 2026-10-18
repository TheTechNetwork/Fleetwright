// The sidecar's front door on a packaged Linux box: which root-owned copy of
// the release to run.
//
// install.sh copies this to <store>/launch.mjs (/usr/local/lib/fleetwright-
// sidecar by default), root-owned, from the same verified release it copies
// into <store>/releases/<version>/, and the sidecar's unit runs
// `node <store>/launch.mjs`. See refresh_sidecar_store in install.sh for why
// the sidecar no longer runs out of the release tree at all: that tree is the
// service user's, and the sidecar's account holds the host key.
//
// WHY A CHOICE IS NEEDED AT ALL. The store keeps the release root last copied
// and the one before it, and `current` here is the newest. But the hub's
// `current` can move without root: the commit-confirm watchdog (install/
// fleetwright-confirm) points it back at the previous release when an update
// cannot prove itself, and restarts everything onto it. A sidecar pinned to
// the store's newest copy would stay on exactly the release that failed — the
// revert would move the hub and not the sidecar. So this follows the hub's
// `current` WHEN ROOT HAS A COPY OF THAT RELEASE, and the store's newest
// otherwise.
//
// WHAT THE SERVICE USER CAN INFLUENCE through this, stated because it reads a
// file they own: which of the copies root already made runs — at most the
// newest and the one before, both verified. Not what is in them. The version
// is a name checked to be one, and it only ever selects a directory under
// this file's own.
//
// No runtime dependencies and nothing from the release tree, on purpose:
// this is the one file every copy is reached through.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const store = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join('lib', 'fleetwright-sidecar.mjs');

/** The release the hub's `current` holds, or null when it cannot be read as a plain name. */
function hubRelease() {
  const dir = process.env.FLEETWRIGHT_INSTALL_DIR;
  if (!dir) return null;
  try {
    const v = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    // A NAME, NEVER A PATH — the same rule install.sh applied when it named
    // the directory, and release.js before it.
    return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

const want = hubRelease();
const matched = want && existsSync(path.join(store, 'releases', want, ENTRY)) ? path.join(store, 'releases', want) : null;
if (want && !matched) {
  // stderr: stdout is the stdio transport's data channel.
  console.error(
    `fleetwright-sidecar: the hub runs ${want} and root has no copy of it, so this runs the newest copy root made. ` +
      'apt, the one-liner or sudo /usr/local/sbin/fleetwright-migrate brings the sidecar level.',
  );
}
await import(pathToFileURL(path.join(matched ?? path.join(store, 'current'), ENTRY)).href);
