// The sidecar runs code the session user cannot change.
//
//   node --test test/sidecar-store.test.js
//
// The sidecar has its own account so that the session user — and a session
// escape landing as it — cannot read /var/lib/fleetwright-sidecar/host-key.json.
// That is only a boundary if the session user cannot change what the account
// RUNS, and it could: the unit ran `node <base>/current/lib/fleetwright-sidecar.mjs`
// out of the release tree, which install.sh chowns to the session user so
// /update can apply releases. Rewrite the bundle, write the hub's restart
// marker, and Restart=always ran it as the sidecar. On top of that the account
// check ran before a function it called existed, failed everywhere, and put
// the sidecar back on the session user's uid — so the separation had never
// been in place on a Linux box.
//
// The rule these hold: nothing the sidecar executes, nor any directory or
// symlink on the way to it, may be the session user's to change; root fills
// the store the sidecar runs from only out of a tree the session user cannot
// reach; and where that cannot hold, the installer says so instead of
// claiming it.
//
// The installer's own functions are extracted and run, not re-implemented.
// The tests that write root-owned files need root, as sidecar-user.test.js's
// last test does; the rest run as anybody but `nobody`, which plays the
// session user throughout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SH_PATH = path.join(ROOT, 'install', 'install.sh');
const SH = readFileSync(SH_PATH, 'utf8');

const sh = (/** @type {string} */ script, /** @type {Record<string,string>} */ env = {}) =>
  spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, FW_INSTALL_SH: SH_PATH, ...env }, timeout: 120_000 });

/** A preamble that defines the named installer functions, as the installer has them. */
const functions = (/** @type {string[]} */ names) => `
fn() { awk -v name="$1" '$0 ~ "^"name"\\\\(\\\\) \\\\{" {p=1} p {print} p && /^}/ {exit}' "$FW_INSTALL_SH"; }
${names.map((n) => `eval "$(fn ${n})"`).join('\n')}
ok() { printf 'ok   %s\\n' "$*"; }; warn() { printf 'warn %s\\n' "$*"; }
`;
const ALTER = ['run_user_can_alter', '_rua_bits', '_rua_walk'];

const root = typeof process.getuid === 'function' && process.getuid() === 0;
const nobody = spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' });
const nobodyUid = nobody.status === 0 ? nobody.stdout.trim() : null;
const gnuStat = spawnSync('stat', ['-c', '%u', '/'], { encoding: 'utf8' }).status === 0;
const canAsk = nobodyUid !== null && gnuStat && String(process.getuid?.()) !== nobodyUid;

