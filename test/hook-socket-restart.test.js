// A session that outlives a hub restart still gets its GitHub credential.
//
// It did not. Every session kept running through a hub update (KillMode=process
// is for exactly that), and every one lost GitHub: git and gh inside it failed
// until somebody restarted the session. The credential broker is on the
// session's hook socket, the socket was bind-mounted as a FILE, and a file
// mount holds the inode. The hub that came back made a new socket the
// container could never see, and only for a session it was launching.
//
// So the container here holds what podman's mount holds now, the session's
// DIRECTORY: an open descriptor on it, reached through /proc/self/fd, which
// resolves to that inode the way the mount does and not to whatever has the
// name later. The first hub stops, a second one starts on the same state, and
// the same path inside the "container" has to answer with the token as it is
// now. Real tmux for "is this session still running", because that is how the
// hub decides which sessions to listen for again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, openSync, closeSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { HookSocketServer, SOCKET_FILE } from '../src/core/hook-socket.js';
import { CREDENTIAL_PATH } from '../src/core/credential-broker.js';
import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';
import { killSession } from '../src/core/tmux.js';
import { buildCommand } from '../src/core/claude.js';

const tmux = spawnSync('tmux', ['-V']).status === 0;
const proc = existsSync('/proc/self/fd');

/**
 * What git's credential helper does inside the container: ask for GitHub on
 * whatever socket it was handed.
 * @param {string} socketPath
 * @returns {Promise<{ status: number|null, body: any, error?: string }>}
 */
function askForGitHub(socketPath) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ provider: 'github' });
    const req = httpRequest(
      { socketPath, method: 'POST', path: CREDENTIAL_PATH, headers: { 'content-type': 'application/json', host: 'hub', 'content-length': Buffer.byteLength(payload) }, timeout: 3000 },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? null, body: JSON.parse(text || 'null') }));
      },
    );
    req.on('error', (e) => resolve({ status: null, body: null, error: /** @type {NodeJS.ErrnoException} */ (e).code || e.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(payload);
  });
}

test('a running session gets GitHub again from the hub that replaced the one it started under', { skip: (!tmux && 'needs tmux') || (!proc && 'needs /proc') }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fw-hubsock-'));
  const name = `cc-hubsock-${process.pid}`;
  t.after(() => {
    killSession(name);
    rmSync(root, { recursive: true, force: true });
  });
  const cfg = /** @type {any} */ ({
    stateDir: path.join(root, 'state'),
    stateFile: path.join(root, 'state.json'),
    spoolFile: path.join(root, 'spool'),
    workdir: root,
    sandbox: true,
    sandboxHookSocket: true,
    sandboxHookSocketDir: path.join(root, 'hook-sockets'),
    maxSessions: 5,
  });
  // The token as the box holds it at the moment of asking. Rotated below, while
  // no hub is running, so the answer afterwards proves it was read again.
  let token = 'ghu_before_the_restart';
  /** @param {Registry} registry */
  const hub = (registry) => {
    const hooks = new HookSocketServer({
      dir: cfg.sandboxHookSocketDir,
      onSessionStart: () => ({ ok: true }),
      secretsFor: () => ({ GH_TOKEN: token }),
      logger: { info: () => {}, warn: () => {} },
    });
    return { hooks, sessions: new SessionManager(cfg, registry, hooks) };
  };

  // THE FIRST HUB launches the session: its socket, its record, its pane.
  const registry = new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile });
  const first = hub(registry);
  await first.hooks.open(name);
  registry.upsert(name, { status: 'running', createdBy: 'fleet:owner@example.com', cwd: root });
  assert.equal(spawnSync('tmux', ['new-session', '-d', '-s', name, 'sleep 60']).status, 0);

  // The container's mount of /run/hub: the session's directory, held.
  const held = openSync(first.hooks.sessionDir(name), 'r');
  t.after(() => closeSync(held));
  const inside = `/proc/self/fd/${held}/${SOCKET_FILE}`;

  const before = await askForGitHub(inside);
  assert.equal(before.status, 200, JSON.stringify(before));
  assert.equal(before.body.env.GH_TOKEN, 'ghu_before_the_restart');

  // THE HUB GOES AWAY. The session does not.
  await first.hooks.closeAll();
  const during = await askForGitHub(inside);
  assert.equal(during.status, null, 'nothing answers while no hub is running');
  token = 'ghu_after_the_restart';

  // THE NEXT HUB, on the same state, as src/index.js starts it.
  const second = hub(new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile }));
  t.after(() => second.hooks.closeAll());
  assert.deepEqual(await second.sessions.reopenHookSockets(), [name]);

  const after = await askForGitHub(inside);
  assert.equal(after.status, 200, `the running session is still cut off: ${JSON.stringify(after)}`);
  assert.equal(after.body.env.GH_TOKEN, 'ghu_after_the_restart', 'read when asked, not when the hub started');
});

test('a session that is not running is not listened for, and a launch still opens it', { skip: !tmux && 'needs tmux' }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fw-hubsock-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'hook-sockets');
  const cfg = /** @type {any} */ ({ stateDir: root, stateFile: path.join(root, 'state.json'), spoolFile: path.join(root, 'spool'), workdir: root, sandbox: true, sandboxHookSocket: true, sandboxHookSocketDir: dir, maxSessions: 5 });
  const registry = new Registry({ stateFile: cfg.stateFile, spoolFile: cfg.spoolFile });
  const hooks = new HookSocketServer({ dir, onSessionStart: () => ({ ok: true }), logger: { info: () => {}, warn: () => {} } });
  t.after(() => hooks.closeAll());

  // Stopped, with its directory left from its last run: the shape every
  // stopped session has now that the directory outlives the hub.
  const stopped = `cc-stopped-${process.pid}`;
  await hooks.open(stopped);
  await hooks.closeAll();
  registry.upsert(stopped, { status: 'stopped' });

  const sessions = new SessionManager(cfg, registry, hooks);
  assert.deepEqual(await sessions.reopenHookSockets(), []);
  assert.equal(hooks.listening(stopped), false);
  await hooks.open(stopped);
  assert.equal(hooks.listening(stopped), true);
});

test('the container mounts the session directory and is told where the socket is in it', () => {
  const line = buildCommand(/** @type {any} */ ({
    claudeBin: 'claude', remoteControl: true, skipPermissions: true, sandbox: true, podmanBin: 'podman',
    sandboxImage: 'localhost/fleetwright-session:latest', sandboxExtraArgs: [], sandboxHookSocket: true,
    sandboxHookSocketDir: '/var/lib/fleetwright/hook-sockets', sandboxUserns: 'nomap',
  }), { name: 'api' });
  assert.match(line, /'-v' '\/var\/lib\/fleetwright\/hook-sockets\/api:\/run\/hub'/);
  assert.match(line, /'-e' 'AGENT_SESSION_HOOK_SOCKET=\/run\/hub\/hub\.sock'/);
  // The file at its old path too, for an image from before the directory,
  // whose entrypoint looks there to decide whether to register its hooks.
  assert.match(line, /'-v' '\/var\/lib\/fleetwright\/hook-sockets\/api\/hub\.sock:\/run\/hub\.sock'/);
  assert.doesNotMatch(line, /:U'/, 'chowning it to the session is what kept the hub from making it again');
});
