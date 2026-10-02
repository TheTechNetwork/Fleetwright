// The minting Worker: the GitHub App's private key, the deposit key people
// seal their Claude logins to, and the logins themselves.
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
// What the coordinator can ask is a few narrow things, and this Worker checks
// each against GitHub rather than against the coordinator's word:
//
//   POST /mint            a repository token for a runner (src/fleet/minter/answer.js)
//   POST /runner-repo     can a runner be started from this repository, asked
//                         as the App, so setting one needs no permanent box
//   POST /github/token    a device finishing or renewing its own GitHub
//                         sign-in, with the client secret that stays here
//                         (src/fleet/minter/github.js)
//   POST /claude/key      the key a person seals a Claude login to
//   POST /claude/deposit  a person deposits, replaces or forgets theirs
//   POST /claude/login    a runner asks for its owner's (src/fleet/minter/claude.js)
//   POST /vault/device    a person reads or changes their vault, sealed on
//                         their own device (src/fleet/minter/vault.js)
//   POST /vault/box       a box asks for what its people approved it to hold,
//                         signed with the box's own key
//
// The logins are kept in a Durable Object of this Worker's own, `LOGINS`,
// which no other script is bound to — and kept sealed, so even the storage
// holds nothing this Worker's secret does not have to open.

import { answerMintRequest } from '../../src/fleet/minter/answer.js';
import { answerDeposit, answerLogin, depositKeyAnswer } from '../../src/fleet/minter/claude.js';
import { answerGithubToken } from '../../src/fleet/minter/github.js';
import { answerVaultDevice, answerVaultBox } from '../../src/fleet/minter/vault.js';
import { importAppKey, checkRunnerRepoForApp } from '../../src/core/repo-tokens.js';
import { importDepositKey } from '../../src/fleet/seal.js';

/** A request is a repository or a login, a job token and a public key. Anything bigger is not one. */
const MAX_BODY = 16 * 1024;

/** Everything this Worker answers. */
const ROUTES = ['/mint', '/runner-repo', '/github/token', '/claude/key', '/claude/deposit', '/claude/login', '/vault/device', '/vault/box'];

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

/** The deposit key, per isolate, on the same terms as the App key above. @type {{ secret: string, key: Promise<{ privateKey: CryptoKey, publicKey: string }> }|null} */
let depositImported = null;

/** @param {string} secret */
function depositKeyFor(secret) {
  if (!depositImported || depositImported.secret !== secret) {
    const key = importDepositKey(secret);
    depositImported = { secret, key };
    key.catch(() => {
      if (depositImported?.key === key) depositImported = null;
    });
  }
  return depositImported.key;
}

/**
 * The logins, through this Worker's own Durable Object. One instance: a fleet
 * of friends is a handful of rows, and one place to read them from is one
 * place to reason about.
 *
 * @param {any} ns  the LOGINS namespace binding, or undefined
 * @returns {import('../../src/fleet/minter/claude.js').LoginStore|null}
 */
function loginsFrom(ns) {
  if (!ns) return null;
  const stub = ns.get(ns.idFromName('logins'));
  /** @param {string} op @param {Record<string, unknown>} body */
  const call = async (op, body) => {
    const res = await stub.fetch(`https://logins.internal/${op}`, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`the login store answered ${res.status}`);
    return res.json();
  };
  return {
    get: async (id) => (await call('get', { id })).row ?? null,
    put: async (id, row) => {
      await call('put', { id, row });
    },
  };
}

/**
 * Where the logins are kept: rows of ciphertext, keyed by GitHub account id.
 * It answers this Worker and nothing else, because nothing else is bound to
 * it — and it would give anybody who was nothing they could open.
 */
export class ClaudeLogins {
  /**
   * @param {{ storage: { get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void> } }} state
   * @param {Record<string, any>} [env]
   */
  constructor(state, env = {}) {
    this.storage = state.storage;
    this.env = env;
  }

  /** @param {Request} request */
  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    /** @type {any} */
    const body = await request.json().catch(() => ({}));
    // THE VAULT RUNS HERE, in the one instance, and not in the Worker in front
    // of it: renewing an OAuth token rotates its refresh token, and only one
    // writer can make sure two boxes asking at once rotate it once. See the
    // lock in src/fleet/minter/vault.js.
    if (op === 'vault/device' || op === 'vault/box') {
      const config = vaultConfig(this.env, this.storage);
      return json(200, op === 'vault/device' ? await answerVaultDevice(body, config) : await answerVaultBox(body, config));
    }
    const id = String(body?.id || '');
    if (!/^[0-9]{1,20}$/.test(id)) return json(400, { ok: false });
    if (op === 'get') return json(200, { ok: true, row: (await this.storage.get(`gh:${id}`)) ?? null });
    if (op === 'put') {
      await this.storage.put(`gh:${id}`, body.row);
      return json(200, { ok: true });
    }
    return json(404, { ok: false });
  }
}

