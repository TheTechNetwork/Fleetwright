// The task picker, pinned across three surfaces.
//
// v3 gave `start` a `profile`, which is only worth having if somebody can
// choose one. That means the same wiring in two apps and a command layer, and
// nothing at runtime would notice one of them missing it: an app that never
// sends `profile` starts idle sessions exactly as it did before, with no error
// anywhere — which is the failure v3 was spent on, wearing a different hat.
//
// docs/app-parity.md exists because this project has already shipped a feature
// to one phone and reported it done on both. This is that document as a test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const IOS = {
  fleet: read('apps/ios/Fleetwright/Fleet.swift'),
  sheet: read('apps/ios/Fleetwright/StartSheet.swift'),
  kind: read('apps/ios/Fleetwright/SessionKind.swift'),
  view: read('apps/ios/Fleetwright/FleetView.swift'),
  voice: read('apps/ios/Fleetwright/Shortcuts.swift'),
};
const DROID = {
  fleet: read('apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt'),
  sheet: read('apps/android/app/src/main/java/network/thetech/fleetwright/StartSheet.kt'),
  kind: read('apps/android/app/src/main/java/network/thetech/fleetwright/SessionKind.kt'),
  view: read('apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt'),
};

test('both apps can ask what tasks the fleet has', () => {
  assert.match(IOS.fleet, /func profiles\(\)/);
  assert.match(DROID.fleet, /suspend fun profiles\(\)/);
  // The verb, spelled the way the protocol spells it. A typo here is a request
  // the coordinator refuses as an unknown verb, which reads as "the fleet is
  // broken" rather than as "this app asked for the wrong thing".
  assert.match(IOS.fleet, /intent\("profiles"/);
  assert.match(DROID.fleet, /intent\("profiles"/);
});

test('both apps send the profile on start, and neither sends the words', () => {
  for (const [name, src] of [['iOS', IOS.fleet], ['Android', DROID.fleet]]) {
    assert.match(src, /params\["profile"\] = profile|put\("profile", profile\)/,
      `${name} never puts profile on a start intent`);
    // THE CONTENT MUST NOT HAVE A ROUTE. A phone that could supply the words
    // would be writing the instructions of an agent running as root in a
    // container — docs/task-at-start.md, and the rule wanted.md set before any
    // of this was built.
    assert.equal(/"(prompt|task|instructions)"\s*[:,]/.test(src), false,
      `${name} has a field that could carry a task's text`);
  }
});

test('the picker is not rendered before the fleet has answered', () => {
  // "This fleet has no profiles" and "nobody answered the question" are
  // different facts, and a picker cannot tell them apart from an empty list.
  // Rendering one while the request is in flight offers "nothing" as if it were
  // the answer, and somebody taps Start.
  assert.match(IOS.sheet, /profilesAnswered/);
  assert.match(IOS.sheet, /if profilesAnswered, !profiles\.isEmpty/);
  // Kotlin says it with a nullable list rather than a second flag: null is
  // cannot-tell, empty is nothing.
  assert.match(DROID.sheet, /mutableStateOf<List<Fleet\.Profile>\?>\(null\)/);
  assert.match(DROID.fleet, /val profiles: List<Profile>\? = null/);
});

test('a profile only one host has pins the host', () => {
  // `start { profile }` on a box without that file is refused. A picker that
  // let somebody choose a task and then land elsewhere would produce a refusal
  // they cannot act on.
  assert.match(IOS.sheet, /owners\.count == 1/);
  assert.match(DROID.sheet, /owners\.size == 1/);
});

test('a kind carries a task on both phones, and Android carries a host at last', () => {
  // A kind is what makes "start an orgi session" mean something spoken, which
  // is the surface with no screen to drive an idle session from afterwards.
  assert.match(IOS.kind, /var profile: String = ""/);
  assert.match(DROID.kind, /val profile: String = ""/);
  // ANDROID HAD NO HOST FIELD AT ALL while iOS has had one since placement
  // shipped, so a kind naming a box did nothing here, silently. That is the
  // gap docs/app-parity.md exists to catch.
  assert.match(DROID.kind, /val host: String = ""/);
  // And stored kinds survive the upgrade: both are read with a default rather
  // than required, so a kind saved before these fields existed still loads.
  assert.match(DROID.kind, /host = o\.optString\("host"\)/);
  assert.match(DROID.kind, /profile = o\.optString\("profile"\)/);
});

test('the voice path applies the kind it was given', () => {
  // Spoken, only `mode` used to survive: "start a dev session" landed wherever
  // the scheduler chose and came up idle. A setting honoured on one surface and
  // ignored on another is the failure this app keeps paying for.
  const call = /Fleet\(settings: settings\)\.start\([\s\S]*?\n            \)/.exec(IOS.voice);
  assert.ok(call, 'the voice intent no longer starts a session');
  assert.match(call[0], /profile: chosen\?\.profile/);
  assert.match(call[0], /host: chosen\?\.host/);
});

test('starting with nothing to do says so, on every surface', () => {
  // "Started" reads as "working" and only one of the two is. Somebody who walks
  // away expecting output comes back to an empty prompt — twice reported, once
  // per beta round.
  assert.match(IOS.view, /come up idle, waiting for you/);
  assert.match(DROID.view, /come up idle, waiting for you/);
  assert.match(read('src/adapters/commands.js'), /IT STARTED IDLE/);
  assert.match(read('src/mcp/server.js'), /IT STARTED IDLE/);
});

test('the shipped profiles are prompts, not notes to a reader', () => {
  // A profile file IS the prompt: its whole content becomes the session's first
  // message, so there is nowhere in it to address the reader. The first version
  // of orient.md opened with three paragraphs explaining what a profile is,
  // which the model would have read as part of the instruction.
  const shipped = ['orient', 'repo-renovate-config', 'repo-dot-github', 'repo-dot-claude'];
  for (const name of shipped) {
    const text = read(`install/profiles/${name}.md`);
    assert.match(text, /^# /, `${name} has no heading, so /profiles has no summary for it`);
    assert.equal(/An example profile, installed so|Explanations go here/.test(text), false,
      `${name} addresses the reader instead of the model`);
  }
  // The note to the reader lives beside them, and is excluded from the list by
  // name — a README offered as a profile is a session started with "Example
  // profiles" as its instruction.
  assert.match(read('install/profiles/README.md'), /A profile file IS the prompt/);
});
