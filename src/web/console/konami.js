// The one hidden thing on the console.
//
// Pure, like state.js, so the sequence is tested without a browser: app.jsx
// feeds it keys and decides what to do when it completes.
//
// WHAT IT IS ALLOWED TO DO is say one line, outside the Confidence panel. It
// never touches the headline or a claim: an Easter egg that made the page look
// calmer than the fleet is would be the exact lie this page exists to stop.

export const KONAMI = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];

export const KONAMI_LINE = 'No extra lives here. Every host still has to report in for itself.';

/**
 * How far into the sequence a person is after one more key.
 *
 * A wrong key does not always reset to nothing: up, up, up is two ups into the
 * sequence, not zero, or a person who pressed up one time too many would never
 * get there.
 *
 * @param {number} at   keys matched so far
 * @param {string} key  KeyboardEvent.key
 * @returns {number}    keys matched now; KONAMI.length means complete
 */
export function konamiStep(at, key) {
  const k = key.length === 1 ? key.toLowerCase() : key;
  if (k === KONAMI[at]) return at + 1;
  // Only up, up can be a prefix of itself; a third up keeps the last two.
  if (k !== KONAMI[0]) return 0;
  return at === 2 ? 2 : 1;
}
