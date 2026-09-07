// The listing, read from the document somebody actually wrote.
//
// WHAT THIS IS FOR. The copy for both stores has always lived in
// apps/store-listing.md — reviewed in pull requests, argued over, kept current
// — and was then retyped into two web consoles. The pipeline builds, signs,
// uploads, distributes to testers and submits for review with nobody touching
// anything, and stopped one step short of the words on the page.
//
// That last step is where a listing goes stale: nobody re-pastes a description
// they only changed slightly, so the repository and the store drift, and the
// repository is the one that looks authoritative.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { storeListing, LISTING_PATH } from '../tools/store-listing.mjs';

/** Write a listing document and read it back. */
function parse(md) {
  const dir = mkdtempSync(path.join(tmpdir(), 'listing-'));
  const p = path.join(dir, 'store-listing.md');
  writeFileSync(p, md);
  try {
    return storeListing(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the real document parses, and is what ships', () => {
  // AGAINST THE ACTUAL FILE, not a fixture. A parser that only ever sees its
  // own examples is a parser that breaks the first time somebody edits the
  // document — which is a thing they are supposed to be able to do freely.
  const l = storeListing();
  assert.equal(l.name, 'Fleetwright');
  assert.ok(l.short.length > 20, 'the short description is empty or truncated');
  assert.ok(l.full.length > 500, 'the full description is empty or truncated');
  // And it is the copy from the document rather than something invented.
  const md = readFileSync(LISTING_PATH, 'utf8');
  assert.ok(md.includes(l.full.split('\n')[0]), 'the description did not come from the document');
});

test('the FIRST block wins, because the alternates are alternates', () => {
  // "Short description" carries a primary and two A/B candidates, with the
  // primary first and the others introduced as alternates. Taking the last
  // would publish a candidate; taking all of them would publish three
  // sentences glued together.
  const l = parse([
    '## App name (30 char max)', '', '```', 'Fleetwright', '```', '',
    '## Short description (80 char max)', '',
    '**Primary**', '', '```', 'the one that ships', '```', '',
    'Alternates:', '', '```', 'not this one', '```', '',
    '## Full description (4000 char max)', '', '```', 'body', '```', '',
  ].join('\n'));
  assert.equal(l.short, 'the one that ships');
});

test('a missing block is refused, not filled from the section below', () => {
  // THE FAILURE MODE OF A LENIENT PARSER HERE IS A STORE PAGE WITH THE WRONG
  // TEXT ON IT. Reaching past a heading for the next block available would put
  // the full description in the app name field, silently, on a real listing.
  assert.throws(
    () => parse([
      '## App name (30 char max)', '', '```', 'Fleetwright', '```', '',
      '## Short description (80 char max)', '', 'somebody deleted the block', '',
      '## Full description (4000 char max)', '', '```', 'body', '```', '',
    ].join('\n')),
    /Short description/,
    'a missing block was filled from somewhere else',
  );
});

test('a heading that is not there names itself', () => {
  assert.throws(
    () => parse('## App name (30 char max)\n\n```\nFleetwright\n```\n'),
    /Short description/,
  );
});

test('the store limits are checked here, not discovered on upload', () => {
  // A field one character over is refused by the API with a message about the
  // attribute, on a release run, minutes after the build — and the release is
  // what stops. Failing on the copy is cheap; failing on the shipment is not.
  assert.throws(
    () => parse([
      '## App name (30 char max)', '', '```', 'x'.repeat(31), '```', '',
      '## Short description (80 char max)', '', '```', 'short', '```', '',
      '## Full description (4000 char max)', '', '```', 'body', '```', '',
    ].join('\n')),
    /App name is 31 characters; the limit is 30/,
  );
});

test('the release applies the listing, and never dies for want of it', () => {
  // A listing that cannot be read is not a reason to drop a release: the copy
  // already on the store is what stays, and it says so.
  const src = readFileSync(new URL('../tools/appstore-release.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ storeListing \} from '\.\/store-listing\.mjs'/);
  assert.match(src, /attributes\.description = listing\.full/);
  // Short description is Play's field; promotional text is the App Store's
  // equivalent slot, and the only one editable without a new version.
  assert.match(src, /attributes\.promotionalText = listing\.short/);
  assert.match(src, /::warning::store listing not applied/);

  // ONE PATCH, because they are one object: two requests would leave a version
  // half-updated when the second failed.
  const block = src.slice(src.indexOf('const attributes = {}'), src.indexOf('// Submission, via'));
  assert.equal((block.match(/method: 'PATCH'/g) || []).length, 1, 'the listing is written in more than one request');
});

test('the document is where both stores read from, not one of them', () => {
  // It lived under apps/android/ while its own text tells you what to type into
  // App Store Connect. A single source filed under one of the two consumers is
  // a single source until somebody tidies up.
  assert.match(LISTING_PATH.pathname, /apps\/store-listing\.md$/);
  const md = readFileSync(LISTING_PATH, 'utf8');
  assert.match(md, /App Store Connect/, 'the shared document stopped covering the App Store');
  assert.match(md, /Play/, 'the shared document stopped covering Play');
});
