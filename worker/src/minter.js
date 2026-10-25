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
//   POST /linked-repo     the same for any role of a linked repository —
//                         archive, runners or templates — and for the private
//                         roles only within FLEETWRIGHT_GITHUB_MINT_OWNERS
//   POST /github/token    a device finishing or renewing its own GitHub
//                         sign-in, with the client secret that stays here
//                         (src/fleet/minter/github.js)
//   POST /claude/key      the key a person seals a Claude login to
//   POST /claude/deposit  a person deposits, replaces or forgets theirs
//   POST /claude/login    a runner asks for its owner's (src/fleet/minter/claude.js)
//   POST /vault/device    a person reads or changes their vault, sealed on
//                         their own device (src/fleet/minter/vault.js)
//   POST /vault/box       a box asks for what its people approved it to hold,
//                         signed with the box's own key, beside the
//                         coordinator's list of who is still in the fleet
//   POST /vault/keys      a box asks for the signing keys people listed, to
//                         check the intents it is sent against; the answer is
//                         signed with this Worker's signing key
//                         (docs/signed-intents.md)
//
// ONE THING ON THE INTERNET, and it is a public key:
//
//   GET /.well-known/fleetwright-minter   the deposit key's public half, and
//                                         the signing key's
//
// And, only while the operator has set FLEETWRIGHT_MINTER_EXPORT_TO and asks
// with the `x-fleetwright-export: keys` header, the keys themselves sealed to
// that key, once, to keep them in Secrets Store (src/fleet/minter/backup.js).
//
// The deploy routes that one path of the fleet's own hostname here
// (.github/workflows/worker.yml), and a route runs before the coordinator's
// Custom Domain on the same hostname, so the coordinator never sees the
// request and cannot answer it with a key of its own. That is what lets a
// phone or `fleetwright-claude-login` find the key to seal to from the fleet's
// address alone, with nobody pasting a pin. Every other path is still only
// what the coordinator's service binding sends, and still POST.
//
// The logins are kept in a Durable Object of this Worker's own, `LOGINS`,
// which no other script is bound to, and kept sealed to the deposit key, which
// the same object makes the first time it is asked and keeps beside them
// (`depositSecret` below). FLEETWRIGHT_MINTER_DEPOSIT_KEY, when set, is used
// instead: a fleet that made one by hand keeps it.

import { answerMintRequest } from '../../src/fleet/minter/answer.js';
import { answerDeposit, answerLogin, depositKeyAnswer } from '../../src/fleet/minter/claude.js';
import { answerGithubToken, SIGNIN_PREFIX } from '../../src/fleet/minter/github.js';
import { answerVaultDevice, answerVaultBox, answerVaultKeys, answerClaudeFresh } from '../../src/fleet/minter/vault.js';
import { generateKeyPair } from '../../src/fleet/crypto.js';
import { importAppKey, checkRunnerRepoForApp, checkLinkedRepoForApp } from '../../src/core/repo-tokens.js';
import { importDepositKey, newDepositKey } from '../../src/fleet/seal.js';
import { storedSecret, snapshot, latestCopy, exportKeys, BACKUP_AFTER_MS } from '../../src/fleet/minter/backup.js';
import { signerRoutes, SIGNER_VERBS } from '../../src/fleet/minter/sign-page.js';
import { VERBS } from '../../src/fleet/protocol/intents.js';

/** A request is a repository or a login, a job token and a public key. Anything bigger is not one. */
const MAX_BODY = 16 * 1024;

/** Everything this Worker answers. */
const ROUTES = ['/mint', '/runner-repo', '/linked-repo', '/github/token', '/claude/key', '/claude/deposit', '/claude/login', '/vault/device', '/vault/box', '/vault/keys'];

/** The one public path: the deposit key's public half, and nothing else. */
export const KEY_PATH = '/.well-known/fleetwright-minter';

/** Where the object keeps the key it made. */
const DEPOSIT_ROW = 'deposit:key';
/** Where the object keeps the key it signs a box's key list with: a P-256 private JWK. */
const SIGNING_ROW = 'signing:key';

/**
 * The header that asks the public address for the keys sealed to the
 * operator's key instead of the public halves (exported, below). A header and
 * not a path or a query, because the deploy routes that one exact path here
 * and a route pattern with no wildcard matches no other path and no query.
 */
