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
  // THE BUG THIS FILE EXISTS FOR. `getIdentifier(name, type, context.packageName)`
  // is the line every tutorial has, and it is wrong on any build with an
  // applicationIdSuffix: resources are compiled under the `namespace`, the
  // debug applicationId is namespace + ".debug", so the lookup asks a package
  // with no resources and gets 0. The app then reports "this build has no
  // Google sign-in configured" — a Firebase problem that does not exist.
  //
  // It only fails on the debug build, which is the one a tester is handed.
  assert.equal(/getIdentifier\s*\(/.test(SIGNIN), false, 'SignIn.kt is looking up a resource by name again');
  assert.equal(/context\.packageName/.test(SIGNIN), false);
  assert.match(SIGNIN, /BuildConfig\.GOOGLE_WEB_CLIENT_ID/);
  // And the explanation is still there for whoever hits this next.
  assert.match(SIGNIN_SRC, /applicationIdSuffix/);
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
