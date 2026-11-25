// What runs a member (docs/engines.md): the list a member names, the list a
// start carries, the one way a turn ends, and the box's own side of it: what
// it runs, whose sign-in it hands a session, which engine takes over, and
// the note it writes when one does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  ENGINES, ENGINE_IDS, TURN_REASONS, HANDS_ON, LIMIT_WORDS, AUTH_WORDS, ENGINES_PARAM_RE,
  checkEngines, encodeEngines, decodeEngines, enginesOn, isPlainDefault, enginesWords, cleanTurn, turnFromHook, turnWords,
} from '../src/fleet/protocol/engines.js';
import * as runner from '../sandbox/engine.mjs';
import { boxEngines, nextEngine, answerEngineCredential, handoffNote, continuationMessage, HANDOFF_FILE } from '../src/core/engine-box.js';
import { applyVault, vaultEngineItem, keepEngineItem } from '../src/core/vault-store.js';
import { CHECKOUT_FACTS_SCRIPT, COMMIT_HANDOFF_SCRIPT, readCheckoutFacts } from '../src/core/files.js';
import { checkMember, toMarkdown, fromMarkdown } from '../src/fleet/protocol/members.js';
import { checkParams } from '../src/fleet/protocol/intents.js';
import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';

const three = [{ engine: 'claude-code' }, { engine: 'codex', model: 'gpt-5.1-codex' }, { engine: 'opencode', model: 'github-copilot/gpt-5' }];

test('a member names up to three engines, each once, each with the model its engine allows', () => {
  assert.deepEqual(/** @type {any} */ (checkEngines(three)).engines, three);
  assert.deepEqual(/** @type {any} */ (checkEngines(undefined)).engines, [{ engine: 'claude-code' }], 'none named is Claude Code, alone');
  const refused = (/** @type {any} */ list) => /** @type {any} */ (checkEngines(list)).text;
  assert.match(refused([]), /at least one/);
  assert.match(refused([{ engine: 'gemini' }]), /one of claude-code, codex, opencode/);
  // ACROSS PROVIDERS, NEVER ACROSS ACCOUNTS: the same engine twice is refused in those words.
  assert.match(refused([{ engine: 'codex' }, { engine: 'codex', model: 'other' }]), /codex is named twice\. A member falls back from one engine to another, never to a second account of the same one/);
  assert.match(refused([{ engine: 'opencode' }]), /OpenCode needs a model.*the model says whose account pays/);
  // A provider this fleet has no row for is refused, naming the ones it has (docs/api-engines.md).
  assert.match(refused([{ engine: 'opencode', model: 'anthropic/claude-sonnet' }]), /^An OpenCode model is written github-copilot\/<model>, or openrouter\/<model> or vercel\/<model> for one that runs on an API key\.$/);
  assert.match(refused([{ engine: 'codex', model: 'two words' }]), /a model name/);
  assert.match(refused([...three, { engine: 'claude-code' }]), /at most 3/);
});

test('a member’s record and file carry the list, in order', () => {
  const m = /** @type {any} */ (checkMember({ id: 'debbie', name: 'Debbie', kind: 'agent', role: 'engineer', engines: [three[1], three[0]] })).member;
  assert.deepEqual(m.engines, [three[1], three[0]]);
  const back = /** @type {any} */ (fromMarkdown(toMarkdown(m))).member;
  assert.deepEqual(back.engines, [three[1], three[0]]);
});

test('the line a start carries reads back as the list, and a line that is not one is refused', () => {
  const line = encodeEngines(three);
  assert.equal(line, 'claude-code,codex=gpt-5.1-codex,opencode=github-copilot/gpt-5');
  assert.match(line, ENGINES_PARAM_RE);
  assert.deepEqual(/** @type {any} */ (decodeEngines(line)).engines, three);
  assert.equal(checkParams('start', { memberEngines: line }).ok, true);
  assert.equal(checkParams('start', { memberEngines: 'codex; rm -rf /' }).ok, false);
  for (const bad of ['', 'codex,codex', 'gemini', 'opencode', 'codex=bad model']) assert.equal(decodeEngines(bad).ok, false, bad);
});

