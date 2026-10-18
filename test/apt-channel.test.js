// /channel on a box apt owns: the suite is one word on a root-owned sources
// line, so changing it is a unit the hub may start, and the unit's script is
// what moves the word.
//
//   node --test test/apt-channel.test.js
//
// ASKED FOR: "Want to be able to switch apt channels between release and
// rolling". The property under test is the one test/channel.test.js keeps for
// the manifest channel: what the app is TOLD is what the box will do next. So
// the script is run for real against a temporary /etc, and the hub's half is
// tested with a stand-in for sudo that does what the unit would, so the reply
// can be checked against the file the next `apt-get` reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { APT_CHANNEL_UNIT, aptChannelUnit, aptSuite, pinnedByEnv, readChannel, switchAptSuite } from '../src/core/channel.js';
import { dispatch } from '../src/adapters/commands.js';

const here = (/** @type {string} */ p) => new URL(`../${p}`, import.meta.url).pathname;
const SCRIPT = here('install/fleetwright-apt-channel');
const UNIT = here('install/fleetwright-apt-channel@.service');

const STABLE = 'deb [arch=amd64 signed-by=/usr/share/keyrings/fleetwright.gpg] https://fleet-apt.thetech.network stable main\n';
const ROLLING = STABLE.replace(' stable main', ' rolling main');

/**
 * A temporary /etc with a sources line, a preferences slot, and an apt-get
 * that records how it was called instead of fetching anything.
 * @param {import('node:test').TestContext} t
 * @param {string} sources
 */
