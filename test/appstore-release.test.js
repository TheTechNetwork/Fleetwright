// Shipping to the App Store, and the refusals that keep it honest.
//
// Same testing posture as testflight-distribute.test.js: the tool is a
// sequence of App Store Connect calls with no logic worth mocking a server
// for, so these pin the invariants in the source — the decisions that were
// argued for once and must not be lost to a refactor that keeps the calls and
// drops the order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../tools/appstore-release.mjs', import.meta.url), 'utf8');

test('a version already on the store refuses by naming the fix', () => {
  // App Store Connect answers this case with a generic 409. The tool has to
  // say "bump MARKETING_VERSION" itself, and it has to say where, because the
  // person reading the log is three files away from knowing.
  assert.match(SRC, /READY_FOR_SALE/);
  assert.match(SRC, /bump MARKETING_VERSION in apps\/ios\/project\.yml/);
});

test('approval releases the version — no third state', () => {
  // AFTER_APPROVAL, and never MANUAL: "approved but waiting for a click
  // nobody knows they owe" is a green pipeline and an unshipped app both
  // being true, which is the same trap PLAY_ROLLOUT's empty default refuses
  // on the Android side.
  assert.match(SRC, /AFTER_APPROVAL/);
  assert.doesNotMatch(SRC, /'MANUAL'/);
});

