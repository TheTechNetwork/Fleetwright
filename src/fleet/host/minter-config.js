// A permanent box as the minter: the App key read from this box's own file.
//
// The fallback to the minting Worker (worker/src/minter.js), for a fleet that
// would rather keep the key off Cloudflare. Separate from repo-tokens.js
// because this half reads a file, and repo-tokens.js is shared with a Worker
// that has no filesystem.

import { readFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';

/**
 * @typedef {object} Minter
 * @property {import('node:crypto').KeyObject} key
 * @property {string} clientId
 * @property {string[]} owners
 */

/**
 * The minter this box is configured to be, if any.
 *
 * Three settings, all on the box and none from the coordinator — the key cannot
 * come down the socket (the coordinator must never hold it), and the other two
 * say what that key may be used for, which is not the coordinator's to decide.
 * Read by loadSidecarConfig (src/fleet/host/config.js):
 *
 *   FLEETWRIGHT_GITHUB_APP_KEY        the App's private key, a PEM file. Or leave
 *                                     it unset and give systemd the key as the
 *                                     credential `github-app-key`
 *                                     (LoadCredentialEncrypted=), which puts it
 *                                     under $CREDENTIALS_DIRECTORY
 *   FLEETWRIGHT_GITHUB_APP_CLIENT_ID  the App's client id, the JWT's issuer
 *   FLEETWRIGHT_GITHUB_MINT_OWNERS    accounts whose repositories may be minted
 *                                     into, comma separated. Empty is nobody
 *
 * A box with none of them is not a minter and that is the normal case. A box
 * with some of them is misconfigured, and says which.
 *
 * @param {{ keyFile?: string, credentialsDirectory?: string, clientId?: string, owners?: string[] }} settings
 * @param {(file: string) => string} [read]
 * @returns {{ minter: Minter|null, problem: string|null }}
 */
export function loadMinter(settings, read = (f) => readFileSync(f, 'utf8')) {
  const file = String(settings.keyFile || '');
  const fromSystemd = settings.credentialsDirectory ? `${settings.credentialsDirectory}/github-app-key` : '';
  const clientId = String(settings.clientId || '').trim();
  const owners = (settings.owners || []).map((s) => String(s).trim()).filter(Boolean);
  let pem = '';
  for (const candidate of [file, fromSystemd].filter(Boolean)) {
    try {
      pem = read(candidate);
      break;
    } catch (e) {
      if (candidate === file) return { minter: null, problem: `FLEETWRIGHT_GITHUB_APP_KEY: ${/** @type {Error} */ (e).message}` };
    }
  }
  if (!pem && !clientId && !owners.length) return { minter: null, problem: null };
  if (!pem) return { minter: null, problem: 'repository tokens: no GitHub App key (FLEETWRIGHT_GITHUB_APP_KEY, or the systemd credential github-app-key)' };
  if (!clientId) return { minter: null, problem: 'repository tokens: FLEETWRIGHT_GITHUB_APP_CLIENT_ID is not set' };
  if (!owners.length) return { minter: null, problem: 'repository tokens: FLEETWRIGHT_GITHUB_MINT_OWNERS is empty, so there is nobody to mint for' };
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') return { minter: null, problem: 'repository tokens: the GitHub App key is not an RSA key' };
    return { minter: { key, clientId, owners }, problem: null };
  } catch (e) {
    return { minter: null, problem: `repository tokens: the GitHub App key does not load (${/** @type {Error} */ (e).message})` };
  }
}
