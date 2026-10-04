// Adding a hypervisor from a phone: the sign-in reaches one machine and nothing
// else, and progress reaches the Lock Screen. docs/hypervisors.md.
//
//   node --test test/xosetup-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift compiles
// only in CI. What is pinned here is what a person sees and what leaves the
// phone — the words, the order of the checks, the bytes a signature and a seal
// are made over — against the coordinator's own definitions where there are
// any, so the two cannot drift apart without one of them failing here. The
// coordinator's half is xosetup-coordinator.test.js.
//
// THE ANDROID HALF IS NOT HERE YET. It lands on its own branch, stacked on the
// coordinator's (CONTRIBUTING.md); the marked block at the bottom is its place,
// and the "both phones say" assertions belong there too once it exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';
import { XOSETUP_STEPS } from '../src/fleet/protocol/intents.js';

const IOS = iosSources();
const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SCREEN = read('apps/ios/Fleetwright/AddHypervisorView.swift');
const PROJECT = read('apps/ios/project.yml');
const WORKFLOW = read('.github/workflows/ios.yml');
const WIDGET_DIR = 'apps/ios/FleetwrightActivity';
const WIDGET = readdirSync(new URL(`../${WIDGET_DIR}`, import.meta.url))
  .filter((f) => f.endsWith('.swift'))
  .sort()
  .map((f) => read(`${WIDGET_DIR}/${f}`))
  .join('\n');

