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

// SETTINGS, NOT PROSE. Both config files explain at length what they do NOT
// contain, and a test that greps the raw text finds `durable_objects` in the
// sentence promising there is no durable object. Comments are where the
// reasoning lives; they must not be where an assertion looks.
/** @param {string} toml */
const settings = (toml) => toml.replace(/^\s*#.*$/gm, '');

const WRANGLER = read('worker/wrangler.demo.toml');
const COORDINATOR = read('worker/wrangler.toml');
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

test('the demo host and the fleet host are different domains', () => {
  const demoHost = fromWrangler('AGENT_FLEET_DEMO_HOST');
  const routes = [...WRANGLER.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(routes.includes(demoHost), 'the demo host has no route, so nothing would answer on it');

  const fleetRoutes = [...COORDINATOR.matchAll(/pattern\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(fleetRoutes.includes(demoHost), false, 'the coordinator still answers on the demo domain');
  for (const r of fleetRoutes) assert.equal(routes.includes(r), false, `${r} is served by both Workers`);
});

test('the demo Worker cannot reach a fleet, because nothing that could is in scope', () => {
  // THE WHOLE SECURITY PROPERTY, and it is now a property of the DEPLOYMENT
  // rather than of the order of branches in a file.
  //
  // The demo used to be a hostname check inside the coordinator, answered
  // above the host routes. That was correct, and it was an argument about
  // order — in a bundle that also held the Durable Object binding, the GitHub
  // App client secret and the APNs key. What replaced it is shorter to verify:
  // this script has no binding to a fleet, so a bug in it cannot find one.
  const demo = settings(read('worker/wrangler.demo.toml'));
  assert.equal(/durable_objects/.test(demo), false, 'the demo Worker has a Durable Object binding');
  assert.equal(/send_email|kv_namespaces|\[\[queues/.test(demo), false, 'the demo Worker has a stateful binding');
  assert.match(demo, /main = "src\/demo-worker\.js"/);

  // And the entrypoint imports the invented fleet, never the real one.
  const src = read('worker/src/demo-worker.js');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./demo.js', './pages.js']);
});

test('the coordinator no longer serves the demo at all', () => {
  // Not "checks it first" — gone. A demo token presented to the real fleet is
  // now an ordinary bad credential, which is the answer it should always have
  // had once the demo had a Worker of its own.
  const src = read('worker/src/worker.js');
  assert.equal(/demoReply|isDemoHost|AGENT_FLEET_DEMO_TOKEN/.test(src), false,
    'the coordinator still has a demo path');
  assert.equal(/AGENT_FLEET_DEMO/.test(settings(COORDINATOR)), false,
    'the coordinator config still carries demo settings');
});

test('the product page is a redirect from the coordinator, never bytes', () => {
  // A coordinator holding the fleet should not also be an unauthenticated,
  // cacheable HTML surface. /docs hands out an address; the demo Worker serves
  // the page. Off unless AGENT_FLEET_DOCS_URL is set, so a fork 404s.
  const src = read('worker/src/worker.js');
  assert.match(src, /url\.pathname === '\/docs' && env\.AGENT_FLEET_DOCS_URL/);
  assert.equal(/new Response\(DOCS/.test(src), false, 'the coordinator is serving the page itself');

  const target = /^AGENT_FLEET_DOCS_URL\s*=\s*"([^"]+)"/m.exec(COORDINATOR);
  assert.ok(target, 'our deploy does not point /docs anywhere');
  assert.equal(new URL(target[1]).hostname, fromWrangler('AGENT_FLEET_DEMO_HOST'),
    '/docs redirects somewhere other than the Worker that serves it');
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
