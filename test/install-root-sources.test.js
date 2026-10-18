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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
