// GitHub and Cloudflare tokens, and the promise that they are the person's own.
//
// "The guests will be bringing their own GitHub Cloudflare Claude creds, no
// shared creds to them." That sentence is the specification for most of this
// file — particularly pickSecretsFile, where the rule deliberately differs
// from the Claude credential's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connections, catalogue, isProvider, verifyToken, PROVIDERS } from '../src/core/connectors.js';
import { Accounts } from '../src/core/accounts.js';
import { pickSecretsFile } from '../src/core/podman.js';
import { loadEnvFile } from '../src/core/env-file.js';

const dir = () => mkdtempSync(join(tmpdir(), 'connectors-'));
const GH = 'ghp_notarealtokenatall000000000000000000';

test('every provider offers a link that pre-fills its own token page', () => {
  for (const c of catalogue('deb13-prod')) {
    const url = new URL(c.url); // throws on anything malformed
    assert.equal(url.protocol, 'https:');
    // The pre-fill is the entire reason for a link rather than an instruction:
    // a bare settings page would be a list of steps to follow by hand.
    assert.ok(url.search.length > 0, `${c.provider} link carries no pre-fill`);
    // The box is named on the token, so revoking the right one later is
    // possible without guessing.
    assert.match(decodeURIComponent(url.search), /deb13-prod/);
    assert.ok(c.env.length > 0 && c.hint);
  }
});

test('the catalogue never carries a secret', () => {
  // A picker is rendered from this on a phone. Nothing here may be a token,
  // and the shape of the object is what guarantees it.
  for (const c of catalogue('box')) {
    assert.deepEqual(Object.keys(c).sort(), ['env', 'hint', 'label', 'provider', 'url']);
  }
});

test('a token round-trips, and the metadata file has nothing in it to leak', () => {
  const state = dir();
  const store = new Connections(state);
  const saved = store.save('Guest@Example.com', 'github', GH, 'octocat');
  assert.equal(saved.ok, true);

  const listed = store.list('guest@example.com');
  assert.deepEqual(listed.map((c) => [c.provider, c.account]), [['github', 'octocat']]);
  assert.ok(listed[0].updatedAt > 0);

  // THE ONLY FILE THE SECRET IS IN. The status a phone asks for is read from
  // the other one, so there is nothing there to serialise by accident.
  const meta = readFileSync(store.metaPathFor('guest@example.com'), 'utf8');
  assert.equal(meta.includes(GH), false);
  assert.ok(readFileSync(store.envPathFor('guest@example.com'), 'utf8').includes(GH));

  for (const f of [store.envPathFor('guest@example.com'), store.metaPathFor('guest@example.com')]) {
    assert.equal(statSync(f).mode & 0o777, 0o600, f);
  }
});

test('the env file is readable by both things that read it', () => {
  const state = dir();
  const store = new Connections(state);
  // Every character a real token uses, including the ones that look like
  // trouble in a shell.
  const token = 'ghp_aB3.xY-_~9/z=Q:1';
  store.save('a@b.com', 'github', token, 'octocat');
  const file = store.envPathFor('a@b.com');

  // 1. The sandbox entrypoint sources it with `.`
  const out = execFileSync('sh', ['-c', `set -a; . '${file}'; printf '%s' "$GH_TOKEN"`], { encoding: 'utf8' });
  assert.equal(out, token);

  // 2. systemd's parser, which is what src/core/env-file.js reproduces
  const env = {};
  loadEnvFile(file, env);
  assert.equal(env.GH_TOKEN, token);
  assert.equal(env.GITHUB_TOKEN, token, 'both names, so nothing has to learn the difference');
});

test('a token that would need escaping is refused rather than escaped', () => {
  // THE TWO READERS DISAGREE. `sh` understands `'\''` and systemd does not,
  // so a value containing a quote is readable by one and mangled by the other
  // — and which one mangles it depends on where the file is being read, which
  // is the worst possible place for that to be decided. Refusing the
  // characters removes the disagreement instead of picking a side.
  const store = new Connections(dir());
  for (const bad of [`tok'en`, 'tok"en', 'tok\\en', 'tok en', 'tok\nen', '', 'x'.repeat(5000)]) {
    const r = store.save('a@b.com', 'github', bad, null);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.message, /does not look like a token/);
  }
  assert.equal(existsSync(store.envPathFor('a@b.com')), false, 'nothing was written');
});

test('unlinking removes the token and says what it cannot do', () => {
  const state = dir();
  const store = new Connections(state);
  store.save('a@b.com', 'github', GH, 'octocat');
  store.save('a@b.com', 'cloudflare', 'cf-token', null);

  const r = store.remove('a@b.com', 'github');
  assert.equal(r.ok, true);
  // Honest about the limit: this box forgot it, the provider did not.
  assert.match(r.message, /revoke it there|still live/i);

  const left = readFileSync(store.envPathFor('a@b.com'), 'utf8');
  assert.equal(left.includes(GH), false);
  assert.ok(left.includes('cf-token'), 'the other provider survives');
  assert.deepEqual(store.list('a@b.com').map((c) => c.provider), ['cloudflare']);

  store.remove('a@b.com', 'cloudflare');
  assert.equal(existsSync(store.envPathFor('a@b.com')), false, 'the last removal takes the file with it');
  assert.deepEqual(store.list('a@b.com'), []);
});

test('removing something that was never there is a refusal, not a success', () => {
  const store = new Connections(dir());
  assert.equal(store.remove('a@b.com', 'github').ok, false);
  assert.equal(store.remove('a@b.com', 'nonesuch').ok, false);
});

