// What the sidecar used to read and write in fleetwright's state directory,
// now asked of fleetwright over the loopback it already holds a token for.
//
//   node --test test/hub-host-routes.test.js
//
// Four file reads and two file writes crossed from the sidecar into the hub's
// state directory: labels, channel, variant and the house rules on every health
// frame; the commit-confirm evidence when the coordinator was reached; the
// connections store when a provider token was renewed. Every one of them
// worked because the two services ran as one user, and every one of them is
// what stops the sidecar — the process holding the coordinator socket — from
// running as a user that cannot read the hub's files (#270). These tests pin the
// routes that replace them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { addLabel } from '../src/core/labels.js';
import { writeChannel } from '../src/core/channel.js';
import { writeVariant } from '../src/core/sandbox-variant.js';
import { armConfirmation, evidencePath } from '../src/core/update-confirm.js';
import { requestRestart } from '../src/core/restart-watch.js';
import { DEFAULT_SOCKET_DIR } from '../src/core/hook-socket.js';

/** @param {import('node:test').TestContext} t @param {Record<string, unknown>} [over] */
async function hub(t, over = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'hostroutes-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));

  const cfg = /** @type {any} */ ({
    stateDir,
    bind: '127.0.0.1',
    port: 0,
    token: '',
    hostname: 'testbox',
    workdir: path.join(stateDir, 'work'),
    maxSessions: 5,
    loginEnabled: true,
    sandbox: true,
    sandboxCredentialsFile: '',
    // A tag this fleet publishes, so the variant is switchable and not pinned.
    sandboxImage: 'ghcr.io/example/fleetwright-session:latest',
    sandboxImagePinned: false,
    releaseChannel: '',
    rulesFile: path.join(stateDir, 'CLAUDE.md'),
    ...over,
  });
  const sessions = /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] });
  const login = /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null });

  const token = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions, login, token });
  await adapter.start();
  const port = /** @type {any} */ (adapter.server).address().port;
  t.after(() => adapter.server?.close());

  const auth = { authorization: `Bearer ${token}` };
  return {
    cfg,
    stateDir,
    state: async () => (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: auth })).json(),
    /** @param {string} p @param {unknown} body @param {Record<string,string>} [headers] */
    post: (p, body, headers = auth) =>
      fetch(`http://127.0.0.1:${port}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
  };
}

// --- the facts the health frame carries -------------------------------------

test('/api/state publishes what the sidecar used to read out of the state directory', async (t) => {
  const h = await hub(t);

  const before = await h.state();
  // A fresh box: nothing set, nothing pinned, no rules. The shapes the sidecar
  // sent from its own reads, so a frame built from this one is byte-identical.
  assert.deepEqual(before.labels.set, []);
  assert.ok(Array.isArray(before.labels.auto) && before.labels.auto.length > 0, 'the machine has facts about itself');
  assert.equal(before.channel, 'stable');
  assert.equal(before.channelPinned, false);
  assert.deepEqual(before.sandbox, { variant: 'minimal', image: 'ghcr.io/example/fleetwright-session:latest', pinned: false });
  assert.equal(before.houseRules, null);

  // Change every one of them the way the verbs do, without restarting anything.
  assert.ok(addLabel(h.cfg, 'noisy').ok);
  assert.ok(writeChannel(h.cfg, 'rolling').ok);
  assert.ok(writeVariant(h.cfg, 'browser').ok);
  writeFileSync(h.cfg.rulesFile, 'Always say why.\n');

  const after = await h.state();
  assert.deepEqual(after.labels.set, ['noisy']);
  assert.ok(after.labels.auto.includes('browser'), 'the auto labels follow the resolved image, not the configured one');
  assert.equal(after.channel, 'rolling');
  assert.deepEqual(after.sandbox, { variant: 'browser', image: 'ghcr.io/example/fleetwright-session:web', pinned: false });
  assert.equal(after.houseRules, 'Always say why.\n'.length);
});

test('a pin from the environment is reported as one, and no sandbox means no sandbox facts', async (t) => {
  // `:v3` is a tag this fleet has never published, so the variant is `custom`
  // — `:latest` would be minimal whoever built it, see variantOf.
  const pinned = await hub(t, { releaseChannel: 'rolling', sandboxImage: 'localhost/mine:v3', sandboxImagePinned: true });
  const s = await pinned.state();
  assert.equal(s.channel, 'rolling');
  assert.equal(s.channelPinned, true);
  assert.deepEqual(s.sandbox, { variant: 'custom', image: 'localhost/mine:v3', pinned: true });

  const plain = await hub(t, { sandbox: false });
  assert.equal((await plain.state()).sandbox, null);
});

test('a reader that fails leaves a null, not a default', async (t) => {
  // C-5, in the two shapes it takes here. A rules path that exists and is not
  // a file is REFUSED by readHouseRules and reported as 0 — the house rules
  // are not in use, and that is known. A state directory the process cannot
  // ask about at all is a null, because "no labels" is a claim.
  const refused = await hub(t);
  rmSync(refused.cfg.rulesFile, { force: true });
  mkdirSync(refused.cfg.rulesFile);
  assert.equal((await refused.state()).houseRules, 0);

  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'hostroutes-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const token = ensureApiToken(/** @type {any} */ ({ stateDir }));
  // A config whose state directory cannot even be named — the shape an EACCES
  // on the way in takes once the sidecar and the hub are different users and
  // somebody points one at the other's directory.
  const cfg = /** @type {any} */ ({
    // The token is configured here, not generated: start() names the token
    // file — under the state directory — only when none is.
    bind: '127.0.0.1', port: 0, token, hostname: 'testbox', workdir: '/nonexistent', maxSessions: 1,
    loginEnabled: false, sandbox: false, releaseChannel: '', rulesFile: '',
    get stateDir() { throw new Error('EACCES: permission denied'); },
  });
  const sessions = /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] });
  const login = /** @type {any} */ ({ status: () => ({ loggedIn: false }), isPending: () => false, pending: null });
  const adapter = new HttpAdapter(cfg, { sessions, login, token });
  await adapter.start();
  t.after(() => adapter.server?.close());
  const port = /** @type {any} */ (adapter.server).address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200, 'one unreadable fact does not take /api/state down');
  const s = await r.json();
  assert.equal(s.labels, null);
  assert.equal(s.houseRules, null);
  // readChannel's own contract is that an unreadable file means stable — it
  // catches its read inside — so this one is the reader's answer, not the
  // route's. Pinned so a change to either shows up here.
  assert.equal(s.channel, 'stable');
});

test("the updater's restart request rides on /api/state, for a sidecar that cannot read the marker", async (t) => {
  const h = await hub(t);
  assert.equal((await h.state()).restartRequestedAt, null, 'a box that has never updated has no request');
  assert.ok(requestRestart({ head: 'abc1234', stateDir: h.stateDir }));
  const at = (await h.state()).restartRequestedAt;
  assert.equal(typeof at, 'number');
  assert.ok(Date.now() - at < 5_000, 'the time the updater wrote, not the time asked');
});

// --- the two writes ------------------------------------------------------------

test('the coordinator half of the update evidence is recorded on request', async (t) => {
  const h = await hub(t);

  // Nothing on trial: recorded as not noted, with the reason, and no file.
  let r = await h.post('/api/update-evidence', { which: 'coord' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, noted: false, why: 'nothing on trial' });
  assert.ok(!existsSync(evidencePath(h.stateDir, 'coord')));

  // A release on trial: the file appears, which is what the watchdog reads.
  assert.ok(armConfirmation(h.cfg, { from: '0.3.0', to: '0.4.0', windowMs: 60_000 }).armed);
  r = await h.post('/api/update-evidence', { which: 'coord' });
  assert.deepEqual(await r.json(), { ok: true, noted: true });
  assert.ok(existsSync(evidencePath(h.stateDir, 'coord')));
});

test("the hub's own half cannot be stamped over HTTP", async (t) => {
  // The hub's evidence is "a session started here", which this process proves
  // for itself in src/index.js. A token holder saying so is not proof, and a
  // caller that could say so could confirm a release that cannot run a session.
  const h = await hub(t);
  armConfirmation(h.cfg, { from: '0.3.0', to: '0.4.0', windowMs: 60_000 });
  for (const which of ['hub', 'both', '', undefined, 42]) {
    const r = await h.post('/api/update-evidence', { which });
    assert.equal(r.status, 400, `which=${String(which)}`);
  }
  assert.ok(!existsSync(evidencePath(h.stateDir, 'hub')));
  assert.ok(!existsSync(evidencePath(h.stateDir, 'coord')));
});

test('provider renewal runs against the store on request and reports per row', async (t) => {
  const h = await hub(t);
  // No connections on this box: nothing to renew, said as an empty list rather
  // than as an error, because a timer on the sidecar will ask every hour.
  const r = await h.post('/api/renew-providers', { secrets: { github: 'x' } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, results: [] });
});

test('renewal refuses a body that is not a map of secrets', async (t) => {
  const h = await hub(t);
  for (const body of [{}, { secrets: null }, { secrets: 'gh' }, { secrets: ['a'] }, { secrets: { github: 1 } }]) {
    const r = await h.post('/api/renew-providers', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('both writes sit behind the token like every other operator route', async (t) => {
  const h = await hub(t);
  for (const [p, body] of [
    ['/api/update-evidence', { which: 'coord' }],
    ['/api/renew-providers', { secrets: {} }],
  ]) {
    const r = await h.post(p, body, {});
    assert.equal(r.status, 401, p);
    assert.deepEqual(await r.json(), { error: 'unauthorised' });
  }
});

// --- where the sockets live -----------------------------------------------------

test("the hook sockets default to fleetwright's own runtime directory", () => {
  // The unit says `RuntimeDirectory=fleetwright`; the code must name the same
  // place, or systemd creates one directory and the service writes into another
  // — the sidecar's, which under #270 it cannot enter.
  assert.equal(DEFAULT_SOCKET_DIR, '/run/fleetwright');
  assert.doesNotMatch(DEFAULT_SOCKET_DIR, /sidecar|agent-fleet/);
});
