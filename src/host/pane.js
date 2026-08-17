// Reading text back out of a tmux pane, on the sidecar's side of the wire.
//
// A pane is a fixed-width grid, not a stream: `capture-pane` returns what is on
// screen, so any line longer than the pane is already broken across rows by the
// time anyone sees it. The sidecar gets that text second-hand, through
// agent-hub's `GET /api/peek`, and has to undo the wrapping itself.
//
// WHY THE SIDECAR EXTRACTS THE URL RATHER THAN TRUSTING THE ONE IT IS GIVEN
//
// agent-hub records a Remote Control URL on each session (`rcUrl`) and serves it
// in /api/state. It gets that URL from its own `extractRcUrl`, which matches the
// raw capture with no de-wrapping — and measured against the verbatim CLI 2.1.233
// capture in design.md §10, that fails two ways as soon as the pane is not
// exactly 80 columns wide:
//
//     width 100 →  https://claude.ai/code/session_016zf   truncated, and
//                  well-formed enough that nobody suspects it
//     width  70 →  null                                   the https:// prefix
//                  straddles the break, so nothing matches at all and the
//                  session is reported online with no URL to reach it by
//
// A stock agent-hub is not going to be modified to fix that, so the sidecar
// re-derives the URL from the pane itself and repairs what it was handed. This
// is the whole reason `peek` is in the verb set rather than just `status`.

/**
 * Undo tmux's hard wrapping so a URL split across pane-width lines can be read
 * back as one string.
 *
 * The naive version — join any newline followed by a non-space — is wrong, and
 * wrong in a way that looks fine. In agent-hub's login flow the line right
 * after the URL is the prompt "Paste code here if prompted >", and joining it
 * appended "Paste" to the OAuth `state` parameter, producing a URL that loads
 * and then fails authorization for no visible reason.
 *
 * A genuine tmux wrap has two properties this relies on: the line being
 * continued was full width, and the continuation contains no whitespace at all
 * (it is the middle of one long token). Prose lines fail both tests.
 *
 * @param {string} text
 */
export function dewrapPane(text) {
  // Panes are at least 80 columns in practice; 60 leaves room for a narrower
  // one while staying far above any width prose would wrap at naturally.
  const MIN_WRAPPED_WIDTH = 60;
  const lines = String(text ?? '').split('\n');
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const continues =
      i > 0 &&
      line.length > 0 &&
      !/\s/.test(line) && // a fragment of one long token, not prose
      lines[i - 1].length >= MIN_WRAPPED_WIDTH; // the previous line was full enough to wrap
    out += continues ? line : (i === 0 ? '' : '\n') + line;
  }
  return out;
}

// Matching an explicit URL character set rather than `\S+` is the other half of
// the guard, and it is not optional once de-wrapping is in play. De-wrapping can
// only ever join MORE text onto the end of the URL, and the pane is a TUI: the
// thing sitting on the next row is as likely to be a box-drawing character as a
// real path segment. `\S+` would swallow it; this stops at the first character
// that cannot appear in a URL.
const RC_URL_RE = /https?:\/\/claude\.ai\/code\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/;

/**
 * Pull the Remote Control URL out of a captured pane.
 * @param {string} text
 * @returns {string|null}
 */
export function extractRcUrl(text) {
  const m = dewrapPane(text).match(RC_URL_RE);
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
  return RC_ONLINE_RE.test(dewrapPane(text));
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
