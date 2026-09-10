// Fetching a release and swapping to it.
//
// The judgement lives in release.js and is tested without a network. This is
// the part that touches the world, kept deliberately thin and in one order that
// does not change:
//
//   1. ask the manifest, and decide (protocol, version)
//   2. download
//   3. VERIFY THE DIGEST — before anything is unpacked, not after
//   4. unpack into a staging directory nobody is running
//   5. RUN IT ONCE. A tree that cannot print its own help is not one to point
//      a service at, and this is the last moment where finding that out is free
//   6. move the symlink
//   7. prune, keeping the one before
//
// Every step before 6 is reversible by doing nothing. That is the property to
// preserve when editing this: a failure at 1-5 leaves a box exactly as it was,
// and a failure after 6 leaves the previous release on disk to point back at.
//
// WHAT THE DIGEST DOES AND DOES NOT PROVE. It proves the bytes are the bytes
// the manifest named — corruption, a truncated download, a cache serving
// something stale. It does not prove the manifest itself is honest: it is
// fetched over the same TLS connection from the same host, so whoever serves
// the manifest chooses what this installs. That is the same trust as the git
// remote it replaces, and it is bounded the same way — by who can write to
// that host. Signing the manifest is the thing that would change it, and it is
// not built.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { RELEASES_DIR, decideRelease, fileUrl, releasePaths, releasesToPrune, verifyDownload } from './release.js';

/**
 * Is this install laid out so a release can be swapped in?
 *
 * `<base>/current -> releases/<version>` is what makes the swap one link move.
 * A packaged box that was unpacked somewhere by hand is not wrong, it is just
 * not updatable this way, and saying which is more useful than failing later.
 *
 * @param {string} installDir
 * @returns {{ ok: true, base: string } | { ok: false, message: string }}
 */
export function releaseLayout(installDir) {
  // TWO NAMES FOR THE SAME DIRECTORY, and only one of them was accepted.
  //
  // This required basename === 'current', which a RUNNING box can never
  // satisfy. INSTALL_ROOT is derived from import.meta.url, and node resolves
  // symlinks — so a service started as `<base>/current/lib/agent-hub.mjs`
  // reports its root as `<base>/releases/<version>`. The check was written
  // about the path the units name; the code reads the path node resolved.
  //
  // The first host ever to run a release asked /update and was told
  //
  //     /opt/fleetwright/releases/main-55 is not a release layout
  //
  // about a box laid out exactly as intended. Which means updating by manifest
  // — the entire point of packaging — could never have worked on any box.
  //
  // Both shapes are the same layout seen from two places, so both are read:
  //
  //     <base>/current              the symlink, what the units name
  //     <base>/releases/<version>   where it resolves to
  const base = path.basename(installDir) === 'current'
    ? path.dirname(installDir)
    : path.basename(path.dirname(installDir)) === RELEASES_DIR
      ? path.dirname(path.dirname(installDir))
      : null;

  // AND THE ROOT IS NOT A BASE. `/current` and `/releases/v1` satisfy the shapes
  // above and give a base of `/`, which would unpack the next release into the
  // filesystem root. No box is laid out there, so the only way to arrive at it
  // is a mistake — and this function's answer decides where files get written.
  // Same reasoning as decideRelease refusing a version that is a path.
  if (base === '/' || base === '' || base === '.') {
    return {
      ok: false,
      message: `${installDir} would put releases at the filesystem root, which is not a layout.`,
    };
  }

  if (base === null) {
    return {
      ok: false,
      message:
        `${installDir} is not a release layout, so there is no symlink to swap.\n` +
        'Re-run install.sh from a release and it will lay this box out as <base>/current -> releases/<version>.',
    };
  }
  return { ok: true, base };
}

/**
 * The version of the tree at `installDir`, from the package.json the release
 * ships.
 *
 * WHICH TREE THAT IS depends on who asks. A running process resolves its own
 * install root through the symlink to the real directory (config.js derives it
 * from where the code is), so from inside a service this is the version THAT
 * SERVICE IS RUNNING — even after `current` has moved on. That is the honest
 * answer to "what is this process", and it is exactly why a service that was
 * never restarted keeps reporting the release it started on. See
 * currentVersion for the other question.
 *
 * @param {string} installDir
 */
