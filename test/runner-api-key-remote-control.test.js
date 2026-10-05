// A runner session is told it has no Remote Control, without waiting.
//
// Remote Control needs a full-scope claude.ai login and a runner never has
// one: its repository's ANTHROPIC_API_KEY is not a claude.ai login, and its
// owner's kept login is a setup-token that can only make model requests. The
// start waited twice the Remote Control timeout before answering "remote
// control did not come online after retry" about a session that was running
// and could never have had a link.
// Seen on gha-TheTechNetwork-Fleetwright-Runners-…-1, whose pane read
// "Sonnet 5.5 · Claude API" above an empty prompt.
//
// Driven through a real tmux, because the wait is the bug: a fake pane would
// answer whatever the test told it to and prove nothing about how long the
// start took.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';
import { saveRunnerLogin } from '../src/core/runner-login.js';
import { killSession } from '../src/core/tmux.js';

const tmux = spawnSync('tmux', ['-V']).status === 0;

test('a runner session says at once that it has no Remote Control, on the key or a setup-token', { skip: !tmux && 'needs tmux' }, async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-key-rc-'));
  const name = `cc-keyrc-${process.pid}`;
  t.after(() => {
    killSession(name);
    rmSync(dir, { recursive: true, force: true });
  });
  // A claude that sits at its prompt and never prints a Remote Control link,
  // which is what the real one does on an API key.
  const bin = path.join(dir, 'claude');
  // It also writes down what it was launched with, so the test can see
  // whether the host still asked it for Remote Control.
  const argsDir = path.join(dir, 'args');
  writeFileSync(bin, `#!/bin/sh\nmkdir -p '${argsDir}'\necho "$*" > '${argsDir}'/$$\necho "Claude API"\nexec sleep 60\n`);
  chmodSync(bin, 0o755);
  const RC_TIMEOUT = 4000;
  const cfg = /** @type {any} */ ({
    stateDir: path.join(dir, 'state'),
    profileDir: path.join(dir, 'profiles'),
    workdir: path.join(dir, 'work'),
    stateFile: path.join(dir, 'state.json'),
    spoolFile: path.join(dir, 'spool'),
    hostname: 'gha-1',
    sandbox: false,
    claudeBin: bin,
    remoteControl: true,
    rcTimeoutMs: RC_TIMEOUT,
    rcRequired: false,
    skipPermissions: false,
    maxSessions: 5,
  });

  // A runner whose owner keeps no Claude login, with a key in its environment.
  assert.equal(saveRunnerLogin(cfg, { email: 'owner@example.com', login: 'owner', token: null }).ok, true);
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-runner-repository-key-000000000000';
  t.after(() => { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; });

  /** What every claude launched so far was started with. */
  const launched = async () => {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    for (let i = 0; i < 50 && !existsSync(argsDir); i++) await new Promise((r) => setTimeout(r, 20));
    return existsSync(argsDir) ? readdirSync(argsDir).map((f) => readFileSync(path.join(argsDir, f), 'utf8')) : [];
  };

  const sm = new SessionManager(cfg, new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile }), null);
  const began = Date.now();
  const reply = await sm.start({ name, actor: 'fleet:owner@example.com' });
  const took = Date.now() - began;

  assert.equal(reply.ok, true, reply.message);
  assert.match(reply.message, /runner repository’s API key, and an API key cannot open Remote Control/, reply.message);
  // Started with neither a task nor a profile: nothing can ever give it work,
  // and it says how to start one that has a job.
  assert.match(reply.message, /start it again with a task/);
  assert.doesNotMatch(reply.message, /did not come online/);
  // Before: two full timeouts, 8 s here. A second is generous for a tmux spawn.
  assert.ok(took < RC_TIMEOUT, `waited ${took} ms for a link an API key cannot have`);
  // AND NOT ASKED FOR. The CLI used to be launched with --remote-control
  // regardless, on a credential that cannot open it.
  assert.ok(!(await launched()).some((a) => a.includes('--remote-control')), 'a runner session was launched with --remote-control');

  // THE OWNER'S KEPT LOGIN IS NO DIFFERENT. It is a setup-token, which can
  // make model requests and cannot open Remote Control either, so keeping one
  // changes who pays and not whether there is a link.
  const owned = `${name}-own`;
  t.after(() => killSession(owned));
  assert.equal(saveRunnerLogin(cfg, { email: 'owner@example.com', login: 'owner', token: 'sk-ant-oat01-' + 'x'.repeat(40) }).ok, true);
  const began2 = Date.now();
  const second = await sm.start({ name: owned, actor: 'fleet:owner@example.com' });
  assert.equal(second.ok, true, second.message);
  assert.match(second.message, /Claude token from `claude setup-token`, which can make model requests but cannot open Remote Control/, second.message);
  assert.ok(Date.now() - began2 < RC_TIMEOUT, 'it waited for a link a setup-token cannot open');
  for (let i = 0; i < 50 && (await launched()).length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((await launched()).length, 2);
  assert.ok(!(await launched()).some((a) => a.includes('--remote-control')), 'a setup-token session was launched with --remote-control');

});

test('on a runner no session asks for Remote Control, a linked login included; elsewhere a linked one still does', async () => {
  const { noRemoteControl } = await import('../src/core/runner-auth-words.js');
  assert.match(String(noRemoteControl('linked', true)), /runs on a runner, which does its task and ends without Remote Control/);
  assert.match(String(noRemoteControl(null, true)), /runs on a runner/);
  // What it runs on is still the more specific reason.
  assert.match(String(noRemoteControl('token', true)), /setup-token/);
  assert.equal(noRemoteControl('linked', false), null);
  assert.equal(noRemoteControl(null), null);
});
