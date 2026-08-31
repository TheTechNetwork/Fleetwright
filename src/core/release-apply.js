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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, readdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { decideRelease, fileUrl, releasePaths, releasesToPrune, verifyDownload } from './release.js';

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
  if (path.basename(installDir) !== 'current') {
    return {
      ok: false,
      message:
        `${installDir} is not a release layout, so there is no symlink to swap.\n` +
        'Re-run install.sh from a release and it will lay this box out as <base>/current -> releases/<version>.',
    };
  }
  return { ok: true, base: path.dirname(installDir) };
}

/**
 * The version running now, from the package.json the release ships.
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
 * @param {object} opts
 * @param {string} opts.installDir
 * @param {string} opts.manifestUrl
 * @param {number} opts.protocol
 * @param {boolean} [opts.dryRun]     decide and report, download nothing
 * @param {typeof fetch} [opts.fetch]
 * @param {(m: string) => void} [opts.log]
 * @returns {Promise<{ ok: boolean, changed: boolean, version?: string, message: string }>}
 */
export async function applyRelease({ installDir, manifestUrl, protocol, dryRun = false, fetch: doFetch = fetch, log = () => {} }) {
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
  const decision = decideRelease({ manifest, installed, protocol });
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
  for (const name of releasesToPrune(present, live, previous)) {
    rmSync(path.join(dir, name), { recursive: true, force: true });
    log(`update: removed release ${name}`);
  }
}
