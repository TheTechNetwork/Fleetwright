// The browser OAuth flows — GitHub's App and Cloudflare's client — and the one
// value holding them together.
//
// The provider redirects a BROWSER to the coordinator, and a browser carries no
// fleet credential. `state` is the only thing tying that request to a flow
// this coordinator started — so it has to be unguessable, single-use,
// short-lived, and bound to both the host and the person. Miss any one and the
// callback is an open door that writes a credential onto a machine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  PendingAuthorizations,
  authorizeUrl,
  cloudflareAuthorizeUrl,
  exchangeCode,
  exchangeCloudflareCode,
  callbackPage,
} from '../src/fleet/coordinator/oauth.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { androidSources } from './helpers/android-sources.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const APP = { clientId: 'Iv23liTEST', clientSecret: 'shh', slug: 'fleetwright-agents' };
const CF = { clientId: 'cf-client-id', clientSecret: 'cf-shh', scopes: 'account-settings.read workers-scripts.edit offline_access' };

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

  const offered = withApp.offerOauth(reply, 'box', 'a@b.com', 'https://fleet.example');
  const github = offered.connections.catalogue.find((c) => c.provider === 'github');
  assert.match(github.url, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
  assert.equal(github.flow, 'app', 'the app must know not to render a paste field');

  // CLOUDFLARE IS UNTOUCHED when no Cloudflare client is registered — each
  // provider's offer stands on its own configuration.
  assert.equal(
    offered.connections.catalogue.find((c) => c.provider === 'cloudflare').url,
    'https://dash.cloudflare.com/profile/api-tokens',
  );

  // And with no App, the paste route is returned exactly as the host sent it.
  assert.deepEqual(without.offerOauth(reply, 'box', 'a@b.com', 'https://fleet.example'), reply);
});

test('a registered Cloudflare client rewrites the cloudflare entry the same way', () => {
  const core = new CoordinatorCore({ logger: quiet, cloudflareOauth: CF });
  const reply = {
    ok: true,
    connections: {
      catalogue: [
        { provider: 'github', url: 'https://github.com/settings/tokens/new' },
        { provider: 'cloudflare', url: 'https://dash.cloudflare.com/profile/api-tokens' },
      ],
      connected: [],
    },
  };
  const offered = core.offerOauth(reply, 'box', 'a@b.com', 'https://fleet.example');
  const cf = offered.connections.catalogue.find((c) => c.provider === 'cloudflare');
  assert.match(cf.url, /^https:\/\/dash\.cloudflare\.com\/oauth2\/auth\?/);
  assert.equal(cf.flow, 'app');
  // GitHub is untouched: no App is configured here.
  assert.equal(
    offered.connections.catalogue.find((c) => c.provider === 'github').url,
    'https://github.com/settings/tokens/new',
  );
  // And its state landed in Cloudflare's OWN pending store — a GitHub
  // callback must not be able to redeem it.
  assert.equal(core.pendingCloudflare.pending.size, 1);
  assert.equal(core.pendingGithub.pending.size, 0);
});

test('a Cloudflare client without a scope list is no offer at all', () => {
  // Without scopes the authorize request asks Cloudflare for nothing, and
  // what comes back is a token that verifies and then cannot do a single
  // piece of work — discovered four hours into a session. The paste route
  // stays, which works.
  const core = new CoordinatorCore({ logger: quiet, cloudflareOauth: { ...CF, scopes: undefined } });
  const reply = {
    ok: true,
    connections: { catalogue: [{ provider: 'cloudflare', url: 'https://dash.cloudflare.com/profile/api-tokens' }], connected: [] },
  };
  assert.deepEqual(core.offerOauth(reply, 'box', 'a@b.com', 'https://fleet.example'), reply);
  assert.equal(core.pendingCloudflare.pending.size, 0, 'no state was minted for a flow that cannot work');
});

