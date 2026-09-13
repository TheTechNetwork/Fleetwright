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
import { readFileSync } from 'node:fs';

import { scrubUrl, scrubEvent, sentryOptions } from '../worker/src/sentry.js';

const CREDENTIAL = 'fwk_9f3a1c2b4d5e6f70_a1b2c3d4e5f60718';

// The iOS reporter, read as text. Several rules below live only in Swift — CI
// compiles it on a macOS runner and nothing here can execute it, so a grep is
// what is available. It cannot prove the SDK does anything; it proves nobody
// deleted the lines that ask it to, which is the failure worth a tripwire.
const iosApp = () =>
  readFileSync(new URL('../apps/ios/Fleetwright/FleetwrightApp.swift', import.meta.url), 'utf8');

// And the Android reporter, which is configured entirely in manifest meta-data
// — there is no Application class and no SentryAndroid.init call. That makes
// the grep below matter MORE than the Swift one: a meta-data key the SDK does
// not recognise is SILENTLY IGNORED. No build error, no runtime error, just a
// replay that never records or a mask that was never asked for.
const androidManifest = () =>
  readFileSync(new URL('../apps/android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');

// One manifest meta-data value, by key name. Returns undefined when the key is
// absent, which is the case the tests below are actually about.
const androidMeta = (key) =>
  androidManifest().match(
    new RegExp(`name="${key.replace(/\./g, '\\.')}"[^/]*?android:value="([^"]*)"`, 's'),
  )?.[1];

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

test('the iOS breadcrumb scrub removes headers rather than marking them', () => {
  // The first version wrote "[redacted]" into the headers key and justified it
  // as "removal would need a second API to guess at". That was an excuse for
  // not looking: setDataValue:forKey: takes a nullable id, and its own
  // implementation says "setValue:forKey: removes the key when value is nil".
  //
  // The difference is worth asserting. A marker is data this app INVENTED and
  // sent to a third party, and the next person reading a breadcrumb has to work
  // out whether Sentry captured a header called "[redacted]" or whether we put
  // it there. Absent is unambiguous.
  const app = iosApp();
  assert.match(app, /crumb\.setData\(value: nil, key: "headers"\)/);
  assert.equal(/setData\(value: "\[redacted\]"/.test(app), false, 'a marker is being invented and sent');
  // And the deprecated setter is gone: "will become read-only in a future
  // release" is a deadline, not an opinion.
  assert.equal(/crumb\.data\?\[[^\]]+\] =/.test(app), false, 'assigning through the deprecated data setter');
});

// SESSION REPLAY, THE ONE THING IN THE REPORTER THAT IS NOT A REFUSAL.
//
// It records the app's screens. That is defensible in an app holding a fleet
// credential for exactly one reason — every text run and image is a rectangle
// before the frame is encoded — and that reason is two lines of configuration.
// Nothing downstream catches it if they go: `beforeSend` never sees a frame.

test('the replay masking switches are written out, not inherited from the SDK', () => {
  const app = iosApp();
  // Both are already the SDK's default. They are written anyway because a
  // default is something a minor version may change and a line is not — and
  // this is the whole of what stands between a replay and the credentials
  // sheet in legible text on somebody else's server.
  assert.match(app, /options\.sessionReplay\.maskAllText = true/);
  assert.match(app, /options\.sessionReplay\.maskAllImages = true/);
  assert.equal(
    /options\.sessionReplay\.maskAll(Text|Images) = false/.test(app),
    false,
    'replay masking has been turned off',
  );
});

test('replay records when something broke, and not otherwise', () => {
  const app = iosApp();
  // The quickstart says sessionSampleRate = 0.1. One session in ten would be a
  // recording of somebody's fleet made with no incident behind it and nothing
  // waiting to read it — the same argument that put the Worker's
  // tracesSampleRate at 0.05 rather than 1.0, landing harder on a phone.
  //
  // Deliberately asserts the VALUE rather than "less than 1". Raising this is a
  // real decision and should have to come through this test, but it is also the
  // line somebody turns up while testing the feature — so the failure names it.
  assert.match(
    app,
    /options\.sessionReplay\.sessionSampleRate = 0\.0/,
    'ambient replay recording is on; see docs/error-reporting.md before changing this',
  );
  // And the half that earns the feature its place: every session that goes
  // wrong is covered.
  assert.match(app, /options\.sessionReplay\.onErrorSampleRate = 1\.0/);
});

test('the replay carries no network detail, because every request is a credential', () => {
  // networkDetailAllowUrls, networkRequestHeaders and networkResponseHeaders
  // attach request and response detail to the replay. This app's every request
  // is an intent to the coordinator with the fleet credential in a header, so
  // unset is the configuration — the same refusal enableNetworkBreadcrumbs
  // makes by another route. A grep is enough: the SDK sends none of it unless
  // one of these names appears.
  const app = iosApp();
  for (const key of ['networkDetailAllowUrls', 'networkRequestHeaders', 'networkResponseHeaders']) {
    // The assignment, not the bare name — the paragraph above the call site
    // names all three in prose so that adding one later is a decision somebody
    // takes rather than a blank they fill in, and a test that broke on its own
    // documentation would just get the documentation deleted.
    const assigned = new RegExp(`options\\.sessionReplay\\.${key}\\s*=`);
    assert.equal(assigned.test(app), false, `${key} is being set on the replay`);
  }
});

test('the still-image attachments stay off, replay or no replay', () => {
  // Replay is masked frames in sequence; these two are a different trade and
  // came out differently. Asserted here so that "we send frames now anyway"
  // cannot quietly become a reason to turn them on.
  const app = iosApp();
  assert.match(app, /options\.attachScreenshot = false/);
  assert.match(app, /options\.attachViewHierarchy = false/);
});

test('the Android replay is configured, with the keys the SDK actually reads', () => {
  // EVERY ONE OF THESE IS A LITERAL FROM SENTRY'S OWN DOCUMENTATION, not a name
  // inferred from the Swift property beside it. docs/error-reporting.md has a
  // section about the three Sentry versions this repository invented and
  // shipped; a manifest key is the same failure with no compiler to catch it,
  // because Android ignores a meta-data name nothing claims.
  assert.equal(androidMeta('io.sentry.session-replay.mask-all-text'), 'true');
  assert.equal(androidMeta('io.sentry.session-replay.mask-all-images'), 'true');
  assert.equal(androidMeta('io.sentry.session-replay.on-error-sample-rate'), '1.0');
  // The quickstart says 0.1. See the iOS test above and the section in
  // docs/error-reporting.md before changing this.
  assert.equal(
    androidMeta('io.sentry.session-replay.session-sample-rate'),
    '0.0',
    'ambient replay recording is on; see docs/error-reporting.md before changing this',
  );
});

test('the Android still-image attachments stay off too', () => {
  assert.equal(androidMeta('io.sentry.attach-screenshot'), 'false');
  assert.equal(androidMeta('io.sentry.attach-view-hierarchy'), 'false');
});

test('the Android DSN is a real one, not the placeholder', () => {
  // It read REPLACE_WITH_ANDROID_DSN for as long as the app had no project to
  // report to, which made every refusal in that manifest theoretical. Turning
  // on a replay for an app that posts nowhere would have been the same joke.
  const dsn = androidMeta('io.sentry.dsn');
  assert.equal(/REPLACE_WITH/.test(dsn ?? ''), false, 'the Android DSN is still a placeholder');
  assert.match(dsn ?? '', /^https:\/\/\w+@o\d+\.ingest\.us\.sentry\.io\/\d+$/);
  // `/0` was the placeholder's project id and is not a project.
  assert.equal(dsn?.endsWith('/0'), false, 'the DSN has no project id');
});

// THE TWO PHONES AGREE, which is the rule this repository spends the most
// effort on. A reporter that is careful on one and not the other is exactly the
// drift test/design-parity.test.js exists for elsewhere — and here the numbers
// live in two files, in two languages, with nothing but this asserting they are
// the same four decisions.
test('iOS and Android record replays on identical terms', () => {
  const swift = iosApp();
  const pairs = [
    ['maskAllText', 'io.sentry.session-replay.mask-all-text'],
    ['maskAllImages', 'io.sentry.session-replay.mask-all-images'],
    ['onErrorSampleRate', 'io.sentry.session-replay.on-error-sample-rate'],
    ['sessionSampleRate', 'io.sentry.session-replay.session-sample-rate'],
  ];
  for (const [swiftName, manifestKey] of pairs) {
    const onIOS = swift.match(
      new RegExp(`options\\.sessionReplay\\.${swiftName} = (\\S+)`),
    )?.[1];
    assert.ok(onIOS, `${swiftName} is not set on iOS at all`);
    assert.equal(
      onIOS,
      androidMeta(manifestKey),
      `${swiftName} and ${manifestKey} disagree — one phone is recording on different terms`,
    );
  }
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
