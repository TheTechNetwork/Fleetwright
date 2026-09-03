import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const JSON_PATH = new URL('../apps/android/app/google-services.json', import.meta.url);
const SIGNIN_SRC = readFileSync(new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/SignIn.kt', import.meta.url), 'utf8');
// CODE ONLY. The comment in SignIn.kt quotes the exact broken line to explain
// why it is gone, and a tripwire that cannot tell code from prose fires on the
// explanation — which is how a good tripwire gets deleted by whoever it
// annoys first.
const SIGNIN = SIGNIN_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const GRADLE = readFileSync(new URL('../apps/android/app/build.gradle.kts', import.meta.url), 'utf8');
const WRANGLER = readFileSync(new URL('../worker/wrangler.toml', import.meta.url), 'utf8');

/** The web OAuth client — client_type 3. The type 1 entries beside it are the
 *  Android clients, which authorise the request rather than being what the
 *  token is issued for. */
function webClientId() {
  const g = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  for (const client of g.client || []) {
    for (const o of client.oauth_client || []) {
      if (o.client_type === 3) return o.client_id;
    }
  }
  return null;
}

test('the Android config carries a web OAuth client', () => {
  // Without one there is no server client id to name, and Google sign-in is
  // unavailable however the app looks it up.
  assert.notEqual(webClientId(), null);
});

test('the client id is never looked up by application id again', () => {
  // THE BUG THIS FILE EXISTS FOR, and it broke BOTH build types for two
  // unrelated reasons — so fixing either alone leaves it broken:
  //
  //   RELEASE — isShrinkResources. Nothing references the string statically, so
  //   the shrinker strips it. Confirmed in the shipped beta APK.
  //   DEBUG — applicationIdSuffix makes context.packageName differ from the
  //   namespace the resources were compiled under.
  //
  // A resource lookup by name cannot be made safe against the first one, which
  // is why this asserts the lookup is gone rather than that it is correct.
  assert.equal(/getIdentifier\s*\(/.test(SIGNIN), false, 'SignIn.kt is looking up a resource by name again');
  assert.equal(/context\.packageName/.test(SIGNIN), false);
  assert.match(SIGNIN, /BuildConfig\.GOOGLE_WEB_CLIENT_ID/);
  // And the explanation is still there for whoever hits this next.
  assert.match(SIGNIN_SRC, /applicationIdSuffix/);
});

test('resource shrinking stays on, and nothing depends on a resource name', () => {
  // Not a suggestion to turn it off. Shrinking is why the release bundle is a
  // reasonable size, and Play grades the app on it. The lesson is the pairing:
  // with isShrinkResources on, ANY getIdentifier lookup is a resource that may
  // not be there — so the two assertions belong in one test, where somebody
  // adding the next runtime lookup has to read why.
  assert.match(GRADLE, /isShrinkResources = true/);
  assert.equal(/getIdentifier/.test(SIGNIN), false);
});

test('the gradle build reads it and turns buildConfig on', () => {
  // buildConfigField without buildConfig = true generates nothing, and the
  // failure is a compile error in a file nobody wrote.
  assert.match(GRADLE, /buildConfigField\("String", "GOOGLE_WEB_CLIENT_ID"/);
  assert.match(GRADLE, /buildConfig = true/);
  // client_type 3 specifically. Picking the first oauth_client would take an
  // Android client and produce a token the coordinator refuses.
  assert.match(GRADLE, /client_type.*3/);
});

test('the app and the coordinator agree on the audience', () => {
  // `aud` in the ID token is the web client id, and the coordinator verifies
  // it against AGENT_FLEET_AUTH_AUDIENCES. These are two files nobody edits
  // together — a re-downloaded google-services.json with a new client id would
  // leave every Google sign-in refused, with a message about audiences and no
  // hint that a JSON file moved underneath it.
  const id = webClientId();
  const configured = /AGENT_FLEET_AUTH_AUDIENCES\s*=\s*"([^"]*)"/.exec(WRANGLER)?.[1] ?? '';
  assert.equal(
    configured.split(',').map((s) => s.trim()).includes(id),
    true,
    `google-services.json's web client (${id}) is not in AGENT_FLEET_AUTH_AUDIENCES`,
  );
});

test('the null a fork gets is still handled, whatever the compiler believes', () => {
  // Kotlin warns "Unnecessary safe call on a non-null receiver" here, because
  // AGP declares BuildConfig fields non-null. It is wrong: build.gradle.kts
  // emits the literal `null` when there is no google-services.json, which is
  // the whole point — a fork building without Firebase gets a clear refusal at
  // the button rather than a sign-in attempt with an empty client id.
  //
  // Taking the compiler's advice would turn that refusal into a
  // NullPointerException, on exactly the builds nobody here runs. So this pins
  // both halves: Gradle still emits null, and SignIn still treats the field as
  // nullable.
  assert.match(GRADLE, /\?: "null"/, 'gradle no longer emits null for a missing google-services.json');
  assert.match(
    SIGNIN,
    /val configured: String\? = BuildConfig\.GOOGLE_WEB_CLIENT_ID/,
    'SignIn no longer treats the client id as nullable',
  );
  // And the refusal it produces names the build, because this screen has been
  // reported three times about three different causes.
  assert.match(SIGNIN, /Build \$\{BuildConfig\.VERSION_CODE\}/);
});
