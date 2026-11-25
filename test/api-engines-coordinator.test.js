// Engines on an API key in the coordinator (docs/api-engines.md): a start
// cut to the providers a machine reports, the box from before keys, and
// the approval that a paid engine needs by default.
//
// The rules are test/api-engines.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const eli = { email: 'eli@example.com', admin: true };
const OR = 'openrouter/anthropic/claude-sonnet-5.5';

/** A fleet with the boxes given, each reporting engines and API providers, and the agent Debbie on the engines given. */
function fleet(/** @type {Array<[string, string[], string[]|undefined, number?]>} */ boxes, /** @type {any} */ engines) {
  const core = new CoordinatorCore({});
  assert.equal(core.setMember(eli, 'eli', { name: 'Eli', kind: 'person', email: eli.email, role: 'owner' }).ok, true);
  const debbie = core.setMember(eli, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'eli', engines });
  assert.equal(debbie.ok, true, /** @type {any} */ (debbie).text);
  for (const [hostId, runs, apiProviders, protocol = PROTOCOL_VERSION] of boxes) {
    core.registry.connect(hostId, () => {});
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [], engines: runs, ...(apiProviders ? { apiProviders } : {}) });
  }
  /** @type {Array<{ hostId: string, params: any }>} */
  const sent = [];
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    sent.push({ hostId: host.hostId, params: spec.params });
    return { ok: true, text: 'Started "cc-1".', sessions: [{ name: 'cc-1', status: 'running' }] };
  });
  const start = (/** @type {string} */ host) => /** @type {Promise<any>} */ (core.dispatch({ verb: 'start', params: { member: 'debbie', task: 'Fix it.' }, actor: eli.email, requester: eli, preferHost: host }));
  /** Approve whatever the last refusal asked for, and start again. */
  const approved = async (/** @type {string} */ host) => {
    const refused = await start(host);
    assert.equal(refused.error?.code, 'needs_approval', refused.text);
    assert.equal(/** @type {any} */ (await core.answerApproval(eli, refused.approval.id, 'approve')).ok, true);
    return start(host);
  };
  return { core, sent, start, approved };
}
const both = [{ engine: 'claude-code' }, { engine: 'opencode', model: OR }];

test('a start on a member with an engine that bills an API key waits for approval on a fleet that set nothing, and says why', async () => {
  const f = fleet([['paid', ['claude-code', 'opencode'], ['openrouter']]], both);
  const refused = await f.start('paid');
  assert.equal(refused.error.code, 'needs_approval');
  assert.deepEqual(refused.approval.reasons, [{ kind: 'paid-api', text: 'Debbie has an engine that bills an API key by the token, which no budget here counts. The session is told: “Fix it.”' }]);
  assert.deepEqual(f.sent, [], 'nothing reached a box');
  // Approved, it carries the engine to the machine that bills that provider.
  const r = await f.approved('paid');
  assert.equal(r.ok, true, r.text);
  assert.equal(f.sent[0].params.memberEngines, `claude-code,opencode=${OR}`);
  // A member with no such engine is not asked about, on the same fleet.
  const plain = fleet([['paid', ['claude-code', 'opencode'], ['openrouter']]], [{ engine: 'claude-code' }, { engine: 'opencode', model: 'github-copilot/gpt-5' }]);
  assert.equal((await plain.start('paid')).ok, true);
});

test('an admin who turns the guard off is not asked, and the engine goes to the machine as before', async () => {
  const f = fleet([['paid', ['claude-code', 'opencode'], ['openrouter']]], both);
  assert.equal(/** @type {any} */ (f.core.setBudgetSettings(eli, { paidApi: false })).ok, true);
  assert.equal(/** @type {any} */ (f.core.budgetsFor(eli)).settings.paidApi, false);
  assert.equal((await f.start('paid')).ok, true);
  assert.equal(f.sent[0].params.memberEngines, `claude-code,opencode=${OR}`);
});

test('a machine that does not report the provider is never sent the engine: it is left out and said, or the start is refused', async () => {
  // A box that runs OpenCode and bills nobody, and one that bills another provider.
  for (const [providers, bills] of /** @type {Array<[string[]|undefined, string]>} */ ([[undefined, ''], [['ai-gateway'], ', billing to ai-gateway']])) {
    const f = fleet([['other', ['claude-code', 'opencode'], providers]], both);
    const r = await f.approved('other');
    assert.equal(r.ok, true, r.text);
    assert.equal(f.sent[0].params.memberEngines, 'claude-code');
    assert.match(String(r.text), /other does not run opencode on OpenRouter, so Debbie has no engine to fall back to there: Claude Code\./);
    // When it was the member's only engine, nothing is sent.
    const only = fleet([['other', ['claude-code', 'opencode'], providers]], [{ engine: 'opencode', model: OR }]);
    const refused = await only.approved('other');
    assert.equal(refused.error?.code, 'no_engine');
    assert.equal(refused.text, `Debbie runs on OpenCode (${OR}), and other runs claude-code, opencode${bills}. Start it on a machine that runs one of its engines, or add one this machine runs to its record.`);
    assert.deepEqual(only.sent, []);
  }
});

test('a box from before API keys reports no provider and is never sent one, whatever protocol it speaks', async () => {
  // Protocol 21 with OpenCode installed: step 4's box. It would refuse the model itself; it is not asked to.
  const f = fleet([['step4', ['claude-code', 'opencode'], undefined, 21]], both);
  const r = await f.approved('step4');
  assert.equal(r.ok, true, r.text);
  assert.equal(f.sent[0].params.memberEngines, 'claude-code');
  // And a box that lists a provider nobody has heard of bills to nobody.
  const odd = fleet([['odd', ['claude-code', 'opencode'], ['acme']]], both);
  await odd.approved('odd');
  assert.equal(odd.sent[0].params.memberEngines, 'claude-code');
});
