// The two questions the fleet asks Clef-flash about a still terminal pane,
// pinned here and nowhere else (docs/decide-design.md, section B).
//
// The wording is part of the model: DECIDE_P_AWAITING is calibrated by
// scripts/decide-harness.mjs against exactly these strings, so a reworded
// question is an uncalibrated one. test/decide-questions.test.js holds them as
// literals; changing a word here means re-running the harness and changing
// that test in the same pull request, with the new threshold.
//
// `kind` lists its options by name only, as the design does. It is evidence
// for the journal and for CI, and it never acts.

export const DECIDE_MODEL = '@cf/cloudflare/clef-flash';

// The request body's own model field, which the REST endpoint and the binding
// both expect beside the path's model id.
export const DECIDE_MODEL_FIELD = 'clef-flash';

/**
 * The probability of `asked` at or above which a host treats a still pane as
 * waiting for a person. Set by scripts/decide-harness.mjs, not by taste: the
 * lowest value at which no hand-labelled negative read as asked, on masked
 * text, on 2026-10-31 (docs/decide.md has the run). It belongs beside the
 * wording because it was measured against the wording.
 */
export const DECIDE_P_AWAITING = 0.8926;

/** A `kind` is a label only at this confidence; below it, it is a guess (section D). */
export const DECIDE_KIND_CONFIDENCE = 0.7;

export const DECIDE_KINDS =Object.freeze(['resume', 'trust', 'permission', 'directory', 'api-key', 'other']);

export const DECIDE_QUESTIONS = Object.freeze({
  asked: Object.freeze({
    type: 'noul',
    instructions:
      'This is the bottom of a terminal running a coding assistant. Is it currently stopped, waiting for a person to pick one of several offered options or to confirm before it continues?',
    criteria: Object.freeze({
      true: 'A dialog or prompt with numbered or listed choices, waiting.',
      false:
        "Output still being produced, a finished result, an ordinary shell prompt, or a list that is part of the assistant's own text rather than a question to the person.",
    }),
  }),
  kind: Object.freeze({
    type: 'choice',
    instructions: 'If it is waiting, what is it asking?',
    criteria: Object.freeze(Object.fromEntries(DECIDE_KINDS.map((k) => [k, k]))),
  }),
});

/**
 * The request body for one decision. Never carries `images`.
 *
 * @param {string} state
 */
export function decideRequest(state) {
  return { model: DECIDE_MODEL_FIELD, state, questions: DECIDE_QUESTIONS };
}

/**
 * Read a Clef-flash response into the fleet's shape, or null when it is not
 * one. `asked` is the noul probability; a noul has no confidence field, so the
 * threshold applies to it directly. `kind` travels with its own confidence, so
 * a reader can never mistake a guess for a label.
 *
 * @param {any} result
 * @returns {{ p: number, kind: string|null, confidence: number|null, inputTokens: number|null }|null}
 */
export function readDecideAnswer(result) {
  const answers = result?.answers;
  const p = answers?.asked?.noul;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
  const kindAnswer = answers?.kind;
  const kind = DECIDE_KINDS.includes(kindAnswer?.choice) ? kindAnswer.choice : null;
  const confidence = typeof kindAnswer?.confidence === 'number' ? kindAnswer.confidence : null;
  const tokens = result?.usage?.input_tokens;
  return { p, kind, confidence, inputTokens: Number.isInteger(tokens) && tokens >= 0 ? tokens : null };
}
