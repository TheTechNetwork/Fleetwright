// What a box allows from chat, and the one line that changes it.
//
// "Rebooting from chat is off" used to print a sudoers line to echo, a chmod
// and an edit to a root-owned env file. Every apt box met that paragraph,
// because a deb install is asked nothing and takes the defaults. The installer
// already owned the rule, the recorded answer and the restart; now one command
// names doing them together, one debconf question asks it, and the answer
// travels to the apps so a phone can draw Reboot only where it would work.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GRANTS, grantCommand, grantsOf, describeGrants, parseGrantArgs, grantPlan, runGrant } from '../src/core/grants.js';
import { reboot } from '../src/core/reboot.js';
import { runUpgrade, runPackageUpgrade } from '../src/core/upgrades.js';
import { dispatch } from '../src/adapters/commands.js';

const here = (/** @type {string} */ p) => new URL(`../${p}`, import.meta.url).pathname;
const SH = readFileSync(here('install/install.sh'), 'utf8');

test('the CLI names the grant, on or off, and refuses anything else before sudo', () => {
  assert.deepEqual(parseGrantArgs(['reboot', 'on']), { name: 'reboot', to: 'on' });
  assert.deepEqual(parseGrantArgs(['upgrades', 'no']), { name: 'upgrades', to: 'off' });
  assert.match(/** @type {any} */ (parseGrantArgs(['sudo', 'on'])).error, /not a grant: sudo/);
  assert.match(/** @type {any} */ (parseGrantArgs(['reboot'])).error, /is not on or off/);
  assert.equal(grantCommand('reboot'), 'sudo fleetwright grant reboot on');
  assert.equal(grantCommand('upgrades', 'off'), 'sudo fleetwright grant upgrades off');
});

test('runGrant: reports without root, refuses to change without root, and runs the installer with it', () => {
  const out = [];
  const err = [];
  const spawned = [];
  const spawn = (/** @type {string} */ cmd, /** @type {string[]} */ argv, /** @type {any} */ opts) => {
    spawned.push({ cmd, argv, env: opts.env });
    return { status: 0 };
  };
  const cfg = { systemUpgrade: true, systemReboot: false };
  const base = { cfg, root: '/opt/fleetwright/current', node: '/usr/lib/fleetwright/node/bin/node', spawn, out: (s) => out.push(s), err: (s) => err.push(s) };

  assert.equal(runGrant([], { ...base, uid: 1000 }), 0);
  assert.match(out[0], /system upgrades from chat\s+on\s+sudo fleetwright grant upgrades off/);
  assert.match(out[0], /reboot from chat\s+off\s+sudo fleetwright grant reboot on/);
  assert.equal(spawned.length, 0, 'reporting runs nothing');

  assert.equal(runGrant(['reboot', 'on'], { ...base, uid: 1000 }), 1);
  assert.match(err[0], /needs root:\n\s+sudo fleetwright grant reboot on/);
  assert.equal(spawned.length, 0);

  assert.equal(runGrant(['reboot', 'sideways'], { ...base, uid: 0 }), 2);
  assert.match(err[1], /is not on or off/);

  assert.equal(runGrant(['reboot', 'on'], { ...base, uid: 0 }), 0);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'bash');
  assert.deepEqual(spawned[0].argv, ['/opt/fleetwright/current/install/install.sh', '--grant', 'reboot=on']);
  // The node this CLI runs on, so a deb box does not go looking for another.
  assert.equal(spawned[0].env.FLEETWRIGHT_NODE_BIN, '/usr/lib/fleetwright/node/bin/node');
  assert.throws(() => runGrant(['reboot', 'on'], { ...base, uid: 0, spawn: undefined }), /needs a spawn/);
});

test('grantPlan keeps a node somebody already named', () => {
  const p = grantPlan({ name: 'upgrades', to: 'off', root: '/r', node: '/n', env: { FLEETWRIGHT_NODE_BIN: '/mine' } });
  assert.equal(p.env.FLEETWRIGHT_NODE_BIN, '/mine');
  assert.deepEqual(p.argv, ['bash', '/r/install/install.sh', '--grant', 'upgrades=off']);
});

test('the refusals name the one line, and still show the rule for anyone who wants to audit it', () => {
  const cfg = /** @type {any} */ ({ systemReboot: false, systemUpgrade: false, runUser: 'user', installDir: '/opt/fleetwright/current' });
  const rb = reboot(cfg, []);
  assert.equal(rb.ok, false);
  assert.match(rb.text, /^Rebooting from chat is off\./);
  assert.match(rb.text, /\n  sudo fleetwright grant reboot on\n/);
  assert.match(rb.text, /user ALL=\(root\) NOPASSWD: \/usr\/bin\/systemctl reboot/);
  assert.match(rb.text, /dpkg-reconfigure fleetwright/);
  // NOT the four-step recipe any more.
  assert.doesNotMatch(rb.text, /sudo tee|chmod 0440/);

  const up = runUpgrade(cfg, { exec: () => ({ status: 0, stdout: '', stderr: '' }) });
  assert.match(up.text, /\n  sudo fleetwright grant upgrades on\n/);
  assert.match(up.text, /dpkg-reconfigure fleetwright/);
  assert.equal(runPackageUpgrade(cfg, { exec: () => ({ status: 0, stdout: '', stderr: '' }) }).text, up.text);
});

