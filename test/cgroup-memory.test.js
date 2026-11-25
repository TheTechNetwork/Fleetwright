// The memory a hub may still take when it is allowed less than its box has
// (src/core/cgroup-memory.js), read here from a tree that stands in for
// /sys/fs/cgroup. Nothing here is in a container: that a real one's files
// read the same is not checked anywhere (the module's header says so).
//
//   node --test test/cgroup-memory.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { availableMemoryBytes, cgroupRoomBytes } from '../src/core/cgroup-memory.js';
import { capacity } from '../src/core/capacity.js';

const GB = 1024 ** 3;
const cfg = { maxSessions: null, sessionMemoryMb: 1024, memoryFloorMb: 768, maxLoadPerCore: 1.5 };

/**
 * A cgroup tree and the line that says which group this process is in.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} own  what /proc/self/cgroup holds
 * @param {Record<string, { max?: string, current?: number, cache?: number }>} groups  by path under the root
 */
function standIn(t, own, groups) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-cgroup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'cgroup');
  for (const [at, g] of Object.entries(groups)) {
    const here = path.join(root, at);
    mkdirSync(here, { recursive: true });
    if (g.max !== undefined) writeFileSync(path.join(here, 'memory.max'), `${g.max}\n`);
    if (g.current !== undefined) writeFileSync(path.join(here, 'memory.current'), `${g.current}\n`);
    if (g.cache !== undefined) writeFileSync(path.join(here, 'memory.stat'), `anon 1\nfile 2\ninactive_file ${g.cache}\nactive_file 3\n`);
  }
  const self = path.join(dir, 'self-cgroup');
  writeFileSync(self, own);
  return { root, self };
}

test('a hub in a container counts its sessions against the container’s limit, not the memory of the box around it', (t) => {
  // AS A MACHINE MADE ON A BOX IS: its group is `/`, and the files at the
  // top are the container's. Allowed 8 GB, holding 6.5 of which half a
  // gigabyte is cache the kernel gives up first: 2 GB of room.
  const machine = standIn(t, '0::/\n', { '': { max: String(8 * GB), current: 6.5 * GB, cache: 0.5 * GB } });
  assert.equal(cgroupRoomBytes(machine), 2 * GB);
  // THE BOX AROUND IT HAS 60 GB FREE, which is what the container's own
  // /proc/meminfo says. Counted against that it took fourteen more sessions
  // into its 2 GB, and the kernel ends a container that passes its limit.
  const box = capacity({ running: 2, cfg, machine: { freeMemBytes: 60 * GB, load1: 0, cpus: 4 } });
  const inside = capacity({ running: 2, cfg, machine: { freeMemBytes: availableMemoryBytes({ free: 60 * GB, ...machine }), load1: 0, cpus: 4 } });
  assert.deepEqual([box.free, inside.free], [14, 1]);
  // AND AT THE LIMIT IT REFUSES IN THE CONTAINER'S NUMBER, with what to do.
  const full = standIn(t, '0::/\n', { '': { max: String(8 * GB), current: 7 * GB, cache: 0 } });
  const refused = capacity({ running: 6, cfg, machine: { freeMemBytes: availableMemoryBytes({ free: 60 * GB, ...full }), load1: 0, cpus: 4 } });
  assert.deepEqual([refused.free, refused.bound], [0, 'memory']);
  assert.match(String(refused.why), /^Short on memory for another session: 1\.0GB available, and a session needs 1\.0GB with 0\.8GB kept for the box\./);
});

test('the limit is the tightest of the groups above the hub, and the box’s own number where that is less', (t) => {
  // A UNIT UNDER A SLICE: no limit of its own, and one on the slice above.
  const unit = standIn(t, '12:pids:/elsewhere\n0::/system.slice/fleetwright.service\n', {
    'system.slice/fleetwright.service': { max: 'max', current: 1 * GB, cache: 0 },
    'system.slice': { max: String(4 * GB), current: 3 * GB, cache: 0 },
  });
  assert.equal(cgroupRoomBytes(unit), 1 * GB);
  // Both limited: the one with less room decides.
  const both = standIn(t, '0::/a/b\n', { 'a/b': { max: String(2 * GB), current: 0.5 * GB }, a: { max: String(16 * GB), current: 15.75 * GB } });
  assert.equal(cgroupRoomBytes(both), 0.25 * GB);
  // A BOX SHORTER THAN ITS CGROUP ALLOWS is still short: the less of the two.
  assert.equal(availableMemoryBytes({ free: 0.5 * GB, ...unit }), 0.5 * GB);
  // Holding more than the limit (the kernel is reclaiming) is no room, never less than none.
  const over = standIn(t, '0::/\n', { '': { max: String(1 * GB), current: 2 * GB, cache: 0 } });
  assert.equal(cgroupRoomBytes(over), 0);
});

test('where no limit can be read the box’s own number stands, as before', (t) => {
  for (const [why, own, groups] of /** @type {Array<[string, string, Record<string, any>]>} */ ([
    ['no limit set anywhere', '0::/user.slice\n', { 'user.slice': { max: 'max', current: 1 * GB } }],
    ['cgroup version 1, which is not read', '12:memory:/docker/abc\n11:pids:/docker/abc\n', { '': { max: String(1 * GB), current: 0 } }],
    ['a group whose files are not there', '0::/gone\n', {}],
    ['a limit with nothing to say what is held', '0::/\n', { '': { max: String(1 * GB) } }],
  ])) {
    const where = standIn(t, own, groups);
    assert.equal(cgroupRoomBytes(where), null, why);
    assert.equal(availableMemoryBytes({ free: 9 * GB, ...where }), 9 * GB, why);
  }
  // Not Linux, or a /proc that cannot be read.
  assert.equal(availableMemoryBytes({ free: 9 * GB, root: '/nonexistent', self: '/nonexistent/cgroup' }), 9 * GB);
});
