// Coming back to the app shows the fleet as it is now, not as it was.
//
// THE COMMENT THAT WAS NOT TRUE. FleetView said a refresh "already happens when
// the app opens, is pulled, or comes back to the foreground", and nothing did
// the third: the app's foreground hook collected a Proxmox VE line and stopped.
// Android's resume did the same two collections and neither reloaded nor sent
// what the outbox held, which waited for the next sign-in. A session page kept
// the picture it was opened with, peeked for two minutes and stopped — so the
// push could be right while the open page was from the pocket.
//
// Neither app compiles here, so this reads their source: a weaker check than
// running them, and the one that would have caught the comment.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ios = (/** @type {string} */ f) => readFileSync(new URL(`../apps/ios/Fleetwright/${f}`, import.meta.url), 'utf8');
const android = (/** @type {string} */ f) => readFileSync(new URL(`../apps/android/app/src/main/java/network/thetech/fleetwright/${f}`, import.meta.url), 'utf8');
/** The body of an effect or hook: from its head to the next line at the same indent. */
const block = (/** @type {string} */ src, /** @type {string} */ head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone`);
  const indent = /[ \t]*$/.exec(src.slice(0, at))?.[0] ?? '';
  const rest = src.slice(at + head.length);
  const end = rest.search(new RegExp(`\\n${indent}[}\\]).]`));
  return rest.slice(0, end < 0 ? undefined : end);
};

test('iOS: becoming active refreshes the list, sends what was held, and re-watches an open session', () => {
  const app = ios('FleetwrightApp.swift');
  const active = block(app, '.onChange(of: scenePhase)');
  assert.match(active, /guard phase == \.active/);
  assert.match(active, /NotificationCenter\.default\.post\(name: \.becameActive/, 'the app says it is back');
  // Every kind of setup this phone is owed a result from, not only Proxmox.
  assert.match(active, /XOSetupHandoff\.collectPending\(fleet:/, 'a finished Xen Orchestra setup is collected on return');
  assert.match(app, /static let becameActive = Notification\.Name\(/);

  const view = ios('FleetView.swift');
  const onActive = block(view, '.onReceive(NotificationCenter.default.publisher(for: .becameActive))');
  assert.match(onActive, /await refresh\(keepStatus: true\)/, 'the list is asked for again');
  // refresh() flushes the outbox when the fleet answers, so one call is both.
  assert.match(block(view, 'private func refresh(keepStatus: Bool = false) async'), /await flushOutbox\(\)/);
  assert.doesNotMatch(view, /it already\n\s*\/\/\/ happens when the app opens, is pulled, or comes back to the foreground/, 'the untrue sentence');

  const page = ios('SessionView.swift');
  const onPage = block(page, '.onReceive(NotificationCenter.default.publisher(for: .becameActive))');
  assert.match(onPage, /watchGeneration \+= 1/, 'the short watch starts again, which is one fresh peek first');
  assert.match(onPage, /await reload\(\)/, 'and the sentence at the top is the fleet’s now');
});

test('Android: resuming reloads, flushes the outbox, and re-watches an open session', () => {
  const main = android('MainActivity.kt');
  const resume = block(main, 'LaunchedEffect(resumes) {');
  assert.match(resume, /resumes > 1 && signedIn/, 'the first resume is the launch, covered by sign-in');
  assert.match(resume, /reload\(keepStatus = true\)/);
  assert.match(resume, /outbox\.flush \{/);
  assert.match(resume, /ProxmoxThroughHandoff\.collectPending/, 'the handoff is still collected');
  assert.match(resume, /XoHandoff\.collectPending\(settings, fleet\)/, 'a finished Xen Orchestra setup is collected on return');

  const sheet = android('SessionSheet.kt');
  assert.match(sheet, /Lifecycle\.Event\.ON_RESUME\) resumes\+\+/);
  const onResume = block(sheet, 'LaunchedEffect(resumes) {');
  assert.match(onResume, /watchGeneration \+= 1/);
  assert.match(onResume, /reload\(\)/);
});

test('a sealed notification that lost its buttons says to open the app', () => {
  // The extension clears a sealed notification's category when it cannot open
  // it in time (and when the seal does not open), because the buttons would
  // answer nothing. That is right; arriving as a generic alert with no word
  // about the missing buttons was the silent half.
  const service = readFileSync(new URL('../apps/ios/FleetwrightPush/NotificationService.swift', import.meta.url), 'utf8');
  const expire = block(service, 'override func serviceExtensionTimeWillExpire()');
  assert.match(expire, /content\.body = PushCrypto\.openToAnswer\(after: content\.body\)/);
  assert.equal((service.match(/PushCrypto\.openToAnswer\(after: content\.body\)/g) ?? []).length, 2, 'both the timed-out and the unopened paths');
  const crypto = ios('PushCrypto.swift');
  assert.match(crypto, /static func openToAnswer\(after body: String\) -> String/);
  assert.match(crypto, /"Open the app to answer\."/);
});
