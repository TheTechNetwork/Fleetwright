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
    // NOT discriminated — and the reason is the whole shape of the fix below.
    // A resume dialog is unique: there is one per session, it is not replaced
    // by a DIFFERENT resume dialog meaning something else, so kind plus labels
    // already names it exactly. Its body also carries a live message counter,
    // so folding the body in would churn the id while somebody reads it —
    // which is the property the original design was protecting.
    discriminate: false,
  },
  {
    kind: 'trust',
    test: /Do you trust the files/i,
    question: 'Do you trust the files in this folder?',
    // The dialog names the directory. The QUESTION above does not, and the
    // directory is not what we send.
    carriesSessionText: true,
    // Two trust asks for two directories are the same shape and different
    // questions. The body is a path, which does not redraw.
    discriminate: true,
  },
  {
    kind: 'permission',
    test: /Do you want to proceed/i,
    question: 'A tool wants permission to run.',
    // The pane shows the command. Same rule: we send the question we wrote.
    carriesSessionText: true,
    // THE CASE THE ID EXISTED FOR AND DID NOT COVER. Permission asks are a
    // STREAM — one per tool call — all sharing this kind, this question and
    // the same option labels. Without the body, `rm -rf build` and `git push`
    // produce the same id, and the guard that refuses an answer aimed at a
    // replaced question passes exactly when the replacement is another
    // permission ask.
    discriminate: true,
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
 * @returns {{ kind: string, question: string, options: {index: number, label: string}[], carriesSessionText: boolean, subject: string }|null}
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

  return {
    kind: matched.kind,
    question: matched.question,
    options,
    carriesSessionText: matched.carriesSessionText,
    // WHAT IS ACTUALLY BEING ASKED, for the id and for nothing else. It never
    // leaves the box: describePrompt returns an explicit {question, options},
    // so this field cannot travel by accident, and what does travel is a
    // 32-bit hash of it. See subjectOf and promptId.
    subject: matched.discriminate ? subjectOf(text, matched.test) : '',
  };
}

/**
 * The body of the dialog — the part that differs between two prompts of the
 * same shape.
 *
 * WITHOUT THIS, `promptId` COLLIDES ON THE CASE THAT MATTERS. Every permission
 * dialog shares one kind, one question we wrote, and the same "Yes" / "No, and
 * tell Claude…" labels, so `rm -rf build` and `git push` produced the SAME id.
 * The guard that exists to refuse an answer aimed at a question that has since
 * been replaced passed happily when the replacement was another permission
 * ask — which is the common shape in agent work, and the one where answering
 * the wrong question costs something.
 *
 * ONLY FOR KINDS THAT RECUR. A resume dialog is unique per session and its body
 * carries a live message counter, so folding the body in would buy nothing and
 * churn the id while somebody reads it. Which kinds need discriminating is a
 * property of the kind, and is declared in KINDS rather than inferred here.
 *
 * Taken from the lines ABOVE the question rather than the whole pane, which is
 * what keeps the original property: the dialog's body is static while somebody
 * reads it, and a spinner, a clock or a token counter redrawing below the
 * options must not invalidate a question they are halfway through.
 *
 * Erring sensitive is the right direction. An id that changes too readily
 * refuses an answer that could have been accepted, and the person taps again; an
 * id that changes too rarely types an approval into a question nobody read.
 *
 * @param {string} text  the whole pane
 * @param {RegExp} test  the matcher that recognised the kind
 * @returns {string}
 */
function subjectOf(text, test) {
  const lines = text.split('\n');
  // ANCHORED ON THE FIRST OPTION, not on the question, and the anchor is the
  // load-bearing choice. The request renders above the options; whether it sits
  // above or below the question line varies with the dialog and with the CLI
  // version, so anchoring on the question reads the body for one layout and
  // nothing at all for the other — which is what the first version of this did.
  //
  // Everything AFTER the options is excluded by construction, and that is what
  // keeps a spinner, a token counter or a clock from invalidating a question
  // somebody is halfway through reading.
  const firstOption = lines.findIndex((l) => OPTION_RE.test(l.trim()));
  const end = firstOption < 0 ? lines.length : firstOption;
  const body = [];
  for (let i = end - 1; i >= 0 && body.length < SUBJECT_LINES; i--) {
    const line = lines[i]
      // Box drawing, bullets and the cursor marker are decoration a redraw can
      // move; the text inside them is the request.
      .replace(/[\u2500-\u257f\u2022\u276f>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    // The question is ours and is identical across every prompt of this kind,
    // so it discriminates nothing and only costs room in the bound below.
    if (test.test(line)) continue;
    body.push(line);
  }
  return body.reverse().join(' ').slice(0, SUBJECT_MAX);
}

/** How far above the question to look for the request. */
const SUBJECT_LINES = 12;
/** Bounded so a pasted wall of text cannot make hashing it the expensive part. */
const SUBJECT_MAX = 600;

/**
 * A stable name for "this exact question, as rendered right now".
 *
 * Not a security boundary and not a nonce — it is how an answer says which
 * screen it was looking at. If the pane has moved on, the id no longer matches
 * and the answer is refused rather than typed into whatever is there instead.
 *
 * Derived from the kind, the option labels AND the dialog's own body, rather
 * than from the whole pane — because a spinner or a clock redrawing must not
 * invalidate a question somebody is in the middle of reading, and because
 * WITHOUT THE BODY IT DOES NOT ACTUALLY DO ITS JOB. Kind plus labels is the
 * dialog's SHAPE, and two permission asks have the same shape; an id that only
 * detects a change of shape passes exactly when one command was swapped for
 * another. See subjectOf.
 *
 * The body never leaves the host. What travels is this hash, which a caller
 * echoes back and cannot invert.
 *
 * @param {string} name
 * @param {{ kind: string, options: {index: number, label: string}[], subject?: string }} prompt
 */
export function promptId(name, prompt) {
  const shape = `${name} ${prompt.kind} ${prompt.options.map((o) => `${o.index}:${o.label}`).join('')} ${prompt.subject ?? ''}`;
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
