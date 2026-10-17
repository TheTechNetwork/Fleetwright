// A few words this box answers that /help does not list.
//
// THE RULES THEY KEEP, which are the rules everything else here keeps. None
// of them reports a state: a joke that said "all is well" would be a claim
// with nothing behind it, on the one surface whose job is claims with
// something behind them. None of them changes anything. And none of them is
// in COMMANDS, which is what keeps them out of /help and out of the sidecar's
// gate: canonicalCommand() does not know these words, so the fleet refuses
// them and only a person at this box, on its console or its CLI, finds them.
//
// dispatch() asks here only after it has failed to find a real command, so an
// egg can never shadow one.

/** @type {Record<string, string>} */
const EGGS = {
  // Colossal Cave, 1976. The first magic word anybody typed at a computer
  // that typed back.
  xyzzy: 'Nothing happens.',
  plugh: 'A hollow voice says "Fool."',
  // CLAUDE.md: "It should not say hello." So it says why not, and where to go.
  hello: 'This box does not say hello. It says whether anything needs you, and /status is where it says it.',
  hi: 'This box does not say hello. It says whether anything needs you, and /status is where it says it.',
  // docs/psychology.md: the product turns unbounded anxiety into bounded
  // knowledge. This is that sentence, for somebody who typed the feeling.
  panic: "Don't panic. /status says what is true on this box right now, and /list says what every session is doing.",
  // What this box allows from chat is set in exactly one place, and it is not
  // here. Saying where is more use than a joke about sandwiches.
  sudo: 'Not from here. What this box allows from chat is set by `sudo fleetwright grant`, on the box itself.',
};

/**
 * The reply to a hidden word, or null when the word is not one.
 * @param {string} name  as parse() returns it: no slash, lower-cased
 * @returns {string|null}
 */
export function egg(name) {
  return Object.hasOwn(EGGS, name) ? EGGS[name] : null;
}
