// The sandbox variant and the labels, on the two phones.
//
// These read the Swift and the Kotlin as TEXT, which can prove a rule is
// present in both places and cannot prove the two agree — the limit
// docs/app-parity.md names. So each one asserts a PROPERTY of the app rather
// than a line in a file: what happens on a host that has never answered, which
// chips offer Remove, what the keyboard is allowed to do to a label.
//
// Comments are stripped before every search. Three tests in this repository
// have now fired on the prose explaining why something was removed, which is a
// test passing because of the sentence describing the bug.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

// THE WHOLE APP. This named three files, and the settings panel it was
// reaching for has since moved into a fourth — the failure ios-sources.js was
// written about, arriving on the other phone.
const kotlin = () => androidSources();

/** Code with the comments taken out — line comments and block comments alike. */
const code = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

test('both phones can ask for either image and neither invents a default', () => {
  for (const [name, src] of [['iOS', code(iosSources())], ['Android', code(kotlin())]]) {
    assert.match(src, /"sandbox"/, `${name} cannot send the verb`);
    assert.match(src, /"minimal"/, `${name} does not offer the minimal image`);
    assert.match(src, /"browser"/, `${name} does not offer the browser image`);
    // NULL IS CANNOT TELL, and this is the whole reason the field is optional.
    // A host older than the verb sends nothing, and a control defaulted to
    // "minimal" would tell somebody their box has no Chromium when it might.
    assert.match(src, /has not said which image it runs sessions in/, `${name} guesses at an unanswered host`);
  }
});

test('a box whose image is named in its environment is told, not offered a picker', () => {
  // The channel already learned this: a control that refuses is worse than a
  // sentence, and the person finds out by tapping otherwise.
  assert.match(code(iosSources()), /pinned == true/);
  assert.match(code(kotlin()), /\bpinned\b/);
  for (const [name, src] of [['iOS', code(iosSources())], ['Android', code(kotlin())]]) {
    assert.match(src, /set on the box/, `${name} does not say who set the image`);
  }
});

test('both phones can add and remove a label', () => {
  for (const [name, src] of [['iOS', code(iosSources())], ['Android', code(kotlin())]]) {
    assert.match(src, /"labels"/, `${name} cannot send the verb`);
    assert.match(src, /"add"/, `${name} cannot add`);
    assert.match(src, /"remove"/, `${name} cannot remove`);
  }
});

test('Remove is offered on exactly the labels it works for', () => {
  // THE PROPERTY THIS SCREEN IS MOST LIKELY TO GET WRONG. `arm64` and `gpu`
  // look identical in the list the host sends, and the host refuses to drop one
  // of them — so a control on every chip would do nothing on half of them, and
  // the only way to find out is to tap it. C-2, functional completeness.
  //
  // THE GUARD AND THE CONTROL TOGETHER, not each somewhere in the file. The
  // first version of this test asserted that `setLabels.contains(label)`
  // appeared and that a Remove button appeared, and it passed with the guard
  // replaced by `true` — because the same expression is also used, negated, to
  // draw the "from the machine" note beside the other chips.
  const ios = code(iosSources());
  assert.match(
    ios,
    /\.swipeActions\(edge: \.trailing\) \{\s*if setLabels\.contains\(label\) \{[\s\S]{0,200}?Button\("Remove", role: \.destructive\)/,
    'iOS does not gate Remove on removability',
  );
  const kt = code(kotlin());
  assert.match(
    kt,
    /if \(label in setLabels\) \{[\s\S]{0,400}?trailingIcon = \{ Text\("✕"\) \}/,
    'Android does not gate the remove chip on removability',
  );
  // AND IT SAYS WHY, on both. Without a reason, the only difference between the
  // two kinds is a missing control, which reads as a bug.
  for (const [name, src] of [['iOS', ios], ['Android', kt]]) {
    assert.match(src, /from the machine/, `${name} does not say why a label cannot be removed`);
  }
});

test('neither keyboard is allowed to change a label on its way in', () => {
  // A label is compared for EQUALITY by the scheduler. `GPU` stored against
  // `gpu` aimed is a label that exists and can never be matched, which looks
  // exactly like tags being broken — and the phone is the only place in this
  // system that would capitalise a word without being asked.
  assert.match(code(iosSources()), /\.textInputAutocapitalization\(\.never\)/);
  const kt = code(kotlin());
  assert.match(kt, /capitalization = KeyboardCapitalization\.None/);
  assert.match(kt, /autoCorrectEnabled = false/);
});

test('the field is cleared when the label leaves, on both', () => {
  // A field still holding a name that was refused looks like it can be pressed
  // again. Same rule the credential paste already follows.
  assert.match(code(iosSources()), /newLabel = ""[\s\S]{0,200}?fleet\.labels\(host: hostId, add: wanted\)/);
  assert.match(code(kotlin()), /newLabel = ""[\s\S]{0,200}?labels\(host\.hostId, add = wanted\)/);
});

test('both believe the reply rather than waiting for the next frame', () => {
  // The host pushes a health frame after a mutating verb and each app's own
  // refresh races it. Losing that race shows the value somebody just changed
  // away from — on the one screen where they are looking straight at it.
  assert.match(code(iosSources()), /reply\.sandbox/);
  assert.match(code(iosSources()), /reply\.setLabels/);
  assert.match(code(kotlin()), /r\.sandboxVariant/);
  assert.match(code(kotlin()), /r\.setLabels/);
});

test('both lists move together, so no chip lingers or goes missing', () => {
  // Updating the removable set and leaving the full list alone draws a chip
  // that is gone, or hides one that is there, for the fifteen seconds until the
  // next health frame.
  for (const [name, src] of [['iOS', code(iosSources())], ['Android', code(kotlin())]]) {
    assert.match(src, /setLabels\.contains|it !in setLabels/, `${name} does not recompute the derived half`);
  }
  assert.match(code(iosSources()), /labels = Array\(Set\(derived\)\.union\(set\)\)\.sorted\(\)/);
  assert.match(code(kotlin()), /labels = \(derived \+ set\)\.distinct\(\)\.sorted\(\)/);
});

test('the host frame carries removability, so no screen has to derive it', () => {
  // Sent rather than asked for, like the channel and the variant beside it: a
  // list of machines must not become a round trip per row.
  const sidecar = readFileSync(new URL('../src/fleet/host/sidecar.js', import.meta.url), 'utf8');
  assert.match(code(sidecar), /setLabels: this\.hubConfig \? readLabels\(this\.hubConfig\) : \[\]/);
});
