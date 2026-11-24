// Engines on a metered API key (docs/api-engines.md), as rules: the
// providers, the model a member may name, which vault item an engine runs
// on, what a machine is sent, what a box hands a session, and the approval
// that guards the spending a budget cannot see.
//
// The runner staging a key is test/engines-run.test.js; the vault keeping
// one is test/vault.test.js; the coordinator is
// test/api-engines-coordinator.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  API_PROVIDERS, API_KEY_ITEMS, checkEngines, encodeEngines, decodeEngines, ENGINES_PARAM_RE, enginesOn, providerOf, credentialOf, anyPaid,
} from '../src/fleet/protocol/engines.js';
import { API_PROVIDERS as RUNNER_PROVIDERS, providerOf as runnerProviderOf } from '../sandbox/engine.mjs';
import { approvalNeeded, checkBudgetSettings, NO_BUDGET_SETTINGS } from '../src/fleet/protocol/budgets.js';
import { boxApiProviders, nextEngine, answerEngineCredential } from '../src/core/engine-box.js';

const OR = 'openrouter/anthropic/claude-sonnet-5.5';
const GW = 'vercel/anthropic/claude-sonnet-5.5';

test('the runner’s copy of the provider table is the fleet’s: the same names, items and variables', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(API_PROVIDERS).map(([id, p]) => [id, { opencode: p.opencode, item: p.item, env: p.env }])),
    Object.fromEntries(Object.entries(RUNNER_PROVIDERS).map(([id, p]) => [id, { opencode: p.opencode, item: p.item, env: p.env }])),
  );
  for (const model of [OR, GW, 'github-copilot/gpt-5']) {
    assert.equal(runnerProviderOf('opencode', model)?.item ?? null, credentialOf({ engine: 'opencode', model }) === 'copilot' ? null : credentialOf({ engine: 'opencode', model }), model);
  }
});

test('a member may name an OpenCode model on either provider, by that provider’s own id, and nothing else new', () => {
  const ok = (/** @type {string} */ model) => checkEngines([{ engine: 'opencode', model }]).ok;
  assert.equal(ok(OR), true);
  assert.equal(ok(GW), true);
  assert.equal(ok('openrouter/gpt-5'), true, 'a model with no slash of its own');
  assert.equal(ok('github-copilot/gpt-5'), true, 'as before');
  for (const bad of ['openrouter/', 'openrouter', 'groq/llama', 'ai-gateway/x', 'openrouter/a/b/c/d', 'openrouter/a b', 'openrouter/a,b', 'openrouter/a=b', `openrouter/${'x'.repeat(200)}`]) {
    assert.equal(ok(bad), false, bad);
  }
  // Codex and Claude Code take no provider prefix: a slash is not a model of theirs.
  assert.equal(checkEngines([{ engine: 'codex', model: OR }]).ok, false);
  // It travels as one line and reads back as itself.
  const list = [{ engine: 'claude-code' }, { engine: 'opencode', model: OR }];
  const line = encodeEngines(list);
  assert.equal(line, `claude-code,opencode=${OR}`);
  assert.equal(ENGINES_PARAM_RE.test(line), true);
  assert.deepEqual(decodeEngines(line), { ok: true, engines: list });
  // Three long names that each pass on their own and do not fit the line a
  // machine takes are refused where the member is written, not at every start.
  const long = /** @type {any} */ (checkEngines([{ engine: 'claude-code', model: 'c'.repeat(80) }, { engine: 'codex', model: 'd'.repeat(80) }, { engine: 'opencode', model: `openrouter/${'a'.repeat(40)}/${'b'.repeat(40)}/${'c'.repeat(27)}` }]));
  assert.equal(long.ok, false);
  assert.match(long.text, /too long together: written as one line they are 3\d\d characters, and a machine takes 300/);
  const fits = /** @type {any} */ (checkEngines([{ engine: 'claude-code', model: 'c'.repeat(80) }, { engine: 'codex', model: 'd'.repeat(80) }, { engine: 'opencode', model: `openrouter/${'a'.repeat(40)}/${'b'.repeat(20)}` }]));
  assert.equal(fits.ok && ENGINES_PARAM_RE.test(encodeEngines(fits.engines)), true);
});

