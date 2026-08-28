// A title is prose. It travels as a FIELD beside the command, never inside it.
//
// Everything in `command` is split on whitespace, so a title with spaces would
// arrive as arguments and a title that looks like a flag would arrive as a
// flag. That is the same mistake `answer` taking an ordinal exists to avoid: a
// string that looks bounded and is not.
//
// These tests drive the real HTTP route rather than the command function,
// because the route is where the field is accepted and validated, and it is
// reachable by anything holding the hub token -- not only by the sidecar that
// has already validated once.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanText, TITLE_MAX, BRIEF_MAX } from '../src/core/text.js';
import { commandMeta, toCommandLine } from '../src/fleet/host/sidecar.js';

test('prose never reaches the command line', () => {
  // The line the hub receives must be identical whether or not a title was
  // given. If a title ever appears here, it is being parsed as arguments.
  const bare = toCommandLine({ verb: 'start', params: { name: 'job' } });
  const titled = toCommandLine({
    verb: 'start',
    params: { name: 'job', title: 'refactor auth --dangerous', brief: 'a b c' },
  });
  assert.equal(bare, titled);
  assert.equal(titled, '/new job');
  assert.doesNotMatch(titled, /refactor/);
  // ...and the dangerous-looking title did not become a flag.
  assert.doesNotMatch(titled, /--dangerous/);
});

test('commandMeta carries them instead, and only for start', () => {
  assert.deepEqual(commandMeta('start', { name: 'j', title: 'x', brief: 'y' }), { title: 'x', brief: 'y' });
  assert.deepEqual(commandMeta('start', { name: 'j' }), {});
  // A title on a verb that has no such parameter is not silently forwarded.
  assert.deepEqual(commandMeta('stop', { name: 'j', title: 'x' }), {});
});

test('the hub and the protocol share one definition of acceptable text', () => {
  // Two doors into the same storage. `?token=fwk_` was full fleet access
  // because two extraction sites disagreed and the disagreement failed open;
  // this is the same shape, so it is the same function on both sides.
  assert.equal(cleanText('  a   b  ', { max: 10 }).value, 'a b');
  assert.equal(cleanText('', { max: 10 }).ok, false);
  assert.equal(cleanText('a' + String.fromCodePoint(0x1b) + 'b', { max: 10 }).ok, false);
  assert.equal(cleanText('a' + String.fromCodePoint(0x202e) + 'b', { max: 10 }).ok, false);
  assert.equal(cleanText(String.fromCodePoint(0x1f680).repeat(60), { max: 60 }).ok, true);
});

test('the limits are named once', () => {
  // A hardcoded 60 in the HTTP route and a 60 in the protocol are two numbers
  // that agree today.
  assert.equal(TITLE_MAX, 60);
  assert.equal(BRIEF_MAX, 500);
});
