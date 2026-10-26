// Questions the pinned Claude Code binary still asks, against the matchers.
//
// The captures in test/fixtures are a CLI that has already moved on once.
// This reads the strings of the release the fleet installs and says which of
// them the matchers do not know. A reworded trust question, a permission
// question, or a resume question fails here, which is the failure to have:
// the alternative is every session on that release being invisible to the
// watcher until somebody happens to look.

import { answerActions, readPrompt } from './prompt.js';
import { AWAITING_RE } from './watcher.js';

/**
 * One family of question, as a contiguous string in the CLI binary.
 *
 * @type {{ kind: 'trust'|'permission'|'resume', source: string }[]}
 */
const FAMILIES = [
  { kind: 'trust', source: 'Is this a [A-Za-z]+ you created or one you trust\\??' },
  { kind: 'trust', source: 'Quick safety check: [^"\\\\\\n]{10,240}' },
  { kind: 'permission', source: 'Do you want to proceed\\?' },
  { kind: 'resume', source: 'Resume from summary[^"\\\\\\n]{0,80}' },
  { kind: 'resume', source: 'Resume full session[^"\\\\\\n]{0,60}' },
];

/**
 * What the pinned CLI says that this fleet would miss.
 *
 * An empty list is "every question we know how to look for is one the
 * matchers recognise, and each kind was actually present". A binary that has
 * been stripped of its strings fails closed: no question found is not a pass.
 *
 * @param {string} blob  `strings` of the Claude Code binary
 * @returns {string[]}
 */
export function dialogProblems(blob) {
  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, number>} */
  const found = { trust: 0, permission: 0, resume: 0 };
  /** @type {string[]} */
  const trustQuestions = [];

  for (const family of FAMILIES) {
    const seen = new Set();
    for (const match of blob.matchAll(new RegExp(family.source, 'g'))) {
      const text = match[0];
      if (seen.has(text)) continue;
      seen.add(text);
      found[family.kind] += 1;
      if (family.kind === 'trust' && /^Is this a /.test(text)) trustQuestions.push(text);
      const prompt = readPrompt(text);
      if (!prompt || prompt.kind !== family.kind) {
        problems.push(`The pinned CLI says “${text}”, and the fleet does not read it as ${family.kind}.`);
        continue;
      }
      if (family.kind === 'trust' && !AWAITING_RE.test(text)) {
        problems.push(`The pinned CLI says “${text}”, and a waiting session would not be noticed.`);
      }
    }
  }

  for (const kind of ['trust', 'permission', 'resume']) {
    if (!found[kind]) problems.push(`The pinned CLI contained no ${kind} question. A strings check that finds nothing is not a pass.`);
  }

  const yes = blob.includes('Yes, I trust this folder');
  const no = blob.includes('No, exit');
  if (!yes || !no) {
    problems.push('The pinned CLI no longer offers “Yes, I trust this folder” and “No, exit”.');
  } else if (trustQuestions[0]) {
    const prompt = readPrompt(`${trustQuestions[0]}\n1. Yes, I trust this folder\n2. No, exit\n`);
    if (!prompt || answerActions(prompt).length < 2) {
      problems.push(`The pinned CLI’s “${trustQuestions[0]}” cannot be answered from the app.`);
    }
  }

  return problems;
}
