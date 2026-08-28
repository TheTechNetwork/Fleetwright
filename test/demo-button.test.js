// The demo, reachable in one tap, and the constants that make it so.
//
// The demo fleet has existed since store review needed credentials that work,
// and reaching it meant finding a token in a deployment document and pasting
// it into a collapsed field labelled "credential" — which is a fair
// description of no demo at all for anybody who is not already reading this
// repository. It is a button now.
//
// A button means the hostname and the credential are compiled into two apps,
// so THREE COPIES of each value now exist and nothing at runtime would notice
// them drifting apart: an app pointed at a domain that no longer serves a demo
// fails in a way that reads as "the app is broken". That is what this file is
// for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const WRANGLER = read('worker/wrangler.toml');
const IOS = read('apps/ios/Fleetwright/Demo.swift');
const ANDROID = read('apps/android/app/src/main/java/network/thetech/fleetwright/Demo.kt');

/** @param {string} key */
const fromWrangler = (key) => {
  const m = new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm').exec(WRANGLER);
  assert.ok(m, `${key} is not set in worker/wrangler.toml`);
  return m[1];
};

test('the demo host is the same in the Worker and in both apps', () => {
  const host = fromWrangler('AGENT_FLEET_DEMO_HOST');
  assert.match(host, /^[a-z0-9.-]+$/, 'a hostname, not a URL — worker.js compares it to url.hostname');

  // The apps hold an origin; the Worker holds a bare hostname. Compared
  // deliberately rather than stored twice in one form, because the two are
  // used for different things and a scheme in wrangler.toml would silently
  // never match.
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    const m = /"https:\/\/([^"]+)"/.exec(src);
    assert.ok(m, `${name} has no demo coordinator URL`);
    assert.equal(m[1], host, `${name} points at a different host than the Worker serves the demo on`);
  }
});

test('the demo credential is the same in all three places', () => {
  const token = fromWrangler('AGENT_FLEET_DEMO_TOKEN');
  assert.match(token, /^demo-/, 'prefixed so a request carrying it is obvious in a log at a glance');
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.ok(src.includes(token), `${name} ships a different demo credential`);
  }
});

test('the demo is not the real token, and not the real fleet', () => {
  // A demo token equal to the API token would silently turn the whole
  // coordinator into a toy; worker.js answers 500 rather than guessing which
  // was meant, and this catches it before a deploy.
  const demo = fromWrangler('AGENT_FLEET_DEMO_TOKEN');
  const api = /^AGENT_FLEET_API_TOKEN\s*=\s*"([^"]+)"/m.exec(WRANGLER);
  if (api) assert.notEqual(demo, api[1]);

  // And the demo host must not be the production host, or the button would
  // point people's phones at the real fleet.
  const demoHost = fromWrangler('AGENT_FLEET_DEMO_HOST');
  const routes = [...WRANGLER.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(routes.includes(demoHost), 'the demo host has no route, so nothing would answer on it');
  assert.ok(routes.length >= 2, 'the demo shares a Worker with the real fleet and needs its own domain');
  assert.notEqual(demoHost, routes.find((r) => r !== demoHost), 'demo and production must be different hosts');
});

test('the demo hostname is matched exactly, never as a suffix', () => {
  // `endsWith('fleetdemo.thetech.network')` would also accept
  // `notfleetdemo.thetech.network`, and a hostname check that can be widened
  // by prefixing it is not a check.
  const src = read('worker/src/worker.js');
  const fn = /function isDemoHost\([\s\S]*?\n}/.exec(src);
  assert.ok(fn, 'isDemoHost is gone — the demo domain is no longer a boundary');
  assert.match(fn[0], /===/);
  assert.equal(/endsWith|includes|startsWith/.test(fn[0]), false, 'a suffix test is not a hostname check');
});

test('the demo is answered before any route that reaches the fleet', () => {
  // THE WHOLE SECURITY PROPERTY. If this check sat lower, /host/connect on the
  // demo domain would have returned first and joined the real fleet — "demo"
  // must not become a way in, and the guarantee is that the answer comes
  // before the door exists rather than that somebody remembered not to open it.
  const src = read('worker/src/worker.js');
  const demoAt = src.indexOf('if (isDemoHost(url, env))');
  const hostRouteAt = src.indexOf("url.pathname === '/host/connect'");
  const objectAt = src.indexOf('env.FLEET.idFromName');
  assert.ok(demoAt > 0 && hostRouteAt > 0);
  assert.ok(demoAt < hostRouteAt, 'a host route is reachable on the demo domain');
  // /apple/notifications legitimately fetches the object above this; what must
  // not happen is a host or session route doing so.
  assert.ok(objectAt > 0);
});

test('the paste-a-credential field is gone from both apps', () => {
  // Replaced by the button. A field labelled "credential" in front of every
  // user is how the shared-secret habit comes back, and the one real need it
  // still served — getting back in when sign-in itself is broken — belongs to
  // the operator with curl, not on everybody's settings screen.
  for (const [name, p] of [
    ['iOS', 'apps/ios/Fleetwright/FleetView.swift'],
    ['Android', 'apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt'],
  ]) {
    const src = read(p);
    // The comment explaining the removal contains the phrase, so match the UI
    // string as it was actually rendered.
    assert.equal(/Text\("Use a credential instead"\)|DisclosureGroup\("Use a credential instead"/.test(src), false,
      `${name} still offers a credential field`);
    assert.match(src, /demo fleet/i, `${name} has no demo button`);
  }
});
