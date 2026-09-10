// The session screen: the one state the product exists for, on a page.
//
// docs/plan.md Phase 2 asks for three things and this pins each: the state
// vocabulary owned in exactly one place, the pane read through `peek` and
// watched on a schedule that ENDS, and Remote Control front and centre
// whenever there is no published prompt. A grep, not a run; the Swift is
// compiled by CI's iOS job. Android joins with its own pull request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';

const SCREEN = readFileSync(new URL('../apps/ios/Fleetwright/SessionView.swift', import.meta.url), 'utf8');

test('the state vocabulary is owned on the model, in one place', () => {
  const swift = iosSources();
  assert.match(swift, /var stateSentence: String \{/);
  // Every sentence is a fact the frame carries. "At its prompt" and not
  // "finished": a session between two steps looks exactly the same.
  for (const words of ['Waiting for you', 'At its prompt', 'Quiet for', 'Working', 'Finished', 'Stopped']) {
    assert.ok(swift.includes(`"${words}`), `the vocabulary lost: ${words}`);
  }
  assert.doesNotMatch(swift, /"Stuck"|"Broken"/, 'a word the frame does not support');
  // Defined once: the page reads it and does not re-derive it.
  assert.equal((swift.match(/var stateSentence: String/g) || []).length, 1);
  assert.match(SCREEN, /session\.stateSentence/);
});

test('the pane is read through peek, shown unwrapped, and watched on a schedule that ends', () => {
  assert.match(SCREEN, /fleet\.peek\(session\.name\)/);
  // Monospaced, sideways, never reflowed: a wrapped pane is a different picture.
  assert.match(SCREEN, /ScrollView\(\.horizontal[\s\S]{0,400}\.fleetType\(\.labelMono\)[\s\S]{0,200}fixedSize\(horizontal: true, vertical: false\)/);
  // Ten looks three seconds apart, nine ten seconds apart, and then a button.
  assert.match(SCREEN, /static let quickLooks = 10/);
  assert.match(SCREEN, /static let quickInterval: Duration = \.seconds\(3\)/);
  assert.match(SCREEN, /static let slowLooks = 9/);
  assert.match(SCREEN, /static let slowInterval: Duration = \.seconds\(10\)/);
  assert.match(SCREEN, /watchEnded = true/);
  assert.match(SCREEN, /Button\("Look again"\)/);
  // Leaving the page is enough to stop asking the host: `.task` cancels.
  assert.match(SCREEN, /\.task\(id: watchGeneration\)/);
  // A blank pane is said in words, in the same words Android's Peek uses.
  assert.match(SCREEN, /Nothing is on \\\(session\.label\)'s screen right now\./);
});

test('Remote Control is front and centre when nothing is being asked, and the question when it is', () => {
  // The order in the source is the order on the page: the sentence, then
  // whatever needs a person, then the pane, then the actions.
  const sentence = SCREEN.indexOf('session.stateSentence');
  const asking = SCREEN.indexOf('sectionHead("It is asking")');
  const rc = SCREEN.indexOf('Continue in Remote Control');
  const pane = SCREEN.indexOf('sectionHead("On its screen")');
  const actions = SCREEN.indexOf('sectionHead("Actions")');
  assert.ok(sentence > 0 && sentence < asking && asking < rc && rc < pane && pane < actions, 'the page is out of order');
  // RC only when there is no prompt: the `else if` that reaches it is the
  // prompt branches' own.
  assert.match(SCREEN, /\} else if session\.isRunning, let url = session\.rcUrl/);
});

test('the row is the way in, and the page tells the list when it changed something', () => {
  const list = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');
  assert.match(list, /NavigationLink \{\s*SessionView\(fleet: fleet, initial: session, onChange: changed\)/);
  assert.match(list, /changed: \{ await refresh\(keepStatus: true\) \}/);
  // The page's own actions go through one place that reloads the session
  // and tells the list, so a Stop moves the sentence and the row alike.
  assert.match(SCREEN, /await reload\(\)\s*await onChange\(\)/);
});

test('the new sentences carry no em dash', () => {
  // The count is pinned by test/antislop.test.js; new copy may not add one.
  for (const s of [
    'Continue in Remote Control',
    'Your shell on this session, in the browser. Anything typed there goes to the session as if you were at the box.',
    'Not running, so there is no screen to read. Output has what it printed; Resume brings the conversation back.',
    'Reading the screen…',
    'No longer watching.',
  ]) {
    assert.ok(SCREEN.includes(s), `lost: ${s}`);
    assert.doesNotMatch(s, /—/);
  }
});

test('a tapped notification opens the session it was about, on iOS', () => {
  // The name rides on the notification (FleetwrightApp posts it), and the
  // page is pushed once the fresh list confirms the session is still there.
  // A buzz that lands on a list of twelve is the search it existed to save.
  const list = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');
  assert.match(list, /note\.userInfo\?\["name"\] as\? String/);
  assert.match(list, /await refresh\(\)\s*if let name, let session = sessions\.first\(where: \{ \$0\.name == name \}\) \{\s*opened = session/);
  assert.match(list, /\.navigationDestination\(item: \$opened\) \{ session in\s*SessionView\(fleet: fleet, initial: session/);
});

// --- Android ------------------------------------------------------------------

import { androidSources } from './helpers/android-sources.js';

const SHEET = readFileSync(new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/SessionSheet.kt', import.meta.url), 'utf8');

test('Android owns the same vocabulary on its model, in the same words', () => {
  const kotlin = androidSources();
  assert.match(kotlin, /val stateSentence: String get\(\) \{/);
  assert.equal((kotlin.match(/val stateSentence: String/g) || []).length, 1, 'defined once');
  const swift = iosSources();
  for (const words of ['Waiting for you', 'At its prompt · idle', 'At its prompt', 'Quiet for', 'Working', 'Finished', 'Stopped · can be resumed', 'Stopped']) {
    assert.ok(swift.includes(`"${words}`), `iOS lost: ${words}`);
    assert.ok(kotlin.includes(`"${words}`), `Android lost: ${words}`);
  }
  assert.match(SHEET, /session\.stateSentence/);
});

test('the sheet watches the pane on the same schedule, unwrapped, and stops', () => {
  assert.match(SHEET, /fleet\.peek\(session\.name\)/);
  assert.match(SHEET, /QUICK_LOOKS = 10/);
  assert.match(SHEET, /QUICK_INTERVAL_MS = 3_000L/);
  assert.match(SHEET, /SLOW_LOOKS = 9/);
  assert.match(SHEET, /SLOW_INTERVAL_MS = 10_000L/);
  assert.match(SHEET, /watchEnded = true/);
  assert.match(SHEET, /Text\("Look again"\)/);
  // softWrap = false is the whole of the never-reflow rule on Android.
  assert.match(SHEET, /fontFamily = FontFamily\.Monospace,\s*softWrap = false/);
  assert.match(SHEET, /horizontalScroll\(rememberScrollState\(\)\)/);
  // Dismissing cancels: the schedule is an effect keyed on the generation.
  assert.match(SHEET, /LaunchedEffect\(watchGeneration, session\.isRunning\)/);
});

test('both phones put the same things in the same order, and say the same sentences', () => {
  const sentence = SHEET.indexOf('session.stateSentence');
  const asking = SHEET.indexOf('Text("It is asking"');
  const rc = SHEET.indexOf('Continue in Remote Control');
  const pane = SHEET.indexOf('Text("On its screen"');
  const actions = SHEET.indexOf('Text("Actions"');
  assert.ok(sentence > 0 && sentence < asking && asking < rc && rc < pane && pane < actions, 'the sheet is out of order');
  for (const s of [
    'Continue in Remote Control',
    'Your shell on this session, in the browser. Anything typed there goes to the session as if you were at the box.',
    'Not running, so there is no screen to read. Output has what it printed; Resume brings the conversation back.',
    'Reading the screen…',
    'No longer watching.',
    'Look again',
    "'s screen right now.",
  ]) {
    assert.ok(SCREEN.includes(s), `iOS lost: ${s}`);
    assert.ok(SHEET.includes(s), `Android lost: ${s}`);
  }
});

test('the card title is the way in on Android too, and the sheet tells the list', () => {
  const main = readFileSync(new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt', import.meta.url), 'utf8');
  assert.match(main, /\.heightIn\(min = 48\.dp\)\s*\.clickable\(onClick = onInspect\)/, 'a 48dp target');
  assert.match(main, /onInspect = \{ inspecting = session \}/);
  assert.match(main, /SessionSheet\([\s\S]{0,300}onChanged = \{ refresh\(keepStatus = true\) \}/);
  assert.match(SHEET, /reload\(\)\s*onChanged\(\)/);
});
