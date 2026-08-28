// A session title is the first text a PERSON writes that this system stores and
// then renders everywhere: a phone list, a notification, a console, and read
// aloud by an assistant. So it is validated at the door rather than by each
// renderer -- the console already has a scrub(), and relying on that means the
// rule holds only where somebody remembered it.
//
// Every hostile character below is built from its code point rather than typed.
// A test about invisible characters should not contain any: pasted into a diff
// or a terminal they are, by construction, invisible.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateIntent, PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const start = (params) => ({
  v: PROTOCOL_VERSION,
  kind: 'intent',
  id: 'abcd1234',
  verb: 'start',
  params,
  issuedAt: Date.now(),
});

const withChar = (code) => 'a' + String.fromCodePoint(code) + 'b';

test('a title and a brief travel with start', () => {
  const r = validateIntent(start({ title: 'refactor auth', brief: 'split the token check out' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.intent.params, { title: 'refactor auth', brief: 'split the token check out' });
});

test('whitespace is collapsed, so a padded title is not a different title', () => {
  const r = validateIntent(start({ title: '  refactor   auth  ' }));
  assert.equal(r.ok, true);
  assert.equal(r.intent.params.title, 'refactor auth');
});

test('a title of only whitespace is empty, not valid', () => {
  const r = validateIntent(start({ title: '   ' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /must not be empty/);
});

test('length is counted in characters, not UTF-16 code units', () => {
  // 60 emoji is 120 code units. Measuring with .length would refuse this and,
  // worse, would invite a truncating client to cut a title through the middle
  // of a character and store half a surrogate pair.
  assert.equal(validateIntent(start({ title: String.fromCodePoint(0x1f680).repeat(60) })).ok, true);
  assert.equal(validateIntent(start({ title: 'x'.repeat(60) })).ok, true);
  assert.equal(validateIntent(start({ title: 'x'.repeat(61) })).ok, false);
});

test('control characters are refused', () => {
  // NUL, BEL, ESC, DEL, and NEL and CSI from the C1 range. ESC starts a
  // terminal escape sequence in any surface that prints this, and NEL is a
  // line break to some renderers while NOT being whitespace to JS -- which is
  // exactly the kind of gap between two definitions that this check exists for.
  //
  // CR and LF are deliberately NOT here: they are whitespace to JS, so they
  // collapse to a space before this check sees them. See the collapse test
  // below. Refusing them instead would reject a title somebody pasted.
  for (const code of [0x00, 0x07, 0x1b, 0x7f, 0x85, 0x9b]) {
    const r = validateIntent(start({ title: withChar(code) }));
    assert.equal(r.ok, false, 'U+' + code.toString(16));
    assert.match(r.error, /control characters/);
  }
});

test('bidirectional overrides are refused, not substituted', () => {
  // RLO, LRO, PDF, the isolates, and the marks. An RLO in a title renders as
  // something else in every list it appears in. The console SUBSTITUTES so a
  // hostile label looks wrong; the protocol REFUSES, because the console is
  // displaying something that already exists and this is the door.
  for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2069, 0x200e, 0x200f]) {
    const r = validateIntent(start({ title: withChar(code) }));
    assert.equal(r.ok, false, 'U+' + code.toString(16));
    assert.match(r.error, /bidirectional overrides/);
  }
});

test('newline and carriage return collapse rather than being refused', () => {
  // A title is one line by definition, so a break in one is either a mistake or
  // an attempt to forge a second row in a list. Either way the result is one
  // line -- and collapsing is kinder than refusing for something a paste does
  // by accident. Both are whitespace to JS, so both are handled by the collapse
  // rather than by the control check, which is worth pinning down: the two
  // rules overlap and it should be clear which one owns these.
  for (const s of ['a\nb', 'a\rb', 'a\r\nb']) {
    const r = validateIntent(start({ title: s }));
    assert.equal(r.ok, true, JSON.stringify(s));
    assert.equal(r.intent.params.title, 'a b');
  }
});

test('brief may be long, and title may not', () => {
  assert.equal(validateIntent(start({ brief: 'x'.repeat(500) })).ok, true);
  assert.equal(validateIntent(start({ brief: 'x'.repeat(501) })).ok, false);
});

test('a non-string title is refused rather than coerced', () => {
  // Coercion is how {} becomes "[object Object]" and a number becomes a title.
  for (const bad of [42, null, {}, [], true]) {
    assert.equal(validateIntent(start({ title: bad })).ok, false, JSON.stringify(bad));
  }
});

test('start still refuses a parameter it does not define', () => {
  // The reason adding title/brief HAD to bump the protocol version: an old host
  // rejects an unknown parameter outright, so the version handshake would
  // otherwise say "we agree" immediately before the intent failed.
  const r = validateIntent(start({ colour: 'red' }));
  assert.equal(r.ok, false);
  assert.match(r.error, /takes no parameter/);
});
