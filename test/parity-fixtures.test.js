// The shared parity fixtures, and the two things Node can say about them.
//
// THE RULE IS WRITTEN TWICE — once in Kotlin, once in Swift — and there is no
// JavaScript copy, deliberately: a third implementation would be a third thing
// to drift. So this file does not check the ANSWERS. It checks that the table
// of answers is honest and that the machinery which runs it will actually run.
//
// WHY THE TABLE EXISTS AT ALL. reassurance.test.js asserts parity by matching
// words in the two sources:
//
//     assert.match(model, /quietFor/, `${name} does not compute it`);
//
// That passes whether Kotlin's stall floor is 90 seconds and Swift's is 120.
// Both files contain the word, the phones disagree, and nothing is red. A text
// search can prove a rule is MENTIONED in both places; only running both
// against the same inputs can prove they agree. The fixture is what makes that
// possible without a third implementation to compare against.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = 'test/fixtures/parity';
const read = (/** @type {string} */ f) => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));

const reassurance = read('reassurance.json');

test('every case is complete, so a half-written one cannot pass by being ignored', () => {
  // A consumer that silently skips a malformed case is a consumer that reports
  // green for a table nobody filled in. The shape is asserted here, once, in
  // the language that can do it cheaply.
  assert.ok(Array.isArray(reassurance.cases) && reassurance.cases.length > 0);
  for (const [i, c] of reassurance.cases.entries()) {
    assert.equal(typeof c.why, 'string', `case ${i} does not say why it exists`);
    assert.ok(c.why.length > 10, `case ${i}'s reason is not a reason`);
    assert.equal(typeof c.headline, 'string', `case ${i} has no expected headline`);
    assert.equal(typeof c.basis, 'string', `case ${i} has no expected basis`);
    for (const field of ['waiting', 'running', 'quiet', 'healthy']) {
      assert.equal(typeof c.in[field], 'number', `case ${i}.in.${field} is not a number`);
    }
    assert.ok(Array.isArray(c.in.unwell), `case ${i}.in.unwell is not a list`);
    assert.equal(typeof c.in.blind, 'boolean', `case ${i}.in.blind is not a boolean`);
  }
});

test('every headline the rule can produce is exercised', () => {
  // THE CHECK THAT KEEPS THE TABLE HONEST AS THE RULE GROWS. A fixture is only
  // worth what it covers, and the failure mode is silent: somebody adds a
  // clause, both apps implement it, and the table never mentions it — so the
  // one thing the fixture exists to catch is the one thing it now cannot.
  //
  // The list is the five outcomes docs/psychology.md argues for, in the order
  // of urgency that IS the design. Adding a sixth means adding a case.
  const seen = new Set(reassurance.cases.map((c) => c.headline));
  const shapes = [
    /^One session is waiting for you$/,
    /^\d+ sessions are waiting for you$/,
    /^One machine needs a look$/,
    /^\d+ machines need a look$/,
    /^No machines are reporting$/,
    /^Nothing is running$/,
    /^Nothing needs you$/,
  ];
  for (const shape of shapes) {
    assert.ok([...seen].some((h) => shape.test(h)), `no case produces a headline matching ${shape}`);
  }
});

test('the ordering of urgency is pinned, because the order is the design', () => {
  // One clause, and the most urgent TRUE one. A banner leading with "3 machines
  // healthy" while a session waits has buried the only sentence worth reading.
  //
  // Asserted as cases that could go either way and are expected to go one way:
  // each of these has two things true at once.
  const both = (pred) => reassurance.cases.filter(pred);

  const waitingAndUnwell = both((c) => c.in.waiting > 0 && c.in.unwell.length > 0);
  assert.ok(waitingAndUnwell.length, 'no case has both a waiting session and an unwell machine');
  for (const c of waitingAndUnwell) assert.match(c.headline, /waiting for you/, c.why);

  const unwellAndBlind = both((c) => c.in.waiting === 0 && c.in.unwell.length > 0 && c.in.blind);
  assert.ok(unwellAndBlind.length, 'no case has an unwell machine while blind');
  for (const c of unwellAndBlind) assert.match(c.headline, /needs a look/, c.why);

  const blindAndIdle = both((c) => c.in.waiting === 0 && !c.in.unwell.length && c.in.blind);
  assert.ok(blindAndIdle.length, 'no case is blind with nothing running');
  for (const c of blindAndIdle) {
    assert.equal(c.headline, 'No machines are reporting', `${c.why}: blind must outrank "Nothing is running"`);
  }
});

test('blind replaces the basis rather than joining it', () => {
  // The half that does the work. A count computed from no health at all would
  // be a reassurance taken on faith, which is the thing this line exists not to
  // ask for.
  for (const c of reassurance.cases.filter((x) => x.in.blind)) {
    assert.match(c.basis, /^The coordinator has no health/, c.why);
    assert.equal(c.basis.includes('·'), false, `${c.why}: blind must not carry counted clauses`);
  }
});

test('singular and plural are both exercised for every counted phrase', () => {
  // "1 sessions running" is the bug this catches, and it is the kind that
  // reaches a screenshot rather than a stack trace.
  const bases = reassurance.cases.map((c) => c.basis);
  for (const [singular, plural] of [
    ['1 session running', /\d+ sessions running/],
    ['1 of them quiet a while', /\d+ of them quiet a while/],
    ['1 machine healthy', /\d+ machines healthy/],
  ]) {
    assert.ok(bases.some((b) => b.includes(singular)), `nothing exercises "${singular}"`);
    assert.ok(
      bases.some((b) => plural.test(b) && !b.includes(singular)),
      `nothing exercises the plural of "${singular}"`,
    );
  }
});

// THE ROUTING TRAP THIS FIXTURE WOULD OTHERWISE INTRODUCE, and the reason this
// test is in the same file rather than left to somebody noticing.
//
// The fixture lives in test/, outside apps/**. Both app workflows trigger on
// `apps/**` — so a change to the TABLE, the one change the whole mechanism
// exists to police, would not run either app's tests. That is the identical
// failure #367 removed from ci.yml: a filter skipping the tests that guard the
// files it is skipping for.
//
// So the workflows have to name this directory, and this is what says so.
test('both app workflows run when a parity fixture changes', () => {
  const fixtures = readdirSync(DIR).filter((f) => f.endsWith('.json'));
  assert.ok(fixtures.length, 'no parity fixtures — delete this test rather than letting it pass vacuously');

  for (const wf of ['.github/workflows/android.yml', '.github/workflows/ios.yml']) {
    const text = readFileSync(wf, 'utf8');
    assert.ok(
      text.includes('test/fixtures/parity/'),
      `${wf} does not trigger on test/fixtures/parity/** — a change to the shared table\n` +
        '    would skip the app tests that consume it, which is the whole bug this fixture is for',
    );
  }
});
