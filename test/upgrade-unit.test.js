// The upgrade runs in a unit of its own, and the hub may only start it.
//
//   node --test test/
//
// docs/recommendations-review.md §7: agent-hub.service could not keep
// ProtectSystem while its grant was `apt-get -y upgrade`, because sudo does
// not escape the hub's mount namespace and an upgrade cannot live inside one.
// The way out the unit named — a oneshot with no sandboxing, and a grant to
// start it and nothing else — is what these tests pin: the units are ones
// systemd accepts, the grant is one visudo accepts, and upgrades.js tries the
// unit first and still works on a box whose grant predates it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runUpgrade, refreshPackageLists, UPGRADE_UNIT, APT_UPDATE_UNIT } from '../src/core/upgrades.js';

const here = (/** @type {string} */ p) => new URL(`../${p}`, import.meta.url).pathname;
const has = (/** @type {string} */ bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;

test('both units are ones systemd will load, and neither takes an argument', (t) => {
  for (const unit of ['install/agent-hub-upgrade.service', 'install/agent-hub-apt-update.service']) {
    const text = readFileSync(here(unit), 'utf8');
    assert.match(text, /^Type=oneshot$/m, unit);
    assert.match(text, /^User=root$/m, unit);
    assert.match(text, /^ExecStart=\/usr\/bin\/apt-get /m, unit);
    // No sandboxing directive at all: rewriting /usr, /etc and /boot is what
    // an upgrade IS, and the unit exists so the hub's own protections do not
    // apply to it.
    assert.doesNotMatch(text, /^Protect|^Private|^NoNewPrivileges|^Restrict/m, `${unit} sandboxes the thing that must not be sandboxed`);
    // The noninteractive flags live here now, not in a sudoers env_keep.
    if (unit.includes('agent-hub-upgrade')) {
      assert.match(text, /--force-confold/);
      assert.match(text, /--force-confdef/);
      assert.match(text, /^Environment=DEBIAN_FRONTEND=noninteractive$/m);
    }
  }
  if (!has('systemd-analyze')) return t.skip('no systemd-analyze on this box');
  const r = spawnSync('systemd-analyze', ['verify', here('install/agent-hub-upgrade.service'), here('install/agent-hub-apt-update.service')], { encoding: 'utf8' });
  assert.equal(r.status, 0, `systemd-analyze verify: ${r.stderr}${r.stdout}`);
});

test('the grant the installer writes is one visudo accepts, and names only the two units', (t) => {
  const installer = readFileSync(here('install/install.sh'), 'utf8');
  const fn = /write_upgrade_sudoers\(\) \{[\s\S]*?\n\}/.exec(installer)?.[0] ?? '';
  assert.ok(fn, 'write_upgrade_sudoers is gone');
  assert.match(fn, /systemctl start agent-hub-upgrade\.service/);
  assert.match(fn, /systemctl start agent-hub-apt-update\.service/);
  assert.doesNotMatch(fn, /printf '[^']*apt-get/, 'an apt-get line is back in the grant');
  assert.doesNotMatch(fn, /env_keep/, 'DEBIAN_FRONTEND rides in the unit now, not through sudo');

  if (!has('visudo')) return t.skip('no visudo on this box');
  // The exact line the installer prints, with a real user name substituted.
  const dir = mkdtempSync(path.join(tmpdir(), 'sudoers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'agent-hub-upgrade');
  writeFileSync(
    file,
    `agent ALL=(root) NOPASSWD: /usr/bin/systemctl start ${UPGRADE_UNIT}, /usr/bin/systemctl start ${APT_UPDATE_UNIT}\n`,
  );
  const r = spawnSync('visudo', ['-cf', file], { encoding: 'utf8' });
  assert.equal(r.status, 0, `visudo: ${r.stderr}${r.stdout}`);
});

/**
 * A stand-in for spawning: answers each argv from a script and records it.
 * @param {Array<{ match: RegExp, status: number, stdout?: string, stderr?: string }>} script
 */
function fakeExec(script) {
  /** @type {string[]} */
  const calls = [];
  const exec = (/** @type {string[]} */ argv) => {
    const line = argv.join(' ');
    calls.push(line);
    const hit = script.find((s) => s.match.test(line));
    if (!hit) return { status: 0, stdout: '', stderr: '' };
    return { status: hit.status, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
  };
  return { exec, calls };
}

const cfg = /** @type {any} */ ({ systemUpgrade: true, runUser: 'agent' });
const waiting = () => ({ supported: true, count: 2, security: 1, rebootRequired: false, packages: ['a', 'b'] });
const done = () => ({ supported: true, count: 0, security: 0, rebootRequired: false, packages: [] });

test('the upgrade starts the unit, and nothing else, when the grant allows it', () => {
  const { exec, calls } = fakeExec([]);
  let n = 0;
  const r = runUpgrade(cfg, { exec, updates: () => (n++ === 0 ? waiting() : done()) });
  assert.equal(r.ok, true, r.text);
  assert.deepEqual(calls, [`sudo -n /usr/bin/systemctl start ${UPGRADE_UNIT}`]);
  assert.match(r.text, /2 packages|Applied|a, b/i);
});

test('a box whose grant predates the unit falls back to the apt-get lines it is still permitted', () => {
  // sudo matches the whole command line, so a refusal of the unit start is
  // a clean signal that this box has the old rule — and refusing to upgrade
  // at all would be worse than upgrading the way it always has.
  const { exec, calls } = fakeExec([
    { match: /systemctl start/, status: 1, stderr: 'Sorry, user agent is not allowed to execute \'/usr/bin/systemctl start agent-hub-upgrade.service\' as root' },
    { match: /force-confold/, status: 1, stderr: 'Sorry, user agent is not allowed to execute' },
  ]);
  let n = 0;
  const r = runUpgrade(cfg, { exec, updates: () => (n++ === 0 ? waiting() : done()) });
  assert.equal(r.ok, true, r.text);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /systemctl start agent-hub-upgrade\.service$/);
  assert.match(calls[1], /apt-get -y -o Dpkg::Options::=--force-confold/);
  assert.equal(calls[2], 'sudo -n /usr/bin/apt-get -y upgrade');
});

test('a failed unit reports what apt said, read from the journal', () => {
  const { exec, calls } = fakeExec([
    { match: /systemctl start/, status: 1, stderr: 'Job for agent-hub-upgrade.service failed because the control process exited with error code.' },
    { match: /^journalctl/, status: 0, stdout: "dpkg: error processing archive\nunable to create '/etc/debian_version.dpkg-new': Read-only file system" },
  ]);
  const r = runUpgrade(cfg, { exec, updates: waiting });
  assert.equal(r.ok, false);
  assert.match(r.text, /Read-only file system/, 'the dpkg line, not only "job failed"');
  const journal = calls.find((c) => c.startsWith('journalctl'));
  assert.ok(journal, 'the journal was consulted');
  assert.match(journal, new RegExp(`-u ${UPGRADE_UNIT} --since -\\d+s --no-pager -o cat`));
  assert.equal(calls.some((c) => c.includes('apt-get')), false, 'a real failure is not a reason to try the old grant');
});

test('the package-list refresh takes the same shape: the unit first, the old line on refusal', () => {
  const first = fakeExec([]);
  refreshPackageLists(cfg, { exec: first.exec, now: () => 1_000_000_000_000 });
  assert.deepEqual(first.calls, [`sudo -n /usr/bin/systemctl start ${APT_UPDATE_UNIT}`]);

  const second = fakeExec([{ match: /systemctl start/, status: 1, stderr: 'Sorry, user agent is not allowed to execute' }]);
  refreshPackageLists(cfg, { exec: second.exec, now: () => 2_000_000_000_000 });
  assert.deepEqual(second.calls, [
    `sudo -n /usr/bin/systemctl start ${APT_UPDATE_UNIT}`,
    'sudo -n /usr/bin/apt-get update',
  ]);
});
