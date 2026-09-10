// Taking a packaged box out of a fleet removes what was put on it.
//
// uninstall.sh was written when every box was a checkout: --purge removed
// "the directory this script is in", and the sudoers rules it knew about were
// the two the wizard writes. A packaged box broke both halves quietly. The
// script lives under /opt/fleetwright/current/install/, so $DIR was the
// `current` SYMLINK and `rm -rf` removed the link and called the code gone,
// with every release still on disk. And the migrate helper — root-owned, in
// /usr/local/sbin, outside the tree on purpose — was never touched, nor was
// the sudoers rule that names it: a box out of the fleet kept a root-capable
// script and a standing grant to run it.
//
// Read as text, like the installer's own tests: this runs as root and removes
// things from /etc, which is not something a test suite does to the machine
// running it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SH = readFileSync(new URL('../install/uninstall.sh', import.meta.url), 'utf8');

test('the uninstaller still parses', () => {
  execFileSync('bash', ['-n', new URL('../install/uninstall.sh', import.meta.url).pathname]);
});

test('--purge on a packaged box removes the releases, not the symlink it was run through', () => {
  // The same test install.sh uses to tell a release from a checkout, and the
  // same base, so the two agree without either reading the other.
  assert.match(SH, /if \[ -f "\$DIR\/lib\/agent-hub\.mjs" \]; then PACKAGED=1; fi/);
  assert.match(SH, /FLEET_BASE="\$\{AGENT_FLEET_BASE:-\/opt\/fleetwright\}"/);
  assert.match(SH, /if \[ "\$PACKAGED" = 1 \]; then PURGE_DIR="\$FLEET_BASE"; else PURGE_DIR="\$DIR"; fi/);
  // And it is PURGE_DIR that goes, previewed under the same name it removes.
  assert.match(SH, /rm -rf "\$\{PURGE_DIR:\?\}"/);
  assert.doesNotMatch(SH, /rm -rf "\$\{DIR:\?\}"/, 'the checkout-only purge is back');
  assert.match(SH, /printf '  code {5}%s \(--purge\)\\n' "\$PURGE_DIR"/);
});

test('root’s half goes too: the migrate rule and the helper it names', () => {
  // The helper is outside the tree so the service user cannot rewrite what
  // it may run as root — which is exactly why purging the tree never reached
  // it. Left behind, it is a root-capable script named by a rule that is
  // gone, on a box that is no longer in any fleet.
  assert.match(SH, /\/etc\/sudoers\.d\/agent-hub-migrate/);
  assert.match(SH, /rm -f \/usr\/local\/sbin\/fleetwright-migrate/);
  // All three rules the installer can write, in one loop, so a fourth cannot
  // be added to the installer without this list being the next thing read.
  for (const rule of ['agent-hub-upgrade', 'agent-hub-reboot', 'agent-hub-migrate']) {
    assert.ok(SH.includes(`/etc/sudoers.d/${rule}`), `${rule} is not removed`);
  }
});

test('the help and the header name the packaged path first', () => {
  assert.match(SH, /sudo \/opt\/fleetwright\/current\/install\/uninstall\.sh --purge/);
  assert.match(SH, /--purge  also remove the code: every release under \/opt\/fleetwright, or the checkout/);
});
