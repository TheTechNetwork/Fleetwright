// Credentials a session needs that are NOT Claude's.
//
// The ask that produced this: "Cloudflare api can be generated via a custom
// url so created in app, same with GitHub, same with many others." That last
// clause is the design. GitHub and Cloudflare are two providers; the shape
// they share is the feature:
//
//   1. a URL that opens the provider's own token page, PRE-FILLED with the
//      scopes this needs, so the page the person lands on is already narrowed
//   2. they create the token, on their account, under their own eyes
//   3. they paste it back, once
//   4. it is verified against the provider's API before it is stored, so a
//      typo fails HERE rather than four hours into a session
//
// No OAuth app, no client secret, no callback URL, and nothing of ours in the
// middle of their consent screen. It also means adding a provider later is a
// row in a table rather than a protocol change — which is the whole reason the
// fleet verbs are `connect`/`link`/`unlink` and not `github`/`cloudflare`.
//
// WHERE THE SECRET LIVES: exactly one file, `<email>.env`, mode 0600. The
// metadata that says a connection exists lives in a SEPARATE file with no
// secret in it, so the status a phone can ask for is read from a file that has
// nothing to leak. Two files is not tidiness — it is the difference between
// "we are careful when we serialise" and "there is nothing there to serialise".
//
// This is deliberately not the credential-terminating proxy from docs/trust.md.
// That is still the right long-term answer and this does not compete with it:
// a token here is a real token on the box, minted by the person, scoped by the
// person, revocable by the person. What it buys is that a guest never hands
// anyone else's credential to anyone, which is the constraint that mattered:
// "the guests will be bringing their own GitHub Cloudflare Claude creds, no
// shared creds to them."

import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';

import { normaliseEmail, HOST_ROW } from './accounts.js';

/** How long a provider gets to answer before we call the token unverifiable. */
const VERIFY_TIMEOUT_MS = 10_000;

/**
 * @typedef {object} Provider
 * @property {string} label            what a person calls it
 * @property {string[]} env            environment variables the token is exported as
 * @property {(host: string) => string} url  where to go to create one
 * @property {string} hint             said on screen, before they leave for that page
 * @property {(secret: string) => Promise<{ ok: boolean, account?: string, granted?: string[]|null, message: string }>} verify
 * @property {string[]} [wants]  permissions the catalogue currently asks for, when they are checkable
 */

/** @param {string} s */
const enc = (s) => encodeURIComponent(s);

/**
 * What a session doing this project's work actually needs.
 *
 * The first pass pre-ticked the minimum that came to mind, and the minimum was
 * wrong in a way that only shows up hours later: `repo,workflow,read:org` on
 * GitHub and `workers_scripts,workers_kv_storage` on Cloudflare would not have
 * let a session do the last week's work. Creating `fleetdemo.thetech.network`
 * needs DNS on the zone; deploying the Worker needs routes; reading a
 * deployment's own settings needs account read.
 *
 * A token that is missing a permission fails INSIDE a session, four hours in,
 * with a provider error nobody reading it has the context to interpret. A
 * token with a permission it never uses costs nothing until it leaks — and it
 * is the person's own token, on their own account, revocable by them, which is
 * the whole reason this design was chosen over holding credentials ourselves.
 *
 * So this errs toward "the work succeeds", and says plainly on screen that the
 * list can be narrowed. That is the honest trade rather than a silent one.
 */
const GITHUB_SCOPES = [
  'repo', // code, issues, PRs, releases — the bulk of it
  'workflow', // editing anything under .github/workflows, which this project does constantly
  'read:org', // org membership, so `gh` can resolve teams and org repos
  'gist', // sharing a snippet out of a session
  'read:packages', // pulling a private package in a build
  'admin:repo_hook', // webhooks a deploy sets up
];