test('an engine runs on its own sign-in, or on the key of the provider its model names', () => {
  assert.equal(credentialOf({ engine: 'opencode', model: OR }), 'apikey:openrouter');
  assert.equal(credentialOf({ engine: 'opencode', model: GW }), 'apikey:ai-gateway');
  assert.equal(credentialOf({ engine: 'opencode', model: 'github-copilot/gpt-5' }), 'copilot');
  assert.equal(credentialOf({ engine: 'codex' }), 'codex');
  assert.equal(credentialOf({ engine: 'claude-code', model: 'opus' }), 'claude');
  assert.deepEqual([providerOf({ engine: 'opencode', model: GW }), providerOf({ engine: 'opencode', model: 'github-copilot/gpt-5' }), providerOf({ engine: 'codex' })], ['ai-gateway', null, null]);
  assert.deepEqual(API_KEY_ITEMS, ['apikey:openrouter', 'apikey:ai-gateway']);
  assert.deepEqual([anyPaid([{ engine: 'claude-code' }, { engine: 'opencode', model: OR }]), anyPaid([{ engine: 'claude-code' }, { engine: 'opencode', model: 'github-copilot/gpt-5' }]), anyPaid(null)], [true, false, false]);
});

test('a machine is sent an engine on an API key only when it reports that provider', () => {
  const list = [{ engine: 'claude-code' }, { engine: 'opencode', model: OR }, { engine: 'codex' }];
  const on = (/** @type {any} */ runs, /** @type {any} */ providers) => enginesOn(list, runs, providers);
  assert.deepEqual(on(['claude-code', 'opencode', 'codex'], ['openrouter']).kept, list);
  // The other provider is not this one.
  assert.deepEqual(on(['claude-code', 'opencode', 'codex'], ['ai-gateway']).dropped, [{ engine: 'opencode', model: OR }]);
  // A BOX FROM BEFORE KEYS reports none, and is never sent one, though it runs OpenCode.
  assert.deepEqual(on(['claude-code', 'opencode', 'codex'], undefined).kept, [{ engine: 'claude-code' }, { engine: 'codex' }]);
  // A provider nobody has heard of in a box's report is not a provider.
  assert.deepEqual(on(['claude-code', 'opencode'], ['openrouter', 'acme', 7]).providers, ['openrouter']);
  // And a Copilot model needs no provider at all.
  assert.deepEqual(enginesOn([{ engine: 'opencode', model: 'github-copilot/gpt-5' }], ['opencode'], undefined).dropped, []);
});

const BOX = { sandbox: true, sandboxHookSocket: true, engines: ['opencode'], apiProviders: ['openrouter'] };

test('a box bills to an API provider only when its operator named it, on a box that runs OpenCode', () => {
  assert.deepEqual(boxApiProviders(BOX), ['openrouter']);
  assert.deepEqual(boxApiProviders({ ...BOX, apiProviders: [' OpenRouter ', 'acme', 'ai-gateway', 'openrouter'] }), ['openrouter', 'ai-gateway']);
  assert.deepEqual(boxApiProviders({ ...BOX, apiProviders: [] }), []);
  assert.deepEqual(boxApiProviders({ ...BOX, engines: ['codex'] }), [], 'the engine that speaks to them is not here');
  assert.deepEqual(boxApiProviders({ ...BOX, sandboxHookSocket: false }), [], 'no socket, no other engines, no keys');
  // At a limit, the next engine is one this box may bill to, or the one after it.
  const rec = { engines: [{ engine: 'claude-code' }, { engine: 'opencode', model: OR }, { engine: 'opencode', model: 'github-copilot/gpt-5' }].slice(0, 2).concat([{ engine: 'codex' }]), engineAt: 0 };
  const limit = { engine: 'claude-code', reason: 'limit' };
  assert.equal(nextEngine(rec, limit, ['claude-code', 'opencode', 'codex'], ['openrouter']), 1);
  assert.equal(nextEngine(rec, limit, ['claude-code', 'opencode', 'codex'], []), 2, 'past the engine it may not bill for');
  assert.equal(nextEngine(rec, limit, ['claude-code', 'opencode'], []), -1);
});

