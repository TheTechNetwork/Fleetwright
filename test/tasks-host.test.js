// A task on the box's own session manager (docs/tasks.md): the door a start
// on a task comes through, and the record that lets the watcher say which
// task a session coming back was work on.
//
// What the box composes for the session is test/vault.test.js ("a session on
// a task…"), through a real sidecar; what the watcher reads and sends is
// test/watcher.test.js. This file is the hop between them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';

/**
 * The hub on loopback, with a session manager that starts nothing and keeps
 * what it was asked to record.
 *
 * @param {import('node:test').TestContext} t
 */
async function hub(t) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'tasks-host-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({
    stateDir, bind: '127.0.0.1', port: 0, token: '', hostname: 'testbox',
    workdir: path.join(stateDir, 'work'), maxSessions: 5, loginEnabled: true, sandbox: false, sandboxCredentialsFile: '',
    sandboxImage: 'x:latest', sandboxImagePinned: false, releaseChannel: '', rulesFile: path.join(stateDir, 'CLAUDE.md'),
    claudeBin: 'claude', remoteControl: false, skipPermissions: false,
  });
  /** @type {any[]} */
  const started = [];
  /** @type {Array<{ name: string, patch: any }>} */
  const recorded = [];
  const sessions = /** @type {any} */ ({
    list: () => [], running: () => [], binned: () => [], peek: () => null,
    registry: { upsert: (/** @type {string} */ name, /** @type {any} */ patch) => void recorded.push({ name, patch }) },
    start: async (/** @type {any} */ opts) => {
      started.push(opts);
      return { ok: true, message: `Started "${opts.name}".`, session: { name: opts.name, status: 'running' } };
    },
  });
  const login = /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null });
  const token = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions, login, token });
  await adapter.start();
  t.after(() => adapter.server?.close());
  const baseUrl = `http://127.0.0.1:${/** @type {any} */ (adapter.server).address().port}`;
  /** @param {Record<string, unknown>} body */
  const command = async (body) => {
    const res = await fetch(`${baseUrl}/api/command`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, body: /** @type {any} */ (await res.json()) };
  };
  return { started, recorded, command };
}

test('a start on a task records the task’s id and branch on the session, and none of its words', async (t) => {
  const { started, recorded, command } = await hub(t);
  const r = await command({ command: '/new on-t12', task: 'Task t12. Branch task/t12-fix-it.\n\nFix it.', taskId: 't12', taskBranch: 'task/t12-fix-it', member: 'debbie', actor: 'fleet:debbie@members.invalid' });
  assert.equal(r.body.ok, true, r.body.text);
  assert.equal(started.length, 1);
  assert.deepEqual(recorded.find((x) => 'taskId' in x.patch), { name: 'on-t12', patch: { taskId: 't12', taskBranch: 'task/t12-fix-it' } });
  assert.ok(!JSON.stringify(recorded).includes('Fix it.'), 'the record keeps which task, never what it said');

  // A start on no task records none.
  recorded.length = 0;
  assert.equal((await command({ command: '/new plain', task: 'Just this.' })).body.ok, true);
  assert.deepEqual(recorded.filter((x) => 'taskId' in x.patch), []);
});

test('the door takes a task’s id and branch only in their own shapes', async (t) => {
  const { started, command } = await hub(t);
  for (const bad of [{ taskId: '12' }, { taskId: 't0' }, { taskId: 't12; rm -rf' }, { taskId: 't12', taskBranch: 'main' }, { taskId: 't12', taskBranch: 'task/t12/../../x' }, { taskId: 12 }]) {
    const r = await command({ command: '/new nope', task: 'x', ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.text, /^task(Id|Branch) is not in the form this accepts$/);
  }
  assert.deepEqual(started, []);
});