test('the answer travels: /updates says what the box allows, as booleans', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'grants-'));
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: { installDir: dir, stateDir: dir, hostname: 'h', releaseManifest: '', systemUpgrade: true, systemReboot: false } }),
      '/updates',
    );
    assert.deepEqual(r.waiting.grants, { upgrades: true, reboot: false });
    assert.deepEqual(grantsOf({}), { upgrades: false, reboot: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the sidecar carries the grants into the health frame, and an older hub is cannot-tell', () => {
  // adoptUpdates is the sidecar's own function; read the way updates-verb
  // does, because the file is a script and not a module.
  const src = readFileSync(here('bin/fleetwright-sidecar'), 'utf8');
  const fn = /function adoptUpdates\(waiting\) \{[\s\S]*?\n  \}/.exec(src)?.[0] ?? '';
  assert.ok(fn, 'adoptUpdates is gone');
  assert.match(fn, /grants:\s*\n?\s*waiting\.grants && typeof waiting\.grants === 'object'/);
  assert.match(fn, /: \(lastUpdates\?\.grants \?\? null\)/, 'an older hub is null, never off');
});

test('the installer has one place a grant is turned on or off, and three callers', () => {
  assert.match(SH, /^apply_grant\(\) \{/m);
  // The writers are called from apply_grant and nowhere else now.
  assert.equal((SH.match(/if write_upgrade_sudoers; then/g) || []).length, 1);
  assert.equal((SH.match(/if write_reboot_sudoers; then/g) || []).length, 1);
  // Off REMOVES the rule: a recorded 0 beside a rule on disk is drift.
  assert.match(SH, /upgrades:no\)\n\s+rm -f \/etc\/sudoers\.d\/fleetwright-upgrade/);
  assert.match(SH, /reboot:no\)\n\s+rm -f \/etc\/sudoers\.d\/fleetwright-reboot/);
  // The wizard, the repair and --grant.
  assert.match(SH, /if confirm "Allow system updates from chat\?" Y; then\n\s+apply_grant upgrades yes/);
  assert.match(SH, /if confirm "Allow reboot from chat\?" N; then\n\s+apply_grant reboot yes/);
  assert.match(SH, /FLEETWRIGHT_SYSTEM_UPGRADE\)" = 1 \]; then\n\s+apply_grant upgrades yes/);
  assert.match(SH, /FLEETWRIGHT_SYSTEM_REBOOT\)" = 1 \]; then\n\s+apply_grant reboot yes/);
  assert.match(SH, /--grant\)/);
  assert.match(SH, /GRANT_ONLY=1/);
  // THE GRANT MODE RUNS BEFORE SECTION 1, which is where the installer finds
  // its node — and set_env, which records the answer, runs node. The first
  // `sudo fleetwright grant reboot on` on a real box printed
  // "NODE_BIN: unbound variable" and changed nothing. So the block resolves
  // NODE_BIN itself, from the name the CLI hands in, before its first
  // apply_grant.
  const block = /if \[ "\$GRANT_ONLY" = 1 \]; then([\s\S]*?)\n\s+exit 0\nfi/.exec(SH)?.[1] ?? '';
  assert.ok(block, 'the grant-only block is gone');
  const finds = block.indexOf('NODE_BIN="${FLEETWRIGHT_NODE_BIN:-');
  const applies = block.indexOf('apply_grant ');
  assert.ok(finds >= 0, 'the grant-only block does not resolve NODE_BIN');
  assert.ok(applies > finds, 'the grant-only block applies a grant before it has a node to record it with');
  // A handed-in answer is applied instead of asked, even over a recorded one.
  assert.match(SH, /if \[ -n "\$GRANT_REBOOT" \] && command -v visudo/);
  assert.match(SH, /if \[ -n "\$GRANT_UPGRADES" \] && command -v visudo/);
  assert.match(SH, /FLEETWRIGHT_GRANT_REBOOT/);
  assert.match(SH, /FLEETWRIGHT_GRANT_UPGRADES/);
});

/** The installer, run with arguments, unprivileged: what it prints and how it exits. */
function grantRun(args) {
  try {
    return { out: execFileSync('bash', [here('install/install.sh'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }), status: 0 };
  } catch (e) {
    const err = /** @type {any} */ (e);
    return { out: String(err.stdout || '') + String(err.stderr || ''), status: err.status ?? 1 };
  }
}

test('--grant takes reboot=on|off and upgrades=on|off, and nothing else', () => {
  const bad = grantRun(['--grant', 'shell=on']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.out, /--grant takes reboot=on\|off or upgrades=on\|off/);
  const none = grantRun(['--grant']);
  assert.notEqual(none.status, 0);
  assert.match(none.out, /got: nothing/);
});
