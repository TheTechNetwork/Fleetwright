// Values the coordinator may push to a host, and the very short list of them.
//
//   node --test test/
//
// THIS IS A COMMAND CHANNEL WEARING A DIFFERENT HAT. "The coordinator can push
// configuration to hosts" is, unconstrained, exactly what design.md §5 refuses
// when it refuses shell strings: arbitrary key/value delivery from the party
// this system treats as compromised. So the tests here are mostly about what a
// coordinator CANNOT make a host store.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readConfigFrame, buildConfigFrame, CONFIG_KEYS } from '../src/fleet/protocol/config-frame.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const SECRET = 'clientsecret000000000000000000000000';
const frame = (values) => ({ v: PROTOCOL_VERSION, kind: 'config', values });

test('a named value arrives', () => {
  const r = readConfigFrame(frame({ githubClientSecret: SECRET }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.values, { githubClientSecret: SECRET });
  assert.deepEqual(r.dropped, []);
});

test('a key the host does not know is dropped, not stored', () => {
  // The whole guardrail. A host that stores whatever it is sent is a host whose
  // behaviour the coordinator writes.
  const r = readConfigFrame(frame({ githubClientSecret: SECRET, sandboxImage: 'evil/image:latest' }));

  assert.deepEqual(Object.keys(r.values), ['githubClientSecret']);
  assert.deepEqual(r.dropped, ['sandboxImage']);
});

test('one bad key does not reject the frame', () => {
  // Otherwise a coordinator can make a host refuse its own configuration by
  // adding a field — a denial primitive handed over for free.
  const r = readConfigFrame(frame({ githubClientSecret: SECRET, nonsense: 42 }));
  assert.equal(r.ok, true);
  assert.equal(r.values.githubClientSecret, SECRET);
});

test('a value that could not survive a command line is refused', () => {
  // Same charset as a protocol `secret`: no whitespace, quotes or backslashes.
  for (const bad of ['has space', "quo'te", 'back\\slash', '', 'x'.repeat(5000), 42, null]) {
    const r = readConfigFrame(frame({ githubClientSecret: bad }));
    assert.deepEqual(r.values, {}, JSON.stringify(bad));
    assert.deepEqual(r.dropped, ['githubClientSecret']);
  }
});

test('a refusal never quotes the value back', () => {
  // These are credentials, and a refusal travels to a log like every other one.
  const r = readConfigFrame(frame({ githubClientSecret: 'secret with a space in it' }));
  assert.equal(JSON.stringify(r).includes('secret with'), false);
});

test('a frame from another protocol version is not guessed at', () => {
  const r = readConfigFrame({ v: PROTOCOL_VERSION + 1, kind: 'config', values: { githubClientSecret: SECRET } });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /this host speaks/);
});

test('an intent is not a config frame and vice versa', () => {
  assert.equal(readConfigFrame({ v: PROTOCOL_VERSION, kind: 'intent', verb: 'list' }).ok, false);
  assert.equal(readConfigFrame(null).ok, false);
  assert.equal(readConfigFrame({ v: PROTOCOL_VERSION, kind: 'config' }).ok, false);
});

test('nothing to say sends no frame at all', () => {
  // A frame with no values would make a host log a delivery that carried
  // nothing, which is worse than silence.
  assert.equal(buildConfigFrame({}), null);
  assert.equal(buildConfigFrame({ githubClientSecret: null }), null);
  assert.equal(buildConfigFrame({ notAKey: 'x' }), null);
});

test('the coordinator can only build what the protocol names', () => {
  const built = buildConfigFrame({ githubClientSecret: SECRET, sandboxImage: 'evil/image' });
  assert.deepEqual(Object.keys(/** @type {any} */ (built).values), ['githubClientSecret']);
});

test('the list is short, and staying short is the point', () => {
  // "It should grow slowly and never become a map." A test rather than a
  // comment, because the way this stops being true is somebody adding a key
  // that seemed harmless in isolation.
  assert.ok(Object.keys(CONFIG_KEYS).length <= 3, 'the config channel is growing — is each key still necessary?');
});
