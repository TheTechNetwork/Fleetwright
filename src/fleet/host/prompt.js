// What a session is actually asking, as an object.
//
// Before this, the answer to "what does it want?" was a boolean. watcher.js read
// the whole pane, tested it against four English regexes, set `awaiting = true`
// and dropped the text on the next line; the notification body then came from
// `session.detail`, which is the registry's last LIFECYCLE string. So a push at
// 3am said "resumed (summary)" — never the question.
//
// Everything downstream inherited that emptiness. The notification had nothing
// to say, so the phone had nothing to offer, so the only honest button left was
// one that leaves the app.
//
// WHAT THIS DELIBERATELY IS NOT. It is not a terminal reader and it does not
// hand pane text onward. It recognises SHAPES it knows and emits fields it
// chose: a kind, a question drawn from a fixed vocabulary, and numbered options
// that matched a strict pattern and are length-capped. Anything it does not
// recognise produces null, and null means "something is waiting" — the old
// behaviour, which is still true and still useful.
//
// That distinction is the whole privacy story. A parser that forwarded the pane
// would put file paths and command lines on a lock screen, through Apple's and
// Google's servers, for a fleet that may not belong to the person holding the
// phone. A parser that forwards only what it matched cannot.

/** The shapes we know. Order matters: the most specific first. */
const KINDS = [
  {
    kind: 'resume',
    // Fleet-authored either way — these strings come from Claude Code's own
    // dialog and carry nothing about the work.
    test: /Resume from summary|Resume full session/i,
    question: 'Resume this session from a summary, or in full?',
    carriesSessionText: false,
  },
  {
    kind: 'trust',
    test: /Do you trust the files/i,
    question: 'Do you trust the files in this folder?',
    // The dialog names the directory. The QUESTION above does not, and the
    // directory is not what we send.
    carriesSessionText: true,
  },
  {
    kind: 'permission',
    test: /Do you want to proceed/i,
    question: 'A tool wants permission to run.',
    // The pane shows the command. Same rule: we send the question we wrote.
    carriesSessionText: true,
  },
];

/** A numbered option, with or without the cursor marker in front of it. */
const OPTION_RE = /^[^\w\d]{0,3}(\d)\.\s+(\S.*)$/;

/** Long enough for a real label, short enough not to smuggle a pane through. */
const MAX_LABEL = 80;

/**
 * Read a pane and say what is being asked, or null if nothing recognised is.
 *
 * @param {string} pane
 * @returns {{ kind: string, question: string, options: {index: number, label: string}[], carriesSessionText: boolean }|null}
 */
export function readPrompt(pane) {
  const text = String(pane || '');
  const matched = KINDS.find((k) => k.test.test(text));
  if (!matched) return null;

  /** @type {{index: number, label: string}[]} */
  const options = [];
  for (const line of text.split('\n')) {
    const m = OPTION_RE.exec(line.trim());
    if (!m) continue;
    const label = m[2].trim().slice(0, MAX_LABEL);
    // "Don't ask me again" is never offered, the same exclusion
    // parseResumeDialog already makes: it flips a global preference for every
    // future session, and a permanent grant made from a lock screen — with the
    // least context anyone will ever have — is not a decision to make in one tap.
    if (/don'?t ask me again/i.test(label)) continue;
    // A dialog renders each option once. Anything repeated is the pane's
    // scrollback, not a second choice.
    if (options.some((o) => o.index === Number(m[1]))) continue;
    options.push({ index: Number(m[1]), label });
  }
  options.sort((a, b) => a.index - b.index);

  return { kind: matched.kind, question: matched.question, options, carriesSessionText: matched.carriesSessionText };
}

/**
 * A stable name for "this exact question, as rendered right now".
 *
 * Not a security boundary and not a nonce — it is how an answer says which
 * screen it was looking at. If the pane has moved on, the id no longer matches
 * and the answer is refused rather than typed into whatever is there instead.
 *
 * Derived from the kind and the option labels rather than from the whole pane,
 * because a spinner or a clock redrawing must not invalidate a question
 * somebody is in the middle of reading.
 *
 * @param {string} name
 * @param {{ kind: string, options: {index: number, label: string}[] }} prompt
 */
export function promptId(name, prompt) {
  const shape = `${name} ${prompt.kind} ${prompt.options.map((o) => `${o.index}:${o.label}`).join('')}`;
  // FNV-1a, 32-bit, hex. Not cryptographic and not pretending to be: what it
  // protects is "did the screen change", and both ends compute it from the same
  // pane seconds apart.
  let h = 0x811c9dc5;
  for (let i = 0; i < shape.length; i++) {
    h ^= shape.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * What a notification is allowed to say about this prompt.
 *
 * @param {{ kind: string, question: string, options: {index: number, label: string}[], carriesSessionText: boolean }} prompt
 * @param {boolean} allowSessionText whether this fleet permits the fuller form
 */
export function describePrompt(prompt, allowSessionText) {
  if (prompt.carriesSessionText && !allowSessionText) {
    // The question is ours either way; what gets dropped is the option labels,
    // which for a permission dialog can name a command.
    return { question: prompt.question, options: [] };
  }
  return { question: prompt.question, options: prompt.options };
}
