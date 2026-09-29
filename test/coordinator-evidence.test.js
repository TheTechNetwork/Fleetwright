// The sidecar's half of the update evidence survives fleetwright's restart.
//
//   node --test test/coordinator-evidence.test.js
//
// An update restarts both services together. fleetwright listens only after its
// startup probe — a throwaway container, up to thirty seconds — and the sidecar
// reaches the coordinator in well under that. One request at connect time would
// land on a closed port, the connection would then stay up and never fire the
// hook again, and the watchdog would revert every update for want of evidence
// the box had every right to. The sidecar used to write the file itself and
// had no such gap; asking has to be at least as reliable as writing was.

import test from 'node:test';
import assert from 'node:assert/strict';

import { recordCoordinatorReached, ATTEMPTS, RETRY_MS } from '../src/fleet/host/evidence.js';
import { HubError } from '../src/fleet/host/hub-client.js';

/** A hub that is down for the first `down` asks and then answers `reply`. */
function hubDownFor(down, reply = { noted: true }) {
  let asks = 0;
  return {
    asks: () => asks,
    noteCoordinatorReached: async () => {
      asks++;
      if (asks <= down) throw new HubError('hub_unreachable', 'POST /api/update-evidence: fetch failed');
      return reply;
    },
  };
}

function capture() {
  /** @type {string[]} */
  const lines = [];
  return { lines, info: (/** @type {string} */ m) => lines.push(`info ${m}`), warn: (/** @type {string} */ m) => lines.push(`warn ${m}`) };
}

/** @type {number[]} */
let slept = [];
const sleep = async (/** @type {number} */ ms) => { slept.push(ms); };

test('a hub that is still starting is asked again until it answers, and the answer is recorded', async () => {
  slept = [];
  const hub = hubDownFor(3);
  const log = capture();
  const r = await recordCoordinatorReached(hub, { log, sleep });
  assert.deepEqual(r, { noted: true, attempts: 4 });
  assert.deepEqual(slept, [RETRY_MS, RETRY_MS, RETRY_MS], 'waits between asks, on the transport clock');
  // Three failures are not three warnings: while the hub is coming up there is
  // nothing to act on, and the line that matters is the one that lands.
  assert.deepEqual(log.lines, ['info update: recorded that this box reached its coordinator']);
});

test('nothing on trial is an answer, asked once and said nowhere', async () => {
  slept = [];
  const log = capture();
  const r = await recordCoordinatorReached(hubDownFor(0, { noted: false, why: 'nothing on trial' }), { log, sleep });
  assert.deepEqual(r, { noted: false, why: 'nothing on trial', attempts: 1 });
  assert.deepEqual(slept, []);
  assert.deepEqual(log.lines, [], 'a settled box logs nothing four times a day');
});

test('a hub too old for the route is an answer too, and is said once', async () => {
  const log = capture();
  const why = 'fleetwright here has no update-evidence route — update it';
  const r = await recordCoordinatorReached(hubDownFor(0, { noted: false, why }), { log, sleep });
  assert.equal(r.attempts, 1);
  assert.deepEqual(log.lines, [`warn update: could not record reaching the coordinator — ${why}`]);
});

test('a refused token is not retried: it will be refused in fifteen seconds too', async () => {
  slept = [];
  const log = capture();
  const hub = {
    noteCoordinatorReached: async () => { throw new HubError('hub_unauthorised', 'POST /api/update-evidence: rejected the token — check FLEETWRIGHT_TOKEN', 401); },
  };
  const r = await recordCoordinatorReached(hub, { log, sleep });
  assert.equal(r.noted, false);
  assert.equal(r.attempts, 1);
  assert.deepEqual(slept, []);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], /rejected the token/);
  assert.doesNotMatch(log.lines[0], /gave up/);
});

test('it gives up inside the trial window, says so once, and never throws', async () => {
  slept = [];
  const log = capture();
  const hub = hubDownFor(Infinity);
  const r = await recordCoordinatorReached(hub, { log, sleep, attempts: 5, retryMs: 1 });
  assert.deepEqual(r, { noted: false, why: 'POST /api/update-evidence: fetch failed', attempts: 5 });
  assert.equal(hub.asks(), 5);
  assert.equal(slept.length, 4, 'no wait after the last ask');
  assert.deepEqual(log.lines, ['warn update: could not record reaching the coordinator — POST /api/update-evidence: fetch failed (gave up after 5 tries)']);
  // The defaults fit inside the ten-minute trial (src/core/update-confirm.js),
  // with room for the hub's whole thirty-second probe.
  assert.ok(ATTEMPTS * RETRY_MS < 10 * 60_000);
  assert.ok(ATTEMPTS * RETRY_MS > 60_000);
});

test('an error that is not the hub being away is reported as itself, once', async () => {
  const log = capture();
  const hub = { noteCoordinatorReached: async () => { throw new TypeError('reply was not what I expected'); } };
  const r = await recordCoordinatorReached(hub, { log, sleep });
  assert.equal(r.attempts, 1);
  assert.match(String(r.why), /not what I expected/);
});

test('the real sleep does not keep the process alive', async () => {
  // Without a fake sleep: one short real wait, and the timer is unref'd, which
  // is the difference between a sidecar that stops when told and one that
  // waits fifteen seconds for a hub it was told to forget about.
  const log = capture();
  const r = await recordCoordinatorReached(hubDownFor(1), { log, retryMs: 5 });
  assert.equal(r.attempts, 2);
});

test('the entrypoint uses it from the connect hook, and nothing else asks directly', async () => {
  const { readFileSync } = await import('node:fs');
  const bin = readFileSync(new URL('../bin/fleetwright-sidecar', import.meta.url), 'utf8');
  assert.match(bin, /const onCoordinatorConnect = \(\) => \{\n\s+void recordCoordinatorReached\(hub, \{ log \}\);\n\s+\};/);
  assert.doesNotMatch(bin, /hub\s*\.noteCoordinatorReached\(/, 'the one-shot ask is back');
});
