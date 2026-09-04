// Verifying an identity token from somebody else's identity provider.
//
// The coordinator has no accounts. It reads an OIDC ID token, checks it, and
// decides whether the email in it is on a list — see docs/identity.md for why
// it is not more than that.
//
// VERIFICATION IS `jose`, NOT OURS. This file hand-rolled it first, and the
// hand-rolled version was defensible — two algorithms, every claim checked,
// tests for alg:none and for a tampered payload. It still went. JWT
// verification is the canonical place where being nearly right has produced
// CVEs for a decade, and the failure mode is silent acceptance rather than a
// crash, which is the worst kind of thing to be nearly right about.
//
// jose was audited before it was taken: zero dependencies, MIT, ~100M downloads
// a week, written by an author of the specifications it implements, and built
// on WebCrypto so it runs in a Worker unchanged. Single-maintainer risk is real
// and is why the version is pinned rather than floated.
//
// What stays here is the part that is not cryptography: which issuers count,
// which addresses are allowed, and what to say when Apple hides one.

import { jwtVerify, createRemoteJWKSet } from 'jose';

/** Providers whose key set is not at the conventional well-known path. */
const JWKS_URLS = {
  'https://accounts.google.com': 'https://www.googleapis.com/oauth2/v3/certs',
  'https://appleid.apple.com': 'https://appleid.apple.com/auth/keys',
  'https://token.actions.githubusercontent.com': 'https://token.actions.githubusercontent.com/.well-known/jwks',
};

/** The one issuer that can speak for a CI job. */
export const ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * What a runner's token must be addressed to.
 *
 * A constant both sides agree on rather than a per-deployment value, because
 * the point of the audience here is only that a token minted for some OTHER
 * service cannot be replayed at this one. Which fleet it is for is settled by
 * the repository allowlist, not by this string.
 */
export const DEFAULT_ACTIONS_AUDIENCE = 'fleetwright';

/** @type {Map<string, any>} */
const jwks = new Map();

/**
 * The key set for an issuer.
 *
 * jose handles rotation, cooldowns and concurrent misses inside this object,
 * which is most of why it is worth having: a `kid` that misses refetches once
 * rather than once per request, and a provider rotating keys does not become an
 * outage.
 *
 * @param {string} issuer
 */
function keysFor(issuer) {
  let set = jwks.get(issuer);
  if (!set) {
    const url =
      JWKS_URLS[/** @type {keyof typeof JWKS_URLS} */ (issuer)] ||
      `${issuer.replace(/\/$/, '')}/.well-known/jwks.json`;
    set = createRemoteJWKSet(new URL(url), { cacheMaxAge: 3_600_000, cooldownDuration: 30_000 });
    jwks.set(issuer, set);
  }
  return set;
}

/**
 * A GitHub Actions job, proving it is the job it says it is.
 *
 * SEPARATE FROM verifyIdToken BECAUSE THE SUBJECT IS NOT A PERSON. That
 * function ends by requiring an `email` claim and checking it against an
 * allowlist of people; an Actions token carries no email and never will. What
 * it carries instead is which repository, which workflow file, and which run —
 * so the allowlist here is of REPOSITORIES, and the identity is a job.
 *
 * WHY THIS BEATS A STORED CREDENTIAL. The alternative for admitting a runner is
 * a long-lived secret in CI that can enrol a host. That secret is readable by
 * every workflow in the repository, survives the job, and cannot say WHICH job
 * used it. A token from this issuer is minted per job, expires in minutes,
 * names the run, and cannot be exported from the job that requested it.
 *
 * `job_workflow_ref` is the claim that matters most and is the one people skip.
 * `repository` alone means any workflow in that repository can admit a host,
 * including one added by a pull request. Pinning the workflow file means only
 * the file that is supposed to do this can.
 *
 * @param {string} token
 * @param {{ audiences: string[], repositories: string[], workflowRef?: string|string[]|null }} opts
 * @returns {Promise<{ repository: string, runId: string, runAttempt: string, workflowRef: string, ref: string, actor: string }>}
 */
