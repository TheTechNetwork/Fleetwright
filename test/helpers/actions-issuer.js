// GitHub's Actions OIDC issuer, stood in: a key set answered where jose looks
// for one, and a signer for job tokens with whatever claims a test needs.
// Shared by the tests of everything a runner's job token unlocks.
import { ACTIONS_ISSUER } from '../../src/fleet/coordinator/oidc.js';

const json = (/** @type {number} */ status, /** @type {any} */ body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * ONE KEY PER PROCESS, under the one `kid`. The verifier (oidc.js keysFor)
 * keeps a remote key set per issuer for the life of the process, cached for
 * an hour with a thirty-second cooldown on refetching, exactly as it should
 * for GitHub. This helper minted a fresh pair on every call under the same
 * `kid`, so the second fleet a test stood up within thirty seconds of the
 * first verified its tokens against the first fleet's key: "the issuer has
 * no such signing key" about one case in three of a table that stands up a
 * fleet per row, and the same once on CI. The key is not what any of those
 * tests is about; the claims are.
 * @type {Promise<CryptoKeyPair>|null}
 */
let signing = null;

/** GitHub's Actions issuer: a key set for jose, and a signer for job tokens. */
export async function actionsIssuer() {
  signing ??= crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pair = await signing;
  const keys = [{ ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'gha', alg: 'RS256', use: 'sig' }];
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
    let host = '';
    try { host = new URL(String(url)).hostname; } catch { /* not a URL */ }
    return host === 'token.actions.githubusercontent.com' ? json(200, { keys }) : real(url, init);
  });
  const b64 = (/** @type {any} */ o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const sign = async (/** @type {any} */ claims) => {
    const h = b64({ alg: 'RS256', kid: 'gha', typ: 'JWT' });
    const c = b64({ iss: ACTIONS_ISSUER, exp: Math.floor(Date.now() / 1000) + 600, run_id: '99', run_attempt: '1', ...claims });
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${c}`));
    return `${h}.${c}.${Buffer.from(sig).toString('base64url')}`;
  };
  return { sign, restore: () => { globalThis.fetch = real; } };
}
