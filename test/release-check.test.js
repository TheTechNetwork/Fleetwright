// Whether a box can see a release waiting for it, and whether it says so.
//
// THE GAP THESE ASSERT IS CLOSED: `updateAvailable` answers in commits and
// needs a git checkout. A packaged host has none, so it reported `appBehind:
// null` — CANNOT TELL — for as long as the packaging existed, both phones
// correctly rendered nothing, and the only way to learn whether an update was
// waiting was to type `/update` and read the reply. The pipeline was complete
// and nothing was looking at it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkRelease } from '../src/core/release-check.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

/**
 * A box laid out the way a release install leaves one: <base>/current is a
 * symlink into <base>/releases/<version>. `releaseLayout` refuses anything
 * else, so a fixture that skipped this would test the refusal and nothing else.
 */
function packagedBox(installed = 'v0.2.2') {
  const base = mkdtempSync(path.join(tmpdir(), 'relcheck-'));
  const dir = path.join(base, 'releases', installed);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: installed }));
  symlinkSync(dir, path.join(base, 'current'));
  return { base, installDir: path.join(base, 'current') };
}

const MANIFEST = 'https://github.com/o/r/releases/latest/download/manifest.json';

/** A fetch that answers one manifest and records what was asked for. */
function serving(manifest) {
  const asked = [];
  const doFetch = async (/** @type {string} */ url) => {
    asked.push(String(url));
    return { ok: true, status: 200, json: async () => manifest };
  };
  return { doFetch, asked };
}

