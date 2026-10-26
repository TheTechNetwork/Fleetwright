// The Claude Code the fleet installs, and the questions that build still asks.
//
//   node --test test/claude-dialog-pin.test.js
//
// The binary check itself is scripts/claude-dialog-check.mjs, run in CI: it
// downloads the pinned CLI. What is tested here is the decision that script
// makes, and that the two macOS workflows install the same release the check
// reads. A bump of one without the other is the drift.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { dialogProblems } from '../src/fleet/host/claude-dialogs.js';
import { CLAUDE_CODE_VERSION } from '../src/fleet/host/claude-pin.js';
import { readPrompt, answerActions } from '../src/fleet/host/prompt.js';
import { AWAITING_RE } from '../src/fleet/host/watcher.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the macOS workflows install the release the dialog check reads', () => {
  for (const file of ['.github/workflows/mac-host.yml', '.github/workflows/ephemeral-mac.yml']) {
    assert.match(read(file), new RegExp(`@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}\\b`), file);
  }
  assert.match(read('scripts/claude-dialog-check.mjs'), /claude-pin\.js/);
});

/** The sentences `strings` pulled out of Claude Code 2.1.308. */
const PINNED = [
  'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what',
  'Quick safety check: is this a project you created or one you trust? Sessions started here can read, edit, and execute files.',
  'Is this a directory you created or one you trust?',
  'Do you want to proceed?',
  'Resume from summary (instant, recommended)',
  'Resume from summary (recommended)',
  'Resume full session as-is',
  'Yes, I trust this folder',
  'No, exit',
].join('\n');

test('every question the pinned CLI was found to ask is one the fleet reads', () => {
  assert.deepEqual(dialogProblems(PINNED), []);
  const prompt = readPrompt('Is this a directory you created or one you trust?\n1. Yes, I trust this folder\n2. No, exit\n');
  assert.equal(prompt?.kind, 'trust');
  assert.equal(AWAITING_RE.test('Is this a directory you created or one you trust?'), true);
  assert.equal(answerActions(/** @type {any} */ (prompt)).length, 2);
});

test('a trust question the matchers have not met is a failure, not a pass', () => {
  const problems = dialogProblems(`${PINNED}\nIs this a workspace you created or one you trust?`);
  assert.ok(problems.some((p) => /workspace/.test(p)), problems.join('\n'));
});

test('a binary with no questions does not pass', () => {
  const problems = dialogProblems('nothing about a dialog in here');
  assert.ok(problems.some((p) => /no trust question/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /no permission question/.test(p)));
  assert.ok(problems.some((p) => /no resume question/.test(p)));
});
