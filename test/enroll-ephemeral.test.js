import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// THE GAP THIS CATCHES is not a wrong value — it is a field that exists at
// every layer except the one that carries it. `mint()` has accepted `ephemeral`
// since the framework was built, the registry retires on it, the scheduler
// refuses to place work on it, and the HTTP handler dropped it on the floor. So
// every CI runner enrolled as a permanent host and left its entry behind when
// the job ended, with the retirement code that exists to prevent exactly that
// never running once.
//
// Source-level, because the failure was structural rather than behavioural:
// nothing was wrong with any function, and no test of a function could see it.
const SERVER = readFileSync(new URL('../src/fleet/coordinator/server.js', import.meta.url), 'utf8');
const DO = readFileSync(new URL('../worker/src/fleet-do.js', import.meta.url), 'utf8');
const OPENAPI = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const IOS = readFileSync(new URL('../apps/ios/Fleetwright/Fleet.swift', import.meta.url), 'utf8');
const ANDROID = readFileSync(new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt', import.meta.url), 'utf8');

test('both coordinators pass ephemeral through to mint', () => {
  for (const [name, src] of [['node server', SERVER], ['worker DO', DO]]) {
    assert.match(src, /ephemeral: Boolean\(body\?\.ephemeral\)/, `${name} drops ephemeral`);
  }
});

test('the contract says the field exists', () => {
  const props = OPENAPI.paths['/api/enroll'].post.requestBody.content['application/json'].schema.properties;
  assert.equal(props.ephemeral?.type, 'boolean');
});

test('both apps can ask for one', () => {
  // A capability only reachable by curl is a capability the product does not
  // have — which is precisely what this was for as long as it existed.
  // The signature grew a bound-pin form; ephemeral is still its first
  // parameter and still defaulted, so existing callers are unchanged.
  assert.match(IOS, /mintHostPin\(ephemeral: Bool = false/);
  assert.match(IOS, /"ephemeral": ephemeral/);
  assert.match(ANDROID, /mintHostPin\(\s*ephemeral: Boolean = false/);
  assert.match(ANDROID, /put\("ephemeral", ephemeral\)/);
});
