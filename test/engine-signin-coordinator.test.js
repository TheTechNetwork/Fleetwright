// Signing an engine in on a machine, in the coordinator (docs/engines.md,
// "Signing in on the machine"): what it refuses in a person's words before
// anything is sent, what it passes on, who is shown which machine's
// sign-ins, and who is told when an attempt ends.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const eli = { email: 'eli@example.com', admin: true };

/** A fleet with the boxes given, each speaking a protocol and reporting engines, and the agent Debbie. */
function fleet(/** @type {Array<[string, number, string[]|undefined]>} */ boxes) {
  const core = new CoordinatorCore({});
  assert.equal(core.setMember(eli, 'eli', { name: 'Eli', kind: 'person', email: eli.email, role: 'owner' }).ok, true);
  assert.equal(core.setMember(eli, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'eli', engines: [{ engine: 'codex' }] }).ok, true);
  for (const [hostId, protocol, runs] of boxes) {
    core.registry.connect(hostId, () => {});
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [], ...(runs ? { engines: runs } : {}) });
  }
  /** @type {Array<{ hostId: string, verb: string, params: any }>} */
  const sent = [];
  /** What the box answers; a test replaces it. @type {{ reply: any }} */
  const box = { reply: { ok: true, state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', text: 'Open the page.' } };
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    sent.push({ hostId: host.hostId, verb: spec.verb, params: spec.params });
    return { ...box.reply, hostId: host.hostId };
  });
  const signin = (/** @type {string} */ host, /** @type {any} */ params = {}, /** @type {any} */ who = eli) =>
    core.dispatch({ verb: 'enginesignin', params: { member: 'debbie', engine: 'codex', action: 'start', ...params }, actor: who.email, requester: who, ...(host ? { preferHost: host } : {}) });
  return { core, sent, box, signin };
}

test('a box older than protocol 22 is refused a sign-in by name, as a machine to update, and is sent nothing', async () => {
  const { sent, signin } = fleet([['box-21', 21, ['claude-code', 'codex']], ['box-22', PROTOCOL_VERSION, ['claude-code', 'codex']]]);
  for (const action of ['start', 'status', 'cancel', 'signout']) {
    const r = await signin('box-21', { action });
    assert.equal(r.error?.code, 'host_outdated', action);
    assert.equal(r.text, 'box-21 is too old to sign an engine in. It speaks protocol 21, and this needs 22. Update fleetwright on box-21, or pick another machine.');
  }
  assert.deepEqual(sent, []);
  const now = await signin('box-22');
  assert.equal(now.ok, true, now.text);
  assert.deepEqual(sent, [{ hostId: 'box-22', verb: 'enginesignin', params: { member: 'debbie', engine: 'codex', action: 'start' } }]);
});
