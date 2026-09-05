// A start that did not come up says what the session printed, not where to
// stand to read it.
//
// REPORTED FROM A BOX:
//
//   Resumed "cc-plucky-gibbon" in /work, but Remote Control did not come online.
//   session exited during startup
//   Reach it on the box with: tmux attach -t cc-plucky-gibbon
//
// Every line true, and the last one is a remedy only a shell can apply — on a
// product whose premise is that a machine can be run without one. It is the
// same shape as an update that says "set this variable" and a channel that
// lives in a root-owned file: the answer is named and the reader cannot reach
// it. `session exited during startup` is the symptom; the container printed the
// cause on its way out, and the host was already holding it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/core/sessions.js', import.meta.url), 'utf8');
const reply = SRC.slice(SRC.indexOf('// WHAT IT PRINTED, not where to go and read it.'), SRC.indexOf('} finally {'));
// COMMENTS STRIPPED, because the comment above this reply QUOTES the message it
// replaced — and an assertion that cannot tell the code from the prose about
// the code would fail on a change that explains itself well.
const code = reply.replace(/^\s*\/\/.*$/gm, '');

test('the failure does not send somebody to a terminal', () => {
  // The message itself. `tmux attach` still appears in this file twice — once
  // in a comment about finishing a login by hand, once in a LOG line, which is
  // read by somebody who is already on the box. Neither is a reply to a phone.
  assert.doesNotMatch(code, /Reach it on the box with/);
  assert.doesNotMatch(code, /tmux attach -t \$\{name\}/);
});

test('it quotes what the session printed', () => {
  // The thing somebody actually wants. Short — this is read on a phone beside
  // two buttons that fetch the rest, and a whole container log there would bury
  // the sentence above it.
  assert.match(code, /#startupOutput\(name\)/);
  assert.match(SRC, /readSessionLogs\(this\.cfg, name, 6\)/);
  assert.match(SRC, /Last output:/);
});

test('the remedy is a button, not a command to copy', () => {
  // Every other dead end in this codebase names a remedy the reader can act on
  // from where they are standing. This one printed a tmux invocation.
  assert.match(code, /buttons: \[/);
  assert.match(code, /command: `\/logs \$\{name\}`/);
  assert.match(code, /command: `\/peek \$\{name\}`/);
});

test('decorating the failure can never replace it', () => {
  // A start that half-worked is already bad news. If reading the log throws —
  // no container, podman gone, a name that stopped being valid — the reply must
  // still arrive, because failing to decorate it would turn bad news into no
  // answer at all.
  const helper = SRC.slice(SRC.indexOf('#startupOutput(name) {'), SRC.indexOf('Make sure this session has a hook socket'));
  assert.match(helper, /try \{/);
  assert.match(helper, /\} catch \{\n\s+return '';/);
  assert.match(helper, /if \(!r\.ok\) return '';/);
});
