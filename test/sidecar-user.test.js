// The sidecar runs as its own account, and the installer is what makes that so.
//
//   node --test test/sidecar-user.test.js
//
// #270. The sidecar holds this box's private key and the coordinator socket;
// the session user holds every member's Claude and provider credential and the
// podman image store. One uid for both meant a compromised sidecar could read
// ~/.claude and connections/*.env, and a session escape landing as the service
// user could read the host key. The code stopped crossing that line first (the
// hub publishes what the sidecar read, and takes its two writes); this is the
// half that makes the line a uid.
//
// Most of this reads the installer, the unit and the uninstaller as text,
// because they run as root on somebody's machine and the CI runner is not
// that. The last test runs the two shell functions for real, as root, against
// a throwaway account — the one part that a text match cannot vouch for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SH = read('install/install.sh');
const UNIT = read('install/fleetwright-sidecar.service');
const PLIST = read('install/fleetwright-sidecar.plist');
const UNINSTALL = read('install/uninstall.sh');
const DRILL = read('scripts/migration-drill.sh');

/** The directive lines of a unit, comments dropped. */
const directives = (/** @type {string} */ unit) => unit.split('\n').filter((l) => /^[A-Za-z]+=/.test(l));

test('the sidecar unit names its own account, and the hub unit keeps the session user', () => {
  assert.ok(directives(UNIT).includes('User=__SIDECAR_USER__'), 'the sidecar unit does not run as the sidecar account');
  assert.ok(!directives(UNIT).includes('User=__USER__'));
  assert.ok(directives(read('install/fleetwright.service')).includes('User=__USER__'), 'the hub unit changed user');
  // launchd gets the same placeholder; on a Mac the installer fills it with the
  // session user, because it makes no system accounts there.
  assert.match(PLIST, /<key>UserName<\/key>\s*<string>__SIDECAR_USER__<\/string>/);
  assert.match(SH, /-e "s\|__SIDECAR_USER__\|\$SIDECAR_USER\|g"/, 'install_unit does not substitute the sidecar account');
  assert.match(SH, /\[ "\$PLATFORM" = macos \] && SIDECAR_USER="\$\{FLEETWRIGHT_SIDECAR_USER:-\$RUN_USER\}"/);
});

test('nothing in the sidecar unit is shared with the hub any more', () => {
  // The 0700 runtime directory it used to make would be one the hub cannot
  // enter; the hub serves the hook sockets from its own. And a process that
  // reads nothing under a home directory says so.
  const lines = directives(UNIT);
  assert.ok(!lines.some((l) => l.startsWith('RuntimeDirectory')), 'RuntimeDirectory is back');
  assert.ok(lines.includes('ProtectHome=yes'), `ProtectHome is ${lines.find((l) => l.startsWith('ProtectHome'))}`);
  assert.ok(lines.includes('StateDirectory=fleetwright-sidecar'), 'the key still needs its directory');
  // The one box where yes would kill the service — code or node under a home
  // directory — gets read-only from the installer, with a line saying so.
  assert.match(SH, /protect_home="ProtectHome=read-only"/);
  assert.match(SH, /-e "s\|\^ProtectHome=yes\$\|\$protect_home\|"/);
});

