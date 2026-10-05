// Changing what the fleet may use on a pool, from the iPhone: what leaves the
// phone, under which binding, and when. docs/hypervisors.md, "The policy".
//
//   node --test test/xopolicy-ios-in-apps.test.js
//
// A read of the sources, like xosetup-in-apps.test.js, whose begin, key check
// and seal this flow reuses and which pins those. What is pinned here is what
// the policy job adds: the two new bindings, held to the host's own
// definitions in seal.js; the key the inventory comes back to staying in
// memory; `purpose` inside the seal where the coordinator cannot reach it;
// the machine asked whether it can before anything is sealed; and the entry,
// for a known admin only. The arithmetic (defaults, bounds, the payload's
// shape) is run by XOPolicyTests.swift; the host's half by xo-setup.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';
import { xosetupInventoryAad, xosetupPolicyAad } from '../src/fleet/seal.js';

const IOS = iosSources();
const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SCREEN = read('apps/ios/Fleetwright/AddHypervisorView.swift');
const POLICY = read('apps/ios/Fleetwright/XOPolicy.swift');
/** Code without its commentary, so a rule is never confused with a note about one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
/** One function's text, from its declaration to the next declaration at the same depth. */
const fn = (/** @type {string} */ src, /** @type {string} */ name) => {
  const at = src.indexOf(`private func ${name}(`);
  assert.ok(at > 0, `no ${name}`);
  const next = src.indexOf('\n    private func ', at + 1);
  return src.slice(at, next > 0 ? next : undefined);
};

