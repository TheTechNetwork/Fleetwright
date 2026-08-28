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

import { VERBS, PROTOCOL_VERSION, validateIntent, buildIntent, isMutating } from '../src/fleet/protocol/intents.js';
import { isValidName } from '../src/core/names.js';

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
  // Pinned deliberately. Adding a verb should be a visible edit to this list,
  // not something that arrives with a feature — and this tripwire worked:
  // `answer` could not land without editing it here.
  //
  // The original comment also said "and a version bump", which turned out to
  // be wrong and is worth correcting rather than obeying. An older host
  // answers an unknown verb with `unknown_verb` — a named refusal that
  // strands nothing. It is adding a PARAMETER to an existing verb that
  // requires the bump, because `bad_params` arrives AFTER the version check
  // has already agreed: the handshake says "we understand each other" and
  // then the work fails. That is why title/brief cost a version and this does
  // not.
  assert.deepEqual(Object.keys(VERBS).sort(), [
    'answer',
    'connect',
    'forget',
    'health',
    'link',
    'list',
    'logs',
    'peek',
    'purge',
    'reboot',
    'restore',
    'resume',
    'start',
    'status',
    'stop',
    'unlink',
    'update',
    'upgrade',
  ]);
});

test('a credential cannot be aimed at somebody else', () => {
  // This test used to assert `login` and `code` were absent, on the grounds
  // that a compromised Worker could point a box at an attacker's Claude
  // account. Half of that reasoning survives and half of it was answered.
  //
  // ANSWERED: the aiming. There is no email, account or user parameter
  // anywhere in the verb set, so `connect` can only ever mean "the verified
  // actor" — an identity the HOST derives from the actor string, and which no
  // caller can name. That is the property this test now pins, because it is
  // the one an innocent-looking convenience parameter would take away.
  //
  // STILL TRUE: a compromised coordinator can show somebody a different
  // authorization page. It cannot do that with more authority than `start`
  // already gives it on the same box. docs/trust.md says so plainly.
  for (const [verb, spec] of Object.entries(VERBS)) {
    for (const key of Object.keys(spec.params)) {
      assert.ok(
        !/email|account|user|owner|as$/i.test(key),
        `${verb} exposes an identity-shaped parameter "${key}" — whose credential must never be a parameter`,
      );
    }
  }
});

test('the credential parameter is not text, and refusals never quote it', () => {
  const link = (secret) => validateIntent(intent({ verb: 'link', params: { provider: 'github', secret } }));

  // cleanText would collapse whitespace and strip control characters, which
  // silently hands a MODIFIED credential to a provider — turning "your token
  // is wrong" into a mystery. A credential is exactly what was minted or it
  // is refused.
  assert.equal(link('ghp_aB3.xY-_~9/z=Q:1').ok, true);
  for (const bad of ['tok en', "tok'en", 'tok"en', 'tok\\en', '', 'x'.repeat(5000), 42, null]) {
    const r = link(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    // The error travels back to the caller and past every log line on the way.
    if (typeof bad === 'string' && bad.length > 4) {
      assert.equal(r.error.includes(bad.slice(0, 5)), false, 'a refusal quoted the credential back');
    }
  }
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
    // answer sends a keystroke into a live session: as mutating as it gets.
    // update/upgrade/reboot change the box itself, which is as mutating as a
    // verb gets — a reboot ends every session on it.
    // connect/link/unlink write a credential to disk on that box, which is
    // state-changing by any reading — and being mutating is what gets their
    // idempotency key honoured, so a retried paste cannot start two logins.
    // restore and purge both change what exists on the box, and being mutating
    // is what gets their idempotency key honoured — a retried purge must not
    // report "no session named that" for work it deleted a moment ago.
    ['answer', 'connect', 'forget', 'link', 'purge', 'reboot', 'restore', 'resume', 'start', 'stop', 'unlink', 'update', 'upgrade'],
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
  // Every value here must be something that is NOT PROTOCOL_VERSION, and the
  // list used to hardcode the neighbours of 1. Bumping to 2 quietly turned one
  // of them into the version we speak, so the test asserted that the current
  // version is rejected — and passed, because it was written when it wasn't.
  // Derived from the constant now, so the next bump cannot do the same.
  for (const v of [PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1, String(PROTOCOL_VERSION), null, undefined]) {
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

// --- agreement with the session manager -------------------------------------

test('every name the protocol accepts, the session manager also accepts', () => {
  // The protocol carries its own charset because it is a wire contract that has
  // to hold whatever the session manager does. What must never happen is the
  // protocol being LOOSER: a name that validates here and is then rejected
  // downstream is an intent that passes every check and fails at the far end.
  for (const name of ['a', 'api', 'api-staging_2', 'cc-1a2b3c', 'X9', 'a'.repeat(40)]) {
    const r = validateIntent(intent({ verb: 'stop', params: { name } }));
    assert.equal(r.ok, true, `protocol should accept ${JSON.stringify(name)}`);
    assert.ok(isValidName(name), `core/names.js should also accept ${JSON.stringify(name)}`);
  }
});

test('the protocol is deliberately STRICTER about the first character', () => {
  // core/names.js is /^[A-Za-z0-9_-]{1,40}$/, which accepts a leading dash — so
  // "--dangerous" is a legal session name as far as the session manager is
  // concerned. That is fine inside it, where names travel as argv entries, and
  // not fine over a wire whose other end re-parses a command LINE: parse() in
  // adapters/commands.js reads any token starting with "--" as a flag, so
  // `/new --dangerous` becomes a permission override with no name at all.
  //
  // So the extra anchor here is not redundancy with core/names.js. It is the
  // thing that closes a gap core/names.js leaves open, and removing it because
  // "the session manager already validates names" would reopen it.
  for (const name of ['--dangerous', '-x', '_leading', '-']) {
    assert.ok(isValidName(name), `core/names.js accepts ${JSON.stringify(name)} — that is the point`);
    const r = validateIntent(intent({ verb: 'start', params: { name } }));
    assert.equal(r.ok, false, `the protocol must refuse ${JSON.stringify(name)}`);
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