test('iOS: the entry is on Machines, for a known admin only', () => {
  // `showsAdmin` is true only for a confirmed admin not viewing as a member;
  // nil (cannot tell) draws nothing, which is the rule every admin row obeys.
  assert.match(IOS, /if settings\.configured && settings\.showsAdmin \{[\s\S]{0,400}?Label\("Add a hypervisor"/);
});

test('iOS: the screen asks every machine first, then runs one job on one machine through its four phases', () => {
  assert.match(IOS, /intent\("xoprobe", params: \["address": address\]/);
  for (const phase of ['begin', 'run', 'status', 'cancel']) {
    assert.match(IOS, new RegExp(`intent\\("xosetup", params: \\["phase": "${phase}"`), `no ${phase} phase`);
  }
  // `begin` names the machine the person chose; the coordinator routes every
  // later phase back to it from the job, so none of them names one.
  assert.match(IOS, /\["phase": "begin", "address": address, "pin": pin\], host: host/);
  // NEVER HELD: each carries an idempotency key, which keeps a send that could
  // not reach the fleet out of the outbox and off the disk.
  const sends = IOS.match(/intent\("(?:xoprobe|xosetup)"[^\n]*\n?[^\n]*idempotencyKey: "app-\\\(UUID\(\)\.uuidString\)"/g) ?? [];
  assert.equal(sends.length, 5, 'every probe and phase is sent with an idempotency key');
});

test('iOS: only a machine that reached the address over HTTPS is offered, and the alternatives are said plainly', () => {
  assert.match(SCREEN, /filter \{ \$0\.reachable == true && \$0\.tls == true && \$0\.cert != nil \}/);
  // What the person reads when nothing can run it, and what to check.
  assert.ok(SCREEN.includes('No machine reached \\(trimmedAddress). Check the address and the port, that Xen Orchestra is up, and that one '));
  assert.ok(SCREEN.includes('Setup needs HTTPS, because the sign-in is only '));
  assert.ok(SCREEN.includes('The Xen Orchestra installer turns it on by default'));
  // The certificate the machine saw is shown for acceptance, grouped so it can
  // be compared against a terminal, and `begin` pins exactly that one.
  assert.match(SCREEN, /Text\(XOSetupKey\.grouped\(cert\)\)/);
  assert.match(SCREEN, /guard let pin = probe\.cert else \{ return \}[\s\S]{0,600}?beginSetup\(address: target, pin: pin, host: probe\.hostId\)/);
  // Cannot tell is said as cannot tell.
  assert.ok(SCREEN.includes('cannot tell whether it is Xen Orchestra'));
});

test('iOS: the key is checked as the machine’s before anything is sealed to it', () => {
  // The exact bytes the machine signs, so the host and the phone cannot
  // disagree about them without one of them being wrong here.
  assert.match(IOS, /static let signingPrefix = "agent-fleet\/v1\/xosetup-key\\n"/);
  assert.match(
    IOS,
    /signingPrefix \+ "\{\\"address\\":\\"\\\(address\)\\",\\"job\\":\\"\\\(job\)\\",\\"key\\":\\"\\\(key\)\\",\\"pin\\":\\"\\\(pin\)\\"\}"/,
  );
  // ECDSA P-256 over SHA-256, raw r||s, from the JWK's x and y.
  assert.match(IOS, /P256\.Signing\.PublicKey\(x963Representation: Data\(\[0x04\]\) \+ x \+ y\)/);
  assert.match(IOS, /P256\.Signing\.ECDSASignature\(rawRepresentation: raw\)/);
  assert.match(IOS, /publicKey\.isValidSignature\(signature, for: Data\(signed\.utf8\)\)/);

  // ORDER: the signature is checked in `begin`, the seal happens in `send`,
  // and `begin` reaches `send` only past the check.
  const begin = SCREEN.slice(SCREEN.indexOf('private func begin('), SCREEN.indexOf('private func approvedFingerprint('));
  const checkAt = begin.indexOf('XOSetupKey.isSigned(');
  assert.ok(checkAt > 0, 'begin does not check the signature');
  assert.ok(!begin.includes('Seal.seal('), 'begin seals before send');
  assert.ok(begin.indexOf('await send()') > checkAt, 'send is reachable before the signature is checked');
  // A bad signature is a hard stop, and the job is dropped on the machine.
  assert.match(begin, /guard XOSetupKey\.isSigned\([^\n]*\) else \{\s*_ = try\? await fleet\.cancelSetup\(job: begunJob\)\s*refuse\("The key \\\(machine\) answered with did not come from that machine, so the sign-in was not sent\."\)/);

  // The fingerprint is the vault's fingerprint, worked out from the key the
  // same way, and compared with what the vault approved for that machine.
  assert.match(begin, /let fingerprint = PhoneVault\.fingerprint\(hostKey\)/);
  assert.match(begin, /if approved == fingerprint \{\s*await send\(\)/);
  assert.match(begin, /\} else if approved != nil \{[\s\S]{0,300}?did not come from that machine: it is not the key this phone approved for it/);
  assert.match(begin, /\} else \{\s*toCompare = fingerprint/);
  // And when the vault has not vouched, the person compares it with the box.
  assert.ok(SCREEN.includes('fleetwright-sidecar identity'));
  assert.ok(SCREEN.includes('"They match"'));
});

test('iOS: the sign-in is sealed under the documented AAD, as the documented payload, and the password is gone the moment it is', () => {
  assert.match(IOS, /static func xosetupAAD\(job: String, address: String\) -> String \{ "fleetwright-xosetup\/v1:\\\(job\):\\\(address\)" \}/);
  const send = SCREEN.slice(SCREEN.indexOf('private func send('), SCREEN.indexOf('private func abandon('));
  assert.match(send, /Seal\.seal\(\s*to: begun\.key,\s*aad: Seal\.xosetupAAD\(job: begun\.job, address: begun\.address\),\s*payload: \["v": 1, "xo": \["email": [^\]]*, "password": password\]\]/);
  // Sealed first, then cleared, then sent: a failed send leaves no password
  // on the screen.
  const sealAt = send.indexOf('Seal.seal(');
  const clearAt = send.indexOf('password = ""');
  const sendAt = send.indexOf('fleet.runSetup(');
  assert.ok(sealAt > 0 && clearAt > sealAt && sendAt > clearAt, 'the password is not cleared between sealing and sending');
  assert.match(send, /"\\\(sealed\["epk"\] \?\? ""\)\.\\\(sealed\["iv"\] \?\? ""\)\.\\\(sealed\["ct"\] \?\? ""\)"/);
  // Nothing on this screen is written anywhere. The code, not the comments,
  // which are allowed to say so.
  const code = SCREEN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  for (const store of ['UserDefaults', 'Keychain.', 'FileManager', 'outbox']) {
    assert.ok(!code.includes(store), `the hypervisor screen touches ${store}`);
  }
  // SecureField, so the password is never on the screen either.
  assert.match(SCREEN, /SecureField\("Its password", text: \$password\)/);
  // Cancelling the comparison clears it too, and drops the job on the machine.
  assert.match(SCREEN, /private func abandon\(\) async \{\s*password = ""\s*toCompare = nil\s*if let begun \{ _ = try\? await fleet\.cancelSetup\(job: begun\.job\) \}/);
});

test('iOS: progress is polled only while the screen is open, with Cancel while it runs', () => {
  assert.match(SCREEN, /\.task\(id: job\) \{ await follow\(\) \}/);
  assert.match(SCREEN, /while !Task\.isCancelled, running \{\s*guard \(try\? await Task\.sleep\(for: \.seconds\(3\)\)\) != nil else \{ return \}/);
  assert.match(SCREEN, /if running \{\s*Button\("Cancel", role: \.destructive\) \{ Task \{ await cancel\(job\) \} \}/);
  // Done has a way out; a stopped job has a way back in.
  assert.match(SCREEN, /else if progress\?\.state == "done" \{\s*Button\("Done"\) \{ dismiss\(\) \}/);
  assert.match(SCREEN, /Button\("Try again"\) \{ reset\(\) \}/);
  // A change of step crossfades (MOTION 2), and nothing loops.
  assert.match(SCREEN, /\.contentTransition\(\.opacity\)/);
  assert.match(SCREEN, /\.animation\(Design\.Motion\.change, value: progress\?\.phase\)/);
  assert.doesNotMatch(SCREEN + WIDGET, /repeatForever|\.symbolEffect\(\.pulse|\.symbolEffect\(\.breathe|phaseAnimator/);
});

test('iOS: every step has words, in the product’s voice, and an unknown step still has a number', () => {
  const words = IOS.slice(IOS.indexOf('static func phrase('), IOS.indexOf('static func headline('));
  for (const step of XOSETUP_STEPS) {
    assert.match(words, new RegExp(`case "${step}": return "[A-Z][^"]+"`), `no words for the ${step} step`);
  }
  assert.match(words, /case "done": return "Hypervisor added"/);
  assert.match(words, /default: return "Step \\\(min\(step \+ 1, max\(of, 1\)\)\) of \\\(max\(of, 1\)\)"/);
  // The end titles are the coordinator's notification titles (core.js
  // #onSetupProgress), so the banner and the activity read as one sentence.
  const core = read('src/fleet/coordinator/core.js');
  for (const title of ['Hypervisor added', 'Hypervisor setup stopped', 'Hypervisor setup cancelled']) {
    assert.ok(core.includes(`'${title}'`), `the coordinator does not say "${title}"`);
    assert.ok(IOS.includes(`"${title}"`), `the phone does not say "${title}"`);
  }
});

test('iOS: the Live Activity decodes exactly what the coordinator pushes, and tells it where to push', () => {
  // The field names ARE the server's content-state keys. Read from the
  // coordinator's source rather than retyped: the object literal it hands to
  // push.activity is the contract.
  const core = read('src/fleet/coordinator/core.js');
  const pushed = /state: \{ step: progress\.step, of: progress\.of, phase: progress\.phase, state: progress\.state \}/.exec(core);
  assert.ok(pushed, 'the coordinator no longer pushes {step, of, phase, state}');
  assert.match(
    IOS,
    /struct ContentState: Codable, Hashable \{\s*(?:\/\/\/[^\n]*\n\s*)?var step: Int\s*(?:\/\/\/[^\n]*\n\s*)*var of: Int\s*(?:\/\/\/[^\n]*\n\s*)*var phase: String\s*(?:\/\/\/[^\n]*\n\s*)*var state: String\s*\}/,
  );
  // The static half is local only: it is in the attributes, not the state.
  assert.match(IOS, /struct XOSetupAttributes: ActivityAttributes \{[\s\S]*?let job: String\s*(?:\/\/\/[^\n]*\n\s*)*let hostId: String\s*(?:\/\/\/[^\n]*\n\s*)*let address: String/);

  // Started with a push token, the token posted hex to the coordinator's
  // route, and the answer's progress applied so a late activity starts right.
  assert.match(IOS, /Activity<XOSetupAttributes>\.request\(\s*attributes: attributes,\s*content: ActivityContent\(state: first, staleDate: nil\),\s*pushType: \.token\s*\)/);
  assert.match(IOS, /for await token in activity\.pushTokenUpdates \{\s*let hex = token\.map \{ String\(format: "%02x", \$0\) \}\.joined\(\)/);
  assert.match(IOS, /post\("\/api\/xosetup\/activity", body: \["job": job, "token": token\]\)/);
  assert.match(IOS, /let state = contentState\(latest\.progress\)\s*else \{ continue \}\s*await activity\.update\(ActivityContent\(state: state, staleDate: nil\)\)/);
  // Ended on this side the moment the screen sees the job is over.
  assert.match(IOS, /if XOSetupWords\.isLive\(state\.state\) \{\s*await activity\.update\(content\)\s*\} else \{\s*await activity\.end\(content, dismissalPolicy: \.after\(/);
  assert.match(IOS, /static func isLive\(_ state: String\) -> Bool \{ state == "running" \|\| state == "waiting" \}/);
});

test('iOS: the extension draws the activity on the palette, with the words and a bar, in every Island size', () => {
  assert.match(WIDGET, /ActivityConfiguration\(for: XOSetupAttributes\.self\)/);
  for (const region of ['DynamicIslandExpandedRegion(.leading)', 'DynamicIslandExpandedRegion(.trailing)', 'DynamicIslandExpandedRegion(.bottom)', 'compactLeading:', 'compactTrailing:', 'minimal:']) {
    assert.ok(WIDGET.includes(region), `no ${region}`);
  }
  assert.match(WIDGET, /ProgressView\(value: Double\(min\(state\.step, state\.of\)\), total: Double\(state\.of\)\)/);
  assert.match(WIDGET, /Text\(XOSetupWords\.headline\(state\)\)/);
  // The same palette check design-parity.test.js runs on the app, because the
  // widget directory is outside the one it reads.
  const bare = WIDGET.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(bare, /\.(?:foregroundStyle|foregroundColor|tint)\([^)]*\.(?:green|orange|red|yellow|blue|purple|pink|mint|teal|indigo|brown|gray|grey|secondary|tertiary|white|black)\b/);
  // Never colour alone: the mark changes shape with the state.
  assert.match(WIDGET, /case "done": return "checkmark"\s*case "failed": return "xmark"/);
});

test('iOS: the project declares the extension, the activity, and a profile per target', () => {
  assert.match(PROJECT, /NSSupportsLiveActivities: true/);
  assert.match(PROJECT, /FleetwrightActivity:\s*\n\s*type: app-extension/);
  assert.match(PROJECT, /NSExtensionPointIdentifier: com\.apple\.widgetkit-extension/);
  assert.match(PROJECT, /PRODUCT_BUNDLE_IDENTIFIER: network\.thetech\.fleetwright\.Activity/);
  // The app embeds it, and the extension compiles the shared type.
  assert.match(PROJECT, /dependencies:\s*\n\s*- package: Sentry\s*\n(?:\s*#[^\n]*\n)*\s*- target: FleetwrightActivity/);
  assert.match(PROJECT, /- path: Fleetwright\/XOSetupActivity\.swift/);
  // One profile variable per target, and the archive names both.
  assert.match(PROJECT, /PROVISIONING_PROFILE_SPECIFIER: \$\(FLEETWRIGHT_APP_PROFILE\)/);
  assert.match(PROJECT, /PROVISIONING_PROFILE_SPECIFIER: \$\(FLEETWRIGHT_ACTIVITY_PROFILE\)/);
  assert.match(WORKFLOW, /FLEETWRIGHT_APP_PROFILE="\$PROFILE_NAME" \\\n\s*FLEETWRIGHT_ACTIVITY_PROFILE="\$ACTIVITY_PROFILE_NAME"/);
  assert.doesNotMatch(WORKFLOW, /PROVISIONING_PROFILE_SPECIFIER=/, 'a specifier on the command line applies to every target');
  assert.match(WORKFLOW, /<key>\$\{ACTIVITY_BUNDLE_ID\}<\/key><string>\$\{ACTIVITY_PROFILE_NAME\}<\/string>/);
  // The extension's profile comes from App Store Connect, not a second secret.
  assert.match(WORKFLOW, /node tools\/ensure-ios-extension-profile\.mjs/);
  assert.doesNotMatch(WORKFLOW, /APPLE_ACTIVITY_PROVISIONING_PROFILE/);
  // The version lives once, for both bundles.
  assert.equal((PROJECT.match(/MARKETING_VERSION: "/g) ?? []).length, 1, 'MARKETING_VERSION is declared more than once');
});

// ─── THE ANDROID HALF GOES HERE ──────────────────────────────────────────────
//
// Added on its own branch, stacked on this one: the same probe and the same
// four phases through Fleet.kt, the same signature check before anything is
// sealed, the same AAD, an ongoing notification in place of the Live Activity,
// and a "both phones say the same things" test over the sentences above.
//
// A COMMENT AND NOT A `test.todo`, deliberately. scripts/check-coverage.mjs
// refuses to judge a run with a skipped test in it, and a todo counts as one —
// so a placeholder test here would switch the coverage ratchet off for the
// whole repository until the Android layer landed.
