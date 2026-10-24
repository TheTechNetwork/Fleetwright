// A direct session runs as the person who started it, like a sandboxed one.
//
// docs/one-account-per-person.md says the box has no Claude account, and the
// sandbox path honoured that from the day it was written. The direct path did
// not: it fell through to the box's ~/.claude, and on a fresh box that is
// Claude's first-run wizard asking how to log in, with nobody at the terminal.
// Seen on the first apt install — the app linked an account, requested a
// session, and got a theme picker.
//
// What has to hold: the session's config directory carries the person's
// credential AND identity (the CLI decides logged-in-ness from the pair),
// declares onboarding done and the cwd trusted, and carries the hook; a resume
// keeps its account and takes today's credential; nobody linked is a refusal
// that says so, not a prompt; and the command points the CLI at that directory
// only for a direct session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';

import { applyVault } from '../src/core/vault-store.js';
import { Accounts } from '../src/core/accounts.js';
import { ensureDirectConfig, directConfigDir, removeDirectConfig } from '../src/core/direct-config.js';
import { buildCommand } from '../src/core/claude.js';

function box({ link = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'direct-'));
  const stateDir = join(root, 'state');
  const home = join(root, 'home');
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/opt/fleetwright/current/bin/fleetwright hook' }] }] } }));
  if (link) signIn(stateDir, 'tok-1');
  const cfg = /** @type {any} */ ({
    stateDir,
    hostname: 'box-1',
    sandbox: false,
    claudeBin: '/usr/bin/claude',
    remoteControl: false,
    skipPermissions: true,
    sandboxCredentialsFile: join(home, '.claude', '.credentials.json'),
  });
  return { cfg, stateDir, cwd: join(root, 'work') };
}

const read = (/** @type {string} */ f) => JSON.parse(readFileSync(f, 'utf8'));

/**
 * The person's Claude sign-in as their vault gives it to this box: an access
 * token and its account, never a refresh token (vault-store.js).
 * @param {string} stateDir @param {string|null} token  null: the vault gives this box nothing for them now
 */
function signIn(stateDir, token) {
  const items = token ? [{ name: 'claude', value: token, expiresAt: Date.now() + 3_600_000, login: { scopes: ['user:inference'] }, account: { emailAddress: 'person@example.com', organizationUuid: 'org' } }] : [];
  applyVault({ stateDir }, { accounts: [{ email: 'person@example.com', items }] });
}

/** The access token a staged credentials file carries, and that it carries no refresh token. @param {string} f */
const tokenIn = (f) => {
  const oauth = read(f).claudeAiOauth;
  assert.equal(oauth.refreshToken, undefined, 'no refresh token on the box');
  return oauth.accessToken;
};

test('a fresh direct session is staged with the person\'s credential, identity, trust and hook', () => {
  const { cfg, cwd } = box();
  const r = ensureDirectConfig(cfg, 'one', 'fleet:person@example.com', { cwd });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.fresh, true);
  assert.equal(r.account, 'person@example.com');
  assert.equal(r.dir, directConfigDir(cfg, 'one'));

  assert.equal(tokenIn(join(r.dir, '.credentials.json')), 'tok-1');
  assert.equal(read(join(r.dir, '.oauth-account.json')).emailAddress, 'person@example.com');
  const state = read(join(r.dir, '.claude.json'));
  assert.equal(state.oauthAccount.emailAddress, 'person@example.com', 'the identity rides with the credential');
  assert.equal(state.hasCompletedOnboarding, true, 'there is an account, so the wizard has nothing to ask');
  assert.equal(state.theme, 'dark');
  assert.equal(state.projects[cwd].hasTrustDialogAccepted, true, 'the cwd is trusted, or the TUI stops on a question');
  assert.match(readFileSync(join(r.dir, 'settings.json'), 'utf8'), /fleetwright hook/, 'the hook is the box\'s, copied in');
  // Nothing of this went into the box's own home.
  assert.equal(existsSync(cfg.sandboxCredentialsFile), false);
});

test('nothing in their vault for this box is a refusal that names the box, not a login prompt', () => {
  const { cfg, cwd } = box({ link: false });
  const r = ensureDirectConfig(cfg, 'one', 'fleet:person@example.com', { cwd });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.message, /No Claude account to give this session on box-1/);
  assert.match(r.message, /person@example\.com keeps no Claude login in their vault that this box was given/);
  assert.match(r.message, /approve box-1 from its page/);
  assert.equal(existsSync(directConfigDir(cfg, 'one')), false, 'nothing is staged for a session that will not start');
});

