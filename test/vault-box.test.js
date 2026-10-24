// The box's own command line on a box the fleet's vault has spoken to.
//
// Fleet people's sessions took every credential from their vault (#1327), and
// the box's own command line, local web page and chat went on running as an
// account linked on the box: the second copy of somebody's login, renewed on
// the box's clock, which the vault exists to end. A box that has taken one
// vault answer is a vault box (vault-store.js, "A VAULT BOX"), and what
// holds there:
//
//   - it became one on an answer, empty or not, and not on a refusal;
//   - its operator is a person whose vault gives it something, never somebody
//     who only linked an account on it (accounts.js, operatorAccount);
//   - a session started on it runs on that person's vault (podman.js);
//   - a link made on it is refused, with where it is made instead, and one
//     already there can still be forgotten (commands.js, vaultLinkRefusal);
//   - nothing reports a linked account as what a session runs on.
//
// A box that stands alone keeps every one of the old answers, and the tests
// that pin those are where they always were (accounts.test.js,
// credential-refresh.test.js, direct-session-account.test.js); the cases here
// that ask a standalone box are the ones this change could have moved.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Accounts, operatorAccount, HOST_ROW } from '../src/core/accounts.js';
import { Connections } from '../src/core/connectors.js';
import { pickCredentialSource } from '../src/core/podman.js';
import { applyVault, vaultEnvFor, vaultHolder } from '../src/core/vault-store.js';
import { dispatch } from '../src/adapters/commands.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';

const HOUR = 3_600_000;

/** @param {import('node:test').TestContext} t */
function box(t, patch = {}) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'vault-box-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  return /** @type {any} */ ({ stateDir, hostname: 'deb14', sandboxCredentialsFile: '', ...patch });
}

/** A Claude account linked on the box itself. @param {any} cfg @param {string} email */
const linkOnBox = (cfg, email) => new Accounts(cfg.stateDir).save(email, JSON.stringify({ claudeAiOauth: { accessToken: `linked-${email}`, expiresAt: Date.now() + HOUR } }));

/** A Claude sign-in as a vault gives one. @param {string} email */
const claude = (email) => ({ name: 'claude', value: `vault-${email}`, expiresAt: Date.now() + HOUR, login: { scopes: ['user:inference'] }, account: { emailAddress: email } });

/** One vault answer, as the sidecar hands it over. @param {any} cfg @param {Record<string, any[]>} people */
const answer = (cfg, people) => applyVault(cfg, { accounts: Object.entries(people).map(([email, items]) => ({ email, items })) });

test('a box becomes a vault box on its first answer, an empty one too, and not on a refusal', (t) => {
  const cfg = box(t);
  linkOnBox(cfg, 'ops@example.com');
  assert.equal(operatorAccount(cfg).email, 'ops@example.com', 'a box that stands alone runs as its one linked account, as before');

  // Something that is not an answer leaves it standing alone.
  assert.equal(applyVault(cfg, { nope: true }).ok, false);
  assert.equal(operatorAccount(cfg).email, 'ops@example.com');

  // "Nobody has approved this box" is an answer. From here the account linked
  // on it is nobody's command line.
  assert.equal(answer(cfg, {}).ok, true);
  const op = operatorAccount(cfg);
  assert.equal(op.email, null);
  assert.match(op.why, /nobody’s vault gives this box anything yet — approve this box from the app or from the vault page in a browser/);
  assert.equal(pickCredentialSource(cfg, 'cli').source, null, 'the linked account is not the fallback');
});

test('the operator is a person whose vault gives the box something, never one who only linked here', (t) => {
  const cfg = box(t);
  linkOnBox(cfg, 'ops@example.com');
  answer(cfg, { 'ann@example.com': [{ name: 'github', value: 'ghu_ann', expiresAt: Date.now() + HOUR }] });

  // The only one, with no configuration: the same rule as one linked account.
  assert.deepEqual(operatorAccount(cfg), { email: 'ann@example.com', why: 'ann@example.com is the only person whose vault gives this box anything' });

  // FLEETWRIGHT_OPERATOR settles who, among them, and only among them.
  const linkedOnly = operatorAccount({ ...cfg, operator: 'ops@example.com' });
  assert.equal(linkedOnly.email, null);
  assert.match(linkedOnly.why, /FLEETWRIGHT_OPERATOR names ops@example\.com, whose vault gives this box nothing/);

  answer(cfg, { 'ann@example.com': [claude('ann@example.com')], 'bo@example.com': [claude('bo@example.com')] });
  const two = operatorAccount(cfg);
  assert.equal(two.email, null);
  assert.match(two.why, /2 people’s vaults give this box something, so set FLEETWRIGHT_OPERATOR to say which of them/);
  assert.equal(operatorAccount({ ...cfg, operator: 'BO@example.com' }).email, 'bo@example.com');
});