export const EXPORT_HEADER = 'x-fleetwright-export';

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
 * The deposit key, from the secret when one is set and from the object's own
 * storage otherwise, or null when this Worker has neither.
 *
 * @param {Record<string, any>} env
 * @returns {(() => Promise<{ privateKey: CryptoKey, publicKey: string }>)|null}
 */
function depositKeyFrom(env) {
  const secret = String(env.FLEETWRIGHT_MINTER_DEPOSIT_KEY || '');
  if (secret) return () => depositKeyFor(secret);
  if (!env.LOGINS) return null;
  return async () => {
    const stub = env.LOGINS.get(env.LOGINS.idFromName('logins'));
    const res = await stub.fetch('https://logins.internal/deposit-key', { method: 'POST', body: '{}' });
    /** @type {any} */
    const r = await res.json().catch(() => null);
    if (!r?.ok || typeof r.secret !== 'string') throw new Error('the login store did not give its key');
    return depositKeyFor(r.secret);
  };
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
    fresh: async (id) => /** @type {any} */ (await call('claude/fresh', { id })),
  };
}

/**
 * The device sign-ins recorded for an account, through the same object, for a
 * Claude deposit to check its GitHub token against (src/fleet/minter/claude.js).
 *
 * @param {any} ns  the LOGINS namespace binding, or undefined
 * @returns {((userId: string) => Promise<any>)|null}
 */
function signInsFrom(ns) {
  if (!ns) return null;
  const stub = ns.get(ns.idFromName('logins'));
  return async (id) => {
    const res = await stub.fetch('https://logins.internal/signin', { method: 'POST', body: JSON.stringify({ id }) });
    if (!res.ok) throw new Error(`the login store answered ${res.status}`);
    return (/** @type {any} */ (await res.json())).row ?? null;
  };
}

/**
 * Where the logins are kept: rows of ciphertext, keyed by GitHub account id.
 * It answers this Worker and nothing else, because nothing else is bound to
 * it — and it would give anybody who was nothing they could open.
 */
export class ClaudeLogins {
  /**
   * @param {{ storage: { get: (k: string) => Promise<any>, put: (k: string, v: any) => Promise<void>, list?: (o?: { prefix?: string, limit?: number }) => Promise<Map<string, any>>, getAlarm?: () => Promise<number|null>, setAlarm?: (t: number) => Promise<void> } }} state
   * @param {Record<string, any>} [env]
   */
  constructor(state, env = {}) {
    this.storage = state.storage;
    this.env = env;
    /** @type {Promise<string>|null} */
    this.made = null;
    /** @type {Promise<{ privateJwk: any, publicJwk: any }>|null} */
    this.signing = null;
    /** @type {Promise<void>|null} */
    this.ready = null;
  }

  /**
   * An empty object filled from the latest copy in R2, once, before it answers
   * anything (src/fleet/minter/backup.js). Only with the deposit key kept
   * outside the object, which is the only key that copy opens with, and only
   * when the object holds nothing at all: a copy is never laid over rows.
   *
   * A COPY THAT IS THERE AND WILL NOT BE READ stops the object answering,
   * rather than letting it start empty: the first thing written into it would
   * make it not empty, and the copy would never be read again. Unbinding
   * `BACKUP` is how an operator says to start empty anyway.
   *
   * @returns {Promise<void>}
   */
  restoreIfEmpty() {
    if (!this.ready) {
      this.ready = (async () => {
        if (!this.env.BACKUP || typeof this.storage.list !== 'function') return;
        if ((await this.storage.list({ limit: 1 })).size) return;
        const secret = String(this.env.FLEETWRIGHT_MINTER_DEPOSIT_KEY || '') || (await storedSecret(this.env.DEPOSIT_KEY_STORED));
        if (!secret) {
          console.warn('The minter is empty, and its deposit key is kept nowhere outside it, so no copy can be opened. Starting empty.');
          return;
        }
        const copy = await latestCopy(this.env.BACKUP, await depositKeyFor(secret));
        if (!copy) return;
        for (const [k, v] of Object.entries(copy.rows)) await this.storage.put(k, v);
        const n = Object.keys(copy.rows).length;
        console.log(`The minter was empty, and was filled from the copy made at ${new Date(copy.at).toISOString()}: ${n} ${n === 1 ? 'row' : 'rows'}.`);
      })();
      this.ready.catch(() => {
        this.ready = null;
      });
    }
    return this.ready;
  }

