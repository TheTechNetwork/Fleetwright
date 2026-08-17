// The intent protocol.
//
//   node --test test/
//
// Most of these are not "does the validator work" — they are the specific
// things a compromised coordinator would try, written down so that a later
// convenience (accept unknown params, allow a path, generate the idempotency
// key here) fails loudly instead of quietly widening the blast radius.

import test from 'node:test';
import assert from 'node:assert/strict';

import { VERBS, PROTOCOL_VERSION, validateIntent, buildIntent, isMutating } from '../src/protocol/intents.js';

/** @param {object} patch */
const intent = (patch) => ({
  v: PROTOCOL_VERSION,
  kind: 'intent',
  id: 'idem-0000001',
  verb: 'list',
  params: {},
  issuedAt: 1_755_000_000_000,
  ...patch,
});

// --- the verb set itself ----------------------------------------------------

test('the verb set is exactly what is documented', () => {
  // Pinned deliberately. Adding a verb should be a visible edit to this list
  // and a version bump, not something that arrives with a feature.
  assert.deepEqual(Object.keys(VERBS).sort(), [
    'forget',
    'health',
    'list',
    'peek',
    'resume',
    'start',
    'status',
    'stop',
  ]);
});

test('login and code are not reachable from the coordinator', () => {
  // A compromised Worker being able to point a box at an attacker's Claude
  // account, or to harvest an authorization code mid-flow, is far outside
  // "someone started and stopped some sessions".
  assert.ok(!('login' in VERBS));
  assert.ok(!('code' in VERBS));
});

test('no verb accepts a path', () => {
  // agent-hub's /new <name> <path> takes any path with no validation, and a
  // sandboxed session's workdir is a fixed /work mount anyway. The parameter
  // simply does not exist, so no validator has to be correct about it.
  for (const [verb, spec] of Object.entries(VERBS)) {
    for (const key of Object.keys(spec.params)) {
      assert.ok(!/path|dir|cwd|file/i.test(key), `${verb} exposes a path-shaped parameter "${key}"`);
    }
  }
});

test('only state-changing verbs are marked mutating', () => {
  assert.deepEqual(
    Object.keys(VERBS).filter(isMutating).sort(),
    ['forget', 'resume', 'start', 'stop'],
  );
  for (const readOnly of ['list', 'status', 'peek', 'health']) {
    assert.equal(isMutating(readOnly), false, `${readOnly} must not be mutating`);
  }
});

// --- envelope ---------------------------------------------------------------

