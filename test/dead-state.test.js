// A `@State` nothing reads is an answer nobody sees.
//
// WHAT THIS IS ABOUT. The settings screen once held every machine's controls
// as rows. When those moved onto a page of their own, the controls went and
// their state did not: five `@State` properties, a `binAction`, a confirmation
// footer and an alert stayed behind, none of which anything could reach —
// nothing assigned `purgeTarget` or `confirmingRevoke`, so neither control
// could ever appear, and `hostActionResult` was written by both of them and
// rendered by nothing.
//
// That is not tidiness. One of those orphans carried this comment:
//
//     The refusal reaches the screen. This was `_ = try?`, which discarded the
//     error AND the reply — so a 403 ("removing machines needs an admin
//     credential") closed the sheet and showed nothing, and the symptom was
//     reported as "the host comes right back".
//
// A fix, in code nobody could run, describing a night somebody lost. The live
// revoke on the host's page had the same shape of bug in a different disguise:
// it set its answer and then dismissed the page it had just set it on. Dead
// state is where a lesson goes to be forgotten, and then relearned.
//
// WHAT IT CANNOT SEE, stated so nobody trusts it further than it goes. Three
// of those six orphans were written AND read inside the unreachable block
// itself, which reads as live from here — a check on names cannot tell that
// nothing ever presents the alert they belong to. It catches the ones that
// leak out of a deleted view, which is how this family starts.
//
// WHY THIS READS FILES RATHER THAN `iosSources()`. That helper concatenates
// the app so a test asserts a property of the APP rather than of a file, which
// is right for almost everything here and wrong for this: `@State private` is
// scoped to one type in one file, and a name declared in FleetView.swift is
// not made live by an unrelated `result` in People.swift. Concatenating would
// turn this check into one that always passes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../apps/ios/Fleetwright/', import.meta.url);

const DECLARES = /@State\s+(?:private\s+)?var\s+(\w+)/;

/**
 * Names this file declares as `@State` and never reads.
 *
 * A read is any mention that is not the declaration and not the left-hand side
 * of an assignment. `$name` counts — that is a binding, which is how SwiftUI
 * spells "somebody else reads and writes this" — and so does `\(name)`, and
 * `name.isEmpty`, and a `get:` closure. Only a name that is written and never
 * looked at again comes back.
 *
 * @param {string} src
 */
function writeOnly(src) {
  const lines = src.split('\n');
  /** @type {string[]} */
  const names = [];
  for (const line of lines) {
    const m = DECLARES.exec(line);
    if (m) names.push(m[1]);
  }

  return names.filter((name) => {
    const declaration = new RegExp(`@State\\s+(?:private\\s+)?var\\s+${name}\\b`);
    // Not preceded by a word character or a dot, so `someOther.result` and
    // `resultHost` do not count as reads of `result`.
    const mention = new RegExp(`(?<![\\w.])\\$?${name}\\b`, 'g');
    for (const line of lines) {
      if (declaration.test(line)) continue;
      for (const hit of line.matchAll(mention)) {
        const before = line.slice(0, hit.index).trim();
        const after = line.slice(hit.index + hit[0].length);
        const assignedHere = /^\s*=[^=]/.test(after) && (before === '' || before.endsWith('{') || before.endsWith(';'));
        if (!assignedHere) return false;
      }
    }
    return true;
  });
}

test('no screen holds state that nothing on it reads', () => {
  const found = readdirSync(DIR)
    .filter((f) => f.endsWith('.swift'))
    .sort()
    .flatMap((f) => writeOnly(readFileSync(new URL(f, DIR), 'utf8')).map((name) => `${f}: ${name}`));

  assert.deepEqual(
    found,
    [],
    'declared, written, and read by nothing — either draw it or delete it:\n  ' + found.join('\n  '),
  );
});

test('the check can still tell the difference', () => {
  // A test that cannot fail is the thing it is testing for. These are the two
  // shapes that matter: one orphan, and one held only through a binding, which
  // is a read and must not be reported.
  assert.deepEqual(
    writeOnly(['@State private var orphan = ""', 'func go() { orphan = "x" }'].join('\n')),
    ['orphan'],
  );
  assert.deepEqual(
    writeOnly(['@State private var showing = false', '.sheet(isPresented: $showing) { Thing() }'].join('\n')),
    [],
  );
});
