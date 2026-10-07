// What a phone remembers about reaching a Xen Orchestra pool: the machine
// that got through last time, tried first, and the sign-in and the person's
// word for the certificate, kept only when they ask and only behind Face ID
// or a fingerprint. docs/hypervisors.md, "The path it used last".
//
//   node --test test/xo-saved-in-apps.test.js
//
// A read of the sources, like xosetup-in-apps.test.js, because the Swift and
// the Kotlin compile only in CI. What is pinned is what a person relies on:
// the item opens to biometrics on this phone and nowhere else; an acceptance
// stands for the one certificate it was given for; nothing is kept until the
// machine has signed in with it, and a password that stops working is
// dropped; the remembered machine is a first try, and every machine is asked
// when it does not get through; and the screen says which of those is true.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SAVED = read('apps/ios/Fleetwright/XOSaved.swift');
const SCREEN = read('apps/ios/Fleetwright/AddHypervisorView.swift');
/** Code without its commentary, so a rule is never confused with a note about one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
/** One function's text, from its declaration to the next declaration at the same depth. */
const fn = (/** @type {string} */ src, /** @type {string} */ name) => {
  const at = src.indexOf(`func ${name}(`);
  assert.ok(at > 0, `no ${name}`);
  const next = src.slice(at + 1).search(/\n {4}(?:@MainActor\n {4})?(?:private |static |@discardableResult\n {4})*func /);
  return src.slice(at, next > 0 ? at + 1 + next : undefined);
};