test('a box that does not know where to look says so, rather than nothing', async () => {
  // EVERY BOX INSTALLED BEFORE THIS ROUND IS IN THIS STATE. A screen showing
  // nothing cannot be told apart from one that checked and found nothing, so
  // the answer names the variable and the remedy — the shape this project keeps
  // getting wrong is a fix only a shell can apply, named nowhere.
  const box = packagedBox();
  try {
    const r = await checkRelease(/** @type {any} */ ({ installDir: box.installDir, releaseManifest: '', stateDir: box.base, hostname: 'h' }));
    assert.equal(r.configured, false);
    assert.equal(r.available, null);
    assert.match(r.message, /AGENT_HUB_RELEASE_MANIFEST/);
    assert.match(r.message, /--upgrade/);
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('a newer release is reported, and nothing is downloaded to find out', async () => {
  const box = packagedBox('v0.2.2');
  const { doFetch, asked } = serving({
    version: 'v0.2.3',
    file: 'fleetwright-host-v0.2.3.tar.gz',
    sha256: 'a'.repeat(64),
    protocol: PROTOCOL_VERSION,
  });
  try {
    const r = await checkRelease(
      /** @type {any} */ ({ installDir: box.installDir, releaseManifest: MANIFEST, stateDir: box.base, hostname: 'h' }),
      { fetch: /** @type {any} */ (doFetch) },
    );
    assert.equal(r.available, 'v0.2.3');
    assert.equal(r.configured, true);
    // THE MANIFEST ONLY. A check that fetched the tarball to answer a question
    // would download a release onto every box in the fleet every fifteen
    // minutes, which is the opposite of a check.
    assert.deepEqual(asked, [MANIFEST]);
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('a box already on the release is told that, not offered it', async () => {
  const box = packagedBox('v0.2.3');
  const { doFetch } = serving({
    version: 'v0.2.3',
    file: 'fleetwright-host-v0.2.3.tar.gz',
    sha256: 'a'.repeat(64),
    protocol: PROTOCOL_VERSION,
  });
  try {
    const r = await checkRelease(
      /** @type {any} */ ({ installDir: box.installDir, releaseManifest: MANIFEST, stateDir: box.base, hostname: 'h' }),
      { fetch: /** @type {any} */ (doFetch) },
    );
    assert.equal(r.available, null);
    assert.match(r.message, /already on v0\.2\.3/);
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('a release this host could not take is not offered as one it can', async () => {
  // THE PROPERTY THE WHOLE FILE IS FOR. "There is an update" and "you may
  // install it" have to be one answer: a box that advertises an update and then
  // refuses it when tapped is worse than one that says nothing, because the
  // refusal arrives after somebody decided to act.
  const box = packagedBox('v0.2.2');
  const { doFetch } = serving({
    version: 'v9.9.9',
    file: 'fleetwright-host-v9.9.9.tar.gz',
    sha256: 'a'.repeat(64),
    protocol: PROTOCOL_VERSION + 1,
  });
  try {
    const r = await checkRelease(
      /** @type {any} */ ({ installDir: box.installDir, releaseManifest: MANIFEST, stateDir: box.base, hostname: 'h' }),
      { fetch: /** @type {any} */ (doFetch) },
    );
    assert.equal(r.available, null, 'a protocol mismatch was offered as an available update');
    assert.match(r.message, /protocol/);
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('the channel decides which address is polled', async () => {
  const box = packagedBox('v0.2.2');
  writeFileSync(path.join(box.base, 'release-channel'), 'rolling\n');
  const { doFetch, asked } = serving({
    version: 'main-42',
    file: 'fleetwright-host-main-42.tar.gz',
    sha256: 'a'.repeat(64),
    protocol: PROTOCOL_VERSION,
    prerelease: true,
  });
  try {
    const r = await checkRelease(
      /** @type {any} */ ({ installDir: box.installDir, releaseManifest: MANIFEST, stateDir: box.base, hostname: 'h' }),
      { fetch: /** @type {any} */ (doFetch) },
    );
    // The stable URL was configured; the channel moved it. Filtering the
    // manifest without moving the address would poll `releases/latest`, which
    // skips prereleases by GitHub's definition and can never serve this.
    assert.deepEqual(asked, ['https://github.com/o/r/releases/download/rolling/manifest.json']);
    assert.equal(r.available, 'main-42');
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('an unreachable release host is not an exception', async () => {
  // A box that cannot reach GitHub still runs sessions perfectly well, and a
  // check that threw would take the timer — and with it the apt answer and the
  // reboot flag — down with it.
  const box = packagedBox();
  const doFetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  try {
    const r = await checkRelease(
      /** @type {any} */ ({ installDir: box.installDir, releaseManifest: MANIFEST, stateDir: box.base, hostname: 'h' }),
      { fetch: /** @type {any} */ (doFetch) },
    );
    assert.equal(r.available, null);
    assert.equal(r.configured, true);
    assert.match(r.message, /could not reach|ENOTFOUND/);
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

// --- and the installer that makes any of it possible ------------------------

test('the installer records where releases come from', () => {
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');

  // Derived from the repository it was installed out of, so a fork's boxes take
  // the fork's releases and nobody has to be told about a variable they have
  // never heard of.
  assert.match(sh, /git -C "\$DIR" remote get-url origin/);
  assert.match(sh, /set_env "\$ENV_FILE" AGENT_HUB_RELEASE_MANIFEST/);

  // THE STABLE ADDRESS, and only that one. `releases/latest/download` skips
  // prereleases; the rolling address is derived from it in release.js, so an
  // installer writing both would be two settings that must agree.
  assert.match(sh, /releases\/latest\/download\/manifest\.json/);
  assert.doesNotMatch(sh, /releases\/download\/rolling/);

  // A remote that is not GitHub is NOT guessed at: inventing a release path
  // inside somebody else's server 404s on every check and blames the check.
  assert.match(sh, /could not tell which repository this came from/);

  // And it never overwrites an answer somebody already gave.
  assert.match(sh, /if \[ -z "\$\(get_env "\$ENV_FILE" AGENT_HUB_RELEASE_MANIFEST\)" \]/);
});

test('the manifest URL is built only from a remote it recognises', async () => {
  // The shell function, exercised as shell rather than reasoned about. Every
  // case here is a real thing `git remote get-url` prints.
  const { execFileSync } = await import('node:child_process');
  const script = new URL('../install/install.sh', import.meta.url).pathname;
  const ask = (/** @type {string} */ remote) =>
    execFileSync('sh', ['-c',
      // The function alone, lifted out: sourcing the installer would run it.
      `${execFileSync('sed', ['-n', '/^release_manifest_url() {/,/^}/p', script], { encoding: 'utf8' })}\n` +
      `release_manifest_url "$1" || echo REFUSED`, 'sh', remote], { encoding: 'utf8' }).trim();

  const expected = 'https://github.com/TheTechNetwork/Fleetwright/releases/latest/download/manifest.json';
  assert.equal(ask('https://github.com/TheTechNetwork/Fleetwright'), expected);
  assert.equal(ask('https://github.com/TheTechNetwork/Fleetwright.git'), expected);
  assert.equal(ask('git@github.com:TheTechNetwork/Fleetwright.git'), expected);
  assert.equal(ask('ssh://git@github.com/TheTechNetwork/Fleetwright'), expected);

  // A fork gets its own, which is the whole point of deriving it.
  assert.match(ask('https://github.com/someone/Fleetwright'), /github\.com\/someone\/Fleetwright\/releases/);

  // And everything else is REFUSED rather than guessed. A GitHub Enterprise
  // host has a different release path; a mirror has none; a local path is not a
  // release host at all. Building a URL from any of them would 404 on every
  // check, for ever, and read as the update system being broken.
  for (const remote of [
    'https://git.example.com/o/r.git',
    '/srv/git/fleetwright.git',
    'https://github.com/onlyowner',
    'https://github.com/o/r/extra',
    '',
  ]) {
    assert.equal(ask(remote), 'REFUSED', `${remote || '(empty)'} was turned into a URL`);
  }
});
