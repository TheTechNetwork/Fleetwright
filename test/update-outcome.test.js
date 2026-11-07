// An update that did not finish says so, and keeps saying so.
//
// THREE SILENT HALF-UPDATES, one record. The session image pull returned
// `ok: true` with the reason in prose, and boxes stayed on an old image while
// /update said they were current (update.js records the incident). The
// credential tidy did the same. The root repair on a packaged box runs AFTER
// the reply has left — the reply promises it — so when sudo refused it the only
// evidence was a journal line and the services restarted anyway.
//
// Now each step that did not do its work is INCOMPLETE as data: the reply leads
// with it, src/core/update-outcome.js keeps it, /updates reads it back on every
// Check and every health poll, and the sidecar's frame carries it so a
// machine's row can stop saying "up to date" over a step that did not happen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordUpdateOutcome, readUpdateOutcome, unfinished, describeUnfinished, outcomePath } from '../src/core/update-outcome.js';
import { runUpdate } from '../src/core/update.js';
import { healAfterRelease, MIGRATE_BIN } from '../src/core/migrate.js';
import { dispatch } from '../src/adapters/commands.js';

const ROOT = new URL('..', import.meta.url).pathname;

test('the record merges step by step, and a fresh update starts it over', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'outcome-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(readUpdateOutcome(dir), null, 'no record is cannot tell, not finished');
  assert.equal(describeUnfinished(null), null);

  recordUpdateOutcome(dir, { image: null, credentials: null }, { fresh: true, at: 1_700_000_000_000 });
  recordUpdateOutcome(dir, { image: { ok: false, text: 'not refreshed: no route to host' } });
  recordUpdateOutcome(dir, { credentials: { ok: true, text: 'finished' } });
  const o = readUpdateOutcome(dir);
  assert.equal(o?.at, 1_700_000_000_000, 'the record keeps the moment the update began');
  assert.deepEqual(unfinished(o), [{ step: 'image', text: 'not refreshed: no route to host' }]);
  assert.equal(
    describeUnfinished(o),
    'The last update (2023-11-14 22:13 UTC) did not finish everything: the session image — not refreshed: no route to host.',
  );

  // The deferred repair lands later, from another call, and is merged in.
  recordUpdateOutcome(dir, { repair: { ok: false, text: 'sudo exited 1' } });
  assert.deepEqual(unfinished(readUpdateOutcome(dir)).map((u) => u.step), ['image', 'repair']);

  // The next update starts a fresh record: nothing from before outlives it.
  recordUpdateOutcome(dir, { image: { ok: true, text: 'finished' } }, { fresh: true });
  assert.deepEqual(unfinished(readUpdateOutcome(dir)), []);
  assert.equal(describeUnfinished(readUpdateOutcome(dir)), null);

  // An unreadable record is cannot tell; a missing state dir writes nothing.
  writeFileSync(outcomePath(dir), 'not json');
  assert.equal(readUpdateOutcome(dir), null);
  assert.equal(recordUpdateOutcome(null, { image: null }), null);
  assert.equal(readUpdateOutcome(undefined), null);
});

/** A checkout with a podman whose pull always fails. */
function checkoutWithBrokenRegistry(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'outcome-update-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const origin = path.join(root, 'origin');
  mkdirSync(origin);
  git(origin, ['init', '-q', '-b', 'main']);
  git(origin, ['config', 'user.email', 'test@example.com']);
  git(origin, ['config', 'user.name', 'Test']);
  writeFileSync(path.join(origin, 'README.md'), 'one\n');
  git(origin, ['add', '-A']);
  git(origin, ['commit', '-qm', 'first commit']);
  const clone = path.join(root, 'deploy');
  git(root, ['clone', '-q', origin, clone]);
  const bin = path.join(root, 'podman');
  writeFileSync(bin, ['#!/bin/sh', 'case "$1" in', '  image) echo "sha256:aaa" ;;', '  pull) echo "no route to host" >&2; exit 125 ;;', '  *) exit 0 ;;', 'esac'].join('\n'));
  chmodSync(bin, 0o755);
  const stateDir = path.join(root, 'state');
  return { cfg: /** @type {any} */ ({ installDir: clone, stateDir, sandbox: true, sandboxImage: 'ghcr.io/example/session:latest', podmanBin: bin }), stateDir };
}

test('an update whose image pull failed leads with it, and records it', async (t) => {
  const { cfg, stateDir } = checkoutWithBrokenRegistry(t);
  const r = await runUpdate(cfg);
  assert.equal(r.ok, true, 'the code is current; a registry outage does not fail the update');
  assert.deepEqual(r.incomplete?.map((i) => i.step), ['image']);
  // FIRST, not in paragraph three under "Already up to date".
  assert.match(r.message.split('\n')[0], /^Not everything finished: the session image not refreshed: no route to host/);
  const recorded = readUpdateOutcome(stateDir);
  assert.equal(recorded?.steps.image?.ok, false);
  assert.equal(recorded?.steps.credentials?.ok, true, 'a step that finished is recorded as finished');
});

