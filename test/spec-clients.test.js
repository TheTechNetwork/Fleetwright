// THE SPEC IS THE CONTRACT, AND THE APP AND THE MCP SERVER ARE ITS CLIENTS.
//
// openapi.json already had a test — openapi.test.js walks it and asserts that
// both coordinators serve the same routes. That catches a route implemented on
// one side and not the other, which is the bug it was written for.
//
// It does not catch a route implemented on BOTH sides and reachable by NOBODY,
// and two of those had been sitting there:
//
//   GET    /api/clients        which devices can reach this fleet
//   DELETE /api/clients/{id}   revoke one, leaving every other alone
//   GET    /api/events         what happened while you were asleep
//
// Sign-in mints one credential per device precisely so that revoking one leaves
// the others working — a property worth nothing while no app could see the
// list, so a lost phone could be revoked only by somebody with a terminal.
// And push shipped in halves: the notification wakes a phone, and nothing could
// tell it what the notification was about.
//
// Both were found by listing the routes against the two apps, in about a
// minute. This is that listing, as a test, so the next one is found the same
// way — by CI rather than by a person noticing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const spec = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));

const readAll = (/** @type {string} */ dir, /** @type {string} */ ext) => {
  const d = new URL(dir, import.meta.url);
  return readdirSync(d)
    .filter((f) => f.endsWith(ext))
    .map((f) => readFileSync(new URL(`${dir}/${f}`, import.meta.url), 'utf8'))
    .join('\n');
};

const IOS = readAll('../apps/ios/Fleetwright', '.swift');
const ANDROID = readAll('../apps/android/app/src/main/java/network/thetech/fleetwright', '.kt');
const MCP = readAll('../src/mcp', '.js');

/**
 * Does this source actually call that route?
 *
 * NOT `includes`, WHICH IS WHAT THIS STARTED AS AND IS NOT GOOD ENOUGH: the
 * stem `/api/events` is a substring of `/api/eventsXX`, so a typo'd route
 * satisfied the test that exists to catch a route nobody calls. Checked by
 * mutation — changing the Android call to a nonsense path and watching this
 * still pass.
 *
 * A route ends where the string does, or continues into a path segment the
 * client appends. Anything else is a different route that happens to start the
 * same way.
 *
 * @param {string} src @param {string} stem
 */
const calls = (src, stem) =>
  // EVERY METACHARACTER, NOT THE TWO I HAPPENED TO THINK OF. This escaped `/`
  // and `.` — and `/` needs no escaping in a RegExp CONSTRUCTOR at all (only in
  // a literal, where it would end the pattern), so the one character it went
  // out of its way to handle was the one that did not need it, while `\` and
  // every other metacharacter went through untouched.
  //
  // CodeQL caught it. Nothing here is attacker-controlled — the stems come from
  // openapi.json, which is ours — but "the input happens to be safe today" is a
  // property of the CALLER, not of this function, and the caller is one
  // `route.split('{')[0]` away from handing it a brace. A sanitiser with an
  // arbitrary subset is the shape this repository keeps getting caught by:
  // true where it was written, quietly false one layer up.
  new RegExp(`${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["'\`)/?]|\\s|$)`).test(src);

/**
 * Routes no client is expected to call, each with the reason.
 *
 * A LIST WITH REASONS, NOT A LIST. The value of this test is entirely in what
 * it refuses to let somebody add silently, so an entry here has to say why —
 * "not a client route" is the sentence that would have hidden /api/events.
 */
const NOT_A_CLIENT_ROUTE = {
  '/api/enroll/host': 'a HOST spends a pin here. The app mints them; it never redeems one.',
  '/api/host/challenge': 'host enrolment, key exchange. Between a box and the coordinator.',
  '/api/host/verify': 'the other half of that exchange.',
  '/apple/notifications': 'APNs calls this. Apple is the client.',
  '/healthz': 'infrastructure liveness. Read by a load balancer, not by a person.',
  '/oauth/github/callback': "a browser redirect target — GitHub sends somebody's browser here.",
  '/oauth/cloudflare/callback': "the same redirect target for the second provider — Cloudflare sends somebody's browser here.",
};

