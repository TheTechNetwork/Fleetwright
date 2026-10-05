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
  assert.match(open, /if let via = XOSaved\.machine\(for: trimmedAddress\), let path = directPath\(via\) \{[\s\S]*?viaMemory = true\s*return\s*\}\s*await probe\(\)/);
  // Only with a certificate that needs nobody's word, or the person's kept
  // word for it; anything else is asked of every machine.
  const direct = bare(fn(SCREEN, 'directPath'));
  assert.match(direct, /if let accepted = remembered\?\.accepted/);
  assert.match(direct, /if let pinned = XOSetupHandoff\.pinnedCertificate\(trimmedAddress\), pinned\.trusted/);
  // Refused at begin (gone, switched off): every machine is asked.
  assert.match(bare(fn(SCREEN, 'begin')), /if viaMemory \{\s*await probe\(\)\s*refuse\("\\\(why\) Your other machines were asked instead\."\)/);
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

test('iOS: the way out names the router it is for, and says it is not built yet', () => {
  assert.ok(SCREEN.includes('The network the edge router, an OPNsense VM, will put its WAN on'));
  assert.ok(SCREEN.includes('The router is not built yet: choosing now records it in Xen Orchestra as the fleetwright-egress tag '));
});
