// Reconnecting a pool's servers from the iPhone: what leaves the phone, under
// which binding, and from where a person reaches it. docs/hypervisors.md.
//
//   node --test test/xoreconnect-ios-in-apps.test.js
//
// A read of the sources, like xopolicy-ios-in-apps.test.js, whose begin, key
// check and seal this flow reuses and which xosetup-in-apps.test.js pins. What
// is pinned here is what a reconnect adds: its bindings for the sign-in that
// goes out and for what comes back, held to the contract's text and to
// seal.js once seal.js has them; `purpose` inside the seal beside the reply
// key; the machine asked whether it can open that sign-in before anything is
// sealed; the key kept in memory; its words on the Lock
// Screen; the push's button; and the pool page's row, offered only when the
// page shows the pool is not all there (C-2). What each server's outcome
// reads as, and when the row is offered, is run by XOReconnectTests.swift.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';
import * as intents from '../src/fleet/protocol/intents.js';
import * as seal from '../src/fleet/seal.js';

const IOS = iosSources();
const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SCREEN = read('apps/ios/Fleetwright/AddHypervisorView.swift');
const APP = read('apps/ios/Fleetwright/FleetwrightApp.swift');
const PAGE = read('apps/ios/Fleetwright/ManageView.swift');
const WORDS = read('apps/ios/Fleetwright/XOSetupActivity.swift');
const WIDGET = read('apps/ios/FleetwrightActivity/FleetwrightActivity.swift');
const TABLE = JSON.parse(read('test/fixtures/parity/manage.json'));
/** Code without its commentary, so a rule is never confused with a note about one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
/** One function's text, from its declaration to the next declaration at the same depth. */
const fn = (/** @type {string} */ src, /** @type {string} */ name) => {
  const at = src.indexOf(`private func ${name}(`);
  assert.ok(at > 0, `no ${name}`);
  const next = src.indexOf('\n    private func ', at + 1);
  return src.slice(at, next > 0 ? next : undefined);
};

// The steps, from the protocol once it lists them (the coordinator's branch
// adds XORECONNECT_STEPS), and from the contract they were agreed in until then.
const RECONNECT_STEPS = /** @type {readonly string[]} */ (
  /** @type {any} */ (intents).XORECONNECT_STEPS ?? ['connect', 'sign-in', 'servers', 'reconnect', 'wait']
);

test('iOS: what a reconnect did comes back under the binding the machine seals it with', () => {
  const m = /static func xosetupReconnectAAD\(job: String, address: String\) -> String \{ "([^"]+)" \}/.exec(IOS);
  assert.ok(m, 'no xosetupReconnectAAD');
  const built = m[1].replace('\\(job)', 'J0').replace('\\(address)', 'A0');
  assert.equal(built, 'fleetwright-xosetup-reconnect/v1:J0:A0');
  // The same string seal.js builds, once seal.js builds it.
  const js = /** @type {any} */ (seal).xosetupReconnectAad;
  if (typeof js === 'function') assert.equal(built, js('J0', 'A0'), 'xosetupReconnectAAD is not seal.js’s binding');
  // Opened with the key this phone sent, under that binding and no other.
  assert.match(read('apps/ios/Fleetwright/XOReconnect.swift'), /Seal\.open\(key, aad: Seal\.xosetupReconnectAAD\(job: job, address: address\)/);
  assert.match(IOS, /var result: String\?/);
  assert.match(fn(SCREEN, 'applyReconnectState'), /XOReconnect\.open\(sealed, job: job, address: reconnectJob\.address, key: reconnectJob\.reply\)/);
});

test('iOS: a reconnect’s sign-in goes under a binding of its own, which a machine too old to know reconnect cannot open', () => {
  const m = /static func xosetupReconnectSigninAAD\(job: String, address: String\) -> String \{ "([^"]+)" \}/.exec(IOS);
  assert.ok(m, 'no xosetupReconnectSigninAAD');
  const built = m[1].replace('\\(job)', 'J0').replace('\\(address)', 'A0');
  assert.equal(built, 'fleetwright-xosetup-reconnect-signin/v1:J0:A0');
  const js = /** @type {any} */ (seal).xosetupReconnectSigninAad;
  if (typeof js === 'function') assert.equal(built, js('J0', 'A0'), 'xosetupReconnectSigninAAD is not seal.js’s binding');
  assert.notEqual(built, seal.xosetupAad('J0', 'A0'));
});

