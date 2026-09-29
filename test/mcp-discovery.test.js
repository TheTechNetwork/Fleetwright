// The two discovery paths serve one document, and it promises nothing OIDC.
//
// RFC 8414 puts the authorization-server metadata at
// /.well-known/oauth-authorization-server; OpenID Connect puts a superset at
// /.well-known/openid-configuration. Clients disagree on which to read: the MCP
// SDK tries the RFC 8414 path first and falls back to the OIDC one, and some
// clients read only the OIDC one. routes.js answers both with the same
// document — a decision recorded on authorizationServerMetadata — and this
// holds the two properties that decision rests on:
//
//   1. the bodies are identical, so which path a client picks cannot change
//      what it learns;
//   2. the document carries no claim that only an OpenID provider could keep.
//      This server mints no id_token, so a `jwks_uri` or a `userinfo_endpoint`
//      at the OIDC path would be an advertisement for an endpoint that does
//      not exist, and `openid` in scopes_supported an invitation to ask for a
//      token the token endpoint never issues.
//
// Driven through mcpRoutes, the function both coordinators dispatch to, rather
// than through a copy of the paths: if the aliasing moves, this moves with it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mcpRoutes } from '../src/mcp/routes.js';
import { authorizationServerMetadata } from '../src/mcp/oauth.js';

const ORIGIN = 'https://fleet.example';

/** @param {string} path */
async function discover(path) {
  // Discovery is answered before any dependency is touched — it is public, and
  // a client cannot authenticate before it knows how — so the deps can be
  // nothing. If that ever stops being true this throws, which is also a finding.
  return mcpRoutes(/** @type {any} */ ({ method: 'GET', path, origin: ORIGIN, headers: {} }), /** @type {any} */ ({}));
}

test('oauth-authorization-server and openid-configuration are one document', async () => {
  const rfc8414 = await discover('/.well-known/oauth-authorization-server');
  const oidc = await discover('/.well-known/openid-configuration');
  assert.equal(rfc8414.status, 200);
  assert.equal(oidc.status, 200);
  assert.deepEqual(oidc.json, rfc8414.json, 'a client reading the OIDC path must learn exactly what one reading the RFC 8414 path learns');
  assert.deepEqual(rfc8414.json, authorizationServerMetadata(ORIGIN), 'and it is the metadata builder, not a copy of it');
});

test('the document at the OIDC path promises nothing only an OpenID provider could keep', async () => {
  const { json: doc } = await discover('/.well-known/openid-configuration');
  // Every claim OpenID Connect Discovery adds over RFC 8414 that would describe
  // an id_token or the endpoints that go with one. None is true of this server.
  for (const claim of [
    'jwks_uri',
    'userinfo_endpoint',
    'subject_types_supported',
    'id_token_signing_alg_values_supported',
    'claims_supported',
    'end_session_endpoint',
    'check_session_iframe',
  ]) {
    assert.equal(claim in doc, false, `${claim} advertises an id_token this server does not mint`);
  }
  assert.ok(!doc.scopes_supported.includes('openid'), 'openid in scopes_supported asks the token endpoint for an id_token');
  assert.ok(!doc.response_types_supported.some((/** @type {string} */ t) => /id_token/.test(t)), 'no response type yields an id_token');
  // And what IS there is what a client needs to reach /mcp: the three
  // endpoints, code + PKCE S256, a public client.
  assert.equal(doc.issuer, ORIGIN);
  assert.equal(doc.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(doc.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(doc.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(doc.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(doc.token_endpoint_auth_methods_supported, ['none']);
});