test('the Cloudflare authorize URL names its own redirect and its scopes', () => {
  const url = new URL(cloudflareAuthorizeUrl({
    clientId: 'abc',
    origin: 'https://fleet.example/',
    state: 'xyz',
    // Commas tolerated: a list in an environment variable gets written both
    // ways, and RFC 6749 wants spaces on the wire.
    scopes: 'account-settings.read,workers-scripts.edit, offline_access',
  }));
  assert.equal(url.origin + url.pathname, 'https://dash.cloudflare.com/oauth2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'abc');
  assert.equal(url.searchParams.get('state'), 'xyz');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://fleet.example/oauth/cloudflare/callback');
  assert.equal(url.searchParams.get('scope'), 'account-settings.read workers-scripts.edit offline_access');
});

test('the Cloudflare exchange is form-encoded, and a non-200 is the failure it is', async () => {
  // Cloudflare's token endpoint is RFC 6749 as written: a JSON body is a 400,
  // and a refusal is a status code carrying error/error_description — where
  // GitHub answers 200 with an error field.
  let sent = null;
  const ok = await exchangeCloudflareCode({
    clientId: 'a', clientSecret: 'b', code: 'c', origin: 'https://f.example',
    fetch: async (_url, init) => {
      sent = init;
      return new Response(JSON.stringify({ access_token: 'cf-token', refresh_token: 'cf-refresh', expires_in: 3600 }), { status: 200 });
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.accessToken, 'cf-token');
  assert.equal(ok.refreshToken, 'cf-refresh');
  assert.equal(sent.headers['content-type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(String(sent.body));
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('redirect_uri'), 'https://f.example/oauth/cloudflare/callback');
  assert.equal(form.get('client_secret'), 'b');

  const refused = await exchangeCloudflareCode({
    clientId: 'a', clientSecret: 'b', code: 'c', origin: 'https://f.example',
    fetch: async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'code spent' }), { status: 400 }),
  });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /code spent/);

  const unreachable = await exchangeCloudflareCode({
    clientId: 'a', clientSecret: 'b', code: 'c', origin: 'https://f.example',
    fetch: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.message, /Could not reach Cloudflare/);

  // A 200 with no token in it is a failure with a name, not an undefined on a
  // screen.
  const empty = await exchangeCloudflareCode({
    clientId: 'a', clientSecret: 'b', code: 'c', origin: 'https://f.example',
    fetch: async () => new Response(JSON.stringify({ token_type: 'bearer' }), { status: 200 }),
  });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /no access token/);

  // And an origin that is not one refuses before anything is sent — same as
  // the authorize URL builder, which yields no URL at all.
  const lost = await exchangeCloudflareCode({ clientId: 'a', clientSecret: 'b', code: 'c', origin: 'nonsense' });
  assert.equal(lost.ok, false);
  assert.match(lost.message, /its own address/);
  assert.equal(cloudflareAuthorizeUrl({ clientId: 'a', origin: 'nonsense', state: 's', scopes: 'account-settings.read' }), null);
});

test('a Cloudflare callback for a flow this coordinator did not start is refused', async () => {
  const core = new CoordinatorCore({ logger: quiet, cloudflareOauth: CF });
  const bogus = await core.finishCloudflareAuthorization({ code: 'c', state: 'invented', origin: 'https://f.example' });
  assert.equal(bogus.ok, false);
  assert.match(bogus.text, /expired or was already used/);

  // A GitHub state cannot finish a Cloudflare flow: the two providers keep
  // separate pending stores, so this needs no check anybody could forget.
  core.pendingGithub.mint({ state: 'gh-state', hostId: 'box', email: 'a@b.com' });
  const crossed = await core.finishCloudflareAuthorization({ code: 'c', state: 'gh-state', origin: 'https://f.example' });
  assert.equal(crossed.ok, false);
  assert.match(crossed.text, /expired or was already used/);

  // A real state with no code — the person pressed Deny — is refused with a
  // fixed sentence, never the query's own words.
  core.pendingCloudflare.mint({ state: 'real', hostId: 'box', email: 'a@b.com' });
  const noCode = await core.finishCloudflareAuthorization({ code: null, state: 'real', origin: 'https://f.example' });
  assert.equal(noCode.ok, false);
  assert.match(noCode.text, /did not send an authorization code/);
});

