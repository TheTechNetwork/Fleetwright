// `fleetwright-sidecar doctor` judges a box the way the fleet does.
//
// THE LINE THIS PINS read "FAIL claude is logged in on the hub" on every box
// set up the way docs/first-session.md asks: a person's Claude login kept in
// their vault, the machine approved from the app, and nothing in the box's own
// home directory. That is the ordinary shape of every machine since
// docs/one-account-per-person.md, so the check failed healthy boxes and passed
// nothing the fleet cares about. The coordinator (registry.js) and the MCP
// server (server.js) each retired the same rule after it degraded every host
// and told two beta testers the fleet was down; doctor kept it, and the page
// that says "every line should say ok" pointed people at it.
//
// What the fleet judges on is `claudeAccounts`: how many people's logins this
// machine holds. Doctor now asks the same question, and the box's own login is
// printed as a fact and never as a verdict.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BIN = new URL('../bin/fleetwright-sidecar', import.meta.url).pathname;

/** A hub that answers /healthz and /api/state with whatever a test says. */
async function hub(state) {
  const server = createServer((req, res) => {
    const p = new URL(req.url || '/', 'http://x').pathname;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (p === '/healthz') return res.end(JSON.stringify({ ok: true, host: 'box' }));
    if (p === '/api/state') return res.end(JSON.stringify({ host: 'box', running: 0, maxSessions: 4, sessions: [], ...state }));
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r(null)); }) };
}

/** Run doctor against that hub, over the stdio transport so no coordinator is asked. */
function doctor(baseUrl) {
  const work = mkdtempSync(path.join(tmpdir(), 'sidecar-doctor-'));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'doctor'], {
      env: {
        ...process.env,
        FLEETWRIGHT_SIDECAR_ENV_FILE: path.join(work, 'absent.env'),
        FLEETWRIGHT_HUB_URL: baseUrl,
        FLEETWRIGHT_TRANSPORT: 'stdio',
        FLEETWRIGHT_COORDINATOR_URL: 'stdio:local',
        FLEETWRIGHT_HOST_KEY: path.join(work, 'host-key.json'),
        FLEETWRIGHT_HOST_ID: 'box',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('a box with an approved login and no login of its own passes', async (t) => {
  const h = await hub({ auth: { loggedIn: false, summary: 'not logged in' }, claudeAccounts: 1 });
  t.after(h.close);
  const { code, out } = await doctor(h.baseUrl);
  assert.equal(code, 0, out);
  assert.match(out, / ok   a Claude login for sessions  — 1 approved login/);
  assert.doesNotMatch(out, /FAIL/);
  // The box's own login is a note, not a line that can fail.
  assert.match(out, /note  the box itself has no Claude login of its own, which is normal/);
});

test('a box nobody has approved fails that line and names the vault step', async (t) => {
  // And the box's own login, when it has one, does not rescue it: sessions
  // through the fleet do not run on it.
  const h = await hub({ auth: { loggedIn: true, summary: 'Logged in as box@example.com' }, claudeAccounts: 0 });
  t.after(h.close);
  const { code, out } = await doctor(h.baseUrl);
  assert.equal(code, 1, out);
  assert.match(out, /FAIL  a Claude login for sessions  — nobody’s vault gives this machine a Claude login/);
  assert.match(out, /You › Credentials/);
  assert.match(out, /fleetwright-sidecar identity/);
  assert.match(out, /note  the box itself is logged in \(Logged in as box@example.com\); sessions through the fleet do not use it/);
});

test('a runner with nobody linked passes on what its sessions run on', async (t) => {
  const h = await hub({ auth: { loggedIn: false }, claudeAccounts: 0, runnerAuth: 'key' });
  t.after(h.close);
  const { code, out } = await doctor(h.baseUrl);
  assert.equal(code, 0, out);
  assert.match(out, / ok   a Claude login for sessions  — a runner: sessions run on the repository’s key/);
});

test('a hub too old to say is a warning, never a verdict either way', async (t) => {
  const h = await hub({ auth: { loggedIn: false } });
  t.after(h.close);
  const { code, out } = await doctor(h.baseUrl);
  assert.equal(code, 0, out);
  assert.match(out, /warn  a Claude login for sessions — this fleetwright does not say/);
  assert.doesNotMatch(out, /logged in on the hub/, 'the retired rule is gone');
});
