// A stopped session on a machine without the sandbox, on the iPhone: Resume
// only where the fleet would take it, and a line saying why where it would not.
//
//   node --test test/unsandboxed-resume-ios-in-apps.test.js
//
// The coordinator resumes a member's session only on a machine that says
// `health.sandboxed: true` or that they administer (hosts.js runsSessionsFor,
// scheduler.js `unsandboxed`, docs/security.md G8). A Resume it refuses is the
// dead control C-2 names, so the card and the page draw the reason instead.
// What the two snapshot answers decode to is run by ResumeKeptTests.swift;
// this reads where the line and the button sit, the way every *-in-apps test
// reads a phone that does not build here. The Android half, in the same
// words, is unsandboxed-resume-android-in-apps.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** Code without its commentary, so a rule is never confused with a note about one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const IOS = bare(iosSources());

/** What a member is told, after the machine's name. */
const KEPT = [
  ' runs sessions without the sandbox, so only this fleet’s admin, or the one person it works for, can resume one there.',
  ' has not said whether its sessions are sandboxed, so only this fleet’s admin, or the one person it works for, can resume one there until it is updated.',
];
/** The titles over a refused start that is a setting on the machine. */
const TITLES = ['Not started: only admins run sessions there', 'Not started: the machine needs an update'];

test('iOS says why Resume is not offered, by the coordinator’s rule', () => {
  for (const words of KEPT) assert.ok(IOS.includes(`"\\(hostId)${words}"`), `iOS does not say: ${words}`);
  // Read under the key the box sends, and the rule is runsSessionsFor: kept
  // only where this person does not administer it and it has not said true.
  // What the box sends under that key is test/hub-host-routes.test.js's.
  assert.match(IOS, /struct HostHealth: Codable[\s\S]*?let sandboxed: Bool\?/);
  assert.match(IOS, /var resumeKept: String\? \{\s*guard administers == false, health\?\.sandboxed != true else \{ return nil \}\s*return health\?\.sandboxed == false/);
});

test('iOS: every Resume on a session gives way to the reason where the fleet would refuse it', () => {
  const gated = IOS.match(/\} else if session\.isResumable, let why = resumeKept \{[^}]*?Text\(why\)[^}]*?\} else if session\.isResumable \{\s*Button\("Resume"\)/g) ?? [];
  assert.equal(gated.length, 2, 'the card and the session page');
  assert.equal((IOS.match(/Button\("Resume"\)/g) ?? []).length, 2, 'a Resume that is not behind the rule');
  // Both are told by the list's own read of the session's machine.
  assert.match(IOS, /private func resumeKept\(_ session: Fleet\.Session\) -> String\? \{\s*fleetHosts\.first \{ \$0\.hostId == session\.hostId \}\?\.resumeKept/);
  assert.equal((IOS.match(/resumeKept: resumeKept\(session\)/g) ?? []).length, 2, 'the card and the page opened from a notification');
  // And the page does not promise a Resume it does not offer.
  assert.match(IOS, /Text\(resumeKept == nil\s*\? "Not running, so there is no screen to read\. Output has what it printed; Resume brings the conversation back\."\s*: "Not running, so there is no screen to read\. Output has what it printed\."\)/);
});

test('iOS titles a refused start by the coordinator’s code, not as a failure to retry', () => {
  // The codes the fleet sends for these two refusals.
  assert.match(read('src/fleet/coordinator/scheduler.js'), /code: 'unsandboxed'/);
  assert.match(read('src/fleet/coordinator/core.js'), /error: \{ code: 'host_outdated' \}/);
  assert.match(IOS, /var error: Refusal\?/);
  const [unsandboxed, outdated] = TITLES;
  assert.ok(IOS.includes(`case "unsandboxed": return "${unsandboxed}"`));
  assert.ok(IOS.includes(`case "host_outdated": return "${outdated}"`));
  assert.match(IOS, /default: return "Could not start a session"/);
  // Which notification carries it is claude-setup-in-apps.test.js's.
});
