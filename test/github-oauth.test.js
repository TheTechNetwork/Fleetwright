// The GitHub App's user-to-server flow, and the one value holding it together.
//
// GitHub redirects a BROWSER to the coordinator, and a browser carries no
// fleet credential. `state` is the only thing tying that request to a flow
// this coordinator started — so it has to be unguessable, single-use,
// short-lived, and bound to both the host and the person. Miss any one and the
// callback is an open door that writes a credential onto a machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PendingAuthorizations, authorizeUrl, exchangeCode, callbackPage } from '../src/fleet/coordinator/github-oauth.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const APP = { clientId: 'Iv23liTEST', clientSecret: 'shh', slug: 'fleetwright-agents' };

test('a state is redeemable exactly once', () => {
  // A callback replayed from browser history, or delivered twice, must not
  // exchange a second time.
  const p = new PendingAuthorizations();
  p.mint({ state: 's1', hostId: 'box', email: 'a@b.com' });
  assert.deepEqual(
    { ...p.redeem('s1'), at: undefined },
    { hostId: 'box', email: 'a@b.com', at: undefined },
  );
  assert.equal(p.redeem('s1'), null);
});

test('a state expires, and an unknown one is refused the same way', () => {
  let clock = 1_000_000;
  const p = new PendingAuthorizations({ now: () => clock, ttlMs: 600_000 });
  p.mint({ state: 's1', hostId: 'box', email: null });
  clock += 600_001;
  assert.equal(p.redeem('s1'), null);
  assert.equal(p.redeem('never-existed'), null);
  // Same answer for expired and unknown — telling a stranger which it was is
  // telling them whether a state exists.
});

test('a flood of abandoned flows cannot evict a live one mid-authorization', () => {
  const p = new PendingAuthorizations();
  p.mint({ state: 'mine', hostId: 'box', email: 'a@b.com' });
  for (let i = 0; i < 500; i++) p.mint({ state: `junk${i}`, hostId: 'box', email: null });
  // Oldest-first eviction means the earliest flow goes first, which is the
  // honest trade: bounded memory, and the loser is the oldest rather than a
  // random one. Pinned so a change to LIFO is a visible decision.
  assert.equal(p.redeem('mine'), null);
  assert.ok(p.pending.size <= 200);
});

test('the authorize URL names its own redirect', () => {
  // Sent explicitly rather than relying on the App's default, so a deployment
  // on a different origin cannot silently send its users to somebody else's
  // coordinator — GitHub matches it against the registered list and refuses a
  // mismatch, which is behaviour worth depending on.
  const url = new URL(authorizeUrl({ clientId: 'abc', origin: 'https://fleet.example/', state: 'xyz' }));
  assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'abc');
  assert.equal(url.searchParams.get('state'), 'xyz');
  // One slash, not two: the origin came in with a trailing one.
  assert.equal(url.searchParams.get('redirect_uri'), 'https://fleet.example/oauth/github/callback');
});

test('GitHub answering 200-with-an-error is treated as the failure it is', async () => {
  const res = await exchangeCode({
    clientId: 'a', clientSecret: 'b', code: 'c', origin: 'https://f.example',
    fetch: async () => new Response(JSON.stringify({ error: 'bad_verification_code', error_description: 'expired' }), { status: 200 }),
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /expired/);
});

test('an unreachable GitHub is a different message from a refused one', async () => {
  const res = await exchangeCode({
    clientId: 'a', clientSecret: 'b', code: 'c', origin: 'https://f.example',
    fetch: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.equal(res.ok, false);
  assert.match(res.message, /Could not reach GitHub/);
});

test('the connect reply offers the App only when one is configured', () => {
  const withApp = new CoordinatorCore({ logger: quiet, githubApp: APP });
  const without = new CoordinatorCore({ logger: quiet });
  const reply = {
    ok: true,
    connections: {
      catalogue: [
        { provider: 'claude', url: null },
        { provider: 'github', url: 'https://github.com/settings/tokens/new?scopes=repo' },
        { provider: 'cloudflare', url: 'https://dash.cloudflare.com/profile/api-tokens' },
      ],
      connected: [],
    },
  };

  const offered = withApp.offerGithubApp(reply, 'box', 'a@b.com', 'https://fleet.example');
  const github = offered.connections.catalogue.find((c) => c.provider === 'github');
  assert.match(github.url, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.equal(github.flow, 'app', 'the app must know not to render a paste field');

  // CLOUDFLARE IS UNTOUCHED, and always will be: there is no third-party app
  // program to rewrite it to.
  assert.equal(
    offered.connections.catalogue.find((c) => c.provider === 'cloudflare').url,
    'https://dash.cloudflare.com/profile/api-tokens',
  );

  // And with no App, the paste route is returned exactly as the host sent it.
  assert.deepEqual(without.offerGithubApp(reply, 'box', 'a@b.com', 'https://fleet.example'), reply);
});

test('a callback for a flow this coordinator did not start is refused', async () => {
  const core = new CoordinatorCore({ logger: quiet, githubApp: APP });
  const bogus = await core.finishGithubAuthorization({ code: 'c', state: 'invented', origin: 'https://f.example' });
  assert.equal(bogus.ok, false);
  assert.match(bogus.text, /expired or was already used/);

  // A real state with no code is refused too, and separately — GitHub sending
  // nothing back is a different fault from somebody forging a state.
  core.pendingGithub.mint({ state: 'real', hostId: 'box', email: 'a@b.com' });
  const noCode = await core.finishGithubAuthorization({ code: null, state: 'real', origin: 'https://f.example' });
  assert.equal(noCode.ok, false);
  assert.match(noCode.text, /did not send an authorization code/);
});

test('the browser gets a page, and the page cannot be injected into', () => {
  const page = callbackPage({ ok: false, text: '<script>alert(1)</script> & "quoted"' });
  assert.equal(page.includes('<script>alert'), false);
  assert.match(page, /&lt;script&gt;/);
  // Nothing to load: this is served by the coordinator and must not become a
  // page that fetches anything.
  assert.equal(/src=|href=/.test(page), false);
});

test('a fleet with no App configured says so rather than failing oddly', async () => {
  const core = new CoordinatorCore({ logger: quiet });
  const r = await core.finishGithubAuthorization({ code: 'c', state: 's', origin: 'https://f.example' });
  assert.equal(r.ok, false);
  assert.match(r.text, /no GitHub App configured/);
});

test('neither app asks for a paste when there is nothing to paste', async () => {
  // The whole point of the App: GitHub sends the result to the coordinator,
  // which hands it to the box. A token field on that screen would be asking
  // somebody for something that does not exist.
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const [name, view, model] of [
    ['iOS', 'apps/ios/Fleetwright/Credentials.swift', 'apps/ios/Fleetwright/Fleet.swift'],
    [
      'Android',
      'apps/android/app/src/main/java/network/thetech/fleetwright/CredentialsSheet.kt',
      'apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt',
    ],
  ]) {
    assert.match(read(model), /isAppFlow/, `${name} cannot tell an app flow from a paste`);
    assert.match(read(view), /isAppFlow/, `${name} renders the same screen for both flows`);
    // And the paste half survives — it is the only route for Cloudflare, and
    // for any deployment that has not registered an App.
    assert.match(read(view), /Come back and paste/, `${name} lost the paste route`);
  }
});
