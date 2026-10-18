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
import { uploadScreenshots } from './appstore-screenshots.mjs';

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
 * Apple's reason, on one line. api() formats a refusal as the request on the
 * first line and Apple's `title: detail` on the ones after; the first line
 * alone ("PATCH … → 409") is the part that says nothing, and it is what every
 * warning here used to print.
 *
 * @param {unknown} e
 */
function reason(e) {
  const lines = String(e instanceof Error ? e.message : e)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (lines.length > 1 ? lines.slice(1).join('; ') : lines[0]) || 'no reason given';
}

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
    //
    // WITH `include`, OR THE ANSWER IS ALWAYS "MISSING". A listed resource
    // carries its relationships as links only; the `data` under each appears
    // when the related resource is included in the same request. Without it,
    // both checks below read an absent `data` as an absent category and an
    // unanswered questionnaire, and said so on three releases whose listing
    // was complete — a warning that is wrong every time is one nobody reads.
    //
    // Two app infos can exist (the one on the store and the one being
    // prepared); a category on either is a category.
    const infos = await api(`/v1/apps/${appId}/appInfos?include=primaryCategory,ageRatingDeclaration&limit=2`);
    const included = infos.included || [];
    if (infos.data?.length) {
      const hasCategory = infos.data.some((/** @type {any} */ i) => i.relationships?.primaryCategory?.data);
      if (!hasCategory) gaps.push('no primary category');
      // The declaration exists from the day the app record does, answered or
      // not; unanswered is every one of its attributes still null.
      const answered = included
        .filter((/** @type {any} */ i) => i.type === 'ageRatingDeclarations')
        .some((/** @type {any} */ d) => Object.values(d.attributes || {}).some((v) => v !== null && v !== undefined));
      if (!answered) gaps.push('the age rating questionnaire has not been answered');
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
    console.log(`::debug::could not pre-check the listing (${reason(e)})`);
    return [];
  }
  return gaps;
}

/**
 * Copyright on the version, the privacy policy URL on the app info, and the
 * App Review contact — the fields the first submission was refused for that
 * are neither the description nor a picture.
 *
 * @param {string} appId @param {string} versionId
 */
