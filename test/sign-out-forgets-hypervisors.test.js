// Signing out takes the hypervisor credentials with it.
//
// THE GAP. A phone keeps a pool's token by its address, not by whose it is:
// the record setup sealed to the phone, the admin sign-in behind Face ID or a
// fingerprint, the key a running setup's token comes back to, a Proxmox node's
// root password while a run is followed, and the secrets the phone lets a
// pool's own machines in with. Sign out removed the fleet credential and left
// every one of those where it was, so the next person to sign in on the same
// phone could reach every pool the last one had, phone-direct and past the
// coordinator's own checks (docs/manage.md). Found in source by a review;
// not demonstrated on a device, and not waited for.
//
// Neither app compiles here, so this reads their source.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ios = (/** @type {string} */ f) => readFileSync(new URL(`../apps/ios/Fleetwright/${f}`, import.meta.url), 'utf8');
const android = (/** @type {string} */ f) => readFileSync(new URL(`../apps/android/app/src/main/java/network/thetech/fleetwright/${f}`, import.meta.url), 'utf8');
/** A function's body, from its head to the next line at its indent. */
const body = (/** @type {string} */ src, /** @type {string} */ head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone`);
  const indent = /[ \t]*$/.exec(src.slice(0, at))?.[0] ?? '';
  const rest = src.slice(at + head.length);
  const end = rest.search(new RegExp(`\\n${indent}\\}`));
  return rest.slice(0, end < 0 ? undefined : end);
};

test('iOS: sign-out forgets every store that keeps a hypervisor credential', () => {
  const out = body(ios('Fleet.swift'), 'func signOut() {');
  assert.match(out, /credential = ""/);
  for (const store of ['XOSetupHandoff', 'XOSaved', 'ProxmoxDirectHandoff', 'ProxmoxThroughHandoff', 'HolderJoin']) {
    assert.match(out, new RegExp(`${store}\\.forgetAll\\(\\)`), `${store} survives a sign-out`);
  }
  // And each forgetAll empties what its store indexes: the pool tokens by
  // the held list, the waiting keys by the pending list, every saved
  // sign-in by its list, every holder secret in both Keychain services.
  const handoff = body(ios('XOSetupHandoff.swift'), 'static func forgetAll() {');
  assert.match(handoff, /Keychain\.set\("", for: tokenAccount\(address\)\)/);
  assert.match(handoff, /removeObject\(forKey: heldKey\)/);
  assert.match(handoff, /Keychain\.set\("", for: replyAccount\(entry\.job\)\)/);
  assert.match(handoff, /removeObject\(forKey: pendingKey\)/);
  const saved = body(ios('XOSaved.swift'), 'static func forgetAll() {');
  assert.match(saved, /stringArray\(forKey: savedKey\) \?\? \[\] \{ forget\(address\) \}/);
  assert.match(saved, /removeObject\(forKey: viaKey\)/);
  assert.match(body(ios('ProxmoxDirectHandoff.swift'), 'static func forgetAll() {'), /forget\(address: entry\.address\)/);
  assert.match(body(ios('ProxmoxThroughHandoff.swift'), 'static func forgetAll() {'), /forget\(job: entry\.job\)/);
  const holder = body(ios('HolderJoin.swift'), 'static func forgetAll() {');
  assert.match(holder, /\[service, faceService\]/);
  assert.match(holder, /SecItemDelete/);
});

test('Android: sign-out forgets every settings key that keeps a hypervisor credential', () => {
  const out = body(android('YouScreen.kt'), 'fun signOut() {');
  assert.match(out, /settings\.credential = ""/);
  assert.match(out, /settings\.forgetHypervisors\(\)/);
  const forget = body(android('Fleet.kt'), 'fun forgetHypervisors() {');
  // Every prefix a hypervisor credential is written under, and the lists
  // beside them. Each of these names is how the writer spells it.
  for (const key of ['secret.hypervisor.', 'secret.xosetup-reply.', 'secret.pvesetup-reply.', 'secret.pvedirect-password.', 'secret.pvedirect-line.', 'xoSaved.', 'holderSecrets.']) {
    assert.ok(forget.includes(`"${key}"`), `${key} survives a sign-out`);
  }
  for (const key of ['xoHeld', 'xoPending', 'pveDirectPending', 'pvePending']) {
    assert.ok(forget.includes(`"${key}"`), `${key} survives a sign-out`);
  }
  assert.match(forget, /prefs\.all\.keys/);
  // And the names above are the ones the writers use, so a rename there
  // fails here rather than quietly leaving a key behind.
  assert.match(android('XoHandoff.kt'), /fun tokenName\(address: String\) = "hypervisor\.\$address"/);
  assert.match(android('XoHandoff.kt'), /private fun replyName\(job: String\) = "xosetup-reply\.\$job"/);
  assert.match(android('ProxmoxDirectHandoff.kt'), /"pvedirect-password\.\$address"/);
  assert.match(android('ProxmoxDirectHandoff.kt'), /"pvedirect-line\.\$address"/);
  assert.match(android('ProxmoxThroughHandoff.kt'), /"pvesetup-reply\.\$job"/);
  assert.match(android('Fleet.kt'), /"xoSaved\.\$address"/);
  assert.match(android('Fleet.kt'), /"holderSecrets\.\$address"/);
  assert.match(android('Fleet.kt'), /putString\("secret\.\$name\.enc"/);
});

test('both phones say so before the tap, in the same words', () => {
  const sentence = 'Signing out also removes the hypervisor tokens and saved sign-ins this phone holds. A pool whose token you saved to your fleet is still there; one kept only on this phone will need setting up again.';
  assert.ok(ios('YouView.swift').includes(sentence), 'iOS');
  assert.ok(android('YouScreen.kt').includes(sentence), 'Android');
});
