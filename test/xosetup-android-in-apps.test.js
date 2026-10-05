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
    'fleet.xosetup("begin", address = where, pin = pin, host = p.hostId, trust = trust, plain = if (plain) "accepted" else null)',
    'fleet.xosetup("run", job = p.setup.job, sealed = sealed)',
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
  // A machine that reached it over TLS with a certificate is offered first;
  // one answered in plain HTTP after those, and only with the card that asks
  // (the plain-HTTP test below).
  const xo = file('XoSetup.kt');
  assert.ok(xo.includes('fun pinned(probe: Fleet.Probe): Boolean = probe.reachable && probe.tls && probe.cert != null'));
  assert.ok(xo.includes('fun plain(probe: Fleet.Probe): Boolean = probe.reachable && !probe.tls'));
  assert.match(sheet, /val pinned = probes\.orEmpty\(\)\.filter \{ XoSetup\.pinned\(it\) \}\s*val reachable = pinned \+ probes\.orEmpty\(\)\.filter \{ XoSetup\.plain\(it\) \}/);
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
  assert.match(sheet, /approved -> run\(pending\)/);
  assert.ok(sheet.includes('Compare this with what fleetwright-sidecar identity prints on ${waitingOn.hostId}.'));
  assert.ok(sheet.includes('Text("They match")'));
  assert.ok(sheet.includes('If they differ, cancel: the sign-in has not left this phone, and will not.'));
});

test('Android: the sign-in is sealed with the app’s own seal, to the job’s key, under the documented AAD', () => {
  const xo = file('XoSetup.kt');
  assert.ok(xo.includes('fun aad(job: String, address: String): String = "fleetwright-xosetup/v1:$job:$address"'));
  assert.ok(xo.includes('Seal.seal(key, aad(job, address), payload)'), 'Seal.kt, not a second construction');
  assert.ok(xo.includes('JSONObject().put("v", 1).put("xo", JSONObject().put("email", email).put("password", password)).put("reply", reply)'));
  assert.ok(xo.includes('"${sealed.getString("epk")}.${sealed.getString("iv")}.${sealed.getString("ct")}"'), 'sent as epk.iv.ct');
});

