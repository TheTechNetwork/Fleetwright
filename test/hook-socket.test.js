// The per-session hook transport, exercised over real unix sockets.
//
//   node --test test/
//
// Nothing here is mocked: each test opens an actual listening socket in a
// temp directory and posts to it through the same client the container-side
// hook uses. That is the point — §10 lists this transport as the one piece of
// the sandbox design still unproven, and a test against a fake socket would
// prove nothing about it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  HookSocketServer,
  postSessionStart,
  isValidSessionName,
  HOOK_PATH,
  CONTAINER_SOCKET_PATH,
} from '../src/host/hook-socket.js';

const UUID = 'a1b2c3d4-1111-2222-3333-444455556666';
const OTHER_UUID = 'ffffffff-9999-8888-7777-666655554444';

/**
 * A server plus the reports it received, torn down when the test ends.
 * @param {import('node:test').TestContext} t
 */
function harness(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hook-sock-'));
  /** @type {Array<{name: string, cwd: string|null, uuid: string}>} */
  const reports = [];
  const warnings = [];
  const server = new HookSocketServer({
    dir,
    onSessionStart: (r) => {
      reports.push(r);
      return { ok: true, message: 'recorded' };
    },
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
  });
  t.after(async () => {
    await server.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, server, reports, warnings };
}

/**
 * Post a raw body to a socket, bypassing the client — so a test can send the
 * things a well-behaved client never would.
 * @param {string} socketPath @param {string} body @param {{method?: string, path?: string}} [opts]
 */
function rawPost(socketPath, body, { method = 'POST', path: urlPath = HOOK_PATH } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method,
        path: urlPath,
        headers: { 'content-type': 'application/json', host: 'hub', 'content-length': Buffer.byteLength(body) },
        timeout: 5000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end(body);
  });
}

// --- the property the whole design rests on ---------------------------------

test('a uuid posted on a session socket is recorded for THAT session', async (t) => {
  const { server, reports } = harness(t);
  const sock = await server.open('bigjob');

  const r = await postSessionStart({ socketPath: sock, uuid: UUID, cwd: '/work' });

  assert.equal(r.ok, true, r.error);
  assert.deepEqual(reports, [{ name: 'bigjob', cwd: '/work', uuid: UUID }]);
});

test('the client sends no session name at all — the socket supplies it', async (t) => {
  const { server, reports } = harness(t);
  const sock = await server.open('bigjob');

  // Exactly what postSessionStart puts on the wire.
  await rawPost(sock, JSON.stringify({ uuid: UUID, cwd: '/work' }));

  assert.equal(reports[0].name, 'bigjob');
});

test('a container cannot report against another session by naming it', async (t) => {
  // The failure this transport exists to remove. Over the shared loopback HTTP
  // endpoint any local process can post any name+uuid, so a root-capable
  // session could repoint a neighbour's resume target at a conversation of its
  // choosing. Here the name in the body is not the authority and is refused.
  const { server, reports, warnings } = harness(t);
  const mine = await server.open('mine');
  await server.open('neighbour');

  const res = await rawPost(mine, JSON.stringify({ name: 'neighbour', uuid: UUID }));

  assert.equal(res.status, 403);
  assert.equal(reports.length, 0, 'nothing may be recorded for either session');
  assert.match(warnings.join('\n'), /neighbour/);
});

test('two sessions have independent sockets', async (t) => {
  const { server, reports } = harness(t);
  const a = await server.open('alpha');
  const b = await server.open('beta');
  assert.notEqual(a, b);

  await postSessionStart({ socketPath: a, uuid: UUID });
  await postSessionStart({ socketPath: b, uuid: OTHER_UUID });

  assert.deepEqual(
    reports.map((r) => [r.name, r.uuid]),
    [
      ['alpha', UUID],
      ['beta', OTHER_UUID],
    ],
  );
});

test('a body naming its own session is accepted', async (t) => {
  // Tolerated so a caller built against agent-hub's existing HTTP payload —
  // which does carry a name — is not a hard failure. It just cannot LIE.
  const { server, reports } = harness(t);
  const sock = await server.open('bigjob');

  const res = await rawPost(sock, JSON.stringify({ name: 'bigjob', uuid: UUID }));

  assert.equal(res.status, 200);
  assert.equal(reports[0].name, 'bigjob');
});

// --- access control ---------------------------------------------------------

test('the socket directory is private and the socket is owner-only', async (t) => {
  const { dir, server } = harness(t);
  const sock = await server.open('bigjob');

  assert.equal(statSync(dir).mode & 0o777, 0o700, 'socket directory must not be traversable by others');
  assert.equal(statSync(sock).mode & 0o777, 0o600, 'socket must not be reachable by other users on the box');
});

test('a session name that would escape the socket directory is refused', async (t) => {
  const { server } = harness(t);
  for (const bad of ['../escape', 'has space', 'semi;colon', '', '.hidden', 'x'.repeat(41)]) {
    assert.ok(!isValidSessionName(bad), `${JSON.stringify(bad)} should not be a valid name`);
    await assert.rejects(() => server.open(bad), /not a valid session name/);
  }
});

// --- what a hostile container can send --------------------------------------