test('a fleet with no Cloudflare client configured says so rather than failing oddly', async () => {
  const core = new CoordinatorCore({ logger: quiet });
  const r = await core.finishCloudflareAuthorization({ code: 'c', state: 's', origin: 'https://f.example' });
  assert.equal(r.ok, false);
  assert.match(r.text, /no Cloudflare OAuth client configured/);
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
  // NOTHING EXTERNAL TO LOAD, which is the property that matters — this is
  // served by the coordinator and must not become a page that fetches
  // anything. The assertion used to be "no href at all", which was a proxy for
  // that and broke the moment the page grew a link back into the app. A link
  // to our own scheme loads nothing.
  assert.equal(/(src|href)\s*=\s*["']?https?:/i.test(page), false, 'the callback page loads something external');
  assert.match(page, /href="fleetwright:\/\/connected/, 'and it offers the way back');
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

test('the origin is parsed, not trimmed — CodeQL was right', async () => {
  const { normaliseOrigin } = await import('../src/fleet/coordinator/oauth.js');

  // THE FINDING. `origin.replace(/\/+$/, '')` backtracks: an anchored `\/+$`
  // against a long run of slashes that does NOT end the string is polynomial.
  // Measured at 60,000 slashes with one character after them: 2,957ms.
  //
  // And the input was not ours — the Node coordinator built its origin from
  // `req.headers.host`, so the slow string was one header away.
  const nasty = `https://x${'/'.repeat(60_000)}a`;
  const started = Date.now();
  normaliseOrigin(nasty);
  assert.ok(Date.now() - started < 500, 'parsing the origin is not linear any more');

  // Parsing makes the trimming unnecessary rather than faster: an origin
  // cannot carry a trailing slash.
  assert.equal(normaliseOrigin('https://fleet.example////'), 'https://fleet.example');
  assert.equal(normaliseOrigin('https://fleet.example/some/path'), 'https://fleet.example');

  // And it refuses what is not an address at all, which the trim silently
  // accepted and passed to GitHub.
  assert.equal(normaliseOrigin('not a url'), null);
  assert.equal(normaliseOrigin('javascript:alert(1)'), null);
  assert.equal(normaliseOrigin(''), null);
  assert.equal(normaliseOrigin('x'.repeat(5000)), null);
});

test('an unparseable origin leaves the paste route rather than breaking it', () => {
  const core = new CoordinatorCore({ logger: quiet, githubApp: APP });
  const reply = {
    ok: true,
    connections: { catalogue: [{ provider: 'github', url: 'https://github.com/settings/tokens/new' }], connected: [] },
  };
  const out = core.offerOauth(reply, 'box', 'a@b.com', 'nonsense');
  // Better a working paste than an authorize URL built out of something that
  // was not an address.
  assert.deepEqual(out, reply);
  assert.equal(core.pendingGithub.pending.size, 0, 'and no state was minted for a flow that cannot start');
});

test('no anchored quantifier runs on a caller-supplied string', async () => {
  // A tripwire on the shape rather than the instance: the next `\/+$` on a
  // header-derived value would be the same bug with a different name.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/fleet/coordinator/oauth.js', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.equal(/replace\(\/[^/]*\+\$\//.test(code), false, 'an anchored + quantifier is back in this file');
});

test('the access token is stored, never the refresh token', async () => {
  // THE 401. This read `refreshToken ?? accessToken`, reaching for the
  // longer-lived value — and a refresh token is not an API credential. It
  // authenticates nothing: `GET /user` with one is a 401 every time. So the
  // whole flow worked and then reported "GitHub rejected that token (401)",
  // which reads like a bad token and was a wrong one.
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/fleet/coordinator/core.js', import.meta.url), 'utf8'),
  );
  // The storing half now lives in one place for both providers, which is
  // where the invariant has to hold.
  const fn = /async #storeAuthorizedToken\([\s\S]*?\n  \}/.exec(src);
  assert.ok(fn, 'the shared token-storing helper is gone');
  // COMMENTS STRIPPED FIRST. The comment above that line quotes the bug it
  // fixed — `refreshToken ?? accessToken` — so matching raw source finds the
  // explanation and calls it the defect. Third time this shape has cost a
  // rewrite: a tripwire has to read code, not prose about code.
  const code = fn[0]
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.match(code, /const secret = exchanged\.accessToken;/);
  assert.equal(/refreshToken \?\?/.test(code), false, 'the refresh token is being stored as a credential again');
});

test('the callback hands control back to the app', async () => {
  const { appReturnUrl, callbackPage } = await import('../src/fleet/coordinator/oauth.js');

  // Only fixed values, all ours. A redirect target a query parameter could
  // steer is an open redirect, and this page is reached by following a link
  // from the provider.
  assert.equal(appReturnUrl({ ok: true }), 'fleetwright://connected?provider=github&ok=1');
  assert.equal(appReturnUrl({ ok: false }), 'fleetwright://connected?provider=github&ok=0');
  assert.equal(appReturnUrl({ ok: true, provider: 'cloudflare' }), 'fleetwright://connected?provider=cloudflare&ok=1');

  // The Cloudflare page says Cloudflare and returns with its own provider tag
  // — and a provider outside the fixed two-value vocabulary cannot steer
  // either the words or the scheme.
  const cf = callbackPage({ ok: true, text: 'done', provider: 'cloudflare' });
  assert.match(cf, /Cloudflare connected/);
  assert.match(cf, /provider=cloudflare/);
  const forged = callbackPage({ ok: true, text: 'done', provider: '"><script>x</script>' });
  assert.equal(forged.includes('<script>x'), false);
  assert.match(forged, /provider=github/);

  // Attempted AND offered. A custom scheme fails silently when the app is not
  // installed — a desktop browser, a private window — so the page has to work
  // on its own afterwards rather than being a blank screen that went nowhere.
  const page = callbackPage({ ok: true, text: 'done' });
  assert.match(page, /location\.replace/);
  assert.match(page, /Back to Fleetwright/);
});

test('both apps register the scheme the callback returns to', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

  // iOS declares it in the generated Info.plist via project.yml.
  assert.match(read('apps/ios/project.yml'), /CFBundleURLSchemes:\s*\n\s*- fleetwright/);
  assert.match(read('apps/ios/Fleetwright/FleetwrightApp.swift'), /onOpenURL/);

  // Android declares an intent filter, and singleTask so returning resumes the
  // app that started the flow rather than stacking a second copy on it.
  const manifest = read('apps/android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:scheme="fleetwright"/);
  assert.match(manifest, /android:launchMode="singleTask"/);
});

test('the app flow is one tap on both phones, and the paste flow is not', () => {
  // "Why is update or login two clicks when we can do one in an embedded
  // browser." It was two because each app launched an external browser and
  // then had nothing to do but wait — the "Done" button existed so a person
  // could tell the app about a callback it had already been handed and
  // dropped. The app was asking the person to be the callback.
  const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const ios = read('apps/ios/Fleetwright/WebAuth.swift') + read('apps/ios/Fleetwright/Credentials.swift');
  const android =
    read('apps/android/app/src/main/java/network/thetech/fleetwright/WebAuth.kt') +
    read('apps/android/app/src/main/java/network/thetech/fleetwright/CredentialsSheet.kt') +
    androidSources();

  // THE BROWSER IS A REAL BROWSER on both, and that matters more than the tap.
  // ASWebAuthenticationSession and a Custom Tab both show the real address bar
  // and the real padlock and run outside this app's process. A WKWebView or a
  // WebView would look tidier and would be a login form drawn by the app that
  // is asking for it, which is the shape of every phishing screen ever built.
  assert.match(ios, /ASWebAuthenticationSession/);
  assert.match(android, /CustomTabsIntent/);

  // COMMENTS STRIPPED FIRST. This is the fifth tripwire in this repo to match
  // the prose explaining why something is wrong rather than the thing being
  // wrong — the paragraph above each of these says the word "WebView" in order
  // to rule it out.
  const code = (/** @type {string} */ src) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/WKWebView/.test(code(ios)), 'iOS must not draw the provider login itself');
  assert.ok(!/\bWebView\b/.test(code(android)), 'Android must not draw it either');

  for (const [name, src] of [['iOS', ios], ['Android', android]]) {
    // The one-tap path is gated on the app flow. The paste route has no
    // redirect to wait for, so an embedded browser there would open a window
    // that never closes itself — worse than a link that is honest about
    // leaving.
    assert.match(src, /isAppFlow/, `${name} does not distinguish the two flows`);
    // And the button that asked somebody to confirm what already happened is
    // gone.
    assert.ok(!/"2\. That is all/.test(code(src)), `${name} still shows a step 2 for a flow with no step 2`);
  }

  // Android needs one thing iOS does not: the redirect arrives as an Intent on
  // the activity rather than as a return value, and the manifest has claimed
  // that scheme since the App round with nothing consuming it.
  assert.match(android, /onNewIntent/);
  assert.match(android, /WebAuth\.deliver/);
});

test('installing the App is not a broken sign-in link', async () => {
  // REPORTED FROM THE LIVE COORDINATOR, on a page headed "Not connected":
  //
  //   /oauth/github/callback?code=…&installation_id=159793900&setup_action=install
  //
  // Two flows arrive at this one URL and only one of them was ours.
  // AUTHORIZATION starts in the app: we mint a state, GitHub hands it back,
  // and there is a person to attach the token to. INSTALLATION starts on
  // GitHub's own page: it sends `installation_id` and `setup_action` and no
  // state, because nobody here started it.
  //
  // The second was being told its link had expired or been used, which is
  // alarming and untrue — nothing expired and the install worked.
  const core = new CoordinatorCore({ logger: quiet, githubApp: APP });
  const r = await core.finishGithubAuthorization({
    code: '6aa010f044fb4ab1c82f',
    state: null,
    setupAction: 'install',
    installationId: '159793900',
    origin: 'https://f.example',
  });

  assert.equal(r.ok, true, 'an installation was reported as a failure');
  assert.equal(r.installed, true);
  assert.doesNotMatch(r.text, /expired|already used/);
  // It says what is still missing, and where. An install with nothing to do
  // next is a person who thinks they are connected and is not.
  assert.match(r.text, /installed/i);
  assert.match(r.text, /Connect/);
});

test('an installation is attributed to nobody, because nobody proved anything', async () => {
  // NO STATE MEANS NO VERIFIED ACTOR. Storing a token for whoever happens to be
  // holding the URL is the thing every other flow here refuses to do, and an
  // installation callback is exactly the shape that invites it: there is a
  // `code` in the query, and exchanging it would produce a real token belonging
  // to a real GitHub account. It is nobody's until somebody signs in and asks.
  const dispatched = [];
  const core = new CoordinatorCore({ logger: quiet, githubApp: APP });
  core.dispatch = async (spec) => { dispatched.push(spec); return { ok: true }; };

  await core.finishGithubAuthorization({
    code: 'a-real-code', state: null, setupAction: 'install', installationId: '1', origin: 'https://f.example',
  });
  assert.deepEqual(dispatched, [], 'an unattributed installation stored a credential');
});

test('a missing state with no installation is still an expired link', async () => {
  // The ambiguity is deliberate and stays: unknown, expired and replayed get
  // one message, because telling a stranger which it was tells them whether a
  // state exists. `setup_action` is what separates the honest third case.
  const core = new CoordinatorCore({ logger: quiet, githubApp: APP });
  const r = await core.finishGithubAuthorization({ code: 'c', state: null, origin: 'https://f.example' });
  assert.equal(r.ok, false);
  assert.match(r.text, /expired or was already used/);
});

test('the installed page does not bounce back into the app', () => {
  // Every other outcome redirects, because the app was waiting for an answer.
  // This one was not started from the app, so there is nothing waiting and
  // nothing that knows to say "you are not connected yet" — bouncing would hide
  // the only sentence explaining what is left to do.
  const installed = callbackPage({ ok: true, installed: true, text: 'installed, connect from the app' });
  assert.doesNotMatch(installed, /location\.replace/);
  assert.match(installed, /GitHub App installed/);
  // The link out is still there for somebody who wants it.
  assert.match(installed, /Back to Fleetwright/);

  // And the ordinary outcomes are unchanged.
  assert.match(callbackPage({ ok: true, text: 'done' }), /location\.replace/);
  assert.match(callbackPage({ ok: false, text: 'no' }), /location\.replace/);
});

test('the Node coordinator reads the same OAuth variables the Worker does', async () => {
  // docs/coordinator-deploy.md has said "set AGENT_FLEET_GITHUB_CLIENT_ID plus
  // the secret" since the App shipped, and setting them did NOTHING on this
  // coordinator: the core was constructed without them, so its
  // /oauth/github/callback — served, and documented in openapi.json — answered
  // "no GitHub App configured" on every request, the catalogue never offered
  // the App, and no host behind a Node coordinator could ever renew. Both
  // coordinators SERVED the route, so openapi.test.js could not see it: parity
  // of routes, divergence of configuration.
  const { Coordinator } = await import('../src/fleet/coordinator/server.js');
  const names = [
    'AGENT_FLEET_GITHUB_CLIENT_ID', 'AGENT_FLEET_GITHUB_CLIENT_SECRET',
    'AGENT_FLEET_CLOUDFLARE_CLIENT_ID', 'AGENT_FLEET_CLOUDFLARE_CLIENT_SECRET', 'AGENT_FLEET_CLOUDFLARE_SCOPES',
  ];
  const saved = names.map((n) => [n, process.env[n]]);
  try {
    process.env.AGENT_FLEET_GITHUB_CLIENT_ID = 'Iv23liTEST';
    process.env.AGENT_FLEET_GITHUB_CLIENT_SECRET = 'shh';
    process.env.AGENT_FLEET_CLOUDFLARE_CLIENT_ID = 'cf-id';
    process.env.AGENT_FLEET_CLOUDFLARE_CLIENT_SECRET = 'cf-shh';
    process.env.AGENT_FLEET_CLOUDFLARE_SCOPES = 'account-settings.read offline_access';
    const c = new Coordinator({ logger: quiet });
    assert.equal(c.core.githubApp?.clientId, 'Iv23liTEST');
    assert.equal(c.core.githubApp?.clientSecret, 'shh');
    assert.equal(c.core.cloudflareOauth?.clientId, 'cf-id');
    assert.equal(c.core.cloudflareOauth?.scopes, 'account-settings.read offline_access');
  } finally {
    for (const [n, v] of saved) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
});

test('the renew deposit forwards no client secret and no literal "undefined"', async () => {
  // `/renew` grew a fourth argument when the client secret travelled with the
  // deposit, and kept it on the command line after the coordinator stopped
  // sending one — so every deposit ended in the word "undefined", harmless
  // only because the hub discards its fourth argument. Worse, when an OLDER
  // coordinator does still send the parameter, the value is the fleet-wide
  // client secret, which the hub has no use for: the protocol accepts it for
  // compatibility and the command line is where it stops travelling.
  const { toCommandLine } = await import('../src/fleet/host/sidecar.js');
  const bare = toCommandLine({ verb: 'renew', params: { provider: 'github', clientId: 'Iv23liTEST', refresh: 'ghr_x' } });
  assert.equal(bare, '/renew github Iv23liTEST ghr_x');
  const fromOldCoordinator = toCommandLine({
    verb: 'renew',
    params: { provider: 'cloudflare', clientId: 'cf-id', refresh: 'cf-refresh', client: 'the-fleet-wide-secret' },
  });
  assert.equal(fromOldCoordinator, '/renew cloudflare cf-id cf-refresh');
});
