// What a session cost, read off the `cost-state` line Claude Code writes into
// its own transcript — by the hub for a session on the box, by the hook for
// one in a sandbox — and never added up, priced or guessed here.
//
//   node --test test/spent.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { spentFromEntry, readSpent, SpentReader } from '../src/core/spent.js';
import { cleanSpent } from '../src/core/activity.js';
import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';
import { dispatch } from '../src/adapters/commands.js';

const UUID = '11111111-2222-3333-4444-555555555555';

/**
 * A cost-state line in the shape CLI 2.1.292 writes, trimmed to the fields
 * that matter and with one model per call.
 * @param {number} usd @param {Record<string, any>} [extra]
 */
function costState(usd, extra = {}) {
  return JSON.stringify({
    type: 'cost-state',
    sessionId: UUID,
    totalCostUSD: usd,
    totalDuration: 60_000,
    startTime: 1_790_000_000_000,
    modelUsage: {
      'a-model': { inputTokens: 2, outputTokens: 84, cacheReadInputTokens: 27_047, cacheCreationInputTokens: 22_716, costUSD: usd },
    },
    hasUnknownModelCost: false,
    ...extra,
  });
}

/** An assistant turn, which carries usage of its own that must NOT be summed. */
const assistant = JSON.stringify({ type: 'assistant', message: { id: 'msg_1', usage: { input_tokens: 9, output_tokens: 999_999 } } });

/** @param {import('node:test').TestContext} t @param {string[]} lines */
function transcript(t, lines) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${UUID}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// --- the figure ---------------------------------------------------------------

test('the figure is Claude Code\'s own, summed across models and nothing else', () => {
  const s = spentFromEntry(JSON.parse(costState(0.4653, {
    modelUsage: {
      a: { inputTokens: 2, outputTokens: 84, cacheReadInputTokens: 100, cacheCreationInputTokens: 10 },
      b: { inputTokens: 3, outputTokens: 16, cacheReadInputTokens: 900, cacheCreationInputTokens: 90 },
    },
  })));
  assert.deepEqual(s, {
    usd: 0.4653,
    complete: true,
    inputTokens: 5,
    outputTokens: 100,
    cacheReadTokens: 1000,
    cacheWriteTokens: 100,
    asOf: 1_790_000_060_000,
  });
});

test('a price Claude Code did not know makes the figure a floor, and a missing flag is not a yes', () => {
  assert.equal(spentFromEntry(JSON.parse(costState(3, { hasUnknownModelCost: true })))?.complete, false);
  const noFlag = JSON.parse(costState(3));
  delete noFlag.hasUnknownModelCost;
  assert.equal(spentFromEntry(noFlag)?.complete, false);
});

test('anything that is not a cost-state, or says nothing this reads, is null — cannot tell, not zero', () => {
  assert.equal(spentFromEntry(JSON.parse(assistant)), null);
  assert.equal(spentFromEntry({ type: 'cost-state' }), null);
  assert.equal(spentFromEntry({ type: 'cost-state', totalCostUSD: 'lots', modelUsage: { a: { outputTokens: -1 } } }), null);
  assert.equal(spentFromEntry(null), null);
  // Dollars without tokens, and tokens without dollars, are each still a fact.
  assert.equal(spentFromEntry({ type: 'cost-state', totalCostUSD: 2 })?.outputTokens, null);
  assert.equal(spentFromEntry({ type: 'cost-state', modelUsage: { a: { outputTokens: 7 } } })?.usd, null);
});

// --- finding it ------------------------------------------------------------------

