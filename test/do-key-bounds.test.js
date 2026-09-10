// Every Durable Object key this coordinator writes has a ceiling.
//
// THE FAILURE THIS EXISTS FOR HAS HAPPENED THREE TIMES. Each of these stores is
// serialised into ONE Durable Object value, and DO storage refuses a value over
// 128KiB. Past that, `storage.put` throws and keeps throwing — and because
// `issueClient` mints a credential before the save that would persist it, the
// symptom is not "storage is full", it is SIGN-IN BROKEN FLEET-WIDE, appearing
// weeks after the code shipped on a box where nothing changed (#351).
//
// The event ring learned this first and bounded itself. `mcpClients` learned it
// second, from an unauthenticated caller who could cross the limit in one POST.
// `devices` learned it third. This file is the attempt to stop there being a
// fourth: a key added to `#save*` without a bound fails here rather than in
// production a month later.
//
//   node --test test/
//
// WHAT A "BOUND" MEANS is deliberately loose, because the four shapes are
// genuinely different and pretending otherwise would produce one bad rule:
//
//   a ring          events — oldest out, because an old event is worth less
//   an eviction     mcpClients, runnerTickets, spentTokens — a dropped row
//                   costs a retry nobody notices
//   a sweep         hostIds, clients, runnerTokens — REVOKED rows age out;
//                   they authenticate nothing, so dropping them removes no
//                   access, only history the event ring already keeps
//   a refusal       devices, hostIds, clients, invites, enrollment — live rows
//                   are never dropped to make room, because doing so locks
//                   somebody out silently

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const DO = read('worker/src/fleet-do.js');

/** Cloudflare's per-value limit, which is the whole reason for this file. */
const DO_VALUE_LIMIT = 128 * 1024;

/**
 * How many rows the size tests will push in before giving up.
 *
 * Generous on purpose: it is not a bound, it is the point past which a ceiling
 * is no longer meaningfully a ceiling. A store that has not refused by here has
 * a cap set so high that the DO limit arrives first, which is the bug.
 */
const FILL_CAP = 5000;

/**
 * Every key the Durable Object writes, and the file that bounds it.
 *
 * Adding a row here is the deliberate step: it is where somebody has to name
 * what stops the new store growing for ever. A key with no row fails the first
 * test, and a row with no key fails the second.
 */
const BOUNDED = {
  hostIds: 'src/fleet/coordinator/hosts.js',
  clients: 'src/fleet/coordinator/clients.js',
  runnerTokens: 'src/fleet/coordinator/clients.js',
  runnerTickets: 'src/fleet/coordinator/runner-tickets.js',
  mcpClients: 'src/mcp/oauth.js',
  spentTokens: 'src/fleet/coordinator/spent-tokens.js',
  invites: 'src/fleet/coordinator/invites.js',
  enrollment: 'src/fleet/coordinator/enrollment.js',
  events: 'worker/src/fleet-do.js',
  devices: 'src/fleet/coordinator/core.js',
};

/** Every `storage.put('name', …)` in the Durable Object. */
function writtenKeys() {
  return [...new Set([...DO.matchAll(/storage\.put\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]))].sort();
}

test('every key the Durable Object writes has a bound somewhere', () => {
  const missing = writtenKeys().filter((k) => !(k in BOUNDED));
  assert.deepEqual(
    missing,
    [],
    `written by fleet-do.js with nothing in this file naming what bounds them:\n  ${missing.join('\n  ')}`,
  );
});

test('this file names no key the Durable Object stopped writing', () => {
  // The other direction, and it is not decoration: a row left behind after a
  // store is removed makes the list above read as complete when it is stale,
  // which is the state that let three of these ship unbounded.
  const written = new Set(writtenKeys());
  const stale = Object.keys(BOUNDED).filter((k) => !written.has(k)).sort();
  assert.deepEqual(stale, [], `named here and written nowhere:\n  ${stale.join('\n  ')}`);
});

/**
 * The shapes a bound actually takes in this repository.
 *
 * Deliberately a short list rather than "any number": a comment saying
 * "bounded" is not a bound, and the point of this check is that deleting the
 * mechanism while leaving the prose fails here. The three entries are the three
 * mechanisms in use — a named cap or window, a ring slice, and the byte
 * backstop the event ring added after a count cap turned out not to promise a
 * size. A fourth shape means editing this list, which is the visible step.
 */
const BOUND_SHAPES = [
  /(MAX_[A-Z_]+|RETENTION_MS|TTL_MS)\s*=\s*[\d_]/,  // a named cap or window
  /\.slice\(-\d/,                                    // a ring
  /\.length\s*>\s*[\d_]{4,}/,                        // a byte backstop
];

test('each bound is a mechanism in the file that owns it, not a promise in a comment', () => {
  for (const [key, file] of Object.entries(BOUNDED)) {
    const src = read(file);
    assert.ok(
      BOUND_SHAPES.some((re) => re.test(src)),
      `${file} is named as what bounds "${key}" and contains no cap, window, ring or byte backstop`,
    );
  }
});

test('a full host store still fits in one Durable Object value', async () => {
  // THE ARITHMETIC, not the sentence beside the constant. hostIds is the store
  // that grows without anybody doing anything — `ephemeralHostRetired` revokes
  // every temporary machine, and revoke marks rather than removes — so its
  // ceiling is the one most worth measuring.
  const { HostIdentities } = await import('../src/fleet/coordinator/hosts.js');
  const ids = new HostIdentities();
  const key = { kty: 'EC', crv: 'P-256', x: 'f'.repeat(43), y: 'g'.repeat(43) };
  let refused = false;
  for (let i = 0; i < FILL_CAP; i++) {
    const r = await ids.enrol({ hostId: `host-${String(i).padStart(5, '0')}`, publicJwk: key, enrolledBy: 'somebody@example.com' });
    if (r.ok === false) { refused = true; break; }
  }
  // FILLED TO THE ACTUAL CEILING, not to a number this test picked. Measuring
  // an arbitrary 400 rows passed happily with the cap raised to 20000, which
  // made this assertion decorative — it measured the test's patience rather
  // than the store's bound.
  assert.ok(refused, `the host store did not refuse within ${FILL_CAP} rows, so its ceiling is too high to be a ceiling`);
  const bytes = new TextEncoder().encode(JSON.stringify(ids.serialise())).length;
  assert.ok(bytes < DO_VALUE_LIMIT, `a full host store is ${bytes} bytes, which does not fit in a DO value`);
});

test('a full credential store still fits in one Durable Object value', async () => {
  const { ClientRegistry } = await import('../src/fleet/coordinator/clients.js');
  const reg = new ClientRegistry();
  let refused = false;
  for (let i = 0; i < FILL_CAP; i++) {
    const r = await reg.issue('x'.repeat(60));
    if (r.ok === false) { refused = true; break; }
    // The widest a row gets: an email is kept on it after sign-in.
    r.client.email = `${'e'.repeat(60)}@${'d'.repeat(60)}.example.com`;
  }
  assert.ok(refused, `the credential store did not refuse within ${FILL_CAP} rows, so its ceiling is too high to be a ceiling`);
  const bytes = new TextEncoder().encode(JSON.stringify(reg.serialise())).length;
  assert.ok(bytes < DO_VALUE_LIMIT, `a full credential store is ${bytes} bytes, which does not fit in a DO value`);
});
