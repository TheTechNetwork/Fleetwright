// What an update contains, read from the changelog at the tag it was cut from.
//
// THE QUESTION A PHONE ASKS BEFORE PRESSING APPLY. "0.3.1 is waiting" beside an
// Apply button is asking somebody to take a release on the strength of its
// number. The notes are the rest of the sentence, and the box does not hold
// them for a version it has not installed yet.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sections,
  parseVersion,
  compareVersions,
  notesBetween,
  changelogRepo,
  changelogUrl,
  fetchNotes,
  forgetNotes,
  plainText,
  describeNotes,
  fit,
} from '../src/core/changelog.js';

const LOG = `# Changelog

Prose before the first section is not a section.

## 0.3.1 — 2026-09-29

**Fixes for the first apt boxes.**

A \`join\` with a bare address is https.

## 0.3.0 - 2026-09-28

The product is Fleetwright now.

## 0.2.3 — 2026-09-05

Older.
`;

test('sections: one per heading, either dash, body trimmed, preamble dropped', () => {
  const all = sections(LOG);
  assert.deepEqual(all.map((s) => [s.version, s.date]), [['0.3.1', '2026-09-29'], ['0.3.0', '2026-09-28'], ['0.2.3', '2026-09-05']]);
  assert.equal(all[1].body, 'The product is Fleetwright now.');
  assert.match(all[0].body, /^\*\*Fixes/);
});