test('the heal records the repair the reply already promised', () => {
  /** @type {any[]} */
  const recorded = [];
  const record = (/** @type {any} */ dir, /** @type {any} */ steps) => { recorded.push({ dir, steps }); return null; };
  const quiet = { info() {}, warn() {} };
  const common = { exists: () => true, after: (/** @type {() => void} */ fn) => fn(), restart() {}, mark: () => true, logger: quiet, stateDir: '/var/lib/fw', record };

  healAfterRelease({ ...common, run: () => ({ status: 0, stdout: 'running the installer from the verified release, with --repair', stderr: '' }) });
  assert.equal(recorded.at(-1).steps.repair.ok, true);

  healAfterRelease({ ...common, run: () => ({ status: 0, stdout: 'already on the packaged layout, running main-103 — nothing to do', stderr: '' }) });
  assert.equal(recorded.at(-1).steps.repair.ok, false);
  assert.match(recorded.at(-1).steps.repair.text, /older than the release/);
  assert.match(recorded.at(-1).steps.repair.text, /Refresh it once: /, 'names the command that finishes it');

  healAfterRelease({ ...common, run: () => ({ status: 1, stdout: '', stderr: 'sudo: a password is required' }) });
  assert.equal(recorded.at(-1).steps.repair.ok, false);
  assert.match(recorded.at(-1).steps.repair.text, /sudo exited 1/);
  assert.ok(recorded.at(-1).steps.repair.text.includes(`sudo ${MIGRATE_BIN}`), 'the one command that finishes it, on the phone');
  assert.ok(recorded.every((r) => r.dir === '/var/lib/fw'));
});

/** A box laid out the way a release install leaves one. */
function packagedBox() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'outcome-updates-'));
  const dir = path.join(base, 'releases', 'v0.2.2');
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: 'v0.2.2' }));
  writeFileSync(path.join(dir, 'lib', 'fleetwright.mjs'), '');
  symlinkSync(dir, path.join(base, 'current'));
  return { base, installDir: path.join(base, 'current') };
}

test('/updates says what the last update left undone, first and as data', async (t) => {
  const box = packagedBox();
  t.after(() => rmSync(box.base, { recursive: true, force: true }));
  const cfg = { installDir: box.installDir, stateDir: box.base, hostname: 'h', releaseManifest: '' };

  const before = await dispatch(/** @type {any} */ ({ cfg }), '/updates');
  assert.equal(before.waiting.incomplete, null, 'no record is nothing to say');
  assert.match(before.text, /^Fleetwright: /);

  recordUpdateOutcome(box.base, { image: { ok: false, text: 'not refreshed: no route to host' }, repair: { ok: false, text: 'sudo exited 1 running the helper' } }, { fresh: true });
  const r = await dispatch(/** @type {any} */ ({ cfg }), '/updates');
  assert.match(r.text.split('\n')[0], /^The last update .* did not finish everything: the session image — not refreshed: no route to host; the root repair — sudo exited 1 running the helper\.$/);
  assert.equal(r.waiting.incomplete, r.text.split('\n')[0]);

  recordUpdateOutcome(box.base, { image: { ok: true, text: 'finished' }, repair: { ok: true, text: 'ran' } }, { fresh: true });
  const after = await dispatch(/** @type {any} */ ({ cfg }), '/updates');
  assert.equal(after.waiting.incomplete, null);
  assert.doesNotMatch(after.text, /did not finish/);
});

test('the sidecar carries the sentence into its frame, and both phones draw it', () => {
  const bin = readFileSync(path.join(ROOT, 'bin/fleetwright-sidecar'), 'utf8');
  assert.match(bin, /incomplete: typeof waiting\.incomplete === 'string' && waiting\.incomplete \? waiting\.incomplete : null/);
  const ios = readFileSync(path.join(ROOT, 'apps/ios/Fleetwright/Fleet.swift'), 'utf8');
  const kt = readFileSync(path.join(ROOT, 'apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt'), 'utf8');
  assert.match(ios, /let incomplete: String\?/, 'iOS decodes updates.incomplete');
  assert.match(kt, /updateIncomplete = updates\?\.optString\("incomplete"\)/, 'Android decodes updates.incomplete');
  // DRAWN WHERE "UP TO DATE" IS: the row's one-line software summary says
  // "last update incomplete" rather than "up to date", and the machine's page
  // shows the sentence in the attention colour.
  const iosRow = readFileSync(path.join(ROOT, 'apps/ios/Fleetwright/FleetView.swift'), 'utf8');
  const ktRow = readFileSync(path.join(ROOT, 'apps/android/app/src/main/java/network/thetech/fleetwright/Screens.kt'), 'utf8');
  assert.match(iosRow, /last update incomplete/);
  assert.match(ktRow, /last update incomplete/);
  const iosPage = readFileSync(path.join(ROOT, 'apps/ios/Fleetwright/HostView.swift'), 'utf8');
  const ktPage = readFileSync(path.join(ROOT, 'apps/android/app/src/main/java/network/thetech/fleetwright/MachinesScreen.kt'), 'utf8');
  assert.match(iosPage, /updates\?\.incomplete/);
  assert.match(ktPage, /updateIncomplete/);
});