test('the service user can change a path through any directory on the way to it', { skip: !canAsk && 'needs GNU stat and a nobody account that is not this user' }, () => {
  const t = mkdtempSync(path.join(tmpdir(), 'rua-'));
  try {
    chmodSync(t, 0o755);
    const p = (/** @type {string} */ rel) => path.join(t, rel);
    mkdirSync(p('ro')); writeFileSync(p('ro/file'), '');
    writeFileSync(p('ro/everyone'), ''); chmodSync(p('ro/everyone'), 0o666);
    mkdirSync(p('open')); chmodSync(p('open'), 0o777); writeFileSync(p('open/file'), '');
    mkdirSync(p('open/target'));
    symlinkSync('/usr/bin', p('open/link'));
    mkdirSync(p('safe')); symlinkSync(p('open/target'), p('safe/via'));
    symlinkSync('/usr/bin/env', p('safe/system'));
    // What the deb's postinst and fleetwright-migrate copy from: a 0700
    // directory of somebody else's under sticky /tmp, whatever is inside it.
    mkdirSync(p('sealed/inner'), { recursive: true }); chmodSync(p('sealed'), 0o700);
    writeFileSync(p('sealed/inner/file'), ''); chmodSync(p('sealed/inner/file'), 0o666);

    const cases = [
      ['/usr/bin/env', false, 'a root-owned file in root-owned directories'],
      [p('ro/file'), false, 'a file in a directory only its owner writes'],
      [p('ro'), true, 'a directory holding a world-writable file'],
      [p('ro/everyone'), true, 'a world-writable file'],
      [p('open/file'), true, 'a 0644 file whose directory anybody can write'],
      [p('open/link'), true, 'a symlink to /usr/bin whose directory anybody can write — the `current` case'],
      [p('safe/via'), true, 'a safe symlink that lands in a directory anybody can write'],
      [p('safe/system'), false, 'a safe symlink to a safe place'],
      [p('sealed'), false, 'a 0700 directory of somebody else’s, under sticky /tmp'],
      [p('sealed/inner/file'), false, 'a 0666 file nobody else can reach'],
      [p('ro/missing'), false, 'nothing there, in a directory they cannot write'],
      [p('open/missing'), true, 'nothing there, in a directory they can write'],
    ];
    const script = `${functions(ALTER)}
RUN_USER=nobody
while IFS= read -r q; do
  if run_user_can_alter "$q"; then echo "yes $q"; else echo "no  $q"; fi
done <<< "$CASES"`;
    const r = sh(script, { CASES: cases.map(([q]) => q).join('\n') });
    const answers = new Map(r.stdout.trim().split('\n').map((l) => [l.slice(4), l.startsWith('yes')]));
    for (const [q, want, why] of cases) {
      assert.equal(answers.get(/** @type {string} */ (q)), want, `${why}: ${q}\n${r.stdout}${r.stderr}`);
    }
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('a file the service user owns is theirs wherever it sits', { skip: !(root && canAsk) && 'needs root to give a file away' }, () => {
  const t = mkdtempSync(path.join(tmpdir(), 'rua-own-'));
  try {
    chmodSync(t, 0o755);
    mkdirSync(path.join(t, 'tree'));
    writeFileSync(path.join(t, 'tree', 'f'), '');
    spawnSync('chown', ['nobody', path.join(t, 'tree', 'f')]);
    const r = sh(`${functions(ALTER)}\nRUN_USER=nobody\nrun_user_can_alter "$P" && echo yes || echo no`, { P: path.join(t, 'tree') });
    assert.equal(r.stdout.trim(), 'yes', r.stderr);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- the store ----------------------------------------------------------------

/** Build a release once and unpack it into a 0700 directory, as postinst does. */
function sealedRelease(/** @type {string} */ work, /** @type {string} */ version) {
  const dist = path.join(work, `dist-${version}`);
  const built = spawnSync(process.execPath, ['tools/build-host-package.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_VERSION: version, RELEASE_OUT_DIR: dist },
  });
  if (built.status !== 0) return null;
  const sealed = path.join(work, `sealed-${version}`);
  mkdirSync(sealed, { mode: 0o700 });
  const tarball = readdirSync(dist).find((f) => f.endsWith('.tar.gz'));
  spawnSync('tar', ['-xzf', path.join(dist, tarball ?? ''), '-C', sealed]);
  return { sealed, tree: path.join(sealed, readdirSync(sealed)[0]) };
}

const STORE_FNS = [...ALTER, 'refresh_sidecar_store'];
const refresh = (/** @type {Record<string,string>} */ v) => sh(`${functions(STORE_FNS)}
set -euo pipefail
PLATFORM=linux RUN_USER=nobody SIDECAR_USER=fleetwright-sidecar CHECK_ONLY=0 PACKAGED=1 CONVERTED=0 FROM_SOURCE=0
SELF_DIR="$SRC" SIDECAR_BASE="$STORE" FLEET_BASE="$BASE"
refresh_sidecar_store
echo "SIDECAR_STORE=$SIDECAR_STORE"`, v);

test('root fills the store only from a release the service user cannot reach', { skip: !(root && canAsk) && 'needs root: the store is root-owned' }, (t) => {
  const work = mkdtempSync(path.join(tmpdir(), 'store-'));
  try {
    chmodSync(work, 0o755);
    const one = sealedRelease(work, 'v-one');
    const two = sealedRelease(work, 'v-two');
    const three = sealedRelease(work, 'v-three');
    if (!one || !two || !three) return t.skip('the release could not be built here');
    const env = { STORE: path.join(work, 'store'), BASE: path.join(work, 'base') };

    // The verified extract: copied, root's, and nothing in it the service user can change.
    let r = refresh({ ...env, SRC: one.tree });
    assert.match(r.stdout, /SIDECAR_STORE=1/, r.stdout + r.stderr);
    const store = env.STORE;
    assert.equal(readFileSync(path.join(store, 'current', 'package.json'), 'utf8').includes('"v-one"'), true);
    assert.equal(statSync(path.join(store, 'launch.mjs')).uid, 0);
    const loose = spawnSync('find', [store, '!', '-type', 'l', '(', '!', '-user', '0', '-o', '-perm', '/022', ')'], { encoding: 'utf8' });
    assert.equal(loose.stdout, '', `left changeable in the store:\n${loose.stdout}`);
    assert.equal(sh(`${functions(ALTER)}\nRUN_USER=nobody\nrun_user_can_alter "$P" && echo yes || echo no`, { P: store }).stdout.trim(), 'no');

    // THE RELEASE TREE IS NEVER A SOURCE. A tree the service user can reach —
    // here, one of its files left world-writable in a directory anybody can
    // enter, which is what `current` is to that user — is refused, and the
    // sidecar keeps the copy it has, saying it is behind.
    chmodSync(two.sealed, 0o755);
    chmodSync(path.join(two.tree, 'lib', 'fleetwright-sidecar.mjs'), 0o666);
    r = refresh({ ...env, SRC: two.tree });
    assert.match(r.stdout, /SIDECAR_STORE=1/);
    assert.match(r.stdout, /keeps running/);
    assert.match(readFileSync(path.join(store, 'current', 'package.json'), 'utf8'), /"v-one"/, 'copied out of a tree the service user can change');

    // No store yet and no verified tree: nothing is made, and the unit falls
    // back to the tree the hub runs — where the check below speaks up.
    r = refresh({ ...env, STORE: path.join(work, 'empty-store'), SRC: two.tree });
    assert.match(r.stdout, /SIDECAR_STORE=0/);

    // THE ONE BEFORE IS KEPT: it is what a rollback points `current` back at.
    chmodSync(two.sealed, 0o700);
    chmodSync(path.join(two.tree, 'lib', 'fleetwright-sidecar.mjs'), 0o644);
    refresh({ ...env, SRC: two.tree });
    refresh({ ...env, SRC: three.tree });
    assert.deepEqual(readdirSync(path.join(store, 'releases')).sort(), ['v-three', 'v-two']);
    // And re-copying the live release replaced nothing, so nothing goes.
    refresh({ ...env, SRC: three.tree });
    assert.deepEqual(readdirSync(path.join(store, 'releases')).sort(), ['v-three', 'v-two']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

// --- the unit -----------------------------------------------------------------

/** The sidecar unit as install_unit writes it, into a directory of the test's. */
function renderSidecarUnit(/** @type {{ store: boolean, dir: string, base: string, sidecarBase: string, node: string }} */ o) {
  const out = mkdtempSync(path.join(tmpdir(), 'unit-'));
  // The function as written, with only its destination moved off the machine.
  const fns = ['install_unit', 'unit_entry', 'sidecar_dir', 'sidecar_entry', 'launchd_path']
    .map((n) => {
      const start = SH.indexOf(`${n}() {`);
      const end = n.startsWith('sidecar_') ? SH.indexOf('\n', start) : SH.indexOf('\n}\n', start) + 2;
      return SH.slice(start, end);
    })
    .join('\n')
    .replaceAll('/etc/systemd/system/', '$X_OUT/');
  const r = sh(`set -euo pipefail
ok() { :; }; warn() { :; }
${fns}
PLATFORM=linux SELF_DIR="$X_SELF" DIR="$X_DIR" FLEET_BASE="$X_BASE"
RUN_USER=alice SIDECAR_USER=fleetwright-sidecar NODE_BIN=/usr/bin/node SIDECAR_NODE_BIN="$X_NODE" UNIT_NODE_BIN=/usr/bin/node CLAUDE_BIN=
STATE_DIR=/var/lib/fleetwright SIDECAR_BASE="$X_SIDECAR_BASE" SIDECAR_STORE=${o.store ? 1 : 0}
install_unit fleetwright-sidecar`, { X_OUT: out, X_SELF: ROOT, X_DIR: o.dir, X_BASE: o.base, X_NODE: o.node, X_SIDECAR_BASE: o.sidecarBase });
  const unit = readFileSync(path.join(out, 'fleetwright-sidecar.service'), 'utf8');
  return { unit, out, r };
}

test('on a packaged box the sidecar unit runs root’s store, and reads the release tree only for its version', () => {
  const base = '/opt/fleetwright';
  const { unit, out } = renderSidecarUnit({ store: true, dir: `${base}/current`, base, sidecarBase: '/usr/local/lib/fleetwright-sidecar', node: '/usr/bin/node' });
  try {
    const line = (/** @type {string} */ k) => unit.split('\n').find((l) => l.startsWith(`${k}=`)) ?? '';
    assert.equal(line('ExecStart'), 'ExecStart=/usr/bin/node /usr/local/lib/fleetwright-sidecar/launch.mjs');
    assert.equal(line('WorkingDirectory'), 'WorkingDirectory=/usr/local/lib/fleetwright-sidecar');
    assert.equal(line('User'), 'User=fleetwright-sidecar');
    // Nothing that runs, and nowhere it runs in, is under the release tree.
    for (const k of ['ExecStart', 'WorkingDirectory']) assert.doesNotMatch(line(k), new RegExp(base), `${k} names the release tree`);
    assert.equal(line('Environment'), `Environment=FLEETWRIGHT_INSTALL_DIR=${base}/current`);
    assert.doesNotMatch(unit, /__[A-Z_]+__/, 'a placeholder was left in the unit');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('the rendered unit is one systemd accepts', { skip: !(root && spawnSync('sh', ['-c', 'command -v systemd-analyze']).status === 0) && 'needs root and systemd-analyze' }, () => {
  const sidecarBase = mkdtempSync(path.join(tmpdir(), 'sbase-'));
  writeFileSync(path.join(sidecarBase, 'launch.mjs'), '');
  const { unit, out } = renderSidecarUnit({ store: true, dir: sidecarBase, base: '/opt/fleetwright', sidecarBase, node: process.execPath });
  try {
    // User= names an account this machine may not have; verify is about the
    // unit's shape, so it is given one that exists everywhere.
    writeFileSync(path.join(out, 'fleetwright-sidecar.service'), unit.replace(/^User=.*$/m, 'User=root'));
    const r = spawnSync('systemd-analyze', ['verify', path.join(out, 'fleetwright-sidecar.service')], { encoding: 'utf8' });
    const complaints = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.includes('fleetwright-sidecar.service') && !/fleetwright\.service|network-online/.test(l));
    assert.deepEqual(complaints, [], complaints.join('\n'));
  } finally {
    rmSync(out, { recursive: true, force: true });
    rmSync(sidecarBase, { recursive: true, force: true });
  }
});

// --- saying so ------------------------------------------------------------------

test('the account check names what the service user could change, rather than claiming a boundary', { skip: !canAsk && 'needs GNU stat and a nobody account that is not this user' }, () => {
  const start = SH.indexOf('SIDECAR_EXPOSED=""\nif');
  assert.ok(start > 0, 'the separation check is gone');
  const block = SH.slice(start, SH.indexOf('\nfi\n', start) + 4);
  const t = mkdtempSync(path.join(tmpdir(), 'exposed-'));
  try {
    chmodSync(t, 0o755);
    mkdirSync(path.join(t, 'store', 'current', 'lib'), { recursive: true });
    writeFileSync(path.join(t, 'store', 'launch.mjs'), '');
    const run = () => sh(`${functions(ALTER)}
PLATFORM=linux RUN_USER=nobody SIDECAR_USER=fleetwright-sidecar CHECK_ONLY=0 SIDECAR_NODE_BIN=/usr/bin/env
sidecar_entry() { printf '%s/store/launch.mjs' "$T"; }
sidecar_dir() { printf '%s/store' "$T"; }
${block}
echo "EXPOSED=$SIDECAR_EXPOSED"`, { T: t });
    let r = run();
    assert.match(r.stdout, /^EXPOSED=$/m, r.stdout + r.stderr);
    assert.match(r.stdout, /out of its reach/);

    // A launcher the service user can rewrite is code it runs as the sidecar.
    chmodSync(path.join(t, 'store', 'launch.mjs'), 0o666);
    r = run();
    assert.match(r.stdout, new RegExp(`EXPOSED=.*${t}/store/launch\\.mjs`));
    assert.match(r.stdout, /NOT protected from nobody/);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('the account check runs where the functions it calls exist, after the store is filled', () => {
  // THE REGRESSION. It ran above unit_entry's definition, so `$(unit_entry …)`
  // was "command not found", the probe failed on every box, and the sidecar
  // fell back to the session user's uid everywhere.
  const probe = SH.indexOf("# CAN THE SIDECAR'S ACCOUNT RUN THE SIDECAR");
  assert.ok(probe > 0);
  for (const def of ['unit_entry() {', 'sidecar_entry() {', 'sidecar_dir() {', 'run_user_can_alter() {']) {
    assert.ok(SH.indexOf(def) > 0 && SH.indexOf(def) < probe, `${def} is defined after the probe that calls it`);
  }
  const call = SH.indexOf('\nrefresh_sidecar_store\n');
  assert.ok(call > 0 && call < probe, 'the store is filled after the check that reads it');
  assert.ok(call < SH.indexOf('\ninstall_unit fleetwright-sidecar\n'), 'the unit is written before the store it names');
});

// --- the launcher ---------------------------------------------------------------

test('launch.mjs follows the hub’s release when root holds a copy of it, and only then', () => {
  const store = mkdtempSync(path.join(tmpdir(), 'launch-'));
  try {
    for (const v of ['v1', 'v2']) {
      mkdirSync(path.join(store, 'releases', v, 'lib'), { recursive: true });
      writeFileSync(path.join(store, 'releases', v, 'lib', 'fleetwright-sidecar.mjs'), `console.log('ran ${v}');\n`);
    }
    symlinkSync('releases/v2', path.join(store, 'current'));
    copyFileSync(path.join(ROOT, 'install', 'fleetwright-sidecar-launch.mjs'), path.join(store, 'launch.mjs'));
    const hub = path.join(store, 'hub');
    mkdirSync(hub);
    const launch = (/** @type {string|null} */ version) => {
      if (version !== null) writeFileSync(path.join(hub, 'package.json'), JSON.stringify({ version }));
      const env = { ...process.env };
      if (version === null) delete env.FLEETWRIGHT_INSTALL_DIR;
      else env.FLEETWRIGHT_INSTALL_DIR = hub;
      return spawnSync(process.execPath, [path.join(store, 'launch.mjs')], { encoding: 'utf8', env });
    };

    // The rollback: the watchdog put the hub back on v1, and root kept v1.
    assert.equal(launch('v1').stdout.trim(), 'ran v1');
    assert.equal(launch('v2').stdout.trim(), 'ran v2');
    // The skew: the hub moved without root. The sidecar stays on root's newest
    // copy and says why, on stderr, because stdout is the stdio transport.
    const ahead = launch('v3');
    assert.equal(ahead.stdout.trim(), 'ran v2');
    assert.match(ahead.stderr, /the hub runs v3 and root has no copy of it/);
    // A version is a name. One that walks out of releases/ selects nothing.
    assert.equal(launch('../releases/v1').stdout.trim(), 'ran v2');
    assert.equal(launch(null).stdout.trim(), 'ran v2');
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

// --- the two places root used to run the release tree -----------------------------

test('purge and uninstall reach the sidecar only through root’s copy', () => {
  const postrm = readFileSync(path.join(ROOT, 'install', 'deb', 'postrm'), 'utf8');
  // The store's uninstaller first; `current` — the service user's — only on a box with none.
  assert.ok(postrm.indexOf('"$STORE/current/install/uninstall.sh"') > 0);
  assert.ok(postrm.indexOf('"$STORE/current/install/uninstall.sh"') < postrm.indexOf('"$BASE/current/install/uninstall.sh"'));
  const un = readFileSync(path.join(ROOT, 'install', 'uninstall.sh'), 'utf8');
  // Run as the sidecar's account only from the store; the release tree only as the session user.
  assert.match(un, /sudo -u "\$SIDECAR_USER" "\$SIDECAR_BASE\/current\/bin\/fleetwright-sidecar" identity/);
  assert.doesNotMatch(un, /sudo -u "\$SIDECAR_USER" "\$DIR\//);
  assert.match(un, /rm -rf "\$\{SIDECAR_BASE:\?\}"/);
});
