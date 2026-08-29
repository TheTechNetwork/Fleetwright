// Keep secrets out of the journal.
//
// WHY THIS IS A MODULE AND NOT A CAREFUL LINE AT EACH LOG SITE
//
// `src/core/login.js` is scrupulous about this — "the code is never logged: it
// is a live credential for the account being attached, for the seconds before
// it is exchanged" — and then every surface above it logs the command line
// verbatim before the flow ever sees it:
//
//     http.js:188      log.info(`http: ${clientLabel(req)} → ${line.slice(0, 120)}`)
//     telegram.js:165  log.info(`telegram: ${who} (${userId}) → ${text.slice(0, 120)}`)
//     sidecar.js       log.info(`sidecar: ${actor} → ${line}`)
//
// So `/code <authorization-code>` has been landing in the journal, on three
// surfaces, since the day login shipped. Nobody wrote a bug: care was taken in
// the one file that thinks about credentials, and undone in three files that
// think about logging. That is what makes a helper the right shape — the
// knowledge of WHICH ARGUMENT IS A SECRET has to live in one place, next to
// the list of commands, or it rots the moment a fourth surface is added.
//
// It matters more now than it did: `logs` reaches a service journal from a
// phone, so what is in the journal is no longer only readable by someone who
// already has the box.

/**
 * Commands whose arguments are credentials, and the index at which the secret
 * part starts.
 *
 * The value is the number of leading arguments that are SAFE — a provider name
 * is worth keeping, because a redacted log line that does not say what was
 * being linked answers nothing at all.
 */
const SECRET_FROM = new Map([
  ['code', 0], // /code <authorization-code>
  ['link', 1], // /link <provider> <token>
  // /renew <provider> <refresh-token> <client-secret> — TWO secrets, and the
  // second is the App's own, shared by every host in the fleet. The provider
  // name is still worth keeping for the same reason it is on `link`.
  ['renew', 1],
]);

/** What replaces it. Fixed length, so the log never leaks the secret's size. */
const MASK = '<redacted>';

/**
 * Redact any credential in a command line, leaving everything else intact.
 *
 * Deliberately conservative: it matches on the command word only, so a line it
 * does not recognise is returned unchanged rather than mangled. A new
 * secret-bearing command must be added to the table above — which is a thing a
 * reviewer can check, unlike "did every log site remember".
 *
 * @param {string} line
 * @returns {string}
 */
export function redactCommandLine(line) {
  const text = String(line ?? '');
  const m = /^(\s*\/?)([a-z][a-z0-9_-]*)(\s+)([\s\S]*)$/i.exec(text);
  if (!m) return text; // no arguments at all — nothing to redact
  const [, lead, word, gap, rest] = m;
  const keep = SECRET_FROM.get(word.toLowerCase());
  if (keep === undefined) return text;

  const args = rest.split(/\s+/).filter(Boolean);
  if (args.length <= keep) return text; // the secret has not been typed yet
  return `${lead}${word}${gap}${[...args.slice(0, keep), MASK].join(' ')}`;
}

/**
 * True when this command carries a credential, whether or not one was typed.
 *
 * Used where a log line is assembled from parts rather than from a whole
 * command string — the sidecar knows the verb before it knows the line.
 *
 * @param {string} word  a command or verb name, with or without a leading slash
 */
export function carriesSecret(word) {
  return SECRET_FROM.has(String(word ?? '').replace(/^\//, '').toLowerCase());
}
