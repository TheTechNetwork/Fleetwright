// Adding a hypervisor from the Android phone: the screen, what it checks
// before it seals anything, and the one notification its progress becomes.
//
//   node --test test/xosetup-android-in-apps.test.js
//
// A read of the Kotlin, like the other *-in-apps tests: it compiles only in
// CI. The arithmetic (the signing input, the raw-to-DER signature, the seal
// under its AAD) is RUN by XoSetupTest.kt; what is pinned here is what a
// person meets and what the coordinator relies on: the verbs in order, the
// check between `begin` and `run`, the password's lifetime, and the words,
// which are iOS's too (test/xosetup-in-apps.test.js). The coordinator's half
// is xosetup-coordinator.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { androidSources } from './helpers/android-sources.js';
import { XOSETUP_STEPS } from '../src/fleet/protocol/intents.js';

const ANDROID = androidSources();
const DIR = new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/', import.meta.url);
const file = (/** @type {string} */ name) => readFileSync(new URL(name, DIR), 'utf8');

test('Android: Add a hypervisor is on Machines, for admins only', () => {
  const machines = file('MachinesScreen.kt');
  assert.match(machines, /if \(admin == true\) \{\s*OpenRow\("Add a hypervisor"\)/);
  assert.ok(machines.includes('OpenRow("Add a machine")'), 'beside Add a machine, not instead of it');
});

test('Android: the screen asks the address, probes, then begins, runs, polls and cancels, in that order', () => {
  const sheet = file('HypervisorSheet.kt');
  const order = [
    'fleet.xoprobe(address.trim())',
    'fleet.xosetup("begin", address = where, pin = pin, host = p.hostId)',
    'fleet.xosetup("run", job = setup.job, sealed = sealed)',
    'fleet.xosetup("status", job = id)',
    'fleet.xosetup("cancel", job = setup.job)',
  ];
  // `run` is written above `begin` as a function the check calls, so the
  // order asserted is the one a person goes through, by call site.
  const at = order.map((call) => {
    const i = sheet.indexOf(call);
    assert.ok(i >= 0, `the screen never sends: ${call}`);
    return i;
  });
  assert.ok(at[0] < at[1], 'probe before begin');
  assert.ok(at[3] > at[2] && at[4] > at[2], 'status and cancel after run');
  // The address field takes no scheme, and says so.
  assert.ok(sheet.includes('A host name or IP address, with a port if it is not 443. No https://.'));
  // Only a machine that reached it over TLS with a certificate is offered.
  assert.match(sheet, /filter \{ it\.reachable && it\.tls && it\.cert != null \}/);
});

test('Android: begin goes to the chosen machine; every later phase names the job alone', () => {
  const fleet = file('Fleet.kt');
  // The client passes `host` only when given it, and the sheet gives it on begin only.
  assert.match(fleet, /suspend fun xosetup\([\s\S]*?host: String\? = null,[\s\S]*?intent\(\s*"xosetup"/);
  const sheet = file('HypervisorSheet.kt');
  for (const later of ['"run"', '"status"', '"cancel"']) {
    const line = sheet.split('\n').find((l) => l.includes(`fleet.xosetup(${later}`));
    assert.ok(line && !line.includes('host ='), `${later} must not name a host: ${line}`);
  }
});

test('Android: the key is verified against the documented signing input before anything is sealed', () => {
  const xo = file('XoSetup.kt');
  // The exact bytes: context line, then the four values as sorted, unspaced JSON.
  assert.ok(xo.includes('"agent-fleet/v1/xosetup-key\\n{\\"address\\":\\"$address\\",\\"job\\":\\"$job\\",\\"key\\":\\"$key\\",\\"pin\\":\\"$pin\\"}"'));
  // ECDSA P-256 with SHA-256, raw r||s wrapped as DER for java.security.
  assert.ok(xo.includes('Signature.getInstance("SHA256withECDSA")'));
  assert.ok(xo.includes('require(raw.size == 64)'));
  assert.ok(xo.includes('verify(derFromRaw(raw))'));
  // The same fingerprint the vault approval uses, over the same canonical key.
  const sheet = file('HypervisorSheet.kt');
  assert.ok(sheet.includes('PhoneVault.fingerprint(setup.hostKey!!)'));
  // The check sits between begin and run: a failed signature is a hard stop
  // that says the key did not come from the machine, and nothing is sent.
  const begin = sheet.indexOf('fleet.xosetup("begin"');
  const verify = sheet.indexOf('XoSetup.verifyKeySig(setup.hostKey, setup.keySig');
  const sealed = sheet.indexOf('XoSetup.sealSignIn(');
  assert.ok(begin < verify, 'verify after begin');
  assert.ok(verify > 0 && sealed > 0);
  assert.ok(sheet.includes('That key did not come from $hostId. Nothing was sent.'));
  // A key the fleet lists for that machine that differs is the same stop.
  assert.ok(sheet.includes('That key did not come from $hostId: the fleet lists a different key for it. Nothing was sent.'));
  // Approved in the vault and matching: proceed. Otherwise the person compares.
  assert.match(sheet, /grants\?\.any \{ it\.fingerprint == fingerprint \}/);
  assert.match(sheet, /approved -> run\(setup, hostId\)/);
  assert.ok(sheet.includes('Compare this with what fleetwright-sidecar identity prints on $unvouchedHost.'));
  assert.ok(sheet.includes('Text("They match")'));
  assert.ok(sheet.includes('If they differ, cancel: the sign-in has not left this phone, and will not.'));
});

test('Android: the sign-in is sealed with the app’s own seal, to the job’s key, under the documented AAD', () => {
  const xo = file('XoSetup.kt');
  assert.ok(xo.includes('fun aad(job: String, address: String): String = "fleetwright-xosetup/v1:$job:$address"'));
  assert.ok(xo.includes('Seal.seal(key, aad(job, address), payload)'), 'Seal.kt, not a second construction');
  assert.ok(xo.includes('JSONObject().put("v", 1).put("xo", JSONObject().put("email", email).put("password", password))'));
  assert.ok(xo.includes('"${sealed.getString("epk")}.${sealed.getString("iv")}.${sealed.getString("ct")}"'), 'sent as epk.iv.ct');
});

test('Android: the password lives in memory until it is sealed, and is never written or logged', () => {
  const sheet = file('HypervisorSheet.kt');
  // Dropped the moment the sealed string exists, before the send.
  assert.match(sheet, /val sealed = XoSetup\.sealSignIn\([^\n]*\n\s*password = ""/);
  // And on every way out of the sign-in step.
  const drops = sheet.split('password = ""').length - 1;
  assert.ok(drops >= 5, `the password is cleared on ${drops} paths; expected the seal, the two hard stops, the comparison's Cancel, Start again and Done`);
  // A password field, not a text field.
  assert.match(sheet, /label = \{ Text\("Admin password"\) \},\s*singleLine = true,\s*visualTransformation = PasswordVisualTransformation\(\)/);
  // Nothing persists it: no preferences, no outbox, no log line.
  assert.doesNotMatch(sheet, /SharedPreferences|prefs\.|Log\.[idwe]\(/);
  // Every xosetup send carries an id, which is what keeps it out of the outbox
  // (Fleet.intent holds only id-less sends).
  const fleet = file('Fleet.kt');
  const xosetup = fleet.slice(fleet.indexOf('suspend fun xosetup('), fleet.indexOf('/** Forget a stored credential.'));
  assert.ok(xosetup.includes('idempotencyKey = "app-" + java.util.UUID.randomUUID().toString()'));
  const xoprobe = fleet.slice(fleet.indexOf('suspend fun xoprobe('), fleet.indexOf('suspend fun xosetup('));
  assert.ok(xoprobe.includes('idempotencyKey = "app-"'));
});

test('Android: progress is polled only while the screen is open, and the words are the steps’ words', () => {
  const sheet = file('HypervisorSheet.kt');
  // A LaunchedEffect keyed on the job: leaving the screen cancels it.
  assert.match(sheet, /LaunchedEffect\(job\) \{[\s\S]*?fleet\.xosetup\("status", job = id\)/);
  assert.ok(sheet.includes('delay(2_000)'));
  // The steps, in the host's order, each with its words. Same words as iOS.
  const xo = file('XoSetup.kt');
  const words = {
    connect: 'Reaching Xen Orchestra',
    'sign-in': 'Signing in',
    inventory: 'Reading the pool',
    user: 'Making the fleetwright user',
    'resource-set': 'Setting what it may use',
    token: 'Making its token',
    updates: 'Turning on updates',
    'hand-off': 'Handing over',
  };
  assert.deepEqual(Object.keys(words), [...XOSETUP_STEPS], 'the app knows every step the protocol has, in order');
  let last = -1;
  for (const [key, say] of Object.entries(words)) {
    const i = xo.indexOf(`"${key}" to "${say}"`);
    assert.ok(i > last, `${key} is said as "${say}", in order`);
    last = i;
  }
  assert.ok(xo.includes('return "Step $n of ${maxOf(of, 1)}"'), 'an unknown key is said as its number');
  // Cancel is offered while it runs, and only then.
  assert.match(sheet, /"running", "waiting" -> \{[\s\S]*?Text\(if \(cancelling\) "Cancelling…" else "Cancel"\)/);
});

test('Android: the design’s tokens only, and a change of state moves', () => {
  const sheet = file('HypervisorSheet.kt');
  assert.doesNotMatch(sheet, /Color\(0x|Color\.(Red|Green|Blue|Yellow|Gray|White|Black)\b/, 'no colour outside the palette');
  assert.ok(sheet.includes('trackColor = Design.Palette.track.now'));
  assert.ok(sheet.includes('Design.Palette.active.now'), 'working is active, not the accent');
  assert.ok(sheet.includes('animationSpec = Design.Motion.change()'));
  assert.match(sheet, /fadeIn\(Design\.Motion\.change\(\)\) togetherWith fadeOut\(Design\.Motion\.change\(\)\)/);
  // Every button is at least 48dp, as the design system requires.
  const buttons = sheet.match(/OutlinedButton\(|TextButton\(/g)?.length ?? 0;
  const tall = sheet.match(/modifier = Modifier\.heightIn\(min = 48\.dp\)/g)?.length ?? 0;
  assert.equal(tall, buttons, `${buttons} buttons, ${tall} of them 48dp`);
});

test('Android: kind=xosetup becomes one ongoing notification per job, then one that says how it ended', () => {
  const messaging = file('Messaging.kt');
  assert.match(messaging, /if \(message\.data\[XoSetupNotice\.EXTRA_KIND\] == XoSetupNotice\.KIND\) \{\s*XoSetupNotice\.post\(applicationContext, message\.data\)\s*return/);
  const notice = file('XoSetupNotice.kt');
  // One id per job, so a step replaces the last and the end replaces the bar.
  assert.ok(notice.includes('val id = ("xosetup-$job").hashCode()'));
  assert.ok(notice.includes('NotificationManagerCompat.from(context).notify(id, notification)'));
  // Determinate progress from `of` and `step`; ongoing while running; low
  // importance so a step does not buzz; the end on a channel that may.
  assert.ok(notice.includes('setProgress(of, step, false)'));
  assert.match(notice, /\.setOngoing\(running\)/);
  assert.ok(notice.includes('NotificationChannel(PROGRESS_CHANNEL, "Setup progress", NotificationManager.IMPORTANCE_LOW)'));
  assert.ok(notice.includes('NotificationChannel(RESULT_CHANNEL, "Setup finished", NotificationManager.IMPORTANCE_DEFAULT)'));
  assert.match(notice, /\.setAutoCancel\(!running\)/);
  // Android 16's Live Update, behind the SDK check, and nowhere without it.
  assert.match(notice, /Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.BAKLAVA[\s\S]*?Notification\.ProgressStyle\(\)/);
  assert.ok(notice.includes('.setRequestPromotedOngoing(true)'));
  // The same titles the coordinator sends (core.js #onSetupProgress).
  for (const title of ['Adding a hypervisor', 'Hypervisor added', 'Hypervisor setup stopped', 'Hypervisor setup cancelled']) {
    assert.ok(notice.includes(`"${title}"`), `the notification says: ${title}`);
  }
  // Permission first, as every other notification here.
  assert.match(notice, /checkSelfPermission\(context, Manifest\.permission\.POST_NOTIFICATIONS\)/);
  // And an older update cannot move the bar backwards.
  assert.match(notice, /if \(\(lastShown\[job\] \?: 0L\) > sentAt\) return/);
  // A tap opens the job's progress rather than whatever was on screen last.
  assert.ok(ANDROID.includes('resumingSetup = openSetup'));
  assert.match(file('MainActivity.kt'), /getStringExtra\(XoSetupNotice\.EXTRA_KIND\) != XoSetupNotice\.KIND/);
});
