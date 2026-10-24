// A session started with a task has it as its first message, word for word.
//
// Protocol v7 let `start` carry a `task`, so a caller can say "build the Mac
// app, run its tests, report" and the session starts on it — a runner is
// minutes old and has no profile to name, and every session started there came
// up idle. The words cross three hops on a box (sidecar → hub HTTP → session
// manager → the CLI's argv), and each hop has a way to lose them: the command
// line is split on spaces, cleanText joins lines, a dropped field starts the
// session idle while the reply says it started.
//
// So this drives the hub's own HTTP door into a real session manager and a
// real tmux, with a `claude` that writes down the last argument it was given,
// and reads that back.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';
import { killSession } from '../src/core/tmux.js';
import { toCommandLine, commandMeta } from '../src/fleet/host/sidecar.js';

const tmux = spawnSync('tmux', ['-V']).status === 0;

/** @param {() => boolean} ok @param {number} ms */
const until = async (ok, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (ok()) return true;
  return ok();
};

test('the sidecar carries a task beside the command line, never in it', () => {
  const task = 'Build ./app --release\nthen run its tests';
  const intent = { verb: 'start', params: { name: 'build1', task }, actor: 'e@example.com' };
  // A task that reads like a flag must not become one: the line is split on spaces.
  assert.equal(toCommandLine(intent), '/new build1');
  assert.equal(commandMeta('start', intent.params, 'fleet:e@example.com').task, task);
  assert.equal('task' in commandMeta('start', { name: 'idle1' }), false);
});

test('a task reaches the session as its first message, newlines and all', { skip: !tmux && 'needs tmux' }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-task-'));
  /** @type {string[]} */
  const names = [];
  // A TMUX SERVER OF ITS OWN. Without one this shares the box's default
  // server with every other run of this file (two worktrees, a verify.sh beside
  // a focused run): the second run is refused "duplicate session: build1", its
  // cleanup kills the first run's session before that claude has written
  // anything, and the session manager adopts every other run's session and
  // hits its cap. Six concurrent runs failed 30 of 30 that way. TMUX_TMPDIR
  // moves the socket into this test's directory; TMUX would override it from
  // inside a tmux pane, so it goes for the duration.
  const env = { TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX };
  process.env.TMUX_TMPDIR = dir;
  delete process.env.TMUX;
  t.after(() => {
    for (const n of names) killSession(n);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  });
  // A claude that writes down the last argument it was started with, which is
  // where buildCommand puts the first message, then waits like a prompt.
  //
  // It writes beside the file and renames it into place, so `said` exists only
  // once it is whole. A plain `> said` creates the file before printf fills
  // it, and a reader polling for existence then reads it empty: measured, a
  // tight poll caught it between the two in 289 of 500 runs.
  const said = path.join(dir, 'said');
  const bin = path.join(dir, 'claude');
  writeFileSync(bin, `#!/bin/sh\nfor a; do last="$a"; done\nprintf '%s' "$last" > '${said}.part'\nmv '${said}.part' '${said}'\nexec sleep 60\n`);
  chmodSync(bin, 0o755);
  const cfg = /** @type {any} */ ({
    stateDir: path.join(dir, 'state'),
    profileDir: path.join(dir, 'profiles'),
    workdir: path.join(dir, 'work'),
    stateFile: path.join(dir, 'state.json'),
    spoolFile: path.join(dir, 'spool'),
    bind: '127.0.0.1',
    port: 0,
    token: '',
    hostname: 'testbox',
    sandbox: false,
    claudeBin: bin,
    remoteControl: false,
    skipPermissions: true,
    maxSessions: 5,
    loginEnabled: true,
    sandboxCredentialsFile: '',
  });
  // A Claude login from their vault, so a session on this box has someone to run as.
  const { applyVault } = await import('../src/core/vault-store.js');
  applyVault(cfg, { accounts: [{ email: 'e@example.com', items: [{ name: 'claude', value: 'sk-ant-oat01-x' }] }] });

  const registry = new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile });
  const sessions = new SessionManager(cfg, registry, null);
  const login = /** @type {any} */ ({ status: () => ({ loggedIn: false }), isPending: () => false, pending: null });
  const token = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions, login, token });
  await adapter.start();
  t.after(() => adapter.server?.close());
  const port = /** @type {any} */ (adapter.server).address().port;
  /** @param {Record<string, unknown>} body */
  const command = async (body) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ actor: 'fleet:e@example.com', ...body }),
    });
    return { status: r.status, body: /** @type {any} */ (await r.json()) };
  };

  const task = 'Build the macOS app in ./app.\n\n  Run its tests --verbose, and say which failed.';
  names.push('build1');
  const started = await command({ command: '/new build1', task });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.ok, true, started.body.text);
  assert.match(started.body.text, /Started on the task it was given/);
  assert.equal(/IT STARTED IDLE/.test(started.body.text), false);

  assert.ok(await until(() => existsSync(said), 5000), 'the session never started');
  assert.equal(readFileSync(said, 'utf8'), task, 'the words the session was given are not the words that were sent');
  // The record says it had a job, for the watcher, and keeps none of the words.
  const rec = registry.get('build1');
  assert.equal(rec?.tasked, true);
  assert.equal(JSON.stringify(rec).includes('macOS app'), false, 'the record is what list and status serve');

  // Two first messages is one too many, and nothing starts.
  mkdirSync(cfg.profileDir, { recursive: true });
  writeFileSync(path.join(cfg.profileDir, 'p.md'), 'Review the open PRs.');
  const both = await command({ command: '/new both1', task: 'do it', profile: 'p' });
  assert.equal(both.body.ok, false);
  assert.match(both.body.text, /a task or a profile, not both/);
  assert.equal(registry.get('both1') ?? null, null);

  // The door refuses what it cannot pass on intact.
  assert.equal((await command({ command: '/new nul1', task: 'a\0b' })).status, 400);
  assert.equal((await command({ command: '/new big1', task: 'x'.repeat(8001) })).status, 400);
  assert.equal((await command({ command: '/new num1', task: 7 })).status, 400);
});
