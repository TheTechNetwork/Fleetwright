// One answer, two subjects, each named.
//
// THE BUG THIS EXISTS FOR, from a screenshot of a real fleet: the app's Check
// button printed "The box is up to date." directly above a line reading
// "running 0223f94 · 1 commit behind", with an Apply update button beside it.
//
// Both sentences were true. Check called `upgrade`, which is the operating
// system; the commit count came from the host's own timer. Neither said what it
// was about, so the screen contradicted itself — and whichever half somebody
// believed, the other taught them not to trust the screen.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dispatch } from '../src/adapters/commands.js';
import { VERBS, isMutating } from '../src/fleet/protocol/intents.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';

/** A box laid out the way a release install leaves one. */
function packagedBox(installed = 'v0.2.2') {
  const base = mkdtempSync(path.join(tmpdir(), 'updates-'));
  const dir = path.join(base, 'releases', installed);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: installed }));
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'lib', 'agent-hub.mjs'), '');
  symlinkSync(dir, path.join(base, 'current'));
  return { base, installDir: path.join(base, 'current') };
}

test('the verb is a read, takes nothing, and is free to add', () => {
  assert.equal(isMutating('updates'), false);
  assert.deepEqual(Object.keys(VERBS.updates.params), []);
  // A NEW VERB RATHER THAN A `check` PARAM ON `update`. Adding a param is a
  // flag day — bad_params arrives after the version handshake has agreed — and
  // v3 hosts were in the field. An older host answers `unknown_verb` to this
  // and strands nothing.
  assert.deepEqual(Object.keys(VERBS.update.params).sort(), ['restart']);
  assert.equal(toCommandLine({ verb: 'updates', params: {}, actor: '' }), '/updates');
});

test('both halves answer, and each says which one it is', async () => {
  const box = packagedBox();
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: { installDir: box.installDir, stateDir: box.base, hostname: 'h', releaseManifest: '' } }),
      '/updates',
    );
    assert.equal(r.ok, true);
    // THE ASSERTION THIS FILE IS FOR. Neither line may be a bare verdict about
    // "the box": one is this software and one is the operating system, and a
    // reader has to be able to tell which they are looking at.
    assert.match(r.text, /^Fleetwright: /m);
    assert.match(r.text, /^Operating system: /m);
    assert.doesNotMatch(r.text, /The box is up to date/);
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('the answer travels as data, not only as prose', async () => {
  const box = packagedBox();
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: { installDir: box.installDir, stateDir: box.base, hostname: 'h', releaseManifest: '' } }),
      '/updates',
    );
    // A row that decided whether to show "Apply update" by searching the prose
    // would break the first time the wording changed — the same rule that put
    // `profiles`, `entries` and `channel` in fields.
    assert.equal(typeof r.waiting.app.pending, 'boolean');
    assert.equal(typeof r.waiting.system.pending, 'boolean');
    // And it says which KIND of box it measured, because "3 commits behind" and
    // "v0.2.3 is waiting" are answers to different questions and only one of
    // them is available on any given machine.
    assert.equal(r.waiting.app.kind, 'release');
  } finally {
    rmSync(box.base, { recursive: true, force: true });
  }
});

test('a box that cannot tell says so instead of reporting nothing waiting', async () => {
  // Neither a checkout nor a release. `pending: false` here means CANNOT TELL,
  // and the text is what carries that — a row rendering only the boolean would
  // show the same thing as a box that had checked and found nothing.
  const dir = mkdtempSync(path.join(tmpdir(), 'updates-none-'));
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: { installDir: dir, stateDir: dir, hostname: 'h', releaseManifest: '' } }),
      '/updates',
    );
    assert.equal(r.waiting.app.kind, 'unknown');
    assert.equal(r.waiting.app.pending, false);
    assert.match(r.text, /Fleetwright: .+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the OS half never claims the box is up to date', async () => {
  // `upgrade`'s reply used to be "The box is up to date." — a sentence about
  // apt with no subject. Whatever this box's apt says, the words that caused
  // the contradiction must not come back.
  const dir = mkdtempSync(path.join(tmpdir(), 'updates-os-'));
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: { installDir: dir, stateDir: dir, hostname: 'h', releaseManifest: '' } }),
      '/updates',
    );
    assert.doesNotMatch(r.text, /The box is up to date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a checkout that could be migrated says that, not a commit count', async () => {
  // THE DEFECT THIS VERB EXISTS TO REMOVE, ONE SCREEN OVER. /update on such a
  // box offers to move it onto packaged releases; /updates counting commits at
  // the same time would be two answers to the same question disagreeing —
  // which is what "The box is up to date." above "1 commit behind" was.
  //
  // The helper is not installed on a machine running the suite, so the state
  // here is `no_helper` and the count is the honest answer. What is asserted is
  // that the two agree: whatever /updates says about a checkout, /update's
  // migration answer does not contradict it.
  const dir = mkdtempSync(path.join(tmpdir(), 'updates-checkout-'));
  mkdirSync(path.join(dir, '.git'));
  try {
    const cfg = /** @type {any} */ ({
      installDir: dir,
      stateDir: dir,
      hostname: 'h',
      releaseManifest: 'https://github.com/o/r/releases/latest/download/manifest.json',
    });
    const updates = await dispatch(/** @type {any} */ ({ cfg }), '/updates');
    const update = await dispatch(/** @type {any} */ ({ cfg }), '/update --check');

    // Neither claims this box is current while the other offers it something.
    const bothSayWaiting = /waiting|behind|move/i.test(updates.text) === /waiting|behind|move/i.test(update.text);
    assert.ok(
      bothSayWaiting || !updates.waiting.app.pending,
      `/updates and /update --check disagree:\n${updates.text}\n---\n${update.text}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
