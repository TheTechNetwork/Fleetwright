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

test('ambiguity is checked BEFORE ownership, so it cannot become an oracle', () => {
  // unknown_session and "not yours" are byte-identical on purpose — a member
  // must not be able to learn that a guessed name exists on somebody else's
  // work. The ambiguous refusal names hosts, so if it were reachable by a
  // member who owns neither session it would be exactly the oracle that
  // identical wording exists to prevent.
  //
  // It is not: both claims here belong to somebody else, and the answer is
  // still the host-naming one — which is safe only because BOTH sessions are
  // unattributed (createdBy null means fleet-owned, per the visibility filter).
  // This test pins the ordering so a later refactor cannot swap the two checks
  // without saying so.
  const p = place(claiming(['alpha', 'beta']), intent('stop', 'bigjob'), {
    requester: { email: 'member@example.com', admin: false },
  });
  assert.equal(p.code, 'ambiguous_session');
});