/**
 * What the vault needs, from this Worker's environment.
 *
 * @param {Record<string, any>} env
 * @param {{ get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void> }} storage
 * @returns {import('../../src/fleet/minter/vault.js').VaultConfig}
 */
function vaultConfig(env, storage) {
  const secret = String(env.FLEETWRIGHT_MINTER_DEPOSIT_KEY || '');
  return {
    depositKey: secret ? () => depositKeyFor(secret) : null,
    store: storage,
    clients: {
      github: { clientId: String(env.FLEETWRIGHT_GITHUB_CLIENT_ID || ''), secret: String(env.FLEETWRIGHT_GITHUB_CLIENT_SECRET || '') },
      cloudflare: { clientId: String(env.FLEETWRIGHT_CLOUDFLARE_CLIENT_ID || ''), secret: String(env.FLEETWRIGHT_CLOUDFLARE_CLIENT_SECRET || '') },
    },
  };
}

/** @param {number} status @param {unknown} body */
function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || !ROUTES.includes(url.pathname)) {
      return json(404, { ok: false, error: { code: 'not_found' }, text: 'This Worker mints repository tokens and keeps each person’s vault for the coordinator, and does nothing else.' });
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
    const owners = String(env.FLEETWRIGHT_GITHUB_MINT_OWNERS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (url.pathname === '/mint') {
      const pem = String(env.FLEETWRIGHT_GITHUB_APP_KEY || '');
      return json(200, await answerMintRequest(ask, {
        appKey: pem ? () => keyFor(pem) : null,
        clientId: String(env.FLEETWRIGHT_GITHUB_CLIENT_ID || ''),
        owners,
      }));
    }
    if (url.pathname === '/runner-repo') {
      const pem = String(env.FLEETWRIGHT_GITHUB_APP_KEY || '');
      const clientId = String(env.FLEETWRIGHT_GITHUB_CLIENT_ID || '');
      // NOT CONFIGURED IS AN ANSWER, as for /mint, so the coordinator can ask
      // a permanent box instead when one is there.
      if (!pem || !clientId) {
        return json(200, { ok: false, needsMinter: true, error: { code: 'not_a_minter' }, text: 'The minting Worker holds no GitHub App key.' });
      }
      let key;
      try {
        key = await keyFor(pem);
      } catch (e) {
        return json(200, { ok: false, error: { code: 'bad_key' }, text: `The GitHub App key does not load: ${/** @type {Error} */ (e).message}.` });
      }
      const check = await checkRunnerRepoForApp({ repo: String(/** @type {any} */ (ask)?.repo || ''), clientId, key });
      return json(200, { ok: check.ok, runnerRepo: check, text: check.message });
    }
    if (url.pathname === '/vault/device' || url.pathname === '/vault/box') {
      if (!env.LOGINS) return json(200, { ok: false, error: { code: 'no_store' }, text: 'The minting Worker has no storage bound, so it keeps no vault.' });
      const stub = env.LOGINS.get(env.LOGINS.idFromName('logins'));
      const res = await stub.fetch(`https://logins.internal${url.pathname}`, { method: 'POST', body: JSON.stringify(ask) });
      return json(200, await res.json());
    }
    const secret = String(env.FLEETWRIGHT_MINTER_DEPOSIT_KEY || '');
    /** @type {import('../../src/fleet/minter/claude.js').ClaudeConfig} */
    const claude = { depositKey: secret ? () => depositKeyFor(secret) : null, logins: loginsFrom(env.LOGINS), owners };
    if (url.pathname === '/github/token') {
      return json(200, await answerGithubToken(ask, {
        depositKey: claude.depositKey,
        clientId: String(env.FLEETWRIGHT_GITHUB_CLIENT_ID || ''),
        clientSecret: String(env.FLEETWRIGHT_GITHUB_CLIENT_SECRET || ''),
      }));
    }
    if (url.pathname === '/claude/key') return json(200, await depositKeyAnswer(claude));
    if (url.pathname === '/claude/deposit') return json(200, await answerDeposit(ask, claude));
    return json(200, await answerLogin(ask, claude));
  },
};