test('iOS: the inventory and the choice travel under the bindings the host seals and opens them under', () => {
  for (const [swift, js] of /** @type {const} */ ([
    ['xosetupInventoryAAD', xosetupInventoryAad],
    ['xosetupPolicyAAD', xosetupPolicyAad],
  ])) {
    const m = new RegExp(`static func ${swift}\\(job: String, address: String\\) -> String \\{ "([^"]+)" \\}`).exec(IOS);
    assert.ok(m, `no ${swift}`);
    const built = m[1].replace('\\(job)', 'J0').replace('\\(address)', 'A0');
    assert.equal(built, js('J0', 'A0'), `${swift} is not seal.js's binding`);
  }
  // Opened with the key this phone sent, under the inventory's binding; the
  // choice sealed to the job's key, under the policy's.
  assert.match(POLICY, /Seal\.open\(key, aad: Seal\.xosetupInventoryAAD\(job: job, address: address\)/);
  assert.match(fn(SCREEN, 'applyPolicy'), /Seal\.seal\(\s*to: policyJob\.key,\s*aad: Seal\.xosetupPolicyAAD\(job: job, address: policyJob\.address\),\s*payload: choice\.payload\(in: inv\)/);
});

test('iOS: the key the inventory comes back to is made for the screen and kept nowhere', () => {
  const send = fn(SCREEN, 'sendForPolicy');
  assert.match(send, /let reply = Seal\.newKey\(\)/);
  // Not the hand-off's key, which waits in the Keychain for a token and is
  // collected at every launch: nothing comes back to a policy job later.
  assert.ok(!bare(send).includes('XOSetupHandoff'), 'the policy sign-in reaches for the hand-off');
  // And nothing in the policy code writes anything anywhere.
  for (const code of [bare(send), bare(fn(SCREEN, 'applyPolicyState')), bare(fn(SCREEN, 'applyPolicy')), bare(POLICY)]) {
    for (const store of ['UserDefaults', 'Keychain', 'FileManager', 'outbox', 'Outbox']) {
      assert.ok(!code.includes(store), `the policy flow touches ${store}`);
    }
  }
  // No Live Activity: the machine waits on the person, who is on the screen.
  assert.ok(!bare(send).includes('XOSetupActivities'), 'a policy job starts a Live Activity');
  // The setup path dispatches to it before it makes the hand-off key.
  const setup = fn(SCREEN, 'send');
  assert.ok(setup.indexOf('await sendForPolicy(begun)') < setup.indexOf('XOSetupHandoff.newKey('), 'the policy path makes a hand-off key');
});

test('iOS: `purpose: policy` is inside the seal, beside the sign-in and the reply key, and never a param', () => {
  const send = fn(SCREEN, 'sendForPolicy');
  assert.match(
    send,
    /Seal\.seal\(\s*to: begun\.key,\s*aad: Seal\.xosetupAAD\(job: begun\.job, address: begun\.address\),\s*payload: \[\s*"v": 1,\s*"xo": \["email": [^\]]*, "password": password\],\s*"reply": reply\.publicKey,\s*"purpose": "policy",\s*\]/,
  );
  // Sealed, then the password cleared, then sent.
  const sealAt = send.indexOf('Seal.seal(');
  const clearAt = send.indexOf('password = ""');
  const sendAt = send.indexOf('fleet.runSetup(');
  assert.ok(sealAt > 0 && clearAt > sealAt && sendAt > clearAt, 'the password is not cleared between sealing and sending');
  // The coordinator sees a policy job only as a phase it relays.
  assert.doesNotMatch(bare(IOS), /params[^\n]*"purpose"|"purpose": "policy", "job"/);
  assert.match(IOS, /intent\("xosetup", params: \["phase": "policy", "job": job, "sealed": sealed\],/);
});

test('iOS: the machine is asked whether it can take a policy before anything is sealed to it', () => {
  // In begin: the answer's `can`, before the key check and before send.
  const begin = SCREEN.slice(SCREEN.indexOf('private func begin('), SCREEN.indexOf('private func approvedFingerprint('));
  const askAt = begin.indexOf('if isPolicy, !can.contains("policy") {');
  assert.ok(askAt > 0, 'begin does not ask the machine');
  assert.ok(askAt < begin.indexOf('await send()'), 'send is reachable before the machine is asked');
  assert.match(begin.slice(askAt), /^if isPolicy, !can\.contains\("policy"\) \{\s*_ = try\? await fleet\.cancelSetup\(job: begunJob\)\s*refuse\("\\\(machine\) is older than changing what the fleet may use, so the sign-in was not sent\. Update that machine, then try again\."\)\s*return/);
  // And again where the seal is.
  const send = fn(SCREEN, 'sendForPolicy');
  assert.ok(send.indexOf('guard begun.can.contains("policy") else') < send.indexOf('Seal.seal('));
  // A machine that did not say is a machine that cannot.
  assert.match(SCREEN, /let can = setup\.can \?\? \[\]/);
});

test('iOS: the choice is sent with an idempotency key and never held', () => {
  assert.match(IOS, /func setupPolicy\(job: String, sealed: String\) async throws -> Reply \{\s*try await intent\("xosetup", params: \["phase": "policy", "job": job, "sealed": sealed\],\s*idempotencyKey: "app-\\\(UUID\(\)\.uuidString\)"\)/);
  // A refusal leaves the form standing with the machine's sentence; Apply is
  // offered only for a choice it would take (C-2).
  assert.match(fn(SCREEN, 'applyPolicy'), /if answer\.ok == false \{ refuse\(answer\.text \?\?/);
  assert.match(SCREEN, /Button\(busy \? "Applying…" : "Apply"\)[^\n]*\n\s*\.disabled\(busy \|\| problem != nil\)/);
});

test('iOS: the pools this phone holds are listed on Machines for a known admin only, each leading to its policy', () => {
  assert.match(IOS, /if settings\.configured && settings\.showsAdmin && !hypervisors\.isEmpty \{\s*hypervisorRows\s*\}/);
  assert.match(IOS, /AddHypervisorView\(settings: settings, policyFor: pool\.address\)/);
  // The list is written where the token is kept, and nowhere else.
  const handoff = read('apps/ios/Fleetwright/XOSetupHandoff.swift');
  assert.match(handoff, /Keychain\.set\(text, for: tokenAccount\(entry\.address\)\)\s*remember\(entry\.address\)/);
  assert.equal((bare(IOS).match(/remember\(/g) ?? []).length, 2, 'the held list is written from somewhere other than collect');
  // In policy mode the address is the one held, not one typed.
  assert.match(SCREEN, /\.disabled\(job != nil \|\| busy \|\| isPolicy\)/);
});
