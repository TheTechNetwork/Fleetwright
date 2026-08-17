// Reading text back out of a tmux pane.
//
// A pane is a fixed-width grid, not a stream: `capture-pane` returns what is on
// screen, so any line longer than the pane is already broken across rows by the
// time we see it. Every consumer that pulls a single long token — a URL — out
// of a capture has to undo that first, which is why this lives in its own
// module rather than next to whichever caller needed it first.

/**
 * Undo tmux's hard wrapping so a URL split across pane-width lines can be read
 * back as one string.
 *
 * The naive version — join any newline followed by a non-space — is wrong, and
 * wrong in a way that looks fine. The line right after the URL is the prompt
 * "Paste code here if prompted >", and joining it appended "Paste" to the
 * OAuth `state` parameter, producing a URL that loads and then fails
 * authorization for no visible reason.
 *
 * A genuine tmux wrap has two properties this relies on: the line being
 * continued was full width, and the continuation contains no whitespace at all
 * (it is the middle of one long token). Prose lines fail both tests.
 *
 * @param {string} text
 */
export function dewrapPane(text) {
  // Panes are at least 80 columns in practice; 60 leaves room for a narrower
  // one while staying far above any line prose would wrap at naturally.
  const MIN_WRAPPED_WIDTH = 60;
  const lines = text.split('\n');
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