test('iOS: `purpose: reconnect` is inside the seal, beside the sign-in and the reply key, and the password goes the moment it is sealed', () => {
  const send = fn(SCREEN, 'sendForReconnect');
  // The shape the host's `run` reads (xo-setup.js): v, xo, reply, purpose.
  assert.match(
    send,
    /Seal\.seal\(\s*to: begun\.key,\s*aad: Seal\.xosetupReconnectSigninAAD\(job: begun\.job, address: begun\.address\),\s*payload: \[\s*"v": 1,\s*"xo": \["email": [^\]]*, "password": password\],\s*"reply": reply\.publicKey,\s*"purpose": "reconnect",\s*\]/,
  );
  const sealAt = send.indexOf('Seal.seal(');
  const clearAt = send.indexOf('password = ""');
  const sendAt = send.indexOf('fleet.runSetup(');
  assert.ok(sealAt > 0 && clearAt > sealAt && sendAt > clearAt, 'the password is not cleared between sealing and sending');
  // The setup path hands a reconnect over before it makes the hand-off key.
  const setup = fn(SCREEN, 'send');
  assert.ok(setup.indexOf('await sendForReconnect(begun)') > 0);
  assert.ok(setup.indexOf('await sendForReconnect(begun)') < setup.indexOf('XOSetupHandoff.newKey('), 'the reconnect path makes a hand-off key');
});

test('iOS: the key what it did comes back to is made for the screen and kept nowhere', () => {
  const send = fn(SCREEN, 'sendForReconnect');
  assert.match(send, /let reply = Seal\.newKey\(\)/);
  for (const code of [bare(send), bare(fn(SCREEN, 'applyReconnectState')), bare(read('apps/ios/Fleetwright/XOReconnect.swift'))]) {
    for (const store of ['UserDefaults', 'Keychain', 'FileManager', 'XOSetupHandoff', 'outbox', 'Outbox']) {
      assert.ok(!code.includes(store), `the reconnect flow touches ${store}`);
    }
  }
  // Dropped once the job is over, however it ended.
  assert.match(fn(SCREEN, 'applyReconnectState'), /if let now = state\.state, !XOSetupWords\.isLive\(now\) \{ reconnectJob = nil \}/);
  // A reconnect collects no token: it is not handed one.
  const apply = fn(SCREEN, 'apply');
  assert.ok(apply.indexOf('if isReconnect {') > 0 && apply.indexOf('if isReconnect {') < apply.indexOf('XOSetupHandoff.collectAndKeep('));
});

