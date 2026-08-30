// The matchers, against panes an actual Claude Code drew.
//
//   node --test test/
//
// EVERY OTHER TEST OF THIS CODE USES A PANE SOMEBODY INVENTED, which is how
// both of the bugs below shipped: the fixtures agreed with the regexes because
// the same person wrote both, from the same wrong idea of what the screen says.
//
// These three files are captures from tmux against Claude Code 2.1.234, with
// paths and the account scrubbed and nothing else touched. They are a snapshot
// of somebody else's TUI and will go stale — that is the point. When they do,
// this test fails and somebody captures new ones, instead of the fleet quietly
// misclassifying every session on it.
//
// HOW TO REFRESH THEM:
//   tmux new-session -d -s cap -x 120 -y 40 'cd /some/dir; claude'
//   tmux capture-pane -p -t cap > ready.txt          # at the input prompt
//   ...send a prompt that runs a long bash call...
//   tmux capture-pane -p -t cap > working.txt        # mid tool call
//   the trust one is whatever the first-run folder dialog says today

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readPrompt } from '../src/fleet/host/prompt.js';
// EXPORTED SO THIS TEST BINDS TO THE REAL ONES. Re-declaring them here, or
// scraping them out of the source, would let the matchers drift from the thing
// asserting they work — which is the failure this whole file exists about.
import { AWAITING_RE, DRAWING_RE, READY_RE } from '../src/fleet/host/watcher.js';

const pane = (/** @type {string} */ name) =>
  readFileSync(new URL(`./fixtures/claude-2.1.234-${name}.txt`, import.meta.url), 'utf8');

const READY = pane('ready');
const WORKING = pane('working');
const TRUST = pane('trust');

test('a working session is not mistaken for a resting one', () => {
  // THE BUG THESE CAPTURES FOUND. The first version keyed on the permission
  // mode name, on the stated premise that the mode line is drawn only when the
  // CLI is ready for input. It is drawn in both states; only the parenthetical
  // changes:
  //
  //   ready    ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
  //   working  ⏵⏵ auto mode on · 1 shell · ← for agents · ↓ to manage
  //
  // So in `bypass permissions` — what this fleet runs by default — a session
  // mid-tool-call matched "at rest": never restarted however wedged, and shown
  // in the apps as "ready · idle" while it was actively working.
  assert.equal(READY_RE.test(READY), true, 'a session at its prompt is ready');
  assert.equal(READY_RE.test(WORKING), false, 'a session running a tool is NOT ready');

  // And the property that made the old version wrong, asserted directly: the
  // mode name is present in both, so it discriminates nothing.
  assert.match(READY, /mode on/);
  assert.match(WORKING, /mode on/);
});

test('both a working and a resting session count as "the CLI is drawing"', () => {
  // The restart gate asks a different question — "is this wedged" — and
  // working, waiting and finished are all "no". One boolean could not answer
  // both questions, and the version that tried got one of them wrong.
  assert.equal(DRAWING_RE.test(READY), true);
  assert.equal(DRAWING_RE.test(WORKING), true);
});

test('the trust dialog is recognised, and it was not', () => {
  // Captured wording: "Quick safety check: Is this a project you created or
  // one you trust?" The matcher looked for "Do you trust the files", which no
  // longer appears — so a dialog that BLOCKS A SESSION until somebody answers
  // was invisible: no notification, no options in the app, and a pane carrying
  // none of the CLI's chrome, which made it a restart candidate. Stopped and
  // resumed straight back onto the same question.
  assert.equal(AWAITING_RE.test(TRUST), true, 'nobody would have been told');
  assert.equal(DRAWING_RE.test(TRUST), false, 'and it has no chrome, so it looked wedged');

  const prompt = readPrompt(TRUST);
  assert.ok(prompt, 'and it could not be answered from the app');
  assert.equal(prompt?.kind, 'trust');
  assert.deepEqual(prompt?.options.map((o) => o.index), [1, 2]);
});

test('the fixtures are the real thing, not a paraphrase of it', () => {
  // A guard against somebody "fixing" a failing test by editing the capture.
  // These strings are Claude Code's, not ours: if they stop appearing, the CLI
  // changed and the matchers need looking at — which is the entire job of this
  // file.
  assert.match(READY, /⏵⏵/, 'the mode marker');
  assert.match(READY, /shift\+tab to cycle/);
  assert.match(WORKING, /Bash\(/, 'a real tool call');
  assert.match(TRUST, /Quick safety check/);
});
