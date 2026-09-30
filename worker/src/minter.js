// The minting Worker: the GitHub App's private key, and one route.
//
//   cd worker && npx wrangler deploy --config wrangler.minter.toml
//
// A SEPARATE SCRIPT FROM THE COORDINATOR, for the reason the demo is one: the
// security boundary is what is in scope. The coordinator is internet-facing and
// this project treats it as compromised, so the key that mints for every
// installation of the App does not live in it. It lives here, in a Worker with
// no public route — wrangler.minter.toml sets no routes and turns workers.dev
// off — reached only by the coordinator's service binding.
//
// What the coordinator can ask is one thing, and this Worker checks that thing
// against GitHub rather than against the coordinator's word. See
// src/fleet/minter/answer.js for the checks and why each one is there.

import { answerMintRequest } from '../../src/fleet/minter/answer.js';
import { importAppKey } from '../../src/core/repo-tokens.js';

/** A request is a repository, a job token and a public key. Anything bigger is not one. */
const MAX_BODY = 16 * 1024;

/**
 * The imported key, per isolate. Importing is cheap and done once; the PEM it
 * came from is kept beside it so a rotated secret is picked up on the next
 * request rather than on the next cold start.
 * @type {{ pem: string, key: Promise<CryptoKey> }|null}
 */
let imported = null;

/** @param {string} pem */
function keyFor(pem) {
  if (!imported || imported.pem !== pem) {
    const key = importAppKey(pem);
    imported = { pem, key };
    // A key that failed to import is forgotten, so the next request tries
    // again — and says why — instead of repeating a cached rejection for ever.
    key.catch(() => {
      if (imported?.key === key) imported = null;
    });
  }
  return imported.key;
}

/** @param {number} status @param {unknown} body */
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, string|undefined>} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/mint') {
      return json(404, { ok: false, error: { code: 'not_found' }, text: 'This Worker mints repository tokens for the coordinator and does nothing else.' });
    }
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY) {
      return json(413, { ok: false, error: { code: 'too_large' }, text: 'That is not a request for a repository token.' });
    }
    let ask;
    try {
      ask = await request.json();
    } catch {
      return json(400, { ok: false, error: { code: 'bad_request' }, text: 'The request was not JSON.' });
    }
    const pem = String(env.FLEETWRIGHT_GITHUB_APP_KEY || '');
    const answer = await answerMintRequest(ask, {
      appKey: pem ? () => keyFor(pem) : null,
      clientId: String(env.FLEETWRIGHT_GITHUB_CLIENT_ID || ''),
      owners: String(env.FLEETWRIGHT_GITHUB_MINT_OWNERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    return json(200, answer);
  },
};
