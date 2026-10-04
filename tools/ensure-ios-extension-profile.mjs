/**
 * Make sure an app extension has an App Store provisioning profile CI can sign
 * with, and write that profile to disk — with nothing done by hand.
 *
 *   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8=… \
 *   BUNDLE_ID=network.thetech.fleetwright.Activity BUNDLE_NAME='Fleetwright Activity' \
 *   PROFILE_NAME='Fleetwright Activity Profile' CERT_SERIAL=0A1B… OUT=/tmp/activity.mobileprovision \
 *   node tools/ensure-ios-extension-profile.mjs
 *
 * ## Why this exists
 *
 * The app's own profile is a repository secret, made once in the developer
 * portal and installed by ios.yml (docs/ci.md, "Making the profile"). That was
 * fine while there was one bundle id to sign. The Live Activity extension is a
 * second bundle (`<app>.Activity`) and Apple signs every bundle with a profile
 * of its own — so a second profile is needed, and asking the owner to make one
 * by hand, download it, base64 it and paste it into a second secret every time
 * it expires is the manual step this repository keeps declining.
 *
 * Everything the portal would do by hand is an App Store Connect API call, and
 * the workflow already holds the key for that API to upload with. So: register
 * the bundle id if it is missing, find a profile for it that the certificate
 * CI signs with can satisfy, make one if there is none, and hand the bytes to
 * the workflow to install.
 *
 * WHAT THIS DOES NOT DO: mint a certificate. A profile is cheap and
 * replaceable; a distribution certificate is capped per team, and minting one
 * per run is how this project filled its cap once already (docs/ci.md). The
 * certificate is the one imported from APPLE_DIST_P12, and if it is not on the
 * team any more this stops and says so, because the archive would have failed
 * with a worse sentence a minute later.
 *
 * ## What it does
 *
 *   1. Find the bundle id resource, or register it (POST /v1/bundleIds).
 *   2. List every non-expired distribution certificate, and find the one CI
 *      signs with by SERIAL — the serial comes from the keychain the workflow
 *      imported the .p12 into, so it is the certificate that will actually
 *      sign and not whichever the team has. Without CERT_SERIAL, any valid
 *      distribution certificate will do, which is the older tool's behaviour.
 *   3. Reuse an ACTIVE App Store profile for that bundle id that names that
 *      certificate and is not about to expire. Otherwise delete any profile of
 *      PROFILE_NAME (names are unique per team and a profile cannot be edited)
 *      and create one bound to the bundle id and EVERY valid distribution
 *      certificate, as tools/recreate-ios-profile.mjs does and for the same
 *      reason: a revocation of one certificate then leaves the others covering
 *      it.
 *   4. Re-read it, insist it is ACTIVE, and write its bytes to OUT. Its name
 *      and UUID go to stdout for the workflow to pick up.
 *
 * Zero dependencies: ES256 JWT via node:crypto, App Store Connect over fetch.
 * The JWT and the paging are the same as recreate-ios-profile.mjs; kept beside
 * it rather than merged, because that tool deletes on purpose and this one
 * must never delete a profile that is still good.
 */
import { createSign } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const {
  ASC_KEY_ID,
  ASC_ISSUER_ID,
  ASC_KEY_P8,
  BUNDLE_ID = 'network.thetech.fleetwright.Activity',
  // The portal's display name for the bundle id, if this has to register it.
  // Letters, digits and spaces only: Apple refuses a dot here.
  BUNDLE_NAME = 'Fleetwright Activity',
  PROFILE_NAME = 'Fleetwright Activity Profile',
  PROFILE_TYPE = 'IOS_APP_STORE',
  // The serial of the certificate CI imported, from `openssl x509 -serial`.
  // Optional; see step 2.
  CERT_SERIAL = '',
  OUT = '',
} = process.env;