/**
 * Cloudflare permission groups, as the dashboard's custom-token deep link
 * expects them.
 *
 * Account-level and zone-level in one list; the dashboard sorts them into the
 * right rows itself. `accountId=*&zoneId=all` in the URL is what makes both
 * sections appear.
 */
const CLOUDFLARE_PERMISSIONS = [
  { key: 'workers_scripts', type: 'edit' }, // deploy the Worker
  { key: 'workers_kv_storage', type: 'edit' }, // its KV
  { key: 'workers_routes', type: 'edit' }, // and the routes it answers on
  { key: 'workers_r2', type: 'edit' },
  { key: 'd1', type: 'edit' },
  { key: 'workers_tail', type: 'read' }, // `wrangler tail`, which is how the fleet gets debugged
  { key: 'account_settings', type: 'read' }, // resolve the account id without being told it
  { key: 'dns_records', type: 'edit' }, // custom domains — fleetdemo.thetech.network needed this
  { key: 'zone_settings', type: 'read' },
  { key: 'zone', type: 'read' },
  { key: 'ssl_and_certificates', type: 'edit' }, // a custom domain's certificate
  { key: 'page_rules', type: 'edit' },
];

/**
 * @param {Response} res
 * @param {string} what
 */
function apiFailure(res, what) {
  if (res.status === 401 || res.status === 403) {
    return `${what} rejected that token (${res.status}). Check it was copied whole, and that it has not expired.`;
  }
  return `${what} answered ${res.status}. The token was not stored.`;
}

