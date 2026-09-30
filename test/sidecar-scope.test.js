// The sidecar's own token, and what it may ask the hub to do.
//
//   node --test test/sidecar-scope.test.js
//
// hardening.md's last open item on the sidecar: the separate account (#270)
// stopped a compromised sidecar READING credentials, and the token it held
// still let it ask for anything. Now the hub mints a second token and gates
// it to the command shapes the sidecar itself builds. These tests pin the
// gate from three sides: the list against the function it mirrors, the HTTP
// adapter's answers on each token, and the installer's handoff.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HttpAdapter } from '../src/adapters/http.js';
import { canonicalCommand } from '../src/adapters/commands.js';
import { ensureApiToken, ensureSidecarToken, readSidecarToken, sidecarTokenFile } from '../src/core/api-token.js';
import { SIDECAR_COMMANDS, sidecarMayRun } from '../src/core/sidecar-scope.js';
import { loadSidecarConfig } from '../src/fleet/host/config.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// --- the list and the function it mirrors ---------------------------------------

test('the allowlist is exactly the words toCommandLine builds, plus the two the watcher and the poll send', () => {
  // Read off the source rather than run: toCommandLine needs a validated
  // intent per verb, and what is being pinned is the SET of first words, not
  // any one line. A verb added there without a line here fails here.
  const sidecar = read('src/fleet/host/sidecar.js');
  const fn = sidecar.slice(sidecar.indexOf('export function toCommandLine'), sidecar.indexOf('export function commandMeta'));
  const built = new Set([...fn.matchAll(/[`'"]\/([a-z]+)/g)].map((m) => m[1]));
  // Two more callers build lines from literals: the idle restart in
  // watcher.js and the update poll in bin/fleetwright-sidecar.
  for (const src of [read('src/fleet/host/watcher.js'), read('bin/fleetwright-sidecar')]) {
    for (const m of src.matchAll(/\.command\((?:`|')\/([a-z]+)/g)) built.add(m[1]);
  }
  const listed = new Set(SIDECAR_COMMANDS.map((c) => canonicalCommand(c)));
  for (const word of built) {
    assert.ok(listed.has(canonicalCommand(word)), `the sidecar builds /${word} and the hub would refuse it`);
  }
  for (const word of SIDECAR_COMMANDS) {
    assert.ok([...built].some((b) => canonicalCommand(b) === word), `/${word} is allowed and nothing builds it`);
  }
  // Every entry is a canonical name dispatch knows, so the gate and the
  // dispatcher agree on what a word means.
  for (const word of SIDECAR_COMMANDS) assert.equal(canonicalCommand(word), word);
});

test('what the sidecar never does is not on the list', () => {
  for (const word of ['help', 'bin', 'enroll', 'identity', 'whoami']) {
    assert.ok(!SIDECAR_COMMANDS.includes(word), `/${word}`);
  }
});

// --- the gate -------------------------------------------------------------------------

test('the two words that cover a person and the box are pinned to the person\'s form', () => {
  assert.equal(sidecarMayRun({ canonical: 'login', args: ['for', 'a@example.com'] }).ok, true);
  assert.equal(sidecarMayRun({ canonical: 'login', args: [] }).ok, false, 'bare /login signs the box in');
  assert.equal(sidecarMayRun({ canonical: 'login', args: ['force'] }).ok, false);
  assert.equal(sidecarMayRun({ canonical: 'login', args: ['for'] }).ok, false);
  assert.equal(sidecarMayRun({ canonical: 'accounts', args: ['remove', 'a@example.com'] }).ok, true);
  assert.equal(sidecarMayRun({ canonical: 'accounts', args: [] }).ok, false, 'listing accounts is the operator\'s');
  assert.equal(sidecarMayRun({ canonical: 'accounts', args: ['add', 'x'] }).ok, false);
});

test('an unknown word, or one off the list, is refused with a reason that names it', () => {
  const r = sidecarMayRun({ canonical: null, args: [] });
  assert.equal(r.ok, false);
  const h = sidecarMayRun({ canonical: 'help', args: [] });
  assert.equal(h.ok, false);
  assert.match(!h.ok ? h.why : '', /\/help/);
  assert.equal(sidecarMayRun({ canonical: 'new', args: ['job'] }).ok, true);
  assert.equal(sidecarMayRun({ canonical: 'link', args: ['github', 'ghp_x'] }).ok, true);
});

// --- the adapter -------------------------------------------------------------------

/** @param {import('node:test').TestContext} t */
async function hub(t) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'sidecar-scope-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({
    stateDir, bind: '127.0.0.1', port: 0, token: '', hostname: 'testbox',
    workdir: path.join(stateDir, 'work'), maxSessions: 5, loginEnabled: true, sandbox: false, sandboxCredentialsFile: '',
    sandboxImage: 'x:latest', sandboxImagePinned: false, releaseChannel: '', rulesFile: path.join(stateDir, 'CLAUDE.md'),
  });
  const sessions = /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [], peek: () => null });
  const login = /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null });
  const operator = ensureApiToken(cfg);
  const sidecar = ensureSidecarToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions, login, token: operator, sidecarToken: sidecar });
  await adapter.start();
  const port = /** @type {any} */ (adapter.server).address().port;
  t.after(() => adapter.server?.close());
  const as = (/** @type {string} */ token) => ({ authorization: `Bearer ${token}` });
  return {
    stateDir, operator, sidecar,
    /** @param {string} p @param {Record<string,string>} [headers] */
    get: (p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers }),
    /** @param {string} line @param {string} token */
    command: (line, token) =>
      fetch(`http://127.0.0.1:${port}/api/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...as(token) },
        body: JSON.stringify({ command: line }),
      }),
    as,
  };
}

test('the hub mints a second token, 0600, distinct from the operator\'s, and reads it back', async (t) => {
  const h = await hub(t);
  assert.notEqual(h.sidecar, h.operator);
  assert.match(h.sidecar, /^[0-9a-f]{48}$/);
  const file = sidecarTokenFile(h.stateDir);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readSidecarToken(h.stateDir), h.sidecar);
  assert.equal(ensureSidecarToken(/** @type {any} */ ({ stateDir: h.stateDir })), h.sidecar, 'minted once');
});

test('the sidecar\'s token reaches what the sidecar calls', async (t) => {
  const h = await hub(t);
  assert.equal((await h.get('/api/state', h.as(h.sidecar))).status, 200);
  assert.equal((await h.get('/api/peek?name=job', h.as(h.sidecar))).status, 404, 'answered, not refused: no such session');
  const list = await h.command('/list', h.sidecar);
  assert.equal(list.status, 200);
  const alias = await h.command('/start job', h.sidecar);
  assert.equal(alias.status, 200, 'an alias of an allowed word is judged as the word');
  const login = await h.command('/login for a@example.com', h.sidecar);
  assert.equal(login.status, 200, 'a person\'s login is the sidecar\'s');
});

test('the sidecar\'s token does not sign the box in, list accounts, open the web UI, or run a word the fleet has no verb for', async (t) => {
  const h = await hub(t);
  for (const line of ['/login', '/login force', '/accounts', '/help', '/bin', '/whoami']) {
    const r = await h.command(line, h.sidecar);
    assert.equal(r.status, 403, line);
    const body = await r.json();
    assert.equal(body.ok, false);
    assert.match(body.text, /sidecar's token/);
  }
  const ui = await h.get('/', h.as(h.sidecar));
  assert.equal(ui.status, 403);
  // And not as a cookie or a query string: a service's credential, not a browser's.
  assert.equal((await h.get(`/api/state?token=${h.sidecar}`)).status, 401);
  assert.equal((await h.get('/api/state', { cookie: `fleetwright_token=${h.sidecar}` })).status, 401);
});

test('the operator\'s token is not gated, exactly as before', async (t) => {
  const h = await hub(t);
  for (const line of ['/help', '/accounts', '/list']) {
    assert.equal((await h.command(line, h.operator)).status, 200, line);
  }
  assert.equal((await h.get('/', h.as(h.operator))).status, 200);
  assert.equal((await h.get(`/api/state?token=${h.operator}`)).status, 200);
});

test('a hub with no second token treats the sidecar as the operator, which is every box before this', async (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'sidecar-scope-old-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({ stateDir, bind: '127.0.0.1', port: 0, token: '', hostname: 'testbox', workdir: path.join(stateDir, 'work'), maxSessions: 5, loginEnabled: true, sandbox: false, sandboxCredentialsFile: '' });
  const sessions = /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] });
  const login = /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null });
  const token = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions, login, token });
  await adapter.start();
  t.after(() => adapter.server?.close());
  const port = /** @type {any} */ (adapter.server).address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/command`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ command: '/help' }),
  });
  assert.equal(r.status, 200);
});

