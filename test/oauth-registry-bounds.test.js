// `/oauth/register` takes no credential, and everything it stores goes into one
// Durable Object value.
//
// DO storage refuses a value over 128KiB. Nothing capped the number of
// registrations, the number of redirect URIs in one, or their length — so an
// anonymous caller could grow `mcpClients` past the limit, at which point
// `storage.put('mcpClients', …)` throws and keeps throwing.
//
// THIS EXACT FAILURE HAS HAPPENED HERE BEFORE. `#saveEvents` in fleet-do.js
// carries the post-mortem: the event ring "fills slowly and crosses the limit
// weeks after the code shipped, on a box where nothing changed — which is
// exactly how it presented". It was bounded for that key and no other.
//
// Workerd does not enforce the limit, which is why a local reproduction of a
// production-only exception (#313) is hard, and why this is reasoned to rather
// than reproduced.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Authorizations } from '../src/mcp/oauth.js';

const ok = (r, why) => { assert.equal(r.ok, true, `${why}: ${r.error}`); return r; };

test('a registration may not carry an unbounded number of redirect URIs', () => {
  const a = new Authorizations();
  const many = Array.from({ length: 500 }, (_, i) => `https://example.org/cb/${i}`);
  assert.equal(a.register({ redirect_uris: many }).ok, false);
  // And the ordinary case is untouched: a real client registers one or two.
  ok(a.register({ redirect_uris: ['https://example.org/cb'] }), 'a normal client was refused');
});

test('a single redirect URI may not be arbitrarily long', () => {
  const a = new Authorizations();
  assert.equal(a.register({ redirect_uris: [`https://example.org/${'a'.repeat(100000)}`] }).ok, false);
});

test('the registry stays under the storage limit however often it is called', () => {
  // THE PROPERTY, not the constant. Ten thousand registrations from an
  // anonymous caller, each individually legitimate.
  const a = new Authorizations();
  for (let i = 0; i < 10_000; i++) {
    ok(a.register({ redirect_uris: [`https://example.org/cb/${i}`], client_name: `client ${i}` }), `registration ${i}`);
  }
  const bytes = JSON.stringify(a.serialise()).length;
  assert.ok(bytes < 128 * 1024, `serialised registry is ${bytes} bytes, past what DO storage accepts`);
});

test('the newest registration survives, and an evicted one can simply register again', () => {
  // EVICTION IS SAFE HERE AND WOULD NOT BE ELSEWHERE. A client_id grants
  // nothing on its own — it is useless until a person completes a sign-in
  // against the allowlist — so a client whose row was dropped gets
  // `invalid_client` and registers again, the same round trip it made first
  // time. `hostIds` could not be bounded this way.
  const a = new Authorizations();
  const first = ok(a.register({ redirect_uris: ['https://example.org/first'] }), 'first');
  for (let i = 0; i < 500; i++) a.register({ redirect_uris: [`https://example.org/cb/${i}`] });
  const last = ok(a.register({ redirect_uris: ['https://example.org/last'] }), 'last');

  assert.equal(a.knows(last.clientId), true, 'the newest registration was evicted');
  assert.equal(a.knows(first.clientId), false, 'nothing was evicted, so the map is still unbounded');
});

test('a value restored from before the caps is trimmed rather than rewritten out', () => {
  // A box that has been running since before this fix has an oversized value
  // ALREADY on disk. restore() would load it and the next save would throw —
  // the fix has to survive its own upgrade path, which is the half that is
  // easy to leave out.
  const a = new Authorizations();
  a.restore(Array.from({ length: 5000 }, (_, i) => ({
    clientId: `mcp_${i}`,
    redirectUris: [`https://example.org/cb/${i}`],
    name: `client ${i}`,
  })));
  const bytes = JSON.stringify(a.serialise()).length;
  assert.ok(bytes < 128 * 1024, `restored registry serialises to ${bytes} bytes`);
});

test('registration still works, because refusing to register is the one thing it must not do', () => {
  // The endpoint is open BY DESIGN — RFC 7591 discovery — and bounding it must
  // not turn into closing it. An MCP client that has never been seen has to be
  // able to become known.
  const a = new Authorizations();
  const r = ok(a.register({ redirect_uris: ['http://127.0.0.1:8976/callback'], client_name: 'Claude' }), 'loopback');
  assert.match(r.clientId, /^mcp_/);
  assert.equal(a.knows(r.clientId), true);
});
