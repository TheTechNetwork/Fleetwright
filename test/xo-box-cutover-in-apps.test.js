// A user per box, turned on from the policy screen. The first Apply names the
// machines this person approved for the pool; the machine mints a Xen
// Orchestra user for each and seals the tokens back. The next Apply, once
// each of them has a token of its own, asks the machine to hand over what was
// still on the shared user, and the phone drops that item from the vault. The
// copy setup handed this phone stays, because the pool's page still signs in
// with it. docs/hypervisors.md, "A user per box"; docs/security.md, G14.
//
//   node --test test/xo-box-cutover-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. Who is named, and when the shared item is withdrawn, is run by
// XOPolicyTests.swift and XoPolicyTest.kt. The machine's half is
// test/xo-setup.test.js and test/xo-box-users.test.js; what a box is then
// given is test/vault.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const A = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const I = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);

const SAID = 'Each machine you approved for this pool is given a Xen Orchestra user of its own, so none of them can reach the machines another made. The user they share is withdrawn once each of them has its token, and a machine still on that user is handed to the first of them. If this phone cannot read which machines those are, they keep the shared user.';

test('both phones say who gets a user, above Apply, in the same words, and only on a machine that reads the list', () => {
  assert.ok(I('XOPolicy.swift').includes(`static let ownUsers = "${SAID}"`));
  assert.ok(A('XoPolicy.kt').includes(`const val OWN_USERS = "${SAID}"`));
  // SAID ONLY WHERE IT IS DONE (C-2): the machine lists `box-users` in
  // begin's `can`, as it lists every other thing a policy choice may carry.
  assert.match(I('AddHypervisorView.swift'), /if policyJob\?\.canBoxUsers == true \{\s*Text\(XOPolicy\.ownUsers\)/);
  assert.ok(I('AddHypervisorView.swift').includes('canBoxUsers: begun.can.contains("box-users")'));
  assert.ok(A('HypervisorSheet.kt').includes('if (canBoxUsers) Hint(XoPolicy.OWN_USERS)'));
  assert.ok(A('HypervisorSheet.kt').includes('canBoxUsers = "box-users" in p.setup.can'));
  assert.match(read('src/fleet/host/xo-setup.js'), /'edge-ha', 'groups', 'box-users',/);
});

test('Apply names those machines, and withdraws the shared item only with them', () => {
  const ios = I('AddHypervisorView.swift');
  const apply = ios.slice(ios.indexOf('private func applyPolicy('), ios.indexOf('private func follow('));
  assert.ok(apply.includes('if policyJob.canBoxUsers { plan = await XOPolicy.poolPlan(settings: settings, fleet: fleet, address: policyJob.address) }'));
  assert.ok(apply.includes('boxes: plan.boxes, retireShared: plan.withdraw'));
  const android = A('HypervisorSheet.kt');
  const choice = android.slice(android.indexOf('fun applyChoice('), android.indexOf('LaunchedEffect(Unit)'));
  assert.ok(choice.includes('val (boxes, withdraw) = if (canBoxUsers) poolPlan(settings, fleet, address.trim()) else emptyList<String>() to false'));
  assert.ok(choice.includes('XoPolicy.sealChoice(key, setup.job, address.trim(), inv, c, secret, boxes, withdraw)'));
  // CANNOT TELL IS NOT "NO MACHINES" (C-5): a vault or a host list that does
  // not answer names nobody, and naming nobody leaves the shared user.
  assert.match(I('XOPolicy.swift'), /\} catch \{\s*return \(\[\], false\)/);
  assert.ok(android.includes('}.getOrDefault(emptyList<String>() to false)'));
  // Who is named is the same rule on both: not revoked, a name the host can
  // put in a user name, and a grant under that name covering this pool.
  assert.match(I('XOPolicy.swift'), /grant\.only\.isEmpty \|\| grant\.only\.contains\(shared\) \|\| grant\.only\.contains\(own\)/);
  assert.match(A('XoPolicy.kt'), /grant\.only\.isEmpty\(\) \|\| shared in grant\.only \|\| own in grant\.only/);
  // And the box id grammar is the host's (HYPERVISOR_BOX_RE).
  const re = /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,63\}\$/;
  assert.match(read('src/fleet/protocol/hypervisor-name.js'), re);
  assert.match(I('XOPolicy.swift'), re);
  assert.match(A('XoPolicy.kt'), re);
});

test('a finished job files each box’s token and drops the shared item from the vault, and the phone’s own copy stays', () => {
  const ios = I('AddHypervisorView.swift');
  const state = ios.slice(ios.indexOf('private func applyPolicyState('), ios.indexOf('private func applyPolicy('));
  const keep = state.indexOf('XOSetupHandoff.keepBoxUsers(');
  const drop = state.indexOf('policyJob = nil');
  assert.ok(keep > 0 && drop > keep, 'the hand-off is read while the job’s key is still held');
  const hand = I('XOSetupHandoff.swift');
  const records = hand.slice(hand.indexOf('static func boxRecords('), hand.indexOf('static func keepBoxUsers('));
  const kept = hand.slice(hand.indexOf('static func keepBoxUsers('), hand.indexOf('static func machineGrants('));
  assert.ok(records.includes('Seal.xosetupHandoffAAD(job: job, address: address)'), 'under the hand-off binding, as the shared token is');
  assert.ok(!records.includes('Keychain.set') && !records.includes('Keychain.delete'), 'the shared record in the Keychain is not replaced or removed');
  assert.ok(kept.includes('keepHypervisor(fleet, address: address, record: one.record, box: one.box)'));
  assert.ok(kept.includes('vault.forget(fleet, name: "hypervisor:\\(address)")'));
  assert.ok(!kept.includes('Keychain.'), 'forgetting the vault item does not touch the copy this phone signs in with');
  assert.match(I('Fleet.swift'), /var handoff: String\?[\s\S]{0,600}var boxHandoff: String\?/);

  const sheet = A('HypervisorSheet.kt');
  const poll = sheet.slice(sheet.indexOf('LaunchedEffect(job, asks)'), sheet.indexOf('FullScreen('));
  const filed = poll.indexOf('XoHandoff.keepBoxUsers(');
  const cleared = poll.indexOf('watchKey = null');
  assert.ok(filed > 0 && cleared > filed, 'the hand-off is filed in the pass that first sees done, before the key is dropped');
  const kt = A('XoHandoff.kt');
  const body = kt.slice(kt.indexOf('suspend fun keepBoxUsers('), kt.indexOf('fun machineGrants('));
  assert.ok(body.includes('Seal.open(key, aad(job, address)'), 'under the hand-off binding, as the shared token is');
  assert.ok(body.includes('vault.keepHypervisor(fleet, address, record.toString(), box)'));
  assert.ok(body.includes('vault.forget(fleet, "hypervisor:$address")'));
  assert.ok(!body.includes('putSecret') && !body.includes('deleteSecret'), 'the phone’s own record of the pool is not rewritten or removed');
  assert.ok(A('Fleet.kt').includes('boxHandoff = s.optString("boxHandoff").takeIf { it.split(".").size == 3 }'));
});
