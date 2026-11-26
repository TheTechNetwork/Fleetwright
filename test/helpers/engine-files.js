// What each engine keeps in a member's engine home once it is signed in, in
// the shape the version the session image pins writes it (docs/engines.md,
// "Credentials"). For every test that plants "a sign-in already there" and
// for the stand-ins that sign in.
//
// WHY ONE PLACE. The tests used to plant `{ "tokens": { "refresh_token": … } }`,
// which is no file either engine writes, and two defects hid behind that:
// the real Codex does not read that file as a sign-in at all, and the real
// one holds a string the made-up one did not, the issuer beside the tokens,
// which the runner then cut out of the page it prints
// (sandbox/engine.mjs, `withhold`).
//
// THE SHAPES ARE SEEN, NOT READ. Codex 0.171.0 was signed in against a
// stand-in for OpenAI on loopback and OpenCode 1.19.6 against one for
// GitHub, with no network, and these are the files they left
// (docs/engines.md, "What has and has not been run"). Every value in them is
// made up.

const b64 = (/** @type {unknown} */ value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Something shaped as a signed token is: three parts, the middle one the
 * claims. Codex reads the claims and never checks the signature, so the last
 * part is free to carry a word a test looks for.
 *
 * @param {Record<string, unknown>} claims @param {string} [signature]
 */
export function fakeJwt(claims, signature = 'c2lnbmF0dXJlLW5vdC1yZWFs') {
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.${signature}`;
}

/**
 * `auth.json` as Codex writes it after a ChatGPT sign-in: the three tokens,
 * who issued them, which login this was, the account, and when it was last
 * renewed.
 *
 * @param {{ refresh?: string, access?: string, signature?: string, email?: string, plan?: string, lastRefresh?: string }} [with_]
 * @returns {string}
 */
export function codexSignIn({ refresh = 'rt-made-up-0123456789abcdef', access, signature, email = 'debbie@example.com', plan = 'plus', lastRefresh = '2026-11-25T10:00:00Z' } = {}) {
  const account = '5f0c0d6e-1111-2222-3333-444455556666';
  const auth = { chatgpt_plan_type: plan, chatgpt_user_id: 'user-made-up-0001', chatgpt_account_id: account };
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt({ email, 'https://api.openai.com/auth': auth }, signature),
      access_token: access ?? fakeJwt({ 'https://api.openai.com/auth': auth, sub: 'made-up' }),
      refresh_token: refresh,
      oauth_provenance: { issuer: 'https://auth.openai.com', client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' },
      login_owner_id: 'o1FZ8b0Pq3mXc7Wd-made-up-login-owner-000000',
      account_id: account,
    },
    last_refresh: lastRefresh,
  }, null, 2);
}

/** OpenCode's entry for GitHub Copilot: GitHub's one token, kept twice, and no expiry. @param {string} token */
export function copilotEntry(token) {
  return { type: 'oauth', access: token, refresh: token, expires: 0 };
}
