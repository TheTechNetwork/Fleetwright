// What makes the app feel slow, and the rule it was breaking to do it.
//
// Two separate faults, and only one of them is about speed.
//
// SEQUENTIAL FETCHES. Opening the Fleet tab did four round trips one after
// another before it drew anything, and every button on the screen calls the
// same function again when it finishes. On mobile data that is most of a
// second of blank, repeated after every tap.
//
// AND A FAILED REQUEST WAS AN EMPTY FLEET. `(try? await …) ?? []` turns "the
// network blinked" into "you have no machines": the list goes blank and fills
// in again a moment later. That is the null-is-not-empty rule — written down in
// this project more than once, and broken in the app that shows the answer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const VIEW = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');
const MAIN = readFileSync(
  new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt', import.meta.url),
  'utf8',
);
/** Source with its commentary gone, so a note about a pattern is not read as one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('independent requests are asked for at the same time', () => {
  const load = VIEW.slice(VIEW.indexOf('private func loadHosts() async'), VIEW.indexOf('/// "elibrody2@gmail.com'));
  // Four answers, one wait. `async let` starts them all and waits once, so the
  // cost is the slowest rather than the sum.
  assert.equal((load.match(/async let /g) || []).length, 4, 'loadHosts went back to waiting on each in turn');
  assert.doesNotMatch(bare(load), /await Fleet\(settings: settings\)\.\w+\(\)/,
    'a request is still being awaited inline, one at a time');

  // The sessions screen asks for the bin's hosts alongside the list rather
  // than after it — they do not depend on each other.
  const refresh = VIEW.slice(VIEW.indexOf('private func refresh(keepStatus'), VIEW.indexOf('private func act('));
  assert.match(refresh, /async let reporting = fleet\.fleetHosts\(\)/);

  const android = MAIN.slice(MAIN.indexOf('LaunchedEffect(signedIn)'), MAIN.indexOf('Text("Devices"'));
  assert.match(android, /val devices = async \{/);
  assert.match(android, /val happened = async \{/);
});

test('a request that failed does not empty the screen', () => {
  // A list that was right ten seconds ago is a better answer than nothing, and
  // the next refresh corrects it. Blanking is how a blip looks like a fleet
  // that went away.
  const load = bare(VIEW.slice(VIEW.indexOf('private func loadHosts() async'), VIEW.indexOf('/// "elibrody2@gmail.com')));
  assert.doesNotMatch(load, /\?\? \[\]/, 'a failed fetch is assigned an empty array again');
  for (const field of ['fleetHosts', 'hosts', 'clients', 'events']) {
    assert.ok(
      load.includes(`{ ${field} = got }`),
      `${field} is not guarded against a failed request`,
    );
  }
});

test('"we have not asked" and "asked, and nobody" stay different', () => {
  // THE ONE THAT DECIDES WHAT SCREEN SOMEBODY SEES. `myClaudeHosts` is optional
  // precisely so those two are distinguishable — needsSetup says so in as many
  // words — and `?? []` on a FAILED ask collapsed them, so the app told a
  // person whose fleet is fine that nothing is set up yet, because one request
  // did not come back.
  const refresh = VIEW.slice(VIEW.indexOf('private func refresh(keepStatus'), VIEW.indexOf('private func act('));
  assert.match(refresh, /if let reply = try\? await fleet\.connections\(\) \{/);
  // The inner `?? []` is correct and stays: the fleet ANSWERED, and nobody
  // linked is a real answer.
  assert.match(refresh, /myClaudeHosts = reply\.connections\?\.linked\("claude"\)\?\.hosts \?\? \[\]/);

  // And the distinction it protects is still written down where it is read.
  assert.match(VIEW, /guard !fleetHosts\.isEmpty, let mine = myClaudeHosts else \{ return false \}/);
});

test('a fact is not printed twice on one row', () => {
  // THE SAME FAULT, SHIPPED ONE SECTION DOWN BY THE SAME HAND. The fleet card
  // was cleaned up for printing the account twice, and the Devices and Recent
  // activity sections added in the same week read:
  //
  //   iPhone (elibrody2@gmail.com)              elibrody2@gmail.com asked for connect
  //   elibrody2@gmail.com · never used          on coordinator · elibrody2@gmail.com · 1 hour ago
  //
  // Eleven rows of the first, nine of the second, each saying the one thing
  // that could tell them apart twice and the thing that could not, once.
  const view = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');

  // The address only when it is somebody ELSE'S, which is when it is news.
  const client = view.slice(view.indexOf('private func describeClient'), view.indexOf('/// Consecutive identical events'));
  assert.match(client, /email != settings\.signedInAs/);

  const who = view.slice(view.indexOf('private func describeEventWho'), view.indexOf('/// Milliseconds since the epoch'));
  assert.match(who, /a != settings\.signedInAs/);
  // "on coordinator" is not a place. It is where everything happens, so it
  // distinguished nothing and appeared on nearly every line.
  assert.match(who, /h != "coordinator"/);
});

test('the lists are ordered by what somebody came to find', () => {
  const view = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');

  // IN USE FIRST. The coordinator sorts by when a credential was MINTED, which
  // on a real account put seven never-used sign-ins above the phone in the
  // hand holding it.
  assert.match(view, /clientsInUse[\s\S]{0,200}?sorted \{ \(\$0\.lastSeenAt \?\? 0\) > \(\$1\.lastSeenAt \?\? 0\) \}/);
  // And the abandoned ones fold away rather than being deleted from the screen:
  // still there, still revocable, no longer first.
  assert.match(view, /DisclosureGroup\("\\\(clientsNeverUsed\.count\) never used"\)/);

  // NINE LINES SAYING "asked for connect" IS ONE FACT. Consecutive only —
  // two bursts an hour apart are two things that happened, and merging them
  // would lose the second one's time.
  assert.match(view, /private var runs: \[EventRun\]/);
  assert.match(view, /out\[out\.count - 1\]\.count \+= 1/);
  assert.match(view, /Text\("×\\\(run\.count\)"\)/);
});

test('a page shows the answer it just received', () => {
  // "Clicking check takes a sec but we get a response — why doesn't the page
  // refresh? Requires going in and out, almost like everything is static."
  //
  // It WAS static. `health`, `state` and `reason` were `let`s captured when the
  // page was pushed, so nothing on it could change: the check answered, the
  // reply appeared in the box at the bottom, and the summary above went on
  // saying what it said when the page opened. "Apply update" could not appear
  // no matter what the check found, because the value gating it was a constant.
  const host = readFileSync(new URL('../apps/ios/Fleetwright/HostView.swift', import.meta.url), 'utf8');

  assert.match(host, /@State private var health: Fleet\.HostHealth\?/);
  assert.match(host, /@State private var state: String\?/);
  // The passed-in values seed the state and are not read again.
  assert.match(host, /let initialHealth: Fleet\.HostHealth\?/);
  assert.match(host, /health = initialHealth/);

  // The reply lands on the page that asked for it...
  assert.match(host, /if let w = reply\.waiting \{ health = health\?\.withUpdates\(w\) \}/);
  // ...and everything the reply is silent about is re-read, rather than waiting
  // for somebody to leave the page and come back.
  assert.match(host, /private func reload\(\) async/);
  assert.match(host, /await reload\(\)/);
  // A failed reload keeps what it had: a page that blanks because the network
  // blinked is the fault the list was just fixed for.
  assert.match(host, /guard let hosts = try\? await fleet\.fleetHosts\(\) else \{ return \}/);
});

test('an app that has not asked yet does not claim there is nothing', () => {
  // "On app start the app looks empty or broken."
  //
  // Every list starts empty, so for the second before the fleet replies the app
  // said "No hosts reporting yet", "No devices reported" and "Nothing recorded
  // yet" — three confident statements about a question nobody had asked. On a
  // cold start that is the whole first impression.
  //
  // The same null-is-not-empty rule this project argues for everywhere else,
  // and did not make on its own opening screen. A splash would hide it; this
  // says it, which is cheaper and true.
  const view = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');
  assert.match(view, /@State private var loaded = false/);
  for (const claim of ['No hosts reporting yet.', 'No devices reported.', 'Nothing recorded yet.']) {
    assert.ok(
      view.includes(`Text(loaded ? "${claim}" : "Asking the fleet…")`),
      `"${claim}" is stated before an answer has arrived`,
    );
  }
  // Set AFTER the four requests, not before: "loaded" means an answer arrived.
  const load = view.slice(view.indexOf('private func loadHosts() async'), view.indexOf('/// "elibrody2@gmail.com'));
  assert.ok(load.indexOf('loaded = true') > load.lastIndexOf('if let got = try? await'),
    'loaded is set before the answers land');
});
