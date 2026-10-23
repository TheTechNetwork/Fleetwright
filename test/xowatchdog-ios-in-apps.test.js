// Adding the reconnect watchdog to a Xen Orchestra that predates it, from the
// iPhone, through the pool master that runs its VM. docs/hypervisors.md,
// "When Xen Orchestra loses a pool"; the machine's half is xo-watchdog.test.js.
//
//   node --test test/xowatchdog-ios-in-apps.test.js
//
// A read of the sources, like xodeploy-in-apps.test.js, whose probe, host-key
// question and seal this flow shares. What is pinned is what leaves the phone
// and what a person reads, against the host's and the coordinator's own
// definitions: the phase begun, the bytes the machine signs the job's key
// over (crypto.js `signingInput`, context `xowatchdog-key`), the binding the
// root password is sealed under (seal.js `xowatchdogAad`) and what is inside
// it, the words for each of XOWATCHDOG_STEPS (xo-setup.js STEP_WORDS), the
// coordinator's titles (WATCHDOG_TITLES in core.js), and the pool page's row.
// Whether the key check accepts and refuses the right signatures is run by
// XOSetupKeyTests.swift.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';
import { XOWATCHDOG_STEPS } from '../src/fleet/protocol/intents.js';
import { STEP_WORDS } from '../src/fleet/host/xo-setup.js';
import { xowatchdogAad, xodeployAad } from '../src/fleet/seal.js';
import { signingInput } from '../src/fleet/crypto.js';

const IOS = iosSources();
const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SCREEN = read('apps/ios/Fleetwright/AddWatchdogView.swift');
const PAGE = read('apps/ios/Fleetwright/ManageView.swift');
const WORDS = read('apps/ios/Fleetwright/XOSetupActivity.swift');
const WIDGET = read('apps/ios/FleetwrightActivity/FleetwrightActivity.swift');
/** One function's text, from its declaration to the next declaration at the same depth. */
const fn = (/** @type {string} */ src, /** @type {string} */ name) => {
  const at = src.indexOf(`private func ${name}(`);
  assert.ok(at > 0, `no ${name}`);
  const next = src.indexOf('\n    private func ', at + 1);
  return src.slice(at, next > 0 ? next : undefined);
};

/** The coordinator's titles for a watchdog's job, the banner and the Lock Screen alike. */
const TITLES = Object.freeze({
  running: 'Adding the reconnect watchdog',
  done: 'Watchdog added',
  failed: 'The watchdog was not added',
  cancelled: 'Adding the watchdog cancelled',
});