test('a version parses with or without its v, and a rolling build is not a version of zero', () => {
  assert.deepEqual(parseVersion('v0.3.1'), [0, 3, 1]);
  assert.deepEqual(parseVersion('0.10.2'), [0, 10, 2]);
  assert.equal(parseVersion('main-63'), null);
  assert.equal(parseVersion('0.4.0~rc1'), null);
  assert.equal(parseVersion(null), null);
  assert.ok(compareVersions([0, 10, 0], [0, 9, 9]) > 0, 'compared as numbers, not as strings');
  assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

test('notesBetween: every release the box would be taking, newest first', () => {
  const all = sections(LOG);
  // A Pi on 0.2.3 offered 0.3.1 is taking 0.3.0 as well, and 0.3.0 is the
  // bigger change. Both, and in the order a changelog reads.
  assert.deepEqual(notesBetween(all, '0.2.3', '0.3.1').map((s) => s.version), ['0.3.1', '0.3.0']);
  assert.deepEqual(notesBetween(all, 'v0.3.0', '0.3.1').map((s) => s.version), ['0.3.1']);
  // The box's own version does not parse: no line to draw, so just the one
  // waiting — not the whole file, and not nothing.
  assert.deepEqual(notesBetween(all, 'main-63', '0.3.1').map((s) => s.version), ['0.3.1']);
  assert.deepEqual(notesBetween(all, null, '0.3.0').map((s) => s.version), ['0.3.0']);
  // Nothing newer than what it runs.
  assert.deepEqual(notesBetween(all, '0.3.1', '0.3.1'), []);
  // The waiting version has no section of its own: what the box would still
  // be taking on the way there is true, and is shown.
  assert.deepEqual(notesBetween(all, '0.3.0', '0.9.9').map((s) => s.version), ['0.3.1']);
  assert.deepEqual(notesBetween(all, '0.3.0', 'main-64'), []);
});

test('the changelog is read from the tag, in the repository the box takes releases from', () => {
  assert.equal(changelogRepo({ releaseManifest: '' }), 'TheTechNetwork/Fleetwright');
  assert.equal(changelogRepo({}), 'TheTechNetwork/Fleetwright');
  // A fork publishing its own releases reads its own notes.
  assert.equal(changelogRepo({ releaseManifest: 'https://github.com/someone/Fork/releases/latest/download/manifest.json' }), 'someone/Fork');
  // A mirror that is not GitHub is not a repository to read from.
  assert.equal(changelogRepo({ releaseManifest: 'https://mirror.example/manifest.json' }), 'TheTechNetwork/Fleetwright');
  assert.equal(changelogUrl({}, 'v0.3.1'), 'https://raw.githubusercontent.com/TheTechNetwork/Fleetwright/v0.3.1/CHANGELOG.md');
  assert.equal(changelogUrl({}, '0.3.1'), 'https://raw.githubusercontent.com/TheTechNetwork/Fleetwright/v0.3.1/CHANGELOG.md');
});

/** A fetch that answers one way and counts how often it was asked. */
function answering(status, body) {
  const f = async () => {
    f.calls++;
    if (status instanceof Error) throw status;
    return { ok: status === 200, status, text: async () => body };
  };
  f.calls = 0;
  return f;
}

test('fetchNotes: the notes between, from one fetch per version', async () => {
  forgetNotes();
  const f = answering(200, LOG);
  const r = await fetchNotes({}, { installed: '0.2.3', available: '0.3.1' }, { fetch: /** @type {any} */ (f) });
  assert.equal(r.ok, true);
  assert.deepEqual(r.notes.map((s) => s.version), ['0.3.1', '0.3.0']);
  // Asked again fifteen minutes later, by the sidecar's timer: the same
  // answer without a second request.
  const again = await fetchNotes({}, { installed: '0.3.0', available: '0.3.1' }, { fetch: /** @type {any} */ (f) });
  assert.deepEqual(again.notes.map((s) => s.version), ['0.3.1']);
  assert.equal(f.calls, 1);
});

test('fetchNotes: could not fetch is CANNOT TELL, said, and not remembered', async () => {
  forgetNotes();
  const gone = answering(404, 'Not Found');
  const r = await fetchNotes({}, { installed: '0.3.0', available: '0.3.1' }, { fetch: /** @type {any} */ (gone) });
  assert.equal(r.ok, false);
  assert.match(r.message ?? '', /could not be fetched: GitHub answered 404/);
  assert.deepEqual(r.notes, []);

  const down = answering(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com'), '');
  const r2 = await fetchNotes({}, { installed: '0.3.0', available: '0.3.1' }, { fetch: /** @type {any} */ (down) });
  assert.equal(r2.ok, false);
  assert.match(r2.message ?? '', /ENOTFOUND/);

  // The box that could not reach GitHub at 03:00 answers at 03:15: a failure
  // is not the cached truth.
  const f = answering(200, LOG);
  const r3 = await fetchNotes({}, { installed: '0.3.0', available: '0.3.1' }, { fetch: /** @type {any} */ (f) });
  assert.equal(r3.ok, true);
  assert.equal(f.calls, 1);
});

test('fetchNotes: a rolling build has no notes and asks for none', async () => {
  forgetNotes();
  const f = answering(200, LOG);
  const r = await fetchNotes({}, { installed: 'main-63', available: 'main-64' }, { fetch: /** @type {any} */ (f) });
  assert.deepEqual(r, { ok: true, notes: [] });
  assert.equal(f.calls, 0);
});

test('the notes reach a reply as prose a chat can read, each version under its own heading', () => {
  assert.equal(plainText('**Bold** and `code` and\n## a heading'), 'Bold and code and\na heading');
  const text = describeNotes(sections(LOG).slice(0, 2));
  assert.match(text, /^What changed in 0\.3\.1 \(2026-09-29\):\n\nFixes for the first apt boxes\./);
  assert.match(text, /\n\nWhat changed in 0\.3\.0 \(2026-09-28\):\n\nThe product is Fleetwright now\./);
  assert.doesNotMatch(text, /\*\*|`/);
  // Nothing to say is nothing, so the caller leaves the line out.
  assert.equal(describeNotes([]), '');
  // Fitted, and the tail names the repository the notes came from.
  const long = describeNotes([{ version: '9.9.9', date: '', body: 'word '.repeat(600) }], { max: 400, repo: 'someone/Fork' });
  assert.ok(long.length < 500);
  assert.match(long, /Full notes: github\.com\/someone\/Fork\/blob\/main\/CHANGELOG\.md$/);
  assert.equal(fit('short', 500), 'short');
});

test('the release-notes script reads the same parser, so a store and a phone show the same notes', async () => {
  const script = await import('../scripts/release-notes.mjs');
  assert.deepEqual(script.sections(LOG), sections(LOG));
  assert.equal(script.fit, fit);
});
