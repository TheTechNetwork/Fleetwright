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
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { admit, makeAdmin } from './helpers/enrolled-hosts.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** Code without its commentary, so a rule is never confused with a note about one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const IOS = bare(iosSources());

/** What a member is told, after the machine's name. */
const KEPT = [
  ' runs sessions without the sandbox, so only this fleet’s admin, or the one person it works for, can resume one there.',
  ' has not said whether its sessions are sandboxed, so only this fleet’s admin, or the one person it works for, can resume one there until it is updated.',
  // A box with its sandbox on that still does not contain a session says
  // why (http.js uncontained), and is told by that reason and its way on.
  ' lets an option in FLEETWRIGHT_SANDBOX_ARGS end its sandbox, so only this fleet’s admin, or the one person it works for, can resume one there until that option is taken out.',
  ' runs fleetwright as root, and root in a session is root on the machine, so only this fleet’s admin, or the one person it works for, can resume one there until fleetwright runs as its own user.',
  ' runs its sandbox with docker, which does not keep root in a session apart from the account that holds everyone’s credentials, so only this fleet’s admin, or the one person it works for, can resume one there until its sessions run under podman.',
  ' has FLEETWRIGHT_SANDBOX_USERNS=host, which makes root in a session the account that holds everyone’s credentials, so only this fleet’s admin, or the one person it works for, can resume one there until that is set back to nomap.',
  ' says its sessions are not contained, so only this fleet’s admin, or the one person it works for, can resume one there.',
];
/** The titles over a refused start that is a setting on the machine. */
const TITLES = ['Not started: only admins run sessions there', 'Not started: the machine needs an update'];

test('iOS says why Resume is not offered, by the coordinator’s rule', () => {
  for (const words of KEPT) assert.ok(IOS.includes(`"\\(hostId)${words}"`), `iOS does not say: ${words}`);
  // Read under the key the box sends, and the rule is runsSessionsFor: kept
  // only where this person does not administer it and it has not said true.
  // What the box sends under that key is test/hub-host-routes.test.js's.
  assert.match(IOS, /struct HostHealth: Codable[\s\S]*?let sandboxed: Bool\?\s*let sandboxedWhy: String\?/);
  assert.match(IOS, /var resumeKept: String\? \{\s*guard administers == false, health\?\.sandboxed != true else \{ return nil \}\s*guard health\?\.sandboxed == false else \{/);
  // Why not is read as the box sent it, and a box too old to say why is off.
  assert.match(IOS, /switch health\?\.sandboxedWhy \?\? "off" \{/);
});

test('iOS names why a machine does not contain a session in the words the coordinator refuses with', async () => {
  // The refusal a member gets from the fleet and the line under a session on
  // the phone are the same fact; a phone that said "without the sandbox" of a
  // box the fleet called root would be the C-5 failure between them. So each
  // reason the box can send is asked of the coordinator, and its clause and
  // its way on must be the phone's.
  const core = new CoordinatorCore({ logger: { info() {}, warn() {}, error() {}, debug() {} } });
  await makeAdmin(core, 'admin@example.test');
  await admit(core, 'deb132');
  const bob = { email: 'bob@example.test', admin: false };
  /** The phone's way on, for the coordinator's. */
  const until = {
    unsafe_args: 'that option is taken out',
    userns_root: 'fleetwright runs as its own user',
    userns_docker: 'its sessions run under podman',
    userns_host: 'that is set back to nomap',
  };
  for (const [why, phone] of Object.entries(until)) {
    core.registry.recordHealth('deb132', {
      hostId: 'deb132', protocol: PROTOCOL_VERSION, hub: { reachable: true }, maxSessions: 5, running: 0, free: 5,
      labels: [], loadavg: [0, 0, 0], claudeAccounts: 1, sessions: [], sandboxed: false, sandboxedWhy: why,
    });
    const r = await core.dispatch({ verb: 'start', params: { name: 'job', task: 'a job' }, actor: bob.email, requester: bob, preferHost: 'deb132' });
    const [, clause, fix] = String(r.text).match(/^deb132 (.*), so only this fleet’s admin can start work there\. (.*) opens it to everyone it acts for\.$/) ?? [];
    assert.ok(clause, `the coordinator said: ${r.text}`);
    assert.ok(IOS.includes(`"\\(hostId) ${clause}, so only this fleet’s admin, or the one person it works for, can resume one there until ${phone}."`), `iOS does not say ${why} as the coordinator does`);
    // The same way on, said once as a step and once as a condition.
    assert.ok(fix.toLowerCase().split(/[ ,]+/).some((w) => w.length > 4 && phone.includes(w)), `${why}: "${fix}" and "${phone}" are not the same way on`);
  }
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
