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

/**
 * What may become a path segment.
 *
 * No slash, no backslash, no `..`, and nothing starting with a dot — so the
 * value cannot leave the directory it is joined to, and cannot hide from `ls`
 * once it is there. Applied to BOTH the version and the filename, because both
 * end up on the filesystem and only one of them looks like it would.
 */
const PLAIN_NAME = /^[A-Za-z0-9._-]+$/;

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
 * @property {boolean} [prerelease]  only for hosts that asked for prereleases
 * @property {number} [rollout]      0–1; the fraction of hosts this is for yet
 */

/**
 * Where one host falls in a staged rollout, as a number in [0, 1).
 *
 * FNV-1a, NOT SHA-256, and the difference is worth stating because a hash in a
 * release path invites the assumption that it is a security boundary. It is
 * not: nothing here is a secret, a host that lied about its own name would only
 * change when it updates, and the property actually needed is an even spread
 * that both a Worker and a Node process compute identically without an await.
 * `crypto.subtle` is async and would make this whole decision async, for a
 * guarantee nobody needs.
 *
 * THE VERSION IS IN THE KEY. Hashing the host alone would put the same
 * machines at the front of every rollout for ever — one box would take every
 * risk and another would never see a release until it was already proven.
 * Mixing the version in reshuffles the order per release while staying
 * deterministic WITHIN one: raising a rollout from 0.1 to 0.5 only ever adds
 * hosts, and never takes the release away from a box that already qualified.
 *
 * @param {string} hostKey  stable per machine — the host id, or its hostname
 * @param {string} version
 */
