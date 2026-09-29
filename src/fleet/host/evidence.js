// The sidecar's half of the commit-confirm evidence, recorded through the hub.
//
// When a release is on trial, reaching the coordinator is this box's proof that
// the update did not sever it from the fleet, and the standing watchdog
// (install/fleetwright-confirm) reverts the release unless both halves — the
// hub's "a session started" and this one — arrive inside the window. The file
// is fleetwright's, in a directory this process may not be able to write since
// the two run as different users (#270), so the sidecar asks fleetwright to
// stamp it (POST /api/update-evidence).
//
// THE ASK HAS TO OUTLIVE THE HUB'S RESTART. An update restarts both services
// together, and fleetwright listens only after its own startup probe — a
// throwaway container, up to thirty seconds. The sidecar reaches the coordinator
// in well under that, so a single request at connect time lands on a closed
// port, and a connection that then stays up never fires the hook again: the
// evidence is never written and every update reverts. The sidecar used to write
// the file itself and had no such gap. So the request is retried, on the
// transport's own idea of time, until fleetwright answers at all — noted, not
// on trial, or a hub too old for the route — or the trial window has passed.

import { HubError } from './hub-client.js';

/** The trial window is ten minutes (src/core/update-confirm.js); this is a
 * little under it, in fifteen-second steps, so a hub that takes its whole
 * probe to come up is still asked in time. */
export const RETRY_MS = 15_000;
export const ATTEMPTS = 36;

/**
 * @param {{ noteCoordinatorReached: () => Promise<{ noted: boolean, why?: string }> }} hub
 * @param {{
 *   log: { info: (m: string) => void, warn: (m: string) => void },
 *   retryMs?: number,
 *   attempts?: number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} opts
 * @returns {Promise<{ noted: boolean, why?: string, attempts: number }>}
 *   What fleetwright finally said, and how many asks it took. Never throws: a
 *   connect is not the place to fail, and the watchdog's revert is the louder
 *   signal if this genuinely never lands.
 */
export async function recordCoordinatorReached(hub, { log, retryMs = RETRY_MS, attempts = ATTEMPTS, sleep = defaultSleep }) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await hub.noteCoordinatorReached();
      if (r.noted) log.info('update: recorded that this box reached its coordinator');
      else if (r.why && r.why !== 'nothing on trial') log.warn(`update: could not record reaching the coordinator — ${r.why}`);
      return { ...r, attempts: attempt };
    } catch (e) {
      const err = /** @type {HubError & { code?: string }} */ (e);
      // Only a hub that is not there yet is worth asking again. A hub that
      // refused the token will refuse it in fifteen seconds too, and saying so
      // once is the useful thing.
      const transient = err instanceof HubError && (err.code === 'hub_unreachable' || err.code === 'hub_timeout');
      if (!transient || attempt >= attempts) {
        log.warn(`update: could not record reaching the coordinator — ${err.message}` + (transient ? ` (gave up after ${attempt} tries)` : ''));
        return { noted: false, why: err.message, attempts: attempt };
      }
      await sleep(retryMs);
    }
  }
}

/** @param {number} ms */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Never what keeps the process alive: a sidecar told to stop while it is
    // still waiting for fleetwright should stop.
    t.unref?.();
  });
}
