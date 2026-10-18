// Root runs and installs only what the installer brought, never the payload.
//
//   node --test test/install-root-sources.test.js
//
// On every packaged route install.sh's $DIR is, or becomes, `current` — the
// service user's tree, chowned to it so /update can apply releases. Its own
// tree, $SELF_DIR, is what root vouched for: the deb's sha-checked extract,
// the tarball bootstrap.sh checked, the copy fleetwright-migrate checked. The
// header of install.sh records that root executing what the service user can
// rewrite is root with extra steps; these hold the places that still did.
//
// The worst of them was deterministic and needed no person: the heal runs
// install.sh --repair with `current` as the payload, and that installed
// $DIR/install/fleetwright-migrate as the root-owned helper the service user
// may run through sudo. Edit the file, `sudo -n fleetwright-migrate`, and the
// next `sudo -n fleetwright-migrate` was the edit, as root.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';

const SH = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');

test('the root helper sudoers names is installed from the installer’s tree, not the payload', () => {
  // The block itself, run with `install` and the sudoers writer stood in for,
  // against a payload and an installer tree that each carry a helper.
  const start = SH.indexOf('if [ "$PLATFORM" = macos ]; then\n  say "the release-migration helper');
  assert.ok(start > 0, 'the helper block moved');
  const block = SH.slice(start, SH.indexOf('\nfi\n', start) + 4);
  const t = mkdtempSync(path.join(tmpdir(), 'helper-'));
  try {
    for (const d of ['self', 'payload']) {
      mkdirSync(path.join(t, d, 'install'), { recursive: true });
      writeFileSync(path.join(t, d, 'install', 'fleetwright-migrate'), d);
    }
    const r = spawnSync('bash', ['-c', `
install() { echo "install $*"; }
write_migrate_sudoers() { return 0; }
ok() { :; }; warn() { :; }; say() { :; }
PLATFORM=linux CHECK_ONLY=0 SELF_DIR=${JSON.stringify(path.join(t, 'self'))} DIR=${JSON.stringify(path.join(t, 'payload'))}
${block}`], { encoding: 'utf8' });
    assert.match(r.stdout, new RegExp(`install -m 0755 -o root -g root ${t}/self/install/fleetwright-migrate /usr/local/sbin/fleetwright-migrate`), r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /payload/);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('nothing in the payload is executed by root: the protocol read, the login, the clean', () => {
  const upgrade = SH.slice(SH.indexOf('# --- 9. --upgrade'));
  // The import is code in $DIR; it runs as the service user, whose tree it is.
  const line = upgrade.split('\n').find((l) => l.includes("src/fleet/protocol/intents.js')")) ?? '';
  assert.match(line, /UPGRADE_MINE="\$\(as_user /, `the protocol import runs as root: ${line.trim()}`);
  // The same for the login the wizard starts and the code it hands back.
  assert.match(SH, /LOGIN_OUT="\$\(as_user "'\$UNIT_NODE_BIN' '\$DIR\/bin\/fleetwright' login"/);
  assert.match(SH, /as_user "'\$UNIT_NODE_BIN' '\$DIR\/bin\/fleetwright' code /);
  // And the clean, and the sidecar's environment template, from this installer.
  assert.match(SH, /"\$SELF_DIR\/install\/uninstall\.sh" --yes/);
  assert.match(SH, /TEMPLATE="\$SELF_DIR\/install\/fleetwright-sidecar\.env\.example"/);
  // No line of the installer starts by executing a payload file as root.
  for (const l of SH.split('\n')) {
    if (/^\s*#/.test(l)) continue;
    assert.doesNotMatch(l, /^\s*(?:if \w+="\$\()?"\$DIR\/(?:bin|install)\//, `root runs a payload file: ${l.trim()}`);
  }
});

// --- root's commands, and what else root did in the service user's reach --------
//
// The eighth audit's half of the same rule. `sudo fleetwright grant …`, `join`
// and `doctor --repair` are advice this product prints everywhere, and the link
// they went through pointed into `current`; the installer itself ran the
// service user's claude, wrote through their home, and let them steer a heal
// into the checkout branch. Each test below runs the installer's own lines.
// Paths reach bash through the environment, never through the script text.

const INSTALL_SH = new URL('../install/install.sh', import.meta.url).pathname;
const isRoot = process.getuid?.() === 0;
const nobodyId = spawnSync('id', ['-u', 'nobody'], { encoding: 'utf8' });
const NOBODY = nobodyId.status === 0 ? nobodyId.stdout.trim() : null;
const canBeNobody = isRoot && NOBODY !== null && spawnSync('sh', ['-c', 'command -v sudo']).status === 0
  && spawnSync('stat', ['-c', '%u', '/']).status === 0;

/** bash, with the installer's path and the case's paths in the environment. */
const bash = (/** @type {string} */ script, /** @type {Record<string,string>} */ env = {}) =>
  spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, FW_INSTALL_SH: INSTALL_SH, ...env }, timeout: 120_000 });
/** Define these installer functions as the installer has them (absent ones are skipped). */
const fns = (/** @type {string[]} */ names) => `
fn() { awk -v name="$1" '$0 ~ "^"name"\\\\(\\\\) \\\\{" {p=1} p {print} p && /^}/ {exit}' "$FW_INSTALL_SH"; }
${names.map((n) => `eval "$(fn ${n})"`).join('\n')}
ok() { printf 'ok   %s\\n' "$*"; }; warn() { printf 'warn %s\\n' "$*"; }; say() { :; }
die() { printf 'FAIL %s\\n' "$*"; exit 1; }
`;
const ALTER_FNS = ['run_user_can_alter', '_rua_bits', '_rua_walk'];
/** The installer's text from one marker to the next, exclusive. */
const between = (/** @type {string} */ from, /** @type {string} */ to) => {
  const a = SH.indexOf(from);
  assert.ok(a >= 0, `the installer no longer has: ${from}`);
  const b = SH.indexOf(to, a + from.length);
  assert.ok(b > a, `the installer no longer has, after it: ${to}`);
  return SH.slice(a, b);
};
const tmp = (/** @type {string} */ name) => {
  const t = mkdtempSync(path.join(tmpdir(), `${name}-`));
  chmodSync(t, 0o755);
  return t;
};

test('a payload that is not a release is refused before anything is read out of it', () => {
  // THE STEER. The heal runs the verified installer with `current` as the
  // payload, and `current` is the service user's: without lib/fleetwright.mjs
  // it read as a checkout, and root ran `npm ci` — and its lifecycle scripts — in it.
  const t = tmp('payload');
  try {
    mkdirSync(path.join(t, 'current'));
    writeFileSync(path.join(t, 'current', 'package.json'), '{"version":"v9","scripts":{"postinstall":"id"}}');
    const r = spawnSync('bash', [INSTALL_SH, '--help'], { encoding: 'utf8', env: { ...process.env, FLEETWRIGHT_PAYLOAD: path.join(t, 'current') } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /is not a release .*Nothing was changed/s);
    assert.doesNotMatch(r.stdout, /usage:/, 'it went on to parse its arguments');
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('the release lay-out never copies from inside the release tree, nor to a version that is a path', () => {
  const block = between('if [ "$PACKAGED" = 1 ]; then\n  RELEASE_VERSION=', '\n# Installing missing OS packages');
  const t = tmp('layout');
  try {
    // What the service user can arrange under a base that is theirs: `current`
    // at a tree of their own, and `releases` a symlink to somewhere of root's.
    const base = path.join(t, 'base');
    mkdirSync(path.join(base, 'theirs', 'lib'), { recursive: true });
    writeFileSync(path.join(base, 'theirs', 'lib', 'fleetwright.mjs'), '');
    mkdirSync(path.join(t, 'roots'));
    symlinkSync(path.join(t, 'roots'), path.join(base, 'releases'));
    symlinkSync(path.join(base, 'theirs'), path.join(base, 'current'));
    const run = (/** @type {string} */ version) => {
      writeFileSync(path.join(base, 'theirs', 'package.json'), JSON.stringify({ version }));
      return bash(`${fns([])}
PACKAGED=1 CHECK_ONLY=0 GRANT_ONLY=0 FLEET_BASE="$X_BASE" DIR="$X_BASE/current"
${block}
echo "DIR=$DIR"`, { X_BASE: base });
    };
    let r = run('v1');
    assert.match(r.stdout, /DIR=.*\/current$/m, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(path.join(t, 'roots')), [], 'root copied the service user’s tree through their `releases` symlink');
    // A version is a name. This one walked out of releases/ into root's.
    r = run('../../roots/sub');
    assert.match(r.stdout, /FAIL the release's version "..\/..\/roots\/sub" is not a plain name/, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(path.join(t, 'roots')), []);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('--grant lays no release out, so root’s copy can run it without replacing the hub’s tree', () => {
  // `sudo fleetwright grant` now runs the installer out of root's store, whose
  // tree is a release that is not `current`; the lay-out above would have
  // copied it over the release the hub runs, root-owned, on every grant.
  const t = tmp('grant');
  try {
    const tree = path.join(t, 'store', 'releases', 'v-store');
    mkdirSync(path.join(tree, 'install'), { recursive: true });
    mkdirSync(path.join(tree, 'lib'));
    writeFileSync(path.join(tree, 'lib', 'fleetwright.mjs'), '');
    writeFileSync(path.join(tree, 'package.json'), '{"version":"v-store"}');
    writeFileSync(path.join(tree, 'install', 'install.sh'), SH);
    const base = path.join(t, 'base');
    mkdirSync(base);
    // A node that is not there stops --grant before it changes anything, on a
    // machine that does have an /etc/fleetwright.env.
    const r = spawnSync('bash', [path.join(tree, 'install', 'install.sh'), '--grant', 'reboot=on'], {
      encoding: 'utf8',
      env: { ...process.env, FLEETWRIGHT_BASE: base, FLEETWRIGHT_NODE_BIN: path.join(t, 'no-node'), FLEETWRIGHT_ASK_NONE: '1' },
      timeout: 60_000,
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(readdirSync(base), [], `--grant laid a release out:\n${r.stdout}${r.stderr}`);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('npm runs no lifecycle scripts for root', () => {
  const block = between('say "Runtime dependencies"\n', '\n# The checkout must belong to the user that runs the service');
  const t = tmp('npm');
  try {
    writeFileSync(path.join(t, 'npm'), '#!/bin/sh\necho "$*" >> "$X_LOG"\n');
    chmodSync(path.join(t, 'npm'), 0o755);
    const r = bash(`${fns([])}
pkg_install() { return 1; }; pkg_why() { :; }
PACKAGED=0 CHECK_ONLY=0 RUN_USER=nobody DIR="$X_T" PATH="$X_T:$PATH"
${block}`, { X_T: t, X_LOG: path.join(t, 'log') });
    const log = readFileSync(path.join(t, 'log'), 'utf8');
    assert.match(log, /^ci .*--ignore-scripts/m, log + r.stderr);
    // Every npm that installs; `ls`, which counts what landed, runs nothing.
    for (const l of log.trim().split('\n').filter((x) => /^(ci|install|i)\b/.test(x))) assert.match(l, /--ignore-scripts/, `npm without --ignore-scripts: ${l}`);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('the sidecar trusts a checkout’s git config only on a box that runs that checkout', { skip: spawnSync('sh', ['-c', 'command -v git']).status !== 0 && 'needs git' }, () => {
  // Written for a checkout, or "dubious ownership" leaves version and updates
  // null on the health frame of every box installed from source. Taken back
  // everywhere else: a converted box kept it for the checkout it left, which
  // stays the service user's, and git runs what a repository's config names.
  const block = between('  SIDECAR_GITCONFIG=/var/lib/fleetwright-sidecar/.gitconfig\n', '\nfi\n\n# TASK PROFILES')
    .replace('SIDECAR_GITCONFIG=/var/lib/fleetwright-sidecar/.gitconfig', 'SIDECAR_GITCONFIG="$X_GC"');
  const t = tmp('safedir');
  try {
    mkdirSync(path.join(t, 'src', '.git'), { recursive: true });
    mkdirSync(path.join(t, 'release'));
    const gc = path.join(t, 'gitconfig');
    const run = (/** @type {Record<string,string>} */ v) => bash(`${fns([])}
SIDECAR_USER="$X_ME" RUN_USER=nobody
${block}`, { X_GC: gc, X_ME: userInfo().username, ...v });
    // A box that runs its checkout: written.
    let r = run({ DIR: path.join(t, 'src'), CONVERTED: '0', FROM_SOURCE: '0' });
    assert.match(readFileSync(gc, 'utf8'), /directory = .*\/src/, r.stdout + r.stderr);
    // The one-liner re-running that checkout's installer on a box since converted: removed.
    writeFileSync(gc, `[user]\n\tname = keep\n${readFileSync(gc, 'utf8')}`);
    r = run({ DIR: path.join(t, 'src'), CONVERTED: '1', FROM_SOURCE: '0' });
    assert.doesNotMatch(readFileSync(gc, 'utf8'), /safe|directory/, r.stdout + r.stderr);
    assert.match(readFileSync(gc, 'utf8'), /name = keep/, 'the rest of the file is kept');
    // And a packaged run, the heal, with no .git at all.
    run({ DIR: path.join(t, 'src'), CONVERTED: '0', FROM_SOURCE: '0' });
    r = run({ DIR: path.join(t, 'release'), CONVERTED: '0', FROM_SOURCE: '0' });
    assert.doesNotMatch(readFileSync(gc, 'utf8'), /safe|directory/, r.stdout + r.stderr);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

/** A node `nobody` can run, for the lines that now run as the service user. */
const nobodyNode = !canBeNobody ? null : [process.execPath, ...spawnSync('sh', ['-c', 'which -a node'], { encoding: 'utf8' }).stdout.trim().split('\n'), '/opt/node22/bin/node', '/usr/bin/node']
  .find((n) => n && spawnSync('sudo', ['-n', '-u', 'nobody', '--', n, '-e', '0']).status === 0) ?? null;

test('the hook is merged into settings.json as the service user, never through a symlink as root', { skip: !nobodyNode && 'needs root, sudo, and a node `nobody` can run' }, () => {
  // `ln -s /etc/passwd ~/.claude/settings.json`, `sudo -n fleetwright-migrate`,
  // and the heal's --repair chowned /etc/passwd to the service user.
  const block = between('SETTINGS="${CLAUDE_HOME:-$HOME}/.claude/settings.json"\n', '\n# --- 5b. the sandbox image');
  const t = tmp('hook');
  try {
    const home = path.join(t, 'home');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    spawnSync('chown', ['-R', 'nobody', home]);
    const victim = path.join(t, 'passwd');
    writeFileSync(victim, 'root:x:0:0:root:/root:/bin/bash\n');
    symlinkSync(victim, path.join(home, '.claude', 'settings.json'));
    const r = bash(`${fns(['run_as_user'])}
node_major() { echo 24; }
RUN_USER=nobody CLAUDE_HOME="$X_HOME" DIR=/opt/fleetwright/current NODE_BIN="$X_NODE" UNIT_NODE_BIN="$X_NODE" NODE_FLOOR=24
${block}`, { X_HOME: home, X_NODE: /** @type {string} */ (nobodyNode) });
    assert.equal(statSync(victim).uid, 0, `root followed the symlink and gave the file away:\n${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(victim, 'utf8'), 'root:x:0:0:root:/root:/bin/bash\n');
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('the installer asks the service user’s claude its version as them, and writes their .profile as them', { skip: !canBeNobody && 'needs root, sudo and a nobody account' }, () => {
  const block = between('CLAUDE_BIN=""\nfor candidate in', '\nelif [ "$CHECK_ONLY" = 1 ]; then\n  warn "claude is not installed');
  const t = tmp('claude');
  try {
    const home = path.join(t, 'home');
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(path.join(home, '.local', 'bin', 'claude'), `#!/bin/sh\nid -u >> "${path.join(t, 'who')}"\necho 9.9.9\n`);
    chmodSync(path.join(home, '.local', 'bin', 'claude'), 0o755);
    writeFileSync(path.join(t, 'who'), '');
    chmodSync(path.join(t, 'who'), 0o666);
    // Their .profile, pointing at a file of root's.
    const rootrc = path.join(t, 'rootrc');
    writeFileSync(rootrc, '# root\n');
    symlinkSync(rootrc, path.join(home, '.profile'));
    spawnSync('chown', ['-R', 'nobody', home]);
    const r = bash(`${fns(['as_user', 'run_as_user'])}
RUN_USER=nobody CLAUDE_HOME="$X_HOME" USER_HOME="$X_HOME" CHECK_ONLY=0
${block}
fi`, { X_HOME: home });
    const who = readFileSync(path.join(t, 'who'), 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(who.length > 0, r.stdout + r.stderr);
    assert.deepEqual([...new Set(who)], [NOBODY], `claude ran as uid ${who.join(',')}:\n${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(rootrc, 'utf8'), '# root\n', 'root appended to a file through the service user’s .profile');
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- the command root types ---------------------------------------------------------

/**
 * The installer's CLI section, run against a fake box: a release tree the
 * service user (nobody) owns, root's store beside it, and a bin directory of
 * the test's. Each tree's bin/fleetwright says which tree it is.
 */
function linkTheClis(/** @type {Record<string,string>} */ vars) {
  const block = between('say "Linking the CLIs"\n', '\n# A command from before the coordinator left')
    .replace('BIN_DIR=/usr/local/bin', 'BIN_DIR="$X_BIN"');
  const t = tmp('clis');
  for (const [tree, said] of [['base/releases/v1', 'current'], ['store/releases/v1', 'store']]) {
    mkdirSync(path.join(t, tree, 'bin'), { recursive: true });
    writeFileSync(path.join(t, tree, 'bin', 'fleetwright'), `#!/bin/sh\necho "ran ${said} as $(id -u) payload=$FLEETWRIGHT_PAYLOAD user=$FLEETWRIGHT_USER args=$*"\n`);
    chmodSync(path.join(t, tree, 'bin', 'fleetwright'), 0o755);
  }
  symlinkSync('releases/v1', path.join(t, 'base', 'current'));
  symlinkSync('releases/v1', path.join(t, 'store', 'current'));
  spawnSync('chown', ['-R', 'nobody', path.join(t, 'base')]);
  // A `node` of root's that runs the script it is handed, as node would.
  writeFileSync(path.join(t, 'node'), '#!/bin/sh\nexec /bin/sh "$@"\n');
  chmodSync(path.join(t, 'node'), 0o755);
  mkdirSync(path.join(t, 'bin'));
  const r = bash(`${fns([...ALTER_FNS, 'sidecar_tree'])}
MISSING=()
PLATFORM=linux CHECK_ONLY=0 RUN_USER=nobody CONVERTED=0 FROM_SOURCE=0 CLI_NEEDS_WRAPPER=0 NODE_FLOOR=24
FLEET_BASE="$X_T/base" DIR="$X_T/base/current" SIDECAR_BASE="$X_T/store"
SIDECAR_NODE_BIN="$X_T/node" UNIT_NODE_BIN="" NODE_BIN=""
PACKAGED="$X_PACKAGED" SIDECAR_STORE="$X_STORE"
${block}`, { X_T: t, X_BIN: path.join(t, 'bin'), ...vars });
  const as = (/** @type {'root'|'nobody'} */ who) => {
    const argv = [path.join(t, 'bin', 'fleetwright'), 'grant', 'reboot', 'on'];
    return who === 'root'
      ? spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
      : spawnSync('sudo', ['-n', '-u', 'nobody', '--', ...argv], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  };
  return { t, r, as };
}

test('on a packaged box, `sudo fleetwright` runs root’s copy of the release, and nobody else’s changes', { skip: !canBeNobody && 'needs root, sudo and a nobody account' }, () => {
  const { t, r, as } = linkTheClis({ X_PACKAGED: '1', X_STORE: '1' });
  try {
    const root = as('root');
    assert.match(root.stdout, new RegExp(`^ran store as 0 payload=${t}/base/current user=nobody args=grant reboot on$`, 'm'), `${r.stdout}${r.stderr}\n${root.stdout}${root.stderr}`);
    // Everybody else runs the release they always did.
    assert.match(as('nobody').stdout, new RegExp(`^ran current as ${NOBODY} `, 'm'));
    assert.match(r.stdout, /as root, fleetwright runs .*\/store\/current — root's copy/);
    // The wrapper is root's, so the service user cannot redirect it.
    assert.equal(statSync(path.join(t, 'bin', 'fleetwright')).uid, 0);
    // And the old link into `current` was replaced, not written through.
    assert.match(readFileSync(path.join(t, 'base', 'releases', 'v1', 'bin', 'fleetwright'), 'utf8'), /ran current/);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('with no copy of root’s, root is refused in words; a checkout says what root running it means', { skip: !canBeNobody && 'needs root, sudo and a nobody account' }, () => {
  let { t, r, as } = linkTheClis({ X_PACKAGED: '1', X_STORE: '0' });
  try {
    const root = as('root');
    assert.equal(root.status, 1, root.stdout + root.stderr);
    assert.doesNotMatch(root.stdout, /ran /, 'root ran a tree the service user can change');
    assert.match(root.stderr, /fleetwright: not as root on this box\. Its code is .*\/base\/current, which nobody can change, and there is no root-owned copy/);
    assert.match(root.stderr, /sudo \/usr\/local\/sbin\/fleetwright-migrate/);
    assert.match(as('nobody').stdout, /^ran current /m);
    assert.match(r.stdout, /as root, fleetwright refuses to run here/);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
  ({ t, r } = linkTheClis({ X_PACKAGED: '0', X_STORE: '0' }));
  try {
    // NO FALSE CLAIM: a checkout is the service user's, root running it is the
    // known exclusion, and the installer says so rather than implying a guard.
    assert.match(r.stdout, /`sudo fleetwright …` runs .*\/base\/current as root, and nobody owns it/);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('apt purge never runs the service user’s uninstaller as root', () => {
  const t = tmp('postrm');
  try {
    mkdirSync(path.join(t, 'base', 'current', 'install'), { recursive: true });
    const marker = path.join(t, 'ran');
    writeFileSync(path.join(t, 'base', 'current', 'install', 'uninstall.sh'), `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(path.join(t, 'base', 'current', 'install', 'uninstall.sh'), 0o755);
    const r = spawnSync('sh', [new URL('../install/deb/postrm', import.meta.url).pathname, 'purge'], {
      encoding: 'utf8',
      env: { ...process.env, FLEETWRIGHT_BASE: path.join(t, 'base'), FLEETWRIGHT_SIDECAR_BASE: path.join(t, 'no-store') },
    });
    assert.equal(existsSync(marker), false, 'postrm ran current/install/uninstall.sh');
    assert.match(r.stderr, /was not run as root/);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

// --- the node root runs, and the files root wrote in the service user's reach -------

test('finding a node asks the service user’s own candidates as them, and root keeps a node of its own', { skip: !canBeNobody && 'needs root, sudo and a nobody account' }, () => {
  // prereq.sh puts node in their ~/.nvm, and the heal names no node, so
  // find_node ran their binary for its version as root — then root ran it for
  // every env file it wrote.
  const t = tmp('node');
  try {
    const home = path.join(t, 'home');
    mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    const theirs = path.join(home, '.local', 'bin', 'node');
    writeFileSync(theirs, `#!/bin/sh\nid -u >> "${path.join(t, 'who')}"\necho 24\n`);
    chmodSync(theirs, 0o755);
    writeFileSync(path.join(t, 'who'), '');
    chmodSync(path.join(t, 'who'), 0o666);
    spawnSync('chown', ['-R', 'nobody', home]);
    // And a system node of root's, first on root's PATH, as /usr/bin/node is.
    mkdirSync(path.join(t, 'sys'));
    writeFileSync(path.join(t, 'sys', 'node'), '#!/bin/sh\necho 24\n');
    chmodSync(path.join(t, 'sys', 'node'), 0o755);
    const preamble = `${fns([...ALTER_FNS, 'as_user', 'root_may_run', 'node_ask', 'node_major', 'find_node'])}
MISSING=()
node_candidates() { printf '%s\\n' "$X_THEIRS"; }
PLATFORM=linux RUN_USER=nobody USER_HOME="$X_HOME" NODE_FLOOR=24
NODE_BIN="$(find_node)"
echo "FOUND=$NODE_BIN"`;
    const env = { X_THEIRS: theirs, X_HOME: home, X_SYS: path.join(t, 'sys') };
    let r = bash(preamble, env);
    const who = readFileSync(path.join(t, 'who'), 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(who.length > 0, r.stdout + r.stderr);
    assert.deepEqual([...new Set(who)], [NOBODY], `root ran the service user's node (uids ${who.join(',')}):\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, new RegExp(`^FOUND=${theirs}$`, 'm'));
    const choose = between("  # AND ROOT'S NODE IS ONE THE SERVICE USER CANNOT REPLACE.", '  ok "node $(node_ask');
    r = bash(`${preamble}
PATH="$X_SYS:$PATH"
${choose}
echo "ROOT_RUNS=$NODE_BIN"`, env);
    // The system node is what the installer then runs as root.
    assert.match(r.stdout, new RegExp(`^ROOT_RUNS=${t}/sys/node$`, 'm'), r.stdout + r.stderr);
    assert.match(r.stdout, /is nobody's to replace, so this installer runs /);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('the sidecar’s token is written as the service user, so a link they left is not followed by root', { skip: !canBeNobody && 'needs root, sudo and a nobody account' }, () => {
  const block = between('SIDECAR_TOKEN_FILE="$STATE_DIR/sidecar-token"\n', '\n# The three env files hold tokens');
  const t = tmp('token');
  try {
    const state = path.join(t, 'state');
    mkdirSync(state);
    mkdirSync(path.join(t, 'profile.d'));
    const target = path.join(t, 'profile.d', 'x.sh');
    symlinkSync(target, path.join(state, 'sidecar-token'));
    spawnSync('chown', ['-hR', 'nobody', state]);
    const r = bash(`${fns(['run_as_user'])}
RUN_USER=nobody CHECK_ONLY=0 STATE_DIR="$X_STATE"
${block}`, { X_STATE: state });
    assert.equal(existsSync(target), false, `root created ${target} through the link:\n${r.stdout}${r.stderr}`);
    // An ordinary state directory still gets its token, and it is theirs.
    rmSync(path.join(state, 'sidecar-token'));
    bash(`${fns(['run_as_user'])}
RUN_USER=nobody CHECK_ONLY=0 STATE_DIR="$X_STATE"
${block}`, { X_STATE: state });
    const st = statSync(path.join(state, 'sidecar-token'));
    assert.equal(String(st.uid), NOBODY);
    assert.equal(st.mode & 0o777, 0o600);
    assert.match(readFileSync(path.join(state, 'sidecar-token'), 'utf8'), /^[0-9a-f]{48}\n$/);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('uninstall edits settings.json as the service user, so root writes nothing through their links', { skip: !nobodyNode && 'needs root, sudo, and a node `nobody` can run' }, () => {
  const UN = readFileSync(new URL('../install/uninstall.sh', import.meta.url), 'utf8');
  const a = UN.indexOf('SETTINGS="$USER_HOME/.claude/settings.json"\n');
  const b = UN.indexOf('\nif [ "$PURGE" = 1 ]', a);
  assert.ok(a > 0 && b > a, 'the hook block moved');
  const t = tmp('unhook');
  try {
    const home = path.join(t, 'home');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: '/opt/fleetwright/current/bin/fleetwright hook' }] }] } }));
    const victim = path.join(t, 'shadow');
    writeFileSync(victim, 'root:*:1::::::\n');
    symlinkSync(victim, path.join(home, '.claude', 'settings.json.tmp-fleetwright-uninstall'));
    spawnSync('chown', ['-hR', 'nobody', home]);
    const r = bash(`ok() { printf 'ok   %s\\n' "$*"; }; warn() { printf 'warn %s\\n' "$*"; }
RUN_USER=nobody USER_HOME="$X_HOME" PATH="$X_NODEDIR:/usr/bin:/bin"
${UN.slice(a, b)}`, { X_HOME: home, X_NODEDIR: path.dirname(/** @type {string} */ (nobodyNode)) });
    assert.equal(readFileSync(victim, 'utf8'), 'root:*:1::::::\n', `root wrote through the link:\n${r.stdout}${r.stderr}`);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test('uninstall --purge removes a link, never the filesystem root it points at', () => {
  const UN = readFileSync(new URL('../install/uninstall.sh', import.meta.url), 'utf8');
  const a = UN.indexOf('if [ "$PURGE" = 1 ]; then\n  say "Removing the code"');
  const b = UN.indexOf('\nfi\n', a);
  assert.ok(a > 0 && b > a, 'the purge block moved');
  const t = tmp('purge');
  try {
    symlinkSync('/', path.join(t, 'base'));
    const r = bash(`ok() { printf 'ok   %s\\n' "$*"; }; warn() { printf 'warn %s\\n' "$*"; }; say() { :; }
PURGE=1 PURGE_DIR="$X_T/base"
${UN.slice(a, b + 4)}`, { X_T: t });
    assert.match(r.stdout, /is the filesystem root — not removing it/, r.stdout + r.stderr);
    assert.ok(existsSync(path.join(t, 'base')));
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});
