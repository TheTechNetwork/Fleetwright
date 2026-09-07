// Screenshots, uploaded from the repository instead of dragged into a browser.
//
// THE LAST FULLY MANUAL STAGE. The pipeline builds, signs, uploads, distributes
// to testers, writes the listing and submits for review; screenshots were the
// one thing left that needed somebody at a laptop with a file picker. They are
// also the worst one to leave manual: they are per device size AND per locale,
// Apple refuses a version missing any required size, and it refuses them all at
// once in the longest message it sends.
//
// ONLY ON A FULL RELEASE, and only if needed. Uploading images is slow, and
// nothing about a TestFlight build wants a store page. So this runs where
// appstore-release.mjs runs — a published, non-prerelease release — and it
// SKIPS a display type that already has screenshots rather than replacing them.
// Re-uploading identical bytes on every release would be minutes of nothing,
// and worse, a window where the store has fewer screenshots than it did.
//
// THE UPLOAD IS THREE STEPS AND A CHECKSUM, which is the whole reason this file
// exists rather than a curl:
//
//   1. POST /v1/appScreenshots   reserves the asset and answers with
//                                uploadOperations — a list of byte RANGES with
//                                their own URLs and headers
//   2. PUT each operation        the bytes for that range, to Apple's storage
//   3. PATCH the screenshot      uploaded: true, plus the MD5 of the file
//
// Step 3 is what makes it real. Without the checksum Apple accepts the bytes
// and leaves the asset in a state that never becomes usable, and the version
// is refused later for a screenshot that looks present.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

// NOTHING IS READ FROM THE ENVIRONMENT AT MODULE LEVEL, because
// appstore-release.mjs IMPORTS this — it owns the ordering, since screenshots
// have to be attached BEFORE the version is submitted or the submission is
// refused for missing them. A module that threw on `import` for want of a
// variable the importer already has would take the release with it.
//
/** Where the images live, one directory per Apple display type. */
export const DEFAULT_DIR = 'apps/ios/store/screenshots';

