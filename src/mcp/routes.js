// The remote MCP endpoint's routes, written once for both coordinators.
//
// The Node server and the Worker have drifted before — a route added to one and
// not the other is how `/api/devices` came to 404 on a box for months while the
// phone waited for notifications that had nowhere to come from. So this is the
// whole surface, and each coordinator only has to hand it a request.
//
//   GET  /.well-known/oauth-protected-resource   where the auth server is
//   GET  /.well-known/oauth-authorization-server what it supports
//   POST /oauth/register                          a client that has never been seen
//   GET  /oauth/authorize                         the sign-in page
//   POST /oauth/authorize                         the ID token comes back here
//   POST /oauth/token                             code + verifier -> credential
//   POST /mcp                                     the conversation
//
// WHAT IS DELIBERATELY NOT HERE: refresh tokens. An access token is a device
// credential and does not expire — it is revoked, from the same list as every
// phone. Adding a refresh flow would mean a second kind of credential with a
// second lifetime to reason about, to solve a problem this fleet does not have.

import { handleMcpRequest } from './http.js';
import { authorizationServerMetadata, protectedResourceMetadata, isSafeRedirect } from './oauth.js';
import { authorizePage } from './authorize-page.js';

/**
 * Is this path ours at all?
 *
 * Asked BEFORE the body is read, and that is the whole reason it is separate
 * from mcpRoutes(). A dispatcher that reads the body in order to decide has
 * already consumed the stream, and every handler below it then reads an empty
 * request — which is not a 404 but a route that silently receives nothing.
 *
 * @param {string} path
 */
export function isMcpPath(path) {
  return (
    path === '/mcp' ||
    path === '/oauth/register' ||
    path === '/oauth/authorize' ||
    path === '/oauth/token' ||
    path === '/.well-known/oauth-protected-resource' ||
    path === '/.well-known/oauth-authorization-server' ||
    path === '/.well-known/openid-configuration'
  );
}

/**
 * The token out of an `Authorization: Bearer …` header.
 *
 * NOT a regular expression, and that is the whole point. This was
 * `/^Bearer\s+(.+)$/i`, in which `\s+` and `(.+)` can each claim the same run
 * of spaces — so a header of "bearer" followed by several thousand spaces makes
 * the engine try every split between them. Quadratic, on a header an anonymous
 * caller chooses, on the ONE route that must answer before anybody is
 * authenticated. Header size limits cap it rather than prevent it.
 *
 * Splitting at the first space is linear and says the same thing.
 *
 * @param {string|null} header
 * @returns {string|null}
 */
function bearer(header) {
  const raw = String(header || '');
  const space = raw.indexOf(' ');
  if (space < 0) return null;
  if (raw.slice(0, space).toLowerCase() !== 'bearer') return null;
  return raw.slice(space + 1).trim() || null;
}

/**
 * @typedef {object} Deps
 * @property {import('./oauth.js').Authorizations} authorizations
 * @property {(token: string) => Promise<{ email?: string, admin?: boolean }|null>} verifyCredential
 * @property {(idToken: string) => Promise<{ ok: true, email: string, name: string|null } | { ok: false, status: number, text: string }>} verifyIdentity
 * @property {(who: { email: string, name?: string|null }, deviceName: string) => Promise<{ token: string }>} issueCredential
 * @property {() => void} save
 * @property {{ google?: string|null, apple?: string|null }} signIn  client ids for the page
 * @property {string} selfOrigin  where to send intents — see below
 */

/**
 * TWO ORIGINS, AND THEY ARE NOT THE SAME QUESTION.
 *
 * `req.origin` is where the CLIENT reached us, and on the Node coordinator it
 * is built from the Host header. That is correct for the discovery documents
 * and the WWW-Authenticate header: a client has to be pointed back at the
 * address it actually used, and a spoofed Host only ever poisons the spoofer's
 * own response.
 *
 * `deps.selfOrigin` is where THIS SERVER sends intents, and it must never come
 * from a header. Conflating them made the coordinator issue an outbound request
 * to any host an authenticated caller named — SSRF, with the coordinator's
 * network position, reachable by any fleet member including a guest. Guests are
 * semi-trusted here by design (docs/accounts.md), which is exactly the
 * population this must hold against.
 *
 * @param {{ method: string, path: string, origin: string, query: URLSearchParams, body: any, authorization: string|null }} req
 * @param {Deps} deps
 * @returns {Promise<{ status: number, json?: any, html?: string, headers?: Record<string,string> } | null>}
 *   null when this is not an MCP route, so the caller falls through.
 */
