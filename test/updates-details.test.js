// The details behind the three lines: which packages, and what the release
// contains.
//
// FROM A PHONE, TONIGHT. The host page said "Operating system: 1 package can be
// upgraded" and "fleetwright 0.3.1 is waiting", and the person holding it
// asked which package and what was in 0.3.1. Both answers existed — apt had
// the name, GitHub had the notes — and neither reached the reply. A count and
// a version number are facts that ask for the next question, and the reply
// now carries the next answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dispatch } from '../src/adapters/commands.js';
import { describePackages } from '../src/core/upgrades.js';
import { forgetNotes } from '../src/core/changelog.js';

const POLICY = (installed, candidate) =>
  `fleetwright:\n  Installed: ${installed}\n  Candidate: ${candidate}\n  Version table:\n`;

const LOG = `# Changelog

## 0.3.1 — 2026-09-29

**What the first apt boxes found, fixed.**

A \`join\` with a bare address is https.

## 0.3.0 — 2026-09-28

The product is Fleetwright now.
`;

/**
 * A box laid out the way the deb leaves one — current → releases/<v> — with an
 * apt-cache on PATH that answers `policy` as told.
 */
function aptBox(installed, candidate) {
  const base = mkdtempSync(path.join(tmpdir(), 'updates-details-'));
  const dir = path.join(base, 'releases', installed);
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: installed }));
  writeFileSync(path.join(dir, 'lib', 'fleetwright.mjs'), '');
  symlinkSync(dir, path.join(base, 'current'));
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'apt-cache'), `#!/bin/sh\ncat <<'EOF'\n${POLICY(installed, candidate)}EOF\n`);
  chmodSync(path.join(bin, 'apt-cache'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  return {
    cfg: { installDir: path.join(base, 'current'), stateDir: base, hostname: 'h', releaseSource: 'apt', releaseManifest: '' },
    done() {
      process.env.PATH = oldPath;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/** A fetch that serves the changelog and counts. */
function serving(status, body) {
  const f = async () => {
    f.calls++;
    if (status instanceof Error) throw status;
    return { ok: status === 200, status, text: async () => body };
  };
  f.calls = 0;
  return f;
}

test('a release waiting carries what changed, as data and in the reply', async () => {
  forgetNotes();
  const box = aptBox('0.3.0', '0.3.1');
  try {
    const f = serving(200, LOG);
    const r = await dispatch(/** @type {any} */ ({ cfg: box.cfg, fetch: f }), '/updates');
    assert.equal(r.waiting.app.available, '0.3.1');
    // ONLY THE STEP THIS BOX TAKES. It runs 0.3.0, so 0.3.0's notes are not
    // news to it.
    assert.deepEqual(r.waiting.app.notes.map((s) => s.version), ['0.3.1']);
    assert.equal(r.waiting.app.notes[0].date, '2026-09-29');
    // In the reply too, after the three lines and not inside them, with the
    // Markdown taken off — a chat and a text box render neither.
    assert.match(r.text, /^Session image: .*\n\n(Waiting for the operating system: .*\n\n)?What changed in 0\.3\.1 \(2026-09-29\):\n\nWhat the first apt boxes found, fixed\./m);
    assert.doesNotMatch(r.text, /\*\*/);
    assert.equal(f.calls, 1);
  } finally {
    box.done();
  }
});

test('a box that skipped a release is shown every release it is taking', async () => {
  forgetNotes();
  const box = aptBox('0.2.3', '0.3.1');
  try {
    const r = await dispatch(/** @type {any} */ ({ cfg: box.cfg, fetch: serving(200, LOG) }), '/updates');
    assert.deepEqual(r.waiting.app.notes.map((s) => s.version), ['0.3.1', '0.3.0']);
    assert.match(r.text, /What changed in 0\.3\.1[\s\S]*What changed in 0\.3\.0/);
  } finally {
    box.done();
  }
});

test('notes that could not be fetched are said to be missing, not shown as none', async () => {
  forgetNotes();
  const box = aptBox('0.3.0', '0.3.1');
  try {
    const r = await dispatch(
      /** @type {any} */ ({ cfg: box.cfg, fetch: serving(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'), '') }),
      '/updates',
    );
    // NULL IS CANNOT TELL — the same tri-state as `pending`, for the same
    // reason. An empty list here would read as "a release with nothing in it".
    assert.equal(r.waiting.app.notes, null);
    assert.match(r.text, /the notes for 0\.3\.1 could not be fetched: .*ENOTFOUND/);
    assert.doesNotMatch(r.text, /What changed/);
  } finally {
    box.done();
  }
});

test('nothing waiting, nothing fetched, nothing said about what changed', async () => {
  forgetNotes();
  const box = aptBox('0.3.1', '0.3.1');
  try {
    const f = serving(200, LOG);
    const r = await dispatch(/** @type {any} */ ({ cfg: box.cfg, fetch: f }), '/updates');
    assert.equal(r.waiting.app.available, null);
    assert.equal('notes' in r.waiting.app, false);
    assert.doesNotMatch(r.text, /What changed|could not be fetched/);
    assert.equal(f.calls, 0);
  } finally {
    box.done();
  }
});

test('the operating system half names its packages, as a list and in the reply', async () => {
  forgetNotes();
  const box = aptBox('0.3.1', '0.3.1');
  try {
    const r = await dispatch(/** @type {any} */ ({ cfg: box.cfg, fetch: serving(200, LOG) }), '/updates');
    const sys = r.waiting.system;
    assert.ok(Array.isArray(sys.packages), 'the package names travel as data');
    // The row's own sentence is still the count: forty names in a fleet list
    // is not a fleet list. The names come after the three lines, where a
    // reply read as prose has room for them.
    if (sys.count > 0) {
      assert.equal(sys.packages.length > 0, true);
      assert.doesNotMatch(sys.text, new RegExp(sys.packages[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(r.text, new RegExp(`\\n\\nWaiting for the operating system: ${sys.packages[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    } else {
      assert.deepEqual(sys.packages, []);
      assert.doesNotMatch(r.text, /Waiting for the operating system/);
    }
  } finally {
    box.done();
  }
});

test('the names are capped, and the cap says so', () => {
  const s = { supported: true, count: 15, security: 0, rebootRequired: false, packages: Array.from({ length: 15 }, (_, i) => `pkg${i}`) };
  assert.equal(describePackages(s, 3), 'pkg0, pkg1, pkg2, …and 12 more');
  assert.equal(describePackages({ ...s, count: 2, packages: ['a', 'b'] }), 'a, b');
  assert.equal(describePackages({ ...s, count: 0, packages: [] }), '');
  // The box lists at most twenty names for a count that may be higher.
  assert.equal(describePackages({ ...s, count: 40, packages: s.packages.slice(0, 10) }, 12), `${s.packages.slice(0, 10).join(', ')}, …and 30 more`);
});
