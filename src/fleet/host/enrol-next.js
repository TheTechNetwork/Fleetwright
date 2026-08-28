// What to tell somebody once the coordinator knows their host.
//
// Separated from the doing so it can be tested, because the wrong answer here
// is not a crash — it is a confidently printed instruction that wastes
// somebody's time, which no smoke test notices.
//
// The instruction it replaces was "Start the sidecar: sudo systemctl restart
// agent-fleet-sidecar", printed unconditionally. On the common path that is
// wrong: enrolment registers the public half of a key the running sidecar is
// ALREADY signing with, it re-signs a fresh nonce on every dial, and the
// transport retries for ever with a backoff capped at MAX_BACKOFF_MS. A sidecar
// that is up connects by itself. Telling somebody to restart a healthy service,
// as root, to achieve what it was about to do anyway, teaches them the tool does
// not know what it is doing.

/**
 * @param {object} o
 * @param {boolean} o.unitInstalled  is there a unit file for this on this box
 * @param {string}  o.state          `systemctl is-active` output, trimmed
 * @param {boolean} o.tty            can we ask a question and get an answer
 * @param {boolean} o.quiet          caller does its own service management
 * @param {number}  o.maxBackoffMs   the transport's reconnect ceiling
 * @returns {{ kind: 'connects-itself'|'no-service'|'offer-start'|'tell-start', text: string }}
 */
export function enrolNextStep({ unitInstalled, state, tty, quiet, maxBackoffMs }) {
  // Not an installed box at all — a checkout, a container, a Mac. `systemctl
  // is-active` answers "inactive" for a unit it has never heard of (exit 4), so
  // the state alone cannot tell these apart, and naming a unit that does not
  // exist is worse than naming nothing.
  if (!unitInstalled) {
    return { kind: 'no-service', text: 'The sidecar will connect the next time it dials the coordinator.' };
  }

  if (state === 'active' || state === 'activating' || state === 'reloading') {
    const secs = Math.round(maxBackoffMs / 1000);
    return {
      kind: 'connects-itself',
      text: `Nothing else to do — the sidecar is running and will connect within ${secs}s.`,
    };
  }

  // Not running. The verb is `start`, never `restart`.
  if (quiet || !tty) {
    return { kind: 'tell-start', text: 'The sidecar is not running.  sudo systemctl start agent-fleet-sidecar' };
  }
  return { kind: 'offer-start', text: 'The sidecar is not running. Start it now?' };
}