// Apple Distribution (iOS + macOS) and the legacy iOS-only kind; a team can
// hold both and either signs an iOS App Store build.
const DISTRIBUTION_CERT_TYPES = new Set(['DISTRIBUTION', 'IOS_DISTRIBUTION']);

// A profile that expires within the month is replaced now rather than on the
// day it fails: the replacement costs nothing and the failure costs a release.
const RENEW_WITHIN_MS = 30 * 24 * 60 * 60_000;

const API = 'https://api.appstoreconnect.apple.com';

function token() {
  const b64u = (/** @type {string|Buffer} */ b) => Buffer.from(b).toString('base64url');
  const header = b64u(JSON.stringify({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${payload}`);
  // `ieee-p1363` is the raw r||s form JWS requires; node's default DER
  // encoding surfaces as a bare 401.
  const sig = signer.sign({ key: /** @type {string} */ (ASC_KEY_P8), dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${sig.toString('base64url')}`;
}

/** @param {string} path @param {RequestInit} [init] */
async function asc(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

/** Every page of a listing, with its `included` resources kept. @param {string} path */
async function ascAll(path) {
  /** @type {any[]} */
  const data = [];
  /** @type {any[]} */
  const included = [];
  let next = `${API}${path}`;
  while (next) {
    const res = await fetch(next, { headers: { authorization: `Bearer ${token()}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${next} -> ${res.status} ${text}`);
    const page = JSON.parse(text);
    data.push(...(page.data ?? []));
    included.push(...(page.included ?? []));
    next = page.links?.next ?? null;
  }
  return { data, included };
}

/** Serials compared as Apple and OpenSSL each write them: upper hex, no leading zeros. @param {string} s */
const serial = (s) => String(s || '').replace(/^serial=/i, '').replace(/[^0-9a-fA-F]/g, '').replace(/^0+/, '').toUpperCase();

function requireEnv() {
  const missing = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8', 'OUT'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`missing required env: ${missing.join(', ')}`);
}

async function main() {
  requireEnv();

  // 1. The bundle id, registered if the team has never seen it. The filter is
  // a search, not an exact match, so the exact identifier is picked out here.
  let bundle = (await ascAll(`/v1/bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}&limit=200`)).data
    .find((b) => b.attributes?.identifier === BUNDLE_ID);
  if (!bundle) {
    const made = await asc('/v1/bundleIds', {
      method: 'POST',
      body: JSON.stringify({
        data: { type: 'bundleIds', attributes: { identifier: BUNDLE_ID, name: BUNDLE_NAME, platform: 'IOS' } },
      }),
    });
    bundle = made.data;
    console.log(`registered bundle id ${BUNDLE_ID} (${bundle?.id})`);
  } else {
    console.log(`bundle id: ${BUNDLE_ID} (${bundle.id})`);
  }
  if (!bundle?.id) throw new Error(`App Store Connect returned no bundle id for ${BUNDLE_ID}`);

  // 2. The certificates, and the one that will sign.
  const now = Date.now();
  const certs = (await ascAll('/v1/certificates?limit=200')).data.filter((c) => {
    if (!DISTRIBUTION_CERT_TYPES.has(c.attributes?.certificateType)) return false;
    const exp = Date.parse(c.attributes?.expirationDate ?? '');
    return !Number.isFinite(exp) || exp > now;
  });
  if (!certs.length) {
    throw new Error(
      'no valid distribution certificate on the team, so there is nothing to bind a profile to. ' +
        'Import the shared one (APPLE_DIST_P12); do NOT mint another — docs/ci.md says why.',
    );
  }
  const wanted = serial(CERT_SERIAL);
  const signer = wanted ? certs.find((c) => serial(c.attributes?.serialNumber) === wanted) : null;
  if (wanted && !signer) {
    throw new Error(
      `the certificate CI imported (serial ${wanted}) is not a valid distribution certificate on this team any more. ` +
        'Signing would fail with it whatever profile existed: it was revoked or has expired, and APPLE_DIST_P12 ' +
        'needs the certificate the team still has.',
    );
  }
  for (const c of certs) {
    const mark = signer && c.id === signer.id ? ' (CI signs with this one)' : '';
    console.log(`  cert ${c.id} ${c.attributes?.certificateType} serial ${serial(c.attributes?.serialNumber)} expires ${c.attributes?.expirationDate ?? '?'}${mark}`);
  }

  // 3. A profile that already does the job. `include` makes each profile
  // carry the ids of its bundle id and certificates, which is how "for this
  // bundle, signed by that certificate" is answered without a request per
  // profile.
  const listing = await ascAll(`/v1/profiles?filter[profileType]=${PROFILE_TYPE}&include=bundleId,certificates&limit=200`);
  const forBundle = listing.data.filter((p) => p.relationships?.bundleId?.data?.id === bundle.id);
  const usable = forBundle.find((p) => {
    if (p.attributes?.profileState !== 'ACTIVE') return false;
    const exp = Date.parse(p.attributes?.expirationDate ?? '');
    if (Number.isFinite(exp) && exp - now < RENEW_WITHIN_MS) return false;
    const bound = new Set((p.relationships?.certificates?.data ?? []).map((/** @type {any} */ c) => c.id));
    // With a known signer the profile has to name it; without one, any valid
    // certificate it names will do, since any of them could be the .p12's.
    return signer ? bound.has(signer.id) : certs.some((c) => bound.has(c.id));
  });

  let profile = usable;
  if (profile) {
    console.log(`reusing profile '${profile.attributes?.name}' (${profile.id}), expires ${profile.attributes?.expirationDate}`);
  } else {
    // Nothing fits: the name has to be free before the create, because Apple
    // keys profiles by name. Only a profile of OUR name is removed — one the
    // owner made by hand under another name is left exactly as it is, since
    // it is theirs and it was not good enough only by this tool's rules.
    for (const p of listing.data.filter((p) => p.attributes?.name === PROFILE_NAME)) {
      console.log(`deleting profile '${PROFILE_NAME}' (${p.id}, was ${p.attributes?.profileState}, expires ${p.attributes?.expirationDate})`);
      await asc(`/v1/profiles/${p.id}`, { method: 'DELETE' });
    }
    const created = await asc('/v1/profiles', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'profiles',
          attributes: { name: PROFILE_NAME, profileType: PROFILE_TYPE },
          relationships: {
            bundleId: { data: { type: 'bundleIds', id: bundle.id } },
            certificates: { data: certs.map((c) => ({ type: 'certificates', id: c.id })) },
          },
        },
      }),
    });
    profile = created.data;
    console.log(`created profile '${PROFILE_NAME}' (${profile?.id}) bound to ${certs.length} distribution cert(s)`);
  }
  if (!profile?.id) throw new Error('App Store Connect returned no profile');

  // 4. Read it back: the state is the proof, not the 201, and the content is
  // the thing the workflow installs.
  const check = (await asc(`/v1/profiles/${profile.id}`)).data;
  const state = check?.attributes?.profileState;
  if (state !== 'ACTIVE') throw new Error(`profile '${check?.attributes?.name}' is ${state}, expected ACTIVE`);
  const content = check?.attributes?.profileContent;
  if (!content) throw new Error(`profile '${check?.attributes?.name}' came back without its content`);
  writeFileSync(OUT, Buffer.from(content, 'base64'));
  console.log(`profile: ${check.attributes.name} (${check.attributes.uuid})`);
  console.log(`expires: ${check.attributes.expirationDate}`);
  console.log(`wrote ${OUT}`);
  console.log(`::notice::'${check.attributes.name}' is ACTIVE for ${BUNDLE_ID}.`);
}

main().catch((e) => {
  process.stderr.write(`ensure-ios-extension-profile: ${e.message}\n`);
  process.exit(1);
});
