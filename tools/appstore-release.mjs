// Put the build that was just uploaded in front of the App Store, not just
// TestFlight.
//
// The third sibling: testflight-distribute.mjs hands a build to testers,
// play-release.mjs pushes the Android bundle to a Play track, and this one
// creates the App Store version, attaches the build to it, and submits it for
// App Review. Deliberately the same shape as both — zero dependencies, an
// ES256 JWT, plain HTTP — because the App Store Connect API is the same API
// TestFlight distribution already talks to; production is more requests, not
// a different protocol.
//
// What this CANNOT do is finish a listing. The description, screenshots,
// category, privacy answers and age rating are set once by hand in App Store
// Connect — the API can carry them, but they are decisions, and the first
// submission of a new app fails politely at the PATCH below until somebody
// has made them. See docs/ci.md for the once-ever checklist.
//
// Runs on ubuntu: it is HTTP and a JWT, and Apple's review queue moves at the
// same speed whatever runner waits for it — which is why nothing here waits
// for review at all. Submission is the delivery; approval is Apple's.

import { storeListing } from './store-listing.mjs';

const KEY_ID = env('ASC_KEY_ID');
const ISSUER_ID = env('ASC_ISSUER_ID');
const PRIVATE_KEY = env('ASC_KEY_P8');
const BUNDLE_ID = env('BUNDLE_ID');
const BUILD_NUMBER = env('BUILD_NUMBER');
// The public release notes. 4000 characters is Apple's limit for whatsNew;
// truncated rather than rejected, because long notes are not a reason to fail
// a shipment. Unlike TestFlight's beta notes, the App Store field accepts
// emoji, so nothing is stripped — these are the words somebody wrote for the
// listing, and they should arrive as written.
const WHATS_NEW = (process.env.WHATS_NEW || '').trim().slice(0, 4000);

// Same ceiling as testflight-distribute.mjs, same reason: processing has no
// deadline and nothing on this side can hurry it.
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 45 * 60_000);
const POLL_INTERVAL_MS = 30_000;

