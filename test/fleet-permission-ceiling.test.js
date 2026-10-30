// The operator's FLEETWRIGHT_SKIP_PERMISSIONS, turned off, holds for every
// start that arrives from the fleet.
//
//   node --test test/fleet-permission-ceiling.test.js
//
// `start` has carried `mode` since protocol v1, and nothing on the host held a
// fleet start to the box's setting: an intent asking `dangerous` became
// `/new --dangerous`, and on a box whose operator had turned bypass off that
// ran `claude --dangerously-skip-permissions`. The phones and Siri send a
// kind's saved mode, so a kind saved as `dangerous` did that, as did any
// agent over MCP that asked; #1408 would have had every phone start send
// `dangerous`. See permissionCeiling in src/adapters/commands.js.
//
// Driven the whole way an intent goes on a box: the real sidecar translates
// it, the real hub-client posts it, the real HTTP adapter decides who sent it,
// dispatch runs `/new`, and what reaches the session manager is turned into
// claude's argv by the real buildCommand. Only the session manager is a stand-
// in, because starting tmux is not the question.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken, ensureSidecarToken } from '../src/core/api-token.js';
import { buildCommand } from '../src/core/claude.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const BYPASS = '--dangerously-skip-permissions';

/**
 * A box: the hub on loopback with both tokens, and a sidecar in front of it.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ skipPermissions: boolean, sidecarHolds?: 'sidecar'|'operator' }} opts
 *   `sidecarHolds: 'operator'` is a box whose sidecar fell back to the
 *   operator's token, which the hub cannot tell from the operator's console
 */
async function box(t, { skipPermissions, sidecarHolds = 'sidecar' }) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'perm-ceiling-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({
    stateDir, bind: '127.0.0.1', port: 0, token: '', hostname: 'testbox',
    workdir: path.join(stateDir, 'work'), maxSessions: 5, loginEnabled: true, sandbox: false, sandboxCredentialsFile: '',
    sandboxImage: 'x:latest', sandboxImagePinned: false, releaseChannel: '', rulesFile: path.join(stateDir, 'CLAUDE.md'),
    claudeBin: 'claude', remoteControl: false, skipPermissions,
  });
  /** @type {any[]} */
  const started = [];
  const sessions = /** @type {any} */ ({
    list: () => [], running: () => [], binned: () => [], peek: () => null,
    start: async (/** @type {any} */ opts) => {
      started.push(opts);
      return { ok: true, message: `Started "${opts.name}".` };
    },
  });
  const login = /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null });
  const operator = ensureApiToken(cfg);
  const sidecarToken = ensureSidecarToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions, login, token: operator, sidecarToken });
  await adapter.start();
  t.after(() => adapter.server?.close());
  const baseUrl = `http://127.0.0.1:${/** @type {any} */ (adapter.server).address().port}`;
  const hub = new HubClient({ baseUrl, token: sidecarHolds === 'operator' ? operator : sidecarToken, readTimeoutMs: 2000 });
  const sidecar = new Sidecar({ hub, transport: /** @type {any} */ ({ send() {}, onMessage() {} }), hostId: 'testbox', healthIntervalMs: 0, watch: false });
  /** @param {Record<string, unknown>} body */
  const post = (body) =>
    fetch(`${baseUrl}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operator}` },
      body: JSON.stringify(body),
    });
  let n = 0;
  return {
    started,
    sidecar,
    /** What claude would be run with, for the n-th start that got through. */
    argv: (/** @type {number} */ i) => buildCommand(cfg, { name: started[i].name, skipPermissions: started[i].skipPermissions }),
    /** @param {Record<string, string>} params @param {string|undefined} actor */
    start: (params, actor) =>
      sidecar.handle({
        v: PROTOCOL_VERSION, kind: 'intent', id: `idem-perm-${String(++n).padStart(4, '0')}`, verb: 'start', params,
        issuedAt: Date.now(), ...(actor ? { actor } : {}),
      }),
    /** The operator at the box: their token, no actor, as the console and the CLI send. */
    local: async (/** @type {string} */ line) => (await post({ command: line })).json(),
    /** A raw /api/command with the operator's token, for the shape of `via`. */
    post,
  };
}

test('on a box that asks, a fleet start asking to bypass is refused with the setting named, and nothing starts', async (t) => {
  // Each way the hub knows a line is the fleet's: the sidecar's own token, and
  // the sidecar saying so where it holds the operator's — with a person behind
  // the intent, and with nobody (the coordinator's admin token names no one).
  for (const sidecarHolds of /** @type {const} */ (['sidecar', 'operator'])) {
    for (const actor of ['eli@example.com', undefined]) {
      const b = await box(t, { skipPermissions: false, sidecarHolds });
      const r = /** @type {any} */ (await b.start({ name: 'job', mode: 'dangerous' }, actor));
      const which = `sidecar holds the ${sidecarHolds} token, actor ${actor ?? 'none'}`;
      assert.equal(r.ok, false, which);
      assert.match(r.text, /turned FLEETWRIGHT_SKIP_PERMISSIONS off/, which);
      assert.match(r.text, /cannot bypass/, which);
      assert.deepEqual(b.started, [], `nothing may reach the session manager (${which})`);
    }
  }
});

test('on the same box the box default and permission prompts on still start, and neither bypasses', async (t) => {
  const b = await box(t, { skipPermissions: false });
  assert.equal(/** @type {any} */ (await b.start({ name: 'plain' }, 'eli@example.com')).ok, true);
  assert.equal(/** @type {any} */ (await b.start({ name: 'careful', mode: 'safe' }, 'eli@example.com')).ok, true);
  assert.equal(b.started.length, 2);
  assert.ok(!b.argv(0).includes(BYPASS), 'no mode is the box default, which asks');
  assert.ok(!b.argv(1).includes(BYPASS));
});

test('the operator at the box can still start one session that bypasses', async (t) => {
  const b = await box(t, { skipPermissions: false });
  const r = await b.local('/new mine --dangerous');
  assert.equal(r.ok, true, r.text);
  assert.ok(b.argv(0).includes(BYPASS));
});

test('on a box that bypasses, a fleet start may still ask to bypass', async (t) => {
  const b = await box(t, { skipPermissions: true });
  const r = /** @type {any} */ (await b.start({ name: 'job', mode: 'dangerous' }, 'eli@example.com'));
  assert.equal(r.ok, true, r.text);
  assert.ok(b.argv(0).includes(BYPASS));
});

test('health says which of the two a start with no mode gets', async (t) => {
  // What a phone labels "Box default" from, and offers "Permissions bypassed"
  // on. A hub too old to say leaves it null (factsFrom), never a guess.
  const asks = await box(t, { skipPermissions: false });
  assert.equal((await asks.sidecar.health()).permissions, 'asks');
  const bypassed = await box(t, { skipPermissions: true });
  assert.equal((await bypassed.sidecar.health()).permissions, 'bypassed');
});

test('via is the one word "fleet" or absent, and any other value is refused rather than read as from this box', async (t) => {
  // The field only takes something away, so a value that is nearly "fleet" and
  // treated as absent would hand back the bypass the sidecar meant to give up.
  const b = await box(t, { skipPermissions: false });
  for (const via of ['web', 'FLEET', '', 1, true, {}, ['fleet']]) {
    const r = await b.post({ command: '/list', via });
    assert.equal(r.status, 400, `via ${JSON.stringify(via)}`);
  }
  for (const via of [null, 'fleet']) {
    const r = await b.post({ command: '/list', via });
    assert.equal(r.status, 200, `via ${JSON.stringify(via)}`);
  }
});
