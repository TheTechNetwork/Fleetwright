// The session's user namespace — the flag, where it goes, and when it cannot.
//
//   node --test test/
//
// Pure argv assembly, like sandbox.test.js: the container that would prove
// the mapping does not run in CI. What is pinned here is that the flag is
// `nomap` and not `auto` (podman chowns a volume only on first use, so `auto`'s
// per-container ranges would orphan a resumed workspace), that the socket
// mount chowns nothing under either flag, and that the two boxes where nomap
// cannot work fall back loudly rather than fail quietly.

import test from 'node:test';
import assert from 'node:assert/strict';

import { usernsArgs, USERNS_MODES } from '../src/core/sandbox-userns.js';
import { resolveUserns } from '../src/config.js';
import { buildCommand } from '../src/core/claude.js';

/** @param {Partial<any>} patch @returns {any} */
const cfg = (patch = {}) => ({
  claudeBin: '/usr/local/bin/claude',
  remoteControl: true,
  skipPermissions: true,
  sandbox: true,
  podmanBin: 'podman',
  sandboxImage: 'localhost/fleetwright-session:latest',
  sandboxMemory: '8g',
  sandboxCpus: '2',
  sandboxPidsLimit: '512',
  sandboxExtraArgs: [],
  sandboxHookSocket: true,
  sandboxHookSocketDir: '/run/fleetwright-sidecar',
  sandboxUserns: 'nomap',
  ...patch,
});

test('the two modes are nomap and host, and nomap is the one that separates', () => {
  assert.deepEqual([...USERNS_MODES], ['nomap', 'host']);
  assert.deepEqual(usernsArgs({ sandboxUserns: 'nomap' }), ['--userns=nomap']);
  assert.deepEqual(usernsArgs({ sandboxUserns: 'host' }), []);
  assert.deepEqual(usernsArgs({}), [], 'an unset mode is the old line, not a guess');
});

test('a session runs in its own namespace, and its socket directory is not chowned to it', () => {
  // `:U` used to chown the socket to the session, and the hub, no longer its
  // owner, could not make it again after a restart. The session now connects
  // through permission bits — see HookSocketServer.open.
  const line = buildCommand(cfg(), { name: 'api' });
  assert.match(line, /'--userns=nomap'/);
  assert.match(line, /'\/run\/fleetwright-sidecar\/api:\/run\/hub'/);
  assert.ok(!line.includes(':U'));
});

test('the host namespace mounts the same directory', () => {
  const line = buildCommand(cfg({ sandboxUserns: 'host' }), { name: 'api' });
  assert.ok(!line.includes('--userns'));
  assert.match(line, /'\/run\/fleetwright-sidecar\/api:\/run\/hub'/);
  assert.ok(!line.includes(':U'));
});

test('the operator refusal of --userns=host still stands beside the default', () => {
  // sandbox-args.js refuses `--userns=host` typed into FLEETWRIGHT_SANDBOX_ARGS.
  // That refusal was right against the wrong baseline — the default WAS host —
  // and it stays right now that the default is not: typing it would undo the
  // separation this file exists for.
  const line = buildCommand(cfg({ sandboxExtraArgs: ['--userns=keep-id'] }), { name: 'api' });
  assert.match(line, /'--userns=nomap'.*'--userns=keep-id'/, 'an operator argument still comes last and wins');
});

test('resolveUserns: nomap on a non-root box with podman', () => {
  assert.deepEqual(resolveUserns('nomap', 'podman', { uid: 1000 }), { mode: 'nomap', note: '', forcedBy: null, blockedBy: [] });
  assert.deepEqual(resolveUserns('nomap', '/usr/bin/podman', { uid: 1000 }), { mode: 'nomap', note: '', forcedBy: null, blockedBy: [] });
});

test('resolveUserns: root cannot have nomap, and is told why', () => {
  // "This option is not allowed for containers created by the root user."
  // design.md §10 recorded every hardware run as root, so this is the box
  // that exists.
  const r = resolveUserns('nomap', 'podman', { uid: 0 });
  assert.equal(r.mode, 'host');
  assert.match(r.note, /non-root service user/);
  assert.match(r.note, /container root IS/);
  // Which downgrade, because the box tells the fleet (http.js uncontained),
  // and the way on is the operator's: install.sh keeps whoever ran it, so
  // the note does not say the installer already made a user.
  assert.equal(r.forcedBy, 'root');
  assert.match(r.note, /its own non-root user/);
  assert.match(r.note, /from a root shell is root/);
});

test('resolveUserns: docker has no nomap, and is told why', () => {
  const r = resolveUserns('nomap', 'docker', { uid: 1000 });
  assert.equal(r.mode, 'host');
  assert.match(r.note, /docker/);
  assert.equal(r.forcedBy, 'docker');
  assert.equal(resolveUserns('nomap', '/usr/bin/docker', { uid: 1000 }).mode, 'host');
});

test('resolveUserns: root with docker is forced by root, and docker is still there after', () => {
  // Running fleetwright as its own user leaves docker downgrading nomap, so
  // both are named, root first because it decided the mode.
  const r = resolveUserns('nomap', 'docker', { uid: 0 });
  assert.equal(r.mode, 'host');
  assert.equal(r.forcedBy, 'root');
  assert.deepEqual(r.blockedBy, ['root', 'docker']);
  assert.match(r.note, /non-root service user/);
  assert.match(r.note, /docker, which has no --userns=nomap/);
});

test('resolveUserns: host is honoured silently, nonsense is corrected loudly', () => {
  assert.deepEqual(resolveUserns('host', 'podman', { uid: 1000 }), { mode: 'host', note: '', forcedBy: null, blockedBy: [] });
  // Honoured, and what nomap would meet here is still known: root, which
  // setting nomap back runs into, and the box says both (http.js uncontained).
  assert.deepEqual(resolveUserns('host', 'podman', { uid: 0 }), { mode: 'host', note: '', forcedBy: null, blockedBy: ['root'] });
  assert.deepEqual(resolveUserns('host', 'docker', { uid: 1000 }).blockedBy, ['docker']);
  const r = resolveUserns('auto', 'podman', { uid: 1000 });
  assert.equal(r.mode, 'nomap');
  assert.match(r.note, /auto is not a mode/);
});

test('a box whose sessions run in the host namespace says on every start that members are refused there', async () => {
  // It reports itself as not containing a session (http.js uncontained), so
  // the fleet stops starting or resuming a member's session there; on a box
  // that took everyone's work, that changed with an update and said nothing.
  // Whether the namespace was asked for or fallen back to, the box says so.
  const { loadConfig, validateConfig } = await import('../src/config.js');
  const warned = (/** @type {Record<string, string>} */ env) =>
    validateConfig(loadConfig({ PATH: process.env.PATH ?? '', ...env })).warnings.filter((w) => /refuses other members/.test(w));
  assert.equal(warned({ FLEETWRIGHT_SANDBOX: '1', FLEETWRIGHT_SANDBOX_USERNS: 'host' }).length, 1);
  assert.equal(warned({ FLEETWRIGHT_SANDBOX: '1', FLEETWRIGHT_PODMAN_BIN: 'docker' }).length, 1);
  assert.match(warned({ FLEETWRIGHT_SANDBOX: '1', FLEETWRIGHT_SANDBOX_USERNS: 'host' })[0], /only for its admin, or the one person the box works for/);
  // No sandbox is not this line's to say: that box was never contained.
  assert.deepEqual(warned({ FLEETWRIGHT_SANDBOX_USERNS: 'host' }), []);
});