test('a list is cut to what a machine runs, in the member’s order, and a machine that says nothing runs Claude Code alone', () => {
  assert.deepEqual(enginesOn(three, ['claude-code', 'codex']).kept, [three[0], three[1]]);
  assert.deepEqual(enginesOn(three, ['claude-code', 'codex']).dropped, [three[2]]);
  // A machine from before engines reports none.
  assert.deepEqual(enginesOn(three, undefined).kept, [three[0]]);
  // A machine cannot report its way out of running Claude Code, or into an engine nobody built.
  assert.deepEqual(enginesOn(three, ['codex', 'gemini', 7]).runs, ['claude-code', 'codex']);
  assert.deepEqual(enginesOn([three[1]], ['claude-code']).kept, []);
  assert.equal(isPlainDefault([{ engine: 'claude-code' }]), true);
  assert.equal(isPlainDefault([{ engine: 'claude-code', model: 'opus' }]), false);
  assert.equal(isPlainDefault(three), false);
  assert.equal(enginesWords(three), 'Claude Code, then Codex (gpt-5.1-codex), then OpenCode (github-copilot/gpt-5)');
});

test('the runner a session image carries agrees with the hub on how a turn ends and what a limit sounds like', () => {
  // sandbox/engine.mjs imports nothing of the release, so what the two share
  // is written twice. This is what says so when they stop agreeing.
  assert.deepEqual([...runner.TURN_REASONS], [...TURN_REASONS]);
  assert.equal(runner.LIMIT_WORDS.source, LIMIT_WORDS.source);
  assert.equal(runner.AUTH_WORDS.source, AUTH_WORDS.source);
  assert.deepEqual(Object.keys(runner.RUNS).sort(), ENGINE_IDS.filter((e) => ENGINES[/** @type {keyof typeof ENGINES} */ (e)].adapter !== 'pane').sort());
  for (const [id, spec] of Object.entries(runner.RUNS)) assert.equal(spec.credential, ENGINES[/** @type {keyof typeof ENGINES} */ (id)].credential, id);
  // Every reason the runner can send is one the hub keeps.
  for (const reason of TURN_REASONS) assert.equal(cleanTurn(runner.ended('codex', reason))?.reason, reason);
});

test('a TurnEnded from a session is held to a type and a bound, and anything else is not a turn’s end', () => {
  assert.deepEqual(cleanTurn({ engine: 'codex', reason: 'limit', detail: 'You hit your usage limit\nsecond line', model: 'gpt-5.1-codex', usage: { input: 10, output: 20 }, resetsAt: 1_800_000_000_000, extra: 'x' }), {
    engine: 'codex', reason: 'limit', detail: 'You hit your usage limit', model: 'gpt-5.1-codex', usage: { input: 10, output: 20 }, resetsAt: 1_800_000_000_000,
  });
  for (const bad of [null, 'limit', [], { engine: 'gemini', reason: 'done' }, { engine: 'codex', reason: 'tired' }]) assert.equal(cleanTurn(bad), null);
  const odd = cleanTurn({ engine: 'codex', reason: 'error', detail: 'x'.repeat(500), usage: { input: -1, output: 2 }, resetsAt: 'soon' });
  assert.deepEqual([odd?.detail?.length, odd?.usage, odd?.resetsAt], [200, null, null]);
});

test('Claude Code’s two hooks read as a TurnEnded: done, a limit, a sign-in, or an error', () => {
  assert.equal(turnFromHook('Stop')?.reason, 'done');
  assert.equal(turnFromHook('StopFailure', 'API Error: 429 rate_limit_error')?.reason, 'limit');
  assert.equal(turnFromHook('StopFailure', 'Claude usage limit reached. Your limit will reset at 3pm')?.reason, 'limit');
  assert.equal(turnFromHook('StopFailure', 'OAuth token has expired. Please log in again')?.reason, 'auth');
  // Overloaded is the provider's bad minute, not this account's limit: nothing is handed on for it.
  assert.equal(turnFromHook('StopFailure', 'API Error: 529 overloaded_error')?.reason, 'error');
  assert.equal(turnFromHook('StopFailure')?.reason, 'error');
  // CLAUDE CODE NAMES THE ERROR, and the name is what the hook sends. An
  // account that cannot pay is at its limit; one on hold, shut out by its
  // organization, or with no cloud credential has no sign-in to use. The
  // last four of those came out `error` and handed nothing on.
  for (const [named, reason] of Object.entries({
    rate_limit: 'limit', billing_error: 'limit',
    authentication_failed: 'auth', oauth_org_not_allowed: 'auth', account_on_hold: 'auth', cloud_credential_error: 'auth',
    model_not_found: 'model', max_output_tokens: 'cut',
    server_error: 'error', invalid_request: 'error', unknown: 'error',
  })) assert.equal(turnFromHook('StopFailure', named)?.reason, reason, named);
  assert.equal(turnFromHook('PostToolUse', 'Bash'), null);
  assert.deepEqual([...HANDS_ON], ['limit', 'auth', 'model']);
});

