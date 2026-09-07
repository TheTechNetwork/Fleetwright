// Whether /etc is writable, asked of the kernel rather than of a unit file.
//
// This function exists because I twice wrote confident advice about somebody
// else's box from an error string, and was wrong both times: first "your
// filesystem is read-only" (it was not), then "re-run the installer, which adds
// ReadWritePaths=/etc" (that release was already on the box, and re-running it
// changed nothing).
//
// A unit file says what was ASKED FOR. mountinfo says what the kernel DID, and
// they disagree whenever a drop-in, an older unit on disk or a `systemctl edit`
// is in the way. The process that will run dpkg is the one that can look.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { etcMount, adviseOnFailure } from '../src/core/upgrades.js';

/** Write a mountinfo fixture and return its path. */
function mounts(lines) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mountinfo-'));
  const file = path.join(dir, 'mountinfo');
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const ROOT_RW = '25 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw';
const ROOT_RO = '25 1 8:1 / / ro,relatime shared:1 - ext4 /dev/sda1 ro';
const ETC_RO = '36 25 8:1 /etc /etc ro,relatime - ext4 /dev/sda1 ro';

test('an ordinary box reports /etc writable, through the root mount', () => {
  const m = etcMount(mounts([ROOT_RW]));
  assert.equal(m.readOnly, false);
  assert.match(m.where, /via \//);
  assert.match(m.evidence, /rw$/);
});

test('ProtectSystem stacks a read-only /etc over a writable root, and that wins', () => {
  // THE CASE THE WHOLE FUNCTION IS FOR. The disk underneath is fine; the
  // service is standing on a read-only layer over one path. Reading the FIRST
  // matching line would report the disk and miss the layer — which is exactly
  // the wrong answer, because it is the reassuring one.
  const m = etcMount(mounts([ROOT_RW, ETC_RO]));
  assert.equal(m.readOnly, true);
  assert.equal(m.where, '/etc');
});

test('the longest mountpoint wins regardless of the order it appears in', () => {
  // mountinfo is not sorted by depth, and a `/etc` line above the `/` line must
  // not be overwritten by it.
  const m = etcMount(mounts([ETC_RO, ROOT_RW]));
  assert.equal(m.readOnly, true);
  assert.equal(m.where, '/etc');
});

test('a later mount at the same point is on top of the earlier one', () => {
  // A stack is resolved by taking the top, and the top is what a write meets.
  const rw = '37 25 8:1 /etc /etc rw,relatime - ext4 /dev/sda1 rw';
  assert.equal(etcMount(mounts([ROOT_RW, ETC_RO, rw])).readOnly, false);
  assert.equal(etcMount(mounts([ROOT_RW, rw, ETC_RO])).readOnly, true);
});

test('a genuinely read-only disk is reported as the disk', () => {
  const m = etcMount(mounts([ROOT_RO]));
  assert.equal(m.readOnly, true);
  assert.match(m.where, /via \//);
});

test('errors=remount-ro on a writable mount is not read-only', () => {
  // `ro` is a whole option, not a substring. Nearly every ext4 root carries
  // `errors=remount-ro`, so a substring test would call every box in the world
  // read-only and send all of them to the wrong advice.
  const m = etcMount(mounts(['25 1 8:1 / / rw,relatime,errors=remount-ro - ext4 /dev/sda1 rw,errors=remount-ro']));
  assert.equal(m.readOnly, false);
});

test('a mountpoint that merely starts with the same letters is not /etc', () => {
  // `/etcetera` is not a parent of `/etc`, and a naive prefix test says it is.
  const m = etcMount(mounts([ROOT_RW, '40 25 8:1 / /etcetera ro,relatime - ext4 /dev/sda1 ro']));
  assert.equal(m.readOnly, false);
  assert.match(m.where, /via \//);
});

test('optional fields are skipped by the separator, not by counting', () => {
  // The fields between the mountpoint and the `-` vary in number — that is why
  // the separator exists. Counting to a fixed index reads the fstype as an
  // option on any mount that carries a propagation tag.
  const many = '36 25 8:1 /etc /etc ro,relatime shared:16 master:2 propagate_from:2 - ext4 /dev/sda1 ro';
  const m = etcMount(mounts([ROOT_RW, many]));
  assert.equal(m.readOnly, true);
  assert.match(m.evidence, /ext4/);
});

test('a kernel that cannot be read says so, and is not rounded to either answer', () => {
  // CANNOT TELL IS ITS OWN ANSWER. Rounding it to the likely one is how the
  // first two versions of this advice went wrong.
  const m = etcMount('/definitely/not/here');
  assert.equal(m.readOnly, null);
  assert.match(m.evidence, /could not read/);
});

test('the advice follows the measurement, not the error string', () => {
  const said = "unable to create '/etc/debian_version.dpkg-new': Read-only file system";
  // On this machine /etc is writable, so the advice must NOT be the one that
  // sends somebody to re-run the installer — which is what the shipped version
  // said to a person who had just done exactly that.
  const advice = adviseOnFailure(said);
  assert.match(advice, /READ-WRITE|READ-ONLY|could not read its own mounts/);
  if (/READ-WRITE/.test(advice)) {
    assert.match(advice, /re-running the installer will not change anything/);
    assert.doesNotMatch(advice.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n'), /curl -fsSL/);
  }
});
