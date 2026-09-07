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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

/** A box with a release laid out, and a manifest offering a newer one. */
async function box({ available = null, unit = null } = {}) {
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

  // A TMUX AND A CLAUDE OF ITS OWN, and this is about the coverage floor as
  // much as about the assertions.
  //
  // doctor probes whatever is on PATH. On a box with claude installed and
  // logged in it takes the success branches and prints an account; on a bare CI
  // container it takes the failure branches. Same test, same result, DIFFERENT
  // LINES EXECUTED — so the coverage number for bin/agent-hub depended on what
  // was installed on the machine running the suite, and a floor recorded on one
  // box read eight points lower on another.
  //
  // That is not a flaky test, which is why it took a re-baseline to notice: it
  // is a test whose ENVIRONMENT is an input nobody declared.
  const fakeBin = path.join(work, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(fakeBin, 'tmux'), '#!/bin/sh\necho "tmux 3.5a"\n');
  writeFileSync(
    path.join(fakeBin, 'claude'),
    // Answers both shapes doctor asks for: `--version`, and `auth status
    // --json`. Logged in, with an address, so the branch that formats one runs.
    '#!/bin/sh\n' +
      'case "$*" in\n' +
      '  *--version*) echo "9.9.9 (Claude Code)" ;;\n' +
      '  *"auth status"*) echo \'{"loggedIn":true,"email":"drill@example.com","subscriptionType":"max"}\' ;;\n' +
      '  *) exit 1 ;;\n' +
      'esac\n',
  );
  for (const f of ['tmux', 'claude']) chmodSync(path.join(fakeBin, f), 0o755);

  // A UNIT DIRECTORY AND A systemctl OF ITS OWN.
  //
  // Same story as the binaries, one layer over: doctor's unit block only runs
  // on a machine that HAS /etc/systemd/system/agent-hub.service, so it ran on
  // the box that recorded the coverage floor — which had a leftover from an
  // earlier drill — and never on CI. Seven points of bin/agent-hub were
  // coverage of whatever happened to be lying around in /etc.
  const unitDir = path.join(work, 'units');
  mkdirSync(unitDir, { recursive: true });
  const systemctlLog = path.join(work, 'systemctl.log');
  const fakeSystemctl = path.join(fakeBin, 'systemctl');
  writeFileSync(
    fakeSystemctl,
    '#!/bin/sh\n' +
      `echo "$@" >> ${JSON.stringify(systemctlLog)}\n` +
      'case "$1" in\n' +
      `  is-active) cat ${JSON.stringify(path.join(work, 'unit-state'))} 2>/dev/null || echo unknown ;;\n` +
      '  is-failed) echo failed ;;\n' +
      // reset-failed and start succeed, so --repair has a repair that WORKS.
      // A fake that always failed would only ever exercise the failure path.
      '  *) exit 0 ;;\n' +
      'esac\n',
  );
  chmodSync(fakeSystemctl, 0o755);
  if (unit) {
    writeFileSync(path.join(unitDir, 'agent-hub.service'), '[Service]\nExecStart=/usr/bin/node x serve\n');
    writeFileSync(path.join(work, 'unit-state'), `${unit}\n`);
  }
  return {
    work,
    base,
    current: path.join(base, 'current'),
    state,
    server,
    fakeBin,
    unitDir,
    systemctlLog,
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
    // ONLY the fixture's binaries, so the machine's own are never consulted.
    PATH: `${b.fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    AGENT_HUB_CLAUDE_BIN: path.join(b.fakeBin, 'claude'),
    AGENT_HUB_SYSTEMCTL_BIN: path.join(b.fakeBin, 'systemctl'),
    FLEETWRIGHT_UNIT_DIR: b.unitDir,
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
  assert.match(out, /FAIL\s+the release has something to run/, out.slice(0, 1200));
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


test('doctor sees the fixture\'s tools, never the machine\'s', async (t) => {
  // THE COVERAGE FLOOR IS WHY THIS EXISTS, not the assertion.
  //
  // doctor probes whatever is on PATH, so on a box with claude installed and
  // logged in it takes the success branches, and on a bare container it takes
  // the failure ones. Same test, same result, DIFFERENT LINES EXECUTED — so
  // bin/agent-hub's coverage depended on what was installed on the machine
  // running the suite, and a floor recorded on one box read eight points lower
  // on another and reported a regression that had not happened.
  //
  // check-coverage.mjs already has this story about Docker and
  // files-container.test.js. Its guard is for a test that SKIPS itself; this is
  // a test that runs everywhere and does different work, which the guard cannot
  // see. So the environment stops being an input.
  const b = await box();
  t.after(() => b.close());

  const { out } = await doctor(b);
  // These strings exist nowhere but the fixture's fake binaries.
  assert.match(out, /9\.9\.9 \(Claude Code\)/, out.slice(0, 900));
  assert.match(out, /drill@example\.com \(max\)/, out.slice(0, 900));
});

test('a unit systemd has given up on is reported, and repaired in the right order', async (t) => {
  const b = await box({ unit: 'failed' });
  t.after(() => b.close());

  const seen = await doctor(b);
  assert.match(seen.out, /FAIL\s+agent-hub\.service is failed/, seen.out.slice(0, 900));
  assert.match(seen.out, /journalctl -u agent-hub/, seen.out.slice(0, 900));
  // OFFERED BEFORE IT IS DONE. A tool that only acts when asked has to say what
  // it would do, or --repair is a flag nobody knows to reach for.
  assert.match(seen.out, /agent-hub doctor --repair/, seen.out.slice(0, 900));

  const fixed = await doctor(b, ['--repair']);
  assert.match(fixed.out, /ok\s+clear the failure counter and start agent-hub/, fixed.out.slice(0, 900));

  // RESET-FAILED BEFORE START, and the order is the assertion. systemd stops
  // trying after StartLimitBurst and then answers "Start request repeated too
  // quickly" to every start — so a plain restart on such a box does nothing and
  // says almost nothing, which is how a counter reached 6423.
  const log = readFileSync(b.systemctlLog, 'utf8').trim().split('\n');
  const reset = log.findIndex((l) => l.startsWith('reset-failed'));
  const start = log.findIndex((l) => l.startsWith('start'));
  assert.ok(reset >= 0, `never reset the counter:\n${log.join('\n')}`);
  assert.ok(start > reset, `started before clearing the counter:\n${log.join('\n')}`);
});

test('an active service is not something to fix', async (t) => {
  const b = await box({ unit: 'active' });
  t.after(() => b.close());

  const { out } = await doctor(b);
  assert.match(out, /ok\s+agent-hub\.service is active/, out.slice(0, 900));
  assert.doesNotMatch(out, /can be fixed for you/, out.slice(0, 900));

  const repaired = await doctor(b, ['--repair']);
  assert.match(repaired.out, /nothing to repair/, repaired.out.slice(0, 900));
  // And it did not touch the service just because it was asked to repair.
  const log = existsSync(b.systemctlLog) ? readFileSync(b.systemctlLog, 'utf8') : '';
  assert.doesNotMatch(log, /^start/m, `--repair started a service that was already running:\n${log}`);
});

test('a box with no unit is not a broken box', async (t) => {
  // A checkout somebody runs by hand has no service, and reporting that as a
  // failed one is the reassuring kind of wrong in reverse. `known: false`.
  const b = await box();
  t.after(() => b.close());

  const { out } = await doctor(b);
  assert.doesNotMatch(out, /agent-hub\.service is/, out.slice(0, 900));
  // The hub check speaks instead — one fact, once, and this is the half that
  // has something to say when there is no unit to point at.
  assert.match(out, /hub reachable at/, out.slice(0, 900));
});