test('every route in the spec is reachable by a primary client, or says why not', () => {
  const unreachable = [];
  for (const route of Object.keys(spec.paths)) {
    if (route in NOT_A_CLIENT_ROUTE) {
      assert.ok(NOT_A_CLIENT_ROUTE[route].length > 20, `${route}: the exemption needs a reason, not a label`);
      continue;
    }
    // The literal prefix, because a client builds `/api/clients/` + an id and
    // never contains the `{id}` the spec writes.
    const stem = route.split('{')[0].replace(/\/$/, '');
    const reached = calls(IOS, stem) || calls(ANDROID, stem) || calls(MCP, stem);
    if (!reached) unreachable.push(route);
  }
  assert.deepEqual(
    unreachable,
    [],
    'these routes are documented, served by both coordinators, and callable by no app and no MCP server. ' +
      'Either give a client a reason to call them, or add them to NOT_A_CLIENT_ROUTE with one.',
  );
});

test('the two apps reach the same routes, or the gap is deliberate', () => {
  // docs/app-parity.md exists because a feature shipped to iOS and not to
  // Android while being reported as done on both — a gap one commit wide is
  // invisible in a summary. This is that document as an assertion.
  const gaps = [];
  for (const route of Object.keys(spec.paths)) {
    if (route in NOT_A_CLIENT_ROUTE) continue;
    const stem = route.split('{')[0].replace(/\/$/, '');
    const i = calls(IOS, stem);
    const a = calls(ANDROID, stem);
    // Only where at least one app has it. A route only the MCP server calls is
    // not an app gap.
    if (i !== a) gaps.push(`${route}: ${i ? 'iOS only' : 'Android only'}`);
  }
  assert.deepEqual(gaps, [], 'one app can reach these and the other cannot');
});

test('the devices a person can revoke are listed by both apps', () => {
  // The specific pair this test was written for. Revoking without listing is
  // not a feature: nobody can name a credential they cannot see.
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.ok(calls(src, '/api/clients'), `${name} cannot list the devices holding a credential`);
    assert.match(src, /revokeClient/, `${name} cannot revoke one`);
  }
});

test('what a notification was about can be read after the fact, everywhere', () => {
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID], ['MCP', MCP]]) {
    assert.ok(calls(src, '/api/events'), `${name} cannot say what happened while it was away`);
  }
});


test('the route matcher treats its argument as a literal, not as a pattern', () => {
  // CodeQL flagged the escape as incomplete and it was: `/` and `.` were
  // handled, `\` and every other metacharacter were not.
  //
  // THE `.` CASE DOES NOT PROVE THE FIX — the old version escaped that one, so
  // a test using it would have passed against the bug. Backslash is the
  // discriminator, and it is here for that reason rather than for coverage.
  assert.equal(calls('/api/1"', '\\d'), false, 'a backslash escape is being interpreted as a pattern');
  // The rest of the class, so the next one added is not a subset again.
  assert.equal(calls('/apiZx"', '/api.x'), false, 'a dot is matching any character');
  assert.equal(calls('/api/xxx"', '/api/x+'), false, 'a quantifier is being applied');
  assert.equal(calls('/api/a"', '/api/(a|b)'), false, 'a group is being applied');

  // And it still matches what it is for: the literal route, ending at a quote,
  // a paren, or a path segment the client appends.
  assert.equal(calls('get("/api/events")', '/api/events'), true);
  assert.equal(calls('send("DELETE", "/api/clients/" + id)', '/api/clients'), true);
  // A LONGER ROUTE IS A DIFFERENT ROUTE. This is the whole reason it is not
  // `includes`: that version was satisfied by /api/eventsXX, so a typo'd route
  // passed the test whose entire job is finding routes nobody calls. Found by
  // mutation, not by reading.
  assert.equal(calls('get("/api/eventsXX")', '/api/events'), false);
});