async function writeVersionFacts(appId, versionId) {
  /** @type {ReturnType<typeof storeListing> | null} */
  let listing = null;
  try {
    listing = storeListing();
  } catch (e) {
    console.log(`::warning::store listing not read: ${reason(e)}`);
  }

  if (listing) {
    try {
      await api(`/v1/appStoreVersions/${versionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { type: 'appStoreVersions', id: versionId, attributes: { copyright: listing.copyright } } }),
      });
      console.log(`copyright: ${listing.copyright}`);
    } catch (e) {
      console.log(`::warning::copyright not set: ${reason(e)}`);
    }

    try {
      // The privacy policy URL lives on the app INFO's localisation, which is
      // per app rather than per version; there can be two infos (the one on
      // the store and the one in preparation), and the URL is written to
      // every en-US localisation that will take it.
      const infos = await api(`/v1/apps/${appId}/appInfos?limit=2`);
      let written = 0;
      for (const info of infos.data || []) {
        const locs = await api(`/v1/appInfos/${info.id}/appInfoLocalizations?limit=50`);
        const en = (locs.data || []).find((/** @type {any} */ l) => l.attributes?.locale === 'en-US');
        if (!en || en.attributes?.privacyPolicyUrl === listing.privacyPolicyUrl) continue;
        try {
          await api(`/v1/appInfoLocalizations/${en.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              data: { type: 'appInfoLocalizations', id: en.id, attributes: { privacyPolicyUrl: listing.privacyPolicyUrl } },
            }),
          });
          written++;
        } catch (e) {
          // The info already on the store is read-only; the one in
          // preparation is the one that matters.
          console.log(`::debug::privacy policy URL not written on app info ${info.id}: ${reason(e)}`);
        }
      }
      if (written) console.log(`privacy policy URL: ${listing.privacyPolicyUrl}`);
    } catch (e) {
      console.log(`::warning::privacy policy URL not set: ${reason(e)}`);
    }
  }

  // WHO APP REVIEW MAY CALL. Four secrets, set once. Without them the job says
  // what to set rather than inventing a person, and Apple holds the version
  // until the contact exists.
  const contact = {
    contactFirstName: process.env.ASC_REVIEW_FIRST_NAME || '',
    contactLastName: process.env.ASC_REVIEW_LAST_NAME || '',
    contactPhone: process.env.ASC_REVIEW_PHONE || '',
    contactEmail: process.env.ASC_REVIEW_EMAIL || '',
  };
  if (Object.values(contact).some((v) => !v)) {
    console.log(
      '::warning::no App Review contact — set ASC_REVIEW_FIRST_NAME, ASC_REVIEW_LAST_NAME, ASC_REVIEW_PHONE and ASC_REVIEW_EMAIL (secrets), or type it once in App Store Connect',
    );
    return;
  }
  try {
    const existing = await api(`/v1/appStoreVersions/${versionId}/appStoreReviewDetail`).catch(() => null);
    const current = existing?.data;
    if (current) {
      await api(`/v1/appStoreReviewDetails/${current.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { type: 'appStoreReviewDetails', id: current.id, attributes: contact } }),
      });
    } else {
      await api('/v1/appStoreReviewDetails', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'appStoreReviewDetails',
            attributes: { ...contact, demoAccountRequired: false },
            relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
          },
        }),
      });
    }
    console.log(`review contact: ${contact.contactFirstName} ${contact.contactLastName}`);
  } catch (e) {
    console.log(`::warning::review contact not set: ${reason(e)}`);
  }
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
    if (vstate === 'READY_FOR_SALE' || vstate === 'READY_FOR_DISTRIBUTION' || vstate === 'REPLACED_WITH_NEW_VERSION') {
      throw new Error(
        `version ${versionString} is already on the App Store (${vstate}) — bump MARKETING_VERSION in apps/ios/project.yml and publish a new release`,
      );
    }
    console.log(`version ${versionString} is ${vstate} — already submitted, nothing to do`);
    return;
  }
  if (!version) {
    // ONE VERSION IN PREPARATION PER PLATFORM — Apple's rule, and the whole
    // reason a new app's first release failed three times with a generic 409
    // on the POST below. App Store Connect makes a "1.0" the moment the app
    // record is created, in PREPARE_FOR_SUBMISSION, and nothing here had ever
    // shipped it; the lookup above asks only for a version with THIS build's
    // name, so it found nothing and asked for a second one, which is the one
    // thing Apple refuses. The same shape recurs after a rejection when the
    // next release carries a new MARKETING_VERSION: the rejected version is
    // still the only editable one.
    //
    // So an editable version under any name is this release's version, renamed.
    // versionString is an updatable attribute, and the rename is what makes
    // the rest of this file — attach the build, write the listing, submit —
    // land on the version Apple will actually accept.
    const editable = await api(`/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=20`);
    const other = (editable.data || []).find((/** @type {any} */ v) =>
      EDITABLE.has(v.attributes?.appVersionState || v.attributes?.appStoreState),
    );
    if (other) {
      const was = other.attributes?.versionString;
      const state = other.attributes?.appVersionState || other.attributes?.appStoreState;
      const renamed = await api(`/v1/appStoreVersions/${other.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { type: 'appStoreVersions', id: other.id, attributes: { versionString } } }),
      });
      version = renamed?.data || { ...other, attributes: { ...other.attributes, versionString } };
      console.log(
        `renamed App Store version ${was} (${state}) to ${versionString} — Apple allows one version in preparation per platform, and that one was it`,
      );
    }
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

  // THE REST OF WHAT A FIRST SUBMISSION IS REFUSED FOR, written from the
  // repository and the environment rather than typed: the copyright line
  // (an attribute of the version), the privacy policy URL (on the app's
  // info, not the version) and who App Review may call (a record of its
  // own, hung off the version). Each warns and goes on when refused; the
  // submission below is where Apple says, in its words, what is still
  // missing, and that is the message worth failing on.
  await writeVersionFacts(app.id, version.id);

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
    // The two fields App Store Connect still wanted typed after the
    // description arrived. Both are localisation attributes, so they travel
    // in the same PATCH.
    attributes.keywords = listing.keywords;
    attributes.supportUrl = listing.supportUrl;
  } catch (e) {
    // A LISTING THAT CANNOT BE READ IS NOT A REASON TO DROP A RELEASE. The copy
    // already on the store is what stays, and it says so.
    console.log(`::warning::store listing not applied: ${reason(e)}`);
  }

  if (Object.keys(attributes).length) {
    try {
      const locs = await api(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`);
      const en = locs.data.find((/** @type {any} */ l) => l.attributes.locale === 'en-US');
      if (en) {
        const patch = (/** @type {Record<string, string>} */ attrs) =>
          api(`/v1/appStoreVersionLocalizations/${en.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              data: { type: 'appStoreVersionLocalizations', id: en.id, attributes: attrs },
            }),
          });
        // THE FIRST VERSION REFUSES whatsNew, and because the fields travel
        // in one PATCH the refusal took the description down with it: the
        // app's first submission then failed for "Description - This field
        // is required" with the description sitting in store-listing.md. So
        // a refused PATCH that carried notes is tried once more without
        // them; the notes decorate, the description is required. A refusal
        // without notes in it, or of the retry, lands in the catch below.
        let written = attributes;
        const refused = await patch(attributes).then(() => null, (/** @type {Error} */ e) => e);
        if (refused && attributes.whatsNew) {
          const { whatsNew, ...rest } = attributes;
          console.log(`::warning::release notes refused (${reason(refused)}) — writing the listing without them`);
          written = rest;
          await patch(rest);
        } else if (refused) {
          written = {};
          console.log(`::warning::listing not set: ${reason(refused)}`);
        }
        if (Object.keys(written).length) console.log(`listing: ${Object.keys(written).join(', ')}`);
        if (written.whatsNew) console.log(`what's new: ${WHATS_NEW.split('\n')[0].slice(0, 72)}`);
      } else {
        console.log('no en-US localization on the version — finish the listing in App Store Connect');
      }
    } catch (e) {
      console.log(`::warning::listing not set: ${reason(e)}`);
    }
  }

  // SCREENSHOTS, BEFORE THE SUBMISSION AND NOT AFTER IT. A version missing a
  // required display size is refused at submission, so the ordering here is the
  // feature: this is the last thing that can still change the version, and the
  // next call asks Apple to accept it.
  //
  // It is also why this is an import rather than another workflow step — a
  // second job could not be placed between two calls inside this one.
  //
  // ONLY ON A FULL RELEASE, which is where this whole file runs, and only if
  // needed: a display type that already has screenshots is left alone.
  try {
    const locs = await api(`/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`);
    const en = locs.data.find((/** @type {any} */ l) => l.attributes.locale === 'en-US');
    if (en) {
      const n = await uploadScreenshots({
        api,
        localizationId: en.id,
        dir: process.env.SCREENSHOTS_DIR || undefined,
        force: process.env.SCREENSHOTS_FORCE === 'true',
      });
      if (n) console.log(`${n} screenshot${n === 1 ? '' : 's'} uploaded`);
    }
  } catch (e) {
    // THE SAME RULE AS THE LISTING. Whatever is already on the store stays, and
    // a submission with the previous version's screenshots is a submission; a
    // release that stopped here is not.
    console.log(`::warning::screenshots not uploaded: ${reason(e)}`);
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
    // ONLY "ALREADY IN" IS DONE. This used to accept any 409, and Apple
    // answers an INCOMPLETE version with a 409 too: "is not in valid state:
    // This resource cannot be reviewed". The job then printed "version
    // already in the submission", skipped the submit, and went green with
    // nothing submitted — a green that cost a release to discover. A version
    // Apple will not take is this job failing, in Apple's words.
    if (/already (?:exists|in|added|part of)|duplicate/i.test(String(e.message))) {
      console.log(`version already in the submission: ${reason(e)}`);
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
    // The same rule: a submission that is already on its way is done, and
    // anything else is a refusal that must be seen. The old test matched on
    // "state" and "409", which is also what Apple says when it will NOT
    // submit; see the item POST above.
    if (/already (?:been )?submitted|already in review/i.test(String(e.message))) {
      console.log(`not resubmitted: ${reason(e)}`);
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