test('iOS: the pool’s page offers Add the reconnect watchdog to an admin, and the screen starts from the pool master the record names', () => {
  assert.match(
    PAGE,
    /if settings\.showsAdmin, XOSetupKey\.isAddress\(pool\.address\) \{\s*NavigationLink \{\s*AddWatchdogView\(settings: settings, xoAddress: pool\.address\)\s*\} label: \{\s*Label\(WatchdogWords\.title,/,
  );
  assert.match(SCREEN, /static let title = "Add the reconnect watchdog"/);
  // Filled in only from what an install's record says, never guessed.
  assert.match(SCREEN, /let master = XOSetupHandoff\.poolMaster\(of: xoAddress\)\s*_address = State\(initialValue: master \?\? ""\)/);
  assert.match(IOS, /let master = object\["poolMaster"\] as\? String, XOSetupKey\.isAddress\(master\)/);
});

test('iOS: the job is begun as phase `watchdog`, pinned to the host key the person compared, on the machine chosen', () => {
  assert.match(IOS, /intent\("xosetup", params: \["phase": "watchdog", "address": address, "pin": pin\], host: host,/);
  assert.match(fn(SCREEN, 'begin'), /let reply = try await fleet\.beginWatchdog\(address: target, pin: key\.sha256, host: probe\.hostId\)/);
  // Begin waits for the comparison and the password.
  assert.match(SCREEN, /Toggle\(isOn: \$matched\)/);
  assert.match(SCREEN, /\.disabled\(busy \|\| !matched \|\| rootPassword\.isEmpty \|\| !XOSetupKey\.isAddress\(xoAddress\)\)/);
  // An older host's refusal (`host_outdated`) is shown in its own words.
  assert.match(fn(SCREEN, 'begin'), /refuse\(reply\.text \?\? "\\\(probe\.hostId\) did not begin adding the watchdog\."\)/);
});

test('iOS: the job key is checked over the bytes the machine signs, under the watchdog’s context, before anything is sealed', () => {
  const expected = signingInput('xowatchdog-key', { address: 'xcp1.lan', job: 'a1b2c3d4e5f6', key: 'K', pin: 'a'.repeat(64) });
  const [prefix, json] = expected.split('\n');
  assert.ok(IOS.includes(`static let watchdogSigningPrefix = "${prefix}\\n"`));
  assert.deepEqual(Object.keys(JSON.parse(json)), ['address', 'job', 'key', 'pin']);
  assert.ok(IOS.includes('isSignedOverHostKey(watchdogSigningPrefix, key: key, keySig: keySig, hostKey: hostKey, address: address, job: job, pin: pin)'));
  const begin = fn(SCREEN, 'begin');
  assert.match(begin, /guard XOSetupKey\.isSignedForWatchdog\(key: jobKey, keySig: keySig, hostKey: hostKey, address: target, job: begunJob, pin: key\.sha256\) else \{\s*_ = try\? await fleet\.cancelSetup\(job: begunJob\)/);
  assert.ok(begin.indexOf('isSignedForWatchdog(') < begin.indexOf('await send()'), 'send is reachable before the key is checked');
});

test('iOS: the root password and Xen Orchestra’s address are sealed under the watchdog’s own binding, with no reply key', () => {
  assert.ok(IOS.includes(`"${xowatchdogAad('\\(job)', '\\(address)')}"`), 'the same binding as seal.js');
  assert.notEqual(xowatchdogAad('J', 'A'), xodeployAad('J', 'A'));
  const send = fn(SCREEN, 'send');
  assert.match(
    send,
    /Seal\.seal\(\s*to: begun\.key,\s*aad: Seal\.xowatchdogAAD\(job: begun\.job, address: begun\.address\),\s*payload: \[\s*"v": 1,\s*"purpose": "watchdog",\s*"root": \["password": rootPassword\],\s*"xo": \["address": xoAddress\],\s*\]/,
  );
  // Nothing comes back to this job, so nothing is made to come back to.
  assert.ok(!send.includes('"reply"') && !send.includes('XOSetupHandoff'), 'a watchdog’s seal carries a reply key');
  // Cleared the moment it is sealed, before the send.
  const sealAt = send.indexOf('Seal.seal(');
  const clearAt = send.indexOf('rootPassword = ""');
  const sendAt = send.indexOf('fleet.runSetup(');
  assert.ok(sealAt > 0 && clearAt > sealAt && sendAt > clearAt, 'the password is not cleared between sealing and sending');
});

test('iOS: what will happen to Xen Orchestra is said before the button', () => {
  const section = fn(SCREEN, 'passwordSection');
  assert.ok(section.indexOf('WatchdogWords.whatHappens(xoAddress)') < section.indexOf('WatchdogWords.addFrom('));
  assert.ok(SCREEN.includes('is shut down for a minute or two while the watchdog is put on its disk, '));
  assert.ok(SCREEN.includes('"then started again. Xen Orchestra is unavailable meanwhile, and so is this pool’s page."'));
});

test('iOS: every step of adding the watchdog has the host’s words, and its ends are the coordinator’s titles', () => {
  const phrases = WORDS.slice(WORDS.indexOf('static func phrase('), WORDS.indexOf('static func building('));
  for (const key of XOWATCHDOG_STEPS) {
    assert.ok(STEP_WORDS[key], `the host has no words for ${key}`);
    assert.ok(phrases.includes(`case "${key}": return "${STEP_WORDS[key]}"`), `no words for ${key}`);
  }
  // The source may spell the apostrophe as ’; read it as the character.
  const core = read('src/fleet/coordinator/core.js').replaceAll('\\u2019', '’');
  for (const title of Object.values(TITLES)) assert.ok(core.includes(`'${title}'`), `the coordinator does not say "${title}"`);
  assert.match(WORDS, new RegExp(`static let watchdogRunning = "${TITLES.running}"`));
  assert.match(WORDS, new RegExp(`case "done": return "${TITLES.done}"\\s*case "failed": return "${TITLES.failed}"\\s*case "cancelled": return "${TITLES.cancelled}"`));
  assert.match(WORDS, /if purpose == "watchdog", let end = watchdogEnd\(s\.state\) \{ return end \}/);
});

test('iOS: it is on the Lock Screen as a watchdog, and the machine’s last sentence is the result', () => {
  assert.match(
    fn(SCREEN, 'send'),
    /XOSetupActivities\.start\(fleet: fleet, job: begun\.job, hostId: begun\.hostId, address: begun\.address,\s*progress: answer\.xosetup, purpose: "watchdog",/,
  );
  assert.ok(WIDGET.includes('purpose == "watchdog" ? "The reconnect watchdog, on \\(hostId)"'));
  const progress = fn(SCREEN, 'progressSection');
  assert.match(progress, /XOSetupWords\.headline\(\$0, purpose: "watchdog"\) \} \?\? XOSetupWords\.watchdogRunning/);
  assert.match(progress, /if let text = progress\?\.text, !text\.isBlank \{\s*Text\(text\)/);
  // Cancel is a setup's.
  assert.match(fn(SCREEN, 'cancel'), /let reply = try await fleet\.cancelSetup\(job: job\)/);
});
