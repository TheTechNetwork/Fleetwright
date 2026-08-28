// Whose session is this?
//
// It used to be unanswerable. agent-hub hardcoded `actor: web` for every HTTP
// caller, so the coordinator verified an email, handed it to the sidecar, and
// the record one hop away stored the string "web". Every session on every host
// had the same creator.
//
// Nothing in docs/accounts.md can be built on that, which is why this is the
// first piece of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { commandMeta, toCommandLine } from '../src/fleet/host/sidecar.js';

test('the verified actor travels with every verb, not just start', () => {
  // Attribution is not a property of starting things. Stopping somebody else\'s
  // session is the event an audit wants most, and it used to be recorded as
  // "web" like everything else.
  for (const verb of ['start', 'stop', 'resume', 'forget', 'list']) {
    assert.equal(commandMeta(verb, { name: 'j' }, 'eli@example.com').actor, 'eli@example.com');
  }
});

test('title and brief stay start-only', () => {
  assert.equal(commandMeta('stop', { name: 'j', title: 'x' }, 'a@b.c').title, undefined);
  assert.equal(commandMeta('start', { name: 'j', title: 'x' }, 'a@b.c').title, 'x');
});

test('no actor means no field, rather than an empty one', () => {
  // An empty string would overwrite the hub\'s own default with nothing,
  // which is worse than the default.
  assert.equal('actor' in commandMeta('start', { name: 'j' }), false);
  assert.equal('actor' in commandMeta('start', { name: 'j' }, ''), false);
});

test('the actor never reaches the command line', () => {
  // Same rule as title and brief: an identity with an @ and dots in it must
  // not be split on whitespace and read as arguments.
  const line = toCommandLine({ verb: 'start', params: { name: 'job' } });
  assert.equal(line, '/new job');
  assert.doesNotMatch(line, /@/);
});