export function installedVersion(installDir) {
  try {
    return JSON.parse(readFileSync(path.join(installDir, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The version `current` points at — what a service WOULD run if it restarted.
 *
 * The other half of the question installedVersion answers from inside a
 * process. A fleet showed a box as `main-88 · up to date` while the same box
 * answered "already on main-102": the sidecar reporting health was still
 * running main-88 out of releases/main-88, the hub had moved `current` to
 * main-102 and restarted, and nothing anywhere compared the two. "Up to date"
 * was measuring what was left to download, which was nothing, about a service
 * fourteen releases behind its own disk.
 *
 * Null on a box that is not a release layout — a checkout has no `current`
 * and no second answer to give — and null when the link cannot be read. Never
 * 'unknown': a caller that sees a string here should be able to compare it.
 *
 * @param {string} installDir  either shape releaseLayout accepts
 * @returns {string|null}
 */
export function currentVersion(installDir) {
  const layout = releaseLayout(installDir);
  if (!layout.ok) return null;
  const v = installedVersion(releasePaths(layout.base, '').link);
  return v === 'unknown' ? null : v;
}

/**
 * @param {object} opts
 * @param {string} opts.installDir
 * @param {string} opts.manifestUrl
 * @param {number} opts.protocol
 * @param {string} [opts.channel]     'stable' (default) or 'rolling'
 * @param {string} [opts.hostKey]     stable per machine, for staged rollouts
 * @param {boolean} [opts.dryRun]     decide and report, download nothing
 * @param {typeof fetch} [opts.fetch]
 * @param {(m: string) => void} [opts.log]
 * @returns {Promise<{ ok: boolean, changed: boolean, version?: string, message: string }>}
 */
export async function applyRelease({ installDir, manifestUrl, protocol, channel = 'stable', hostKey = '', dryRun = false, fetch: doFetch = fetch, log = () => {} }) {
  const layout = releaseLayout(installDir);
  if (!layout.ok) return { ok: false, changed: false, message: layout.message };

  let manifest;
  try {
    const res = await doFetch(manifestUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) return { ok: false, changed: false, message: `the release manifest answered ${res.status}` };
    manifest = await res.json();
  } catch (e) {
    return { ok: false, changed: false, message: `could not reach the release manifest: ${/** @type {Error} */ (e).message}` };
  }

  const installed = installedVersion(installDir);
  const decision = decideRelease({ manifest, installed, protocol, channel, hostKey });
  if (!decision.act) {
    // `current` is not a failure — a box asking whether it is up to date and
    // being told it is has got the answer it wanted.
    return { ok: decision.reason === 'current', changed: false, message: decision.message };
  }
  if (dryRun) return { ok: true, changed: false, version: decision.manifest.version, message: `${decision.message} (available)` };

  const { dir, link, staging } = releasePaths(layout.base, decision.manifest.version);
  const url = fileUrl(manifestUrl, decision.manifest.file);
  log(`update: fetching ${url}`);

  let bytes;
  try {
    const res = await doFetch(url);
    if (!res.ok) return { ok: false, changed: false, message: `the release answered ${res.status}` };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, changed: false, message: `could not download the release: ${/** @type {Error} */ (e).message}` };
  }

  const verified = verifyDownload(bytes, decision.manifest);
  if (!verified.ok) return { ok: false, changed: false, message: verified.message };
  log(`update: ${verified.message}`);

  // Staged under a name that is not a version, so a half-unpacked tree can
  // never be mistaken for a release — releasesToPrune removes it on sight.
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const tarball = path.join(staging, '.tarball');
  try {
    // writeFileSync, not `sh -c 'cat > "$1"'`. The shell version was doing
    // nothing a plain write does not, and it spawned a shell to hold a path
    // built from a manifest — which is how CodeQL found it
    // (js/command-line-injection) and how a reader would have to stop and
    // reason about quoting to see it was safe. No shell, nothing to reason
    // about.
    writeFileSync(tarball, bytes);
    // --no-same-owner: unpacking as root would otherwise restore whatever uid
    // the archive claims. --strip-components=1 drops the version directory the
    // tarball wraps everything in.
    execFileSync('tar', ['-xzf', tarball, '-C', staging, '--strip-components=1', '--no-same-owner']);
    rmSync(tarball, { force: true });
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, changed: false, message: `could not unpack the release: ${/** @type {Error} */ (e).message}` };
  }

  // RUN IT ONCE, BEFORE ANYTHING POINTS AT IT. A bundle built against a newer
  // Node, or truncated in a way the digest somehow survived, or simply broken,
  // fails here — where the running box is still untouched — instead of after
  // the swap, where systemd restarts the corpse every three seconds.
  const entry = path.join(staging, 'lib', 'agent-hub.mjs');
  if (!existsSync(entry)) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, changed: false, message: 'the release has no lib/agent-hub.mjs — refusing it' };
  }
  const smoke = spawnSync(process.execPath, [entry, '--help'], { encoding: 'utf8', timeout: 30_000 });
  if (smoke.status !== 0) {
    rmSync(staging, { recursive: true, force: true });
    return {
      ok: false,
      changed: false,
      message:
        `the release does not run on this box, so it was not installed:\n${(smoke.stderr || smoke.stdout || '').slice(0, 400)}`,
    };
  }

  const previous = currentTarget(link);
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);

  // Atomic. Creating the link under a temporary name and renaming it over the
  // old one means there is never a moment where `current` does not exist —
  // which would be a moment where the service cannot start.
  const pending = `${link}.pending`;
  rmSync(pending, { force: true });
  symlinkSync(dir, pending);
  renameSync(pending, link);
  log(`update: current -> ${dir}`);

  prune(layout.base, decision.manifest.version, previous, log);

  return {
    ok: true,
    changed: true,
    version: decision.manifest.version,
    message:
      `Installed ${decision.manifest.version} (was ${installed}).\n` +
      'The new code is on disk and this process is still the old one — restart to apply it.',
  };
}

/** @param {string} link */
function currentTarget(link) {
  try {
    return path.basename(readlinkSync(link));
  } catch {
    return null;
  }
}

/**
 * @param {string} base
 * @param {string} live
 * @param {string|null} previous
 * @param {(m: string) => void} log
 */
function prune(base, live, previous, log) {
  const dir = path.join(base, 'releases');
  let present;
  try {
    present = readdirSync(dir);
  } catch {
    return;
  }
  // NEWEST FIRST, BY WHEN IT WAS INSTALLED. Version names do not sort against
  // each other once two channels exist — `v0.2.3` and `main-55` have no order —
  // so the filesystem is asked instead. A directory that cannot be stat'd sorts
  // last, which means it is a candidate for removal rather than something that
  // silently occupies a retention slot.
  const newestFirst = present
    .filter((v) => !v.startsWith('.incoming-'))
    .map((v) => {
      let at = 0;
      try { at = statSync(path.join(dir, v)).mtimeMs; } catch { /* sorts last */ }
      return { v, at };
    })
    .sort((a, b) => b.at - a.at)
    .map((e) => e.v);

  for (const name of releasesToPrune(present, live, previous, { newestFirst })) {
    rmSync(path.join(dir, name), { recursive: true, force: true });
    log(`update: removed release ${name}`);
  }
}
