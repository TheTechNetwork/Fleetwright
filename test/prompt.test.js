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

// --- the collision the id was supposed to prevent ---------------------------
//
// SEC-PROTO-4. `promptId` hashed kind + option labels, which is the dialog's
// SHAPE — and two permission asks have the same shape. So `rm -rf build` and
// `git push` produced the same id, and the guard that refuses an answer aimed
// at a question that has since been replaced passed happily when the
// replacement was another permission ask. That is the common case in agent
// work, and the one where answering the wrong question costs something.

const RM = `Do you want to proceed?

  bash: rm -rf build

  1. Yes
  2. No, tell Claude what to do differently`;

const PUSH = `Do you want to proceed?

  bash: git push --force origin main

  1. Yes
  2. No, tell Claude what to do differently`;

test('two permission asks with different commands get different ids', () => {
  const a = /** @type {any} */ (readPrompt(RM));
  const b = /** @type {any} */ (readPrompt(PUSH));

  // Same shape in every respect the old id looked at.
  assert.equal(a.kind, b.kind);
  assert.deepEqual(a.options, b.options);
  assert.equal(a.question, b.question);

  assert.notEqual(
    promptId('cc-otter', a),
    promptId('cc-otter', b),
    'a late tap approving rm -rf would have been accepted against git push',
  );
});

test('the command never leaves the box — only a hash of it does', () => {
  // The body is what makes the id discriminate, and it is exactly the text the
  // carriesSessionText rule exists to keep on the machine. describePrompt
  // returns an explicit {question, options}, so `subject` cannot travel by
  // accident; this asserts that rather than trusting it.
  const p = /** @type {any} */ (readPrompt(RM));
  assert.match(p.subject, /rm -rf build/, 'the id has something to discriminate on');

  const shown = describePrompt(p, true);
  assert.equal(JSON.stringify(shown).includes('rm -rf'), false, 'the command reached the wire');
  assert.equal(promptId('cc-otter', p).length, 8, 'and what does travel is a short hash');
});

test('a permission dialog still survives its own redraw', () => {
  // The property the original design was protecting, which the fix must not
  // spend: a spinner, a token counter or a clock redrawing BELOW the options
  // must not invalidate a question somebody is halfway through reading.
  const p = /** @type {any} */ (readPrompt(RM));
  const redrawn = /** @type {any} */ (readPrompt(`${RM}\n\n  ⏳ 12.4k tokens · 38s`));

  assert.equal(promptId('cc-otter', p), promptId('cc-otter', redrawn));
});

test('two trust asks for two directories are two questions', () => {
  const a = /** @type {any} */ (readPrompt('Do you trust the files in this folder?\n\n/home/eli/work/a\n\n  1. Yes\n  2. No'));
  const b = /** @type {any} */ (readPrompt('Do you trust the files in this folder?\n\n/home/eli/work/b\n\n  1. Yes\n  2. No'));

  assert.notEqual(promptId('cc-otter', a), promptId('cc-otter', b));
});

test('a resume dialog is deliberately NOT discriminated', () => {
  // Which kinds need it is a property of the kind. A resume dialog is unique
  // per session — there is one, and it is not replaced by a different resume
  // dialog meaning something else — and its body carries a live message
  // counter, so folding the body in would buy nothing and churn the id while
  // somebody reads it.
  const p = /** @type {any} */ (readPrompt(RESUME));
  assert.equal(p.subject, '');
});