/** @type {Readonly<Record<string, Provider>>} */
export const PROVIDERS = Object.freeze({
  github: {
    label: 'GitHub',
    // GH_TOKEN is what the `gh` CLI reads; GITHUB_TOKEN is what almost
    // everything else does. Setting both costs nothing and saves a session
    // discovering the difference at the worst moment.
    env: ['GH_TOKEN', 'GITHUB_TOKEN'],
    // Checkable, because GitHub returns the granted scopes on every request.
    // Cloudflare has no equivalent that this token is allowed to read, so it
    // has no `wants` and the app says what is asked for without claiming to
    // know what was given — a difference worth keeping visible rather than
    // papering over.
    wants: GITHUB_SCOPES,
    // A CLASSIC token, deliberately: the query parameters that pre-tick scopes
    // only work on this page. Fine-grained tokens are the better credential and
    // cannot be pre-filled at all, so choosing them would mean handing somebody
    // a bare settings page and a list of instructions to follow by hand. When
    // GitHub supports pre-filling those, this row changes and nothing else does.
    url: (label) =>
      `https://github.com/settings/tokens/new?scopes=${GITHUB_SCOPES.join(',')}&description=${enc(`Fleetwright — ${label}`)}`,
    hint: 'The scopes are pre-ticked for the work a session usually does — untick anything you would rather it could not do. Replacing one? Delete the old "Fleetwright" token on that page first: GitHub has no API to revoke a personal token, so this cannot do it for you, and an abandoned token stays live until you remove it.',
    async verify(secret) {
      const res = await fetch('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${secret}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'agent-hub',
        },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, message: apiFailure(res, 'GitHub') };
      const body = /** @type {any} */ (await res.json());
      const login = typeof body?.login === 'string' ? body.login : null;
      // WHAT THIS TOKEN CAN ACTUALLY DO, handed back on every request for
      // free. Worth capturing because the expected list GROWS: the first
      // version asked for three scopes and the work needed six, and the people
      // who connected before that change had no way to find out — their token
      // simply failed inside a session, hours later, at whichever step needed
      // the missing one.
      //
      // Granted scopes are not a secret. They are the same list the person
      // ticked, and storing them is what lets the app say "this one is missing
      // workflow" instead of "connected".
      // ABSENT IS NOT EMPTY, and conflating them reported a working token as
      // broken. A GitHub APP user token carries no classic scopes at all — its
      // capabilities are the App's permissions, chosen at install and listed
      // nowhere in this header — so GitHub omits it. Parsing that as `[]` and
      // subtracting it from the PAT scope list produced "missing repo,
      // workflow, read:org, gist, read:packages, admin:repo_hook" on a token
      // that was working perfectly.
      //
      // It was also a category error: an App token's permissions and a PAT's
      // scopes are different vocabularies, and there is nothing to compare.
      // `null` means "cannot tell", which both apps already render as itself
      // rather than as an absence.
      const header = res.headers.get('x-oauth-scopes');
      const granted = header === null || header.trim() === ''
        ? null
        : header.split(',').map((x) => x.trim()).filter(Boolean);
      return login
        ? {
            ok: true,
            account: login,
            granted,
            message:
              `GitHub token verified as @${login}.` +
              // Said once, here, rather than left as a silent null the apps
              // have to explain for themselves. An App token is not a lesser
              // token — it is a differently-shaped one, and its permissions
              // live on the installation.
              (granted === null
                ? '\nThis looks like a GitHub App token: its permissions are the ones chosen when the App was ' +
                  'installed, and GitHub does not report them as scopes.'
                : ''),
          }
        : { ok: false, message: 'GitHub accepted the token but did not say who it belongs to.' };
    },
  },

  cloudflare: {
    label: 'Cloudflare',
    env: ['CLOUDFLARE_API_TOKEN'],
    // Cloudflare's dashboard accepts a custom-token template in the query
    // string. If that ever stops working the link still lands on the API
    // tokens page, which is the page they need — a deep link that degrades
    // into a shallow one is an acceptable failure; one that 404s is not.
    url: (label) =>
      'https://dash.cloudflare.com/profile/api-tokens?' +
      `name=${enc(`Fleetwright — ${label}`)}&` +
      `permissionGroupKeys=${enc(JSON.stringify(CLOUDFLARE_PERMISSIONS))}&` +
      'accountId=*&zoneId=all',
    hint: 'Use "Create Custom Token" — the permissions arrive pre-selected, covering Workers, KV, R2, D1, DNS and certificates, because a custom domain and a deploy both need more than Workers alone. Editing the existing "Fleetwright" token on that page also works, and keeps the value you already pasted. Untick anything you would rather it could not do.',
    async verify(secret) {
      const res = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      // Cloudflare answers 401 with a JSON body that explains itself, so read
      // the body before deciding — its message is better than our guess.
      const body = /** @type {any} */ (await res.json().catch(() => null));
      if (body?.success === true && body?.result?.status === 'active') {
        return { ok: true, account: body?.result?.id ? String(body.result.id).slice(0, 8) : undefined, message: 'Cloudflare token verified and active.' };
      }
      const said = body?.errors?.[0]?.message;
      if (said) return { ok: false, message: `Cloudflare rejected that token: ${said}` };
      if (body?.result?.status) return { ok: false, message: `Cloudflare says that token is ${body.result.status}.` };
      return { ok: false, message: apiFailure(res, 'Cloudflare') };
    },
  },
});

/** @param {unknown} name */
export function isProvider(name) {
  return Object.hasOwn(PROVIDERS, String(name ?? ''));
}

/**
 * Providers, for a picker. Never includes anything secret.
 *
 * `label` names the token on the provider's page. It used to be the hostname,
 * which made sense when a token lived on one box — now that a token is the
 * person's and goes to every host, the person is what identifies it, and
 * identifying it is what makes the old one findable when they replace it.
 *
 * @param {string} label
 */
export function catalogue(label) {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    provider: id,
    label: p.label,
    url: p.url(label),
    hint: p.hint,
    env: p.env,
    // What this asks for, so a screen can show the difference against what a
    // stored token was actually granted. Absent where the provider will not
    // tell us — see `wants`.
    ...(p.wants ? { wants: p.wants } : {}),
  }));
}

