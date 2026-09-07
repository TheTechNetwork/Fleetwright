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
