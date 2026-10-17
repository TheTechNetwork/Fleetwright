// Two boxes claim one name, and the coordinator refuses instead of picking.
//
// WHY THIS FILE EXISTS AT ALL is a finding rather than a feature. The branch
// below — scheduler.js's `ambiguous_session`, whose own comment says "a stop
// that lands on the wrong box is not recoverable by trying again" — had NO
// test. It was covered anyway, on some runs: something else in the suite
// happened to build a registry where two hosts reported the same session name,
// and the branch ran as a side effect.
//
// That showed up as coverage flapping between 100% and 98.06% on an unchanged
// tree, three times in nine runs, with lines 239-247 the only difference. A
// safety refusal that is exercised by accident is a safety refusal nobody has
// checked: the accident can stop happening in a commit that has nothing to do
// with it, and the number would go down by two lines with no test failing.
//
// So it is asserted here, on purpose, at the seam it belongs to.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { place } from '../src/fleet/coordinator/scheduler.js';

/** Every verb that must land on the box already holding the session. */
const PINNED = ['resume', 'stop', 'forget', 'peek', 'status', 'restore', 'purge'];

/**
 * A registry where `name` is claimed by each of `hostIds`.
 *
 * Hand-built rather than driven through the real HostRegistry, for the reason
 * this file opens with: the point is to reach one branch deliberately, and a
 * fixture assembled out of health frames reaches it by a route that can change
 * underneath the assertion.
 *
 * @param {string[]} hostIds
 */
const claiming = (hostIds) => {
  const hosts = hostIds.map((hostId) => ({ hostId, connected: true, state: 'ready', reason: '' }));
  return /** @type {any} */ ({
    reachable: () => hosts,
    schedulable: () => hosts,
    list: () => hosts,
    get: (/** @type {string} */ id) => hosts.find((h) => h.hostId === id),
    findSessions: () => hosts.map((host) => ({ host, status: 'running', createdBy: null, ageMs: 0 })),
  });
};

const intent = (/** @type {string} */ verb, /** @type {string} */ name) => ({ verb, params: { name } });

test('a session name claimed by two boxes is refused, not guessed at', () => {
  // EVERY pinned verb, not just stop. `forget` and `purge` destroy state and
  // `resume` starts an empty conversation under a name somebody believes is
  // their long-running one — all three are as unrecoverable as the stop the
  // comment in scheduler.js is written about.
  for (const verb of PINNED) {
    const p = place(claiming(['alpha', 'beta']), intent(verb, 'bigjob'));
    assert.equal(p.kind, 'refused', `${verb} chose a box`);
    assert.equal(p.code, 'ambiguous_session', verb);
  }
});

test('the refusal names both boxes, because the fix is on one of them', () => {
  // A refusal that does not say WHERE leaves somebody with two machines to
  // check by hand — which is the state they were already in. Naming them is
  // the whole difference between refusing and being unhelpful.
  const p = place(claiming(['alpha', 'beta']), intent('stop', 'bigjob'));
  assert.match(p.reason, /alpha and beta/);
  assert.match(p.reason, /bigjob/);
  // And it says what to do about it, rather than only what it will not do.
  assert.match(p.reason, /Rename one/);
});

test('one claim is not ambiguous — the refusal must not fire on the normal case', () => {
  // The other half of the assertion, and the one that would catch an off-by-one
  // in `claims.length > 1`. A single claim places.
  const p = place(claiming(['alpha']), intent('stop', 'bigjob'));
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'alpha');
});

test('three boxes are still refused, and all three are named', () => {
  const p = place(claiming(['alpha', 'beta', 'gamma']), intent('resume', 'bigjob'));
  assert.equal(p.code, 'ambiguous_session');
  for (const host of ['alpha', 'beta', 'gamma']) assert.match(p.reason, new RegExp(host));
});

test('a member is asked to choose only among their own sessions', () => {
  // This pinned the opposite order, ambiguity before ownership, and said that
  // was safe because both claims were unattributed. It was not safe with any
  // creators (a later audit): two other people's sessions of one name, or one
  // of theirs and one on a box the member enrolled, answered any member's
  // peek with the hosts holding them, where a single claim answered
  // unknown_session. Narrowed to the member's own claims first, somebody
  // else's session changes nothing a member is told.
  const member = { email: 'member@example.com', admin: false };
  /** @param {Array<[string, string|null]>} claims host and creator */
  const by = (claims) => {
    const hosts = claims.map(([hostId]) => ({ hostId, connected: true, state: 'ready', reason: '' }));
    return /** @type {any} */ ({
      reachable: () => hosts,
      schedulable: () => hosts,
      list: () => hosts,
      get: (/** @type {string} */ id) => hosts.find((h) => h.hostId === id),
      findSessions: () => claims.map(([, createdBy], i) => ({ host: hosts[i], status: 'running', createdBy, ageMs: 0 })),
    });
  };
  const absent = place(by([]), intent('stop', 'bigjob'), { requester: member });

  for (const verb of ['peek', 'stop', 'status']) {
    const theirs = place(by([['alpha', 'fleet:carol@example.com'], ['beta', 'fleet:dave@example.com']]), intent(verb, 'bigjob'), { requester: member });
    assert.equal(theirs.code, 'unknown_session', `${verb} told a member where two other people's sessions are`);
    assert.equal(theirs.reason, absent.reason, verb);

    // Their own and somebody else's: theirs, on the box holding it.
    const mine = place(by([['alpha', 'fleet:carol@example.com'], ['beta', 'fleet:member@example.com']]), intent(verb, 'bigjob'), { requester: member });
    assert.equal(mine.host?.hostId, 'beta', verb);
  }

  // Two of their own is still theirs to choose between, and only those named.
  const both = place(by([['alpha', 'fleet:member@example.com'], ['beta', 'fleet:carol@example.com'], ['gamma', 'fleet:member@example.com']]), intent('stop', 'bigjob'), { requester: member });
  assert.equal(both.code, 'ambiguous_session');
  assert.match(both.reason, /alpha and gamma/);

  // logs <name> counted every claim once the member owned one.
  const logs = place(by([['alpha', 'fleet:carol@example.com'], ['beta', 'fleet:member@example.com']]), intent('logs', 'bigjob'), { requester: member });
  assert.equal(logs.host?.hostId, 'beta');
});
