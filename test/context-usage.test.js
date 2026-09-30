// How full a session's window is, read off its transcript — by the hub for a
// session on the box, by the hook for one in a sandbox — and carried as a
// number that is never guessed.
//
//   node --test test/context-usage.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  contextFromLines,
  readTailLines,
  contextFromTranscript,
  cleanTranscriptPath,
  ContextReader,
  TAIL_BYTES,
} from '../src/core/context-usage.js';
import { cleanContext } from '../src/core/activity.js';
import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';

const UUID = '11111111-2222-3333-4444-555555555555';

/** An assistant entry the shape Claude Code writes, with the usage that matters. */
function assistant(usage, extra = {}) {
  return JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5-1', usage, content: [] }, ...extra });
}

/** @param {import('node:test').TestContext} t @param {string[]} lines */
function transcript(t, lines) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${UUID}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// --- the parser ---------------------------------------------------------------

test('the last assistant turn decides, and the three input counts are what was in the window', () => {
  const ctx = contextFromLines([
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    assistant({ input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 9 }),
    JSON.stringify({ type: 'user', message: { content: 'more' } }),
    assistant({ input_tokens: 32, cache_creation_input_tokens: 16284, cache_read_input_tokens: 232401, output_tokens: 3693 }),
  ]);
  assert.deepEqual(ctx, { tokens: 32 + 16284 + 232401, model: 'claude-fable-5-1' });
});

test('output tokens are not context — they are what came out of it', () => {
  const ctx = contextFromLines([assistant({ input_tokens: 100, output_tokens: 5000 })]);
  assert.equal(ctx?.tokens, 100);
});

test('a subagent turn has a window of its own and is skipped', () => {
  const ctx = contextFromLines([
    assistant({ input_tokens: 500 }),
    assistant({ input_tokens: 7 }, { isSidechain: true }),
  ]);
  assert.equal(ctx?.tokens, 500);
});

test('a malformed line, a turn with no usage, and a non-number are skipped, not read', () => {
  const ctx = contextFromLines([
    assistant({ input_tokens: 500 }),
    '{"type":"assistant","message":{"usage":{"input_tokens":"lots"}}}',
    '{"type":"assistant","message":{}}',
    '{not json "assistant"',
  ]);
  assert.equal(ctx?.tokens, 500);
});

test('a transcript with no assistant turn yet is null — cannot tell, not zero', () => {
  assert.equal(contextFromLines([JSON.stringify({ type: 'user', message: { content: 'hi' } })]), null);
  assert.equal(contextFromLines([]), null);
});

test('the model name is bounded, and absent when the transcript has none', () => {
  const long = 'm'.repeat(200);
  const ctx = contextFromLines([JSON.stringify({ type: 'assistant', message: { model: long, usage: { input_tokens: 1 } } })]);
  assert.equal(ctx?.model?.length, 64);
  assert.equal(contextFromLines([JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 1 } } })])?.model, null);
});

// --- the tail ---------------------------------------------------------------------