/**
 * Verify a token with its provider, and never throw.
 *
 * A network failure is NOT a bad token, and saying so matters: "could not
 * reach GitHub" sends somebody to check their connection, while "GitHub
 * rejected that token" sends them to mint a new one. Collapsing the two wastes
 * whichever of those two trips was the wrong one.
 *
 * @param {string} provider @param {string} secret
 */
export async function verifyToken(provider, secret) {
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, message: `"${provider}" is not a provider this host knows.` };
  try {
    return await p.verify(secret);
  } catch (e) {
    const err = /** @type {Error} */ (e);
    const why = err.name === 'TimeoutError' ? `did not answer within ${VERIFY_TIMEOUT_MS / 1000}s` : err.message;
    return { ok: false, message: `Could not reach ${p.label} to check the token — it ${why}. Nothing was stored.` };
  }
}

/**
 * What a credential is allowed to look like.
 *
 * Printable ASCII, no whitespace, and no quote or backslash. Two reasons, and
 * the second one is why this is a hard refusal rather than an escape:
 *
 *  1. A token with whitespace in it is a paste that picked up half the page,
 *     which `login.js` already refuses for the authorization code and for the
 *     same reason.
 *  2. The file this ends up in has TWO readers with DIFFERENT quoting rules —
 *     the sandbox entrypoint sources it with `.`, and systemd's
 *     EnvironmentFile parser (which `src/core/env-file.js` reproduces) strips
 *     exactly one layer of surrounding quotes and knows nothing about `'\''`.
 *     Escaping correctly for one is escaping wrongly for the other. Refusing
 *     the characters that make them disagree means there is nothing to get
 *     right twice.
 *
 * Every token shape these providers actually issue passes: `ghp_…`, base64url,
 * JWTs, Cloudflare's alphanumerics.
 */
