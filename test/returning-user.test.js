// What a returning user can find out about work they left running.
//
// Three beta findings, one complaint: B2 (#314) `read_log` said "printed
// nothing" while `peek` showed a full pane; B5 (#331) `peek` — documented as
// how you find out whether work is done — fails on stopped sessions, which is
// every session a returning user has; C4 (#320) the credential countdown was
// only reachable from a tool called out of desperation.
//
// All three were FIXED and only C4 was pinned. This file pins the other two,
// because #311 in this same set was closed once on a fix that turned out to be
// half a fix, and nothing caught it but running the tool by hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSessionLogs } from '../src/core/logs.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';

/** A shell script on disk that answers however the test needs. */
function stub(dir, name, body) {
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

/**
 * A box with a fake podman and a fake tmux.
 *
 * REAL BINARIES ON DISK, not a stubbed spawnSync: `tmux` is resolved from PATH
 * inside src/core/tmux.js and `podmanBin` comes from config, and a mock of the
 * call would not catch an argument built wrongly — which is half of what these
 * functions are.
 */
function box(t, { containerPrints = '', paneShows = '', paneExists = true, containerExists = true }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'returning-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const podmanBin = stub(dir, 'podman', `
case "$1" in
  logs) ${containerPrints ? `printf '%s' ${JSON.stringify(containerPrints)}` : ':'} ; exit 0 ;;
  container) exit ${containerExists ? 0 : 125} ;;
  *) exit 0 ;;
esac`);

  stub(dir, 'tmux', `
case "$1" in
  has-session) exit ${paneExists ? 0 : 1} ;;
  capture-pane) printf '%s' ${JSON.stringify(paneShows)} ; exit 0 ;;
  *) exit 0 ;;
esac`);

  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  t.after(() => { process.env.PATH = before; });

  return /** @type {any} */ ({ sandbox: true, podmanBin, stateDir: dir });
}

test('a resumed session reads its pane when the container has printed nothing', async (t) => {
  // FINDING B2, EXACTLY. The container a resume restarted into has printed
  // nothing yet and the work is in the pane — both statements true, and the
  // tool the product names for collecting output returned the useless one.
  const cfg = box(t, { containerPrints: '', paneShows: 'the answer you came back for' });
  const r = readSessionLogs(cfg, 'bigjob');
  assert.equal(r.ok, true);
  assert.match(r.text, /the answer you came back for/, 'it stopped at the empty container');
  assert.doesNotMatch(r.text, /printed nothing/);
});

test('the container still wins when it has something to say', () => {
  // THE FALL-THROUGH MUST NOT BECOME A PREFERENCE. The container outlives the
  // pane and holds why a session DIED, which is the case this function was
  // written for — reversing the order to fix B2 would trade one blind spot for
  // an older one.
  const cfg = box({ after: () => {} }, { containerPrints: 'Killed: out of memory', paneShows: 'stale' });
  const r = readSessionLogs(cfg, 'bigjob');
  assert.match(r.text, /out of memory/);
  assert.doesNotMatch(r.text, /stale/);
});

test('nothing anywhere names the way back, rather than only the loss', async (t) => {
  // A stopped session, no container, no pane. The transcript survives and a
  // resume restores it — an error that knows the way out and does not say it
  // is the failure this project's refusals exist to avoid.
  const cfg = box(t, { containerPrints: '', paneExists: false, containerExists: false });
  const r = readSessionLogs(cfg, 'bigjob');
  assert.equal(r.ok, false);
  assert.match(r.text, /resume bigjob/i, 'it states the loss and stops');
  assert.match(r.text, /transcript/);
});

// --- B5 (#331): peek on a session that is not running -----------------------

/** @param {import('node:test').TestContext} t @param {string[]} known */
async function hub(t, known) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'peek-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({
    stateDir, bind: '127.0.0.1', port: 0, token: '', hostname: 'testbox',
    workdir: path.join(stateDir, 'work'), maxSessions: 5, loginEnabled: true,
    sandbox: false, sandboxCredentialsFile: '',
  });
  const sessions = /** @type {any} */ ({
    // A stopped session: the registry knows it, and peek finds no live pane.
    list: () => known.map((name) => ({ name, status: 'stopped' })),
    running: () => [], binned: () => [],
    peek: () => null,
  });
  const login = /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null });
  const adapter = new HttpAdapter(cfg, { sessions, login, token: ensureApiToken(cfg) });
  await adapter.start();
  const port = /** @type {any} */ (adapter.server).address().port;
  t.after(() => adapter.server?.close());
  return { port, token: ensureApiToken(cfg) };
}

test('peeking a stopped session names the way back, not just "not running"', async (t) => {
  // FINDING B5. `peek` is documented as how you find out whether work is done,
  // and every session a returning user has is stopped — so the documented tool
  // answered "not running" on exactly the sessions whose output they wanted.
  const { port, token } = await hub(t, ['bigjob']);
  const res = await fetch(`http://127.0.0.1:${port}/api/peek?name=bigjob`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 404, 'the status stays machine-readable');
  const body = await res.json();
  assert.match(body.text, /Resume it/);
  assert.match(body.text, /transcript/);
});

test('a name nothing knows is told that, and not offered a resume', async (t) => {
  // THE TWO ANSWERS ARE DIFFERENT. Offering "resume it" for a session that has
  // never existed sends somebody to run a command that cannot work, which is
  // the same fault as a remedy naming an archived surface.
  const { port, token } = await hub(t, ['bigjob']);
  const res = await fetch(`http://127.0.0.1:${port}/api/peek?name=ghost`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  assert.match(body.text, /No session called "ghost"/);
  assert.doesNotMatch(body.text, /Resume it/);
});
