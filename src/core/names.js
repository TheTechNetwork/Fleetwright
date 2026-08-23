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

// Words, not hex. A generated name is something a person has to type into a
// chat, read back off a phone screen, and — the case that decides it — SAY OUT
// LOUD to Siri: "resume brave-otter" works, "resume cc-1a2b3c" does not.
//
// Both lists are deliberately dull: short, unambiguous when spoken, no
// homophones, nothing that reads as a judgement about the work. Every entry is
// lowercase a-z, so any pair is inside the name charset by construction and
// starts with a letter, which the fleet protocol requires.
const ADJECTIVES = [
  'amber', 'brave', 'brisk', 'calm', 'clever', 'coral', 'crisp', 'daring', 'dusty', 'eager',
  'early', 'fair', 'fleet', 'fresh', 'gentle', 'glad', 'golden', 'grand', 'happy', 'hardy',
  'honest', 'ivory', 'jolly', 'keen', 'kind', 'lively', 'lucky', 'merry', 'mighty', 'noble',
  'olive', 'patient', 'plucky', 'proud', 'quick', 'quiet', 'rapid', 'ready', 'royal', 'sharp',
  'silver', 'smooth', 'snowy', 'solid', 'spry', 'stout', 'sturdy', 'sunny', 'swift', 'tidy',
  'tough', 'trusty', 'vivid', 'warm', 'wise', 'witty', 'zesty',
];

const NOUNS = [
  'otter', 'falcon', 'badger', 'heron', 'marten', 'osprey', 'raven', 'shrew', 'stoat', 'tapir',
  'walrus', 'wombat', 'bison', 'cougar', 'dingo', 'egret', 'ferret', 'gannet', 'gibbon', 'grouse',
  'hare', 'ibex', 'jackal', 'kestrel', 'lemur', 'lynx', 'magpie', 'marmot', 'mongoose', 'narwhal',
  'ocelot', 'panda', 'pelican', 'puffin', 'quail', 'rabbit', 'salmon', 'seal', 'sparrow', 'stork',
  'tern', 'thrush', 'turtle', 'vulture', 'weasel', 'whale', 'wolf', 'wren', 'yak', 'zebra',
];

/** @param {number} bound */
function pick(bound) {
  // getRandomValues rather than Math.random: not because a session name is a
  // secret, but because two hosts generating names at the same millisecond
  // should not agree, and a seeded PRNG in a restarted process is exactly how
  // that happens.
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] % bound;
}

/**
 * A short, speakable, unique name for when the requester does not supply one —
 * "cc-brave-otter". Prefixed so auto-named sessions are obvious in `tmux ls`
 * and so nothing collides with a name somebody chose by hand.
 *
 * @param {(name: string) => boolean} taken
 */
export function generateName(taken = () => false) {
  const space = ADJECTIVES.length * NOUNS.length;
  for (let i = 0; i < 40; i++) {
    const name = `cc-${ADJECTIVES[pick(ADJECTIVES.length)]}-${NOUNS[pick(NOUNS.length)]}`;
    if (!taken(name)) return name;
  }
  // ~2,850 pairs. Forty collisions means the box genuinely has most of them in
  // use, so fall back to something that cannot collide rather than refusing to
  // start a session over a naming detail.
  for (let i = 0; i < 20; i++) {
    const b = new Uint8Array(3);
    crypto.getRandomValues(b);
    const name = `cc-${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
    if (!taken(name)) return name;
  }
  throw new Error(`could not generate a free session name (${space} word pairs all taken?)`);
}
