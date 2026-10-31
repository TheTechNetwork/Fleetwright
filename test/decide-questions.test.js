// The two questions the fleet asks Clef-flash, held as literals
// (src/core/decide-questions.js).
//
// A prompt-byte contract: DECIDE_P_AWAITING was measured against exactly this
// wording by scripts/decide-harness.mjs, so a reworded question is an
// uncalibrated threshold. Changing a word here means re-running the harness,
// and this test changes in the same pull request as the new threshold.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DECIDE_QUESTIONS, DECIDE_P_AWAITING, decideRequest } from '../src/core/decide-questions.js';

test('the questions are the pinned ones, word for word, and the threshold measured against them', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(DECIDE_QUESTIONS)), {
    asked: {
      type: 'noul',
      instructions:
        'This is the bottom of a terminal running a coding assistant. Is it currently stopped, waiting for a person to pick one of several offered options or to confirm before it continues?',
      criteria: {
        true: 'A dialog or prompt with numbered or listed choices, waiting.',
        false:
          "Output still being produced, a finished result, an ordinary shell prompt, or a list that is part of the assistant's own text rather than a question to the person.",
      },
    },
    kind: {
      type: 'choice',
      instructions: 'If it is waiting, what is it asking?',
      criteria: { resume: 'resume', trust: 'trust', permission: 'permission', directory: 'directory', 'api-key': 'api-key', other: 'other' },
    },
  });
  assert.equal(DECIDE_P_AWAITING, 0.8926);
});

test('a request never carries images', () => {
  assert.deepEqual(Object.keys(decideRequest('x')).sort(), ['model', 'questions', 'state']);
});