test('iOS: the machine is asked whether it can open a reconnect’s sign-in before anything is sealed to it', () => {
  const begin = SCREEN.slice(SCREEN.indexOf('private func begin('), SCREEN.indexOf('private func approvedFingerprint('));
  const askAt = begin.indexOf('if isReconnect, let why = XOReconnect.refusal(can: can, machine: machine) {');
  assert.ok(askAt > 0, 'begin does not ask the machine');
  assert.ok(askAt < begin.indexOf('await send()'), 'send is reachable before the machine is asked');
  assert.match(begin.slice(askAt), /^if isReconnect, let why = XOReconnect\.refusal\(can: can, machine: machine\) \{\s*_ = try\? await fleet\.cancelSetup\(job: begunJob\)/);
  const send = fn(SCREEN, 'sendForReconnect');
  const refusedAt = send.indexOf('if let why = XOReconnect.refusal(can: begun.can, machine: begun.hostId) {');
  assert.ok(refusedAt > 0 && refusedAt < send.indexOf('Seal.seal('), 'the seal is reachable before the machine is asked');
  // `reconnect` alone is refused, in words that say to update that machine:
  // a relay can add it to a machine too old to know it. Which list gets
  // which sentence is run by XOReconnectTests.swift.
  const RECONNECT = read('apps/ios/Fleetwright/XOReconnect.swift');
  const refusal = RECONNECT.slice(RECONNECT.indexOf('static func refusal(can: [String], machine: String) -> String? {'));
  assert.match(bare(refusal), /^static func refusal\(can: \[String\], machine: String\) -> String\? \{\s*if !can\.contains\("reconnect"\) \{\s*return "\\\(machine\) is older than reconnecting Xen Orchestra’s servers, so the sign-in was not sent\."\s*\}\s*if !can\.contains\("reconnect-signin"\) \{\s*return "\\\(machine\) is too old to open the sign-in this app seals for a reconnect, so the sign-in was not sent\."\s*\}\s*return nil/);
  for (const at of [begin.slice(askAt), send.slice(refusedAt)]) assert.match(at, /refuse\("\\\(why\) Update that machine, then try again\."\)/);
});

test('iOS: a reconnect starts where it was asked from: the address named, the machine that noticed, the sign-in Face ID opens', () => {
  assert.match(SCREEN, /init\(settings: Settings, policyFor address: String\? = nil, reconnectFor pool: String\? = nil, via machine: String\? = nil\)/);
  assert.match(SCREEN, /if isPolicy \|\| isReconnect, probes == nil, !probing \{ await openRemembered\(\) \}/);
  // Never offered through this phone, and never an install: it is for a Xen
  // Orchestra the fleet already reaches.
  assert.match(SCREEN, /guard !isReconnect else \{ return false \}\s*guard !isPolicy, job == nil, let all = probes/);
  // On the Lock Screen while it runs, as a reconnect and not a setup.
  assert.match(fn(SCREEN, 'sendForReconnect'), /XOSetupActivities\.start\(fleet: fleet, job: begun\.job, hostId: begun\.hostId, address: begun\.address,\s*progress: answer\.xosetup, purpose: "reconnect"\)/);
});

test('iOS: every reconnect step has words, and its ends are the coordinator’s titles', () => {
  const words = WORDS.slice(WORDS.indexOf('static func phrase('), WORDS.indexOf('static func building('));
  for (const step of RECONNECT_STEPS) {
    assert.match(words, new RegExp(`case "${step}": return (?:"[A-Z][^"]+"|reconnectRunning)`), `no words for the ${step} step`);
  }
  // The titles the contract fixed (RECONNECT_TITLES in core.js), so the
  // banner and the activity read as one sentence.
  assert.match(WORDS, /static let reconnectRunning = "Reconnecting Xen Orchestra’s servers"/);
  assert.match(WORDS, /case "done": return "Pools back"\s*case "failed": return "The pools did not come back"\s*case "cancelled": return "Reconnecting cancelled"/);
  // The source may spell the apostrophe as \u2019; read it as the character.
  const core = read('src/fleet/coordinator/core.js').replaceAll('\\u2019', '\u2019');
  if (core.includes('RECONNECT_TITLES')) {
    for (const title of ['Reconnecting Xen Orchestra’s servers', 'Pools back', 'The pools did not come back', 'Reconnecting cancelled']) {
      assert.ok(core.includes(`'${title}'`), `the coordinator does not say "${title}"`);
    }
  }
  assert.match(WORDS, /if purpose == "reconnect", let end = reconnectEnd\(s\.state\) \{ return end \}/);
  assert.ok(WIDGET.includes('purpose == "reconnect" ? "Xen Orchestra’s servers, on \\(hostId)"'));
});

test('iOS: what each server went through is shown, and done says only what came back', () => {
  for (const words of ['Xen Orchestra’s servers', 'Pools it shows now']) assert.ok(SCREEN.includes(`sectionHead("${words}")`), words);
  assert.match(SCREEN, /ForEach\(Array\(outcome\.servers\.enumerated\(\)\), id: \\\.offset\) \{ _, server in\s*serverRow\(server\)/);
  // A failure is the row in a tone, beside the words that say so.
  assert.match(fn(SCREEN, 'serverRow'), /\.foregroundStyle\(XOReconnect\.failed\(server\) \? Design\.Palette\.bad : Design\.Palette\.inkDim\)/);
  // Done with no pools shown is not "Pools back" (C-5).
  assert.match(fn(SCREEN, 'reconnectHeadline'), /if state\.state == "done", outcome\?\.pools\?\.isEmpty == true \{ return "Done, and Xen Orchestra still shows no pools" \}/);
});

test('iOS: a lost pool’s push has one button, Reconnect, that opens the app behind an unlock', () => {
  const answers = read('apps/ios/Fleetwright/NotificationAnswers.swift');
  assert.match(answers, /static let poolCategory = "fleet\.pool\.reconnect"/);
  assert.match(answers, /static let reconnectAction = "reconnect"/);
  assert.match(answers, /static let reconnectWord = "Reconnect"/);
  assert.match(answers, /options: \[\.foreground, \.authenticationRequired\]/);
  assert.match(bare(answers), /all\.insert\(poolReconnect\(\)\)/);
  // The coordinator sends the same category, once it sends one.
  const core = read('src/fleet/coordinator/core.js');
  if (core.includes('pool-lost')) assert.ok(core.includes("'fleet.pool.reconnect'"), 'the coordinator sends another category');
});

test('iOS: Reconnect opens the reconnect from the machine that noticed, and a tap on the body opens the pool’s page', () => {
  const routed = bare(APP);
  assert.match(routed, /if kind == "pool-lost" \|\| kind == "pool-back", !address\.isEmpty \{\s*if kind == "pool-lost", action == NotificationAnswers\.reconnectAction \{\s*return open\(reconnect: address, via: host\)\s*\}\s*return open\(pool: address\)/);
  assert.match(routed, /let host = info\["hostId"\] as\? String \?\? ""/);
  assert.match(routed, /let address = info\["address"\] as\? String \?\? ""/);
  // Machines pushes it: the reconnect for any pool, a page only for one this
  // phone holds a token for, because that is what the page reads it with.
  const machines = bare(read('apps/ios/Fleetwright/MachinesView.swift'));
  assert.match(machines, /guard wanted\.reconnect \|\| hypervisors\.contains\(where: \{ \$0\.address == wanted\.address \}\) else \{ return \}/);
  assert.match(machines, /if ask\.reconnect \{\s*AddHypervisorView\(settings: settings, reconnectFor: ask\.address, via: ask\.via\)\s*\} else if let pool = hypervisors\.first\(where: \{ \$0\.address == ask\.address \}\) \{\s*PoolManageView\(settings: settings, pool: pool\)/);
  assert.match(bare(read('apps/ios/Fleetwright/FleetView.swift')), /\} else if let pool = note\.userInfo\?\["pool"\] as\? PoolAsk \{\s*openPool = pool\s*tab = \.machines/);
});

test('iOS: the pool’s page offers Reconnect its servers to an admin, only once it has loaded and shows the pool is not all there', () => {
  // The shared table gains the key with the Android change, since both phones'
  // parity tests check its keys exactly; once it is there it must agree.
  if ('reconnectServers' in TABLE.words) assert.equal(TABLE.words.reconnectServers, 'Reconnect its servers');
  assert.match(IOS, /static let reconnectServers = "Reconnect its servers"/);
  assert.match(
    bare(PAGE),
    /if settings\.showsAdmin, Manage\.offersReconnect\(loaded: watch\.phase == \.live, held: pool\.pools, in: watch\.snapshot\) \{\s*NavigationLink \{\s*AddHypervisorView\(settings: settings, reconnectFor: pool\.address, via: watch\.via\)\s*\} label: \{\s*Label\(Manage\.Words\.reconnectServers/,
  );
  // Loaded is live, directly or read through a machine; nothing before.
  assert.match(IOS, /guard loaded else \{ return false \}\s*return s\.list\(\.pool\)\.isEmpty \|\| !missingPools\(held: held, in: s\)\.isEmpty/);
});
