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
  ' lets an option in FLEETWRIGHT_SANDBOX_ARGS end its sandbox, so only this fleet’s admin, or the one person it works for, can resume one there until that option is taken out.',
  ' runs fleetwright as root, and root in a session is root on the machine, so only this fleet’s admin, or the one person it works for, can resume one there until fleetwright runs as its own user.',
  ' runs its sandbox with docker, which does not keep root in a session apart from the account that holds everyone’s credentials, so only this fleet’s admin, or the one person it works for, can resume one there until its sessions run under podman.',
  ' has FLEETWRIGHT_SANDBOX_USERNS=host, which makes root in a session the account that holds everyone’s credentials, so only this fleet’s admin, or the one person it works for, can resume one there until that is set back to nomap.',
  ' says its sessions are not contained, so only this fleet’s admin, or the one person it works for, can resume one there.',
];
const TITLES = ['Not started: only admins run sessions there', 'Not started: the machine needs an update'];

test('Android says why Resume is not offered, in the iPhone’s words and by the same rule', () => {
  for (const words of KEPT) {
    assert.ok(ANDROID.includes(`"$hostId${words}"`), `Android does not say: ${words}`);
    assert.ok(IOS.includes(`"\\(hostId)${words}"`), `iOS does not say: ${words}`);
  }
  // Read under the key the box sends, absent kept apart from false.
  assert.match(ANDROID, /sandboxed = health\?\.takeIf \{ it\.has\("sandboxed"\) && !it\.isNull\("sandboxed"\) \}\?\.optBoolean\("sandboxed"\)/);
  assert.match(ANDROID, /val resumeKept: String\?\s*get\(\) = when \{\s*administers != false \|\| sandboxed == true -> null\s*sandboxed == false && saidWhy\.size > 1 -> \{/);
  assert.match(ANDROID, /sandboxed == false -> when \(saidWhy\[0\]\) \{/);
  // Why not, read under the keys the box sends, every entry of the rest; a
  // box too old to say why is off.
  assert.match(ANDROID, /sandboxedWhy = health\?\.optString\("sandboxedWhy"\)\?\.takeIf \{ it\.isNotBlank\(\) && it != "null" \},/);
  assert.match(ANDROID, /sandboxedAlso = health\?\.optJSONArray\("sandboxedAlso"\)\?\.let \{ arr ->\s*\(0 until arr\.length\(\)\)\.map \{ i -> arr\.optString\(i\) \}/);
  assert.match(ANDROID, /get\(\) = sandboxedWhy\?\.let \{ listOf\(it\) \+ sandboxedAlso \} \?: listOf\("off"\)/);
});

test('both phones join two or more reasons from the same table, in the same words', () => {
  // What each reason's machine does and what has to change, as the line
  // joins them when a box gives more than one. iOS's table is held to the
  // coordinator's words by unsandboxed-resume-ios-in-apps.test.js; this
  // holds Android's to iOS's, row for row.
  const rows = (/** @type {RegExp} */ re, /** @type {string} */ src) =>
    Object.fromEntries([...src.matchAll(re)].map(([, code, does, until]) => [code, [does, until]]));
  const ios = rows(/"([a-z_]+)": \("([^"]+)", "([^"]+)"\)/g, IOS);
  const android = rows(/"([a-z_]+)" to \("([^"]+)" to "([^"]+)"\)/g, ANDROID);
  assert.deepEqual(Object.keys(ios).sort(), ['off', 'unsafe_args', 'userns_docker', 'userns_host', 'userns_root']);
  assert.deepEqual(android, ios);
  // Said in the same sentence around them; how each joins is pinned by
  // ResumeKeptTest.kt and ResumeKeptTests.swift, word for word.
  const sentence = ', so only this fleet’s admin, or the one person it works for, can resume one there until ';
  assert.ok(ANDROID.includes(`"$hostId \${together(known.map { it.first })}${sentence}\${together(known.map { it.second })}."`));
  assert.ok(IOS.includes(`"\\(hostId) \\(Self.together(known.map { $0.does }))${sentence}\\(Self.together(known.map { $0.until }))."`));
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
