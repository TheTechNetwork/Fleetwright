// Check, then apply — for both, and only when there is something to apply.
//
// Reported from the fleet, and it was two different mistakes in two
// directions: Update ALWAYS RESTARTED (apply with no check) while Upgrade
// NEVER APPLIED (check with no apply). Both verbs have supported both halves
// since they shipped; the apps used one param each and never the other.
//
//   update  restart: yes|no
//   upgrade apply:   yes|no
//
// And `updates.system` — what the OS has waiting, already in prose from the
// host — had been travelling on every health report since maintenance shipped
// and was displayed nowhere. Which is exactly why upgrade looked like a verb
// that could only tell you things.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const APPS = [
  ['iOS', 'apps/ios/Fleetwright/FleetView.swift', 'apps/ios/Fleetwright/Fleet.swift'],
  [
    'Android',
    'apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt',
    'apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt',
  ],
];

test('both apps offer a check that applies nothing', () => {
  for (const [name, view] of APPS) {
    const src = read(view);
    assert.match(src, /"Check"/, `${name} has no check`);
    // The check is `upgrade` in its reporting mode — apply off, which is the
    // verb's own default and the thing it was designed to do.
    assert.match(src, /upgrade\((host: )?host(\.hostId)?\)/, `${name}'s check does not use upgrade's reporting mode`);
  }
});

test('apply is offered only when something is waiting', () => {
  // A button that is always offered teaches people to press it without
  // reading, which is the opposite of what a maintenance screen is for.
  for (const [name, view] of APPS) {
    const src = read(view);
    assert.match(src, /appPending/, `${name} offers "apply update" unconditionally`);
    assert.match(src, /systemPending/, `${name} offers "apply upgrade" unconditionally`);
    assert.match(src, /"Apply update"/, `${name} cannot apply a code update`);
    assert.match(src, /"Apply upgrade"/, `${name} cannot apply system packages`);
  }
});

test('the two pending answers are separate, because they are separate actions', () => {
  // Pulling code and installing packages are different things on different
  // schedules; one boolean would make "there is an update" ambiguous at
  // exactly the moment somebody is deciding whether to press it.
  for (const [name, , model] of APPS) {
    const src = read(model);
    assert.match(src, /appPending/, `${name} model has no appPending`);
    assert.match(src, /systemPending/, `${name} model has no systemPending`);
  }
});

test('what the OS has waiting is actually displayed', () => {
  // health.updates.system has been sent on every report since maintenance
  // shipped. Neither app rendered it, so "what is available" was only ever
  // visible by tapping a button that also did something.
  assert.match(read(APPS[0][1]), /updates\?\.system/, 'iOS does not show the system updates it receives');
  assert.match(read(APPS[1][2]), /systemUpdates/, 'Android does not parse the system updates it receives');
  assert.match(read(APPS[1][1]), /systemUpdates/, 'Android does not show the system updates it receives');
});

test('host output is rendered as output, not as a caption', () => {
  // "Update works although the output is hard to read." It is several lines of
  // a host's own text, with paths and commit ids in it, and it was going into
  // a squeezed grey caption that ran together into one paragraph.
  const ios = read(APPS[0][1]);
  assert.match(ios, /design: \.monospaced/, 'iOS still renders host output in the body font');
  assert.match(ios, /textSelection\(\.enabled\)/, 'iOS host output cannot be copied');
  const android = read(APPS[1][1]);
  assert.match(android, /FontFamily\.Monospace/, 'Android still renders host output in the body font');
  assert.match(android, /verticalScroll/, 'Android host output cannot scroll');
});