test('why a turn ended is a sentence a person reads', () => {
  const t = (/** @type {any} */ o) => turnWords({ engine: 'codex', reason: 'done', detail: null, model: null, usage: null, resetsAt: null, ...o });
  assert.equal(t({ reason: 'limit', resetsAt: Date.UTC(2026, 10, 24, 18, 30) }), 'Codex stopped at its account’s limit. It says the limit lifts at 2026-11-24 18:30 UTC.');
  assert.equal(t({ reason: 'limit' }), 'Codex stopped at its account’s limit.');
  assert.equal(t({ engine: 'opencode', reason: 'model', model: 'opencode/big-pickle' }), 'OpenCode was not on the model that was asked for: it said opencode/big-pickle, so nothing was asked of it.');
  assert.equal(t({ engine: 'opencode', reason: 'model' }), 'OpenCode was not on the model that was asked for, or did not say which it was on, so nothing was asked of it.');
  assert.equal(t({ reason: 'error', detail: 'stream closed' }), 'Codex stopped on an error: stream closed.');
});

test('a box runs Claude Code, and another engine only where its operator says so and sessions have their own socket', () => {
  assert.deepEqual(boxEngines({}), ['claude-code']);
  assert.deepEqual(boxEngines({ sandbox: true, sandboxHookSocket: true, engines: ['Codex', 'opencode', 'gemini', 'claude-code', 'codex'] }), ['claude-code', 'codex', 'opencode']);
  // The runner reports to the session's socket and asks it for a sign-in: no socket, no other engine.
  assert.deepEqual(boxEngines({ sandbox: true, sandboxHookSocket: false, engines: ['codex'] }), ['claude-code']);
  assert.deepEqual(boxEngines({ sandbox: false, sandboxHookSocket: true, engines: ['codex'] }), ['claude-code']);
});

test('the next engine is the first after this one that the box runs, and only for a limit, a sign-in or the wrong model', () => {
  const rec = { engines: three, engineAt: 0 };
  const all = ['claude-code', 'codex', 'opencode'];
  assert.equal(nextEngine(rec, { engine: 'claude-code', reason: 'limit' }, all), 1);
  assert.equal(nextEngine(rec, { engine: 'claude-code', reason: 'limit' }, ['claude-code', 'opencode']), 2, 'an engine the box lacks is passed over');
  assert.equal(nextEngine({ ...rec, engineAt: 2 }, { engine: 'opencode', reason: 'limit' }, all), -1, 'the last has nothing after it');
  for (const reason of ['done', 'refused', 'cut', 'cancelled', 'error']) assert.equal(nextEngine(rec, { engine: 'claude-code', reason }, all), -1, reason);
  // A report about an engine the pane is no longer on moves nothing.
  assert.equal(nextEngine({ ...rec, engineAt: 1 }, { engine: 'claude-code', reason: 'limit' }, all), -1);
  assert.equal(nextEngine({ engines: null }, { engine: 'claude-code', reason: 'limit' }, all), -1);
});

test('the image with the engines in it is built, published and run where the browser one is', () => {
  // Nothing built it. The Containerfile took WITH_ENGINES=1 and no workflow
  // passed it, so the layer that installs Codex and OpenCode had never run
  // in CI and there was no image for a box that names them to pull.
  const workflow = readFileSync(new URL('../.github/workflows/sandbox.yml', import.meta.url), 'utf8');
  assert.match(workflow, /build-args: WITH_ENGINES=1/);
  assert.match(workflow, /type=raw,value=engines,enable=\{\{is_default_branch\}\}/);
  // AND RUN: each engine answers on the image that was built, and the minimal image is seen to have neither.
  const smoke = workflow.slice(workflow.indexOf('The engines variant has both engines, and each answers'), workflow.indexOf('THE BUG THIS WHOLE JOB EXISTS FOR'));
  assert.match(smoke, /docker build --build-arg WITH_ENGINES=1 -t fleetwright-session:engines /);
  for (const said of ['codex --version', 'opencode --version', 'for tool in fleetwright-engine codex opencode']) assert.ok(smoke.includes(said), said);
  assert.match(smoke, /fleetwright-session:smoke[\s\S]*the minimal image has \$tool, which no box was told it runs/);
  // The argument the workflow passes is the one the Containerfile reads.
  const containerfile = readFileSync(new URL('../sandbox/Containerfile', import.meta.url), 'utf8');
  assert.match(containerfile, /^ARG WITH_ENGINES=0$/m);
  assert.match(containerfile, /if \[ "\$WITH_ENGINES" = "1" \]; then \\\n\s+npm install -g "@openai\/codex@\$\{CODEX_VERSION\}" "opencode-ai@\$\{OPENCODE_VERSION\}"/);
});

