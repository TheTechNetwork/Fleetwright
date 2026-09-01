// What the error reporter is allowed to send.
//
// An error reporter's whole job is to copy request context to a third party, and
// this coordinator carries a credential on nearly every request — including one
// IN THE QUERY STRING, deliberately, because a Shortcut calls it through "Get
// Contents of URL" and cannot set headers.
//
// Keeping a secret out of this fleet's own journal (src/core/redact.js) and then
// posting it to sentry.io would be the same bug with a longer flight. These
// tests are the tripwire for that, and they are deliberately blunt: they take
// the real strings the real routes carry and assert none of them survive.

import test from 'node:test';
import assert from 'node:assert/strict';

import { scrubUrl, scrubEvent, sentryOptions } from '../worker/src/sentry.js';

const CREDENTIAL = 'fwk_9f3a1c2b4d5e6f70_a1b2c3d4e5f60718';

test('a credential in the query string does not survive', () => {
  // openapi.json: "A credential may arrive as Authorization: Bearer <token> OR
  // as ?token=<token>. The query form is deliberate."
  const scrubbed = scrubUrl(`https://fleet.example/api/intent?token=${CREDENTIAL}&host=deb132`);
  assert.equal(scrubbed.includes(CREDENTIAL), false);
  // And the useful part is kept, or the report is not worth sending.
  assert.match(scrubbed, /\/api\/intent/);
  assert.match(scrubbed, /host=deb132/);
});

test('an unknown parameter is dropped rather than kept', () => {
  // ALLOWLIST, NOT DENYLIST. `token` is the one that exists today; the rule has
  // to survive the next parameter somebody adds without remembering this file.
  const scrubbed = scrubUrl('https://fleet.example/x?apiKey=sk-live-abcdef&pin=421337');
  assert.equal(scrubbed.includes('sk-live-abcdef'), false);
  assert.equal(scrubbed.includes('421337'), false);
});

test('a malformed url does not throw on the error path', () => {
  // This runs while something is already going wrong. Throwing here would turn
  // a reportable error into an unreportable one.
  assert.equal(scrubUrl('not a url'), '[unparseable url]');
  assert.equal(scrubUrl(/** @type {any} */ (undefined)), '[unparseable url]');
});

test('headers, cookies and bodies never leave', () => {
  const event = scrubEvent({
    request: {
      url: `https://fleet.example/oauth/token?token=${CREDENTIAL}`,
      headers: { authorization: `Bearer ${CREDENTIAL}`, cookie: 'session=abc' },
      cookies: { session: 'abc' },
      // /oauth/token carries an authorization code and its PKCE verifier;
      // /api/session carries an Apple or Google ID token; /api/intent carries
      // `link github <token>`.
      data: { code: 'abc123', code_verifier: 'dBjftJeZ4CVP', idToken: 'eyJhbGciOi' },
      query_string: `token=${CREDENTIAL}`,
    },
    user: { email: 'eli@example.com', ip_address: '1.2.3.4' },
  });

  const flat = JSON.stringify(event);
  for (const secret of [CREDENTIAL, 'Bearer', 'session=abc', 'abc123', 'dBjftJeZ4CVP', 'eyJhbGciOi']) {
    assert.equal(flat.includes(secret), false, `${secret} reached the payload`);
  }
  // NO USER AT ALL. An email is the identity this fleet's allowlists are built
  // on, and a third party has no need of it to tell you a Worker threw.
  assert.equal(flat.includes('eli@example.com'), false);
  assert.equal(flat.includes('1.2.3.4'), false);
});

test('breadcrumbs are scrubbed too, because outbound calls carry the credential', () => {
  // The coordinator's own outbound fetches are intents, and an intent carries
  // the caller's credential. A breadcrumb recording one is the same leak by a
  // quieter route.
  const event = scrubEvent({
    breadcrumbs: [
      { category: 'fetch', data: { url: `https://fleet.example/api/intent?token=${CREDENTIAL}`, headers: { authorization: 'Bearer x' } } },
    ],
  });
  const flat = JSON.stringify(event);
  assert.equal(flat.includes(CREDENTIAL), false);
  assert.equal(flat.includes('authorization'), false);
});

test('no DSN means no reporting, with no second code path', () => {
  // A fresh clone, a contributor's `wrangler dev`, and a self-hosted fleet all
  // run this unchanged and must post nowhere. Sentry treats an absent DSN as
  // disabled, so this stays one path rather than an `if` somebody can get wrong.
  assert.equal(sentryOptions({}).dsn, undefined);
  assert.equal(sentryOptions({ SENTRY_DSN: '' }).dsn, undefined);
  assert.equal(sentryOptions({ SENTRY_DSN: 'https://k@o1.ingest.sentry.io/2' }).dsn, 'https://k@o1.ingest.sentry.io/2');
});

test('the data-collection switches are off, and the sample rate is not 1.0', () => {
  const opts = sentryOptions({});
  // The two the SDK turns on for you.
  assert.equal(opts.dataCollection.userInfo, false);
  assert.deepEqual(opts.dataCollection.httpBodies, []);
  assert.equal(opts.sendDefaultPii, false);
  // The quickstart says 1.0. Every host sends a health frame every fifteen
  // seconds and every phone polls; tracing all of it spends the quota an actual
  // incident needs.
  assert.ok(opts.tracesSampleRate < 1, 'tracing every request on this fleet is noise, not data');
  assert.equal(sentryOptions({ SENTRY_TRACES_SAMPLE_RATE: '0.5' }).tracesSampleRate, 0.5);
});

test('the hooks are wired, not merely defined', () => {
  // scrubEvent could be perfect and never called. beforeSend and
  // beforeSendTransaction are the only two places it runs.
  const opts = sentryOptions({});
  const dirty = () => ({ request: { url: `https://fleet.example/?token=${CREDENTIAL}`, headers: { a: 'b' } } });
  for (const hook of ['beforeSend', 'beforeSendTransaction']) {
    const out = JSON.stringify(opts[hook](dirty()));
    assert.equal(out.includes(CREDENTIAL), false, `${hook} did not scrub`);
    assert.equal(out.includes('headers'), false, `${hook} kept headers`);
  }
  const crumb = opts.beforeBreadcrumb({ data: { url: `https://x.example/?token=${CREDENTIAL}` } });
  assert.equal(JSON.stringify(crumb).includes(CREDENTIAL), false);
});
