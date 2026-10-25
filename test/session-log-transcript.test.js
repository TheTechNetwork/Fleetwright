// `read_log` on a session that runs directly on the box — a Mac, a runner —
// reads the conversation from Claude Code's transcript.
//
// The pane there is Claude Code's screen, redrawn in place, so its scrollback
// is the last screenful. On a macOS runner that was all `read_log` gave back:
// the bottom of a report with its top cut off, and the rest took three more
// sessions asked to repeat it shorter. These pin that the whole conversation
// comes back, in order, and that the live screen still rides under it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSessionLogs } from '../src/core/logs.js';

/** A fake tmux, as returning-user.test.js has: a real binary on PATH. */
function box(t, { paneShows = '', paneExists = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'transcript-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, 'tmux'),
    `#!/bin/sh\ncase "$1" in\n  has-session) exit ${paneExists ? 0 : 1} ;;\n  capture-pane) printf '%s' ${JSON.stringify(paneShows)} ; exit 0 ;;\n  *) exit 0 ;;\nesac\n`,
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  t.after(() => { process.env.PATH = before; });
  return { dir, cfg: /** @type {any} */ ({ sandbox: false, stateDir: dir }) };
}

/** @param {string} dir @param {object[]} rows */
function transcript(dir, rows) {
  const file = path.join(dir, 'conv.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const REPORT = Array.from({ length: 60 }, (_, i) => `line ${i + 1} of the report`).join('\n');

test('a direct session’s whole report comes back from its transcript, top included, with the screen under it', (t) => {
  const { dir, cfg } = box(t, { paneShows: '…last screenful only…\n❯ ' });
  const file = transcript(dir, [
    { type: 'user', message: { content: 'Build DuoNotes and report.' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Starting with the environment.' }, { type: 'tool_use', name: 'Bash', input: { command: 'xcodebuild -version\nmore' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'Xcode 27.2 — a tool result, not something a person said' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'a subagent talking to itself' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: REPORT }] } },
  ]);

  const r = readSessionLogs(cfg, 'cc-eager-kestrel', 200, { transcriptPath: file });
  assert.equal(r.ok, true);
  assert.match(r.text, /^Conversation of cc-eager-kestrel, from its transcript:/);
  assert.match(r.text, /❯ Build DuoNotes and report\./);
  assert.match(r.text, /⎿ Bash: xcodebuild -version$/m);
  assert.match(r.text, /line 1 of the report/, 'the top of the report is there, which the pane had lost');
  assert.match(r.text, /line 60 of the report/);
  assert.doesNotMatch(r.text, /a tool result, not something a person said/);
  assert.doesNotMatch(r.text, /subagent talking to itself/);
  assert.match(r.text, /On its screen now:\n…last screenful only…/);
});

test('the line count is kept from the end', (t) => {
  const { dir, cfg } = box(t, { paneExists: false });
  const file = transcript(dir, [{ type: 'assistant', message: { content: [{ type: 'text', text: REPORT }] } }]);
  const r = readSessionLogs(cfg, 'cc-one', 5, { transcriptPath: file });
  assert.match(r.text, /line 60 of the report/);
  assert.doesNotMatch(r.text, /line 55 of the report/);
  assert.doesNotMatch(r.text, /On its screen now/, 'no pane, no claim of one');
});

test('a transcript with nothing said yet falls back to the pane, as before', (t) => {
  const { dir, cfg } = box(t, { paneShows: 'starting…' });
  const file = transcript(dir, [{ type: 'user', isMeta: true, message: { content: 'hook output' } }]);
  const r = readSessionLogs(cfg, 'cc-one', 60, { transcriptPath: file });
  assert.equal(r.text, 'Pane for cc-one:\nstarting…');
});
