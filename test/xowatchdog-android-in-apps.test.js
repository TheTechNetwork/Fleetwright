// Adding the reconnect watchdog to a Xen Orchestra that predates it, from the
// Android phone, through the pool master that runs its VM: where it is
// offered, the key checked before the root password is sealed to it, the
// binding it is sealed under, and the words its steps and its end are said in.
// docs/hypervisors.md, "When Xen Orchestra loses a pool".
//
//   node --test test/xowatchdog-android-in-apps.test.js
//
// A read of the Kotlin, like xodeploy-in-apps.test.js beside it: it compiles
// only in CI. What is pinned is what the machine relies on and a person
// meets, against the host's and the coordinator's own definitions: the bytes
// the machine signs (crypto.js `signingInput`), the binding (seal.js
// `xowatchdogAad`), the words for each of XOWATCHDOG_STEPS (xo-setup.js
// STEP_WORDS) and the titles the coordinator pushes (WATCHDOG_TITLES in
// core.js). The arithmetic is RUN by XoWatchdogTest.kt; the machine's half is
// xo-watchdog.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { XOWATCHDOG_STEPS } from '../src/fleet/protocol/intents.js';
import { STEP_WORDS } from '../src/fleet/host/xo-setup.js';
import { xowatchdogAad } from '../src/fleet/seal.js';
import { signingInput } from '../src/fleet/crypto.js';

const DIR = new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/', import.meta.url);
const file = (/** @type {string} */ name) => readFileSync(new URL(name, DIR), 'utf8');
const WATCHDOG = file('XoWatchdog.kt');
const SHEET = file('XoWatchdogSheet.kt');

/** The coordinator's titles, read from core.js, which does not export them. */
const TITLES = (() => {
  const core = readFileSync(new URL('../src/fleet/coordinator/core.js', import.meta.url), 'utf8');
  const body = core.match(/const WATCHDOG_TITLES = Object\.freeze\(\{([^}]*)\}\)/)?.[1];
  assert.ok(body, 'core.js has WATCHDOG_TITLES');
  return Object.fromEntries([...body.matchAll(/(\w+): '([^']*)'/g)].map((m) => [m[1], m[2]]));
})();