/** @param {string} name */
function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function token(KEY_ID, ISSUER_ID, PRIVATE_KEY) {
  const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const claim = { iss: ISSUER_ID, iat, exp: iat + 20 * 60, aud: 'appstoreconnect-v1' };
  const pkcs8 = PRIVATE_KEY.replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(pkcs8), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

/** @param {string|Uint8Array} input */
function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** An api() bound to one set of credentials, for standalone runs. */
function apiFor(KEY_ID, ISSUER_ID, PRIVATE_KEY) {
  return async function api(/** @type {string} */ p, /** @type {RequestInit} */ init = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await token(KEY_ID, ISSUER_ID, PRIVATE_KEY)}`,
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body);
      detail = (parsed.errors || []).map((/** @type {any} */ e) => `${e.title}: ${e.detail}`).join('\n  ') || detail;
    } catch {}
    throw new Error(`${init.method || 'GET'} ${p} → ${res.status}\n  ${detail}`);
  }
  return JSON.parse(body);
  };
}

/**
 * Upload one image and mark it complete.
 *
 * THE RANGES ARE APPLE'S, NOT OURS. `uploadOperations` may split a file into
 * several parts with their own offsets and headers, and honouring that is the
 * difference between an asset that becomes usable and one that sits in
 * UPLOAD_COMPLETE for ever.
 */
async function upload(api, setId, file) {
  const bytes = readFileSync(file);
  const name = path.basename(file);
  const created = await api('/v1/appScreenshots', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'appScreenshots',
        attributes: { fileSize: bytes.length, fileName: name },
        relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: setId } } },
      },
    }),
  });

  const id = created.data.id;
  for (const op of created.data.attributes.uploadOperations || []) {
    /** @type {Record<string, string>} */
    const headers = {};
    for (const h of op.requestHeaders || []) headers[h.name] = h.value;
    const res = await fetch(op.url, {
      method: op.method || 'PUT',
      headers,
      body: bytes.subarray(op.offset, op.offset + op.length),
    });
    if (!res.ok) throw new Error(`uploading ${name} → ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  }

  // MD5, WHICH IS APPLE'S CHOICE AND NOT A SECURITY CLAIM. It is how the
  // service checks it received what was reserved; without it the asset never
  // becomes usable and the version is refused later for a screenshot that
  // looks present.
  await api(`/v1/appScreenshots/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      data: {
        type: 'appScreenshots',
        id,
        attributes: { uploaded: true, sourceFileChecksum: createHash('md5').update(bytes).digest('hex') },
      },
    }),
  });
  return name;
}

/**
 * Attach the screenshots in `dir` to one localisation.
 *
 * @param {object} o
 * @param {(p: string, init?: RequestInit) => Promise<any>} o.api
 * @param {string} o.localizationId  the en-US appStoreVersionLocalization
 * @param {string} [o.dir]
 * @param {boolean} [o.force]        replace what is already there
 * @returns {Promise<number>} how many images were uploaded
 */
export async function uploadScreenshots({ api, localizationId, dir = DEFAULT_DIR, force = false }) {
  if (!existsSync(dir)) {
    // NOT A FAILURE. There are no iOS screenshots in the repository yet, and a
    // release must not stop for want of a directory that is somebody else's
    // next piece of work.
    console.log(`no ${dir} — no screenshots to upload`);
    return 0;
  }

  // One directory per Apple display type: APP_IPHONE_69, APP_IPHONE_65,
  // APP_IPAD_PRO_3GEN_129 and so on. The directory name IS the display type,
  // so adding a size is a folder rather than a code change.
  const types = readdirSync(dir).filter((d) => statSync(path.join(dir, d)).isDirectory());
  if (!types.length) {
    console.log(`no display-type directories under ${dir} — no screenshots to upload`);
    return 0;
  }

  const sets = await api(`/v1/appStoreVersionLocalizations/${localizationId}/appScreenshotSets?limit=50`);
  let uploaded = 0;

  for (const type of types) {
    const files = readdirSync(path.join(dir, type))
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
      // SORTED, because the order on the store page is the order they arrive
      // in, and readdir's order is the filesystem's. The names carry the
      // sequence — phone-01, phone-02 — for exactly this reason.
      .sort();
    if (!files.length) continue;

    let set = (sets.data || []).find((/** @type {any} */ s) => s.attributes.screenshotDisplayType === type);
    if (set && !force) {
      const existing = await api(`/v1/appScreenshotSets/${set.id}/appScreenshots?limit=1`);
      if ((existing.data || []).length) {
        // IF NEEDED. Re-uploading identical bytes on every release is minutes
        // of nothing, and worse: a window where the store has fewer
        // screenshots than it did a moment ago.
        console.log(`${type}: already has screenshots — left alone (SCREENSHOTS_FORCE=true to replace)`);
        continue;
      }
    }

    if (!set) {
      const made = await api('/v1/appScreenshotSets', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'appScreenshotSets',
            attributes: { screenshotDisplayType: type },
            relationships: {
              appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: localizationId } },
            },
          },
        }),
      });
      set = made.data;
    }

    for (const f of files) {
      console.log(`${type}: uploaded ${await upload(api, set.id, path.join(dir, type, f))}`);
      uploaded++;
    }
  }
  return uploaded;
}

/** Standalone: find the version and its en-US localisation, then upload. */
async function main() {
  const api = apiFor(env('ASC_KEY_ID'), env('ASC_ISSUER_ID'), env('ASC_KEY_P8'));
  const bundleId = env('BUNDLE_ID');
  const versionString = env('VERSION_STRING');

  const apps = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
  const app = apps.data[0];
  if (!app) throw new Error(`no app record for ${bundleId}`);

  const versions = await api(
    `/v1/apps/${app.id}/appStoreVersions?filter[versionString]=${encodeURIComponent(versionString)}&filter[platform]=IOS&limit=1`,
  );
  const version = versions.data[0];
  if (!version) throw new Error(`no App Store version ${versionString} — appstore-release.mjs creates it`);

  const locs = await api(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`);
  const en = locs.data.find((/** @type {any} */ l) => l.attributes.locale === 'en-US');
  if (!en) {
    console.log('no en-US localization on the version — nothing to attach screenshots to');
    return;
  }

  await uploadScreenshots({
    api,
    localizationId: en.id,
    dir: process.env.SCREENSHOTS_DIR || DEFAULT_DIR,
    force: process.env.SCREENSHOTS_FORCE === 'true',
  });
}

// Only when run directly. Imported by appstore-release.mjs, which owns the
// ordering — screenshots must be attached BEFORE the version is submitted.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
