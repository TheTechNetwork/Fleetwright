// Choosing which host a session lands on.
//
// A preference, not a parameter: it rides beside the intent and never inside
// it, because `start` deliberately takes no host -- the protocol cannot
// express "run this THERE", only the coordinator decides placement, and this
// is the caller weighing in on that decision. Which is also why adding it
// costs no protocol bump.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostRegistry } from '../src/fleet/coordinator/registry.js';
import { place, UNAVAILABLE_WHY } from '../src/fleet/coordinator/scheduler.js';

function fleet() {
  const r = new HostRegistry();
  for (const [id, free] of [['big-box', 4], ['small-box', 1]]) {
    r.connect(id, () => {});
    r.recordHealth(id, { hub: { reachable: true }, maxSessions: 5, running: 5 - free, free, labels: [] });
  }
  return r;
}

const start = { verb: 'start', params: {} };

test('a chosen host wins over the ranking', () => {
  // The scheduler would pick big-box on capacity. The person picked small-box,
  // and the person knows something the ranker does not -- that is the feature.
  const p = place(fleet(), start, { preferHost: 'small-box' });
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'small-box');
});

test('no preference behaves exactly as before', () => {
  const p = place(fleet(), start, {});
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'big-box');
});

test('an unknown host is refused by name', () => {
  const p = place(fleet(), start, { preferHost: 'no-such-box' });
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'host_unavailable');
  assert.match(p.reason, /not a host this fleet knows/);
});

test('an unschedulable host is refused with ITS reason, not a generic one', () => {
  // "deb132: claude is not logged in" sends somebody to fix the box.
  // "no host matches" sends them to stare at a picker that looked healthy.
  const r = fleet();
  r.recordHealth('small-box', { hub: { reachable: false, reason: 'hub is down' }, maxSessions: 5, running: 0, free: 5 });
  const p = place(r, start, { preferHost: 'small-box' });
  assert.equal(p.kind, 'refused');
  assert.match(p.reason, /small-box is degraded/);
  assert.match(p.reason, /hub/);
});

test('a full host is refused with its numbers', () => {
  const r = fleet();
  r.recordHealth('small-box', { hub: { reachable: true }, maxSessions: 5, running: 5, free: 0, labels: [] });
  const p = place(r, start, { preferHost: 'small-box' });
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'at_capacity');
  assert.match(p.reason, /5\/5/);
});

test('the preference never touches pinned or fan-out verbs', () => {
  // A resume goes where the session volume lives; a list goes everywhere.
  // A preference that could move either would be a footgun, not a feature.
  const r = fleet();
  const fan = place(r, { verb: 'list', params: {} }, { preferHost: 'small-box' });
  assert.equal(fan.kind, 'fanout');
  assert.equal(fan.hosts.length, 2);
});

test('a pool’s own machine runs no sessions: never placed, refused by name, and not degraded for having no Claude account', () => {
  // Asked for: "Should the pool's own machine ever run sessions? No". It
  // showed degraded for nobody having linked an account, and New session ›
  // Where offered it.
  const r = new HostRegistry();
  r.connect('holder-e8309c', () => {});
  r.recordHealth('holder-e8309c', { hub: { reachable: true }, maxSessions: 4, running: 0, free: 4, labels: [], claudeAccounts: 0 });
  assert.equal(r.get('holder-e8309c')?.state, 'healthy', 'it holds the pool; no account is a fault only where sessions run');
  assert.equal(place(r, start).kind, 'refused', 'wherever fits is never there');
  const named = place(r, start, { preferHost: 'holder-e8309c' });
  assert.equal(named.kind, 'refused');
  assert.match(/** @type {any} */ (named).reason, /holder-e8309c is a pool's own machine\. It holds the pool for the fleet and runs no sessions\./);
  // Another box with no account is still degraded, and says the remedy as a
  // phone draws it: no backticks, no <email> placeholder.
  r.connect('deb13', () => {});
  r.recordHealth('deb13', { hub: { reachable: true }, maxSessions: 4, running: 0, free: 4, labels: [], claudeAccounts: 0 });
  assert.equal(r.get('deb13')?.state, 'degraded');
  assert.doesNotMatch(r.get('deb13')?.reason || '', /[`<>]/);
});

test('a host_unavailable refusal says which kind it is, as one word beside the sentence', () => {
  // THE TITLE'S WORD. The phones title a refusal from `error.code`, and for
  // host_unavailable from `why` beside it (scheduler.js UNAVAILABLE_WHY);
  // the sentence goes under the details. Every kind this file can refuse is
  // here, so a new sentence without a word, or a word off the list, fails
  // where the sentence is written; and the two cases that get no word are
  // pinned as getting none, because "offline" of a host that is reporting
  // would be a claim with nothing behind it (C-5).
  const r = new HostRegistry();
  const add = (/** @type {string} */ id, /** @type {any} */ opts, /** @type {any} */ h = {}) => {
    r.connect(id, () => {}, opts);
    r.recordHealth(id, { hub: { reachable: true }, maxSessions: 4, running: 0, free: 4, labels: [], sandboxed: true, ...h });
  };
  const me = { email: 'me@example.com', admin: false };
  const admin = { email: 'ops@example.com', admin: true };
  add('ours', { actsFor: null });
  add('theirs', { actsFor: 'other@example.com' });
  add('gha-other', { ephemeral: true, owner: 'other@example.com', actsFor: 'other@example.com' });
  add('holder-e8309c', { actsFor: null }, { claudeAccounts: 0 });
  add('gone', { actsFor: null });
  r.disconnect('gone', 'socket closed: 1006');
  add('signedout', { actsFor: null }, { claudeAccounts: 0 });

  /** @type {Set<string>} */
  const seen = new Set();
  const why = (/** @type {any} */ p, /** @type {string|undefined} */ want) => {
    assert.equal(p.kind, 'refused', p.reason);
    assert.equal(p.code, 'host_unavailable', p.reason);
    assert.equal(p.why, want, p.reason);
    if (want) {
      assert.ok(UNAVAILABLE_WHY.includes(want), `${want} is not on the list`);
      seen.add(want);
    }
  };
  const named = (/** @type {string} */ verb, /** @type {string} */ preferHost, requester = me) =>
    place(r, { verb, params: {} }, { preferHost, requester });

  // New work on a host named by the person.
  why(named('start', 'theirs'), 'enrolled_by_other');
  why(named('start', 'gha-other'), 'temporary_other');
  why(named('start', 'holder-e8309c'), 'pools_own');
  why(named('start', 'gone'), 'offline');
  why(named('start', 'signedout'), undefined);
  why(named('start', 'no-such-box'), undefined);
  // A credential, which goes only where the person's credentials may be.
  why(named('connect', 'theirs'), 'no_credentials');
  why(named('setuptoken', 'gone'), 'offline');
  // A box's settings, and the hypervisor and runner work only a permanent
  // machine of the person's does.
  why(named('labels', 'gone', admin), 'offline');
  why(named('xosetup', 'theirs'), 'enrolled_by_other');
  why(named('xosetup', 'gone'), 'offline');
  why(named('provision', 'theirs'), 'not_yours');
  why(named('provision', 'gone'), 'offline');

  assert.deepEqual([...seen].sort(), [...UNAVAILABLE_WHY].sort(), 'every word on the list is one some refusal carries, and no refusal carries another');
});