function box(t, sources) {
  const dir = mkdtempSync(path.join(tmpdir(), 'apt-channel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    FLEETWRIGHT_APT_SOURCES: path.join(dir, 'fleetwright.list'),
    FLEETWRIGHT_APT_PREFS: path.join(dir, 'fleetwright-channel'),
    FLEETWRIGHT_APT_GET: path.join(dir, 'apt-get'),
  };
  writeFileSync(env.FLEETWRIGHT_APT_SOURCES, sources);
  writeFileSync(env.FLEETWRIGHT_APT_GET, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${path.join(dir, 'apt-get.calls')}"\n`);
  chmodSync(env.FLEETWRIGHT_APT_GET, 0o755);
  /** @param {string} suite */
  const run = (suite) => spawnSync('sh', [SCRIPT, suite], { encoding: 'utf8', env: { ...process.env, ...env } });
  const calls = () => (existsSync(path.join(dir, 'apt-get.calls')) ? readFileSync(path.join(dir, 'apt-get.calls'), 'utf8').trim().split('\n') : []);
  return { dir, env, run, calls, sources: () => readFileSync(env.FLEETWRIGHT_APT_SOURCES, 'utf8'), prefs: () => (existsSync(env.FLEETWRIGHT_APT_PREFS) ? readFileSync(env.FLEETWRIGHT_APT_PREFS, 'utf8') : null) };
}

test('stable to rolling: the suite word moves, the rest of the line stays, any pin goes, the lists are refreshed', (t) => {
  const b = box(t, STABLE);
  // A pin from before 0.4.12, when the build sorted below every release and
  // rolling was the side that needed one. It must not survive: with the build
  // above the release it follows, rolling is an upgrade and the pin would only
  // be a stale claim in /etc.
  writeFileSync(b.env.FLEETWRIGHT_APT_PREFS, 'Package: fleetwright\nPin: release o=Fleetwright,a=rolling\nPin-Priority: 1001\n');
  const r = b.run('rolling');
  assert.equal(r.status, 0, r.stderr);
  // Only the one word: the architecture, the keyring and the address are
  // whatever the image or the installer wrote, and are not this script's.
  assert.equal(b.sources(), ROLLING);
  assert.equal(b.prefs(), null, 'a build of main outranks the release it follows, so rolling needs no pin and keeps none');
  assert.deepEqual(b.calls(), ['update'], 'apt-get update, once, and nothing else');
  // The hub reads the same file the next apt-get does.
  assert.equal(aptSuite({ aptSources: b.env.FLEETWRIGHT_APT_SOURCES }), 'rolling');
});

test('rolling to stable: the word moves back and the package is pinned to stable, because the release is the downgrade now', (t) => {
  const b = box(t, ROLLING);
  const r = b.run('stable');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(b.sources(), STABLE);
  // THE PIN IS WHAT MAKES THE WAY BACK INSTALLABLE. A build of main is
  // <base>+main.<run>, above the release it follows, so without a priority
  // above 1000 apt would keep the build and the box would report a suite it
  // never takes from.
  const prefs = b.prefs();
  assert.ok(prefs, 'no pin was written');
  assert.match(prefs, /^Package: fleetwright$/m);
  assert.match(prefs, /^Pin: release o=Fleetwright,a=stable$/m, 'the pin must name the suite the repository publishes (tools/build-apt-repo.sh)');
  assert.match(prefs, /^Pin-Priority: 1001$/m);
  assert.deepEqual(b.calls(), ['update']);
  assert.equal(aptSuite({ aptSources: b.env.FLEETWRIGHT_APT_SOURCES }), 'stable');
});

test('a word that is not a suite, a box with no line, and a line of another shape are each refused with the file untouched', (t) => {
  const b = box(t, STABLE);
  assert.equal(b.run('testing').status, 2);
  assert.equal(b.run('').status, 2);
  assert.equal(b.sources(), STABLE);
  assert.deepEqual(b.calls(), [], 'nothing was fetched for a refused word');

  // Not an apt box: the file is simply absent.
  rmSync(b.env.FLEETWRIGHT_APT_SOURCES);
  const none = b.run('rolling');
  assert.equal(none.status, 3);
  assert.match(none.stderr, /does not take Fleetwright from apt/);

  // A line this script does not understand is left exactly as it was: a
  // rewrite it only half understood is how a box ends up with a source apt
  // cannot read.
  const odd = 'deb-src https://example.invalid stable main\n# a comment\n';
  writeFileSync(b.env.FLEETWRIGHT_APT_SOURCES, odd);
  const r = b.run('rolling');
  assert.equal(r.status, 4);
  assert.match(r.stderr, /left alone/);
  assert.equal(b.sources(), odd);
  assert.equal(b.prefs(), null);
  assert.deepEqual(b.calls(), []);
});

test('the unit runs the script with its instance as the suite, and the grant names the two instances and no wildcard', (t) => {
  const unit = readFileSync(UNIT, 'utf8');
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^User=root$/m);
  assert.match(unit, /^ExecStart=\/usr\/local\/sbin\/fleetwright-apt-channel %i$/m, 'the instance is the suite, and the only argument');
  assert.doesNotMatch(unit, /^Protect|^Private|^NoNewPrivileges|^Restrict/m, 'the unit sandboxes the thing that must rewrite /etc');

  const installer = readFileSync(here('install/install.sh'), 'utf8');
  const fn = /write_upgrade_sudoers\(\) \{[\s\S]*?\n\}/.exec(installer)?.[0] ?? '';
  assert.match(fn, /systemctl start fleetwright-apt-channel@stable\.service/);
  assert.match(fn, /systemctl start fleetwright-apt-channel@rolling\.service/);
  // Two exact lines, never the template with a wildcard: sudo matches the
  // whole argv, and a wildcard would let the hub name any instance.
  assert.doesNotMatch(fn, /systemctl start fleetwright-apt-channel@(?!stable\.service|rolling\.service)/, 'a granted instance that is not one of the two');
  assert.match(installer, /install_unit fleetwright-apt-channel@/, 'the grant names a unit the installer does not install');
  assert.match(installer, /install -m 0755 -o root -g root .*fleetwright-apt-channel" \/usr\/local\/sbin\/fleetwright-apt-channel/, 'the unit runs a script the installer does not put there');
  // And the uninstaller takes both away again.
  const un = readFileSync(here('install/uninstall.sh'), 'utf8');
  assert.match(un, /fleetwright-apt-channel@\.service/);
  assert.match(un, /\/usr\/local\/sbin\/fleetwright-apt-channel/);
  // The names the hub uses are the names the files have.
  assert.equal(aptChannelUnit('rolling'), 'fleetwright-apt-channel@rolling.service');
  assert.equal(`${APT_CHANNEL_UNIT}.service`, path.basename(UNIT));

  if (spawnSync('systemd-analyze', ['--version']).status !== 0) return t.skip('no systemd-analyze on this box');
  // Verified as a copy whose ExecStart names the script where this checkout
  // has it: systemd-analyze refuses a unit whose command is not on the box,
  // and the box running the tests is not one the installer has been over.
  const dir = mkdtempSync(path.join(tmpdir(), 'apt-channel-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const copy = path.join(dir, path.basename(UNIT));
  // ExecStart= by name: the unit's comment names the path too, and a plain
  // replace would move the comment and leave the command.
  writeFileSync(copy, unit.replace(/^ExecStart=\S+/m, `ExecStart=${SCRIPT}`));
  const r = spawnSync('systemd-analyze', ['verify', copy], { encoding: 'utf8' });
  assert.equal(r.status, 0, `systemd-analyze verify: ${r.stderr}${r.stdout}`);
});

/**
 * A stand-in for sudo: records the argv and, on the unit the real grant
 * permits, does what the unit would do to the fixture file.
 * @param {string} sources  the fixture's sources path
 * @param {{ refuse?: boolean, fail?: string, noop?: boolean }} [how]
 */
function fakeSudo(sources, { refuse = false, fail = '', noop = false } = {}) {
  /** @type {string[]} */
  const calls = [];
  const exec = (/** @type {string[]} */ argv) => {
    calls.push(argv.join(' '));
    if (refuse) return { status: 1, stdout: '', stderr: `Sorry, user agent is not allowed to execute '${argv.slice(2).join(' ')}' as root` };
    if (fail) return { status: 1, stdout: '', stderr: fail };
    const m = /^sudo -n \/usr\/bin\/systemctl start fleetwright-apt-channel@(stable|rolling)\.service$/.exec(argv.join(' '));
    if (!m) return { status: 1, stdout: '', stderr: 'not a command this stand-in knows' };
    if (!noop) writeFileSync(sources, m[1] === 'rolling' ? ROLLING : STABLE);
    return { status: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

/** @param {import('node:test').TestContext} t @param {string} sources @param {object} [extra] */
function aptBox(t, sources, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'apt-box-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'fleetwright.list');
  writeFileSync(file, sources);
  const cfg = /** @type {any} */ ({ stateDir: dir, releaseSource: 'apt', aptSources: file, systemUpgrade: true, installDir: '/opt/fleetwright/current', releaseChannel: '', ...extra });
  return { cfg, file };
}

test('the switch starts exactly the granted unit, then reports the suite read back from the line', (t) => {
  const { cfg, file } = aptBox(t, STABLE);
  const { exec, calls } = fakeSudo(file);
  const r = switchAptSuite(cfg, 'rolling', { exec });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.channel, 'rolling');
  assert.deepEqual(calls, ['sudo -n /usr/bin/systemctl start fleetwright-apt-channel@rolling.service'], 'the whole privilege is starting the one named instance');
  assert.match(r.message, /ordinary upgrade/, 'a build of main outranks the release it follows');
  // What the hub reads next agrees with what it just said.
  assert.equal(readChannel(cfg), 'rolling');

  const back = switchAptSuite(cfg, 'stable', { exec });
  assert.equal(back.ok, true);
  assert.match(back.message, /downgrade/, 'says why the way back needs the pin');
  assert.equal(readChannel(cfg), 'stable');
  assert.equal(calls.length, 2);
});

test('a unit that ran and changed nothing is reported as that, not as a switch', (t) => {
  // C-5: the reply is the line, not the request.
  const { cfg, file } = aptBox(t, STABLE);
  const { exec } = fakeSudo(file, { noop: true });
  const r = switchAptSuite(cfg, 'rolling', { exec });
  assert.equal(r.ok, false);
  assert.equal(r.channel, 'stable');
  assert.match(r.message, /still names the stable suite/);
});

test('already on the suite asked for is a yes that starts nothing', (t) => {
  const { cfg, file } = aptBox(t, ROLLING);
  const { exec, calls } = fakeSudo(file);
  const r = switchAptSuite(cfg, 'rolling', { exec });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, []);
});

test('without the upgrade grant the box is pinned, and the answer names the command that grants it', (t) => {
  const { cfg, file } = aptBox(t, STABLE, { systemUpgrade: false });
  assert.equal(pinnedByEnv(cfg), true);
  const { exec, calls } = fakeSudo(file);
  const r = switchAptSuite(cfg, 'rolling', { exec });
  assert.equal(r.ok, false);
  assert.deepEqual(calls, [], 'nothing was tried: the unit is installed by the same decision as the grant');
  assert.match(r.message, /sudo fleetwright grant upgrades on/);
  assert.match(r.message, /by hand/);
  // With the grant, the same box is not pinned: the picker is any box's.
  assert.equal(pinnedByEnv({ ...cfg, systemUpgrade: true }), false);
});

test('a grant that predates the unit is told about --repair; a unit that fails is quoted', (t) => {
  const { cfg, file } = aptBox(t, STABLE);
  const old = switchAptSuite(cfg, 'rolling', { exec: fakeSudo(file, { refuse: true }).exec });
  assert.equal(old.ok, false);
  assert.match(old.message, /install\.sh --repair/);
  const broke = switchAptSuite(cfg, 'rolling', { exec: fakeSudo(file, { fail: 'Job for fleetwright-apt-channel@rolling.service failed.' }).exec });
  assert.equal(broke.ok, false);
  assert.match(broke.message, /failed/);
  assert.equal(readChannel(cfg), 'stable');
});

test('/channel on an apt box answers with data, moves the suite through the unit, and reports what it reads back', async (t) => {
  const { cfg, file } = aptBox(t, STABLE);
  const { exec, calls } = fakeSudo(file);
  const ctx = /** @type {any} */ ({ cfg, exec });
  const asked = await dispatch(ctx, '/channel');
  assert.equal(asked.channel, 'stable');
  assert.equal(asked.channelPinned, false, 'with the grant, an apt box offers the picker');
  assert.match(asked.text, /stable suite/);

  const moved = await dispatch(ctx, '/channel rolling');
  assert.equal(moved.ok, true, moved.text);
  assert.equal(moved.channel, 'rolling');
  assert.equal(moved.channelPinned, false);
  assert.equal(calls.length, 1);
  assert.equal((await dispatch(ctx, '/channel')).channel, 'rolling');

  const bad = await dispatch(ctx, '/channel testing');
  assert.equal(bad.ok, false);
  assert.equal(bad.channel, 'rolling', 'a refused word leaves the box where it was, and says so');
  assert.equal(calls.length, 1, 'nothing was started for a word that is not a suite');
});

test('/channel on an apt box without the grant is pinned and says which command grants it', async (t) => {
  const { cfg } = aptBox(t, ROLLING, { systemUpgrade: false });
  const asked = await dispatch(/** @type {any} */ ({ cfg }), '/channel');
  assert.equal(asked.channel, 'rolling');
  assert.equal(asked.channelPinned, true);
  assert.match(asked.text, /grant upgrades on/);
  const refused = await dispatch(/** @type {any} */ ({ cfg }), '/channel stable');
  assert.equal(refused.ok, false);
  assert.equal(refused.channelPinned, true);
});