test('the installer makes a system account with no login and its state directory as home', () => {
  assert.match(SH, /^SIDECAR_USER="\$\{FLEETWRIGHT_SIDECAR_USER:-fleetwright-sidecar\}"$/m);
  const fn = SH.slice(SH.indexOf('ensure_sidecar_user() {'), SH.indexOf('\n}\n', SH.indexOf('ensure_sidecar_user() {')));
  assert.match(fn, /useradd --system --user-group --home-dir \/var\/lib\/fleetwright-sidecar --no-create-home/);
  assert.match(fn, /--shell "\$shell"/);
  // busybox, for Alpine; and an honest fallback when neither exists, rather
  // than a unit naming an account that does not.
  assert.match(fn, /adduser -S -D -H -h \/var\/lib\/fleetwright-sidecar/);
  assert.match(fn, /SIDECAR_USER="\$RUN_USER"\n\s+SIDECAR_USER_FALLBACK=1/);
  assert.match(fn, /\[ "\$CHECK_ONLY" = 1 \] && \{ ok "would create/, '--check must not create accounts');
});

test('what the sidecar owns moves to its account, once, on a box installed before this', () => {
  // systemd fixes the directory's owner on start and not its contents, and the
  // contents are the private key written by the session user.
  assert.match(SH, /install -d -m 0700 -o "\$SIDECAR_USER" \/var\/lib\/fleetwright-sidecar/);
  assert.match(SH, /find \/var\/lib\/fleetwright-sidecar -mindepth 1 ! -user "\$SIDECAR_USER"[^\n]*\n\s+chown -R "\$SIDECAR_USER" \/var\/lib\/fleetwright-sidecar/);
  assert.match(SH, /chown "\$SIDECAR_USER" "\$MACHINE_FILE"/);
  assert.match(SH, /chown "\$SIDECAR_USER" "\$SIDECAR_ENV"/);
  assert.doesNotMatch(SH, /install -d -m 0700 -o "\$RUN_USER" \/var\/lib\/fleetwright-sidecar/);
  // And the session user's things stay the session user's.
  assert.match(SH, /install -d -o "\$RUN_USER" -m 0750 "\$STATE_DIR"/);
});

test('everything the installer runs as the sidecar runs as the sidecar', () => {
  // enrol, identity, doctor: they read the key, so they have to be its owner.
  const cli = SH.slice(SH.indexOf('sidecar_cli() {'), SH.indexOf('\n}\n', SH.indexOf('sidecar_cli() {')));
  assert.match(cli, /as_sidecar "FLEETWRIGHT_ENROL_QUIET=1/);
  assert.doesNotMatch(cli, /as_user /);
  for (const m of SH.matchAll(/sudo -u (\$\w+) \$DIR\/bin\/fleetwright-sidecar enrol/g)) {
    assert.equal(m[1], '$SIDECAR_USER', `a fix-it line names the wrong account: ${m[0]}`);
  }
  for (const m of SH.matchAll(/sudo -u %s %s\/bin\/fleetwright-sidecar enrol <pin>\\n' "(\$\w+)"/g)) {
    assert.equal(m[1], '$SIDECAR_USER');
  }
  // Never a login shell of an account whose shell is nologin.
  const asSidecar = SH.slice(SH.indexOf('as_sidecar() {'), SH.indexOf('\n}\n', SH.indexOf('as_sidecar() {')));
  assert.match(asSidecar, /runuser -u "\$SIDECAR_USER" -- bash -lc/);
  assert.doesNotMatch(asSidecar, /runuser -l/);
  assert.match(asSidecar, /su -s \/bin\/bash/);
});

test('a checkout stays readable to git under the other account', () => {
  // "dubious ownership" would leave version and updates null on the health
  // frame of every box installed from source. One safe.directory line, in the
  // account's own config rather than /etc/gitconfig for everybody.
  assert.match(SH, /git config --file \/var\/lib\/fleetwright-sidecar\/\.gitconfig --replace-all safe\.directory "\$DIR"/);
});

test('the hub user is read from the hub unit alone', () => {
  // The sidecar unit names a different account now; reading it for RUN_USER
  // would hand the sessions to the sidecar's account on a box missing the
  // hub's unit.
  const fn = SH.slice(SH.indexOf('unit_user() {'), SH.indexOf('\n}\n', SH.indexOf('unit_user() {')));
  assert.match(fn, /for u in \/etc\/systemd\/system\/fleetwright\.service; do/);
  assert.doesNotMatch(fn, /fleetwright-sidecar\.service/);
});

test('the account can be checked before the unit is written, and the unit falls back if it fails', () => {
  // A unit that dies at ExecStart with a permissions error attributed to node
  // is the failure this probe exists to catch before it is written.
  assert.match(SH, /as_sidecar "test -r '\$\(unit_entry fleetwright-sidecar\)' && test -x '\$NODE_BIN'"/);
  const start = SH.indexOf("# CAN THE SIDECAR'S ACCOUNT RUN THE SIDECAR");
  assert.ok(start > 0, 'the probe is gone');
  const probe = SH.slice(start, SH.indexOf('\nfi\n', start));
  assert.match(probe, /SIDECAR_USER="\$RUN_USER"/);
  assert.match(probe, /MISSING\+=/);
});

test('the uninstaller removes the account it made, and only that one', () => {
  assert.match(UNINSTALL, /home="\$\(getent passwd "\$SIDECAR_USER"[^\n]*\n\s+if \[ "\$home" = \/var\/lib\/fleetwright-sidecar \]; then\n\s+if userdel "\$SIDECAR_USER"/);
  assert.match(UNINSTALL, /left the \$SIDECAR_USER account alone/);
  // And the drill, which installs for real, leaves no account behind either.
  assert.match(DRILL, /SIDECAR_USER_EXISTED=0\nid fleetwright-sidecar/);
  assert.match(DRILL, /if \[ "\$\{SIDECAR_USER_EXISTED:-0\}" = 0 \]; then\n\s+userdel fleetwright-sidecar/);
});

// --- for real, as root ------------------------------------------------------

const root = typeof process.getuid === 'function' && process.getuid() === 0;
const has = (/** @type {string} */ bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
const canRun = root && has('useradd') && has('userdel') && (has('sudo') || has('runuser') || has('su'));

test('the two functions make an account that can run the sidecar and read nothing of root\'s', { skip: !canRun && 'needs root and useradd' }, () => {
  // The installer's own text, extracted and run — not a re-implementation.
  // A throwaway name, removed at the end whatever happens in between.
  const name = `fwtest-${process.pid}`;
  const script = `
set -uo pipefail
SH=${JSON.stringify(new URL('../install/install.sh', import.meta.url).pathname)}
fn() { awk -v name="$1" '$0 ~ "^"name"\\\\(\\\\) \\\\{" {p=1} p {print} p && /^}/ {exit}' "$SH"; }
eval "$(fn as_sidecar)"; eval "$(fn ensure_sidecar_user)"
ok() { :; }; warn() { printf 'warn %s\\n' "$*"; }
MISSING=(); CHECK_ONLY=0; RUN_USER=root; SIDECAR_USER=${name}
ensure_sidecar_user || echo "FAIL create"
[ "$SIDECAR_USER" = ${name} ] || echo "FAIL fell back"
getent passwd ${name} | cut -d: -f6,7
as_sidecar 'id -un'
d="$(mktemp -d)"; chmod 0711 "$d"; install -d -m 0700 -o ${name} "$d/state"
as_sidecar "touch '$d/state/key' && chmod 0600 '$d/state/key'" && echo "writes its state"
as_sidecar "cat /root/.bashrc /root/.profile" >/dev/null 2>&1 && echo "FAIL read root home" || echo "cannot read root's home"
ensure_sidecar_user && echo "idempotent"
rm -rf "$d"; userdel ${name} && echo "removed"
`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /FAIL/, out);
  assert.match(out, new RegExp(`^/var/lib/fleetwright-sidecar:(/usr/sbin/nologin|/sbin/nologin|/bin/false)$`, 'm'), out);
  assert.match(out, new RegExp(`^${name}$`, 'm'), 'as_sidecar did not run as the account');
  assert.match(out, /writes its state/, out);
  assert.match(out, /cannot read root's home/, out);
  assert.match(out, /idempotent/, out);
  assert.match(out, /removed/, out);
  assert.equal(spawnSync('id', [name]).status, 1, 'the throwaway account is still there');
});