test('only the tail of a large transcript is read, and the partial first line is dropped', (t) => {
  // A tool result before the last turn can be a megabyte on its own. The
  // answer is at the end, and reading the whole file per event would tax
  // every turn of every session.
  const file = transcript(t, [assistant({ input_tokens: 1 })]);
  appendFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(TAIL_BYTES * 2) } })}\n`);
  appendFileSync(file, `${assistant({ input_tokens: 4242 })}\n`);

  const lines = readTailLines(file);
  assert.ok(lines && lines.length >= 2);
  assert.ok(lines.join('\n').length <= TAIL_BYTES, 'bounded');
  assert.equal(contextFromTranscript(file)?.tokens, 4242);
});

test('a missing transcript is null, never a throw — the hook must not block a turn', () => {
  assert.equal(readTailLines('/nowhere/at/all.jsonl'), null);
  assert.equal(contextFromTranscript('/nowhere/at/all.jsonl'), null);
  assert.equal(contextFromTranscript(null), null);
});

// --- the reader's cache --------------------------------------------------------

test('the reader re-reads only when the file has moved', () => {
  let reads = 0;
  const stat = { size: 10, mtimeMs: 1 };
  const reader = new ContextReader({ stat: () => ({ ...stat }), read: () => ({ tokens: ++reads, model: null }) });

  assert.equal(reader.for('/t.jsonl')?.tokens, 1);
  assert.equal(reader.for('/t.jsonl')?.tokens, 1, 'same size and mtime: the cached answer');
  stat.size = 11;
  assert.equal(reader.for('/t.jsonl')?.tokens, 2, 'the file grew: read again');
  stat.mtimeMs = 2;
  assert.equal(reader.for('/t.jsonl')?.tokens, 3, 'the file was touched: read again');
  reader.forget('/t.jsonl');
  assert.equal(reader.for('/t.jsonl')?.tokens, 4);
});

test('a file the reader cannot stat is null and drops out of the cache', () => {
  let ok = true;
  const reader = new ContextReader({ stat: () => { if (!ok) throw new Error('ENOENT'); return { size: 1, mtimeMs: 1 }; }, read: () => ({ tokens: 9, model: null }) });
  assert.equal(reader.for('/t.jsonl')?.tokens, 9);
  ok = false;
  assert.equal(reader.for('/t.jsonl'), null);
  assert.equal(reader.cache.size, 0);
  assert.equal(reader.for(null), null);
});

// --- what the hub will record ------------------------------------------------------

test('a transcript path is kept only when it is the shape Claude Code writes', () => {
  assert.equal(cleanTranscriptPath(`/home/agent/.claude/projects/-work/${UUID}.jsonl`), `/home/agent/.claude/projects/-work/${UUID}.jsonl`);
  assert.equal(cleanTranscriptPath(`relative/${UUID}.jsonl`), null, 'absolute only');
  assert.equal(cleanTranscriptPath('/etc/passwd'), null, 'a <uuid>.jsonl only');
  assert.equal(cleanTranscriptPath(`/a/../b/${UUID}.jsonl`), null);
  assert.equal(cleanTranscriptPath(42), null);
  assert.equal(cleanTranscriptPath(null), null);
});

test('the context a hook posts is bounded to a count and a model name', () => {
  assert.deepEqual(cleanContext({ tokens: 1200, model: 'claude-fable-5-1' }), { tokens: 1200, model: 'claude-fable-5-1' });
  assert.deepEqual(cleanContext({ tokens: 0 }), { tokens: 0, model: null });
  assert.equal(cleanContext({ tokens: -1 }), null);
  assert.equal(cleanContext({ tokens: 1.5 }), null);
  assert.equal(cleanContext({ tokens: '1200' }), null);
  assert.equal(cleanContext({ tokens: 2e9 }), null, 'bigger than any window there is');
  assert.equal(cleanContext(null), null);
  assert.equal(cleanContext([1]), null);
  assert.equal(cleanContext({ tokens: 5, model: 'a\nb' })?.model, 'a', 'one line');
});

// --- the session manager ----------------------------------------------------------

/** @param {import('node:test').TestContext} t */
function manager(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ctx-sm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({ stateDir: dir, profileDir: path.join(dir, 'profiles'), workdir: dir, stateFile: path.join(dir, 'state.json'), spoolFile: path.join(dir, 'spool') });
  const registry = new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile });
  const sm = new SessionManager(cfg, registry, null);
  // tmux is not the question here.
  sm.reconcile = () => {};
  return { sm, registry };
}

test('a session on the box: the hook names the transcript and the hub reads the window off it', (t) => {
  const { sm, registry } = manager(t);
  const file = transcript(t, [assistant({ input_tokens: 100, cache_read_input_tokens: 900 })]);
  registry.upsert('local', { status: 'running', cwd: '/w' });

  const r = sm.recordUuid({ name: 'local', uuid: UUID, transcriptPath: file });
  assert.equal(r.ok, true);
  registry.upsert('local', { status: 'running' });

  assert.equal(sm.list().find((s) => s.name === 'local')?.context?.tokens, 1000);

  // The transcript grows; the next ask sees it.
  appendFileSync(file, `${assistant({ input_tokens: 100, cache_read_input_tokens: 4900 })}\n`);
  const later = Date.now() + 5000;
  utimesSync(file, later / 1000, later / 1000);
  assert.equal(sm.list().find((s) => s.name === 'local')?.context?.tokens, 5000);
});

test('a sandboxed session: the hook carries the context, and it survives an event that says nothing about it', (t) => {
  const { sm, registry } = manager(t);
  registry.upsert('boxed', { status: 'running', cwd: '/work' });
  // Its SessionStart names no transcript this box can read.
  sm.recordUuid({ name: 'boxed', uuid: UUID });
  registry.upsert('boxed', { status: 'running' });

  sm.recordEvent({ name: 'boxed', event: 'Stop', context: { tokens: 42_000, model: 'claude-fable-5-1' } });
  assert.equal(sm.list().find((s) => s.name === 'boxed')?.context?.tokens, 42_000);

  sm.recordEvent({ name: 'boxed', event: 'Notification', detail: 'idle_prompt' });
  assert.equal(sm.list().find((s) => s.name === 'boxed')?.context?.tokens, 42_000, 'kept from the last event that carried one');

  // A notification this host does not read still updates the number if it carries one.
  sm.recordEvent({ name: 'boxed', event: 'Notification', detail: 'agent_completed', context: { tokens: 43_000, model: null } });
  assert.equal(sm.list().find((s) => s.name === 'boxed')?.context?.tokens, 43_000);

  sm.recordEvent({ name: 'boxed', event: 'PostToolUse', detail: 'Bash', context: { tokens: 50_000, model: null } });
  assert.equal(sm.activity.get('boxed')?.context?.tokens, 50_000);
});

test('a session that is not running has no context, whatever was recorded', (t) => {
  const { sm, registry } = manager(t);
  const file = transcript(t, [assistant({ input_tokens: 100 })]);
  registry.upsert('done', { status: 'stopped', cwd: '/w' });
  sm.recordUuid({ name: 'done', uuid: UUID, transcriptPath: file });
  assert.equal(sm.list().find((s) => s.name === 'done')?.context, null);
});

test('a SessionStart that names no transcript clears the one from the session\'s other life', (t) => {
  const { sm, registry } = manager(t);
  const file = transcript(t, [assistant({ input_tokens: 100 })]);
  registry.upsert('mover', { status: 'running', cwd: '/w' });
  sm.recordUuid({ name: 'mover', uuid: UUID, transcriptPath: file });
  assert.equal(registry.get('mover')?.transcriptPath, file);
  sm.recordUuid({ name: 'mover', uuid: UUID });
  assert.equal(registry.get('mover')?.transcriptPath, null);
  sm.recordUuid({ name: 'mover', uuid: UUID, transcriptPath: '/etc/passwd' });
  assert.equal(registry.get('mover')?.transcriptPath, null, 'not a transcript');
});

// --- the two implementations must agree ------------------------------------------

test('the in-container hook reads the same context as core does', (t) => {
  // sandbox/hook.mjs cannot import from src/ — it is copied into the image on
  // its own — so the parser is duplicated there. Running both over one fixture
  // is what stops the copies drifting, exactly as test/titles.test.js does for
  // the title.
  const file = transcript(t, [
    assistant({ input_tokens: 10, cache_read_input_tokens: 5 }),
    assistant({ input_tokens: 3 }, { isSidechain: true }),
    '{"type":"assistant","message":{"usage":{"input_tokens":"nope"}}}',
    assistant({ input_tokens: 32, cache_creation_input_tokens: 16284, cache_read_input_tokens: 232401 }),
  ]);

  const inContainer = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
       import { readFileSync } from 'node:fs';
       const src = readFileSync('sandbox/hook.mjs', 'utf8');
       const body = src.slice(src.indexOf('function contextFromLines'));
       const fns = body.slice(0, body.indexOf('\\nfunction readStdin'));
       const make = new Function('openSync', 'readSync', 'closeSync', 'fstatSync', 'Buffer', fns + '; return (f) => contextFromLines(readTailLines(f) ?? []);');
       process.stdout.write(JSON.stringify(make(openSync, readSync, closeSync, fstatSync, Buffer)(process.argv[1])));`,
      file,
    ],
    { encoding: 'utf8', cwd: process.cwd() },
  );

  assert.equal(inContainer.status, 0, inContainer.stderr);
  const expected = contextFromTranscript(file);
  assert.deepEqual(JSON.parse(inContainer.stdout), expected);
  assert.equal(expected?.tokens, 32 + 16284 + 232401);
});
