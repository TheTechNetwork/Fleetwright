// `doctor` as a repair tool, and the one thing it must never do.
//
// It used to answer one question — can this box run a SESSION — while every
// afternoon lost on this project went to a different one: can this box run
// ITSELF. A dangling `current`, a release tree the service user cannot write, a
// unit systemd has given up on: all invisible from here, all diagnosed on the
// box by somebody with a shell, which is the thing the product exists to avoid
// needing.
//
// OFFER, NEVER FORCE. Updating is the one remedy that changes what the box
// RUNS, and it is the one that is genuinely a decision — a machine mid-session
// has a reason to wait. So it is printed with its command and never applied,
// including under --repair, and that is asserted rather than intended.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** A box with a release laid out, and a manifest offering a newer one. */
async function box({ available = null } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), 'doctor-'));
  const base = path.join(work, 'opt', 'fleetwright');
  const rel = path.join(base, 'releases', 'v1.0.0');
  mkdirSync(path.join(rel, 'lib'), { recursive: true });
  mkdirSync(path.join(rel, 'install'), { recursive: true });
  writeFileSync(path.join(rel, 'package.json'), JSON.stringify({ version: 'v1.0.0' }));
  writeFileSync(path.join(rel, 'lib', 'agent-hub.mjs'), '');
  symlinkSync(rel, path.join(base, 'current'));

  // SERVED OVER HTTP, not file://. Node's fetch does not open file: URLs, so a
  // manifest on disk answers "could not check for a release" — which is a
  // perfectly good answer and not the one under test. The migration tests get
  // away with file:// because the helper there is shell and uses curl.
  let manifest = '';
  let server = null;
  if (available) {
    const body = JSON.stringify({
      version: available,
      file: `fleetwright-host-${available}.tar.gz`,
      sha256: createHash('sha256').update('x').digest('hex'),
      protocol: 3,
    });
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    // AWAITED. `listen` is asynchronous, and address() is null until it fires —
    // which read as "the fixture is broken" rather than "the fixture is early".
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  }
  const state = path.join(work, 'state');
  mkdirSync(state, { recursive: true });
  return {
    work,
    base,
    current: path.join(base, 'current'),
    state,
    server,
    get manifest() {
      if (!server) return '';
      const a = /** @type {any} */ (server.address());
      return `http://127.0.0.1:${a.port}/manifest.json`;
    },
    close() {
      server?.close();
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/**
 * ASYNC, AND NOT BY PREFERENCE. spawnSync blocks this process's event loop, so
 * the manifest server above — which lives in this process — can never answer,
 * and doctor waits for a reply that cannot arrive until doctor exits. Thirty
 * seconds of nothing, reported as a timeout, from a deadlock between two halves
 * of one test.
 */
function doctor(b, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['bin/agent-hub', 'doctor', ...args], {
      cwd: ROOT,
      env: envFor(b),
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ out, code }));
  });
}

function envFor(b) {
  return {
    ...process.env,
    // Nothing of this machine's: doctor reads /etc/agent-hub.env otherwise,
    // and a test that inherits a real box's config tests that box.
    AGENT_HUB_ENV_FILE: path.join(b.work, 'nonexistent.env'),
    AGENT_HUB_INSTALL_DIR: b.current,
    AGENT_HUB_STATE_DIR: b.state,
    AGENT_HUB_WORKDIR: b.state,
    AGENT_HUB_RELEASE_MANIFEST: b.manifest,
    AGENT_FLEET_BASE: b.base,
    AGENT_HUB_TELEGRAM_TOKEN: '',
    // A port nothing is on, so "hub reachable" is a stable no.
    AGENT_HUB_PORT: '59999',
  };
}

test('an available update is offered with its command, and not taken', async (t) => {
  const b = await box({ available: 'v2.0.0' });
  t.after(() => b.close());

  const { out } = await doctor(b);
  assert.match(out, /an update is waiting: v2\.0\.0/, out.slice(0, 900));
  // THE COMMAND, not "run an update". A remedy somebody has to go and look up
  // is a remedy for people who already knew.
  assert.match(out, /agent-hub update/, out.slice(0, 900));
});

test('--repair does not apply it, and says so where somebody will read it', async (t) => {
  const b = await box({ available: 'v2.0.0' });
  t.after(() => b.close());

  const { out } = await doctor(b, ['--repair']);
  assert.match(out, /not applied by --repair/, out.slice(0, 900));

  // AND IT DEMONSTRABLY DID NOT. The symlink still points where it did, and no
  // second release was laid down beside it — the assertion that would fail if
  // somebody later decided --repair "might as well" update.
  assert.equal(readFileSync(path.join(b.current, 'package.json'), 'utf8').includes('v1.0.0'), true);
  assert.equal(
    spawnSync('ls', [path.join(b.base, 'releases')], { encoding: 'utf8' }).stdout.trim(),
    'v1.0.0',
    '--repair laid out a release',
  );
});

test('a broken release layout is reported, not discovered during an update', async (t) => {
  // The state a real box reached: `current` resolves, the directory is there,
  // and the payload is not. Every cheap check passes; only opening the file it
  // is supposed to run says otherwise, and nothing did.
  const b = await box();
  t.after(() => b.close());
  rmSync(path.join(b.base, 'releases', 'v1.0.0', 'lib'), { recursive: true, force: true });

  const { out } = await doctor(b);
  // NOT the layout check, which passes: releaseLayout validates the SHAPE of
  // the path, and a directory with no lib/ in it is a perfectly well-shaped
  // path. This is the check that opens the file.
  assert.match(out, /FAIL {2}the release has something to run/, out.slice(0, 1200));
  assert.match(out, /re-run the installer/, out.slice(0, 1200));
});

test('one fact is reported once', () => {
  // "hub unreachable" and "agent-hub.service is inactive" are the same news.
  // Printing both is how a screen contradicts itself, which is the defect the
  // `updates` verb exists to remove, one tool over.
  const src = readFileSync(new URL('../bin/agent-hub', import.meta.url), 'utf8');
  assert.match(src, /if \(!unit\.known \|\| hubUp\) \{/);
});

test('a repair that failed is a failure, not a line of output', () => {
  // "doctor says it fixed it" and "the box is still broken" must not be able to
  // appear in the same sentence. Reporting the ATTEMPT and exiting 0 is how
  // they do.
  const src = readFileSync(new URL('../bin/agent-hub', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('if (repair) {'));
  assert.match(block.slice(0, 900), /if \(!done\) bad\+\+/);
  // And a root-only repair is SKIPPED with the command to run, not attempted
  // and reported as broken: a chown that fails prints a permission error about
  // fixing a permission error, which reads as the tool being broken.
  assert.match(block.slice(0, 900), /needs root: sudo agent-hub doctor --repair/);
});