// The one state a version can be edited and submitted in, plus the states a
// rejection leaves behind. Anything else is either on its way to the store
// (resubmitting would be double-shipping) or already ON the store (the fix is
// a new MARKETING_VERSION, not a louder push of the old one).
const EDITABLE = new Set([
  'PREPARE_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);

/** @param {string} name */
function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** A short-lived ES256 assertion — same construction as testflight-distribute.mjs. */
async function token() {
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

/** @param {string} path @param {RequestInit} [init] */
async function api(path, init = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 204) return null;
  const body = await res.text();
  if (!res.ok) {
    let detail = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body);
      detail = (parsed.errors || []).map((/** @type {any} */ e) => `${e.title}: ${e.detail}`).join('\n  ') || detail;
    } catch {}
    throw new Error(`${init.method || 'GET'} ${path} → ${res.status}\n  ${detail}`);
  }
  return JSON.parse(body);
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * What is missing from the listing, before anything is created.
 *
 * WHY THIS RUNS FIRST. Everything below it writes: it creates an App Store
 * version, attaches a build, sets the release notes, and only THEN asks Apple
 * to accept it — which is where an incomplete listing refuses, attribute by
 * attribute, in Apple's words. So the first submission of a new app left a
 * half-built version behind and a raw refusal in the log, and the answer was a
 * line of prose pointing at a checklist in docs/ci.md.
 *
 * None of this is fixable from here — nothing in this repository can supply a
 * screenshot or a privacy answer — which is exactly why it should be reported
 * BEFORE the writes rather than discovered after them. A refusal that names
 * every missing thing at once, before touching anything, is a list somebody can
 * work through. Four rounds of "and also…" is not.
 *
 * READ-ONLY, and it never throws on its own account: an API shape that changed,
 * or a permission this key does not have, must not stop a release that would
 * otherwise have gone out. It is a better error message, not a new gate.
 *
 * @returns {Promise<string[]>} human-readable descriptions of what is missing
 */
async function listingGaps(appId, versionString) {
  const gaps = [];
  try {
    // The primary locale's own text. Absent here is the commonest first-time
    // failure, and the one that reads worst afterwards: Apple complains about
    // `description` on a version this script just created.
    const infos = await api(`/v1/apps/${appId}/appInfos?limit=1`);
    const info = infos.data?.[0];
    if (info) {
      const cat = info.relationships?.primaryCategory?.data;
      if (!cat) gaps.push('no primary category');
      // ageRatingDeclaration is a relationship; its absence is the age rating
      // never having been answered.
      const rating = info.relationships?.ageRatingDeclaration?.data;
      if (!rating) gaps.push('the age rating questionnaire has not been answered');
    }

    // The version's localisations carry description, keywords and support URL.
    // Checked against the version if it exists, and against the app's newest
    // otherwise — on a first run there is no version yet, which is not a gap.
    const versions = await api(
      `/v1/apps/${appId}/appStoreVersions?filter[versionString]=${encodeURIComponent(versionString)}&filter[platform]=IOS&limit=1`,
    );
    const v = versions.data?.[0];
    if (v) {
      const locs = await api(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations?limit=50`);
      const primary = locs.data?.[0];
      if (!primary) {
        gaps.push('no localisation on this version — description and keywords are unset');
      } else {
        const a = primary.attributes || {};
        if (!a.description) gaps.push(`no description for ${a.locale || 'the primary locale'}`);
        if (!a.keywords) gaps.push(`no keywords for ${a.locale || 'the primary locale'}`);
        if (!a.supportUrl) gaps.push('no support URL');
        // SCREENSHOTS ARE PER LOCALISATION, and a version with none is refused
        // for every device size at once — the longest and least readable of
        // Apple's refusals.
        const sets = await api(`/v1/appStoreVersionLocalizations/${primary.id}/appScreenshotSets?limit=10`);
        if (!(sets.data || []).length) gaps.push('no screenshots on this version');
      }
    }
  } catch (e) {
    // NOT A FAILURE. See above: this is a better message, not a new gate.
    console.log(`::debug::could not pre-check the listing (${String(e.message).split('\n')[0]})`);
    return [];
  }
  return gaps;
}

async function main() {
  const apps = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`);
  const app = apps.data[0];
  if (!app) throw new Error(`no app record for ${BUNDLE_ID} — create it in App Store Connect first`);
  console.log(`app ${app.attributes.name} (${app.id})`);

  // The build, waited for like TestFlight waits for it — "version" here is
  // the build number. include=preReleaseVersion rides along because the
  // version TRAIN on the build (its preReleaseVersion) is the marketing
  // version the archive was stamped with. Read from the build rather than
  // parsed out of project.yml, so the App Store version created below is the
  // one the binary actually claims — the two cannot drift, because one is
  // derived from the other.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let build = null;
  let versionString = '';
  for (;;) {
    const found = await api(
      `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(BUILD_NUMBER)}&include=preReleaseVersion&limit=1`,
    );
    build = found.data[0];
    const state = build?.attributes?.processingState;
    if (state === 'VALID') {
      versionString = found.included?.find((/** @type {any} */ i) => i.type === 'preReleaseVersions')?.attributes?.version || '';
      break;
    }
    if (state === 'FAILED' || state === 'INVALID') throw new Error(`build ${BUILD_NUMBER} is ${state}`);
    if (Date.now() > deadline) {
      // NOT A FAILURE, for the same reason as in testflight-distribute.mjs:
      // the upload already succeeded and Apple's queue answers to nobody.
      // This job is idempotent, so the recovery is one click.
      const waited = Math.round(POLL_TIMEOUT_MS / 60_000);
      console.log(
        `\n::warning::Build ${BUILD_NUMBER} uploaded but was still ${state || 'not visible'} after ${waited} minutes.\n` +
          'Nothing is wrong with it — App Store Connect processing has no deadline. Re-run this\n' +
          'job once the build shows up in App Store Connect and it will pick up where it left off.',
      );
      process.exit(0);
    }
    console.log(build ? `build ${BUILD_NUMBER} is ${state}, waiting…` : `build ${BUILD_NUMBER} not visible yet, waiting…`);
    await sleep(POLL_INTERVAL_MS);
  }
  if (!versionString) throw new Error(`build ${BUILD_NUMBER} has no version train — cannot name an App Store version`);
  console.log(`build ${BUILD_NUMBER} is VALID (${build.id}), version ${versionString}`);

  // WHAT THE LISTING IS MISSING, SAID BEFORE ANYTHING IS WRITTEN. Everything
  // below this line creates or changes something in App Store Connect, and the
  // refusal for an incomplete listing arrives at the very END — after a version
  // exists, a build is attached and notes are set. One list, up front, beats
  // four rounds of Apple saying "and also".
  const gaps = await listingGaps(app.id, versionString);
  if (gaps.length) {
    console.log('::warning::this listing is not finished, and App Review will refuse it:');
    for (const g of gaps) console.log(`::warning::  - ${g}`);
    console.log('::warning::none of these can be set from here — the once-ever checklist is in docs/ci.md');
  }

  // The App Store version: found if it exists, created if not. Found-first is
  // what makes a re-run safe, and it is also how a version Apple rejected gets
  // a second build — the rejected version is EDITABLE, so it is reused rather
  // than duplicated.
  const versions = await api(
    `/v1/apps/${app.id}/appStoreVersions?filter[versionString]=${encodeURIComponent(versionString)}&filter[platform]=IOS&limit=1`,
  );
  let version = versions.data[0];
  const vstate = version?.attributes?.appVersionState || version?.attributes?.appStoreState;
  if (version && !EDITABLE.has(vstate)) {
    // Not editable is not one situation, and the two it splits into get
    // opposite answers. Already in the pipeline (waiting, in review, pending
    // release) means the work this run would do is DONE — a green exit,
    // because a re-run of a release must not fail for having worked the first
    // time. Already public means the version string is spent, and the only
    // fix is a bump in project.yml — said here by name, because the API's own
    // error for it is a generic 409.
    if (vstate === 'READY_FOR_SALE' || vstate === 'REPLACED_WITH_NEW_VERSION') {
      throw new Error(
        `version ${versionString} is already on the App Store (${vstate}) — bump MARKETING_VERSION in apps/ios/project.yml and publish a new release`,
      );
    }
    console.log(`version ${versionString} is ${vstate} — already submitted, nothing to do`);
    return;
  }
  if (!version) {
    // AFTER_APPROVAL, not MANUAL: approved means released, with no third state
    // where a green pipeline and an unshipped app are both true. The same
    // choice play-release.mjs makes by not defaulting to a staged rollout —
    // a shipment the pipeline cannot finish is a shipment it should not start.
    const created = await api('/v1/appStoreVersions', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'appStoreVersions',
          attributes: { platform: 'IOS', versionString, releaseType: 'AFTER_APPROVAL' },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      }),
    });
    version = created.data;
    console.log(`created App Store version ${versionString} (${version.id})`);
  } else {
    console.log(`reusing App Store version ${versionString} (${version.id}, ${vstate})`);
  }

  // The build, attached. On a reused version this replaces whatever build was
  // there, which is the point: the newest release run owns the version.
  await api(`/v1/appStoreVersions/${version.id}/relationships/build`, {
    method: 'PATCH',
    body: JSON.stringify({ data: { type: 'builds', id: build.id } }),
  });
  console.log(`build ${BUILD_NUMBER} attached to ${versionString}`);

  // "What's New in This Version" — the public one, on the listing. Apple
  // refuses the field on an app's FIRST version (there is nothing it is newer
  // than), and that refusal must not sink the submission: notes are a nicety,
  // the version is the delivery.
  // THE LISTING ITSELF, FROM THE DOCUMENT SOMEBODY WROTE — not only the notes.
  //
  // The description and the promotional text lived in apps/store-listing.md,
  // reviewed in pull requests, and were then retyped into a web console. So the
  // pipeline built, signed, uploaded, distributed and submitted without a human
  // touching anything, and stopped one step short of the words on the page —
  // which is exactly where a listing goes stale, because nobody re-pastes a
  // description they only changed slightly.
  //
  // WRITTEN TOGETHER WITH whatsNew, in one PATCH, because they are one object
  // and two requests would leave a version half-updated when the second failed.
  /** @type {Record<string, string>} */
  const attributes = {};
  if (WHATS_NEW) attributes.whatsNew = WHATS_NEW;
  try {
    const listing = storeListing();
    attributes.description = listing.full;
    // The short description is Play's field; on the App Store the equivalent
    // slot is promotional text, which is the one thing editable WITHOUT a new
    // version — so the same sentence lands in the place it belongs on each
    // store rather than being invented twice.
    attributes.promotionalText = listing.short;
  } catch (e) {
    // A LISTING THAT CANNOT BE READ IS NOT A REASON TO DROP A RELEASE. The copy
    // already on the store is what stays, and it says so.
    console.log(`::warning::store listing not applied: ${String(e.message).split('\n')[0]}`);
  }

  if (Object.keys(attributes).length) {
    try {
      const locs = await api(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`);
      const en = locs.data.find((/** @type {any} */ l) => l.attributes.locale === 'en-US');
      if (en) {
        await api(`/v1/appStoreVersionLocalizations/${en.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            data: { type: 'appStoreVersionLocalizations', id: en.id, attributes },
          }),
        });
        console.log(`listing: ${Object.keys(attributes).join(', ')}`);
        if (WHATS_NEW) console.log(`what's new: ${WHATS_NEW.split('\n')[0].slice(0, 72)}`);
      } else {
        console.log('no en-US localization on the version — finish the listing in App Store Connect');
      }
    } catch (e) {
      console.log(`::warning::listing not set: ${String(e.message).split('\n')[0]}`);
    }
  }

  // Submission, via the reviewSubmissions flow (appStoreVersionSubmissions is
  // the deprecated one). Three calls: a submission for the app, the version
  // added to it as an item, and the submission marked submitted. Each of the
  // three tolerates already-done, because a re-run arrives with some or all of
  // it standing.
  const open = await api(
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=1`,
  );
  let submission = open.data[0];
  if (submission && submission.attributes.state !== 'READY_FOR_REVIEW') {
    console.log(`a review submission is already ${submission.attributes.state} — not submitting again`);
    return;
  }
  if (!submission) {
    const created = await api('/v1/reviewSubmissions', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: 'IOS' },
          relationships: { app: { data: { type: 'apps', id: app.id } } },
        },
      }),
    });
    submission = created.data;
  }

  try {
    await api('/v1/reviewSubmissionItems', {
      method: 'POST',
      body: JSON.stringify({
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: submission.id } },
            appStoreVersion: { data: { type: 'appStoreVersions', id: version.id } },
          },
        },
      }),
    });
  } catch (e) {
    if (/already|duplicate|conflict|409/i.test(String(e.message))) {
      console.log(`version already in the submission: ${e.message.split('\n')[1]?.trim() || ''}`);
    } else {
      // The error most worth translating: an incomplete listing refuses here
      // (or on the PATCH below) with attribute-by-attribute complaints.
      // Nothing in this repository can supply a screenshot or a privacy
      // answer, so say where the fix lives instead of just relaying the raw
      // refusal.
      console.error('If this names missing metadata, finish the listing in App Store Connect — the once-ever checklist is in docs/ci.md.');
      throw e;
    }
  }

  try {
    await api(`/v1/reviewSubmissions/${submission.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ data: { type: 'reviewSubmissions', id: submission.id, attributes: { submitted: true } } }),
    });
    console.log(`version ${versionString} (build ${BUILD_NUMBER}) submitted for App Review`);
  } catch (e) {
    if (/already|state|conflict|409/i.test(String(e.message))) {
      console.log(`not resubmitted: ${e.message.split('\n')[0]}`);
    } else {
      console.error('If this names missing metadata, finish the listing in App Store Connect — the once-ever checklist is in docs/ci.md.');
      throw e;
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
