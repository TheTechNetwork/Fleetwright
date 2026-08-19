// Push the freshly built bundle to Play's internal testing track.
//
// The counterpart to tools/testflight-distribute.mjs, and deliberately shaped
// the same way: zero dependencies, a service-account JWT, and plain HTTP. Play
// and App Store Connect are more alike than their documentation suggests —
// both want a signed assertion exchanged for a token, and both make you wrap a
// release in a transaction.
//
// The transaction is the part worth knowing. Nothing you do to a Play listing
// takes effect until the edit is committed, so a run that dies halfway leaves
// the track exactly as it was rather than half-updated. That is why this reads
// as create-edit, upload, assign, commit rather than one call.

import { readFile, stat } from 'node:fs/promises';
import { signJwtRS256 } from '../src/fleet/push.js';

const PACKAGE = env('PLAY_PACKAGE_NAME');
const AAB = env('AAB_PATH');
const TRACK = process.env.PLAY_TRACK || 'internal';
const NOTES = (process.env.RELEASE_NOTES || '').trim().slice(0, 500);

/** @param {string} name */
function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** The service account, as JSON or base64 of it — same latitude as push.js. */
function serviceAccount() {
  const raw = env('PLAY_SERVICE_ACCOUNT_JSON').trim();
  const text = raw.startsWith('{') ? raw : new TextDecoder().decode(Uint8Array.from(atob(raw.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));
  const parsed = JSON.parse(text);
  if (!parsed.client_email || !parsed.private_key) throw new Error('service account is missing client_email or private_key');
  return parsed;
}

/** Google's JWT-bearer flow, the same one FCM uses — hence the shared signer. */
async function token() {
  const account = serviceAccount();
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await signJwtRS256(
    {
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    },
    account.private_key,
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).access_token;
}

/** @param {string} bearer @param {string} path @param {RequestInit} [init] */
async function api(bearer, path, init = {}) {
  const res = await fetch(`https://androidpublisher.googleapis.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 500);
    try {
      detail = JSON.parse(body).error?.message || detail;
    } catch {}
    throw new Error(`${init.method || 'GET'} ${path} → ${res.status}\n  ${detail}`);
  }
  return body ? JSON.parse(body) : null;
}

async function main() {
  const size = (await stat(AAB)).size;
  // The account is named up front because every interesting failure here is
  // about WHICH account is asking, and Play's errors never say. "The caller
  // does not have permission" is the same message whether the account was
  // never invited, was invited without app permissions, or belongs to a
  // different project than the one somebody granted.
  console.log(`${AAB} (${(size / 1_048_576).toFixed(1)} MB) → ${PACKAGE} ${TRACK}`);
  console.log(`as ${serviceAccount().client_email}`);
  const bearer = await token();

  const edit = await api(bearer, `/androidpublisher/v3/applications/${PACKAGE}/edits`, { method: 'POST' }).catch(
    (e) => {
      if (!/403|permission/i.test(String(e.message))) throw e;
      throw new Error(
        `${e.message}\n\n` +
          `Play refused ${serviceAccount().client_email} on ${PACKAGE}.\n` +
          'It returns the same 403 for "not invited", "invited without app permissions" and\n' +
          '"no such app", so check in this order:\n' +
          '  1. Play Console -> Users and permissions -> is that exact address listed?\n' +
          '  2. Open it -> App permissions -> the app must have "Release to testing tracks".\n' +
          '     Account-level access alone is not enough.\n' +
          '  3. The package must already be bound to an app record by one manual upload.',
      );
    },
  );
  console.log(`edit ${edit.id}`);

  // Nothing below takes effect until the commit at the end. If this throws,
  // the edit is abandoned by Play and the track is untouched.
  const bundle = await api(
    bearer,
    `/upload/androidpublisher/v3/applications/${PACKAGE}/edits/${edit.id}/bundles?uploadType=media`,
    { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await readFile(AAB) },
  );
  console.log(`uploaded versionCode ${bundle.versionCode}`);

  await api(bearer, `/androidpublisher/v3/applications/${PACKAGE}/edits/${edit.id}/tracks/${TRACK}`, {
    method: 'PUT',
    body: JSON.stringify({
      track: TRACK,
      releases: [
        {
          versionCodes: [String(bundle.versionCode)],
          status: 'completed',
          ...(NOTES ? { releaseNotes: [{ language: 'en-US', text: NOTES }] } : {}),
        },
      ],
    }),
  });

  await api(bearer, `/androidpublisher/v3/applications/${PACKAGE}/edits/${edit.id}:commit`, { method: 'POST' });
  console.log(`committed — versionCode ${bundle.versionCode} is live on ${TRACK}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
