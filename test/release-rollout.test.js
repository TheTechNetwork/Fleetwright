// Prereleases per host, and rollouts a fraction at a time.
//
// Both are decisions, so both live in decideRelease beside the protocol gate —
// pure, no network, no filesystem, testable without a running host. The parts
// that go wrong here are the judgements, not the download.

import test from 'node:test';
import assert from 'node:assert/strict';

import { decideRelease, rolloutPosition } from '../src/core/release.js';

const BASE = { version: 'v2.0.0', file: 'host-v2.tar.gz', sha256: 'a'.repeat(64) };
// The merged manifest LAST, or spreading `over` puts the raw override back and
// every case silently tests the base manifest.
const ask = (/** @type {any} */ over) =>
  decideRelease({ installed: 'v1.0.0', protocol: 3, ...over, manifest: { ...BASE, ...over.manifest } });

test('a prerelease reaches only the hosts that asked for it', () => {
  const stable = ask({ manifest: { prerelease: true }, hostKey: 'box' });
  assert.equal(stable.act, false);
  assert.equal(stable.reason, 'channel');
  // Names the variable, because the person reading this is the one who can set
  // it and "not for this channel" sends them to a document.
  assert.match(stable.message, /AGENT_HUB_RELEASE_CHANNEL=prerelease/);

  assert.equal(ask({ manifest: { prerelease: true }, channel: 'prerelease', hostKey: 'box' }).act, true);
  // And an ordinary release still reaches a host that opted in — the channel
  // widens what it takes rather than replacing it.
  assert.equal(ask({ channel: 'prerelease', hostKey: 'box' }).act, true);
});

test('a rollout admits a stable fraction, and widening only ever adds', () => {
  // THE PROPERTY THAT MATTERS. A host that qualified at 25% must still qualify
  // at 50%, or raising a rollout would take the release away from machines that
  // already had it — and a fleet would oscillate.
  const hosts = Array.from({ length: 500 }, (_, i) => `box-${i}`);
  const at = (/** @type {number} */ r) =>
    new Set(hosts.filter((h) => ask({ manifest: { rollout: r }, hostKey: h }).act));

  const quarter = at(0.25);
  const half = at(0.5);
  const all = at(1);

  for (const h of quarter) assert.ok(half.has(h), `${h} qualified at 25% and not at 50%`);
  for (const h of half) assert.ok(all.has(h), `${h} qualified at 50% and not at 100%`);

  // Roughly the fraction asked for. Not exact — it is a hash, not a quota — but
  // a rollout that admitted 5% when it said 25% would be useless.
  assert.ok(quarter.size > 90 && quarter.size < 160, `25% admitted ${quarter.size} of 500`);
  assert.ok(half.size > 200 && half.size < 300, `50% admitted ${half.size} of 500`);
  assert.equal(all.size, 500);
});

test('each release reshuffles who goes first', () => {
  // Hashing the host alone would put the same machines at the front of every
  // rollout for ever: one box takes every risk, another never sees a release
  // until it is already proven.
  const hosts = Array.from({ length: 200 }, (_, i) => `box-${i}`);
  const first = (/** @type {string} */ v) =>
    hosts.filter((h) => decideRelease({ manifest: { ...BASE, version: v, rollout: 0.2 }, installed: 'v0', protocol: 3, hostKey: h }).act);

  const a = new Set(first('v2.0.0'));
  const b = first('v2.0.1');
  const overlap = b.filter((h) => a.has(h)).length;
  // Some overlap is expected by chance; near-total overlap would mean the
  // version is not in the key.
  assert.ok(overlap < b.length * 0.6, `the same ${overlap}/${b.length} hosts lead both rollouts`);
});

test('a host with no stable name waits for everybody', () => {
  // Guessing a position would move a host between rollouts at random. The
  // fraction only ever rises, so waiting is the answer that cannot be wrong.
  const nameless = ask({ manifest: { rollout: 0.5 }, hostKey: '' });
  assert.equal(nameless.act, false);
  assert.equal(nameless.reason, 'rollout');
  assert.match(nameless.message, /no stable name/);
  assert.equal(ask({ manifest: { rollout: 1 }, hostKey: '' }).act, true);
});

test('a release that says nothing about either goes to everybody', () => {
  // Every release built before these fields existed, and every one built
  // without thinking about them. A rollout nobody configured must not hold a
  // fleet back.
  assert.equal(ask({ hostKey: 'box' }).act, true);
  assert.equal(ask({ manifest: { rollout: undefined, prerelease: undefined }, hostKey: 'box' }).act, true);
});

test('already having it beats both rules', () => {
  // A host running the release must not be told it is not in the group yet —
  // that is a sentence nobody can act on, about something already installed.
  const same = decideRelease({
    manifest: { ...BASE, prerelease: true, rollout: 0 },
    installed: BASE.version,
    protocol: 3,
    hostKey: 'box',
  });
  assert.equal(same.reason, 'current');
});

test('the protocol gate still comes first', () => {
  // A host one protocol behind must be told that, not told it is not in the
  // rollout — those send whoever is reading in opposite directions.
  const mismatched = decideRelease({
    manifest: { ...BASE, protocol: 2, rollout: 0, prerelease: true },
    installed: 'v1.0.0',
    protocol: 3,
    hostKey: 'box',
  });
  assert.equal(mismatched.reason, 'protocol');
});

test('the position is a spread, and the same everywhere', () => {
  // FNV-1a rather than SHA-256: nothing here is secret, and both a Worker and a
  // Node process have to compute it identically without an await.
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 2000; i++) buckets[Math.floor(rolloutPosition(`box-${i}`, 'v1') * 10)]++;
  for (const [i, n] of buckets.entries()) {
    assert.ok(n > 120 && n < 280, `decile ${i} got ${n} of an expected 200 — the spread is not even`);
  }
  // Deterministic, or a host would drift in and out of a rollout as it retried.
  assert.equal(rolloutPosition('box', 'v1'), rolloutPosition('box', 'v1'));
  assert.notEqual(rolloutPosition('box', 'v1'), rolloutPosition('box', 'v2'));
  // And always in range, including for input that would overflow a naive
  // 32-bit multiply.
  for (const key of ['', 'a'.repeat(4096), '☃', 'box-999999']) {
    const p = rolloutPosition(key, 'v1');
    assert.ok(p >= 0 && p < 1, `${JSON.stringify(key.slice(0, 12))} gave ${p}`);
  }
});
