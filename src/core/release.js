// Updating from a release, rather than by pulling a git repository.
//
// The git path stays and is still the fallback — see docs/packaging.md, which
// argues that order: one box at a time, and the fallback is what makes moving
// a box safe. This is the other half.
//
// WHAT AN UPDATE HAS TO GET RIGHT, in the order the failures actually happen:
//
//   1. NOT UPDATING WHEN IT SHOULD NOT. A release built for a different
//      protocol version strands this host from its coordinator, and it strands
//      it AFTER the update, when it can no longer say so. The manifest carries
//      the protocol so the flag day is visible before it is crossed.
//   2. NOT INSTALLING SOMETHING ELSE. The digest is checked against the bytes
//      that arrived, before anything is unpacked — not after, and not against
//      a length.
//   3. LEAVING A BOX THAT WORKS. Releases unpack BESIDE the running one and a
//      symlink moves. A failed download changes nothing; a rollback is one
//      symlink; and the previous release is still on disk to roll back to.
//
// None of that is novel. What is easy to get wrong is doing them in a different
// order — verifying after unpacking, or swapping before verifying — and each
// wrong order is a box somebody has to drive to.

import { createHash } from 'node:crypto';

/** Where a release is unpacked, relative to the install root's parent. */
export const RELEASES_DIR = 'releases';

/** The symlink that says which release is live. */
export const CURRENT_LINK = 'current';

/**
 * @typedef {object} Manifest
 * @property {string} version
 * @property {string} file
 * @property {string} sha256
 * @property {number} [bytes]
 * @property {number} [protocol]
 * @property {string|null} [sandboxImage]
 */

/**
 * Is this manifest usable, and is it worth acting on?
 *
 * Pure. The whole decision lives here so it can be tested without a network,
 * a filesystem or a running host — the parts that go wrong are the judgements,
 * not the download.
 *
 * @param {object} q
 * @param {unknown} q.manifest        whatever the URL returned
 * @param {string} q.installed        the version running now
 * @param {number} q.protocol         the protocol THIS build speaks
 * @returns {{ act: false, reason: string, message: string } | { act: true, manifest: Manifest, message: string }}
 */
export function decideRelease({ manifest, installed, protocol }) {
  const m = /** @type {any} */ (manifest);
  if (!m || typeof m !== 'object') {
    return { act: false, reason: 'unreadable', message: 'the release manifest was not an object' };
  }
  for (const field of ['version', 'file', 'sha256']) {
    if (typeof m[field] !== 'string' || !m[field]) {
      return { act: false, reason: 'unreadable', message: `the release manifest has no ${field}` };
    }
  }
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) {
    return { act: false, reason: 'unreadable', message: 'the release manifest\'s sha256 is not a sha256' };
  }
  // A filename becomes a path. This is the one field an attacker controls that
  // ends up on the filesystem, so it is a name and never a route to one.
  if (!/^[A-Za-z0-9._-]+$/.test(m.file) || m.file.startsWith('.')) {
    return { act: false, reason: 'unreadable', message: `the release filename is not a plain name: ${m.file.slice(0, 60)}` };
  }

  // BEFORE the version comparison, deliberately. A host one protocol behind
  // must be told that, not told it is up to date — those are opposite
  // instructions to whoever is reading.
  if (typeof m.protocol === 'number' && m.protocol !== protocol) {
    return {
      act: false,
      reason: 'protocol',
      message:
        `That release speaks protocol ${m.protocol} and this host speaks ${protocol}.\n` +
        'Updating would disconnect it from its coordinator, and it could not tell you afterwards.\n' +
        'Update the coordinator first, then this host.',
    };
  }

  if (m.version === installed) {
    return { act: false, reason: 'current', message: `already on ${installed}` };
  }

  return { act: true, manifest: m, message: `${installed} → ${m.version}` };
}

/**
 * Do the bytes match what the manifest promised?
 *
 * Separate from the download on purpose: this is the check, and a check that
 * lives inside the thing it checks is a check somebody can skip by calling the
 * other function.
 *
 * @param {Uint8Array} bytes
 * @param {Manifest} manifest
 * @returns {{ ok: boolean, message: string }}
 */
export function verifyDownload(bytes, manifest) {
  if (typeof manifest.bytes === 'number' && bytes.length !== manifest.bytes) {
    return {
      ok: false,
      message: `the download is ${bytes.length} bytes and the manifest says ${manifest.bytes} — refusing it`,
    };
  }
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== manifest.sha256) {
    // BOTH DIGESTS, because the useful next question is "which one is wrong",
    // and somebody comparing them by eye needs both in front of them.
    return {
      ok: false,
      message: `digest mismatch — refusing it\n  expected ${manifest.sha256}\n  got      ${got}`,
    };
  }
  return { ok: true, message: `sha256 ${got.slice(0, 16)}… verified` };
}

/**
 * Where the manifest lives, and where a file in it lives.
 *
 * Relative to the MANIFEST's own URL rather than configured separately: one
 * setting cannot then point at another deployment's tarball, and moving a
 * release host is one value instead of two that must agree.
 *
 * @param {string} manifestUrl
 * @param {string} file
 */
export function fileUrl(manifestUrl, file) {
  return new URL(file, manifestUrl).toString();
}

/**
 * Where a release lives once it is installed.
 *
 * The layout is the rollback:
 *
 *   /opt/fleetwright/releases/main-41/    the one before
 *   /opt/fleetwright/releases/main-42/    unpacked, verified, complete
 *   /opt/fleetwright/current -> releases/main-42
 *
 * A failed download changes nothing, because nothing has moved. A failed
 * release is one symlink back, because the previous tree is still there. And
 * the unit files point at `current`, so the swap needs no daemon-reload and no
 * edit to anything root owns.
 *
 * @param {string} base  e.g. /opt/fleetwright
 * @param {string} version
 */
export function releasePaths(base, version) {
  return {
    dir: `${base}/${RELEASES_DIR}/${version}`,
    link: `${base}/${CURRENT_LINK}`,
    staging: `${base}/${RELEASES_DIR}/.incoming-${version}`,
  };
}

/**
 * Releases that can be removed.
 *
 * Keeps the live one and the one before it, because "the one before" is what a
 * rollback needs and a rollback target that was tidied away is not one. Older
 * than that is disk somebody is paying for to hold a version nobody will choose.
 *
 * @param {string[]} present   directory names under releases/
 * @param {string} live        the version `current` points at
 * @param {string|null} previous
 * @returns {string[]}
 */
export function releasesToPrune(present, live, previous = null) {
  const keep = new Set([live, previous].filter(Boolean));
  // Anything half-unpacked is not a release and is always removable — it is
  // the debris of an interrupted update, and keeping it would make the next
  // one refuse a directory that already exists.
  return present.filter((v) => v.startsWith('.incoming-') || !keep.has(v));
}