test('the version string comes from the build, not from a file', () => {
  // The build's version train IS MARKETING_VERSION at the tagged commit,
  // read back from the binary that was uploaded. Parsing project.yml here
  // would introduce a second reader of the same value, and two readers is
  // how a version drifts from the build it names.
  assert.match(SRC, /include=preReleaseVersion/);
  assert.doesNotMatch(SRC, /project\.yml'/);
});

test('a slow processing queue is a warning, not a failure', () => {
  // The upload already succeeded; Apple's queue answers to nobody. The exit
  // inside the poll loop must be 0, so a re-run is a choice rather than a
  // red cross on a green outcome.
  const timeout = SRC.indexOf('::warning::Build');
  assert.ok(timeout > 0, 'the timeout warning is gone');
  const after = SRC.slice(timeout, timeout + 600);
  assert.match(after, /process\.exit\(0\)/);
});

test('submission goes through reviewSubmissions, and the deprecated door stays shut', () => {
  // appStoreVersionSubmissions is the endpoint every old blog post reaches
  // for. It is deprecated, and mixing the two flows leaves a submission the
  // other API cannot see. The tool may NAME it — that is the warning sign on
  // the door — but the path must never appear as a request.
  assert.match(SRC, /\/v1\/reviewSubmissions/);
  assert.match(SRC, /reviewSubmissionItems/);
  assert.doesNotMatch(SRC, /\/v1\/appStoreVersionSubmissions/);
});

test('release notes are a nicety and cannot sink the shipment', () => {
  // Apple refuses whatsNew on an app's first version — there is nothing it
  // is newer than — and that refusal must downgrade to a warning. The
  // version is the delivery; the notes decorate it.
  const notes = SRC.indexOf('appStoreVersionLocalizations');
  assert.ok(notes > 0, 'the localization step is gone');
  // The message is now about the whole LISTING, because the notes stopped being
  // the only thing written there — the description and promotional text come
  // from apps/store-listing.md in the same PATCH. The property is unchanged and
  // is what this guards: a refusal here warns, it does not throw.
  assert.match(SRC, /::warning::listing not set/);
  const block = SRC.slice(SRC.indexOf('const attributes = {}'), SRC.indexOf('// Submission, via'));
  assert.doesNotMatch(block, /throw /, 'a failed listing update now sinks the release');
});

test('an incomplete listing points at the checklist', () => {
  // The first run of a new app fails at submission with Apple naming missing
  // metadata one attribute at a time. Nothing in this repository can supply
  // a screenshot or a privacy answer, so the error has to say where the
  // once-ever fixes live.
  assert.match(SRC, /finish the listing in App Store Connect/);
  assert.match(SRC, /docs\/ci\.md/);
});

test('what the listing is missing is said before anything is written', () => {
  // The refusal for an incomplete listing arrives at the very END — after a
  // version exists, a build is attached and the notes are set — and it is
  // Apple's own attribute-by-attribute complaint. So the first submission of a
  // new app left a half-built version behind and a raw error in the log, and
  // the answer was a line of prose pointing at a checklist.
  //
  // Nothing here can supply a screenshot or a privacy answer, which is exactly
  // why it belongs BEFORE the writes rather than after them. One list somebody
  // can work through beats four rounds of "and also".
  const src = readFileSync(new URL('../tools/appstore-release.mjs', import.meta.url), 'utf8');

  const check = src.indexOf('const gaps = await listingGaps(');
  assert.ok(check > 0, 'the listing is never pre-checked');
  // BEFORE the first write. Creating the version is the first thing that
  // changes anything on Apple's side.
  const firstWrite = src.indexOf("await api('/v1/appStoreVersions', {");
  assert.ok(firstWrite > 0 && check < firstWrite, 'the pre-check runs after the version is created');

  // A BETTER MESSAGE, NOT A NEW GATE. An API shape that changed, or a
  // permission this key does not have, must not stop a release that would
  // otherwise have gone out — so the check swallows its own errors and warns
  // rather than throwing.
  const fn = src.slice(src.indexOf('async function listingGaps('), src.indexOf('async function main()'));
  assert.match(fn, /could not pre-check the listing/);
  assert.doesNotMatch(fn, /throw new Error/);
  // It warns; it does not fail the job.
  assert.match(src, /::warning::this listing is not finished/);
});

test('a version already in preparation under another name is renamed, never duplicated', () => {
  // Apple allows one version in preparation per platform, and App Store
  // Connect makes a "1.0" with the app record. Three releases of a new app
  // looked only for a version with the build's own name, found none, asked
  // for a second one, and got the generic 409 for it. The editable version
  // that exists — whatever it is called — is this release's version.
  const lookup = SRC.indexOf('filter[platform]=IOS&limit=20');
  const rename = SRC.indexOf("attributes: { versionString } }");
  const create = SRC.indexOf("await api('/v1/appStoreVersions', {");
  assert.ok(lookup > 0, 'the editable-version lookup is gone');
  assert.ok(rename > lookup, 'the rename is gone');
  assert.ok(rename < create, 'the rename must be tried before a new version is created');
  assert.match(SRC, /one version in preparation per platform/);
});

test('the listing pre-check includes the data it reads', () => {
  // A listed appInfo carries its relationships as links only. Without
  // `include`, `relationships.primaryCategory.data` is absent whether or not a
  // category is set, and the check warned "no primary category" on three
  // releases whose listing was complete.
  const fn = SRC.slice(SRC.indexOf('async function listingGaps('), SRC.indexOf('async function main()'));
  assert.match(fn, /appInfos\?include=primaryCategory,ageRatingDeclaration/);
  assert.match(fn, /ageRatingDeclarations/);
});

test('a refused version is a red job, not "already in the submission"', () => {
  // Apple answers an INCOMPLETE version with a 409 too: "is not in valid
  // state: This resource cannot be reviewed". The old test accepted any 409
  // as "already in", skipped the submit, and the first release of a new app
  // went green with nothing submitted. Only "already" is done.
  const items = SRC.slice(SRC.indexOf("await api('/v1/reviewSubmissionItems'"), SRC.indexOf('await api(`/v1/reviewSubmissions/${submission.id}`'));
  assert.doesNotMatch(items, /conflict\|409/, 'any 409 is accepted as "already in the submission" again');
  assert.doesNotMatch(items, /\/already\|/, 'a bare "already" matches Apple\'s refusals as well');
  assert.match(items, /throw e/);
  const final = SRC.slice(SRC.indexOf('await api(`/v1/reviewSubmissions/${submission.id}`'), SRC.indexOf('main().catch'));
  assert.doesNotMatch(final, /state\|conflict\|409/, 'any refusal of the submit is accepted as done again');
});

test('refused release notes do not take the description with them', () => {
  // A first version refuses whatsNew, and the fields travel in one PATCH, so
  // the description sank with the notes and Apple then wanted it typed. The
  // PATCH that carried notes is tried once more without them.
  const block = SRC.slice(SRC.indexOf('const attributes = {}'), SRC.indexOf('// Submission, via'));
  assert.match(block, /const \{ whatsNew, \.\.\.rest \} = attributes/);
  assert.match(block, /await patch\(rest\)/);
  assert.match(block, /release notes refused/);
});

test("warnings carry Apple's reason, not only the request that was refused", () => {
  // api() puts the request on the first line and Apple's words after it;
  // "PATCH … → 409" alone is what three releases printed, and it says
  // nothing. reason() is what every warning and skip prints now.
  assert.match(SRC, /function reason\(/);
  const fn = SRC.slice(SRC.indexOf('function reason('), SRC.indexOf('async function listingGaps('));
  assert.match(fn, /lines\.slice\(1\)/);
  assert.doesNotMatch(SRC, /String\(e\.message\)\.split\('\\n'\)\[0\]\}`\)/, 'a warning still prints only the request line');
});
