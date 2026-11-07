// A stopped session on a machine without the sandbox, on the iPhone: Resume
// only where the fleet would take it, and, where it would not, a word on the
// card and a sentence on the page saying who can.
//
//   node --test test/unsandboxed-resume-ios-in-apps.test.js
//
// The coordinator resumes a member's session only on a machine that says
// `health.sandboxed: true` or that they administer (hosts.js runsSessionsFor,
// scheduler.js `unsandboxed`, docs/security.md G8). A Resume it refuses is the
// dead control C-2 names, so the card and the page draw the reason instead:
// the card in three words (`resumeKeptRow`), the page in one sentence
// (`resumeKept`) that says who can resume it. What the machine would have to
// change (its sandbox, root, an environment variable) is the machine page's
// and its admin's business, and no longer on every row of the session list
// (docs/reviews/copy-2026-11-06.md, 1). What the two snapshot answers decode
// to is run by ResumeKeptTests.swift; this reads where the line and the
// button sit, the way every *-in-apps test reads a phone that does not build
// here. The Android half, in the same words, is
// unsandboxed-resume-android-in-apps.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { admit, makeAdmin } from './helpers/enrolled-hosts.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** Code without its commentary, so a rule is never confused with a note about one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const IOS = bare(iosSources());

/** What a member is told on the page, after the machine's name. */
const KEPT = [
  ' runs sessions without full isolation. Your admin can resume it.',
  ' has not said whether it isolates sessions. Your admin can resume it.',
];
/** And on the card. */
const ROW = 'Only an admin can resume this';
/** The titles over a refused start that is a setting on the machine. */
const TITLES = ['Not started: only admins run sessions there', 'Not started: the machine needs an update'];

test('iOS says who can resume where Resume is not offered, by the coordinator’s rule', () => {
  for (const words of KEPT) assert.ok(IOS.includes(`"\\(hostId)${words}"`), `iOS does not say: ${words}`);
  assert.ok(IOS.includes(`static let resumeKeptRow = "${ROW}"`));
  // Read under the key the box sends, and the rule is runsSessionsFor: kept
  // only where this person does not administer it and it has not said true.
  // What the box sends under that key is test/hub-host-routes.test.js's.
  assert.match(IOS, /struct HostHealth: Codable[\s\S]*?let sandboxed: Bool\?\s*let sandboxedWhy: String\?/);
  assert.match(IOS, /var resumeKept: String\? \{\s*guard administers == false, health\?\.sandboxed != true else \{ return nil \}\s*guard health\?\.sandboxed == false else \{/);
  // Why not is still read as the box sent it, every reason of it, for the
  // machine page; the session list does not say it.
  assert.match(IOS, /let sandboxedWhy: String\?\s*let sandboxedAlso: \[String\]\?/);
  assert.ok(!IOS.includes('can resume one there'), 'the session list still names the machine’s setting');
  assert.ok(!/"[^"\n]*FLEETWRIGHT_SANDBOX_[^"\n]*resume[^"\n]*"/.test(IOS), 'an environment variable is named beside Resume');
});

test('the coordinator still says why, so "Your admin can resume it" has an answer behind it', async () => {
  // The page's sentence is a claim about the fleet's rule (C-5): a member is
  // refused and an admin is not, whichever reason the box gives. Each reason
  // the box can send is asked of the coordinator, which refuses the member
  // with a sentence that names an admin as the one who can.
  const core = new CoordinatorCore({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
  await makeAdmin(core, 'admin@example.test');
  await admit(core, 'deb132');
  const bob = { email: 'bob@example.test', admin: false };
  for (const why of ['off', 'unsafe_args', 'userns_root', 'userns_docker', 'userns_host']) {
    core.registry.recordHealth('deb132', {
      hostId: 'deb132', protocol: PROTOCOL_VERSION, hub: { reachable: true }, maxSessions: 5, running: 0, free: 5,
      labels: [], loadavg: [0, 0, 0], claudeAccounts: 1, sessions: [], sandboxed: false, sandboxedWhy: why,
    });
    const r = await core.dispatch({ verb: 'start', params: { name: 'job', task: 'a job' }, actor: bob.email, requester: bob, preferHost: 'deb132' });
    assert.equal(r.ok, false, `${why}: the coordinator took a member's session on an uncontained machine`);
    assert.match(String(r.text), /^deb132 .*, so only this fleet’s admin can start work there\./, `${why}: the coordinator said: ${r.text}`);
  }
});

test('iOS: every Resume on a session gives way to who can where the fleet would refuse it', () => {
  // The card: the verdict. The page: the sentence.
  const card = IOS.match(/\} else if session\.isResumable, resumeKept != nil \{[\s\S]*?Text\(Fleet\.FleetHost\.resumeKeptRow\)[\s\S]*?\} else if session\.isResumable \{\s*Button\("Resume"\)/g) ?? [];
  assert.equal(card.length, 1, 'the card');
  const page = IOS.match(/\} else if session\.isResumable, let why = resumeKept \{[^}]*?Text\(why\)[^}]*?\} else if session\.isResumable \{\s*Button\("Resume"\)/g) ?? [];
  assert.equal(page.length, 1, 'the session page');
  assert.equal((IOS.match(/Button\("Resume"\)/g) ?? []).length, 2, 'a Resume that is not behind the rule');
  // Both are told by the list's own read of the session's machine.
  assert.match(IOS, /private func resumeKept\(_ session: Fleet\.Session\) -> String\? \{\s*fleetHosts\.first \{ \$0\.hostId == session\.hostId \}\?\.resumeKept/);
  assert.equal((IOS.match(/resumeKept: resumeKept\(session\)/g) ?? []).length, 2, 'the card and the page opened from a notification');
  // And the page does not promise a Resume it does not offer: the pane says
  // only that nothing is running, and the buttons below say what there is.
  assert.match(IOS, /Text\("Not running\."\)/);
  assert.ok(!IOS.includes('Resume brings the conversation back'), 'the pane still promises Resume');
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
