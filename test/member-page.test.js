// The page an invited member uses when they have no phone.
//
// WHAT IS ACTUALLY BEING TESTED, because "does the HTML look right" is not
// something a terminal can answer and this file does not pretend to. Four
// things that are true or false regardless of taste:
//
//   1. BOTH COORDINATORS SERVE IT. A route on one and not the other is the bug
//      this repository has shipped more than once (`/api/devices` 404ing on a
//      box for months), and it is why the routes live in one module that each
//      coordinator calls.
//   2. IT IS REACHABLE WITHOUT A CREDENTIAL, which is the entire point: a
//      person who has just been invited holds nothing yet.
//   3. IT HANDS OUT NOTHING. It is served before the token gate, so a page
//      that leaked a fleet credential, a host name or an address would be
//      leaking it to anybody who asked.
//   4. THE INSTALLABLE PARTS ARE ACTUALLY INSTALLABLE. A manifest that does not
//      parse and a service worker the browser refuses to register both fail
//      silently, in a console nobody has open.
//
// The behaviour of the page in a browser — sign-in, the connect flows, the
// keyboard, contrast, the phone width — was verified by driving a real
// Chromium against a real coordinator, which is what R-35 asks for and what no
// assertion in this file can replace.

import test from 'node:test';
import assert from 'node:assert/strict';

import { memberRoutes, isMemberPath, signInClients, MEMBER_PATH } from '../src/fleet/coordinator/member-page.js';

const SIGN_IN = { google: '1234-abc.apps.googleusercontent.com', apple: 'network.thetech.fleetwright.signin' };
const DEPS = { fleet: 'the test fleet', signIn: SIGN_IN };

const get = (/** @type {string} */ path, deps = DEPS) => memberRoutes({ method: 'GET', path }, deps);

test('the four routes are ours and everything else is not', () => {
  for (const p of [MEMBER_PATH, `${MEMBER_PATH}/`, `${MEMBER_PATH}/manifest.webmanifest`, `${MEMBER_PATH}/icon.svg`, `${MEMBER_PATH}/sw.js`]) {
    assert.equal(isMemberPath(p), true, p);
  }
  // NOT A PREFIX MATCH. `/mercury` starts with `/me` and belongs to whoever
  // adds it later; a router that claimed it would take a route away from a
  // file that never mentions this one.
  for (const p of ['/', '/api/intent', '/mercury', '/me/other', `${MEMBER_PATH}/sw.js/x`]) {
    assert.equal(isMemberPath(p), false, p);
  }
  assert.equal(memberRoutes({ method: 'GET', path: '/api/intent' }, DEPS), null, 'a foreign path must fall through');
});

test('the page is served to somebody holding nothing at all', () => {
  // The whole reason this exists: an invited person has no credential yet, and
  // on a fleet whose only other surface is an app they cannot install, a page
  // that required one would be the same dead end wearing a browser.
  const page = get(MEMBER_PATH);
  assert.equal(page?.status, 200);
  assert.match(page.contentType, /^text\/html/);
  assert.match(page.body, /<title>Your credentials: the test fleet<\/title>/);
  // It says what it is for before it asks anybody to sign in to it.
  assert.match(page.body, /runs on <strong>your<\/strong> Claude account/);
  assert.match(page.body, /Nothing here starts, stops or reads a session/);
});

test('a page served before the token gate gives away nothing', () => {
  // It is reachable by anybody, so what it contains is public. The client ids
  // are meant to be (they are in every phone's binary); a credential, a host
  // name or an internal address would not be.
  const body = get(MEMBER_PATH).body;
  assert.equal(/fwk_/.test(body), false, 'a fleet credential is on the page');
  assert.equal(/AGENT_FLEET_API_TOKEN|AGENT_FLEET_HOST_TOKEN/.test(body), false, 'a break-glass token is named');
  // The two routes it posts to, and no third — both relative, so the page
  // cannot be made to send a credential anywhere but the coordinator that
  // served it.
  const posts = [...body.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(posts)].sort(), ['/api/intent', '/api/session']);
  // No absolute address of ours anywhere: an internal hostname baked into a
  // public page is a map of the fleet handed to whoever asks for the page.
  const absolute = [...body.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[1] ?? m[0]);
  for (const url of absolute) {
    assert.match(
      url,
      /^https:\/\/(accounts\.google\.com|appleid\.cdn-apple\.com|www\.w3\.org)\//,
      `${url} is an address this page should not be publishing`,
    );
  }
});