test('a session started on a vault box runs on its operator’s vault login, and refuses rather than take a linked one', (t) => {
  const cfg = box(t);
  linkOnBox(cfg, 'ann@example.com');
  answer(cfg, { 'ann@example.com': [claude('ann@example.com')] });

  // The same person linked AND approving: the vault's copy, never the link.
  for (const actor of ['cli', 'web', 'telegram:12345', null]) {
    const picked = pickCredentialSource(cfg, actor);
    assert.equal(picked.account, 'ann@example.com', String(actor));
    assert.match(String(picked.source), /vault\/ann@example\.com\.claude-credentials\.json$/, String(actor));
  }

  // Their vault gives this box GitHub and no Claude login: said, with where.
  answer(cfg, { 'ann@example.com': [{ name: 'github', value: 'ghu_ann', expiresAt: Date.now() + HOUR }] });
  const none = pickCredentialSource(cfg, 'cli');
  assert.equal(none.source, null);
  assert.equal(none.account, 'ann@example.com');
  assert.match(String(none.why), /ann@example\.com’s vault gives this box no Claude login — keep one under You › Credentials in the app or on the vault page in a browser/);
});

test('a local session’s GitHub is its operator’s vault on a vault box, and the box’s own row on a box that stands alone', (t) => {
  // What the broker serves a session (src/index.js, secretsFor) is read from
  // the holder this answers.
  const cfg = box(t);
  new Connections(cfg.stateDir).save(HOST_ROW, 'github', 'ghu_box_row');
  assert.equal(vaultHolder(cfg, 'cli'), null, 'standing alone, the box’s own row');

  answer(cfg, { 'ann@example.com': [{ name: 'github', value: 'ghu_ann', expiresAt: Date.now() + HOUR }] });
  assert.deepEqual(vaultHolder(cfg, 'cli'), { email: 'ann@example.com' });
  assert.equal(vaultEnvFor(cfg, vaultHolder(cfg, 'web')?.email ?? null).GH_TOKEN, 'ghu_ann');
  // A fleet person is their own holder; an actor that does not parse is nobody's.
  assert.deepEqual(vaultHolder(cfg, 'fleet:bo@example.com'), { email: 'bo@example.com' });
  assert.equal(vaultHolder(cfg, 'fleet:not an email'), null);
});

/**
 * dispatch, as the local web page, the CLI and chat reach it, with a login
 * flow that records whether anything was started.
 *
 * @param {any} cfg
 */
function surface(cfg) {
  /** @type {string[]} */
  const started = [];
  const login = {
    status: () => ({ loggedIn: false }),
    isPending: () => false,
    start: async (/** @type {any} */ o) => { started.push(JSON.stringify(o)); return { ok: true, message: 'open this', url: 'https://claude.invalid/x' }; },
    cancel: () => ({ message: 'cancelled' }),
    logout: () => ({ ok: true, message: 'logged out' }),
  };
  const sessions = { list: () => [], running: () => [], view: () => null };
  return {
    started,
    run: (/** @type {string} */ actor, /** @type {string} */ line) => dispatch(/** @type {any} */ ({ cfg: { installDir: cfg.stateDir, releaseManifest: '', loginEnabled: true, ...cfg }, login, sessions, actor }), line),
  };
}