test('Android: the token comes back to this phone, to a key sent inside the seal, and is kept encrypted alone', async () => {
  const { xosetupHandoffAad } = await import('../src/fleet/seal.js');
  const handoff = file('XoHandoff.kt');
  const sheet = file('HypervisorSheet.kt');
  // THE SAME BINDING the machine seals under.
  assert.equal(xosetupHandoffAad('J', 'A'), 'fleetwright-xosetup-handoff/v1:J:A');
  assert.ok(handoff.includes('fun aad(job: String, address: String): String = "fleetwright-xosetup-handoff/v1:$job:$address"'));
  assert.ok(handoff.includes('Seal.open(key, aad(job, address), sealed)'));
  // The key is made before the seal and goes inside it, never as a param.
  assert.match(sheet, /val reply = XoHandoff\.newKey\(settings, p\.setup\.job, p\.where\)\s*(?:pendingSave = [^\n]*\s*)?val sealed = XoSetup\.sealSignIn\([^\n]*reply\.publicKey\)/);
  const xosetup = file('Fleet.kt').slice(file('Fleet.kt').indexOf('suspend fun xosetup('), file('Fleet.kt').indexOf('/** Forget a stored credential.'));
  assert.ok(xosetup.length > 0 && !xosetup.includes('"reply"'), 'the reply key is never an xosetup param');
  // Kept encrypted under the Keystore key, and collected on every sign-in
  // and launch as well as by the open screen.
  assert.ok(file('Fleet.kt').includes('putString("secret.$name.enc", encrypt(value))'));
  assert.ok(handoff.includes('settings.putSecret(tokenName(entry.address), record)'));
  assert.match(file('MainActivity.kt'), /XoHandoff\.collectPending\(settings, fleet\)/);
  assert.match(sheet, /XoHandoff\.collect\(settings, id, r\.xosetup\)\?\.let \{ handedBack = it \}/);
  // Said only once this phone knows (C-5).
  assert.match(sheet, /XoHandoff\.Outcome\.Kept -> Hint\("The token is kept on this phone now, encrypted, and no machine in the fleet keeps a copy\."\)/);
  assert.doesNotMatch(handoff, /Log\.[idwe]\(|println\(/);
});

test('Android: the password lives in memory until it is sealed, and is never written or logged', () => {
  const sheet = file('HypervisorSheet.kt');
  // Dropped the moment the sealed string exists, before the send.
  assert.match(sheet, /val sealed = XoSetup\.sealSignIn\([^\n]*\n\s*password = ""/);
  // And on every way out of the sign-in step.
  const drops = sheet.split('password = ""').length - 1;
  assert.ok(drops >= 5, `the password is cleared on ${drops} paths; expected the seal, the two hard stops, the comparison's Cancel, Start again and Done`);
  // A password field, not a text field.
  assert.match(sheet, /label = \{ Text\("Admin password"\) \},\s*singleLine = true,\s*enabled = !beginning,\s*visualTransformation = PasswordVisualTransformation\(\)/);
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
  // A LaunchedEffect keyed on the job (and on Ask again): leaving the screen cancels it.
  assert.match(sheet, /LaunchedEffect\(job, asks\) \{[\s\S]*?fleet\.xosetup\("status", job = id\)/);
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
  // Cancel is offered while it runs and the fleet has not yet taken one;
  // once it has, the host's sentence stands where the button was (C-2).
  assert.match(sheet, /\(setup\.state == "running" \|\| setup\.state == "waiting"\) && !cancelAccepted -> \{[\s\S]*?Text\(if \(cancelling\) "Cancelling…" else "Cancel"\)/);
  assert.match(sheet, /if \(r\.ok\) \{[\s\S]*?cancelAccepted = true\s*cancelText = r\.text/);
  assert.match(sheet, /\(setup\.state == "running" \|\| setup\.state == "waiting"\) -> \{\s*Hint\(cancelText\.ifBlank \{ "Cancelling after this step\." \}/);
});

test('Android: a poll that is refused stops, says so, and paints no state the fleet did not report', () => {
  const sheet = file('HypervisorSheet.kt');
  // C-5: "Stopped" is the machine's word for its own job. The screen never
  // builds a failed Setup of its own to say it.
  assert.doesNotMatch(sheet, /Fleet\.Setup\(id, "failed"/);
  assert.doesNotMatch(sheet, /Setup\([^)]*"failed"/);
  // The poll ends on the fleet's word that it has no such job, or after five
  // unanswered asks, and the screen says which.
  assert.match(sheet, /if \(r\.code == "unknown_job" \|\| unanswered >= 5\) \{/);
  assert.ok(sheet.includes('"The fleet has no setup with this id for you, so there is nothing more to ask it."'));
  assert.ok(sheet.includes('"Asked five times with no answer, so this has stopped asking."'));
  // Both offer a way on: Ask again (when asking could help) and Start again.
  assert.match(sheet, /if \(!pollGone\) \{\s*OutlinedButton\(onClick = \{ asks\+\+ \}[\s\S]*?Text\("Ask again"\)/);
  // The coordinator's code is read as data beside ok and text, not parsed from the sentence.
  assert.match(file('Fleet.kt'), /code = json\.optJSONObject\("error"\)\?\.optString\("code"\)/);
});

test('Android: a certificate that does not check out is acknowledged, having been shown', () => {
  const xo = file('XoSetup.kt');
  const sheet = file('HypervisorSheet.kt');
  // One line per problem, in the words iOS uses (test/xosetup-in-apps.test.js).
  for (const line of [
    'Self-signed: nothing but the server itself vouches for it.',
    'Signed by an authority this machine does not trust.',
    'Expired on ${',
    'Not valid until ${',
    'Issued for a different name than $address.',
    'This machine could not read the certificate’s details.',
  ]) {
    assert.ok(xo.includes(line), `the app says: ${line}`);
  }
  // The details a person checks against the padlock: who it is for, who
  // signed it, when it is good, which names it carries, and the pin.
  for (const label of ['"Issued to"', '"Issued by"', '"Valid from"', '"Valid until"', '"Names"', '"Certificate SHA-256"']) {
    assert.ok(sheet.includes(label), `the card shows ${label}`);
  }
  // A trusted certificate is one calm line and no question.
  assert.ok(xo.includes('"Its certificate checks out: ${parts.joinToString(", ")}."'));
  assert.match(sheet, /certificate != null && trusted && cert != null -> \{[\s\S]*?Hint\(XoSetup\.trustedLine\(certificate\)/);
  // Otherwise the card that asks: the attention ring, this screen's one
  // tone, and an explicit box at the design's 48dp, off while beginning.
  assert.match(sheet, /fleetCard\(radius = Design\.Radius\.cardSmall, ring = Design\.Palette\.attention\.now\)/);
  assert.match(sheet, /\.heightIn\(min = 48\.dp\)\s*\.toggleable\(value = acknowledged, enabled = enabled, role = Role\.Checkbox/);
  assert.ok(sheet.includes('Checkbox(checked = acknowledged, onCheckedChange = null, enabled = enabled)'));
  assert.ok(sheet.includes('Text("I checked this certificate and trust it"'));
  // Set up is off until the certificate is either fine or acknowledged.
  assert.match(sheet, /val consented = if \(plain\) plainAccepted \|\| kept else \(trusted \|\| acknowledged \|\| kept\)/);
  assert.match(sheet, /enabled = !beginning && email\.isNotBlank\(\) && password\.isNotEmpty\(\) && consented/);
  // The acknowledgement was about one certificate: a new address, a new
  // machine or a new probe each untick it.
  const resets = sheet.split('acknowledged = false').length - 1;
  assert.ok(resets >= 3, `the acknowledgement resets on ${resets} paths; expected the address, the machine and the probe`);
  assert.match(sheet, /address = next\s*probes = null\s*probeText = ""\s*chosen = null\s*acknowledged = false/);
  assert.match(sheet, /chosen = p\.hostId\s*(?:\/\/[^\n]*\n\s*)*acknowledged = false/);
  // `trust = accepted` goes with begin only for an acknowledged certificate
  // that did not check out; a trusted one sends nothing.
  assert.ok(xo.includes('if (c?.trusted == true) null else if (acknowledged) "accepted" else null'));
  // The acknowledgement given now, or kept on this phone for this same
  // certificate (XoSaved, held to the fingerprint in xo-saved-in-apps.test.js).
  assert.ok(sheet.includes('val trust = if (plain) null else XoSetup.trustFor(p.certificate, acknowledged || kept)'));
  assert.match(file('Fleet.kt'), /if \(trust != null\) put\("trust", trust\)/);
  // The coordinator's shape, read tolerantly: trusted only when said AND clean.
  assert.ok(xo.includes('trusted = json.optBoolean("trusted", false) && problems.isEmpty()'));
});

test('Android: a Xen Orchestra answering in plain HTTP can be chosen, once the person has read what would cross the wire', () => {
  const xo = file('XoSetup.kt');
  const sheet = file('HypervisorSheet.kt');
  // What the row says, with `xo` three-valued: the same words as iOS.
  for (const line of [
    'true -> "Reached Xen Orchestra over plain HTTP"',
    'false -> "Reached something over plain HTTP, and it does not look like Xen Orchestra"',
    'null -> "Reached something over plain HTTP; cannot tell whether it is Xen Orchestra"',
  ]) {
    assert.ok(xo.includes(line), `the row says: ${line}`);
  }
  // The old refusal is gone with the rule it stated.
  assert.ok(!xo.includes('Setup needs HTTPS'));
  // The card that asks, in the certificate card's ring, with the stakes in
  // words that name both ends, the fix on the far side, and a 48dp box that
  // says what it does.
  const card = sheet.slice(sheet.indexOf('private fun PlainAsk('), sheet.indexOf('private fun Detail('));
  assert.ok(card.includes('.fleetCard(radius = Design.Radius.cardSmall, ring = Design.Palette.attention.now)'));
  assert.ok(card.includes('Text("This Xen Orchestra answers without HTTPS", style = Design.Style.bodyStrong, color = Design.Palette.attention.now)'));
  assert.ok(card.includes('"The admin password you type, and the token the fleet keeps afterwards, would cross the network between " +'));
  assert.ok(card.includes('"${probe.hostId} and $address unencrypted. Anything on that network could read them."'));
  assert.ok(card.includes('"To give it HTTPS instead: in the installer\'s xo-install.cfg, set PORT=\\"443\\", PATH_TO_HTTPS_CERT, " +'));
  assert.ok(card.includes('"PATH_TO_HTTPS_KEY and AUTOCERT=\\"true\\", then run it again."'));
  assert.match(card, /\.heightIn\(min = 48\.dp\)\s*\.toggleable\(value = accepted, enabled = enabled, role = Role\.Checkbox/);
  assert.ok(card.includes('Checkbox(checked = accepted, onCheckedChange = null, enabled = enabled)'));
  assert.ok(card.includes('Text("Send it without HTTPS anyway"'));
  // Shown instead of the certificate card for a plain machine, and the
  // acceptance gates Set up the way the acknowledgement does.
  assert.match(sheet, /plain -> PlainAsk\(pick, address, plainAccepted, enabled = !beginning, onAccepted = \{ plainAccepted = it \}, kept = kept\)/);
  assert.match(sheet, /val consented = if \(plain\) plainAccepted \|\| kept else \(trusted \|\| acknowledged \|\| kept\)/);
  // Saveable, and reset where the acknowledgement is: the address, the
  // machine and the probe.
  assert.match(sheet, /var plainAccepted by rememberSaveable \{/);
  assert.match(sheet, /acknowledged = false\s*plainAccepted = false\s*val r = fleet\.xoprobe/);
  assert.match(sheet, /chosen = null\s*acknowledged = false\s*plainAccepted = false\s*\}/);
  assert.match(sheet, /chosen = p\.hostId\s*(?:\/\/[^\n]*\n\s*)*acknowledged = false\s*plainAccepted = false/);
  // `begin` for a plain machine: no pin, no trust, `plain = accepted`, and
  // nothing sent until the box is ticked. The key is checked over an empty
  // pin, which is what the machine signed.
  assert.match(sheet, /val plain = XoSetup\.plain\(p\)\s*val pin = if \(plain\) null else \(p\.cert \?: return\)\s*val kept = rememberedAccepts\(p\)\s*if \(plain && !plainAccepted && !kept\) return\s*val trust = if \(plain\) null else XoSetup\.trustFor/);
  assert.ok(sheet.includes('XoSetup.signingInput(where, setup.job, setup.key, pin ?: "")'));
  assert.ok(xo.includes('require(pin.isEmpty() || PIN_RE.matches(pin))'));
  const fleet = file('Fleet.kt');
  assert.match(fleet, /if \(trust != null\) put\("trust", trust\)[\s\S]*?if \(plain != null\) put\("plain", plain\)/);
  assert.match(fleet, /if \(pin != null\) put\("pin", pin\)/, 'no pin key at all for a plain setup, not an empty one');
});

test('Android: a setup in progress survives a rotation and a second notification tap', () => {
  const sheet = file('HypervisorSheet.kt');
  for (const name of ['address', 'chosen', 'acknowledged', 'job', 'runningOn']) {
    assert.match(sheet, new RegExp(`var ${name} by rememberSaveable \\{`), `${name} is saveable`);
  }
  // And the password is not: a Bundle is a place.
  assert.match(sheet, /var password by remember \{ mutableStateOf\(""\) \}/);
  const machines = file('MachinesScreen.kt');
  assert.match(machines, /var addingHypervisor by rememberSaveable \{/);
  assert.match(machines, /var hypervisorJob by rememberSaveable \{/);
  // Keyed on the job, so a tap for another job retargets the open sheet.
  assert.match(machines, /key\(hypervisorJob\) \{\s*HypervisorSheet\(settings, resumeJob = hypervisorJob/);
  // `run` seals under the address and email `begin` was sent with, while the
  // fields stay frozen until it answers.
  assert.match(sheet, /XoSetup\.sealSignIn\(key, p\.setup\.job, p\.where, p\.email, password, reply\.publicKey\)/);
  assert.doesNotMatch(sheet, /sealSignIn\([^\n]*address\.trim\(\)/);
  const frozen = sheet.match(/enabled = !beginning,/g)?.length ?? 0;
  assert.ok(frozen >= 3, `${frozen} inputs freeze while beginning; expected the address, the email and the password`);
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
  // Which is ignored without this permission, so the manifest declares it.
  const manifest = readFileSync(new URL('../apps/android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.ok(manifest.includes('<uses-permission android:name="android.permission.POST_PROMOTED_NOTIFICATIONS" />'));
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

test('Android: a setup goes only to a machine new enough to hand the token back, checked before anything is sealed', () => {
  const sheet = file('HypervisorSheet.kt');
  const guard = sheet.indexOf('!policy && setup.can.isEmpty() -> {');
  assert.ok(guard > 0, 'no guard for a machine too old to hand the token back');
  assert.ok(guard < sheet.indexOf('XoSetup.verifyKeySig('), 'checked after the key, so after the comparison could begin');
  const block = sheet.slice(guard, sheet.indexOf('}', guard));
  assert.match(block, /password = ""/);
  assert.match(block, /keeps the pool's token itself instead of handing it to this phone\. Nothing was sent\./);
  assert.match(sheet.slice(guard, guard + 900), /fleet\.xosetup\("cancel", job = setup\.job\)/);
});
