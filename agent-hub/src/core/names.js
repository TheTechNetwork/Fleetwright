// Session names are tmux targets, Remote Control names and (via the hook) map
// keys in the state file. Keep them to a strict charset so none of those three
// can be confused by a clever name.

export const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** @param {unknown} name */
export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

/**
 * Why a name was rejected, phrased for a chat reply.
 * @param {string} name
 */
export function nameError(name) {
  if (!name) return 'A session name is required.';
  if (name.length > 40) return `"${name}" is too long — 40 characters max.`;
  return `"${name}" is not a valid session name. Use letters, digits, - and _ only.`;
}

/**
 * A short unique name for when the requester does not supply one, e.g.
 * "cc-1a2b3c". Prefixed so auto-named sessions are obvious in `tmux ls`.
 * @param {(name: string) => boolean} taken
 */
export function generateName(taken = () => false) {
  for (let i = 0; i < 20; i++) {
    const b = new Uint8Array(3);
    crypto.getRandomValues(b);
    const name = 'cc-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    if (!taken(name)) return name;
  }
  // 20 collisions against a 16-million space means `taken` is lying to us.
  throw new Error('could not generate a free session name');
}
