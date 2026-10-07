// Installing Xen Orchestra from a phone, for a pool that has none: offered only
// when no machine found one, the pool master's SSH host key compared before
// anything is begun, and both passwords reaching one machine and nothing else.
// docs/hypervisors.md, "A pool without Xen Orchestra".
//
//   node --test test/xodeploy-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. What is pinned is what a person sees and what
// leaves the phone, against the host's and the coordinator's own definitions:
// the bytes the machine signs (crypto.js `signingInput`), the binding the
// passwords are sealed under (seal.js `xodeployAad`), the words for each of
// XODEPLOY_STEPS (xo-setup.js STEP_WORDS), and the shortest admin password
// the machine takes. The machine's half is xo-deploy.test.js.
//
// The Android half is below the iOS one, and the sentences both phones say
// are checked against both.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';
import { XODEPLOY_STEPS, XOSETUP_STEPS } from '../src/fleet/protocol/intents.js';
import { STEP_WORDS } from '../src/fleet/host/xo-setup.js';
import { MIN_ADMIN_PASSWORD } from '../src/fleet/host/xo-deploy.js';
import { xodeployAad } from '../src/fleet/seal.js';
import { signingInput } from '../src/fleet/crypto.js';

const IOS = iosSources();
const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const ENTRY = read('apps/ios/Fleetwright/AddHypervisorView.swift');
const SCREEN = read('apps/ios/Fleetwright/DeployXOView.swift');

/** The sentences a person reads on the install screen, which Android says too. */
const DEPLOY_SENTENCES = Object.freeze([
  'This pool has no Xen Orchestra yet',
  'Install Xen Orchestra',
  'Address of the pool master',
  'Find a machine that can reach it over SSH',
  'Which machine installs it',
  'Check this key on the pool master',
  'On the pool master’s console, open Local Command Shell and run:',
  'It matches the pool master’s',
  'The root password goes only to a server that answers with this key.',
  'Root password of the pool master',
  'New password for Xen Orchestra’s admin',
  'At least 12 characters.',
  'Reached its SSH server',
  'Could not reach its SSH server',
  'Cannot tell: it has no ssh-keyscan to look with',
  'Too old to install Xen Orchestra. Update it, then ask again.',
  'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub',
  'admin@admin.net, and its default password is replaced with this one before anything else uses it.',
  'as admin@admin.net with the password you chose.',
]);

test('iOS: installing is offered only when every machine that answered found no Xen Orchestra', () => {
  // C-2: the action exists only where it is the answer. A machine that could
  // not tell (`xo` nil) has not said there is none, so it keeps the offer away.
  assert.match(ENTRY, /return all\.allSatisfy \{ \$0\.reachable == false \|\| \$0\.xo == false \}/);
  assert.match(ENTRY, /guard !isPolicy, job == nil, let all = probes, !all\.isEmpty else \{ return false \}/);
  assert.match(ENTRY, /if noXenOrchestra \{ installSection \}/);
  // What the probe already found is handed over, so nothing is asked twice.
  assert.match(ENTRY, /DeployXOView\(settings: settings, address: trimmedAddress, probes: probes\)/);
});

test('iOS: the probe’s SSH answer is what is offered, and only a machine that reached it and can install', () => {
  // Another address is asked about with the same probe, whose answer says
  // what answered SSH wherever Xen Orchestra did not.
  assert.match(SCREEN, /let reply = try await fleet\.xoprobe\(address: trimmedAddress\)/);
  assert.match(SCREEN, /probe\.ssh\?\.reachable == true && probe\.ssh\?\.deploy == true && hostKey\(probe\) != nil/);
  // An answer with no `ssh` is a machine that did not look, said as that.
  assert.match(SCREEN, /guard let ssh = probe\.ssh else \{ return "Too old to install Xen Orchestra\. Update it, then ask again\." \}/);
  // Cannot tell is said as cannot tell, never as unreachable (C-5).
  assert.match(SCREEN, /case nil:\s*return "Cannot tell: it has no ssh-keyscan to look with"/);
});