/** A box holding a member's vault as the minter hands it over. */
function boxHolding(/** @type {import('node:test').TestContext} */ t, /** @type {any[]} */ items) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'engines-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = { stateDir };
  const apply = (/** @type {any[]} */ now) => applyVault(cfg, { accounts: [{ principal: 'member:debbie', member: 'debbie', login: '', items: now, problems: [] }] });
  assert.equal(apply(items).ok, true);
  return { cfg, apply };
}
const signIn = (/** @type {string} */ refresh) => JSON.stringify({ tokens: { access_token: 'a', refresh_token: refresh } });

test('a session is handed its own member’s sign-in for an engine it names, and nobody else’s', (t) => {
  const { cfg } = boxHolding(t, [{ name: 'codex', value: signIn('r-1'), expiresAt: null }, { name: 'copilot', value: 'gho_token', expiresAt: null }]);
  const rec = { createdBy: 'fleet:debbie@members.invalid', engines: [{ engine: 'claude-code' }, { engine: 'codex' }] };
  assert.deepEqual(answerEngineCredential(cfg, rec, 'codex'), { ok: true, kind: 'codex', value: signIn('r-1') });
  const code = (/** @type {any} */ r, /** @type {string} */ kind) => /** @type {any} */ (answerEngineCredential(cfg, r, kind)).error;
  // THE GRANT IS THE RECORD: the member keeps a Copilot token, and this session names no engine that runs on it.
  assert.equal(code(rec, 'copilot'), 'not_granted');
  assert.equal(code(rec, 'claude'), 'not_granted', 'a Claude sign-in never leaves by this door');
  assert.equal(code({ ...rec, engines: null }, 'codex'), 'not_granted');
  assert.equal(code(null, 'codex'), 'no_session');
  // Another member's session, naming the same engine, reads its own vault, which holds none.
  assert.equal(code({ createdBy: 'fleet:jason@members.invalid', engines: [{ engine: 'codex' }] }, 'codex'), 'not_held');
  assert.equal(code({ engines: [{ engine: 'codex' }] }, 'codex'), 'no_owner');
});

test('a Codex sign-in renewed on the box is kept through the vault’s next answer, and replaced by a new deposit', (t) => {
  const first = { name: 'codex', value: signIn('r-1'), expiresAt: null };
  const { cfg, apply } = boxHolding(t, [first]);
  const rec = { createdBy: 'fleet:debbie@members.invalid', engines: [{ engine: 'codex' }] };
  // Codex rewrote its file, and the runner handed it back.
  assert.equal(answerEngineCredential(cfg, rec, 'codex', signIn('r-2')).ok, true);
  assert.equal(vaultEngineItem(cfg, 'debbie@members.invalid', 'codex'), signIn('r-2'));
  // The vault answers again with the deposit it has always had: the renewed copy stays.
  apply([first]);
  assert.equal(vaultEngineItem(cfg, 'debbie@members.invalid', 'codex'), signIn('r-2'));
  // A custodian deposits a new one: that is the one now.
  apply([{ ...first, value: signIn('r-9') }]);
  assert.equal(vaultEngineItem(cfg, 'debbie@members.invalid', 'codex'), signIn('r-9'));

  // WHAT IS NOT KEPT: text that is not a sign-in, a kind that does not renew, and a sign-in where the vault gave none.
  assert.equal(keepEngineItem(cfg, 'debbie@members.invalid', 'codex', 'garbage'), false);
  assert.equal(keepEngineItem(cfg, 'debbie@members.invalid', 'codex', JSON.stringify({ OPENAI_API_KEY: 'sk' })), false);
  assert.equal(keepEngineItem(cfg, 'debbie@members.invalid', 'copilot', 'gho_other'), false);
  assert.equal(keepEngineItem(cfg, 'jason@members.invalid', 'codex', signIn('planted')), false);
  assert.equal(vaultEngineItem(cfg, 'debbie@members.invalid', 'codex'), signIn('r-9'));
  // And when the vault stops giving it, the box stops holding it.
  apply([]);
  assert.equal(vaultEngineItem(cfg, 'debbie@members.invalid', 'codex'), null);
});

