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
import { VERBS, XOSETUP_STEPS } from '../src/fleet/protocol/intents.js';
import { signingInput } from '../src/fleet/crypto.js';

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
  for (const phase of ['run', 'status', 'cancel']) {
    assert.match(IOS, new RegExp(`intent\\("xosetup", params: \\["phase": "${phase}"`), `no ${phase} phase`);
  }
  // `begin` names the machine the person chose; the coordinator routes every
  // later phase back to it from the job, so none of them names one. Its
  // params are built first, because `pin` goes only when there is a
  // certificate, and `trust` and `plain` only when a person gave their word.
  // `relay` only for a machine that reached the address through this phone
  // (test/relay-in-apps.test.js).
  assert.match(IOS, /var params = \["phase": "begin", "address": address\]\s*if let pin \{ params\["pin"\] = pin \}\s*if let trust \{ params\["trust"\] = trust \}\s*if plain \{ params\["plain"\] = "accepted" \}\s*if let relay \{ params\["relay"\] = relay \}\s*return try await intent\("xosetup", params: params, host: host/);
  // NEVER HELD: each carries an idempotency key, which keeps a send that could
  // not reach the fleet out of the outbox and off the disk.
  const sends = IOS.match(/intent\("(?:xoprobe|xosetup)"[^\n]*\n?[^\n]*idempotencyKey: "app-\\\(UUID\(\)\.uuidString\)"/g) ?? [];
  // Eight: the probe, the probe through this phone, and begin, run, status,
  // cancel and policy (test/xopolicy-ios-in-apps.test.js has the last), and
  // an install's deploy (test/xodeploy-in-apps.test.js).
  assert.equal(sends.length, 8, 'every probe and phase is sent with an idempotency key');
});

