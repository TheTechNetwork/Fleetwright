// Reading text back out of a tmux pane, on the sidecar's side of the wire.
//
// A pane is a fixed-width grid, not a stream: `capture-pane` returns what is on
// screen, so any line longer than the pane is already broken across rows by the
// time anyone sees it. The sidecar gets that text second-hand, through
// agent-hub's `GET /api/peek`, and has to undo the wrapping itself.
//
// WHY THE SIDECAR EXTRACTS THE URL RATHER THAN TRUSTING THE ONE IT IS GIVEN
//
// The session manager records a Remote Control URL on each session (`rcUrl`) and
// serves it in /api/state. Its own `extractRcUrl` used to match the raw capture
// with no de-wrapping, and measured against the verbatim CLI 2.1.233 capture in
// design.md §10 that failed two ways as soon as the pane was not exactly 80
// columns wide:
//
//     width 100 →  https://claude.ai/code/session_016zf   truncated, and
//                  well-formed enough that nobody suspects it
//     width  70 →  null                                   the https:// prefix
//                  straddles the break, so nothing matches at all and the
//                  session is reported online with no URL to reach it by
//
// That is fixed at source now (core/claude.js), so this layer is no longer
// load-bearing for correctness. It stays for two reasons: a host may be running
// a session manager older than this tree, and with both in place a `truncated`
// or `missing` from reconcileRcUrl means the extraction upstream of it has
// regressed — which is exactly the failure that went unnoticed the first time,
// because nothing was watching for it.

// De-wrapping itself belongs to the session manager, not the fleet: core/pane.js
// is where it lives and where the login flow uses it. Imported rather than
// re-implemented — two copies of a rule this subtle is how they drift, and it is
// subtle (see that file for the "Paste code here" bug that shaped it).
import { dewrapPane, RC_URL_RE } from '../../core/pane.js';

export { dewrapPane };

// Matching an explicit URL character set rather than `\S+` is the other half of
// the guard, and it is not optional once de-wrapping is in play. De-wrapping can
// only ever join MORE text onto the end of the URL, and the pane is a TUI: the
// thing sitting on the next row is as likely to be a box-drawing character as a
// real path segment. `\S+` would swallow it; this stops at the first character
// that cannot appear in a URL.


/**
 * Pull the Remote Control URL out of a captured pane.
 * @param {string} text
 * @returns {string|null}
 */
export function extractRcUrl(text) {
  // Guarded here rather than in core/pane.js: that one is only ever handed
  // capturePane output, which is always a string. This one is handed whatever
  // came back as JSON over HTTP.
  const m = dewrapPane(String(text ?? '')).match(RC_URL_RE);
  // Trailing punctuation is legal in a URL but is almost always the sentence
  // around it rather than part of the link.
  return m ? m[0].replace(/[)\].,]+$/, '') : null;
}

// The markers Claude Code prints once Remote Control is online, across its
// interactive and server modes. Same set agent-hub matches, tested against
// de-wrapped text here because one of the markers IS the URL — on a pane narrow
// enough to wrap it, "claude.ai/code" is split across two rows and matches
// nothing.
//
// Note the flag matters: launched WITHOUT `--remote-control <name>` the pane
// shows only "/rc active" in the status line, which matches none of these.
// agent-hub always passes the flag, so this is not a live gap — but a session
// started some other way will read as offline here.
const RC_ONLINE_RE =
  /remote-control is active|claude\.ai\/code|Continue (?:here, on your phone|coding in the Claude mobile app)|·\s*Connected/i;

/**
 * Is Remote Control up, judged from the pane alone?
 * @param {string} text
 */
export function isRemoteControlOnline(text) {
  return RC_ONLINE_RE.test(dewrapPane(String(text ?? '')));
}

/**
 * @typedef {object} RcUrlResult
 * @property {string|null} url       the best URL available, or null
 * @property {'pane'|'record'|null} source
 * @property {boolean} repaired      true when the pane disagreed with the record
 * @property {'missing'|'truncated'|'mismatch'|null} reason  why it was repaired
 */

/**
 * Reconcile the URL agent-hub recorded against the one the live pane actually
 * shows, preferring the pane.
 *
 * The pane is the primary source because it is current and because the record
 * was produced by the unguarded matcher. The record is the fallback for the
 * ordinary case where the pane has since scrolled the banner away.
 *
 * `reason` distinguishes the two failures worth knowing about separately:
 * `truncated` is the silent one (a link that loads and goes nowhere), `missing`
 * is the loud one (a session reported online and unreachable).
 *
 * @param {{ recorded?: string|null, pane?: string|null }} opts
 * @returns {RcUrlResult}
 */
export function reconcileRcUrl({ recorded = null, pane = null }) {
  const fromPane = pane ? extractRcUrl(pane) : null;
  const rec = recorded || null;

  if (!fromPane) {
    return { url: rec, source: rec ? 'record' : null, repaired: false, reason: null };
  }
  if (!rec) {
    return { url: fromPane, source: 'pane', repaired: true, reason: 'missing' };
  }
  if (fromPane === rec) {
    return { url: rec, source: 'record', repaired: false, reason: null };
  }
  return {
    url: fromPane,
    source: 'pane',
    repaired: true,
    // A recorded URL that is a strict prefix of the live one is the truncation
    // case specifically, which is worth naming because it is the one that looks
    // fine in a log.
    reason: fromPane.startsWith(rec) ? 'truncated' : 'mismatch',
  };
}