test('nothing is linked on a vault box: every way of linking the box’s own row says where it is kept instead', async (t) => {
  const cfg = box(t);
  answer(cfg, { 'ann@example.com': [claude('ann@example.com')] });
  const { run, started } = surface(cfg);
  const WHERE = /deb14 takes every credential from the vault of somebody who approved it, so nothing is linked on it — keep it under You › Credentials in the app or on the vault page in a browser, and approve deb14\./;

  for (const [actor, line] of [
    ['cli', '/login'],
    ['web', '/login force'],
    ['telegram:1', '/login for ops@example.com'],
    ['cli', '/connect github'],
    ['web', '/link github ghp_0123456789abcdef0123456789abcdef0123'],
    // An admin through the fleet, writing the box's row with --host.
    ['fleet:ann@example.com', '/link github ghp_0123456789abcdef0123456789abcdef0123 --host'],
    ['fleet:ann@example.com', '/connect cloudflare --host'],
    ['cli', '/renew github Iv1.client refresh-token'],
  ]) {
    const r = await run(actor, line);
    assert.equal(r.ok, false, `${actor} ${line}`);
    assert.match(r.text, WHERE, `${actor} ${line}`);
  }
  assert.deepEqual(started, [], 'no login was started');
  assert.deepEqual(new Connections(cfg.stateDir).list(HOST_ROW), [], 'nothing was written to the box’s row');
  assert.deepEqual(new Accounts(cfg.stateDir).list(), []);

  // FORGETTING still works: that is how the copies already here go.
  new Connections(cfg.stateDir).save(HOST_ROW, 'github', 'ghu_old_box_link');
  const gone = await run('cli', '/unlink github');
  assert.equal(gone.ok, true, gone.text);
  assert.deepEqual(new Connections(cfg.stateDir).list(HOST_ROW), []);
  assert.equal((await run('cli', '/login logout')).ok, true);
  assert.equal((await run('cli', '/login status')).ok, true);
});

test('a box that stands alone still links on its own command line', async (t) => {
  const cfg = box(t);
  const { run, started } = surface(cfg);
  const page = await run('cli', '/connect github');
  assert.equal(page.ok, true, page.text);
  assert.match(page.text, /Create a GitHub token here/);
  const renew = await run('cli', '/renew github Iv1.client refresh-token');
  assert.equal(renew.ok, true, renew.text);
  const login = await run('cli', '/login for ops@example.com');
  assert.equal(login.ok, true, login.text);
  assert.equal(started.length, 1);
});

test('status and the account list on a vault box count vault logins, not links nobody uses', async (t) => {
  const cfg = box(t);
  linkOnBox(cfg, 'ops@example.com');
  linkOnBox(cfg, 'old@example.com');
  answer(cfg, { 'ann@example.com': [claude('ann@example.com')] });
  const { run } = surface(cfg);

  const status = await run('cli', '/status');
  assert.match(status.text, /claude: 1 person’s vault gives this box a Claude login — a session runs as whoever starts it; this box’s own command line runs as ann@example\.com/);
  assert.doesNotMatch(status.text, /accounts? linked/);

  const accounts = await run('cli', '/accounts');
  assert.match(accounts.text, /Linked here, and not used:\n {2}old@example\.com\n {2}ops@example\.com/);
  assert.doesNotMatch(accounts.text, /A session runs on the account of whoever starts it/);
});

test('the health a box reports counts its vault logins once it is a vault box, and its links before', async (t) => {
  const cfg = box(t, { bind: '127.0.0.1', port: 0, token: '', workdir: os.tmpdir(), maxSessions: 1, sandbox: false, claudeBin: 'claude', remoteControl: false, skipPermissions: false });
  linkOnBox(cfg, 'ops@example.com');
  linkOnBox(cfg, 'old@example.com');
  const token = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, {
    sessions: /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] }),
    login: /** @type {any} */ ({ status: () => ({ loggedIn: false }), isPending: () => false }),
    token,
  });
  await adapter.start();
  t.after(() => adapter.server?.close());
  const base = `http://127.0.0.1:${/** @type {any} */ (adapter.server).address().port}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const accounts = async () => (await (await fetch(`${base}/api/state`, { headers })).json()).claudeAccounts;

  assert.equal(await accounts(), 2, 'standing alone, the two linked here');
  // Over the wire the sidecar uses, and an empty answer is enough.
  const r = await fetch(`${base}/api/vault`, { method: 'POST', headers, body: JSON.stringify({ accounts: [] }) });
  assert.equal(r.status, 200);
  assert.equal(await accounts(), 0, 'the linked ones are nobody’s now');
  await fetch(`${base}/api/vault`, { method: 'POST', headers, body: JSON.stringify({ accounts: [{ email: 'ann@example.com', items: [claude('ann@example.com')] }] }) });
  assert.equal(await accounts(), 1);
  assert.ok(readFileSync(path.join(cfg.stateDir, 'vault', '.vault-box'), 'utf8'), 'the answer is recorded');
});