test('the only scripts on it belong to the sign-in it runs', () => {
  // A page of ours collecting credentials for somebody else is the shape of
  // every phishing screen ever built, and a third-party script in the middle
  // of an authentication is the same objection one step removed.
  const body = get(MEMBER_PATH).body;
  const external = [...body.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  for (const src of external) {
    assert.match(src, /^https:\/\/(accounts\.google\.com|appleid\.cdn-apple\.com)\//, src);
  }
  // And a deployment with no sign-in configured says so rather than rendering
  // an empty box where two buttons should be.
  const bare = get(MEMBER_PATH, { fleet: 'x', signIn: { google: null, apple: null } }).body;
  assert.equal(/<script src=/.test(bare), false, 'a provider script loaded with no provider configured');
  assert.match(bare, /no sign-in configured/);
});

test('the manifest parses, and points at an icon that exists', () => {
  const m = get(`${MEMBER_PATH}/manifest.webmanifest`);
  assert.equal(m?.status, 200);
  assert.match(m.contentType, /application\/manifest\+json/);
  const parsed = JSON.parse(m.body);
  assert.equal(parsed.display, 'standalone');
  assert.equal(parsed.start_url, MEMBER_PATH);
  assert.ok(parsed.icons.length, 'no icons, so nothing will install it');
  for (const icon of parsed.icons) {
    assert.equal(isMemberPath(icon.src), true, `${icon.src} is not a route this serves`);
    assert.equal(get(icon.src)?.status, 200, icon.src);
  }
});

test('the service worker is allowed the scope the page actually sits at', () => {
  // WITHOUT THIS HEADER THE REGISTRATION IS REFUSED and the page is simply not
  // installable, with one line in a console nobody has open to say so. A
  // worker served from `/me/sw.js` may by default control `/me/` only, and the
  // page is at `/me` — one character outside it.
  //
  // Found by opening the page in a real browser. Every test that only fetched
  // these routes passed, which is why this assertion is here rather than a
  // note in a comment.
  const sw = get(`${MEMBER_PATH}/sw.js`);
  assert.equal(sw?.status, 200);
  assert.match(sw.contentType, /text\/javascript/);
  assert.equal(sw.headers?.['service-worker-allowed'], MEMBER_PATH);
  // And it caches nothing: this page holds a live credential, and a worker
  // keeping copies of its responses would outlive the sign-out that cleared it.
  assert.equal(/caches\.|cache\.put|cache\.add/.test(sw.body), false, 'the service worker grew a cache');
  assert.match(sw.body, /respondWith\(fetch\(e\.request\)\)/);
});

test('anything but a GET is refused, and says so as data', () => {
  const r = memberRoutes({ method: 'POST', path: MEMBER_PATH }, DEPS);
  assert.equal(r?.status, 405);
  assert.equal(JSON.parse(r.body).error.code, 'method_not_allowed');
});

test('the Google client is found in the audience list, not written twice', () => {
  // The list an ID token is verified against already contains the id, so a
  // deployment that had to repeat it in a second variable would eventually
  // have two that disagree.
  assert.deepEqual(
    signInClients({ audiences: ['network.thetech.fleetwright', '1234-abc.apps.googleusercontent.com'], appleService: 'svc' }),
    { google: '1234-abc.apps.googleusercontent.com', apple: 'svc' },
  );
  // Nothing configured is null, twice over, and never a guess at one of them.
  assert.deepEqual(signInClients({ audiences: [] }), { google: null, apple: null });
  assert.deepEqual(signInClients({ audiences: ['network.thetech.fleetwright'] }), { google: null, apple: null });
});

test('both coordinators serve it, and serve the same bytes', async () => {
  // The parity check this whole module exists for. Driven through each
  // coordinator's real front door rather than by calling memberRoutes twice,
  // because what drifts is the WIRING: one of them forgetting the route, or
  // putting it below the credential gate where an invited person cannot reach
  // it.
  const { Coordinator } = await import('../src/fleet/coordinator/server.js');
  const worker = (await import('../worker/src/worker.js')).default;

  const env = {
    AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch',
    AGENT_FLEET_NAME: 'the test fleet',
    AGENT_FLEET_AUTH_AUDIENCES: '1234-abc.apps.googleusercontent.com',
    AGENT_FLEET_AUTH_APPLE_SERVICE: 'network.thetech.fleetwright.signin',
    // No FLEET binding: a request that reached the Durable Object would throw,
    // which is the assertion — this page must never need it.
  };
  const before = {
    name: process.env.AGENT_FLEET_NAME,
    aud: process.env.AGENT_FLEET_AUTH_AUDIENCES,
    apple: process.env.AGENT_FLEET_AUTH_APPLE_SERVICE,
  };
  process.env.AGENT_FLEET_NAME = env.AGENT_FLEET_NAME;
  process.env.AGENT_FLEET_AUTH_AUDIENCES = env.AGENT_FLEET_AUTH_AUDIENCES;
  process.env.AGENT_FLEET_AUTH_APPLE_SERVICE = env.AGENT_FLEET_AUTH_APPLE_SERVICE;

  const node = new Coordinator({ apiToken: env.AGENT_FLEET_API_TOKEN, logger: { info() {}, warn() {}, error() {}, debug() {} } });
  const port = await node.listen(0, '127.0.0.1');
  try {
    for (const path of [MEMBER_PATH, `${MEMBER_PATH}/manifest.webmanifest`, `${MEMBER_PATH}/icon.svg`, `${MEMBER_PATH}/sw.js`]) {
      // NO Authorization HEADER ANYWHERE IN HERE. That is the test.
      const fromNode = await fetch(`http://127.0.0.1:${port}${path}`);
      const fromWorker = await worker.fetch(new Request(`https://fleet.example${path}`), env, { waitUntil() {} });
      assert.equal(fromNode.status, 200, `node refused ${path}`);
      assert.equal(fromWorker.status, 200, `worker refused ${path}`);
      assert.equal(
        fromNode.headers.get('content-type'),
        fromWorker.headers.get('content-type'),
        `${path} is served as a different type by each coordinator`,
      );
      assert.equal(await fromNode.text(), await fromWorker.text(), `${path} differs between coordinators`);
    }
    // The header the browser needs, on both.
    const swNode = await fetch(`http://127.0.0.1:${port}${MEMBER_PATH}/sw.js`);
    const swWorker = await worker.fetch(new Request(`https://fleet.example${MEMBER_PATH}/sw.js`), env, { waitUntil() {} });
    assert.equal(swNode.headers.get('service-worker-allowed'), MEMBER_PATH);
    assert.equal(swWorker.headers.get('service-worker-allowed'), MEMBER_PATH);
  } finally {
    await node.close();
    for (const [k, v] of Object.entries({ AGENT_FLEET_NAME: before.name, AGENT_FLEET_AUTH_AUDIENCES: before.aud, AGENT_FLEET_AUTH_APPLE_SERVICE: before.apple })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