  /**
   * Whether the key kept outside agrees with the one this object holds, said
   * in the log when it does not. The object's own wins: it is the one every
   * vault here is sealed to, and a Secrets Store secret set to another key by
   * mistake must not take them all away. Never waited for.
   *
   * @param {string} name @param {any} binding @param {(outside: string) => boolean} same
   */
  agrees(name, binding, same) {
    storedSecret(binding).then(
      (outside) => {
        if (outside && !same(outside)) console.error(`The ${name} key in Secrets Store is not the one this minter holds; the one it holds is used. Put the exported one there (docs/vault.md).`);
      },
      () => {},
    );
  }

  /** The copy written BACKUP_AFTER_MS after a change, when a bucket is bound and no copy is due already. */
  async backupSoon() {
    if (!this.env.BACKUP || typeof this.storage.getAlarm !== 'function' || typeof this.storage.setAlarm !== 'function') return;
    try {
      if ((await this.storage.getAlarm()) === null) await this.storage.setAlarm(Date.now() + BACKUP_AFTER_MS);
    } catch {
      // The next answer asks again.
    }
  }

  /** Every row but the keys, copied to R2 and sealed to the deposit key (src/fleet/minter/backup.js). */
  async alarm() {
    if (!this.env.BACKUP || typeof this.storage.list !== 'function') return;
    await this.restoreIfEmpty();
    const secret = String(this.env.FLEETWRIGHT_MINTER_DEPOSIT_KEY || '') || (await this.depositSecret());
    await snapshot(this.env.BACKUP, await this.storage.list(), [DEPOSIT_ROW, SIGNING_ROW], await depositKeyFor(secret), Date.now());
  }

  /**
   * The key the device-key list a box is given is signed with, made the first
   * time it is asked and kept beside the deposit key, once, for the reason the
   * deposit key is made once (depositSecret). A box pins its public half from
   * the well-known address (docs/signed-intents.md), so a second key would be
   * a box refusing every answer after the first.
   *
   * @returns {Promise<{ privateJwk: any, publicJwk: any }>}
   */
  signingKey() {
    if (!this.signing) {
      this.signing = (async () => {
        const halves = (/** @type {any} */ jwk) => {
          const { d: _d, key_ops: _ops, ...rest } = jwk;
          return { privateJwk: jwk, publicJwk: { ...rest, key_ops: ['verify'] } };
        };
        const kept = await this.storage.get(SIGNING_ROW);
        if (kept && typeof kept === 'object' && typeof kept.d === 'string') {
          this.agrees('signing', this.env.SIGNING_KEY_STORED, (outside) => JSON.parse(outside)?.d === kept.d);
          return halves(kept);
        }
        // KEPT OUTSIDE, from Secrets Store (src/fleet/minter/backup.js): the
        // object lost, and the key every box pinned brought back with it.
        const outside = await storedSecret(this.env.SIGNING_KEY_STORED);
        if (outside) {
          const jwk = JSON.parse(outside);
          if (jwk?.kty !== 'EC' || jwk?.crv !== 'P-256' || typeof jwk?.d !== 'string') throw new Error('the signing key in Secrets Store is not a P-256 private key');
          await this.storage.put(SIGNING_ROW, jwk);
          return halves(jwk);
        }
        const { privateJwk, publicJwk } = await generateKeyPair();
        await this.storage.put(SIGNING_ROW, privateJwk);
        return { privateJwk, publicJwk };
      })();
      this.signing.catch(() => {
        this.signing = null;
      });
    }
    return this.signing;
  }

  /**
   * The key this object made, made the first time it is asked.
   *
   * ONCE, even when two requests ask before the first has finished: they share
   * one promise, because this is the only instance and the only isolate it
   * runs in. Two keys would mean a phone sealing to the first while the vault
   * opens with the second. A failure is forgotten so the next ask tries again.
   *
   * @returns {Promise<string>}
   */
  depositSecret() {
    if (!this.made) {
      this.made = (async () => {
        const kept = await this.storage.get(DEPOSIT_ROW);
        if (typeof kept === 'string' && kept) {
          this.agrees('deposit', this.env.DEPOSIT_KEY_STORED, (outside) => JSON.parse(outside)?.d === JSON.parse(kept)?.d);
          return kept;
        }
        // KEPT OUTSIDE, from Secrets Store: the object lost, and the key every
        // vault and every copy in R2 is sealed to brought back with it.
        const outside = await storedSecret(this.env.DEPOSIT_KEY_STORED);
        if (outside) {
          await importDepositKey(outside);
          await this.storage.put(DEPOSIT_ROW, outside);
          return outside;
        }
        const { secret } = await newDepositKey();
        await this.storage.put(DEPOSIT_ROW, secret);
        return secret;
      })();
      this.made.catch(() => {
        this.made = null;
      });
    }
    return this.made;
  }

