// A stopped session on a machine without the sandbox, on Android: Resume only
// where the fleet would take it, and a line saying why where it would not, in
// the iPhone's words.
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

/** What a member is told, after the machine's name. */
const KEPT = [
  ' runs sessions without the sandbox, so only this fleet’s admin, or the one person it works for, can resume one there.',
  ' has not said whether its sessions are sandboxed, so only this fleet’s admin, or the one person it works for, can resume one there until it is updated.',
];
const TITLES = ['Not started: only admins run sessions there', 'Not started: the machine needs an update'];

test('Android says why Resume is not offered, in the iPhone’s words and by the same rule', () => {
  for (const words of KEPT) {
    assert.ok(ANDROID.includes(`"$hostId${words}"`), `Android does not say: ${words}`);
    assert.ok(IOS.includes(`"\\(hostId)${words}"`), `iOS does not say: ${words}`);
  }
  // Read under the key the box sends, absent kept apart from false.
  assert.match(ANDROID, /sandboxed = health\?\.takeIf \{ it\.has\("sandboxed"\) && !it\.isNull\("sandboxed"\) \}\?\.optBoolean\("sandboxed"\)/);
  assert.match(ANDROID, /val resumeKept: String\?\s*get\(\) = when \{\s*administers != false \|\| sandboxed == true -> null\s*sandboxed == false ->/);
});

test('Android: every Resume on a session gives way to the reason where the fleet would refuse it', () => {
  const gated = ANDROID.match(/\} else if \(session\.resumable && resumeKept != null\) \{\s*Text\(resumeKept,[^\n]*\n\s*\} else if \(session\.resumable\) \{\s*TextButton\([^\n]*\{ Text\("Resume"\) \}/g) ?? [];
  assert.equal(gated.length, 2, 'the card and the session sheet');
  assert.equal((ANDROID.match(/Text\("Resume"\)/g) ?? []).length, 2, 'a Resume that is not behind the rule');
  // Both are told by the list's own read of the session's machine.
  assert.equal((ANDROID.match(/resumeKept = binHosts\.firstOrNull \{ it\.hostId == session\.hostId \}\?\.resumeKept,/g) ?? []).length, 2);
  // And the sheet does not promise a Resume it does not offer.
  assert.match(ANDROID, /if \(resumeKept == null\) "Not running, so there is no screen to read\. Output has what it printed; Resume brings the conversation back\."\s*else "Not running, so there is no screen to read\. Output has what it printed\."/);
});

test('Android titles a refused start by the coordinator’s code, as the iPhone does', () => {
  const [unsandboxed, outdated] = TITLES;
  assert.ok(ANDROID.includes(`"unsandboxed" -> "${unsandboxed}"`));
  assert.ok(ANDROID.includes(`"host_outdated" -> "${outdated}"`));
  for (const t of TITLES) assert.ok(IOS.includes(`"${t}"`), `iOS does not say: ${t}`);
  assert.ok(ANDROID.includes('else -> "Could not start a session"'));
  // Which notification carries it is claude-setup-in-apps.test.js's.
});
