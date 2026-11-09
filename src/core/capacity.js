// How many more sessions this box can take, measured rather than fixed.
//
// A FIXED COUNT WAS THE WRONG QUESTION. Five was right for the box this came
// from, which hard-froze at load ~14 with 4 claude and 6 headless chrome, and
// wrong for everything else: a 12GB cloud VM sat refusing work at 5/5 with
// 9GB available and a load of 0.14, and a 4GB Pi was allowed the same five. A
// session waiting on the model costs memory and almost no CPU; what freezes a
// box is running out of memory, or every core being busy with builds. So those
// are what is asked.
//
//   memory   the box keeps FLEETWRIGHT_MEMORY_FLOOR_MB available for itself,
//            and each new session needs FLEETWRIGHT_SESSION_MEMORY_MB above
//            that. "Available" is the kernel's MemAvailable (what os.freemem()
//            reads on Linux): page cache it can drop counts, because it will
//   load     the one-minute load per core under FLEETWRIGHT_MAX_LOAD_PER_CORE.
//            A box already that busy is not given more, whatever its memory
//   ceiling  FLEETWRIGHT_MAX_SESSIONS, when set, is still a hard limit. A box
//            owner who wants five gets five. Unset, the ceiling is
//            DEFAULT_CEILING, which is there for the case nothing above
//            catches: a box with memory to spare and nothing running yet
//
// STARTS STILL WARMING UP ARE COUNTED. A session takes the better part of a
// minute to reach its working size and the load average lags by the same, so
// five starts in five seconds would each see an idle box. Every start in the
// last WARMUP_MS has its memory taken off what is available before the sum.
//
// PURE. The caller passes the machine in; nothing here reads the clock or the
// OS, so the tests say exactly what a box with 3GB and a load of 4 is told.

/** The ceiling when FLEETWRIGHT_MAX_SESSIONS is unset. */
export const DEFAULT_CEILING = 16;
/** How long a start counts as not yet at its working size. */
export const WARMUP_MS = 90_000;

const MB = 1024 * 1024;

/**
 * @typedef {object} CapacityConfig
 * @property {number|null} maxSessions  the ceiling the box owner set, or null
 * @property {number} sessionMemoryMb
 * @property {number} memoryFloorMb
 * @property {number} maxLoadPerCore
 */

/**
 * @typedef {object} Capacity
 * @property {number} running
 * @property {number} free     how many more it would admit now
 * @property {number} limit    running + free: what "n of limit" should say
 * @property {number} ceiling
 * @property {'memory'|'load'|'ceiling'|null} bound  what is limiting it, when free is 0
 * @property {string|null} why a sentence for a refusal, when free is 0
 */

/**
 * @param {{ running: number, warming?: number, cfg: CapacityConfig,
 *   machine: { freeMemBytes: number, load1: number, cpus: number } }} args
 *   warming: starts within WARMUP_MS, already included in `running`
 * @returns {Capacity}
 */
export function capacity({ running, warming = 0, cfg, machine }) {
  const ceiling = cfg.maxSessions ?? DEFAULT_CEILING;
  const perSession = Math.max(1, cfg.sessionMemoryMb);
  const availableMb = machine.freeMemBytes / MB - warming * perSession;
  const byMemory = Math.max(0, Math.floor((availableMb - cfg.memoryFloorMb) / perSession));
  const byCeiling = Math.max(0, ceiling - running);
  const cpus = Math.max(1, machine.cpus);
  const loadPerCore = machine.load1 / cpus;
  const overloaded = loadPerCore >= cfg.maxLoadPerCore;

  const free = overloaded ? 0 : Math.min(byMemory, byCeiling);
  /** @type {Capacity['bound']} */
  let bound = null;
  /** @type {string|null} */
  let why = null;
  if (free === 0) {
    if (byCeiling === 0) {
      bound = 'ceiling';
      why = cfg.maxSessions === null
        ? `At ${running} sessions, the most this box runs without FLEETWRIGHT_MAX_SESSIONS set. Stop a session first, or set it higher if the box can take it.`
        : `At the session limit this box sets (${running}/${ceiling}). Stop a session first, or raise FLEETWRIGHT_MAX_SESSIONS.`;
    } else if (overloaded) {
      bound = 'load';
      why = `Too busy for another session: load ${machine.load1.toFixed(1)} on ${cpus} core${cpus === 1 ? '' : 's'}, ` +
        `and it takes new ones under ${(cfg.maxLoadPerCore * cpus).toFixed(1)}. Try again when the work running here eases, or use another box.`;
    } else {
      bound = 'memory';
      const gb = (/** @type {number} */ mb) => `${(Math.max(0, mb) / 1024).toFixed(1)}GB`;
      why = `Short on memory for another session: ${gb(machine.freeMemBytes / MB)} available` +
        `${warming ? `, ${gb(warming * perSession)} of it held for ${warming} still starting` : ''}` +
        `, and a session needs ${gb(perSession)} with ${gb(cfg.memoryFloorMb)} kept for the box. Stop a session first, or use another box.`;
    }
  }
  return { running, free, limit: running + free, ceiling, bound, why };
}

/**
 * What a session manager says about room, or, for one without capacity()
 * (a test's stand-in), the configured count as it was before this file.
 *
 * @param {any} sessions @param {{ maxSessions?: number|null }} cfg @param {number} running
 * @returns {Capacity}
 */
export function roomOf(sessions, cfg, running) {
  if (typeof sessions?.capacity === 'function') return sessions.capacity(running);
  const ceiling = typeof cfg.maxSessions === 'number' ? cfg.maxSessions : DEFAULT_CEILING;
  const free = Math.max(0, ceiling - running);
  return { running, free, limit: running + free, ceiling, bound: free ? null : 'ceiling', why: free ? null : `At the session limit (${running}/${ceiling}).` };
}