export async function mcpRoutes(req, deps) {
  const { method, path, origin } = req;

  // DISCOVERY IS PUBLIC. A client cannot authenticate before it knows how, and
  // these documents say only what is already true of a public endpoint.
  if (method === 'GET' && path === '/.well-known/oauth-protected-resource') {
    return { status: 200, json: protectedResourceMetadata(origin) };
  }
  if (method === 'GET' && (path === '/.well-known/oauth-authorization-server' || path === '/.well-known/openid-configuration')) {
    return { status: 200, json: authorizationServerMetadata(origin) };
  }

  if (method === 'POST' && path === '/oauth/register') {
    const r = deps.authorizations.register(req.body || {});
    if (!r.ok) return { status: 400, json: { error: r.error } };
    deps.authorizations.sweep();
    return {
      status: 201,
      json: {
        client_id: r.clientId,
        redirect_uris: r.redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      },
    };
  }

  // The page a person lands on. It runs Apple's or Google's sign-in in their
  // browser; nothing here decides who they are.
  if (method === 'GET' && path === '/oauth/authorize') {
    const clientId = req.query.get('client_id') || '';
    const redirectUri = req.query.get('redirect_uri') || '';
    const challenge = req.query.get('code_challenge') || '';
    const state = req.query.get('state') || '';
    // CHECKED BEFORE ANYTHING IS RENDERED. A page that collects a sign-in and
    // then discovers it cannot send the result anywhere has wasted somebody's
    // credentials on a screen that was never going to work.
    if (req.query.get('code_challenge_method') !== 'S256') {
      return { status: 400, html: authorizePage.error('This client asked for a sign-in without PKCE, which this fleet does not allow.') };
    }
    if (!isSafeRedirect(redirectUri)) {
      return { status: 400, html: authorizePage.error('That client asked to be sent back to an address this fleet will not use.') };
    }
    // THE SAME ARGUMENT, ONE STEP EARLIER. issueCode already refuses an
    // unregistered client — but by then somebody has signed in, and being told
    // afterwards that the client was never known is the wasted sign-in this page
    // exists to avoid. A client whose registration this coordinator has
    // forgotten re-registers on a 400 and tries again.
    if (!deps.authorizations.knows(clientId)) {
      return {
        status: 400,
        html: authorizePage.error('This fleet does not know that client. Remove it and add it again — it will register itself.'),
      };
    }
    return {
      status: 200,
      html: authorizePage.render({ clientId, redirectUri, challenge, state, origin, signIn: deps.signIn }),
    };
  }

  // The page posts the ID token here. This is where Apple and Google stop and
  // the fleet's own rules begin.
  if (method === 'POST' && path === '/oauth/authorize') {
    const who = await deps.verifyIdentity(String(req.body?.idToken || ''));
    if (!who.ok) return { status: who.status, json: { error: 'access_denied', error_description: who.text } };

    const issued = deps.authorizations.issueCode({
      email: who.email,
      name: who.name,
      clientId: String(req.body?.clientId || ''),
      redirectUri: String(req.body?.redirectUri || ''),
      challenge: String(req.body?.challenge || ''),
    });
    if (!issued.ok) return { status: 400, json: { error: issued.error } };
    deps.save();
    return { status: 200, json: { code: issued.code } };
  }

  if (method === 'POST' && path === '/oauth/token') {
    const form = req.body || {};
    if (String(form.grant_type) !== 'authorization_code') {
      return { status: 400, json: { error: 'unsupported_grant_type' } };
    }
    const spent = await deps.authorizations.redeem({
      code: String(form.code || ''),
      clientId: String(form.client_id || ''),
      redirectUri: String(form.redirect_uri || ''),
      verifier: String(form.code_verifier || ''),
    });
    if (!spent.ok) return { status: 400, json: { error: spent.error } };

    // THE ACCESS TOKEN IS A DEVICE CREDENTIAL. Named so a person looking at
    // their device list can tell what it is and revoke it without guessing.
    const { token } = await deps.issueCredential(
      { email: spent.email, name: spent.name ?? null },
      'an MCP client',
    );
    deps.save();
    return {
      status: 200,
      headers: { 'cache-control': 'no-store' },
      json: { access_token: token, token_type: 'Bearer', scope: 'fleet' },
    };
  }

  if (path === '/mcp') {
    if (method !== 'POST') {
      // No SSE stream. GET is how a client opens one, and answering 405 says
      // there is none rather than leaving it waiting for events.
      return { status: 405, json: { error: 'this endpoint takes POST' } };
    }
    const token = bearer(req.authorization);
    const client = token ? await deps.verifyCredential(token) : null;
    if (!client?.email) {
      // THE 401 IS THE ENTRY POINT. Without this header a client has no way to
      // discover that signing in is even possible, and reports the endpoint as
      // broken rather than as protected.
      return {
        status: 401,
        headers: {
          'www-authenticate': `Bearer realm="fleetwright", resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        },
        json: { error: 'invalid_token' },
      };
    }
    const { status, body } = await handleMcpRequest({
      body: req.body,
      credential: /** @type {string} */ (token),
      // NOT `origin`. See the note above the function.
      coordinator: deps.selfOrigin,
    });
    return { status, json: body };
  }

  return null;
}
