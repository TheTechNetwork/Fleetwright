// A few words this box answers that /help does not list.
//
// THE RULES THEY KEEP, which are the rules everything else here keeps. None
// of them reports a state: a joke that said "all is well" would be a claim
// with nothing behind it, on the one surface whose job is claims with
// something behind them. None of them changes anything. And none of them is
// in COMMANDS, which is what keeps them out of /help and out of the sidecar's
// gate: canonicalCommand() does not know these words, so the fleet refuses
// them from a phone or an agent, and only a person at this box finds them,
// by typing one at its CLI: `fleetwright xyzzy`. Not on the console, which
// shows the fleet and has nowhere to type; it has a hidden thing of its own,
// in konami.js, and the two share the one line they both say.
//
// dispatch() asks here only after it has failed to find a real command, so an
// egg can never shadow one.

import { KONAMI, KONAMI_LINE } from '../web/console/konami.js';

/**
 * The words that answer the same way every time.
 * @type {Record<string, string>}
 */
const EGGS = {
  // Colossal Cave, 1976. The other magic word; this is what it said when you
  // used one in the wrong place.
  plugh: 'A hollow voice says "Fool."',
  // CLAUDE.md: "It should not say hello." So it says why not, and where to go.
  hello: 'This box does not say hello. It says whether anything needs you, and /status is where it says it.',
  hi: 'This box does not say hello. It says whether anything needs you, and /status is where it says it.',
  // docs/psychology.md: the product turns unbounded anxiety into bounded
  // knowledge. This is that sentence, for somebody who typed the feeling.
  panic: "Don't panic. /status says what is true on this box right now, and /list says what every session is doing.",
};

// What this box allows from chat is set in exactly one place, and it is not
// here. Saying where is more use than a joke about sandwiches, unless the
// sandwich is the one from xkcd 149, below.
const SUDO = 'Not from here. What this box allows from chat is set by `sudo fleetwright grant`, on the box itself.';

/**
 * How many times anybody at this box has typed xyzzy since the hub started.
 * One count for the box, not per person: it is a cave, and the cave does not
 * know who is in it.
 */
let cave = 0;

// The first magic word anybody typed at a computer that typed back, and what
// it said in Adventure when the word did nothing. The third line is the
// game's most quoted one with a word changed, and the change is true here on
// purpose: docs/design-system.md spends RHYTHM on every host row being the
// same shape, so that a row which looks different means something is.
const XYZZY = [
  'Nothing happens.',
  'Nothing happens, again.',
  'You are in a maze of twisty little hosts, all alike. Nothing happens.',
];

const SANDWICH = ['me', 'a', 'sandwich'];

// The Konami code, typed as words at a prompt that has no arrow keys. The
// line is the console's, imported rather than copied, so the two surfaces
// cannot drift apart on a joke.
/** @type {Record<string, string>} */
const KEY_WORDS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', b: 'b', a: 'a' };
const KONAMI_GLYPHS = '↑↑↓↓←→←→ba';

/**
 * @param {string[]} args  as parse() returns them
 * @param {string[]} words what they must be, lower-cased
 */
function says(args, words) {
  return args.length === words.length && words.every((w, i) => w === args[i].toLowerCase());
}

/**
 * The reply to a hidden word, or null when the word is not one.
 * @param {string} name    as parse() returns it: no slash, lower-cased
 * @param {string[]} args  the rest of the line, which a few of these read
 * @returns {string|null}
 */
export function egg(name, args = []) {
  if (Object.hasOwn(EGGS, name)) return EGGS[name];
  switch (name) {
    case 'xyzzy':
      return XYZZY[cave++] ?? XYZZY[0];
    // xkcd 149. "What? Make it yourself." / "sudo make me a sandwich" / "Okay."
    case 'make':
      return says(args, SANDWICH) ? 'What? Make it yourself.' : null;
    case 'sudo':
      return says(args, ['make', ...SANDWICH]) ? 'Okay.' : SUDO;
    case 'up': {
      const keys = [name, ...args].map((w) => KEY_WORDS[w.toLowerCase()]);
      return keys.length === KONAMI.length && keys.every((k, i) => k === KONAMI[i]) ? KONAMI_LINE : null;
    }
    case KONAMI_GLYPHS:
      return args.length ? null : KONAMI_LINE;
    default:
      return null;
  }
}