export async function verifyActionsToken(token, { audiences, repositories, workflowRef = null }) {
  const raw = String(token || '');
  if (raw.split('.').length !== 3) throw new Error('not a JWT');
  if (!repositories.length) {
    // Empty means nobody, the same way the person allowlist works. A
    // deployment that has not said which repositories may admit hosts has not
    // opted in, and defaulting to "any" would make enabling the issuer enough
    // for anyone's fork to enrol.
    throw new Error('no repositories are configured to enrol runners');
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(raw, keysFor(ACTIONS_ISSUER), {
      issuer: ACTIONS_ISSUER,
      audience: audiences,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 60,
    }));
  } catch (e) {
    throw new Error(reasonFor(/** @type {any} */ (e)));
  }

  const repository = String(payload.repository || '');
  if (!repositories.includes(repository)) {
    throw new Error(`${repository || 'that repository'} is not allowed to enrol runners here`);
  }
  const jobWorkflowRef = String(payload.job_workflow_ref || '');
  // A LIST, because a runner repository has one workflow per operating system.
  //
  // It was a single prefix, which was right when the only runner was a Mac and
  // wrong the moment there were four files: pinning one of them means the other
  // three cannot admit a host, and pinning none means ANY workflow in the
  // repository can — including one a pull request adds, which is the whole
  // reason this claim is checked at all.
  //
  // A string still works and means a list of one, so no deployment's
  // configuration changes underneath it.
  const allowedRefs = (Array.isArray(workflowRef) ? workflowRef : [workflowRef]).filter(Boolean);
  if (allowedRefs.length && !allowedRefs.some((prefix) => jobWorkflowRef.startsWith(String(prefix)))) {
    throw new Error(`that job runs ${jobWorkflowRef || 'an unknown workflow'}, not ${allowedRefs.join(' or ')}`);
  }

  return {
    repository,
    runId: String(payload.run_id || ''),
    runAttempt: String(payload.run_attempt || '1'),
    workflowRef: jobWorkflowRef,
    ref: String(payload.ref || ''),
    actor: String(payload.actor || ''),
  };
}

/**
 * Verify an ID token and return the identity in it.
 *
 * Throws with a reason rather than returning null: every failure here is
 * something an operator may need to act on — a misconfigured audience, an
 * issuer nobody allowed, a clock — and "sign-in failed" tells them none of it.
 *
 * @param {string} token
 * @param {{ issuers: string[], audiences: string[] }} opts
 * @returns {Promise<{ email: string, sub: string, name: string|null, issuer: string }>}
 */
export async function verifyIdToken(token, { issuers, audiences }) {
  const raw = String(token || '');
  const parts = raw.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');

  // THE ISSUER IS CHECKED BEFORE ANY KEY IS FETCHED, and that ordering is the
  // whole security of this function. jose checks `iss` too — but only after
  // fetching the key named in the token's header. A token naming an attacker's
  // issuer would therefore send the coordinator off to fetch that attacker's
  // keys, and the signature would verify perfectly against them.
  let unverified;
  try {
    unverified = JSON.parse(new TextDecoder().decode(fromB64Url(parts[1])));
  } catch {
    throw new Error('not a JWT');
  }
  const issuer = String(unverified?.iss || '');
  if (!issuers.includes(issuer)) throw new Error(`issuer ${issuer || '(none)'} is not configured`);

  let payload;
  try {
    ({ payload } = await jwtVerify(raw, keysFor(issuer), {
      issuer,
      audience: audiences,
      // Named explicitly. Left open, `alg` is chosen by the token, which is
      // how algorithm confusion works.
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 60,
    }));
  } catch (e) {
    throw new Error(reasonFor(/** @type {any} */ (e)));
  }

  const email = String(payload.email || '').toLowerCase();
  if (!email) throw new Error('the token carries no email, so there is nothing to check against the allowlist');
  // Providers send this as a boolean or the string "true", depending on the
  // provider and the decade.
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new Error(`${email} is not verified with ${issuer}`);
  }

  return { email, sub: String(payload.sub || ''), name: payload.name ? String(payload.name) : null, issuer };
}