test('a well-formed intent validates and is returned normalised', () => {
  const r = validateIntent(intent({ verb: 'resume', params: { name: 'bigjob', choice: 'summary' }, actor: 'telegram:12345' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.intent.params, { name: 'bigjob', choice: 'summary' });
  assert.equal(r.intent.actor, 'telegram:12345');
});

test('a different protocol version is refused, not guessed at', () => {
  for (const v of [0, 2, '1', null, undefined]) {
    const r = validateIntent(intent({ v }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'unsupported_version');
  }
});

test('an unknown verb is refused', () => {
  for (const verb of ['exec', 'shell', 'login', 'code', '', 'LIST', '__proto__', 'constructor']) {
    const r = validateIntent(intent({ verb }));
    assert.equal(r.ok, false, `verb ${JSON.stringify(verb)} should be refused`);
    assert.equal(r.code, 'unknown_verb');
  }
});

test('a prototype-polluting verb cannot borrow Object.prototype', () => {
  // hasOwnProperty rather than `verb in VERBS` — "toString" is on every object.
  const r = validateIntent(intent({ verb: 'toString' }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unknown_verb');
});

test('an idempotency key is mandatory and bounded', () => {
  for (const id of [undefined, '', 'short', 'x'.repeat(129), 'has space', 'semi;colon', 42]) {
    const r = validateIntent(intent({ id }));
    assert.equal(r.ok, false, `id ${JSON.stringify(id)} should be refused`);
  }
  assert.equal(validateIntent(intent({ id: 'a'.repeat(128) })).ok, true);
});

test('non-intent envelopes are refused', () => {
  for (const raw of [null, undefined, 'a string', 42, [], intent({ kind: 'reply' }), intent({ kind: undefined })]) {
    assert.equal(validateIntent(raw).ok, false, `${JSON.stringify(raw)} should be refused`);
  }
});

test('issuedAt outside the skew window is stale', () => {
  const now = 1_755_000_000_000;
  const fresh = validateIntent(intent({ issuedAt: now - 1000 }), { now, maxSkewMs: 30_000 });
  assert.equal(fresh.ok, true);

  for (const at of [now - 60_000, now + 60_000]) {
    const r = validateIntent(intent({ issuedAt: at }), { now, maxSkewMs: 30_000 });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'stale');
  }
});

test('skew is not checked when the caller does not ask for it', () => {
  assert.equal(validateIntent(intent({ issuedAt: 1 })).ok, true);
});

// --- parameters -------------------------------------------------------------

test('an unknown parameter is refused rather than ignored', () => {
  // Silently dropping it is a coordinator and a host that disagree about what
  // the command means, which is exactly what a fixed verb set is for.
  const r = validateIntent(intent({ verb: 'stop', params: { name: 'bigjob', force: true } }));
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_params');
  assert.match(r.error, /takes no parameter "force"/);
});

test('a required parameter cannot be omitted', () => {
  for (const verb of ['resume', 'stop', 'forget', 'peek']) {
    const r = validateIntent(intent({ verb, params: {} }));
    assert.equal(r.ok, false, `${verb} should require a name`);
    assert.match(r.error, /requires "name"/);
  }
});

test('an optional parameter may be omitted', () => {
  assert.equal(validateIntent(intent({ verb: 'status', params: {} })).ok, true);
  assert.equal(validateIntent(intent({ verb: 'start', params: {} })).ok, true);
  assert.equal(validateIntent(intent({ verb: 'list' })).ok, true, 'params may be absent entirely');
});

test('a session name can never become a shell fragment', () => {
  const hostile = [
    'bad;name',
    'has space',
    '$(whoami)',
    '`id`',
    'a|b',
    'a&&b',
    "quote'd",
    'new\nline',
    '../escape',
    '/absolute',
    'x'.repeat(41),
    '',
  ];
  for (const name of hostile) {
    const r = validateIntent(intent({ verb: 'stop', params: { name } }));
    assert.equal(r.ok, false, `name ${JSON.stringify(name)} should be refused`);
  }
});

test('a session name can never become a command-line FLAG', () => {
  // The subtle one. agent-hub's parser treats any token starting with "--" as a
  // flag, so a session called "--dangerous" would turn `/stop --dangerous` into
  // a flag with no argument — and on /start, into a permission override. The
  // name charset is anchored at the first character precisely to make this
  // impossible by construction rather than by quoting downstream.
  for (const name of ['--dangerous', '--safe', '--yolo', '-x', '--']) {
    const r = validateIntent(intent({ verb: 'start', params: { name } }));
    assert.equal(r.ok, false, `name ${JSON.stringify(name)} should be refused`);
  }
});

test('enum parameters accept only their listed values', () => {
  assert.equal(validateIntent(intent({ verb: 'resume', params: { name: 'a', choice: 'summary' } })).ok, true);
  assert.equal(validateIntent(intent({ verb: 'resume', params: { name: 'a', choice: 'full' } })).ok, true);
  for (const choice of ['1', '2', 'SUMMARY', 'partial', '', 3, null]) {
    const r = validateIntent(intent({ verb: 'resume', params: { name: 'a', choice } }));
    assert.equal(r.ok, false, `choice ${JSON.stringify(choice)} should be refused`);
  }
});

test('"Don\'t ask me again" is not expressible as a resume choice', () => {
  // Option 3 flips a global preference for every future session, interactive
  // ones included. agent-hub refuses to offer it; the protocol cannot name it.
  assert.deepEqual(VERBS.resume.params.choice.values, ['summary', 'full']);
});

test('integer parameters are range-checked', () => {
  assert.equal(validateIntent(intent({ verb: 'peek', params: { name: 'a', lines: 60 } })).ok, true);
  for (const lines of [0, -1, 501, 1.5, '60', NaN, Infinity]) {
    const r = validateIntent(intent({ verb: 'peek', params: { name: 'a', lines } }));
    assert.equal(r.ok, false, `lines ${JSON.stringify(lines)} should be refused`);
  }
});

test('params must be an object, not an array or a string', () => {
  for (const params of ['name=bigjob', ['bigjob'], 42]) {
    const r = validateIntent(intent({ verb: 'stop', params }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'bad_params');
  }
});

test('an actor id is charset-bounded because it is recorded and logged', () => {
  assert.equal(validateIntent(intent({ actor: 'telegram:12345' })).ok, true);
  assert.equal(validateIntent(intent({ actor: 'app:device-7f3a' })).ok, true);
  for (const actor of ['has space', 'x'.repeat(129), '', 42, 'new\nline']) {
    assert.equal(validateIntent(intent({ actor })).ok, false, `actor ${JSON.stringify(actor)} should be refused`);
  }
});

// --- building ---------------------------------------------------------------

test('buildIntent refuses to produce something the host would reject', () => {
  assert.throws(() => buildIntent({ id: 'idem-0000001', verb: 'exec', params: {} }), /malformed intent/);
  assert.throws(() => buildIntent({ id: 'short', verb: 'list' }), /malformed intent/);
  assert.throws(() => buildIntent({ id: 'idem-0000001', verb: 'stop', params: { name: '--yolo' } }), /malformed intent/);
});

test('buildIntent output round-trips through validateIntent', () => {
  const built = buildIntent({
    id: 'idem-0000002',
    verb: 'resume',
    params: { name: 'bigjob', choice: 'full' },
    actor: 'telegram:12345',
    issuedAt: 1_755_000_000_000,
  });
  const r = validateIntent(JSON.parse(JSON.stringify(built)));
  assert.equal(r.ok, true);
  assert.deepEqual(r.intent, built);
});

test('the idempotency key is the callers, not generated per attempt', () => {
  // A key minted inside buildIntent would be a new key on every retry, which
  // makes it decoration: the whole point is that the retry of a `start` carries
  // the key the first attempt did.
  const a = buildIntent({ id: 'idem-0000003', verb: 'stop', params: { name: 'x' }, issuedAt: 1 });
  const b = buildIntent({ id: 'idem-0000003', verb: 'stop', params: { name: 'x' }, issuedAt: 2 });
  assert.equal(a.id, b.id);
});