test('of two copies of a Codex sign-in handed back, the one renewed later is kept, whichever arrives last', (t) => {
  // As Codex writes the file: it says when it was last renewed.
  const at = (/** @type {string} */ refresh, /** @type {string|null} */ when) => JSON.stringify({ tokens: { access_token: 'a', refresh_token: refresh }, ...(when ? { last_refresh: when } : {}) });
  const { cfg } = boxHolding(t, [{ name: 'codex', value: at('r-1', '2026-11-24T10:00:00Z'), expiresAt: null }]);
  const rec = { createdBy: 'fleet:debbie@members.invalid', engines: [{ engine: 'codex' }] };
  const held = () => vaultEngineItem(cfg, 'debbie@members.invalid', 'codex');
  // Two sessions of Debbie's were each handed r-1. One renews at noon and hands its file back.
  assert.equal(answerEngineCredential(cfg, rec, 'codex', at('r-2', '2026-11-24T12:00:00Z')).ok, true);
  // THE OTHER ARRIVES LAST WITH AN OLDER FILE: one it renewed at eleven,
  // whose token the noon renewal has since used up. It used to replace the
  // good copy, and the next session on this machine was signed out.
  const older = /** @type {any} */ (answerEngineCredential(cfg, rec, 'codex', at('r-1b', '2026-11-24T11:00:00Z')));
  assert.deepEqual([older.ok, older.error, older.message], [false, 'not_kept', 'That does not read as a newer copy of the sign-in this machine holds, so it was not kept.']);
  assert.equal(held(), at('r-2', '2026-11-24T12:00:00Z'));
  // Neither is one renewed at the same moment that says something else, nor one that does not say when.
  assert.equal(answerEngineCredential(cfg, rec, 'codex', at('r-x', '2026-11-24T12:00:00Z')).ok, false);
  assert.equal(answerEngineCredential(cfg, rec, 'codex', at('r-y', null)).ok, false);
  assert.equal(held(), at('r-2', '2026-11-24T12:00:00Z'));
  // A later renewal is the one now, and handing the same file back twice is no refusal.
  assert.equal(answerEngineCredential(cfg, rec, 'codex', at('r-3', '2026-11-24T13:00:00Z')).ok, true);
  assert.equal(answerEngineCredential(cfg, rec, 'codex', at('r-3', '2026-11-24T13:00:00Z')).ok, true);
  assert.equal(held(), at('r-3', '2026-11-24T13:00:00Z'));

  // A copy held here that says nothing about when it was renewed, or does not read at all, has no claim to be the newer.
  const plain = boxHolding(t, [{ name: 'codex', value: 'not a file at all', expiresAt: null }]);
  assert.equal(answerEngineCredential(plain.cfg, rec, 'codex', at('r-9', null)).ok, true);
  assert.equal(vaultEngineItem(plain.cfg, 'debbie@members.invalid', 'codex'), at('r-9', null));
});

