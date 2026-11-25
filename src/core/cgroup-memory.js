// The memory this process may still take, where it is allowed less than the
// box has.
//
// WHY. capacity.js counts sessions against the memory that is available, and
// that number was asked of the kernel for the whole box (os.freemem(), which
// is MemAvailable). A hub is not always given the whole box. The one inside a
// machine made on a box (src/core/machines.js) runs in a container started
// with `--memory`, what that box gives a session, and a container's
// /proc/meminfo is the box's: allowed 8 GB on a box with 60 free, it would
// count sixteen sessions into the eight. The kernel ends a container that
// passes its limit, and every session in it goes at once, with no refusal
// anybody reads first. The same is true of a hub under a unit's MemoryMax,
// or in a container somebody else made.
//
// WHAT IS READ. The limit is the cgroup's, version 2: this process's group
// from /proc/self/cgroup, and under /sys/fs/cgroup that group's
// `memory.max`, `memory.current` and `memory.stat`. A limit can sit on any
// group above this one, so each one up to the root is read and the least room
// is the answer. Inside a container the group is `/` and the files at the top
// are the container's own.
//
// ROOM IS THE LIMIT LESS WHAT IS HELD AND WOULD NOT BE GIVEN BACK.
// `memory.current` counts the page cache, and capacity.js counts cache as
// available, "because it will" be dropped. So the cache the kernel gives up
// before it ends anything (`inactive_file`) is taken off what is held, the
// same sum MemAvailable is for a box.
//
// NOT READ: cgroup version 1. Rootless Podman sets no memory limit under it,
// and the boxes this runs on are on version 2. There, and wherever nothing
// can be read, the answer is "no limit known" and the box's own number
// stands, which is how this behaved before.
//
// NOTHING HERE HAS RUN IN A CONTAINER. The tests read a tree that stands in
// for /sys/fs/cgroup (test/cgroup-memory.test.js). That a machine's hub then
// refuses a session for memory at its container's limit has not been seen:
// CI starts its machine with no limits (scripts/machine-smoke.mjs says why).

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A file that holds one whole number, or null: `max` is no limit, and so is a file that is not there. @param {string} file */
function whole(file) {
  try {
    const text = readFileSync(file, 'utf8').trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

/** The cache a group holds that the kernel gives up first, from its `memory.stat`. @param {string} dir */
function givenBack(dir) {
  try {
    const m = /^inactive_file (\d+)$/m.exec(readFileSync(path.join(dir, 'memory.stat'), 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * How many bytes this process's cgroup may still take, or null when no
 * limit on it is known.
 *
 * @param {{ root?: string, self?: string }} [where]  where the cgroup tree and this process's own line are; a test's stand-ins
 * @returns {number|null}
 */
export function cgroupRoomBytes({ root = '/sys/fs/cgroup', self = '/proc/self/cgroup' } = {}) {
  let group;
  try {
    // Version 2 is the one line that begins `0::`. A box on version 1 has a
    // line for each controller and none like it.
    const line = readFileSync(self, 'utf8').split('\n').find((l) => l.startsWith('0::'));
    if (line === undefined) return null;
    group = path.posix.normalize(`/${line.slice(3).trim()}`);
  } catch {
    return null;
  }
  /** @type {number|null} */
  let least = null;
  for (let dir = group; ; dir = path.posix.dirname(dir)) {
    const here = path.join(root, dir);
    const max = whole(path.join(here, 'memory.max'));
    const current = whole(path.join(here, 'memory.current'));
    if (max !== null && current !== null) {
      const room = Math.max(0, max - Math.max(0, current - givenBack(here)));
      least = least === null ? room : Math.min(least, room);
    }
    if (dir === '/') break;
  }
  return least;
}

/**
 * The memory a new session can be counted against: what the box has
 * available, or what this process's cgroup leaves it, whichever is less.
 * What capacity.js is told is free (src/index.js).
 *
 * @param {{ free?: number, root?: string, self?: string }} [where]  `free` is the box's own number, os.freemem() unless said
 */
export function availableMemoryBytes({ free = os.freemem(), root, self } = {}) {
  const room = cgroupRoomBytes({ ...(root ? { root } : {}), ...(self ? { self } : {}) });
  return room === null ? free : Math.min(free, room);
}