test('a connections file is not a linked Claude account', () => {
  // The bug this pins: Accounts.list() filters *.json and would have listed
  // `a@b.com.connections` as a person. Every sibling file this directory grows
  // is added by somebody not thinking about that function.
  const state = dir();
  new Connections(state).save('a@b.com', 'github', GH, 'octocat');
  assert.deepEqual(new Accounts(state).list(), []);
});

test('a member gets their own tokens or none — never somebody else’s', () => {
  const state = dir();
  const store = new Connections(state);
  const cfg = /** @type {any} */ ({ stateDir: state });

  // The box's own row, as an operator would set it from the CLI.
  store.save(null, 'github', 'the-admins-token', 'admin');

  // A guest who has connected nothing gets NOTHING. This is the difference
  // from the Claude credential, which falls back to the shared org account: a
  // shared plan is a licence somebody chose to share, and a GitHub token is
  // one person's access to their own repositories.
  assert.equal(pickSecretsFile(cfg, 'fleet:guest@example.com'), null);

  // Once they connect their own, they get theirs.
  store.save('guest@example.com', 'github', 'the-guests-token', 'guest');
  const theirs = pickSecretsFile(cfg, 'fleet:guest@example.com');
  assert.ok(readFileSync(theirs, 'utf8').includes('the-guests-token'));
  assert.equal(readFileSync(theirs, 'utf8').includes('the-admins-token'), false);

  // An actor with no email is somebody operating the box itself — the CLI,
  // Telegram, the web UI — and gets the box's row.
  for (const actor of ['telegram:12345', 'web', 'cli', null]) {
    const file = pickSecretsFile(cfg, actor);
    assert.ok(file && readFileSync(file, 'utf8').includes('the-admins-token'), String(actor));
  }
});

test('a token is checked before it is stored, and the reasons stay apart', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });

  globalThis.fetch = async () => new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
  assert.deepEqual(await verifyToken('github', GH), {
    ok: true, account: 'octocat', message: 'GitHub token verified as @octocat.',
  });

  globalThis.fetch = async () => new Response('{}', { status: 401 });
  const rejected = await verifyToken('github', GH);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /rejected that token/);

  // "Could not reach GitHub" sends somebody to check their connection.
  // "GitHub rejected that token" sends them to mint a new one. Collapsing the
  // two wastes whichever of those trips was the wrong one.
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const unreachable = await verifyToken('github', GH);
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.message, /Could not reach GitHub/);
  assert.match(unreachable.message, /Nothing was stored/);
});

test('cloudflare reports an inactive token as inactive, not as a network problem', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: true, result: { status: 'disabled' } }), { status: 200 });
  const r = await verifyToken('cloudflare', 'x');
  assert.equal(r.ok, false);
  assert.match(r.message, /disabled/);
});

test('an unknown provider is refused by name', async () => {
  assert.equal(isProvider('github'), true);
  assert.equal(isProvider('toString'), false, 'hasOwn, so a prototype key is not a provider');
  assert.equal((await verifyToken('nonesuch', 'x')).ok, false);
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['cloudflare', 'github']);
});

test('the payload a picker is built from carries both kinds of credential', async () => {
  // Claude is an OAuth login the CLI drives in a pane; GitHub and Cloudflare
  // are tokens a person mints on a page. connectors.js knows only about the
  // second kind, on purpose — so the merge is tested here, at the one place
  // that sees both.
  const { dispatch } = await import('../src/adapters/commands.js');
  const state = dir();
  new Connections(state).save('me@example.com', 'github', GH, 'octocat');

  const ctx = /** @type {any} */ ({
    cfg: { stateDir: state, hostname: 'deb13-prod', loginEnabled: true },
    actor: 'fleet:me@example.com',
    login: { status: () => ({ loggedIn: false }) },
  });
  const reply = await dispatch(ctx, '/connect');
  assert.equal(reply.ok, true);

  const providers = reply.connections.catalogue.map((c) => c.provider);
  assert.deepEqual(providers, ['claude', 'github', 'cloudflare']);

  // Claude has no static page to send anybody to: the authorization URL is
  // minted per attempt in a pane on that box. `null` is the honest answer
  // there, and a missing field would not be.
  assert.equal(reply.connections.catalogue[0].url, null);
  assert.deepEqual(
    reply.connections.connected.map((c) => [c.provider, c.account]),
    [['github', 'octocat']],
  );

  // NOTHING IN THIS PAYLOAD IS A TOKEN. It is rendered on a phone and it
  // travels through the coordinator to get there.
  assert.equal(JSON.stringify(reply.connections).includes(GH), false);
});

test('a linked Claude account shows as connected for the person who linked it', async () => {
  const { dispatch } = await import('../src/adapters/commands.js');
  const { Accounts } = await import('../src/core/accounts.js');
  const state = dir();
  mkdirSync(join(state, 'accounts'), { recursive: true });
  new Accounts(state).save('me@example.com', JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));

  const ctx = /** @type {any} */ ({
    cfg: { stateDir: state, hostname: 'box', loginEnabled: true },
    actor: 'fleet:me@example.com',
    login: { status: () => ({ loggedIn: true, email: 'the-box@example.com' }) },
  });
  const reply = await dispatch(ctx, '/connect');
  // THEIRS, not the box's. A member asking "am I connected" is not asking
  // what account the machine runs on — that distinction is the whole of
  // docs/accounts.md.
  assert.deepEqual(
    reply.connections.connected.filter((c) => c.provider === 'claude').map((c) => c.account),
    ['me@example.com'],
  );
});