test('the handoff note says who stopped, why, what was asked and what the checkout said, and that a machine wrote it', () => {
  const note = handoffNote({
    turn: { engine: 'claude-code', reason: 'limit', detail: 'usage limit reached', model: null, usage: null, resetsAt: Date.UTC(2026, 10, 24, 18, 30) },
    next: { engine: 'codex', model: 'gpt-5.1-codex' },
    taskId: 't12', taskBranch: 'task/t12-fix-the-login',
    firstMessage: 'Task t12. Fix the login redirect.',
    checkout: { where: 'app', branch: 'task/t12-fix-the-login', status: ' M src/auth.js\n', log: '3f2a1bc Fix the redirect\n' },
    pane: `${'x'.repeat(5000)}\nI had just started on the Safari case.`,
    at: Date.UTC(2026, 10, 24, 12, 0),
  });
  assert.match(note, /^# Handoff: Claude Code to Codex\n\nWritten by this machine at 2026-11-24 12:00 UTC, not by either engine\./);
  assert.match(note, /\*\*Why:\*\* Claude Code stopped at its account’s limit\. It says the limit lifts at 2026-11-24 18:30 UTC\. Its own words: usage limit reached/);
  assert.match(note, /\*\*Continuing on:\*\* Codex \(gpt-5\.1-codex\)/);
  assert.match(note, /\*\*Task:\*\* t12, on the branch task\/t12-fix-the-login\. Write RESULT\.md/);
  assert.match(note, /## What was asked\n\nTask t12\. Fix the login redirect\./);
  assert.match(note, /In `app`, on the branch `task\/t12-fix-the-login`\.[\s\S]* M src\/auth\.js[\s\S]*3f2a1bc Fix the redirect/);
  assert.match(note, /I had just started on the Safari case\.\n```\n$/);
  assert.ok(note.length < 4000, 'the pane’s tail is bounded');

  // WHAT IT COULD NOT SEE IS SAID AS THAT, never left out as if it were nothing.
  const bare = handoffNote({ turn: { engine: 'codex', reason: 'auth', detail: null, model: null, usage: null, resetsAt: null }, next: { engine: 'opencode', model: 'github-copilot/gpt-5' }, at: 0 });
  assert.match(bare, /This machine no longer holds the first message of this session/);
  assert.match(bare, /No git checkout was found at the top of the workspace or one directory down\./);
  assert.match(bare, /\(nothing could be read off the pane\)/);
  assert.doesNotMatch(bare, /\*\*Task:\*\*/);

  assert.equal(continuationMessage('Fix it.', 'claude-code'), `Fix it.\n\n----------\n\nYou are continuing work that Claude Code began in this workspace and could not finish. Read ${HANDOFF_FILE} at the top of the workspace first: it says why it stopped and what the checkout looked like.`);
  assert.match(continuationMessage(null, 'codex'), /^You are continuing work that Codex began/);
});

/** Run one of the workspace scripts against a directory standing in for /work. */
function inWorkspace(/** @type {string} */ root, /** @type {string} */ script, /** @type {string[]} */ args, /** @type {string} */ stdin = '') {
  return spawnSync('sh', ['-c', `t="${root}"\n${script}`, 'sh', ...args], { input: stdin, encoding: 'utf8' });
}
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });

test('the note is committed alone, on the task’s own branch and no other, and the checkout is found one directory down', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'engines-work-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'app');
  mkdirSync(repo);
  git(repo, ['init', '-q']);
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'first']);
  git(repo, ['checkout', '-q', '-b', 'task/t12-fix-it']);
  writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  writeFileSync(path.join(repo, 'wip.txt'), 'unfinished\n');
  // A hook of the repository's is the session's code, and does not run.
  writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch "$(git rev-parse --show-toplevel)/HOOK-RAN"\nexit 1\n', { mode: 0o755 });

  const facts = readCheckoutFacts(inWorkspace(root, CHECKOUT_FACTS_SCRIPT, ['.', 'task/t12-fix-it']).stdout);
  assert.deepEqual([facts?.where, facts?.branch], ['app', 'task/t12-fix-it']);
  assert.match(String(facts?.status), / M a\.txt\n\?\? wip\.txt/);
  assert.match(String(facts?.log), /first$/);
  // Asked for a branch no checkout is on: none is found, and none is guessed.
  assert.equal(readCheckoutFacts(inWorkspace(root, CHECKOUT_FACTS_SCRIPT, ['.', 'task/t99-other']).stdout), null);

  const done = inWorkspace(repo, COMMIT_HANDOFF_SCRIPT, ['.', 'task/t12-fix-it'], '# Handoff\n');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git(repo, ['show', '--stat', '--format=%s', 'HEAD']).stdout.trim().split('\n').filter(Boolean).join('|'), 'Handoff note: one engine stopped and the next continues| HANDOFF.md | 1 +| 1 file changed, 1 insertion(+)');
  // The session's own unfinished work is still unfinished, and still its own to commit.
  assert.match(git(repo, ['status', '--short']).stdout, / M a\.txt\n\?\? wip\.txt/);
  assert.equal(spawnSync('ls', [repo]).stdout.toString().includes('HOOK-RAN'), false);
  assert.equal(readFileSync(path.join(repo, 'HANDOFF.md'), 'utf8'), '# Handoff\n');

  // ON ANY OTHER BRANCH it is refused, and nothing is written there.
  git(repo, ['checkout', '-q', '-b', 'somebody-elses-work']);
  const refused = inWorkspace(repo, COMMIT_HANDOFF_SCRIPT, ['.', 'task/t12-fix-it'], '# Second\n');
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(path.join(repo, 'HANDOFF.md'), 'utf8'), '# Handoff\n');
});

/** A session manager with one running session that names two engines. */
function manager(/** @type {import('node:test').TestContext} */ t, /** @type {any} */ session = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'engines-sm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({ stateDir: dir, profileDir: path.join(dir, 'profiles'), workdir: dir, stateFile: path.join(dir, 'state.json'), spoolFile: path.join(dir, 'spool'), sandbox: true, sandboxHookSocket: true, engines: ['codex'] });
  const registry = new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile });
  const sm = new SessionManager(cfg, registry, null);
  sm.reconcile = () => {};
  registry.upsert('job', { status: 'running', cwd: '/w', engines: [{ engine: 'claude-code' }, { engine: 'codex' }], engineAt: 0, ...session });
  /** @type {any[]} */
  const handed = [];
  sm.handOn = /** @type {any} */ (async (/** @type {string} */ name, /** @type {any} */ turn) => void handed.push({ name, engine: turn.engine, reason: turn.reason }));
  return { sm, registry, handed };
}

test('how a turn ended is kept on the session’s record, and only a limit, a sign-in or the wrong model looks for the next engine', (t) => {
  const { sm, registry, handed } = manager(t);
  // Claude Code's own hooks, on a pane that is Claude Code's.
  sm.recordEvent({ name: 'job', event: 'UserPromptSubmit', at: 1000 });
  sm.recordEvent({ name: 'job', event: 'Stop', at: 2000 });
  assert.deepEqual(registry.get('job')?.turn, { engine: 'claude-code', reason: 'done', detail: null, model: null, usage: null, resetsAt: null, at: 2000 });
  assert.deepEqual(handed, []);
  sm.recordEvent({ name: 'job', event: 'StopFailure', detail: 'API Error: 529 overloaded_error', at: 3000 });
  assert.deepEqual([registry.get('job')?.turn?.reason, handed.length], ['error', 0]);
  sm.recordEvent({ name: 'job', event: 'StopFailure', detail: 'Claude usage limit reached', at: 4000 });
  assert.deepEqual(handed, [{ name: 'job', engine: 'claude-code', reason: 'limit' }]);
  assert.equal(sm.list().find((s) => s.name === 'job')?.activity?.phase, 'ready', 'and it is at its prompt, as any ended turn is');
});

test('a runner’s TurnEnded counts only for the engine the pane is on, and must read as one', (t) => {
  const { sm, registry, handed } = manager(t, { engineAt: 1 });
  const turn = (/** @type {any} */ o) => ({ engine: 'codex', reason: 'done', detail: null, model: null, usage: null, resetsAt: null, ...o });
  // On Codex's pane, Claude Code's hooks are not this session's turns.
  sm.recordEvent({ name: 'job', event: 'StopFailure', detail: 'usage limit reached', at: 1000 });
  assert.equal(registry.get('job')?.turn, undefined);
  sm.recordEvent({ name: 'job', event: 'TurnEnded', turn: turn({ reason: 'auth' }), at: 2000 });
  assert.deepEqual(handed, [{ name: 'job', engine: 'codex', reason: 'auth' }]);
  // A session cannot report its way onto another engine than the one it is.
  sm.recordEvent({ name: 'job', event: 'TurnEnded', turn: turn({ engine: 'opencode', reason: 'limit' }), at: 3000 });
  assert.equal(handed.length, 1);
  assert.equal(registry.get('job')?.turn?.engine, 'codex');
  assert.equal(sm.recordEvent({ name: 'job', event: 'TurnEnded', turn: null }).ok, false);
});

test('a session that names no engines is Claude Code’s as it always was: its turns are kept and nothing is handed on', (t) => {
  const { sm, registry, handed } = manager(t, { engines: null, engineAt: undefined });
  sm.handOn = SessionManager.prototype.handOn.bind(sm);
  sm.recordEvent({ name: 'job', event: 'StopFailure', detail: 'rate limit', at: 1000 });
  assert.equal(registry.get('job')?.turn?.reason, 'limit');
  assert.equal(registry.get('job')?.status, 'running');
  assert.deepEqual(handed, []);
});
