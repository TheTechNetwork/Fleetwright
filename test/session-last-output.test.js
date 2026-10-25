// What a sandboxed session printed, kept when it ends on its own.
//
//   node --test test/session-last-output.test.js
//
// cc-trusty-egret on vnic-runner-oci died within three seconds of every
// resume, a dozen times, and nothing could say why: its container ran with
// `--rm`, so the output went with it, and the pane closed with the container.
// It runs without `--rm` now; reconcile keeps the end of what it printed and
// removes it, and `logs` reads that back. A stop still discards it, as it has
// always said it does.
//
// Real binaries on PATH, as test/blank-pane.test.js has them: `podman` and
// `tmux` stand-ins that keep their state in files, so the calls are the ones
// src/core/podman.js and tmux.js actually build.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';
import { readSessionLogs } from '../src/core/logs.js';
import { lastOutputPath } from '../src/core/podman.js';

/** @param {string} dir @param {string} name @param {string} body */
function stub(dir, name, body) {
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

/**
 * A box whose session `name` is recorded as running, with a container that
 * printed `printed` and exited with `status`, and a pane that is `alive` or not.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ name: string, printed: string, status: number, alive: boolean }} o
 */
function box(t, { name, printed, status, alive }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'last-output-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'printed.txt');
  writeFileSync(out, printed);
  const gone = path.join(dir, 'removed');
  const calls = path.join(dir, 'calls');
  // `container exists` until `rm -f`; `logs` and `inspect` answer as podman does.
  const podmanBin = stub(dir, 'podman', `
echo "$*" >> ${JSON.stringify(calls)}
case "$1" in
  container) [ -e ${JSON.stringify(gone)} ] && exit 1 ; exit 0 ;;
  logs) [ -e ${JSON.stringify(gone)} ] && exit 125 ; cat ${JSON.stringify(out)} ; exit 0 ;;
  inspect) echo ${status} ; exit 0 ;;
  rm) touch ${JSON.stringify(gone)} ; exit 0 ;;
  *) exit 0 ;;
esac`);
  const panes = path.join(dir, 'panes');
  writeFileSync(panes, alive ? `${name}\n` : '');
  stub(dir, 'tmux', `
case "$1" in
  list-sessions) cat ${JSON.stringify(panes)} ; exit 0 ;;
  has-session) grep -qx "\${3#=}" ${JSON.stringify(panes)} ; exit $? ;;
  kill-session) : > ${JSON.stringify(panes)} ; exit 0 ;;
  *) exit 0 ;;
esac`);
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  t.after(() => { process.env.PATH = before; });

  const cfg = /** @type {any} */ ({ stateDir: dir, workdir: dir, maxSessions: 5, sandbox: true, podmanBin, binTtlMs: 0 });
  const registry = new Registry({ stateFile: path.join(dir, 'state.json'), spoolFile: path.join(dir, 'spool.jsonl') });
  registry.upsert(name, { status: 'running', cwd: dir, createdBy: 'fleet:eli@example.com' });
  const sessions = new SessionManager(cfg, registry, null);
  return { cfg, registry, sessions, removed: () => existsSync(gone), calls: () => readFileSync(calls, 'utf8') };
}

test('a session that ended on its own keeps what it printed, and logs says why after its container is gone', (t) => {
  const b = box(t, { name: 'trusty', printed: 'No conversation found with session ID: 063ab304\n', status: 1, alive: false });

  b.sessions.reconcile();
  assert.equal(b.registry.get('trusty')?.status, 'stopped');
  assert.ok(b.removed(), 'its container is removed once what it printed is kept');

  const said = readSessionLogs(b.cfg, 'trusty');
  assert.equal(said.ok, true, said.text);
  assert.equal(said.text, 'What trusty printed before it ended:\nIt exited with status 1.\nNo conversation found with session ID: 063ab304');
});

test('a stop discards the container and keeps nothing, as a stop always has', (t) => {
  const b = box(t, { name: 'asked', printed: 'working on it\n', status: 0, alive: true });

  const stopped = b.sessions.stop({ name: 'asked', actor: 'fleet:eli@example.com' });
  assert.equal(stopped.ok, true, stopped.message);
  assert.ok(b.removed(), 'a container that runs without --rm is removed by the stop');
  assert.equal(existsSync(lastOutputPath(b.cfg, 'asked')), false);
  assert.match(b.calls(), /^rm -f agent-asked$/m);
});
