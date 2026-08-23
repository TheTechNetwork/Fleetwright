// Reading the credential off a request, in ONE place.
//
// This file exists because there were three places and two of them disagreed.
//
// The Worker accepted a credential from the `authorization` header OR a
// `?token=` query parameter — the query form is deliberate, because §7 wants a
// Shortcut to be able to call the API through "Get Contents of URL", which
// cannot set headers. The Durable Object behind it read the header and only the
// header. So a request carrying `?token=fwk_` passed the Worker's "this looks
// like a device credential, let the object judge it" check, and arrived at an
// object that saw no credential at all, judged nothing, and answered.
//
// The literal four characters `fwk_` in a URL were therefore full access to the
// fleet: list hosts, send intents, mint enrolment pins, revoke machines.
//
// The bug was not either extraction. Each was reasonable. The bug was that
// "what credential is on this request" was answered twice, so the two answers
// could differ — and the failure mode of that disagreement was silent
// admission rather than a refusal. One function, imported by all three
// coordinators, is the only fix that stays fixed.

/**
 * @param {string|null|undefined} authorization the Authorization header
 * @param {URL|null} [url] for the ?token= form
 * @returns {string} the presented credential, or '' — never null, so callers
 *   cannot accidentally compare undefined against a secret
 */
export function credentialFrom(authorization, url = null) {
  const header = String(authorization || '');
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (bearer) return bearer;
  return url?.searchParams.get('token') || '';
}

/** Does this look like a per-device credential rather than the admin token?
 *  @param {string} presented */
export function isClientCredential(presented) {
  return /^fwk_/.test(String(presented || ''));
}
