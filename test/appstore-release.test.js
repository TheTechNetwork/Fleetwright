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
  assert.match(SRC, /::warning::release notes not set/);
});

test('an incomplete listing points at the checklist', () => {
  // The first run of a new app fails at submission with Apple naming missing
  // metadata one attribute at a time. Nothing in this repository can supply
  // a screenshot or a privacy answer, so the error has to say where the
  // once-ever fixes live.
  assert.match(SRC, /finish the listing in App Store Connect/);
  assert.match(SRC, /docs\/ci\.md/);
});