test('a malformed uuid is refused and records nothing', async (t) => {
  const { server, reports } = harness(t);
  const sock = await server.open('bigjob');

  for (const bad of ['', 'not-a-uuid', '../../etc/passwd', 'A1B2C3D4-1111-2222-3333-444455556666']) {
    const res = await rawPost(sock, JSON.stringify({ uuid: bad }));
    assert.equal(res.status, 400, `uuid ${JSON.stringify(bad)} should be refused`);
  }
  assert.equal(reports.length, 0);
});

test('a body that is not a JSON object is refused', async (t) => {
  const { server, reports } = harness(t);
  const sock = await server.open('bigjob');

  for (const bad of ['', 'not json', '[1,2,3]', '"a string"', 'null']) {
    const res = await rawPost(sock, bad);
    assert.equal(res.status, 400, `body ${JSON.stringify(bad)} should be refused`);
  }
  assert.equal(reports.length, 0);
});

test('an oversized body is dropped rather than buffered', async (t) => {
  const { server, reports } = harness(t);
  const sock = await server.open('bigjob');

  const huge = JSON.stringify({ uuid: UUID, cwd: 'x'.repeat(2 * 1024 * 1024) });
  // The server destroys the request part-way, so the client may see either a
  // 400 or a broken connection. Both are correct; what matters is that nothing
  // is recorded and the process is still up.
  await rawPost(sock, huge).catch(() => null);

  assert.equal(reports.length, 0);
  // Still serving afterwards.
  const ok = await postSessionStart({ socketPath: sock, uuid: UUID });
  assert.equal(ok.ok, true, ok.error);
});

test('only POST to the hook path is answered', async (t) => {
  const { server } = harness(t);
  const sock = await server.open('bigjob');

  assert.equal((await rawPost(sock, '{}', { method: 'GET' })).status, 405);
  assert.equal((await rawPost(sock, '{}', { path: '/api/command' })).status, 404);
  assert.equal((await rawPost(sock, '{}', { path: '/healthz' })).status, 404);
});

test('a rejected report from the hub is passed back, not swallowed', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hook-sock-'));
  const server = new HookSocketServer({
    dir,
    onSessionStart: () => ({ ok: false, message: 'no such session' }),
  });
  t.after(async () => {
    await server.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const sock = await server.open('bigjob');

  const r = await postSessionStart({ socketPath: sock, uuid: UUID });

  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(r.body?.message, 'no such session');
});

// --- lifecycle --------------------------------------------------------------

test('closing a session removes its socket from the filesystem', async (t) => {
  const { dir, server } = harness(t);
  const sock = await server.open('bigjob');
  assert.ok(statSync(sock));

  await server.close('bigjob');

  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(server.names(), []);
});

test('a socket left behind by a crashed run is reclaimed', async (t) => {
  // `--rm` plus a container that died hard leaves the file with nothing behind
  // it. The next start of that session must not fail with EADDRINUSE.
  const { dir, server, reports } = harness(t);
  const stale = path.join(dir, 'bigjob.sock');
  writeFileSync(stale, '');

  const sock = await server.open('bigjob');
  await postSessionStart({ socketPath: sock, uuid: UUID });

  assert.equal(reports[0].name, 'bigjob');
});

test('a socket with a LIVE listener is never stolen', async (t) => {
  // The other half of reclaiming: unlinking unconditionally would be a way to
  // hijack a running session — drop its socket, listen on the same path, and
  // its next report lands in the wrong process.
  const { dir, server } = harness(t);
  await server.open('bigjob');

  const second = new HookSocketServer({ dir, onSessionStart: () => ({ ok: true }) });
  t.after(() => second.closeAll());

  await assert.rejects(() => second.open('bigjob'), /already in use/);
});

test('opening the same session twice is idempotent', async (t) => {
  const { server } = harness(t);
  const first = await server.open('bigjob');
  const again = await server.open('bigjob');

  assert.equal(first, again);
  assert.deepEqual(server.names(), ['bigjob']);
});

test('closing a session that was never open is not an error', async (t) => {
  const { server } = harness(t);
  await server.close('never-existed');
});

// --- the client's contract with its caller ----------------------------------

test('an unreachable socket returns a failure instead of throwing', async (t) => {
  // The caller is a SessionStart hook. It must be free to fall back to the
  // spool file, and it must never take the session down with it.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hook-sock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = await postSessionStart({ socketPath: path.join(dir, 'absent.sock'), uuid: UUID, timeoutMs: 1000 });

  assert.equal(r.ok, false);
  assert.ok(r.error, 'the caller needs a reason to log before it spools');
});

test('every session sees the same in-container path, whatever it is called', async (t) => {
  // This is what lets a session report without knowing its own name: the host
  // paths differ per session, the container path never does. Changing
  // CONTAINER_SOCKET_PATH means changing the podman `-v` line in lockstep, so
  // pin it.
  const { server } = harness(t);
  const hostPaths = [await server.open('alpha'), await server.open('beta')];

  assert.equal(new Set(hostPaths).size, 2, 'host sockets are per-session');
  assert.equal(CONTAINER_SOCKET_PATH, '/run/hub.sock');
  for (const p of hostPaths) {
    assert.notEqual(p, CONTAINER_SOCKET_PATH);
  }
});