// --- the sidecar's side ----------------------------------------------------------

test('the sidecar reads its own token before the operator\'s, and the env file before either', (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'sidecar-scope-cfg-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  mkdirSync(stateDir, { recursive: true });
  const base = { FLEETWRIGHT_COORDINATOR_URL: 'https://fleet.example', FLEETWRIGHT_STATE_DIR: stateDir, FLEETWRIGHT_HOST_KEY: path.join(stateDir, 'host-key.json') };

  assert.equal(loadSidecarConfig(base).hubToken, null, 'nothing to read: null, never an empty string');
  writeFileSync(path.join(stateDir, 'api-token'), 'operator-token\n', { mode: 0o600 });
  assert.equal(loadSidecarConfig(base).hubToken, 'operator-token', 'a hub from before the second token');
  writeFileSync(path.join(stateDir, 'sidecar-token'), 'sidecar-token\n', { mode: 0o600 });
  assert.equal(loadSidecarConfig(base).hubToken, 'sidecar-token');
  assert.equal(loadSidecarConfig({ ...base, FLEETWRIGHT_HUB_TOKEN: 'from-the-env' }).hubToken, 'from-the-env', 'what the installer wrote wins');
});

// --- the installer's handoff --------------------------------------------------------

test('root mints the sidecar token where the hub will find it, and copies it into the sidecar\'s env', () => {
  const sh = read('install/install.sh');
  // Minted right after the state directory, 0600 and owned by the hub's user
  // — the hub's ensureSidecarToken reads what root wrote.
  const mint = sh.slice(sh.indexOf('SIDECAR_TOKEN_FILE="$STATE_DIR/sidecar-token"'), sh.indexOf('# --- 3. environment file'));
  assert.match(mint, /umask 077/);
  assert.match(mint, /\/dev\/urandom/);
  assert.match(mint, /chown "\$RUN_USER" "\$SIDECAR_TOKEN_FILE"/);
  assert.match(mint, /chmod 0600 "\$SIDECAR_TOKEN_FILE"/);
  assert.match(mint, /\[ "\$CHECK_ONLY" != 1 \]/, '--check writes nothing');
  // Both places the sidecar's env is written prefer it over the operator's.
  assert.equal((sh.match(/FLEETWRIGHT_HUB_TOKEN: sidecarToken \|\| hub\.FLEETWRIGHT_TOKEN \|\| ''/g) || []).length, 2);
  assert.equal((sh.match(/SIDECAR_TOKEN_FILE="\$SIDECAR_TOKEN_FILE"/g) || []).length, 2, 'handed to both node blocks');
});
