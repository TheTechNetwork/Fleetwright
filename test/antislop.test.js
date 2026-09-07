// The design rules an agent is expected to follow here, and the one exception.
//
// WHY A TEST AT ALL, for a document. CLAUDE.md is the file that tells whoever
// is next — a person or an agent — which rules apply and which have already
// been settled. A pointer to a design system that has moved, or an exception
// whose reasoning has been deleted while the exception stays, is worse than no
// document: it is a document that is confidently wrong, and it is read at the
// moment somebody is deciding what a screen should look like.
//
// So this checks the claims it makes about the repository are still true.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const MD = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');
const url = (/** @type {string} */ p) => new URL(`../${p}`, import.meta.url);

test('every file it points at exists', () => {
  // A pointer to a moved file is the failure mode of a document nobody runs.
  for (const [, link] of MD.matchAll(/\]\(([^)#]+\.(?:md|sh|js))\)/g)) {
    assert.equal(existsSync(url(link)), true, `CLAUDE.md points at ${link}, which is not there`);
  }
});

test('the tests it says enforce the rules are the tests that exist', () => {
  // "Do not re-litigate these" is only safe advice while the things it names
  // are real. A table of enforcement that has drifted invites somebody to
  // trust a check that stopped running.
  for (const [, file] of MD.matchAll(/`(test\/[\w.-]+\.test\.js)`/g)) {
    assert.equal(existsSync(url(file)), true, `CLAUDE.md credits ${file}, which is not there`);
  }
});

test('the em-dash exception carries its count, and the count is honest', () => {
  // THE ONE RULE THIS PROJECT DOES NOT FOLLOW. An exception to a Hard Gate rule
  // has to say how much it is exempting, or it is a licence rather than a
  // decision — and a number in prose goes stale silently, which is the whole
  // reason it is checked here.
  const claimed = MD.match(/(\d+) of them across the two apps and (\d+) more/);
  assert.ok(claimed, 'the exception no longer says how many strings it covers');

  const apps = [
    'apps/ios/Fleetwright',
    'apps/android/app/src/main/java/network/thetech/fleetwright',
  ];
  let inApps = 0;
  for (const dir of apps) {
    for (const f of readdir(dir)) {
      const src = readFileSync(url(`${dir}/${f}`), 'utf8');
      inApps += (src.match(/"[^"\n]*—[^"\n]*"/g) || []).length;
    }
  }

  // WITHIN A MARGIN, not to the unit. Pinning it exactly would fail on a
  // sentence somebody reworded, which teaches people to edit the number
  // without reading what it is for. Ten is close enough to catch "the
  // exception quietly grew to cover the whole app".
  const said = Number(claimed[1]);
  assert.ok(
    Math.abs(inApps - said) <= 10,
    `CLAUDE.md says ${said} user-facing em dashes in the apps; there are ${inApps}`,
  );
});

test('the exception says what would delete it', () => {
  // An exception with no way out is a rule change wearing a note's clothes.
  assert.match(MD, /it is a mechanical change and this paragraph is what\s*\n?\s*should be deleted with it/);
});

test('the dials are set, because antislop requires them before any UI work', () => {
  for (const dial of ['ENERGY', 'RHYTHM', 'MOTION']) {
    assert.match(MD, new RegExp(`\\*\\*${dial}\\*\\*\\s*\\|\\s*1`), `${dial} is not set to a value`);
  }
  // And the design system is named as the DESIGN.md antislop expects, rather
  // than the rules floating free of any direction.
  assert.match(MD, /docs\/design-system\.md/);
});

/** @param {string} dir */
function readdir(dir) {
  return readdirSync(url(dir)).filter((/** @type {string} */ f) => /\.(swift|kt)$/.test(f));
}