export function rolloutPosition(hostKey, version) {
  const key = `${hostKey}:${version}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    // Math.imul, because `hash * 16777619` overflows a double past 32 bits and
    // stops being the same function on different inputs.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // A FINALISER, and it is not optional — this was written without one and the
  // rollout barely reshuffled between v2.0.0 and v2.0.1: 37 of 38 hosts led
  // both. FNV-1a moves a one-bit input change into the LOW bits of the hash,
  // and the position is the high bits (it divides by 2^32), so two versions
  // differing in their last character produced almost the same ordering — the
  // property this function exists to avoid.
  //
  // MurmurHash3's fmix32, which is exactly the "spread low bits upward" step
  // FNV lacks. Tested by comparing who leads two adjacent versions.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}

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
 * @param {string} [q.channel]        'stable' (default) or 'rolling'
 * @param {string} [q.hostKey]        stable per machine, for staged rollouts
 * @returns {{ act: false, reason: string, message: string } | { act: true, manifest: Manifest, message: string }}
 */
export function decideRelease({ manifest, installed, protocol, channel = 'stable', hostKey = '' }) {
  const m = /** @type {any} */ (manifest);
  if (!m || typeof m !== 'object') {
    return { act: false, reason: 'unreadable', message: 'the release manifest was not an object' };
  }
  for (const field of ['version', 'file', 'sha256']) {
    if (typeof m[field] !== 'string' || !m[field]) {
      return { act: false, reason: 'unreadable', message: `the release manifest has no ${field}` };
    }
  }
  // THE VERSION IS A PATH TOO, and this is the check that was missing while the
  // one below it existed. `file` looks like a filename so it got validated;
  // `version` looks like a label, and then releasePaths turns it into
  // `<base>/releases/<version>` and `<base>/releases/.incoming-<version>`,
  // which are mkdir'd, written to, renamed and symlinked. A version of
  // `../../../../tmp/x` normalises straight out of the releases directory.
  //
  // Validating the field that LOOKS dangerous and missing the one that also
  // becomes a path is the recurring shape here: true where it was written,
  // quietly false one layer up.
  if (!PLAIN_NAME.test(m.version) || m.version.startsWith('.')) {
    return {
      act: false,
      reason: 'unreadable',
      message: `the release version is not a plain name: ${m.version.slice(0, 60)}`,
    };
  }
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) {
    return { act: false, reason: 'unreadable', message: 'the release manifest\'s sha256 is not a sha256' };
  }
  // A filename becomes a path. This is the one field an attacker controls that
  // ends up on the filesystem, so it is a name and never a route to one.
  if (!PLAIN_NAME.test(m.file) || m.file.startsWith('.')) {
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

  // BEFORE the channel and rollout rules. A host that already has the release
  // is done, whatever channel it is on and wherever it falls in a rollout —
  // telling it "not for you yet" about something it is running would be a
  // sentence nobody can act on.
  if (m.version === installed) {
    return { act: false, reason: 'current', message: `already on ${installed}` };
  }

  // A PRERELEASE IS OPT-IN, PER HOST. The point of marking one is that it goes
  // to the boxes somebody chose to expose, so a bad build is found before every
  // machine takes it.
  // `m.prerelease` is GITHUB'S flag — the checkbox on the release — and the
  // channel is which address this box polls. Two different questions, which is
  // why the channel is no longer called by the same word.
  if (m.prerelease === true && channel !== 'rolling') {
    return {
      act: false,
      reason: 'channel',
      message:
        `${m.version} is a prerelease and this host is on the stable channel.\n` +
        'Set AGENT_HUB_RELEASE_CHANNEL=prerelease to take these.',
    };
  }

  // STAGED, and the fraction is the release's to decide rather than the host's.
  // A host computes only WHERE IT FALLS, which it can do offline and identically
  // everywhere. Absent, or 1 or more, means everybody — a rollout nobody
  // configured must not hold a fleet back.
  const rollout = typeof m.rollout === 'number' ? m.rollout : 1;
  if (rollout < 1) {
    // No key means no stable position, and guessing one would move a host
    // between rollouts at random. Waiting is the safe answer: the fraction only
    // ever rises, so a host that cannot place itself gets the release when it
    // reaches everybody.
    const position = hostKey ? rolloutPosition(hostKey, m.version) : 1;
    if (position >= rollout) {
      return {
        act: false,
        reason: 'rollout',
        message:
          `${m.version} is rolling out to ${Math.round(rollout * 100)}% of hosts and this one is not in that group yet.\n` +
          (hostKey ? 'It will update when the rollout widens.' : 'This host has no stable name to place itself with, so it waits for 100%.'),
      };
    }
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
 * The two GitHub release addresses, and how to get from one to the other.
 *
 * THE ROLLING TAG IS `rolling`, NOT `main`, and that is a bug fix rather than a
 * preference. A tag named `main` alongside a branch named `main` makes every
 * bare `main` in git ambiguous — and git resolves `refs/tags/` FIRST, so
 * `git checkout main`, `git diff main` and `git log main..` silently used the
 * commit the last rolling build was cut from, drifting further behind the
 * branch on every merge. It warns, and a warning in a script nobody reads is
 * not a defence.
 */
const STABLE_PATH = '/releases/latest/download/';
const ROLLING_PATH = '/releases/download/rolling/';

/**
 * Which manifest a box on this channel should fetch.
 *
 * THE CHANNEL HAS TO MOVE THE ADDRESS, not only filter what arrives. The two
 * channels are two different URLs — `releases/latest/download` skips
 * prereleases by GitHub's own definition, so a box left pointed there would
 * switch to `prerelease`, report that it had, and keep taking stable builds
 * forever. That is this repository's recurring failure exactly: true where it
 * was written, quietly false one layer up.
 *
 * Derived from the configured URL rather than configured twice, because two
 * settings that must agree are a setting that will not. A URL matching neither
 * shape — a mirror, a file:// path in a test — is returned unchanged and
 * `derived` is false, so a caller can SAY that rather than silently rewriting
 * somebody's address into one that does not exist.
 *
 * @param {string} manifestUrl the configured address
 * @param {string} channel
 * @returns {{ url: string, derived: boolean }}
 */
export function manifestUrlFor(manifestUrl, channel) {
  const url = String(manifestUrl || '');
  const want = channel === 'rolling' ? ROLLING_PATH : STABLE_PATH;
  const other = channel === 'rolling' ? STABLE_PATH : ROLLING_PATH;
  if (url.includes(want)) return { url, derived: true };
  if (url.includes(other)) return { url: url.replace(other, want), derived: true };
  return { url, derived: false };
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