test('iOS: the host key is asked about every time, and Install waits for the answer and both passwords', () => {
  assert.match(SCREEN, /Toggle\(isOn: \$matched\)/);
  assert.match(SCREEN, /\.disabled\(busy \|\| !matched \|\| rootPassword\.isEmpty \|\| !DeployWords\.adminPasswordOK\(adminPassword\)\)/);
  assert.match(SCREEN, new RegExp(`static let minAdminPassword = ${MIN_ADMIN_PASSWORD}\\b`));
  assert.ok(SCREEN.includes(`"At least ${MIN_ADMIN_PASSWORD} characters."`));
  // The key the person compared is the one the install is pinned to, as the
  // hex of its digest, which the probe carries beside the fingerprint.
  assert.match(SCREEN, /beginDeploy\(address: target, pin: key\.sha256, host: probe\.hostId\)/);
  assert.match(IOS, /intent\("xosetup", params: \["phase": "deploy", "address": address, "pin": pin\], host: host,\s*idempotencyKey: "app-\\\(UUID\(\)\.uuidString\)"\)/);
});

test('iOS: the job key is checked over the bytes the machine signs, before anything is sealed to it', () => {
  const expected = signingInput('xodeploy-key', { address: 'xcp1.lan', job: 'a1b2c3d4e5f6', key: 'K', pin: 'a'.repeat(64) });
  const [prefix, json] = expected.split('\n');
  assert.ok(IOS.includes(`static let deploySigningPrefix = "${prefix}\\n"`));
  // The keys in canonical order, as the phone writes them by hand.
  assert.deepEqual(Object.keys(JSON.parse(json)), ['address', 'job', 'key', 'pin']);
  assert.ok(IOS.includes('deploySigningPrefix + "{\\"address\\":\\"\\(address)\\",\\"job\\":\\"\\(job)\\",\\"key\\":\\"\\(key)\\",\\"pin\\":\\"\\(pin)\\"}"'));
  // The check comes before the seal, on the path that seals.
  const check = SCREEN.indexOf('XOSetupKey.isSignedForDeploy(');
  const sealed = SCREEN.indexOf('Seal.xodeployAAD(');
  assert.ok(check > 0 && sealed > check);
});

test('iOS: both passwords are sealed under the install’s own binding, with the key the token comes back to', () => {
  assert.ok(IOS.includes(`"${xodeployAad('\\(job)', '\\(address)')}"`), 'the same binding as seal.js');
  assert.match(SCREEN, /"purpose": "deploy",\s*"root": \["password": rootPassword\],\s*"xo": \["password": adminPassword\],\s*"reply": reply\.publicKey,/);
  // Cleared from the screen the moment they are sealed, before the send.
  assert.match(SCREEN, /rootPassword = ""\s*adminPassword = ""\s*toCompare = nil\s*let joined/);
  // The token comes back as a setup's does, and is kept under the address of
  // the Xen Orchestra the record names, which the pool master is beside.
  assert.match(IOS, /at == address \|\| \(record\["poolMaster"\] as\? String == address && XOSetupKey\.isAddress\(at\)\)/);
});

test('iOS: every step of an install has the host’s words, and its end says it installed and added', () => {
  for (const key of XODEPLOY_STEPS.filter((k) => !XOSETUP_STEPS.includes(/** @type {any} */ (k)))) {
    assert.ok(IOS.includes(`case "${key}": return "${STEP_WORDS[key]}"`), `no words for ${key}`);
  }
  // The coordinator's banner titles (DEPLOY_TITLES in core.js), the same words.
  for (const end of ['Xen Orchestra installed and added', 'Installing Xen Orchestra stopped', 'Installing Xen Orchestra cancelled']) {
    assert.ok(IOS.includes(`return "${end}"`), end);
  }
  assert.match(SCREEN, /XOSetupActivities\.start\(fleet: fleet, job: begun\.job, hostId: begun\.hostId, address: begun\.address,\s*progress: answer\.xosetup, purpose: "deploy"\)/);
});

test('iOS: the install screen says each sentence the phones share', () => {
  for (const s of DEPLOY_SENTENCES) assert.ok(IOS.includes(s), s);
});

// THE ANDROID HALF, and what both phones say.

const ANDROID = androidSources();
const SHEET = read('apps/android/app/src/main/java/network/thetech/fleetwright/XoDeploySheet.kt');
const ADD = read('apps/android/app/src/main/java/network/thetech/fleetwright/HypervisorSheet.kt');
const NOTICE = read('apps/android/app/src/main/java/network/thetech/fleetwright/XoSetupNotice.kt');