test('iOS: a machine that reached the address is offered, HTTPS with a certificate first, and the alternatives are said plainly', () => {
  assert.match(SCREEN, /filter \{ \$0\.reachable == true && \$0\.tls == true && \$0\.cert != nil \}/);
  assert.match(SCREEN, /ForEach\(offered\)/);
  assert.match(SCREEN, /private var offered: \[Fleet\.Probe\] \{ reached \+ plainReached \}/);
  // What the person reads when nothing can run it, and what to check. Plain
  // HTTP is offered now, so no sentence on the screen claims setup needs HTTPS.
  assert.ok(SCREEN.includes('No machine reached \\(trimmedAddress). Check the address and the port, that Xen Orchestra is up, and that one '));
  assert.ok(!SCREEN.includes('Setup needs HTTPS'));
  assert.ok(!SCREEN.includes('needs HTTPS'));
  // How to give it HTTPS instead is said, and never that it has HTTPS already.
  assert.ok(!SCREEN.includes('on by default'));
  assert.ok(SCREEN.includes('xo-install.cfg') && SCREEN.includes('AUTOCERT'));
  // The certificate the machine saw is shown for acceptance, grouped so it can
  // be compared against a terminal, and `begin` pins exactly that one.
  assert.match(SCREEN, /Text\(XOSetupKey\.grouped\(cert\)\)/);
  assert.match(SCREEN, /if let cert = probe\.cert \{\s*pin = cert\s*plain = false[\s\S]{0,2000}?beginSetup\(address: target, pin: pin, host: probe\.hostId, trust: trust, plain: plain,/);
  // Cannot tell is said as cannot tell.
  assert.ok(SCREEN.includes('cannot tell whether it is Xen Orchestra'));
});

test('iOS: a machine that reached the address over plain HTTP is offered after the HTTPS ones, behind a warning the person accepts', () => {
  // The coordinator's shape for plain HTTP is `reachable: true, tls: false`,
  // and that, in as many words, is what is offered: a machine that said
  // neither is not rounded to either.
  assert.match(IOS, /var plainHTTP: Bool \{ reachable == true && tls == false \}/);
  // The row says what it reached and how; cannot tell stays cannot tell.
  for (const words of [
    'Reached Xen Orchestra over plain HTTP',
    'Reached something over plain HTTP, and it does not look like Xen Orchestra',
    'Reached something over plain HTTP; cannot tell whether it is Xen Orchestra',
  ]) {
    assert.ok(SCREEN.includes(`"${words}"`), words);
  }
  // The warning: the heading in the attention tone, then the two things that
  // would travel in the clear and between which machines, then the lines of
  // xo-install.cfg that would make it HTTPS. The same words as Android.
  assert.match(SCREEN, /Text\("This Xen Orchestra answers without HTTPS"\)\s*\.fleetType\(\.bodyStrong\)\s*\.foregroundStyle\(Design\.Palette\.attention\)/);
  assert.ok(SCREEN.includes('The admin password you type, and the token the fleet keeps afterwards, would cross the network between '));
  assert.ok(SCREEN.includes('\\(probe.hostId) and \\(trimmedAddress) unencrypted. Anything on that network could read them.'));
  assert.ok(SCREEN.includes('To give it HTTPS instead: in the installer\'s xo-install.cfg, set PORT=\\"443\\", PATH_TO_HTTPS_CERT, '));
  assert.ok(SCREEN.includes('PATH_TO_HTTPS_KEY and AUTOCERT=\\"true\\", then run it again.'));
  assert.ok(!SCREEN.includes('on by default'));
  // Shown only when there is no certificate: never both questions at once.
  // The toggle stands unless the person's kept word for plain HTTP does.
  assert.match(SCREEN, /if let cert = chosen\.cert \{[\s\S]*?\} else if chosen\.plainHTTP \{\s*plainQuestion\(chosen\)\s*if rememberedAccepts\(chosen\) \{[\s\S]{0,300}?\} else \{\s*Toggle\(isOn: \$plainAccepted\) \{\s*Text\("Send it without HTTPS anyway"\)[\s\S]{0,300}?\.frame\(minHeight: 44\)/);
  // Begin waits for the toggle, and for nothing less.
  assert.match(SCREEN, /\.disabled\(busy \|\| email\.isBlank \|\| password\.isEmpty \|\| !accepted\(chosen\)\)/);
  assert.match(SCREEN, /private func accepted\(_ probe: Fleet\.Probe\) -> Bool \{\s*if probe\.cert != nil \{ return probe\.certificateTrusted \|\| acknowledged \|\| rememberedAccepts\(probe\) \}\s*return probe\.plainHTTP && \(plainAccepted \|\| rememberedAccepts\(probe\)\)\s*\}/);
  // The toggle resets on the same changes as the certificate's: the address,
  // the machine, and a new probe.
  assert.match(SCREEN, /\.onChange\(of: address\)[\s\S]{0,500}?acknowledged = false\s*plainAccepted = false/);
  assert.match(SCREEN, /if chosen\?\.hostId != probe\.hostId \{\s*acknowledged = false\s*plainAccepted = false\s*\}/);
  const probe = SCREEN.slice(SCREEN.indexOf('private func probe()'), SCREEN.indexOf('private func choose('));
  assert.match(probe, /acknowledged = false\s*plainAccepted = false/);
  // What leaves the phone: `plain: accepted`, no pin, no trust, and only once
  // the person has said so. The one word the coordinator takes.
  assert.match(SCREEN, /\} else if probe\.plainHTTP, plainAccepted \|\| rememberedAccepts\(probe\) \{\s*pin = nil\s*trust = nil\s*plain = true\s*\} else \{\s*return\s*\}/);
  assert.deepEqual(VERBS.xosetup.params.plain.values, ['accepted']);
  // The key is still checked, over the pin the machine signed: the empty
  // string, in the bytes, the way the host's own canonical JSON writes it.
  assert.match(SCREEN, /XOSetupKey\.isSigned\([^\n]*pin: pin \?\? ""\)/);
  assert.match(IOS, /guard isJob\(job\), pin\.isEmpty \|\| isPin\(pin\), Seal\.isKey\(key\), isAddress\(address\)/);
  assert.equal(
    signingInput('xosetup-key', { address: 'xo.lan', job: 'j', key: 'k', pin: '' }),
    'agent-fleet/v1/xosetup-key\n{"address":"xo.lan","job":"j","key":"k","pin":""}',
  );
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
  assert.match(send, /Seal\.seal\(\s*to: begun\.key,\s*aad: Seal\.xosetupAAD\(job: begun\.job, address: begun\.address\),\s*payload: \[\s*"v": 1,\s*"xo": \["email": [^\]]*, "password": password\],\s*"reply": reply\.publicKey,\s*\]/);
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

test('iOS: the token comes back to this phone, to a key sent inside the seal, and is kept in the Keychain alone', async () => {
  const { xosetupHandoffAad } = await import('../src/fleet/seal.js');
  const HANDOFF = read('apps/ios/Fleetwright/XOSetupHandoff.swift');
  // THE SAME BINDING the machine seals under, built the same way.
  assert.equal(xosetupHandoffAad('J', 'A'), 'fleetwright-xosetup-handoff/v1:J:A');
  assert.match(IOS, /static func xosetupHandoffAAD\(job: String, address: String\) -> String \{ "fleetwright-xosetup-handoff\/v1:\\\(job\):\\\(address\)" \}/);
  assert.match(HANDOFF, /Seal\.open\(key, aad: Seal\.xosetupHandoffAAD\(job: job, address: address\)/);
  // The key is made before the seal and goes inside it, never as a param the
  // coordinator could swap.
  const send = SCREEN.slice(SCREEN.indexOf('private func send('), SCREEN.indexOf('private func abandon('));
  assert.ok(send.indexOf('XOSetupHandoff.newKey(job: begun.job, address: begun.address)') < send.indexOf('Seal.seal('));
  assert.doesNotMatch(IOS, /params\["reply"\] = reply\.publicKey|"phase": "run", "job": job, "sealed": sealed, "reply"/);
  // Its private half outlives the screen in the Keychain until it is used,
  // and every launch collects what a closed app was handed.
  assert.match(HANDOFF, /Keychain\.set\(key\.privateKey\.rawRepresentation\.base64EncodedString\(\), for: replyAccount\(job\)\)/);
  assert.match(IOS, /XOSetupActivities\.resume\(fleet: Fleet\(settings: settings\)\)[\s\S]{0,300}XOSetupHandoff\.collectPending\(fleet: Fleet\(settings: settings\)\)/);
  // The screen collects when it sees done, and says where the token is only
  // once it knows (C-5).
  assert.match(SCREEN, /let \(outcome, inFleet\) = await XOSetupHandoff\.collectAndKeep\(job: job, state: state, settings: settings\)\s*if let outcome \{ handedBack = outcome \}/);
  assert.match(SCREEN, /case \.kept:\s*Text\("The token is in this phone’s Keychain now\. No machine in the fleet keeps it on disk\."\)/);
  // Kept in the Keychain, this device only, and never anywhere else.
  assert.match(HANDOFF, /Keychain\.set\(text, for: tokenAccount\(at\)\)/);
  assert.match(IOS, /kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
  const code = HANDOFF.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /UserDefaults[^\n]*token|FileManager|Outbox|print\(/);
});

test('iOS: progress is polled only while the screen is open, with Cancel while it runs', () => {
  assert.match(SCREEN, /\.task\(id: job\) \{ await follow\(\) \}/);
  assert.match(SCREEN, /while !Task\.isCancelled, running \{\s*guard \(try\? await Task\.sleep\(for: \.seconds\(3\)\)\) != nil else \{ return \}/);
  // Offered once: after the machine says it will stop, its sentence stands
  // in for the button (C-2).
  assert.match(SCREEN, /if running, !cancelRequested \{\s*Button\("Cancel", role: \.destructive\) \{ Task \{ await cancel\(job\) \} \}/);
  assert.match(SCREEN, /refuse\(reply\.text \?\? "It could not be stopped\."\)\s*\} else \{\s*cancelRequested = true/);
  // Done has a way out; a stopped job has a way back in.
  assert.match(SCREEN, /else if progress\?\.state == "done" \{\s*Button\("Done"\) \{ dismiss\(\) \}/);
  assert.match(SCREEN, /Button\("Try again"\) \{[\s\S]{0,200}?reset\(\)/);
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
  const pushed = /state: \{\s*step: progress\.step,\s*of: progress\.of,\s*phase: progress\.phase,\s*state: progress\.state,\s*\.\.\.\(progress\.fill === null \? \{\} : \{ fill: progress\.fill \}\),\s*\.\.\.\(progress\.build === null \? \{\} : \{ build: progress\.build \}\),\s*\.\.\.\(progress\.stage === null \|\| progress\.stages === null \? \{\} : \{ stage: progress\.stage, stages: progress\.stages \}\),\s*\}/.exec(core);
  assert.ok(pushed, 'the coordinator no longer pushes {step, of, phase, state, fill?, build?, stage?, stages?}');
  // `fill` is optional and an older build ignores a key it has no field for,
  // so a phone that predates it still decodes every push.
  assert.match(
    IOS,
    /struct ContentState: Codable, Hashable \{\s*(?:\/\/\/[^\n]*\n\s*)?var step: Int\s*(?:\/\/\/[^\n]*\n\s*)*var of: Int\s*(?:\/\/\/[^\n]*\n\s*)*var phase: String\s*(?:\/\/\/[^\n]*\n\s*)*var state: String\s*(?:\/\/\/[^\n]*\n\s*)*var since: Date\? = nil\s*(?:\/\/\/[^\n]*\n\s*)*var fill: Int\? = nil\s*(?:\/\/\/[^\n]*\n\s*)*var build: String\? = nil\s*(?:\/\/\/[^\n]*\n\s*)*var stage: Int\? = nil\s*var stages: Int\? = nil\s*\}/,
  );
  // `since` is the phone's own, never pushed: optional, so a pushed state
  // without it still decodes.
  assert.match(read('src/fleet/coordinator/core.js'), /state: \{\s*step: progress\.step,\s*of: progress\.of,\s*phase: progress\.phase,\s*state: progress\.state,\s*\.\.\.\(progress\.fill === null \? \{\} : \{ fill: progress\.fill \}\),\s*\.\.\.\(progress\.build === null \? \{\} : \{ build: progress\.build \}\),\s*\.\.\.\(progress\.stage === null \|\| progress\.stages === null \? \{\} : \{ stage: progress\.stage, stages: progress\.stages \}\),\s*\}/, 'the coordinator pushes no `since`');
  // The static half is local only: it is in the attributes, not the state.
  assert.match(IOS, /struct XOSetupAttributes: ActivityAttributes \{[\s\S]*?let job: String\s*(?:\/\/\/[^\n]*\n\s*)*let hostId: String\s*(?:\/\/\/[^\n]*\n\s*)*let address: String/);

  // Started with a push token, the token posted hex to the coordinator's
  // route, and the answer's progress applied so a late activity starts right.
  assert.match(IOS, /Activity<XOSetupAttributes>\.request\(\s*attributes: attributes,\s*content: content\(first\),\s*pushType: \.token\s*\)/);
  assert.match(IOS, /for await token in activity\.pushTokenUpdates \{\s*await register\(token, for: job, on: activity, fleet: fleet\)[\s\S]*?let hex = token\.map \{ String\(format: "%02x", \$0\) \}\.joined\(\)/);
  assert.match(IOS, /post\("\/api\/xosetup\/activity", body: \["job": job, "token": token\]\)/);
  assert.match(IOS, /let state = contentState\(latest\.progress\)\s*else \{ return \}\s*await show\(state, on: activity\)/);
  // Ended on this side the moment the screen sees the job is over.
  assert.match(IOS, /if XOSetupWords\.isLive\(state\.state\) \{\s*await activity\.update\(content\)\s*\} else \{\s*await activity\.end\(content, dismissalPolicy: \.after\(/);
  assert.match(IOS, /static func isLive\(_ state: String\) -> Bool \{ state == "running" \|\| state == "waiting" \}/);
});

test('iOS: a policy job is on the Lock Screen from Apply, as a change and not a setup', () => {
  // ASKED FOR: "What happened to my live activities", during the edge
  // router's download. Started when the choice is sent, with its purpose, at
  // the apply step; fed by the screen's polling after that, but never by a
  // `choosing` answer, which would end it as not live.
  assert.match(SCREEN, /XOSetupActivities\.start\(fleet: fleet, job: job, hostId: hostId, address: policyJob\.address,\s*progress: answer\.xosetup, purpose: "policy", otherwise: applying\)/);
  assert.match(SCREEN, /if state\.state != "choosing" \{ await XOSetupActivities\.apply\(job: job, progress: state\) \}/);
  const ACT = read('apps/ios/Fleetwright/XOSetupActivities.swift');
  assert.match(ACT, /XOSetupAttributes\(job: job, hostId: hostId, address: address, purpose: purpose\)/);
  assert.match(ACT, /guard !Activity<XOSetupAttributes>\.activities\.contains\(where: \{ \$0\.attributes\.job == job \}\)/);
});

test('iOS: the bar is the edge router’s build while it says how far, and the disk is picked and named', () => {
  // ASKED FOR: "this needs proper progress, also which disk did it put it on?"
  assert.match(SCREEN, /let \(value, total\) = XOSetupWords\.bar\(state\)\s*ProgressView\(value: value, total: total\)/);
  assert.match(WIDGET, /let \(value, total\) = XOSetupWords\.bar\(state\)\s*ProgressView\(value: value, total: total\)/);
  // ASKED FOR: "Why no actual updates in the live activity?", while a machine
  // image was building and the app called it the edge router. What is being
  // built is named from the key the host sends, in one place, and the screen
  // and the Lock Screen both say it.
  for (const [key, words] of [['edge', 'building the edge router'], ['image', 'building the machine image'], ['holder', 'making the pool’s own machine']]) {
    assert.ok(IOS.includes(`case "${key}": return "${words}"`), `no words for a ${key} build`);
  }
  assert.ok(IOS.includes('case let (what?, part?): return "\\(what), \\(part)"'));
  assert.ok(SCREEN.includes('XOSetupWords.detail(build: part.build, stage: part.stage, stages: part.stages)'));
  assert.ok(!SCREEN.includes('building the edge router'), 'the screen names one build for every build again');
  assert.match(WIDGET, /if !stale, let detail = XOSetupWords\.detail\(state\) \{\s*Text\(detail\)/);
  assert.ok(SCREEN.includes('if choice.edgeDiskChoice, choice.building(in: inv).edge || choice.building(in: inv).image {'));
  assert.ok(SCREEN.includes('edgeDisk: begun.can.contains("edge-disk")'));
  assert.ok(SCREEN.includes('Its disk is on \\($0).'));
  assert.ok(WIDGET.includes('purpose == "policy" ? "What the fleet may use, on \\(hostId)" : "Hypervisor setup on \\(hostId)"'));
});

test('iOS: the extension draws the activity on the palette, with the words and a bar, in every Island size', () => {
  assert.match(WIDGET, /ActivityConfiguration\(for: XOSetupAttributes\.self\)/);
  for (const region of ['DynamicIslandExpandedRegion(.leading)', 'DynamicIslandExpandedRegion(.trailing)', 'DynamicIslandExpandedRegion(.bottom)', 'compactLeading:', 'compactTrailing:', 'minimal:']) {
    assert.ok(WIDGET.includes(region), `no ${region}`);
  }
  assert.match(WIDGET, /ProgressView\(value: value, total: total\)/);
  assert.match(WIDGET, /Text\(XOSetupWords\.headline\(state, purpose: purpose\)\)/);
  // A change to what the fleet may use ends in its own words, not "Hypervisor
  // added", in every place the extension draws one.
  assert.equal((WIDGET.match(/purpose: context\.attributes\.purpose/g) || []).length, 5);
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

test('iOS: a certificate that does not check out is shown in full and accepted by the person before begin', () => {
  // The same words as Android (XoSetup.kt problemLines), one per problem.
  for (const words of [
    'Self-signed: nothing but the server itself vouches for it.',
    'Signed by an authority this machine does not trust.',
    'Issued for a different name than',
    'This machine could not read the certificate’s details.',
    'Not trusted by that machine, which did not say why.',
    'Its certificate checks out',
  ]) {
    assert.ok(SCREEN.includes(words), words);
  }
  assert.match(SCREEN, /case "expired": return "Expired on /);
  assert.match(SCREEN, /case "not-yet-valid": return "Not valid until /);
  // Every field the coordinator narrows is decoded and shown.
  assert.match(IOS, /struct Certificate: Codable, Hashable \{[\s\S]*?let trusted: Bool\?[\s\S]*?let problems: \[String\]\?[\s\S]*?let subject: String\?[\s\S]*?let issuer: String\?[\s\S]*?let notBefore: String\?[\s\S]*?let notAfter: String\?[\s\S]*?let names: \[String\]\?/);
  for (const label of ['"Issued to"', '"Issued by"', '"Valid"', '"Names"']) assert.ok(SCREEN.includes(label), label);
  // The question, and Begin waits for its answer.
  assert.match(SCREEN, /Toggle\(isOn: \$acknowledged\)/);
  assert.match(SCREEN, /\.disabled\(busy \|\| email\.isBlank \|\| password\.isEmpty \|\| !accepted\(chosen\)\)/);
  // The person's word, given now or kept on this phone for this same
  // certificate (XOSaved, held to the fingerprint in xo-saved-in-apps.test.js).
  assert.match(SCREEN, /if probe\.cert != nil \{ return probe\.certificateTrusted \|\| acknowledged \|\| rememberedAccepts\(probe\) \}/);
  // `trust` goes only with the person's word, and never for a trusted one.
  assert.match(SCREEN, /if probe\.certificateTrusted \{\s*trust = nil\s*\} else if acknowledged \|\| rememberedAccepts\(probe\) \{\s*trust = "accepted"\s*\} else \{\s*return\s*\}/);
  // What was found for one address is not left standing for another.
  assert.match(SCREEN, /\.onChange\(of: address\)[\s\S]{0,400}?probes = nil[\s\S]{0,80}?chosen = nil[\s\S]{0,80}?acknowledged = false/);
});

test('iOS: a Live Activity that has heard nothing says so, and one the app gave up on ends', () => {
  const ACT = read('apps/ios/Fleetwright/XOSetupActivities.swift');
  assert.match(ACT, /staleDate: XOSetupWords\.isLive\(state\.state\) \? Date\(timeIntervalSinceNow: staleAfter\) : nil/);
  assert.match(WIDGET, /stale: context\.isStale/);
  assert.match(WIDGET, /if stale, XOSetupWords\.isLive\(state\.state\) \{\s*Text\(XOSetupWords\.silence\(state\)\)/);
  // A state with no step still ends a dead job's activity.
  assert.match(ACT, /var state = fresh \?\? activity\.content\.state\s*state\.state = newState/);
  // Tokens are relayed again after a relaunch.
  assert.match(read('apps/ios/Fleetwright/FleetwrightApp.swift'), /XOSetupActivities\.resume\(fleet: Fleet\(settings: settings\)\)/);
});

test('iOS: a setup goes only to a machine new enough to hand the token back, checked before anything is sealed', () => {
  // SEEN: a machine with the release on disk and a sidecar still running the
  // one before kept the token and reset the resource set, and the phone only
  // found out afterwards. `can` arrived after the hand-off, so none is older.
  const guard = SCREEN.indexOf('if !isPolicy, can.isEmpty {');
  assert.ok(guard > 0, 'no guard for a machine too old to hand the token back');
  assert.ok(guard < SCREEN.indexOf('guard XOSetupKey.isSigned('), 'checked after the key, so after the comparison could begin');
  const block = SCREEN.slice(guard, SCREEN.indexOf('return', guard));
  assert.match(block, /fleet\.cancelSetup\(job: begunJob\)/);
  assert.match(block, /keeps the pool’s token itself instead of handing it to this phone\. Nothing was sent\./);
});