test('a session is handed a key only for a provider its member’s engines name and its box has turned on', (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'api-box-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  // What the vault left on this box for the member, filed under the member's own account.
  mkdirSync(path.join(stateDir, 'vault'), { recursive: true });
  writeFileSync(path.join(stateDir, 'vault', 'debbie@members.invalid.json'), JSON.stringify({ items: { 'apikey:openrouter': { value: 'sk-or-v1-0123456789abcdef' }, 'apikey:ai-gateway': { value: 'vck_0123456789abcdef' }, copilot: { value: 'gho_x' } } }));
  const cfg = { ...BOX, stateDir };
  const rec = { createdBy: 'debbie@members.invalid', engines: [{ engine: 'claude-code' }, { engine: 'opencode', model: OR }] };
  assert.deepEqual(answerEngineCredential(cfg, rec, 'apikey:openrouter'), { ok: true, kind: 'apikey:openrouter', value: 'sk-or-v1-0123456789abcdef' });
  // A provider its member does not name.
  assert.equal(/** @type {any} */ (answerEngineCredential(cfg, rec, 'apikey:ai-gateway')).error, 'not_granted');
  // A provider the member names and this box's operator has not turned on, whatever the vault left here.
  const off = /** @type {any} */ (answerEngineCredential({ ...cfg, apiProviders: [] }, rec, 'apikey:openrouter'));
  assert.deepEqual([off.error, off.message], ['not_granted', 'The operator of this machine has not turned that API provider on.']);
  // A session whose member has no such engine at all.
  assert.equal(/** @type {any} */ (answerEngineCredential(cfg, { ...rec, engines: [{ engine: 'claude-code' }] }, 'apikey:openrouter')).error, 'not_granted');
  // And a key is never "handed back": nothing a session sends replaces one.
  assert.equal(/** @type {any} */ (answerEngineCredential(cfg, rec, 'apikey:openrouter', 'sk-or-v1-planted-0123456789')).ok, false);
});

const debbie = { id: 'debbie', name: 'Debbie', budgetUsdMonth: null };

test('a start on an engine that bills an API key needs approval by default, and an admin can turn that off', () => {
  const need = (/** @type {any} */ settings, /** @type {boolean} */ paid) => /** @type {any} */ (approvalNeeded({ settings, member: debbie, spend: null, start: { dangerous: false, paid } })).reasons;
  // A fleet that set nothing: asked about a paid engine, and about nothing else.
  assert.deepEqual(need(NO_BUDGET_SETTINGS, true), [{ kind: 'paid-api', text: 'Debbie has an engine that bills an API key by the token, which no budget here counts.' }]);
  assert.deepEqual(need(NO_BUDGET_SETTINGS, false), [], 'which changes nothing for a fleet with no such engine');
  // A record written before the setting existed has none, and is still on.
  assert.equal(/** @type {any} */ (checkBudgetSettings({ budgets: 'ask' }, { budgets: 'off', dangerous: false, workTypes: [] })).paidApi, true);
  assert.deepEqual(need({ budgets: 'off', dangerous: false, workTypes: [] }, true).map((/** @type {any} */ r) => r.kind), ['paid-api']);
  // Turned off, and kept off by a later change to something else.
  const off = /** @type {any} */ (checkBudgetSettings({ paidApi: false }, NO_BUDGET_SETTINGS));
  assert.equal(off.paidApi, false);
  assert.equal(/** @type {any} */ (checkBudgetSettings({ dangerous: true }, off)).paidApi, false);
  assert.deepEqual(need(off, true), []);
  assert.equal(/** @type {any} */ (checkBudgetSettings({ paidApi: 'no' })).ok, false);
});