test('Android: installing is offered only when every machine that answered found no Xen Orchestra', () => {
  assert.match(ADD, /if \(!policy && found\.isNotEmpty\(\) && found\.all \{ !it\.reachable \|\| it\.xo == false \}\) \{/);
  assert.match(ADD, /if \(deploying\) \{\s*XoDeploySheet\(/);
});

test('Android: the probe asks over SSH, and only a machine that reached it and can install is offered', () => {
  // What Add a hypervisor's probe found is handed over, and another address
  // is asked about with the same probe.
  assert.match(ADD, /XoDeploySheet\(settings, address\.trim\(\), probes, onDismiss = \{ deploying = false \}\)/);
  assert.match(SHEET, /val r = fleet\.xoprobe\(address\.trim\(\)\)/);
  assert.match(ANDROID, /val ssh = probe\.ssh \?: return false\s*return ssh\.reachable == true && ssh\.deploy == true && hostKey\(probe\) != null/);
  assert.match(SHEET, /if \(XoDeploy\.canInstall\(p\)\) \{\s*Row\(/);
  // Null stays cannot tell all the way from the wire.
  assert.match(ANDROID, /fun maybe\(key: String\): Boolean\? = s\.takeIf \{ it\.has\(key\) && !it\.isNull\(key\) \}\?\.optBoolean\(key\)/);
});

test('Android: Install waits for the host key and both passwords, and the key is checked before the seal', () => {
  assert.match(SHEET, /enabled = !beginning && matched && rootPassword\.isNotEmpty\(\) && XoDeploy\.adminPasswordOk\(adminPassword\)/);
  assert.match(ANDROID, new RegExp(`const val MIN_ADMIN_PASSWORD = ${MIN_ADMIN_PASSWORD}\\b`));
  assert.match(SHEET, /val pin = XoDeploy\.hostKey\(p\)\?\.sha256 \?: return/);
  assert.match(SHEET, /fleet\.xosetup\("deploy", address = where, pin = pin, host = p\.hostId\)/);
  const [prefix] = signingInput('xodeploy-key', { address: 'a', job: 'b', key: 'c', pin: 'd' }).split('\n');
  assert.ok(ANDROID.includes(`"${prefix}\\n{\\"address\\":\\"$address\\",\\"job\\":\\"$job\\",\\"key\\":\\"$key\\",\\"pin\\":\\"$pin\\"}"`));
  const check = SHEET.indexOf('XoDeploy.signingInput(');
  const sealed = SHEET.indexOf('XoDeploy.sealPasswords(');
  assert.ok(check > 0 && sealed > 0, 'both are on the screen');
  assert.ok(ANDROID.includes(`"${xodeployAad('$job', '$address')}"`), 'the same binding as seal.js');
  assert.match(ANDROID, /\.put\("purpose", "deploy"\)\s*\.put\("root", JSONObject\(\)\.put\("password", rootPassword\)\)\s*\.put\("xo", JSONObject\(\)\.put\("password", adminPassword\)\)\s*\.put\("reply", reply\)/);
  // Cleared the moment they are sealed.
  assert.match(SHEET, /val sealed = XoDeploy\.sealPasswords\([^\n]*\)\s*rootPassword = ""\s*adminPassword = ""/);
  // Kept under the address the record names.
  assert.match(ANDROID, /at == address \|\| \(record\.optString\("poolMaster"\) == address && XoSetup\.ADDRESS_RE\.matches\(at\)\)/);
});

test('Android: every step of an install has the host’s words, and the notification ends saying it installed and added', () => {
  for (const key of XODEPLOY_STEPS.filter((k) => !XOSETUP_STEPS.includes(/** @type {any} */ (k)))) {
    assert.ok(ANDROID.includes(`"${key}" to "${STEP_WORDS[key]}"`), `no words for ${key}`);
  }
  for (const end of ['Xen Orchestra installed and added', 'Installing Xen Orchestra stopped', 'Installing Xen Orchestra cancelled', 'Installing Xen Orchestra']) {
    assert.ok(NOTICE.includes(`-> "${end}"`), end);
  }
  assert.match(NOTICE, /val deploy = data\["purpose"\] == "deploy"/);
});

test('both phones say each sentence of an install the same way', () => {
  for (const s of DEPLOY_SENTENCES) {
    assert.ok(IOS.includes(s), `iOS: ${s}`);
    assert.ok(ANDROID.includes(s), `Android: ${s}`);
  }
});