  /** @param {Request} request */
  async fetch(request) {
    try {
      await this.restoreIfEmpty();
    } catch (e) {
      return json(503, { ok: false, error: { code: 'restore_failed' }, text: `The minter is empty and its copy in R2 could not be read back (${/** @type {Error} */ (e).message}), so it answers nothing until it can. See docs/vault.md.` });
    }
    const answer = await this.answer(request);
    await this.backupSoon();
    return answer;
  }

  /** @param {Request} request */
  async answer(request) {
    const op = new URL(request.url).pathname.slice(1);
    /** @type {any} */
    const body = await request.json().catch(() => ({}));
    // THE VAULT RUNS HERE, in the one instance, and not in the Worker in front
    // of it: renewing an OAuth token rotates its refresh token, and only one
    // writer can make sure two boxes asking at once rotate it once. See the
    // lock in src/fleet/minter/vault.js.
    // ITS OWN KEY, to the Worker in front of it and to nothing else: no other
    // script is bound to this object. Not asked for when the secret is set.
    if (op === 'deposit-key') return json(200, { ok: true, secret: await this.depositSecret() });
    // THE PUBLIC HALF ONLY, for the well-known answer: the private half never
    // leaves this object.
    // THE KEYS THEMSELVES, sealed to the operator's key, only while the
    // Worker secret naming that key is set (src/fleet/minter/backup.js).
    if (op === 'export') {
      const to = String(this.env.FLEETWRIGHT_MINTER_EXPORT_TO || '');
      if (!to) return json(404, { ok: false, error: { code: 'not_exporting' }, text: 'No key to export to is set.' });
      const depositKey = String(this.env.FLEETWRIGHT_MINTER_DEPOSIT_KEY || '') || (await this.depositSecret());
      const { privateJwk } = await this.signingKey();
      return json(200, { ok: true, v: 1, sealed: await exportKeys(to, { depositKey, signingKey: privateJwk }, Date.now()) });
    }
    if (op === 'signing-key') {
      const { publicJwk } = await this.signingKey();
      return json(200, { ok: true, key: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y } });
    }
    // A SIGN-IN RENEWED FOR A RUNNER here, under the vault's lock, because
    // the Worker in front cannot hold it (src/fleet/minter/claude-login.js).
    if (op === 'claude/fresh') {
      return json(200, await answerClaudeFresh(body, vaultConfig(this.env, this.storage, () => this.depositSecret())));
    }
    if (op === 'vault/device' || op === 'vault/box' || op === 'vault/keys') {
      const config = vaultConfig(this.env, this.storage, () => this.depositSecret(), () => this.signingKey());
      if (op === 'vault/keys') return json(200, await answerVaultKeys(body, config));
      return json(200, op === 'vault/device' ? await answerVaultDevice(body, config) : await answerVaultBox(body, config));
    }
    // A DEVICE'S GITHUB SIGN-IN finishes here too, beside the vault, because
    // it is recorded where the vault reads it (src/fleet/minter/github.js).
    if (op === 'github/token') {
      const config = vaultConfig(this.env, this.storage, () => this.depositSecret());
      const client = /** @type {{ clientId: string, secret: string }} */ (config.clients?.github);
      return json(200, await answerGithubToken(body, { depositKey: config.depositKey, clientId: client.clientId, clientSecret: client.secret, store: this.storage }));
    }
    const id = String(body?.id || '');
    if (!/^[0-9]{1,20}$/.test(id)) return json(400, { ok: false });
    if (op === 'get') return json(200, { ok: true, row: (await this.storage.get(`gh:${id}`)) ?? null });
    if (op === 'signin') return json(200, { ok: true, row: (await this.storage.get(`${SIGNIN_PREFIX}${id}`)) ?? null });
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
 * @param {() => Promise<string>} own  the key the object made, when no secret is set
 * @param {(() => Promise<{ privateJwk: any, publicJwk: any }>)|null} [signingKey]  the key a box's key list is signed with
 * @returns {import('../../src/fleet/minter/vault.js').VaultConfig}
 */
function vaultConfig(env, storage, own, signingKey = null) {
  const secret = String(env.FLEETWRIGHT_MINTER_DEPOSIT_KEY || '');
  return {
    depositKey: secret ? () => depositKeyFor(secret) : async () => depositKeyFor(await own()),
    signingKey,
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

/**
 * What the one public path answers: the public halves, or, asked with
 * EXPORT_HEADER while the operator has named a key to export to, the keys
 * themselves sealed to it (src/fleet/minter/backup.js).
 *
 * @param {Request} request @param {Record<string, any>} env
 */
async function keyAnswer(request, env) {
  if (request.headers.get(EXPORT_HEADER) !== 'keys') return publicKey(env);
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  // ONLY WHILE ASKED FOR: the operator sets FLEETWRIGHT_MINTER_EXPORT_TO to
  // a key of their own, fetches this once, and deletes it again. Unset, this
  // is the same 404 as any path the Worker does not serve.
  if (!env.FLEETWRIGHT_MINTER_EXPORT_TO || !env.LOGINS || request.method !== 'GET') {
    return new Response(JSON.stringify({ ok: false, error: { code: 'not_exporting' }, text: 'This minting Worker is not exporting its keys.' }), { status: 404, headers });
  }
  const stub = env.LOGINS.get(env.LOGINS.idFromName('logins'));
  const res = await stub.fetch('https://logins.internal/export', { method: 'POST', body: '{}' });
  return new Response(await res.text(), { status: res.status, headers });
}

/**
 * The deposit key's public half, for anyone who asks: a phone, the deposit
 * tool, a person with curl. Nothing about who keeps what, and nothing private.
 *
 * NOT CACHED, so a key made for the first time, or a new secret, is what the
 * next ask sees. It is one small read of one row.
 *
 * @param {Record<string, any>} env
 */
async function publicKey(env) {
  const key = depositKeyFrom(env);
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (!key) {
    return new Response(JSON.stringify({ ok: false, error: { code: 'no_deposit_key' }, text: 'This minting Worker has no storage bound, so it keeps no key.' }), { status: 503, headers });
  }
  try {
    return new Response(JSON.stringify({ ok: true, v: 1, key: (await key()).publicKey, ...(await signingPublic(env)) }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: { code: 'bad_deposit_key' }, text: `The deposit key does not load: ${/** @type {Error} */ (e).message}.` }), { status: 503, headers });
  }
}

/**
 * The signing key's public half, which a box pins to check the key list it is
 * given (docs/signed-intents.md), or nothing when this Worker keeps no storage
 * to make one in. Never a reason to fail the deposit key's answer beside it:
 * a phone sealing a deposit has no use for it.
 *
 * @param {Record<string, any>} env
 * @returns {Promise<{ signing?: { kty: string, crv: string, x: string, y: string } }>}
 */
async function signingPublic(env) {
  if (!env.LOGINS) return {};
  try {
    const stub = env.LOGINS.get(env.LOGINS.idFromName('logins'));
    const res = await stub.fetch('https://logins.internal/signing-key', { method: 'POST', body: '{}' });
    /** @type {any} */
    const r = await res.json().catch(() => null);
    return r?.ok && r.key ? { signing: r.key } : {};
  } catch {
    return {};
  }
}

/**
 * Per verb the signing page signs, the parameters the fleet sets after the
 * person asked, which a signature leaves out (intent-signature.js). From the
 * protocol's own table, so the page and a box agree on the bytes.
 */
const SIGNER_FLEET_PARAMS = Object.fromEntries(
  SIGNER_VERBS.map((verb) => [verb, Object.entries(/** @type {any} */ (VERBS)[verb]?.params ?? {}).filter(([, p]) => p?.setBy === 'fleet').map(([k]) => k)]),
);

/**
 * The signing host, and only what it serves.
 *
 * @param {Request} request @param {URL} url @param {Record<string, any>} env
 */
async function signingHost(request, url, env) {
  const page = await signerRoutes({ method: request.method, path: url.pathname }, {
    fleetOrigin: String(env.FLEETWRIGHT_FLEET_ORIGIN || ''),
    clientId: String(env.FLEETWRIGHT_GITHUB_CLIENT_ID || ''),
    fleet: String(env.FLEETWRIGHT_NAME || ''),
    fleetParams: SIGNER_FLEET_PARAMS,
    // A CLOUDFLARE SIGN-IN IS OFFERED ONLY WHERE ONE CAN BE KEPT: the client
    // this Worker renews with, its secret (the vault refuses without one) and
    // the client's registered scopes, which an authorize without asks for
    // nothing usable. The secret is looked at, never sent.
    cloudflare: env.FLEETWRIGHT_CLOUDFLARE_CLIENT_ID && env.FLEETWRIGHT_CLOUDFLARE_CLIENT_SECRET && env.FLEETWRIGHT_CLOUDFLARE_SCOPES
      ? { clientId: String(env.FLEETWRIGHT_CLOUDFLARE_CLIENT_ID), scopes: String(env.FLEETWRIGHT_CLOUDFLARE_SCOPES) }
      : null,
  });
  if (page) return new Response(request.method === 'HEAD' ? null : page.body, { status: page.status, headers: page.headers });
  if (url.pathname === KEY_PATH && (request.method === 'GET' || request.method === 'HEAD')) return keyAnswer(request, env);
  return new Response('Not here. This address serves the signing page and nothing else.', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const signHost = String(env.FLEETWRIGHT_SIGNING_HOST || '').trim().toLowerCase();
    if (signHost && url.hostname.toLowerCase() === signHost) return signingHost(request, url, env);
    if (url.pathname === KEY_PATH && (request.method === 'GET' || request.method === 'HEAD')) {
      return keyAnswer(request, env);
    }
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
    if (url.pathname === '/linked-repo') {
      const pem = String(env.FLEETWRIGHT_GITHUB_APP_KEY || '');
      const clientId = String(env.FLEETWRIGHT_GITHUB_CLIENT_ID || '');
      if (!pem || !clientId) {
        return json(200, { ok: false, needsMinter: true, error: { code: 'not_a_minter' }, text: 'The minting Worker holds no GitHub App key.' });
      }
      let key;
      try {
        key = await keyFor(pem);
      } catch (e) {
        return json(200, { ok: false, error: { code: 'bad_key' }, text: `The GitHub App key does not load: ${/** @type {Error} */ (e).message}.` });
      }
      const check = await checkLinkedRepoForApp({
        role: String(/** @type {any} */ (ask)?.role || ''),
        repo: String(/** @type {any} */ (ask)?.repo || ''),
        clientId,
        key,
        owners,
      });
      // NOT MINE TO SAY: a private role outside the accounts this key mints
      // into. The same answer as no key at all, so the coordinator asks a box
      // with the person's own connection — which can see exactly what they
      // can, and nothing of anybody else's.
      if (!check) {
        return json(200, { ok: false, needsMinter: true, error: { code: 'owner_not_allowed' }, text: 'That account is not one this fleet mints into.' });
      }
      return json(200, { ok: check.ok, linkedRepo: check, text: check.message });
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
      const check = await checkRunnerRepoForApp({ repo: String(/** @type {any} */ (ask)?.repo || ''), clientId, key, owners });
      // NOT MINE TO SAY, as for /linked-repo: anything but a public repository
      // outside the accounts this key mints into.
      if (!check) {
        return json(200, { ok: false, needsMinter: true, error: { code: 'owner_not_allowed' }, text: 'That account is not one this fleet mints into.' });
      }
      return json(200, { ok: check.ok, runnerRepo: check, text: check.message });
    }
    // THE VAULT, AND A DEVICE'S SIGN-IN when there is storage to record it
    // in. Without, a sign-in still finishes here and opens no vault, which a
    // minter with no storage does not keep anyway.
    if (url.pathname === '/vault/device' || url.pathname === '/vault/box' || url.pathname === '/vault/keys' || (url.pathname === '/github/token' && env.LOGINS)) {
      if (!env.LOGINS) return json(200, { ok: false, error: { code: 'no_store' }, text: 'The minting Worker has no storage bound, so it keeps no vault.' });
      const stub = env.LOGINS.get(env.LOGINS.idFromName('logins'));
      const res = await stub.fetch(`https://logins.internal${url.pathname}`, { method: 'POST', body: JSON.stringify(ask) });
      return json(200, await res.json());
    }
    /** @type {import('../../src/fleet/minter/claude.js').ClaudeConfig} */
    const claude = { depositKey: depositKeyFrom(env), logins: loginsFrom(env.LOGINS), owners, signIns: signInsFrom(env.LOGINS) };
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
