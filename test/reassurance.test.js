// "Nothing needs you", and why the app is confident of it.
//
//   node --test test/
//
// docs/psychology.md names this as the product's real job:
//
//   The product's real job is to convert unbounded anxiety into bounded
//   knowledge — and the important consequence is that "nothing needs you" is
//   the most important state in the system, not the least.
//
// Neither app said it. A list of rows is not that: reading five rows and
// concluding none of them is asking anything is work, and it is work somebody
// redoes every time they open the app, which is the loop the anxiety runs in.
//
// The banner is written twice, once per platform, so what is checked here is
// that the two say the same things — and that both of them keep the property
// that makes the line worth trusting at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** Comments stripped. Five tripwires in this repo have matched the prose. */
const code = (/** @type {string} */ src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const ios = read('apps/ios/Fleetwright/Reassurance.swift');
const android = read('apps/android/app/src/main/java/network/thetech/fleetwright/Reassurance.kt');

test('both phones say the same five things, in the same order of urgency', () => {
  // The ORDER is the design. One clause, and the most urgent true one — a
  // banner that leads with "3 machines healthy" while a session is waiting has
  // buried the only sentence worth reading.
  const clauses = [
    'waiting for you',
    'needs a look',
    'No machines are reporting',
    'Nothing is running',
    'Nothing needs you',
  ];
  for (const [name, src] of [['iOS', ios], ['Android', android]]) {
    let at = -1;
    for (const clause of clauses) {
      const found = src.indexOf(clause);
      assert.ok(found > 0, `${name} never says "${clause}"`);
      assert.ok(found > at, `${name} says "${clause}" out of urgency order`);
      at = found;
    }
  }
});

test('a fleet nobody can hear from is not a fleet with nothing running', () => {
  // §7: silence has to be trustworthy before it is comfortable. If the app is
  // quiet because everything is fine AND quiet because every host dropped,
  // then quiet means nothing and the anxiety comes straight back.
  //
  // So `blind` is its own state with its own sentence, and it must not be
  // reachable from the same branch as "nothing is running".
  for (const [name, src] of [['iOS', ios], ['Android', android]]) {
    assert.match(src, /blind/, `${name} cannot tell an empty fleet from an unreachable one`);
    assert.match(src, /no health from any machine/, `${name} does not say why it cannot tell`);
  }
});

test('the headline never stands alone', () => {
  // A reassurance with no basis is one somebody has to take on faith, and the
  // whole argument for this line is that they should not have to.
  for (const [name, src] of [['iOS', ios], ['Android', android]]) {
    assert.match(src, /\bbasis\b/, `${name} has a headline with nothing behind it`);
    assert.match(src, /machines? healthy/, `${name} never says what it counted`);
    assert.match(src, /looksStalled/, `${name} counts finished sessions as needing attention`);
  }
});

test('nothing here is a badge, a streak or a number that moves for its own sake', () => {
  // The end of docs/psychology.md rules these out by name. The interruption
  // budget belongs to the sessions, and spending any of it on the product
  // itself is spending it against the person.
  for (const [name, src] of [['iOS', ios], ['Android', android]]) {
    for (const banned of ['streak', 'badgeCount', 'achievement']) {
      assert.ok(!code(src).includes(banned), `${name} grew a ${banned}`);
    }
  }
});

test('colour agrees with the words and never carries them', () => {
  // §5. Colour is pre-attentive, which makes it excellent reinforcement and
  // terrible as the sole carrier of meaning: a colour-blind reader loses it
  // entirely and everybody loses it in sunlight.
  //
  // Checked as a structural property — the tint is computed from the same
  // fields the headline is, so there is no state the colour can express that
  // the sentence does not.
  assert.match(ios, /var tint: Color \{[\s\S]*?waiting > 0[\s\S]*?\}/);
  assert.match(android, /val tint: Color = when \{[\s\S]*?waiting > 0/);
});

test('both apps show how long a session has been quiet, and neither shouts about a pause', () => {
  // "Running" was doing two jobs: a session mid-build and one that has not
  // moved since Tuesday looked identical, in the same font, and the difference
  // is the entire question somebody opens this app to ask.
  const models = [
    ['iOS', read('apps/ios/Fleetwright/Fleet.swift'), read('apps/ios/Fleetwright/FleetView.swift')],
    [
      'Android',
      read('apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt'),
      read('apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt'),
    ],
  ];
  for (const [name, model, view] of models) {
    assert.match(model, /quietFor/, `${name} does not compute it`);
    assert.match(view, /quietFor/, `${name} computes it and shows it nowhere`);
    // A FLOOR, and it is what keeps the field meaningful. A pane pauses
    // constantly — waiting on a network call, thinking, between tool calls —
    // and a counter that resets every few seconds is noise that teaches people
    // to ignore it.
    assert.match(model, /300/, `${name} has no floor, so it will flicker on every pause`);
    // AND IT SAYS WHICH KIND OF STILL. A finished session and a wedged one
    // both stop changing; rendering both as "quiet for 3h" is true of each and
    // useful about neither, and it invited a person to worry at the most
    // common state in the fleet. The banner counts only the stalled ones for
    // the same reason.
    assert.match(model, /atRest/, `${name} cannot tell a finished session from a stuck one`);
    assert.match(model, /looksStalled/, `${name} has no notion of "worth a second look"`);
    // Never for a session at a prompt: that pane is still because somebody has
    // to answer it, which is the opposite of idle.
    assert.match(model, /prompt/, `${name} would call a waiting session idle`);
  }
});

test('a person with nowhere to run anything sees a setup step, not an empty list', () => {
  // ONBOARDING, and the moment it went wrong. Somebody new signs in, sees
  // "Nothing is running" and a Start button, taps it, and is refused for want
  // of a Claude account — having been told nothing about needing one. The
  // first screen is confident and the second is a refusal.
  //
  // A person with nowhere to run anything is not looking at an empty list.
  // They are looking at a setup step, and it is a different screen.
  const src = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');

  assert.match(src, /needsSetup/, 'the two empty states are still one');
  assert.match(src, /Nothing set up yet/);
  assert.match(src, /Connect Claude/, 'and it does not offer the thing that fixes it');

  // ASKED AS THE PERSON. The count a host reports is fleet-wide — how many
  // people can start something here — so a guest joining a fleet where
  // somebody else has connected would read as "set up" while being unable to
  // start anything. Whose account is missing is a question about the asker.
  assert.match(src, /myClaudeHosts/, 'it judges setup on somebody else\'s account');

  // AND BOTH HALVES HAVE TO BE KNOWN. An empty fleet list is "we have not
  // heard yet" and a nil answer is "we have not asked" — neither is evidence,
  // and claiming setup is needed on the strength of a missing answer is the
  // benign-looking lie this project keeps refusing.
  assert.match(src, /guard !fleetHosts\.isEmpty, let mine = myClaudeHosts/);
});
