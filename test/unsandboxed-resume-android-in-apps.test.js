// A stopped session on a machine without the sandbox, on Android: Resume only
// where the fleet would take it, and, where it would not, a word on the card
// and a sentence on the sheet saying who can, in the iPhone's words.
//
//   node --test test/unsandboxed-resume-android-in-apps.test.js
//
// The rule and why it is the coordinator's are in
// unsandboxed-resume-ios-in-apps.test.js. What the two snapshot answers decode
// to is run by ResumeKeptTest.kt; this reads where the line and the button sit,
// and that both phones say the same thing.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

/** Code without its commentary, so a rule is never confused with a note about one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const ANDROID = bare(androidSources());
const IOS = bare(iosSources());

/** What a member is told on the sheet, after the machine's name. */
const KEPT = [
  ' runs sessions without full isolation. Your admin can resume it.',
  ' has not said whether it isolates sessions. Your admin can resume it.',
];
/** And on the card. */
const ROW = 'Only an admin can resume this';
const TITLES = ['Not started: only admins run sessions there', 'Not started: the machine needs an update'];

test('Android says who can resume where Resume is not offered, in the iPhone’s words and by the same rule', () => {
  for (const words of KEPT) {
    assert.ok(ANDROID.includes(`"$hostId${words}"`), `Android does not say: ${words}`);
    assert.ok(IOS.includes(`"\\(hostId)${words}"`), `iOS does not say: ${words}`);
  }
  assert.ok(ANDROID.includes(`const val RESUME_KEPT_ROW = "${ROW}"`));
  assert.ok(IOS.includes(`static let resumeKeptRow = "${ROW}"`));
  // Read under the key the box sends, absent kept apart from false.
  assert.match(ANDROID, /sandboxed = health\?\.takeIf \{ it\.has\("sandboxed"\) && !it\.isNull\("sandboxed"\) \}\?\.optBoolean\("sandboxed"\)/);
  assert.match(ANDROID, /val resumeKept: String\?\s*get\(\) = when \{\s*administers != false \|\| sandboxed == true -> null\s*sandboxed == false -> "\$hostId runs sessions without full isolation/);
  // Why not is still read under the keys the box sends, every entry of the
  // rest, for the machine page; the session list does not say it.
  assert.match(ANDROID, /sandboxedWhy = health\?\.optString\("sandboxedWhy"\)\?\.takeIf \{ it\.isNotBlank\(\) && it != "null" \},/);
  assert.match(ANDROID, /sandboxedAlso = health\?\.optJSONArray\("sandboxedAlso"\)\?\.let \{ arr ->\s*\(0 until arr\.length\(\)\)\.map \{ i -> arr\.optString\(i\) \}/);
});

test('neither phone names the machine’s setting in the session list', () => {
  // The reason (root, docker, an environment variable) and its way on were
  // on every card and sheet, in the coordinator's words. They are the machine
  // page's now (docs/reviews/copy-2026-11-06.md, 1), and the two phones drop
  // them together.
  for (const [name, src] of [['Android', ANDROID], ['iOS', IOS]]) {
    assert.ok(!src.includes('can resume one there'), `${name} still names the machine’s setting`);
    assert.ok(!/"[^"\n]*FLEETWRIGHT_SANDBOX_[^"\n]*resume[^"\n]*"/.test(src), `${name} names an environment variable beside Resume`);
  }
});

test('Android: every Resume on a session gives way to who can where the fleet would refuse it', () => {
  // The card: the verdict. The sheet: the sentence.
  const card = ANDROID.match(/\} else if \(session\.resumable && resumeKept != null\) \{\s*Text\(Fleet\.FleetHost\.RESUME_KEPT_ROW,[^\n]*\n\s*\} else if \(session\.resumable\) \{\s*TextButton\([^\n]*\{ Text\("Resume"\) \}/g) ?? [];
  assert.equal(card.length, 1, 'the card');
  const sheet = ANDROID.match(/\} else if \(session\.resumable && resumeKept != null\) \{\s*Text\(resumeKept,[^\n]*\n\s*\} else if \(session\.resumable\) \{\s*TextButton\([^\n]*\{ Text\("Resume"\) \}/g) ?? [];
  assert.equal(sheet.length, 1, 'the session sheet');
  assert.equal((ANDROID.match(/Text\("Resume"\)/g) ?? []).length, 2, 'a Resume that is not behind the rule');
  // Both are told by the list's own read of the session's machine.
  assert.equal((ANDROID.match(/resumeKept = binHosts\.firstOrNull \{ it\.hostId == session\.hostId \}\?\.resumeKept,/g) ?? []).length, 2);
  // And the sheet does not promise a Resume it does not offer.
  assert.match(ANDROID, /else -> Text\("Not running\.",/);
  assert.ok(!ANDROID.includes('Resume brings the conversation back'), 'the pane still promises Resume');
});

test('Android titles a refused start by the coordinator’s code, as the iPhone does', () => {
  const [unsandboxed, outdated] = TITLES;
  assert.ok(ANDROID.includes(`"unsandboxed" -> "${unsandboxed}"`));
  assert.ok(ANDROID.includes(`"host_outdated" -> "${outdated}"`));
  for (const t of TITLES) assert.ok(IOS.includes(`"${t}"`), `iOS does not say: ${t}`);
  // Any other refusal is titled by its code's word (ReasonWords.refusal,
  // test/reasons-in-apps.test.js); it was one sentence for every code.
  assert.ok(ANDROID.includes('else -> title'));
  // Which notification carries it is claude-setup-in-apps.test.js's.
});
