// What a real box showed that the temp-directory tests could not.
//
//   node --test test/install-on-a-box.test.js
//
// Each of these was measured on a systemd box (podman, systemd as PID 1, an
// install from a release tarball through bootstrap.sh and a loopback manifest)
// and each is a place where the installer said one thing and the box was
// another. The installer cannot be run here — it writes /etc — so each test
// runs the one piece of it that was wrong, at that piece's own boundary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SH = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
const UNINSTALL = readFileSync(new URL('../install/uninstall.sh', import.meta.url), 'utf8');

const fn = (name) => {
  const body = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, 'm').exec(SH)?.[0] ?? '';
  assert.ok(body, `${name} is gone from install.sh`);
  return body;
};

const hasVisudo = spawnSync('sh', ['-c', 'command -v visudo']).status === 0;

test('the two helpers that take no arguments are granted with none', () => {
  // `fwsvc ALL=(root) NOPASSWD: /usr/local/sbin/fleetwright-migrate` is how
  // the rules read, and to sudo a command with no arguments written matches it
  // with ANY: on the box `sudo -l /usr/local/sbin/fleetwright-migrate
  // --some-arg` answered yes, and so did `fleetwright-reclaim /etc`. Both
  // helpers' headers say "no arguments … every argument is a widening"; only
  // the helpers ignoring their argv made that true. `""` makes sudo say it.
  const dir = mkdtempSync(path.join(tmpdir(), 'sudoers-'));
  try {
    for (const [writer, file] of [['write_migrate_sudoers', 'fleetwright-migrate'], ['write_reclaim_sudoers', 'fleetwright-reclaim']]) {
      // The writer as the installer runs it, with root's `install` pointed
      // here instead of /etc/sudoers.d, and the real visudo where there is one.
      const script = [
        `install() { cp "$3" "${dir}/$(basename "$4")"; }`,
        hasVisudo ? '' : 'visudo() { return 0; }',
        fn(writer),
        `RUN_USER=fwsvc ${writer}`,
      ].join('\n');
      const r = spawnSync('bash', ['-euo', 'pipefail', '-c', script], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${writer} refused its own rule:\n${r.stderr}`);
      const rule = readFileSync(path.join(dir, file), 'utf8').trim();
      assert.equal(rule, `fwsvc ALL=(root) NOPASSWD: /usr/local/sbin/${file} ""`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the commit-confirm watchdog is armed on a route the wizard is not on', () => {
  // Only the wizard armed it. --no-wizard, the deb with no coordinator, and the
  // --repair every update's heal runs all wrote the timer, printed "commit-
  // confirm watchdog installed (reverts an update that cannot prove itself)",
  // and left fleetwright-confirm.timer disabled — through an install, two heals
  // and an update to a new release on the box. This runs the installer's own
  // arming block with the wizard off and a systemctl that records its calls.
  const start = SH.indexOf('# THE WATCHDOG IS ARMED WHERE IT IS INSTALLED');
  assert.ok(start >= 0, 'the watchdog is armed only where the wizard runs');
  const end = SH.indexOf('\nfi\n', start) + 4;
  const units = mkdtempSync(path.join(tmpdir(), 'confirm-'));
  try {
    writeFileSync(path.join(units, 'fleetwright-confirm.timer'), '');
    // Its one root path pointed at the fixture, and nothing else changed.
    const block = SH.slice(start, end).replaceAll('/etc/systemd/system/', `${units}/`);
    const log = path.join(units, 'systemctl.log');
    const run = (vars) => spawnSync('bash', ['-euo', 'pipefail', '-c', [
      `systemctl() { echo "$*" >> ${JSON.stringify(log)}; }`,
      'ok() { echo "ok $*"; }', 'warn() { echo "warn $*"; }',
      ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
      block,
    ].join('\n')], { encoding: 'utf8' });
    const armed = () => { try { return readFileSync(log, 'utf8'); } catch { return ''; } };

    const r = run({ PACKAGED: 1, PLATFORM: 'linux', CHECK_ONLY: 0, HAVE_SYSTEMD: 1, WIZARD: 'no', UPGRADE: 1 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(armed(), /^enable --now fleetwright-confirm\.timer$/m, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /commit-confirm watchdog armed/);

    // And not where there is nothing to guard: a checkout, or --check.
    rmSync(log, { force: true });
    run({ PACKAGED: 0, PLATFORM: 'linux', CHECK_ONLY: 0, HAVE_SYSTEMD: 1 });
    run({ PACKAGED: 1, PLATFORM: 'linux', CHECK_ONLY: 1, HAVE_SYSTEMD: 1 });
    assert.equal(armed(), '', 'armed on a checkout or under --check');
  } finally {
    rmSync(units, { recursive: true, force: true });
  }
});

test('a package manager that failed is named, not called missing', () => {
  // A Debian box with no network printed "could not install podman (no
  // supported package manager found (apt, dnf, pacman, zypper, apk))" with
  // apt-get on its PATH.
  const bin = mkdtempSync(path.join(tmpdir(), 'pkg-why-'));
  try {
    mkdirSync(path.join(bin, 'b'));
    writeFileSync(path.join(bin, 'b', 'apt-get'), '#!/bin/sh\nexit 100\n');
    chmodSync(path.join(bin, 'b', 'apt-get'), 0o755);
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', [
      'id() { echo 0; }', 'PLATFORM=linux', fn('pkg_why'), 'pkg_why',
    ].join('\n')], { encoding: 'utf8', env: { PATH: `${path.join(bin, 'b')}:/usr/bin:/bin` } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^apt-get could not install it/);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('an uninstall that removed everything exits 0, --purge or not', () => {
  // `uninstall.sh --purge --yes` printed every removal, then "Removed.", and
  // exited 1: its last line was `[ "$PURGE" != 1 ] && printf …`, and a false
  // test as the last command is the script's status. Anything scripting an
  // uninstall read success as failure. The closing section, run as the script
  // runs it.
  const tail = UNINSTALL.slice(UNINSTALL.indexOf('say "Removed."'));
  for (const purge of ['1', '0']) {
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', `say() { :; }\nPURGE=${purge}\nPURGE_DIR=/opt/fleetwright\n${tail}`], { encoding: 'utf8' });
    assert.equal(r.status, 0, `PURGE=${purge}: ${r.stderr}`);
  }
});