test('iOS: what is kept opens to Face ID or Touch ID, on this phone only, and is offered only where it can be', () => {
  // A new face or finger retires it; it never leaves in a backup; it goes
  // with the passcode.
  assert.match(SAVED, /SecAccessControlCreateWithFlags\(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, \.biometryCurrentSet, nil\)/);
  assert.match(SAVED, /item\[kSecAttrAccessControl as String\] = access/);
  // The switch exists only when biometrics are enrolled (C-2).
  assert.match(SAVED, /canEvaluatePolicy\(\.deviceOwnerAuthenticationWithBiometrics/);
  assert.match(SCREEN, /if let biometry \{\s*Toggle\(isOn: \$keep\) \{\s*Text\("Keep on this phone, behind \\\(biometry\)"\)/);
  // Turning it off over what was kept forgets it then, not later.
  assert.match(SCREEN, /\.onChange\(of: keep\) \{ _, on in\s*guard !on, keepLoaded else \{ return \}\s*XOSaved\.forget\(trimmedAddress\)/);
  // And the Face ID prompt says why it is up.
  assert.match(read('apps/ios/project.yml'), /NSFaceIDUsageDescription: >-[\s\S]{0,200}?a Xen Orchestra sign-in you chose to keep/);
});

test('iOS: a kept acceptance stands for the certificate it was given for and no other', () => {
  const accepts = fn(SAVED, 'accepts');
  assert.match(accepts, /if let cert = probe\.cert \{ return accepted\.pin == cert \}/);
  assert.match(accepts, /return probe\.plainHTTP && accepted\.plain/);
  // A different certificate is asked about in full: the question card and
  // its toggle come back whenever the kept word does not match.
  assert.match(SCREEN, /if !chosen\.certificateTrusted, rememberedAccepts\(chosen\) \{\s*rememberedLine\("You accepted this certificate before/);
  assert.match(SCREEN, /\} else if !chosen\.certificateTrusted \{\s*Toggle\(isOn: \$acknowledged\)/);
});

test('iOS: nothing is kept until the machine has signed in with it, and a password that stops working is dropped', () => {
  const note = bare(fn(SCREEN, 'notePath'));
  // Past `sign-in`, and only then, is anything written.
  assert.match(note, /let past = now == "done" \|\| now == "choosing" \|\| \(XOSetupWords\.isLive\(now\) && !phase\.isEmpty && phase != "connect" && phase != "sign-in"\)/);
  assert.match(note, /if past \{[\s\S]*?XOSaved\.save\(entry, for: trimmedAddress\)[\s\S]*?return\s*\}/);
  assert.equal((bare(SCREEN).match(/XOSaved\.save\(/g) ?? []).length, 1, 'something else writes what is kept');
  // Stopped at sign-in with a kept password: forgotten, and said.
  assert.match(note, /phase == "sign-in", keepLoaded \{\s*XOSaved\.forget\(trimmedAddress\)/);
  assert.ok(SCREEN.includes('The kept sign-in did not work, so this phone no longer keeps it.'));
  // The copy waiting to be kept is the one sealed, taken before the password
  // is cleared, and dropped with any refusal.
  for (const send of [fn(SCREEN, 'send'), fn(SCREEN, 'sendForPolicy')]) {
    assert.match(bare(send), /pendingSave = chosen\.flatMap \{ entryToKeep\(\$0\) \}\s*password = ""/);
  }
  assert.match(bare(fn(SCREEN, 'refuse')), /pendingSave = nil/);
  assert.match(bare(fn(SCREEN, 'entryToKeep')), /guard keep, biometry != nil else \{ return nil \}/);
});

test('iOS: the machine that got through last time is tried first, and every machine is asked when it does not', () => {
  const open = bare(fn(SCREEN, 'openRemembered'));
  assert.match(open, /if let via = XOSaved\.machine\(for: trimmedAddress\), let path = directPath\(via\) \{[\s\S]*?viaMemory = true\s*(?:await beginWithKept\(\)\s*)?return\s*\}\s*await probe\(\)/);
  // Only with a certificate that needs nobody's word, or the person's kept
  // word for it; anything else is asked of every machine.
  const direct = bare(fn(SCREEN, 'directPath'));
  assert.match(direct, /if let accepted = remembered\?\.accepted/);
  assert.match(direct, /if let pinned = XOSetupHandoff\.pinnedCertificate\(trimmedAddress\), pinned\.trusted/);
  // Refused at begin (gone, switched off): every machine is asked.
  assert.match(bare(fn(SCREEN, 'begin')), /if viaMemory \{\s*await self\.probe\(\)\s*refuse\("\\\(why\) Your other machines were asked instead\."\)/);
  // Stopped at connect: said, and Try again asks every machine.
  assert.match(SCREEN, /let askAll = viaMemory && progress\?\.phase == "connect"\s*reset\(\)\s*if askAll \{ Task \{ await probe\(\) \} \}/);
  // Asked of all, the one that got through last time is chosen among them.
  assert.match(bare(fn(SCREEN, 'probe')), /else if let via = XOSaved\.machine\(for: trimmedAddress\) \{\s*chosen = offered\.first \{ \$0\.hostId == via \}/);
  // Remembered only once it got through.
  assert.match(bare(fn(SCREEN, 'notePath')), /if past \{\s*if !hostId\.isEmpty \{ XOSaved\.rememberMachine\(hostId, for: trimmedAddress\) \}/);
  // And it claims nothing it did not ask this time.
  assert.ok(SCREEN.includes('Got through last time, so it is tried first'));
  assert.ok(SCREEN.includes('Its certificate checked out when this pool was set up, and \\(probe.hostId) checks it again before signing in.'));
});

test('iOS: the sign-in footer says who keeps it, for the switch as it stands', () => {
  assert.ok(SCREEN.includes('This phone keeps it\\(word) in its '));
  assert.ok(SCREEN.includes('Keychain behind \\(biometry), once \\(chosen.hostId) has signed in with it; the fleet never keeps it.'));
  assert.ok(SCREEN.includes('and neither this phone nor the fleet keeps it.'));
});

test('iOS: the way out names the router it is for, and offers to build it only where it can be built', () => {
  assert.ok(SCREEN.includes('The network the edge router, an OPNsense VM, will put its WAN on'));
  // Offered by a machine that said it can, and only with a way out (C-2).
  assert.match(SCREEN, /canEdge: begun\.can\.contains\("edge"\)/);
  assert.match(SCREEN, /if canEdge, choice\.egress != nil \{\s*Toggle\(isOn: \$choice\.edge\)/);
  assert.match(SCREEN, /\.onChange\(of: choice\.egress\) \{ _, way in\s*if way == nil \{ choice\.edge = false; choice\.image = false; choice\.images = \[\]; choice\.holder = false \}/);
  // Built where there is none, kept where there is, and the cost said first.
  assert.ok(SCREEN.includes('there == nil ? "Build the edge router on it" : "Keep the edge router on it"'));
  assert.ok(SCREEN.includes('downloads OPNsense once, about 470 MB, and builds it while you wait.'));
  assert.ok(SCREEN.includes('is too old to build the router; update it to have it built from here.'));
  // Any of the pool's networks as the way out, from a machine that takes it,
  // and only the fleet's from one that does not (checkPolicy).
  assert.match(SCREEN, /anyWayOut: begun\.can\.contains\("egress-any"\)/);
  // Less the pool's group networks, which are no way out (vm-groups-in-apps).
  assert.match(SCREEN, /ForEach\(inv\.choosable\.filter \{ anyWayOut \|\| choice\.networks\.contains\(\$0\.id\) \}\)/);
  assert.ok(SCREEN.includes('Any of the pool’s networks can be it. One the fleet’s VMs may not use is the better, so no lab can skip the router.'));
  // What goes to the machine, which checkPolicy reads, and its one rule.
  const POLICY = read('apps/ios/Fleetwright/XOPolicy.swift');
  assert.match(POLICY, /"edge": edge,/);
  assert.ok(POLICY.includes('The edge router needs a way out: choose the network its WAN goes on.'));
});

// ─── Android ────────────────────────────────────────────────────────────────

const KT = 'apps/android/app/src/main/java/network/thetech/fleetwright/';
const SAVED_KT = read(`${KT}XoSaved.kt`);
const SHEET = read(`${KT}HypervisorSheet.kt`);
/** One local function's text in the sheet, to the next one at the same depth. */
const kfn = (/** @type {string} */ name) => {
  const at = SHEET.search(new RegExp(`\\n {4}(?:suspend )?fun ${name}\\(`));
  assert.ok(at > 0, `no ${name}`);
  const next = SHEET.slice(at + 1).search(/\n {4}(?:suspend )?fun |\n {4}\/\/ |\n {4}LaunchedEffect/);
  return bare(SHEET.slice(at, next > 0 ? at + 1 + next : undefined));
};

test('Android: what is kept opens after a strong fingerprint or face, under a key of its own, and is offered only where it can be', () => {
  // Every use, after a strong check; retired by a new fingerprint or face.
  assert.match(SAVED_KT, /\.setUserAuthenticationRequired\(true\)\s*\.setUserAuthenticationParameters\(0, KeyProperties\.AUTH_BIOMETRIC_STRONG\)\s*\.setInvalidatedByBiometricEnrollment\(true\)/);
  // Not the fleet credential's key, which opens on a locked phone.
  assert.match(SAVED_KT, /private const val KEY_ALIAS = "fleetwright\.xo-saved"/);
  assert.match(SAVED_KT, /BiometricPrompt\.CryptoObject\(cipher\)/);
  assert.match(read('apps/android/app/src/main/AndroidManifest.xml'), /<uses-permission android:name="android\.permission\.USE_BIOMETRIC" \/>/);
  // The box exists only when a strong check is enrolled (C-2).
  assert.match(SAVED_KT, /canAuthenticate\(BiometricManager\.Authenticators\.BIOMETRIC_STRONG\) == BiometricManager\.BIOMETRIC_SUCCESS/);
  assert.match(SHEET, /if \(canKeep\) \{[\s\S]{0,2400}?Text\("Keep on this phone, behind your fingerprint or face"/);
  assert.match(SHEET, /if \(!on && keepLoaded\) \{\s*XoSaved\.forget\(settings, address\.trim\(\)\)/);
});

test('Android: a kept acceptance stands for the certificate it was given for and no other', () => {
  assert.match(SAVED_KT, /if \(cert != null\) return acceptedPin == cert\s*return XoSetup\.plain\(probe\) && acceptedPlain/);
  // The box comes back whenever the kept word does not match.
  assert.match(SHEET, /if \(kept\) \{\s*Text\(\s*"You accepted this certificate before, and this phone kept that behind your fingerprint or face\."/);
  assert.match(SHEET, /\} else \{\s*Row\([\s\S]{0,300}?toggleable\(value = acknowledged/);
  assert.match(kfn('begin'), /val trust = if \(plain\) null else XoSetup\.trustFor\(p\.certificate, acknowledged \|\| kept\)/);
});

test('Android: nothing is written until the machine has signed in with it, and a password that stops working is dropped', () => {
  const note = kfn('notePath');
  assert.match(note, /val past = s\.state == "done" \|\| s\.state == "choosing" \|\|\s*\(s\.state == "running" && phase\.isNotEmpty\(\) && phase != "connect" && phase != "sign-in"\)/);
  assert.match(note, /if \(past\) \{[\s\S]*?XoSaved\.keep\(settings, where, it\)[\s\S]*?return\s*\}/);
  assert.equal((bare(SHEET).match(/XoSaved\.keep\(/g) ?? []).length, 1, 'something else writes what is kept');
  assert.match(note, /phase == "sign-in" && keepLoaded\) \{\s*XoSaved\.forget\(settings, where\)/);
  // Sealed while the password is still here, before the machine's seal, and
  // dropped when the send is refused.
  for (const name of ['run', 'runPolicy']) {
    assert.match(kfn(name), /pendingSave = pick\?\.let \{ sealToKeep\(it, p\.email\) \}\s*val sealed = Xo(?:Setup|Policy)\.sealSignIn/);
    assert.match(kfn(name), /if \(!r\.ok\) \{\s*pendingSave = null/);
  }
});

test('Android: the machine that got through last time is tried first, and every machine is asked when it does not', () => {
  assert.match(kfn('openRemembered'), /val path = XoSaved\.machine\(settings, address\.trim\(\)\)\?\.let \{ directPath\(it\) \}\s*if \(path != null\) \{[\s\S]*?viaMemory = true\s*return\s*\}\s*probe\(\)/);
  assert.match(kfn('directPath'), /XoHandoff\.pinnedCertificate\(settings, address\.trim\(\)\)/);
  assert.match(kfn('begin'), /\(!r\.ok \|\| setup == null\) && viaMemory -> \{[\s\S]*?probe\(\)\s*refusal = "\$why Your other machines were asked instead\."/);
  assert.match(kfn('startAgain'), /val askAll = viaMemory && progress\?\.state == "failed" && progress\?\.phase == "connect"[\s\S]*?if \(askAll\) probe\(\)/);
  assert.match(kfn('probe'), /chosen = able\.singleOrNull\(\)\?\.hostId \?: able\.firstOrNull \{ it\.hostId == via \}\?\.hostId/);
  assert.match(kfn('notePath'), /if \(past\) \{\s*if \(runningOn\.isNotBlank\(\)\) XoSaved\.rememberMachine\(settings, where, runningOn\)/);
});

test('both phones begin by themselves once Face ID or a fingerprint opened a kept sign-in and a machine is chosen', () => {
  // ASKED FOR: "After FaceID it should auto connect." The unlock is the
  // person saying go: Begin runs once, when a machine is chosen, and never
  // for a sign-in that was typed. Begin's own checks still decide what is sent.
  assert.match(bare(fn(SCREEN, 'unlockRemembered')), /autoBegin = !login\.email\.isEmpty && !login\.password\.isEmpty/);
  assert.match(bare(fn(SCREEN, 'beginWithKept')), /guard autoBegin, let chosen else \{ return \}\s*autoBegin = false\s*guard !busy, job == nil else \{ return \}\s*await begin\(chosen\)/);
  assert.match(bare(fn(SCREEN, 'openRemembered')), /viaMemory = true\s*await beginWithKept\(\)/);
  assert.match(bare(fn(SCREEN, 'probe')), /await beginWithKept\(\)/);
  assert.match(bare(fn(SCREEN, 'choose')), /if autoBegin \{ Task \{ await beginWithKept\(\) \} \}/);
  assert.match(kfn('unlockRemembered'), /autoBegin = !entry\.email\.isNullOrBlank\(\) && !entry\.password\.isNullOrBlank\(\)/);
  assert.match(bare(SHEET), /LaunchedEffect\(autoBegin, pick\?\.hostId\) \{\s*if \(!autoBegin \|\| pick == null\) return@LaunchedEffect\s*autoBegin = false\s*if \(!beginning && job == null\) begin\(\)/);
});

test('both phones say the same things about what is remembered', () => {
  for (const words of [
    'Got through last time, so it is tried first',
    ' got through last time and did not this time.',
    'The kept sign-in did not work, so this phone no longer keeps it.',
    ' Your other machines were asked instead.',
    'checks it again before signing in.',
    'The network the edge router, an OPNsense VM, will put its WAN on',
    'downloads OPNsense once, about 470 MB, and builds it while you wait.',
    'It is there and running. Apply keeps its WAN on this network.',
    'It is there and stopped. Apply keeps its WAN on this network and starts it.',
    'is too old to build the router; update it to have it built from here.',
    'Any of the pool’s networks can be it. One the fleet’s VMs may not use is the better, so no lab can skip the router.',
  ]) {
    assert.ok(SCREEN.includes(words), `iOS: ${words}`);
    assert.ok(SHEET.includes(words) || read(`${KT}PolicyForm.kt`).includes(words), `Android: ${words}`);
  }
});