test('a direct session started on a vault box runs on its operator’s vault, a sign-in or a token, and never on a link', () => {
  // The operator of a vault box is a person who approved it (accounts.js,
  // operatorAccount); here the one person, who has also linked an account on
  // the box that nothing should read.
  const { cfg, cwd, stateDir } = box();
  new Accounts(stateDir).save('person@example.com', JSON.stringify({ claudeAiOauth: { accessToken: 'linked-here', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }));
  const signedIn = ensureDirectConfig(cfg, 'mine', 'cli', { cwd });
  assert.equal(signedIn.ok, true, signedIn.ok ? '' : signedIn.message);
  if (!signedIn.ok) return;
  assert.equal(signedIn.account, 'person@example.com');
  assert.equal(tokenIn(join(signedIn.dir, '.credentials.json')), 'tok-1');

  // A setup-token, which has no credentials file: found by the person the
  // pick named, since a session on the box itself has no email of its own.
  applyVault({ stateDir }, { accounts: [{ email: 'person@example.com', items: [{ name: 'claude', value: `sk-ant-oat01-${'p'.repeat(40)}`, expiresAt: null }] }] });
  const token = ensureDirectConfig(cfg, 'tok', 'web', { cwd });
  assert.equal(token.ok, true, token.ok ? '' : token.message);
  if (!token.ok) return;
  assert.equal(token.account, 'person@example.com');
  assert.equal(token.auth?.kind, 'token');
  assert.match(String(/** @type {any} */ (token.auth).file), /vault\/person@example\.com\.claude$/);
});

test('a direct session started on a box that stands alone runs on its operator’s linked account, and resumes on it', () => {
  const { cfg, cwd, stateDir } = box({ link: false });
  new Accounts(stateDir).save('ops@example.com', JSON.stringify({ claudeAiOauth: { accessToken: 'linked-1', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }));
  const first = ensureDirectConfig(cfg, 'mine', 'cli', { cwd });
  assert.equal(first.ok, true, first.ok ? '' : first.message);
  if (!first.ok) return;
  assert.equal(first.account, 'ops@example.com');
  assert.equal(read(join(first.dir, '.credentials.json')).claudeAiOauth.accessToken, 'linked-1');

  // Relinked since: the resume takes today's copy.
  new Accounts(stateDir).save('ops@example.com', JSON.stringify({ claudeAiOauth: { accessToken: 'linked-2', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 } }));
  const again = ensureDirectConfig(cfg, 'mine', 'cli', { account: 'ops@example.com', cwd });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(read(join(again.dir, '.credentials.json')).claudeAiOauth.accessToken, 'linked-2');
});

test('a resume keeps its account and takes today\'s credential, and keeps what the CLI wrote', () => {
  const { cfg, cwd, stateDir } = box();
  const first = ensureDirectConfig(cfg, 'one', 'fleet:person@example.com', { cwd });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  // The CLI wrote its own state, and the person renewed their login.
  const stateFile = join(first.dir, '.claude.json');
  writeFileSync(stateFile, JSON.stringify({ ...read(stateFile), numStartups: 3 }));
  signIn(stateDir, 'tok-2');

  // Resumed by somebody else: the record's account wins over the actor.
  const again = ensureDirectConfig(cfg, 'one', 'fleet:colleague@example.com', { account: 'person@example.com', cwd });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.fresh, false);
  assert.equal(again.account, 'person@example.com');
  assert.equal(tokenIn(join(again.dir, '.credentials.json')), 'tok-2', 'same person, current token');
  assert.equal(read(stateFile).numStartups, 3, 'the CLI\'s own state survives a refresh');

  // Record silent: the directory says whose it is.
  const silent = ensureDirectConfig(cfg, 'one', null, { cwd });
  assert.equal(silent.ok && silent.account, 'person@example.com');

  // Their vault stopped giving this box their login since: the session keeps
  // the credential it has rather than refusing to resume or taking somebody else's.
  signIn(stateDir, null);
  const gone = ensureDirectConfig(cfg, 'one', 'fleet:colleague@example.com', { account: 'person@example.com', cwd });
  assert.equal(gone.ok, true);
  assert.equal(tokenIn(join(first.dir, '.credentials.json')), 'tok-2');
});

test('the hook template reaches the next start when it changes, and a session\'s own edits are kept until then', () => {
  const { cfg, cwd } = box();
  const r = ensureDirectConfig(cfg, 'one', 'fleet:person@example.com', { cwd });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const dest = join(r.dir, 'settings.json');
  const template = join(path.dirname(cfg.sandboxCredentialsFile), 'settings.json');
  // The session edited its copy after the template was written: kept.
  writeFileSync(dest, '{"mine":1}');
  const later = Date.now() / 1000 + 5;
  utimesSync(dest, later, later);
  ensureDirectConfig(cfg, 'one', null, { account: 'person@example.com', cwd });
  assert.equal(read(dest).mine, 1);
  // The operator then changed the box's settings: the newer template wins.
  writeFileSync(template, '{"theirs":2}');
  utimesSync(template, later + 5, later + 5);
  ensureDirectConfig(cfg, 'one', null, { account: 'person@example.com', cwd });
  assert.equal(read(dest).theirs, 2);
});

test('forgetting the session forgets its config', () => {
  const { cfg, cwd } = box();
  const r = ensureDirectConfig(cfg, 'one', 'fleet:person@example.com', { cwd });
  assert.equal(r.ok, true);
  removeDirectConfig(cfg, 'one');
  assert.equal(existsSync(directConfigDir(cfg, 'one')), false);
  removeDirectConfig(cfg, 'one'); // and again is fine
});

test('the command points the CLI at the session\'s directory, for a direct session only', () => {
  const { cfg } = box();
  const direct = buildCommand(cfg, { name: 'one', configDir: "/var/lib/fleetwright/direct/it's" });
  assert.match(direct, /^CLAUDE_CONFIG_DIR='\/var\/lib\/fleetwright\/direct\/it'\\''s' IS_SANDBOX=1 exec '\/usr\/bin\/claude'/);
  assert.doesNotMatch(buildCommand(cfg, { name: 'one' }), /CLAUDE_CONFIG_DIR/);
  const sandboxed = buildCommand({
    ...cfg, sandbox: true, podmanBin: 'podman', sandboxHookSocket: false, sandboxImage: 'img', sandboxUserns: 'nomap',
    sandboxMemory: '8g', sandboxCpus: '2', sandboxPidsLimit: '512', sandboxExtraArgs: [], sandboxHookSocketDir: '/run/fleetwright-sidecar',
  }, { name: 'one', configDir: '/x' });
  assert.doesNotMatch(sandboxed, /CLAUDE_CONFIG_DIR/, 'a sandboxed session has its volume; the variable would only reach podman');
});