test('the newest figure wins, however far back it is, and per-turn usage is never summed', (t) => {
  // The lines are irregular: on a real transcript the last one was 2.4 MB from
  // the end. A tail read the size context-usage.js uses would miss it.
  const file = transcript(t, [costState(1), assistant, costState(2.5), assistant]);
  appendFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(3 * 1024 * 1024) } })}\n${assistant}\n`);
  const r = readSpent(file);
  assert.equal(r?.value?.usd, 2.5);
  assert.equal(r?.value?.outputTokens, 84, 'the figure, not 84 plus every assistant turn');
});

test('a later read looks only at what was written since, and keeps the earlier figure when nothing is new', (t) => {
  const file = transcript(t, [costState(1)]);
  const first = readSpent(file);
  assert.equal(first?.value?.usd, 1);
  appendFileSync(file, `${assistant}\n`);
  const second = readSpent(file, first?.through);
  assert.equal(second?.value, null, 'nothing new between the floor and the end');
  assert.ok(Number(second?.through) > Number(first?.through));
  appendFileSync(file, `${costState(4)}\n`);
  assert.equal(readSpent(file, second?.through)?.value?.usd, 4);
});

test('a line still being written is read again next time rather than skipped', (t) => {
  const file = transcript(t, [assistant]);
  const half = costState(9).slice(0, 40);
  appendFileSync(file, half);
  const r = readSpent(file);
  assert.equal(r?.value, null);
  appendFileSync(file, `${costState(9).slice(40)}\n`);
  assert.equal(readSpent(file, r?.through)?.value?.usd, 9);
});

test('a figure further back than the scan is cannot-tell, not a scan of the whole file', (t) => {
  const file = transcript(t, [costState(1), JSON.stringify({ type: 'user', message: { content: 'x'.repeat(4096) } })]);
  assert.equal(readSpent(file, 0, 1024)?.value, null);
  assert.equal(readSpent(file, 0)?.value?.usd, 1);
});

test('a transcript that cannot be read is null, never a throw — the hook must not block a turn', () => {
  assert.equal(readSpent('/nowhere/at/all.jsonl'), null);
  assert.equal(readSpent(null), null);
});

test('the reader remembers what it found while the file grows without a new figure', (t) => {
  const file = transcript(t, [costState(1)]);
  const reader = new SpentReader();
  assert.equal(reader.for(file)?.usd, 1);
  appendFileSync(file, `${assistant}\n`);
  const later = Date.now() + 5000;
  utimesSync(file, later / 1000, later / 1000);
  assert.equal(reader.for(file)?.usd, 1, 'kept, because nothing newer was written');
  appendFileSync(file, `${costState(2)}\n`);
  utimesSync(file, (later + 5000) / 1000, (later + 5000) / 1000);
  assert.equal(reader.for(file)?.usd, 2);
  assert.equal(reader.for(null), null);
});

// --- what the hub will record ------------------------------------------------------

test('the figure a hook posts is bounded to numbers a screen can draw', () => {
  const good = { usd: 1.5, complete: true, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, asOf: 5 };
  assert.deepEqual(cleanSpent(good), good);
  assert.deepEqual(cleanSpent({ usd: null, complete: false, outputTokens: 2 }), {
    usd: null, complete: false, inputTokens: null, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null, asOf: null,
  });
  assert.equal(cleanSpent({ usd: -1 })?.usd ?? null, null);
  assert.equal(cleanSpent({ usd: '12' }), null, 'nothing a screen could draw');
  assert.equal(cleanSpent({ outputTokens: 1.5 }), null);
  assert.equal(cleanSpent({ usd: 1, complete: 'yes' })?.complete, false, 'only true is true');
  assert.equal(cleanSpent(null), null);
  assert.equal(cleanSpent([1]), null);
});

// --- the session manager ----------------------------------------------------------

/** @param {import('node:test').TestContext} t */
function manager(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'spent-sm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({ stateDir: dir, profileDir: path.join(dir, 'profiles'), workdir: dir, stateFile: path.join(dir, 'state.json'), spoolFile: path.join(dir, 'spool') });
  const registry = new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile });
  const sm = new SessionManager(cfg, registry, null);
  sm.reconcile = () => {};
  return { sm, registry, cfg };
}

test('a session on the box: the hub reads the figure off the transcript the hook named', (t) => {
  const { sm, registry } = manager(t);
  const file = transcript(t, [costState(0.75)]);
  registry.upsert('local', { status: 'running', cwd: '/w' });
  sm.recordUuid({ name: 'local', uuid: UUID, transcriptPath: file });
  registry.upsert('local', { status: 'running' });
  assert.equal(sm.list().find((s) => s.name === 'local')?.spent?.usd, 0.75);
  // What it cost is still true once it has stopped.
  registry.upsert('local', { status: 'stopped' });
  assert.equal(sm.list().find((s) => s.name === 'local')?.spent?.usd, 0.75);
});

test('a sandboxed session: the figure a hook carried outlives the hub that heard it', (t) => {
  const { sm, registry, cfg } = manager(t);
  registry.upsert('boxed', { status: 'running', cwd: '/work' });
  const spent = cleanSpent({ usd: 3.2, complete: true, outputTokens: 4000, asOf: 10 });
  sm.recordEvent({ name: 'boxed', event: 'Stop', spent });
  sm.recordEvent({ name: 'boxed', event: 'Notification', detail: 'idle_prompt' });
  assert.equal(sm.list().find((s) => s.name === 'boxed')?.spent?.usd, 3.2, 'an event that carries none does not erase it');

  // Stopped, and the hub restarted: the container is gone and so is its
  // transcript's only reader, and the cost is still the cost.
  registry.upsert('boxed', { status: 'stopped' });
  const again = new SessionManager(cfg, new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile }), null);
  again.reconcile = () => {};
  assert.equal(again.list().find((s) => s.name === 'boxed')?.spent?.usd, 3.2);
});

test('nothing reported is null, not a session that cost nothing', (t) => {
  const { sm, registry } = manager(t);
  registry.upsert('quiet', { status: 'running', cwd: '/w' });
  assert.equal(sm.list().find((s) => s.name === 'quiet')?.spent, null);
});

test('/status says what it cost and how the run spent its time, and says so when it cannot', async (t) => {
  // The reply fleet_status, fleet_await and a Telegram chat all read. It
  // answered with the bare record, which knows neither.
  const { sm, registry, cfg } = manager(t);
  registry.upsert('boxed', { status: 'running', cwd: '/work', skipPermissions: null });
  const ctx = /** @type {any} */ ({ sessions: sm, cfg: { ...cfg, skipPermissions: false } });

  const before = await dispatch(ctx, '/status boxed');
  assert.match(before.text, /time: not reported by this session/);
  assert.match(before.text, /cost: not reported by Claude Code yet/);

  const now = Date.now();
  sm.recordEvent({ name: 'boxed', event: 'UserPromptSubmit', at: now - 50 * 60_000 });
  sm.recordEvent({ name: 'boxed', event: 'PermissionRequest', detail: 'Bash', at: now - 20 * 60_000 });
  sm.recordEvent({ name: 'boxed', event: 'Stop', at: now - 20 * 60_000, spent: cleanSpent({ usd: 12.4, complete: false, outputTokens: 48_211, asOf: now }) });

  const after = await dispatch(ctx, '/status boxed');
  assert.match(after.text, /time: working 30m, at its prompt 20m \(counted since 50m ago\)/);
  assert.match(after.text, /cost: at least \$12\.40 at API prices, 48,211 tokens out, as Claude Code counted it just now/);
  assert.equal(after.sessions[0].spent.usd, 12.4, 'and the figure itself, for a screen');
});

// --- the two implementations must agree ------------------------------------------

test('the in-container hook finds the same figure as core does, and carries it between hooks', (t) => {
  // sandbox/hook.mjs cannot import from src/ — it is copied into the image on
  // its own — so the reader is duplicated there. Running both over one file
  // is what stops the copies drifting, as test/context-usage.test.js does for
  // the window.
  const file = transcript(t, [costState(1), assistant, costState(6.25, { hasUnknownModelCost: true }), assistant]);
  const memo = mkdtempSync(path.join(os.tmpdir(), 'spent-memo-'));
  t.after(() => rmSync(memo, { recursive: true, force: true }));

  const run = () => spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { openSync, readSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
       const src = readFileSync('sandbox/hook.mjs', 'utf8');
       const body = src.slice(src.indexOf('function spentNow'));
       const fns = body.slice(0, body.indexOf('\\n/**\\n * The last assistant turn'));
       const make = new Function('openSync', 'readSync', 'closeSync', 'fstatSync', 'readFileSync', 'writeFileSync', 'renameSync', 'tmpdir', 'Buffer', 'process', fns + '; return spentNow;');
       const spentNow = make(openSync, readSync, closeSync, fstatSync, readFileSync, writeFileSync, renameSync, () => process.argv[2], Buffer, process);
       process.stdout.write(JSON.stringify(spentNow(process.argv[1])));`,
      file,
      memo,
    ],
    { encoding: 'utf8', cwd: process.cwd() },
  );

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), readSpent(file)?.value);
  assert.equal(JSON.parse(first.stdout).complete, false);

  // The next hook in the same container starts where this one stopped, and
  // still answers with the figure when nothing new was written.
  appendFileSync(file, `${assistant}\n`);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).usd, 6.25);
});
