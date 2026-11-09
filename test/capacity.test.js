// How many sessions a box takes, measured (core/capacity.js).
//
//   node --test test/capacity.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { capacity, DEFAULT_CEILING } from '../src/core/capacity.js';
import { fullness } from '../src/fleet/coordinator/scheduler.js';

const GB = 1024 ** 3;
const cfg = { maxSessions: null, sessionMemoryMb: 1024, memoryFloorMb: 768, maxLoadPerCore: 1.5 };

test('the box that sat at 5/5 with 9GB free takes more', () => {
  // vnic-runner-oci, measured 2026-11-09: 2 cores, 9GB available, load 0.14.
  const c = capacity({ running: 5, cfg, machine: { freeMemBytes: 9 * GB, load1: 0.14, cpus: 2 } });
  assert.equal(c.free, 8);
  assert.equal(c.limit, 13);
  assert.equal(c.bound, null);
  assert.equal(c.why, null);
});

test('memory runs out before the count does, and says so', () => {
  const c = capacity({ running: 2, cfg, machine: { freeMemBytes: 1.5 * GB, load1: 0.2, cpus: 4 } });
  assert.equal(c.free, 0);
  assert.equal(c.bound, 'memory');
  assert.match(String(c.why), /Short on memory for another session: 1\.5GB available, and a session needs 1\.0GB with 0\.8GB kept for the box/);
});

test('a busy box takes nothing, whatever its memory', () => {
  const c = capacity({ running: 1, cfg, machine: { freeMemBytes: 30 * GB, load1: 6.4, cpus: 4 } });
  assert.equal(c.free, 0);
  assert.equal(c.bound, 'load');
  assert.match(String(c.why), /load 6\.4 on 4 cores, and it takes new ones under 6\.0/);
});

test('starts still warming up hold their memory, so a burst cannot all get in', () => {
  const machine = { freeMemBytes: 4 * GB, load1: 0, cpus: 8 };
  assert.equal(capacity({ running: 0, cfg, machine }).free, 3);
  const warm = capacity({ running: 3, warming: 3, cfg, machine });
  assert.equal(warm.free, 0);
  assert.equal(warm.bound, 'memory');
  assert.match(String(warm.why), /3\.0GB of it held for 3 still starting/);
});

test('FLEETWRIGHT_MAX_SESSIONS is still a ceiling: a box that set 5 keeps 5', () => {
  const c = capacity({ running: 5, cfg: { ...cfg, maxSessions: 5 }, machine: { freeMemBytes: 60 * GB, load1: 0, cpus: 32 } });
  assert.equal(c.free, 0);
  assert.equal(c.bound, 'ceiling');
  assert.match(String(c.why), /\(5\/5\).*raise FLEETWRIGHT_MAX_SESSIONS/);
});

test('unset, the ceiling is DEFAULT_CEILING', () => {
  const c = capacity({ running: DEFAULT_CEILING, cfg, machine: { freeMemBytes: 256 * GB, load1: 0, cpus: 64 } });
  assert.equal(c.free, 0);
  assert.equal(c.bound, 'ceiling');
  assert.match(String(c.why), /without FLEETWRIGHT_MAX_SESSIONS set/);
});

test('the coordinator says why a box is full from its frame', () => {
  assert.equal(fullness({ running: 3, maxSessions: 3, capacityBound: 'memory', freeMemBytes: 1.2 * GB }), '3/3 sessions, short on memory (1.2GB available)');
  assert.equal(fullness({ running: 2, maxSessions: 2, capacityBound: 'load', loadavg: [7.25, 1, 1], cpus: 4 }), '2/2 sessions, too busy (load 7.3 on 4 cores)');
  assert.equal(fullness({ running: 5, maxSessions: 5, capacityBound: 'ceiling' }), '5/5 sessions, its own limit');
  // A box from before: the fixed count, as it was said.
  assert.equal(fullness({ running: 5, maxSessions: 5 }), '5/5 sessions');
});
