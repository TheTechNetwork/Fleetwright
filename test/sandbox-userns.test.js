// The session's user namespace — the flag, where it goes, and when it cannot.
//
//   node --test test/
//
// Pure argv assembly, like sandbox.test.js: the container that would prove
// the mapping does not run in CI. What is pinned here is that the flag is
// `nomap` and not `auto` (podman chowns a volume only on first use, so `auto`'s
// per-container ranges would orphan a resumed workspace), that the socket
// mount carries `:U` only when the flag does, and that the two boxes where
// nomap cannot work fall back loudly rather than fail quietly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { usernsArgs, hookSocketMount, USERNS_MODES } from '../src/core/sandbox-userns.js';
import { resolveUserns } from '../src/config.js';
import { buildCommand } from '../src/core/claude.js';

/** @param {Partial<any>} patch @returns {any} */
const cfg = (patch = {}) => ({
  claudeBin: '/usr/local/bin/claude',
  remoteControl: true,
  skipPermissions: true,
  sandbox: true,
  podmanBin: 'podman',
  sandboxImage: 'localhost/agent-session:latest',
  sandboxMemory: '8g',
  sandboxCpus: '2',
  sandboxPidsLimit: '512',
  sandboxExtraArgs: [],
  sandboxHookSocket: true,
  sandboxHookSocketDir: '/run/agent-fleet',
  sandboxUserns: 'nomap',
  ...patch,
});

test('the two modes are nomap and host, and nomap is the one that separates', () => {
  assert.deepEqual([...USERNS_MODES], ['nomap', 'host']);
  assert.deepEqual(usernsArgs({ sandboxUserns: 'nomap' }), ['--userns=nomap']);
  assert.deepEqual(usernsArgs({ sandboxUserns: 'host' }), []);
  assert.deepEqual(usernsArgs({}), [], 'an unset mode is the old line, not a guess');
});

test('a session runs in its own namespace, and its socket is chowned to it', () => {
  const line = buildCommand(cfg(), { name: 'api' });
  assert.match(line, /'--userns=nomap'/);
  assert.match(line, /'\/run\/agent-fleet\/api\.sock:\/run\/hub\.sock:U'/, 'one inode, chowned to the session');
});

test('the host namespace is exactly the line every session ran before', () => {
  const line = buildCommand(cfg({ sandboxUserns: 'host' }), { name: 'api' });
  assert.ok(!line.includes('--userns'));
  assert.match(line, /'\/run\/agent-fleet\/api\.sock:\/run\/hub\.sock'/);
  assert.ok(!line.includes(':U'), 'no chown when the hub already owns what the session connects to');
});

test('hookSocketMount adds :U only under nomap', () => {
  assert.equal(hookSocketMount({ sandboxUserns: 'nomap' }, '/a/x.sock', '/run/hub.sock'), '/a/x.sock:/run/hub.sock:U');
  assert.equal(hookSocketMount({ sandboxUserns: 'host' }, '/a/x.sock', '/run/hub.sock'), '/a/x.sock:/run/hub.sock');
});

test('the operator refusal of --userns=host still stands beside the default', () => {
  // sandbox-args.js refuses `--userns=host` typed into AGENT_HUB_SANDBOX_ARGS.
  // That refusal was right against the wrong baseline — the default WAS host —
  // and it stays right now that the default is not: typing it would undo the
  // separation this file exists for.
  const line = buildCommand(cfg({ sandboxExtraArgs: ['--userns=keep-id'] }), { name: 'api' });
  assert.match(line, /'--userns=nomap'.*'--userns=keep-id'/, 'an operator argument still comes last and wins');
});

test('resolveUserns: nomap on a non-root box with podman', () => {
  assert.deepEqual(resolveUserns('nomap', 'podman', { uid: 1000 }), { mode: 'nomap', note: '' });
  assert.deepEqual(resolveUserns('nomap', '/usr/bin/podman', { uid: 1000 }), { mode: 'nomap', note: '' });
});

test('resolveUserns: root cannot have nomap, and is told why', () => {
  // "This option is not allowed for containers created by the root user."
  // design.md §10 recorded every hardware run as root, so this is the box
  // that exists.
  const r = resolveUserns('nomap', 'podman', { uid: 0 });
  assert.equal(r.mode, 'host');
  assert.match(r.note, /non-root service user/);
  assert.match(r.note, /container root IS/);
});

test('resolveUserns: docker has no nomap, and is told why', () => {
  const r = resolveUserns('nomap', 'docker', { uid: 1000 });
  assert.equal(r.mode, 'host');
  assert.match(r.note, /docker/);
  assert.equal(resolveUserns('nomap', '/usr/bin/docker', { uid: 1000 }).mode, 'host');
});

test('resolveUserns: host is honoured silently, nonsense is corrected loudly', () => {
  assert.deepEqual(resolveUserns('host', 'podman', { uid: 1000 }), { mode: 'host', note: '' });
  assert.deepEqual(resolveUserns('host', 'podman', { uid: 0 }), { mode: 'host', note: '' });
  const r = resolveUserns('auto', 'podman', { uid: 1000 });
  assert.equal(r.mode, 'nomap');
  assert.match(r.note, /auto is not a mode/);
});
