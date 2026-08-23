// What a session is asking, read out of a pane.
//
// The value of this file is not that it parses — it is that every case here is
// a way the parse could be WRONG in a manner nobody would notice: an option
// offered that must never be offered, a command line reaching a lock screen, an
// id that changes while somebody is reading the question it names.

import test from 'node:test';
import assert from 'node:assert/strict';

import { readPrompt, promptId, describePrompt } from '../src/fleet/host/prompt.js';

const RESUME = `This session is 4 hours old and has 87 messages.

  1. Resume from summary
  2. Resume full session
  3. Don't ask me again`;

const PERMISSION = `Do you want to proceed?

  1. Yes
  2. Yes, and don't ask me again for rm commands
  3. No, tell Claude what to do differently`;

const TRUST = `Do you trust the files in this folder?

/home/eli/work/private-client-repo

  1. Yes, proceed
  2. No, exit`;

test('a resume dialog becomes a question and its choices', () => {
  const p = /** @type {any} */ (readPrompt(RESUME));
  assert.equal(p.kind, 'resume');
  assert.match(p.question, /summary, or in full/);
  assert.deepEqual(p.options.map((/** @type {any} */ o) => o.index), [1, 2]);
});

test('"don\'t ask me again" is never an option we offer', () => {
  // It flips a global preference for every future session. A permanent grant
  // made from a lock screen, with the least context anyone will ever have, is
  // not a decision to put behind one tap — the same call parseResumeDialog
  // already makes in src/core/claude.js.
  for (const pane of [RESUME, PERMISSION]) {
    const p = /** @type {any} */ (readPrompt(pane));
    assert.equal(
      p.options.some((/** @type {any} */ o) => /don'?t ask me again/i.test(o.label)),
      false,
      pane.slice(0, 20),
    );
  }
});

test('the question is ours, never the pane\'s', () => {
  // The trust dialog names a directory and the permission dialog names a
  // command. Neither reaches the question, because prompt.js writes the
  // question from a fixed vocabulary rather than lifting a line out of the
  // terminal.
  const trust = /** @type {any} */ (readPrompt(TRUST));
  assert.equal(trust.question.includes('private-client-repo'), false);
  assert.equal(trust.carriesSessionText, true);

  const resume = /** @type {any} */ (readPrompt(RESUME));
  assert.equal(resume.carriesSessionText, false, 'a resume dialog quotes nothing about the work');
});

test('without the fleet switch, nothing that quotes the session travels', () => {
  const perm = /** @type {any} */ (readPrompt(PERMISSION));
  const shown = describePrompt(perm, false);
  assert.equal(shown.options.length, 0, 'the option naming rm commands does not leave the box');
  assert.equal(shown.question, 'A tool wants permission to run.');

  // And a resume prompt is unaffected either way, which is the point of
  // classifying rather than gating everything.
  const resume = /** @type {any} */ (readPrompt(RESUME));
  assert.equal(describePrompt(resume, false).options.length, 2);
});

test('with the switch on, the choices come through', () => {
  const perm = /** @type {any} */ (readPrompt(PERMISSION));
  assert.equal(describePrompt(perm, true).options.length, 2);
});

test('an unrecognised pane is null, not a guess', () => {
  // Null still means "something is waiting" upstream — the old boolean is
  // still the backstop. What it must never do is invent a question.
  assert.equal(readPrompt('npm install\n added 41 packages'), null);
  assert.equal(readPrompt(''), null);
});

test('the id survives a redraw and changes when the question does', () => {
  const p = /** @type {any} */ (readPrompt(RESUME));
  const withSpinner = /** @type {any} */ (readPrompt(RESUME.replace('87 messages', '88 messages')));
  assert.equal(promptId('cc-otter', p), promptId('cc-otter', withSpinner), 'a redraw must not invalidate it');

  const other = /** @type {any} */ (readPrompt(PERMISSION));
  assert.notEqual(promptId('cc-otter', p), promptId('cc-otter', other));
  assert.notEqual(promptId('cc-otter', p), promptId('cc-badger', p), 'and it is per session');
});

test('a repeated option is scrollback, not a second choice', () => {
  const doubled = `${RESUME}\n\n  1. Resume from summary\n  2. Resume full session`;
  const p = /** @type {any} */ (readPrompt(doubled));
  assert.deepEqual(p.options.map((/** @type {any} */ o) => o.index), [1, 2]);
});

test('a long label is capped rather than carrying a pane through it', () => {
  const long = `Do you want to proceed?\n  1. Yes, run ${'x'.repeat(500)}`;
  const p = /** @type {any} */ (readPrompt(long));
  assert.ok(p.options[0].label.length <= 80);
});