/**
 * jose's error codes, as something an operator can act on. Its own messages are
 * accurate and terse; these say what to do next.
 *
 * @param {{ code?: string, message?: string }} e
 */
function reasonFor(e) {
  switch (e.code) {
    case 'ERR_JWT_EXPIRED':
      return 'the token has expired — sign in again';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return `this token was issued for a different application (${e.message})`;
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'the signature does not verify';
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return 'the issuer has no such signing key — the token may be from a different provider';
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return `unsupported algorithm (${e.message})`;
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return 'the issuer published more than one matching key';
    default:
      return String(e.message || 'the token could not be verified');
  }
}

/** @param {string} s */
function fromB64Url(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Is this address allowed in?
 *
 * Entries are either a whole address or `@domain`. Empty allows NOBODY, which
 * is the right default for something that grants control of every machine in a
 * fleet — a coordinator that has not been told who is allowed should refuse
 * everyone rather than everyone.
 *
 * @param {string} email
 * @param {string[]} allow
 */
export function isAllowed(email, allow) {
  const address = String(email || '').toLowerCase().trim();
  if (!address.includes('@')) return false;
  const domain = address.slice(address.lastIndexOf('@'));

  return (allow || []).some((entry) => {
    const rule = String(entry || '').toLowerCase().trim();
    if (!rule) return false;
    return rule.startsWith('@') ? rule === domain : rule === address;
  });
}

/**
 * Apple's Hide My Email produces a real, stable address that can never match a
 * company domain. Refusing it as "not on the list" would send somebody to ask
 * why they are missing from a list they are on.
 *
 * @param {string} email
 */
export function isPrivateRelay(email) {
  return /@privaterelay\.appleid\.com$/i.test(String(email || ''));
}

/** Visible for tests. */
export function forgetJwks() {
  jwks.clear();
}

/**
 * A server-to-server notification from Apple.
 *
 * Apple POSTs one of these when a user changes their mail forwarding
 * preference, REVOKES this app from their Apple ID settings, or deletes their
 * Apple Account. The first is housekeeping; the other two mean a person has
 * withdrawn consent, and until now that flowed only one way — an admin could
 * revoke a phone, and a user revoking the app at Apple's end left their
 * credential working indefinitely.
 *
 * Verified exactly like an ID token, because it is one: a JWT signed by Apple,
 * for our audience. The signature is the entire authentication — this endpoint
 * is public by necessity, and anyone can POST to it.
 *
 * @param {string} token the `payload` field Apple sends
 * @param {{ audiences: string[] }} opts
 * @returns {Promise<{ type: string, email: string|null, sub: string|null }>}
 */
export async function verifyAppleNotification(token, { audiences }) {
  const raw = String(token || '');
  if (raw.split('.').length !== 3) throw new Error('not a JWT');

  // Fixed issuer, not read from the token. verifyIdToken has to look at `iss`
  // because it serves several providers; this one is Apple by definition, and
  // taking the issuer from the message would let the message choose whose keys
  // we fetch.
  const issuer = 'https://appleid.apple.com';
  let payload;
  try {
    ({ payload } = await jwtVerify(raw, keysFor(issuer), {
      issuer,
      audience: audiences,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 60,
    }));
  } catch (e) {
    throw new Error(reasonFor(/** @type {any} */ (e)));
  }

  // The interesting fields are nested one level down, as a JSON string.
  let events = payload.events;
  if (typeof events === 'string') {
    try {
      events = JSON.parse(events);
    } catch {
      throw new Error('the notification carried no readable events');
    }
  }
  const e = /** @type {any} */ (events || {});
  return {
    type: String(e.type || ''),
    email: e.email ? String(e.email).toLowerCase() : null,
    sub: e.sub ? String(e.sub) : null,
  };
}

/** The two that mean a person has withdrawn consent, as opposed to housekeeping.
 *  @param {string} type */
export function isWithdrawal(type) {
  return type === 'consent-revoked' || type === 'account-delete';
}