/** @param {unknown} secret */
export function looksLikeToken(secret) {
  const s = String(secret ?? '');
  // The leading-dash rule mirrors src/fleet/protocol/intents.js: agent-hub's
  // parser reads `-word` as a flag, so a token starting with one would be read
  // as an option rather than a value — `--host` most dangerously of all.
  return (
    s.length > 0 &&
    s.length <= 4096 &&
    /^[\x21-\x7e]+$/.test(s) &&
    !/['"\\]/.test(s) &&
    !/^[-\u2013\u2014]/.test(s)
  );
}

/**
 * One assignment line, quoted so both readers of this file agree.
 *
 * Safe because `looksLikeToken` has already refused everything that would need
 * escaping. The quotes are still there so a value can never be read as bare
 * shell words if the charset rule is ever loosened.
 *
 * @param {string} key @param {string} value
 */
function assignment(key, value) {
  return `${key}='${value}'`;
}

/**
 * Per-person connected credentials.
 *
 * Keyed by the same normalised email as `Accounts`, and living in the same
 * directory, because they are the same idea: what this person's sessions run
 * with. `null` is the box itself — a solo install, or the shared org row —
 * which is stored under a dot-prefixed name so `Accounts.list()` cannot mistake
 * it for a person.
 */
export class Connections {
  /** @param {string} stateDir */
  constructor(stateDir) {
    this.dir = path.join(stateDir, 'accounts');
  }

  /**
   * The filename stem for a row, or null when there is no such row.
   *
   * `null` USED TO MEAN THE BOX. It now means nothing at all, and that change
   * is the fix for a real defect: `emailFromActor` returns null both for "a
   * local operator, use the shared row" and for "a fleet identity I could not
   * parse", and those two had the same effect — the second one writing a
   * person's live token into the file every session on the machine reads.
   *
   * The box is `HOST_ROW`, a symbol, which nothing can arrive at by accident.
   *
   * @param {string|symbol|null} row @returns {string|null}
   */
  #stem(row) {
    if (row === HOST_ROW) return '.host';
    return typeof row === 'string' ? normaliseEmail(row) : null;
  }

  /** The one file a secret is ever in. @param {string|symbol|null} row */
  envPathFor(row) {
    const stem = this.#stem(row);
    return stem ? path.join(this.dir, `${stem}.env`) : null;
  }

  /** Metadata only — safe to read anywhere. @param {string|symbol|null} row */
  metaPathFor(row) {
    const stem = this.#stem(row);
    return stem ? path.join(this.dir, `${stem}.connections.json`) : null;
  }

  /**
   * What is connected, and to which account. Never the token.
   * @param {string|symbol|null} row
   * @returns {Array<{ provider: string, label: string, account: string|null, updatedAt: number }>}
   */
  list(row) {
    const file = this.metaPathFor(row);
    if (!file || !existsSync(file)) return [];
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8'));
      return Object.entries(meta)
        .filter(([id]) => isProvider(id))
        .map(([id, v]) => {
          const granted = Array.isArray(/** @type {any} */ (v)?.granted) ? /** @type {any} */ (v).granted : null;
          const wants = PROVIDERS[id].wants;
          return {
            provider: id,
            label: PROVIDERS[id].label,
            account: typeof (/** @type {any} */ (v)?.account) === 'string' ? /** @type {any} */ (v).account : null,
            updatedAt: Number(/** @type {any} */ (v)?.updatedAt) || 0,
            // WHAT IS MISSING, when that is knowable. Null means "cannot tell"
            // — an older record with no granted list, or a provider that will
            // not say — and null is deliberately different from an empty
            // array, which means "checked, nothing missing".
            missing: granted && wants ? wants.filter((w) => !granted.includes(w)) : null,
          };
        })
        .sort((a, b) => a.provider.localeCompare(b.provider));
    } catch {
      return []; // unreadable metadata is "nothing connected", never an error
    }
  }

  /**
   * Check a STORED credential against its provider, and report what it can do.
   *
   * Different from verifying at link time, which checks a value somebody just
   * pasted. This checks the one actually in use — which is the question worth
   * asking, because a token can be revoked, expire, or have its permissions
   * narrowed at the provider long after it was stored, and nothing here would
   * know until a session failed.
   *
   * The secret never leaves: it is read, sent to the provider, and the answer
   * comes back as an account name and a list of scope NAMES.
   *
   * @param {string|symbol|null} row @param {string} provider
   * @returns {Promise<{
   *   ok: boolean,
   *   message: string,
   *   account?: string,
   *   granted?: string[]|null,
   *   wants?: string[]|null,
   *   missing?: string[]|null,
   * }>}
   */
  async check(row, provider) {
    const p = PROVIDERS[provider];
    if (!p) return { ok: false, message: `"${provider}" is not a provider this host knows.` };
    const secret = this.#secrets(row)[p.env[0]];
    if (!secret) return { ok: false, message: `No ${p.label} token is stored here.` };

    const checked = await verifyToken(provider, secret);
    if (!checked.ok) return checked;
    const granted = checked.granted ?? null;
    const wants = p.wants ?? null;
    return {
      ...checked,
      granted,
      wants,
      // Null, not empty: "cannot tell" is a different fact from "nothing
      // missing", and rendering the first as the second is how somebody finds
      // out four hours into a session.
      missing: granted && wants ? wants.filter((w) => !granted.includes(w)) : null,
    };
  }

  /** The tokens themselves, read back to rewrite the file. @param {string|symbol|null} row */
  #secrets(row) {
    const file = this.envPathFor(row);
    /** @type {Record<string, string>} */
    const out = {};
    if (!file || !existsSync(file)) return out;
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
    return out;
  }

  /**
   * Store a verified token.
   *
   * The whole env file is rewritten from what is already there plus this
   * provider's variables, so removing a provider from the catalogue cannot
   * strand its variable in a file forever.
   *
   * @param {string|symbol|null} row @param {string} provider @param {string} secret
   * @param {string|null} [account]
   * @param {string[]|null} [granted]  the permission names the provider says
   *   this token actually carries, where it will say. Not a secret — the same
   *   words the person ticked — and the only way to notice later that the
   *   asked-for list has grown past what they granted.
   */
  save(row, provider, secret, account = null, granted = null) {
    const p = PROVIDERS[provider];
    const envFile = this.envPathFor(row);
    const metaFile = this.metaPathFor(row);
    if (!p) return { ok: false, message: `"${provider}" is not a provider this host knows.` };
    // FAILS CLOSED. There is no row to write to, so nothing is written —
    // rather than falling back to a shared one that other people read.
    if (!envFile || !metaFile) return { ok: false, message: 'there is no credential row for that identity' };
    if (!looksLikeToken(secret)) {
      return {
        ok: false,
        message:
          'That does not look like a token — paste just the token itself, with no spaces or quotes around it.',
      };
    }

    const secrets = this.#secrets(row);
    for (const key of p.env) secrets[key] = secret;

    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      envFile,
      `# Written by agent-hub. One line per credential; sourced into sessions.\n` +
        Object.entries(secrets)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => assignment(k, v))
          .join('\n') +
        '\n',
      { mode: 0o600 },
    );

    /** @type {Record<string, unknown>} */
    let meta = {};
    try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { /* first connection */ }
    // `granted` is a list of scope names, not a credential. Kept beside the
    // metadata so the app can say "missing workflow" rather than "connected"
    // when the asked-for list has grown since this token was made.
    meta[provider] = { account, updatedAt: Date.now(), ...(granted ? { granted } : {}) };
    writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });

    // `granted === null` means the provider will not say — an App token, whose
    // permissions are the installation's. Nothing to subtract, so nothing is
    // short, and claiming otherwise is how a working credential gets reported
    // as broken the moment it is stored.
    const short = granted && p.wants ? p.wants.filter((w) => !granted.includes(w)) : [];
    return {
      ok: true,
      message:
        `${p.label} connected${account ? ` as ${account}` : ''}. New sessions get it as ${p.env.join(' and ')}.` +
        // Said at the moment of storing, because this is the last point where
        // the person is still on the provider's page in another tab.
        (short.length ? `\nIt is missing ${short.join(', ')} — sessions will fail at whatever needs those.` : ''),
    };
  }

  /**
   * Forget a token.
   *
   * Only ours — a session that is already running holds what it was seeded
   * with and is not reached into, exactly as `logout` leaves running sessions
   * alone. And this cannot revoke anything at the provider, so it says so:
   * the token is still live on their account until they revoke it there.
   *
   * @param {string|symbol|null} row @param {string} provider
   */
  remove(row, provider) {
    const p = PROVIDERS[provider];
    const envFile = this.envPathFor(row);
    const metaFile = this.metaPathFor(row);
    if (!p || !envFile || !metaFile) return { ok: false, message: `"${provider}" is not a provider this host knows.` };

    const secrets = this.#secrets(row);
    let had = false;
    for (const key of p.env) {
      if (key in secrets) had = true;
      delete secrets[key];
    }
    const rest = Object.entries(secrets).sort(([a], [b]) => a.localeCompare(b));
    if (rest.length) {
      writeFileSync(
        envFile,
        `# Written by agent-hub. One line per credential; sourced into sessions.\n` +
          rest.map(([k, v]) => assignment(k, v)).join('\n') +
          '\n',
        { mode: 0o600 },
      );
    } else if (existsSync(envFile)) {
      unlinkSync(envFile);
    }

    try {
      const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
      delete meta[provider];
      if (Object.keys(meta).length) writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
      else unlinkSync(metaFile);
    } catch { /* nothing recorded — the env file was the whole story */ }

    return had
      ? {
          ok: true,
          message:
            `Forgot the ${p.label} token. Sessions already running keep what they were seeded with.\n` +
            `It is still live on your ${p.label} account — revoke it there if you want it dead.`,
        }
      : { ok: false, message: `No ${p.label} token was stored.` };
  }
}