test('Android: an admin’s row on the pool’s page opens it, with the pool master an install kept', () => {
  const page = file('PoolPage.kt');
  assert.match(page, /if \(admin == true\) \{[\s\S]{0,400}?OpenRow\(Manage\.Words\.addWatchdog\) \{ onAddWatchdog\(\) \}/);
  assert.ok(file('Manage.kt').includes('const val addWatchdog = "Add the reconnect watchdog"'));
  // The address it answers on is the one the phone keeps the pool under, and
  // the pool master is read from that record, never guessed.
  assert.match(file('MachinesScreen.kt'), /XoWatchdogSheet\(settings, xoAddress = pool, startPoolMaster = XoHandoff\.poolMaster\(settings, pool\)/);
  assert.match(file('XoHandoff.kt'), /fun poolMaster\(settings: Settings, address: String\): String\? = [\s\S]{0,200}?\.optString\("poolMaster"\)/);
});

test('Android: it is begun as phase `watchdog`, pinned to the host key the person compared, and only then', () => {
  assert.match(SHEET, /val pin = XoDeploy\.hostKey\(p\)\?\.sha256 \?: return\s*if \(!matched\) return/);
  assert.match(SHEET, /fleet\.xosetup\("watchdog", address = where, pin = pin, host = p\.hostId\)/);
  assert.match(SHEET, /enabled = !beginning && matched && rootPassword\.isNotEmpty\(\)/);
  assert.match(SHEET, /HostKeyAsk\(pick\.hostId, address\.trim\(\), key, matched/);
  // An older machine's refusal is said in the coordinator's own words.
  assert.match(SHEET, /!r\.ok \|\| setup == null -> refusal = r\.text\.ifBlank/);
});

test('Android: the job key is checked under `xowatchdog-key` before the root password is sealed to it', () => {
  const [prefix] = signingInput('xowatchdog-key', { address: 'a', job: 'b', key: 'c', pin: 'd' }).split('\n');
  assert.ok(WATCHDOG.includes(`"${prefix}\\n{\\"address\\":\\"$address\\",\\"job\\":\\"$job\\",\\"key\\":\\"$key\\",\\"pin\\":\\"$pin\\"}"`));
  const check = SHEET.indexOf('XoWatchdog.signingInput(');
  const sealed = SHEET.indexOf('XoWatchdog.sealRoot(');
  assert.ok(check > 0 && sealed > 0, 'both are on the screen');
  // The seal happens only in run, which begin reaches after the check.
  assert.match(SHEET, /setup\.key == null \|\| !XoSetup\.verifyKeySig\(setup\.hostKey, setup\.keySig, runCatching \{ XoWatchdog\.signingInput\(where, setup\.job, setup\.key, pin\) \}/);
  assert.ok(SHEET.includes('PhoneVault.approval(it, hostId, setup.hostKey!!)'), 'approved only by a whole-vault grant for that machine');
});

test('Android: the root password and Xen Orchestra’s address are sealed under the job’s own binding, with no reply key', () => {
  assert.ok(WATCHDOG.includes(`"${xowatchdogAad('$job', '$address')}"`), 'the same binding as seal.js');
  assert.ok(WATCHDOG.includes('Seal.seal(key, aad(job, address), payload)'));
  assert.ok(WATCHDOG.includes('const val PURPOSE = "watchdog"'));
  assert.match(WATCHDOG, /\.put\("v", 1\)\s*\.put\("purpose", PURPOSE\)\s*\.put\("root", JSONObject\(\)\.put\("password", rootPassword\)\)\s*\.put\("xo", JSONObject\(\)\.put\("address", xoAddress\)\)\s*val sealed/);
  // Sealed to the pool master's address as begun, with the pool's own
  // address inside, and cleared the moment it is sealed.
  assert.match(SHEET, /val sealed = XoWatchdog\.sealRoot\(key, b\.setup\.job, b\.where, rootPassword, xoAddress\)\s*rootPassword = ""/);
  assert.match(SHEET, /fleet\.xosetup\("run", job = b\.setup\.job, sealed = sealed\)/);
  assert.ok(!SHEET.includes('XoHandoff.newKey'), 'nothing comes back, so no key is made for it');
});

test('Android: every step has the host’s words, in the protocol’s order, and the ends are the coordinator’s titles', () => {
  const keys = [...WATCHDOG.matchAll(/^ {8}"([a-z-]+)" to "/gm)].map((m) => m[1]);
  assert.deepEqual(keys, [...XOWATCHDOG_STEPS]);
  for (const key of XOWATCHDOG_STEPS) assert.ok(WATCHDOG.includes(`"${key}" to "${STEP_WORDS[key]}"`), `no words for ${key}`);
  assert.deepEqual(Object.keys(TITLES).sort(), ['cancelled', 'done', 'failed', 'running']);
  for (const [state, title] of Object.entries(TITLES)) {
    assert.ok(WATCHDOG.includes(state === 'running' ? `else -> "${title}"` : `"${state}" -> "${title}"`), `${state}: ${title}`);
  }
  // The notification draws a watchdog job with them.
  const notice = file('XoSetupNotice.kt');
  assert.match(notice, /val watchdog = data\["purpose"\] == XoWatchdog\.PURPOSE/);
  assert.match(notice, /\} else if \(watchdog\) \{\s*XoWatchdog\.title\(state\)/);
  assert.match(notice, /watchdog -> XoWatchdog\.stepWords\(data\["phase"\], step, of\)/);
});

test('Android: what happens is said before the root password is asked for, and the end is the machine’s sentence', () => {
  assert.ok(WATCHDOG.includes('Xen Orchestra’s VM is shut down for a minute or two while the watchdog is put on its disk, then started again.'));
  assert.ok(WATCHDOG.includes('Xen Orchestra is unavailable meanwhile.'));
  const said = SHEET.indexOf('Text(XoWatchdog.WHAT_HAPPENS');
  const asked = SHEET.indexOf('label = { Text("Root password of the pool master") }');
  assert.ok(said > 0 && asked > said, 'what happens comes before the password field');
  // The job's text is drawn as given: whether the VM was started again is
  // the machine's to say (C-5).
  assert.match(SHEET, /DeployProgress\(setup, stateWords = ::watchdogStateWords, stepWords = XoWatchdog::stepWords\)/);
  assert.match(file('XoDeploySheet.kt'), /setup\.text\?\.let \{ Quoted\(it\) \}/);
});
