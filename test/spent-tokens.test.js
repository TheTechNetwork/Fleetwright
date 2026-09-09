// A token that has bought a credential buys nothing more.
//
// Every test here is a way a second exchange could succeed: the same token
// again, the same token after a restart, the same token after the table was
// flooded. The one direction that is uninteresting is refusing a token that
// was never seen — that is a support ticket, not a breach.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SpentTokens } from '../src/fleet/coordinator/spent-tokens.js';

const T0 = 1_800_000_000_000;

test('a token spends once', async () => {
  const spent = new SpentTokens({ now: () => T0 });
  assert.equal(await spent.spend('a.b.c', T0 + 600_000), true);
  assert.equal(await spent.spend('a.b.c', T0 + 600_000), false);
  // A different token is a different token, even one character apart.
  assert.equal(await spent.spend('a.b.d', T0 + 600_000), true);
});

test('a spent token is forgotten when it would have expired anyway', async () => {
  let now = T0;
  const spent = new SpentTokens({ now: () => now });
  await spent.spend('a.b.c', T0 + 600_000);
  now = T0 + 599_000;
  assert.equal(await spent.spend('a.b.c', T0 + 600_000), false, 'still live, still spent');
  now = T0 + 600_001;
  // The provider would refuse it now, so there is nothing left to protect
  // and no reason to keep the hash. This is what bounds the table.
  assert.equal(spent.serialise().length, 0);
});

test('a token cannot make the table remember it for a year', async () => {
  let now = T0;
  const spent = new SpentTokens({ now: () => now });
  await spent.spend('a.b.c', T0 + 365 * 24 * 3_600_000);
  now = T0 + 25 * 3_600_000;
  assert.equal(spent.serialise().length, 0, 'kept on the token\'s say-so');
});

test('what is written down is a hash, and it survives a restart', async () => {
  const first = new SpentTokens({ now: () => T0 });
  await first.spend('eyJ.secret.sig', T0 + 600_000);
  const written = JSON.stringify(first.serialise());
  assert.equal(written.includes('secret'), false, 'the token is in the state file');

  const second = new SpentTokens({ now: () => T0 + 1000 });
  second.restore(JSON.parse(written));
  assert.equal(await second.spend('eyJ.secret.sig', T0 + 600_000), false, 'a restart made it reusable');

  // Restored entries that have already expired are dropped rather than kept.
  const later = new SpentTokens({ now: () => T0 + 700_000 });
  later.restore(JSON.parse(written));
  assert.equal(later.serialise().length, 0);
});

test('a flood evicts the oldest, which is the one closest to expiring', async () => {
  const spent = new SpentTokens({ now: () => T0 });
  for (let i = 0; i < 5000; i++) await spent.spend(`t${i}`, T0 + 600_000);
  assert.equal(await spent.spend('t0', T0 + 600_000), false, 'not full yet');
  await spent.spend('one-more', T0 + 600_000);
  assert.equal(await spent.spend('t0', T0 + 600_000), true, 'the oldest should have been evicted');
  // Re-spending t0 made room by evicting t1, the next oldest; t2 and every
  // younger token are still remembered.
  assert.equal(await spent.spend('t2', T0 + 600_000), false, 'more than the oldest was evicted');
});
