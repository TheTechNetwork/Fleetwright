// A pool's own machine asking to join, on the phones: one approval that lets
// it in and lets it hold that pool and nothing else, checked against the
// secret this phone made before anything is let in, given by the phone that
// made it by itself, offered as a button only when there is a request it
// could not settle, and said in the same words on both.
//
//   node --test test/holder-join-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. The proof itself is run, not read: HolderJoinTests.swift and
// HolderJoinTest.kt hold it to test/fixtures/parity/holder-join.json. ASKED
// FOR: "Should it ask us for a pin we request it from the app it gets Face
// ID", "If I approve why shouldn't it approve both?", and "If I authorize
// the creation of a holder why do I need to let it in? Carry the
// authorization from the creation: if it's the same VM, allow it in".
// docs/hypervisors.md, "A machine of its own".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HYPERVISOR_PREFIX } from '../src/fleet/minter/vault.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const A = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const I = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);

const PHONES = [
  {
    name: 'iOS',
    words: I('HolderJoin.swift'),
    card: I('HoldersAskingView.swift'),
    vault: I('PhoneVault.swift'),
    form: I('AddHypervisorView.swift'),
    push: I('NotificationAnswers.swift') + I('FleetwrightApp.swift'),
    /** A name as Swift interpolates it. */
    put: (/** @type {string} */ v) => `\\(${v})`,
  },
  {
    name: 'Android',
    words: A('HolderJoin.kt'),
    card: A('HoldersAsking.kt'),
    vault: A('PhoneVault.kt'),
    form: A('PolicyForm.kt'),
    push: A('HolderNotice.kt') + A('Messaging.kt'),
    put: (/** @type {string} */ v) => (v.includes('.') ? `\${${v}}` : `$${v}`),
  },
];

/**
 * What both phones say, word for word, with the names they fill in. A long
 * sentence is split where both sources break the line, so each piece is one
 * literal on both.
 */
const SAID = [
  ['{hostId} asks to join'],
  ['To hold {address}. This phone checks it is the machine you made before it lets it in.'],
  ['{hostId} has not asked to join yet. If it never does, make it again from the pool’s policy.'],
  ['Let {hostId} join and hold {address}'],
  ['None of the requests under {hostId} was made by the machine this phone made, so nothing was let in. ', 'Decline it, and make the pool’s own machine again if it never asks.'],
  ['This phone did not make {hostId}, so it cannot check it. Let it in from the phone that applied the policy, or make it again from this one.'],
  ['{hostId} has joined and holds {address}.'],
  ['{hostId} has joined, and could not be approved to hold its pool: {why} Approve it under its page.'],
  ['This phone made {hostId}, so it lets it in by itself once it asks. Nothing to tap.'],
  ['{hostId} joined'],
];

const fill = (/** @type {string} */ s, /** @type {(v: string) => string} */ put, /** @type {Record<string, string>} */ names) =>
  s.replace(/\{(\w+)\}/g, (_, k) => put(names[k] ?? k));

test('the one approval lets the machine hold that pool and nothing else of yours', () => {
  for (const p of PHONES) {
    // The vault's own name for a pool's record, and only it: a grant
    // without `only` would hand the machine every item the person keeps.
    const only = p.name === 'iOS' ? `"only": ["${HYPERVISOR_PREFIX}\\(address)"]` : `.put("only", JSONArray().put("${HYPERVISOR_PREFIX}$address"))`;
    assert.ok(p.vault.includes(only), `${p.name}: the holder's grant is scoped to its pool`);
  }
});

test('nothing is let in before this phone’s secret proves the request, and the key let in is the one proved', () => {
  for (const p of PHONES) {
    // THE ONE APPROVAL IS ONE FUNCTION, for the tap and the quiet pass alike.
    const from = p.words.indexOf(p.name === 'iOS' ? 'static func admit(_ w: Waiting' : 'suspend fun admit(context: Context, settings: Settings, waiting: Waiting');
    assert.ok(from > 0, `${p.name}: HolderJoin.admit`);
    const body = p.words.slice(from);
    const secrets = body.search(/secrets\((for: w\.address|settings, waiting\.address)\)/);
    const unlock = body.search(/unlock\((w\.address|context, settings, waiting), /);
    const proven = body.indexOf('proven(');
    const admit = body.indexOf('.approveHolder(');
    assert.ok(secrets > 0 && unlock > secrets && proven > unlock && admit > proven, `${p.name}: this phone's secrets, then the proof, then the fleet`);
    // A request none of the secrets proves is said, and it stops there.
    assert.match(body.slice(proven, admit), /notProven\(/, `${p.name}: an unproved request is refused in words`);
    // The vault is asked for the same key the fleet let in, after it did.
    const vault = body.indexOf('PhoneVault(');
    assert.ok(vault > admit, `${p.name}: holding the pool follows joining`);
    assert.match(body.slice(vault, vault + 200), /request\.publicJwk/, `${p.name}: the vault approves the key that was proved`);
    // Quietly, only the secrets this phone reads by itself: one from before,
    // behind the owner, is never put up from a background.
    assert.match(body.slice(0, proven), p.name === 'iOS' ? /if quiet\.isEmpty && made\(w\.address\) \{ return \.nothing \}/ : /if \(quiet\.isEmpty\(\) && made\(settings, waiting\.address\)\) return Outcome\.Unsaid/, `${p.name}: a quiet pass over a secret from before says nothing`);
  }
});

test('the phone that made the machine lets it in by itself: on the card as it appears, and from the push that says it asks', () => {
  for (const p of PHONES) {
    // THE CARD: a quiet pass once per request, keyed on the keys asking.
    assert.match(p.card, p.name === 'iOS' ? /\.task\(id: w\.requests\.map\(\\\.key\)\.sorted\(\)\.joined\(separator: ","\)\) \{[\s\S]*?quietly: true/ : /LaunchedEffect\(waiting\.hostId, waiting\.requests\.map \{ it\.key \}\.sorted\(\)\.joinToString\(","\)\) \{[\s\S]*?quietly = true/, `${p.name}: the card lets a proved request in by itself`);
    // THE TAP: the same approval, not quietly.
    assert.match(p.card, p.name === 'iOS' ? /func letIn\(_ w: HolderJoin\.Waiting\) async \{[\s\S]*?quietly: false/ : /fun letIn\(\) = scope\.launch \{[\s\S]*?quietly = false/, `${p.name}: Let it in is the same approval`);
    // THE PUSH: let in by name, and the notification then says it joined.
    assert.match(p.push, p.name === 'iOS' ? /HolderJoin\.admit\(named: hostId, settings: settings\)/ : /HolderJoin\.admit\(context, settings, hostId\)/, `${p.name}: the push lets it in by name`);
    assert.match(p.push, /joinedTitle\(hostId\)/, `${p.name}: the notification says it joined`);
  }
});

test('the secrets are this phone’s own to read, so nobody has to be present; the ones from before stay behind the owner', () => {
  const swift = I('HolderJoin.swift');
  const from = swift.indexOf('static func newSecret(');
  const body = swift.slice(from, swift.indexOf('struct Secret'));
  assert.match(body, /kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/, 'iOS: a new secret is kept as the fleet credential is');
  assert.doesNotMatch(body, /userPresence|SecAccessControlCreateWithFlags/, 'iOS: a new secret is behind the owner');
  assert.match(swift, /private static let service = "network\.thetech\.fleetwright\.holder-join\.2"/);
  assert.match(swift, /private static let faceService = "network\.thetech\.fleetwright\.holder-join"/);
  const kt = A('HolderJoin.kt');
  const quiet = kt.slice(kt.indexOf('private fun quietKey()'), kt.indexOf('private val OAEP'));
  assert.doesNotMatch(quiet, /setUserAuthenticationRequired\(true\)/, 'Android: the key a new secret is sealed to needs the owner');
  assert.match(kt, /private const val QUIET_KEY_ALIAS = "fleetwright\.holder-join\.3"/);
  assert.match(kt, /val cipher = Cipher\.getInstance\("AES\/GCM\/NoPadding"\)\.apply \{ init\(Cipher\.ENCRYPT_MODE, quietKey\(\)\) \}/, 'Android: a new secret is sealed to the quiet key');
});

test('Let it in is on the push, under the category the coordinator sends, and opens Machines', () => {
  const swift = I('NotificationAnswers.swift');
  assert.match(swift, /static let holderCategory = "fleet\.holder\.join"/);
  assert.match(swift, /UNNotificationAction\(identifier: letInAction, title: HolderJoin\.letInWord,\s*options: \[\.foreground, \.authenticationRequired\]\)/, 'iOS: one button, opening the app, behind the lock');
  assert.match(swift, /all\.insert\(holderJoin\(\)\)/, 'iOS: registered at launch with the rest');
  const kt = A('HolderNotice.kt');
  assert.match(kt, /const val CATEGORY = "fleet\.holder\.join"/);
  assert.match(kt, /if \(!joined\) builder\.addAction\(0, HolderJoin\.LET_IN_WORD, openIntent\(context, hostId, id, action = ACTION\)\)/, 'Android: the button only where there is something left to press');
  assert.match(A('Messaging.kt'), /HolderNotice\.handles\(data\["kind"\]\) && \(sealed \|\| data\["category"\] == HolderNotice\.CATEGORY\)/, 'Android: drawn by the app only when it arrives as data');
  for (const p of PHONES) assert.ok(p.words.includes('"Let it in"'), `${p.name}: the word on the button`);
});

test('Let it in and Decline are offered only for a name something has asked under', () => {
  for (const p of PHONES) {
    const offer = p.name === 'iOS' ? /if !w\.requests\.isEmpty && !isIn\(w\) \{/ : /if \(asked && !admitted\) \{/;
    const at = p.card.search(offer);
    assert.ok(at > 0, `${p.name}: the buttons are behind a request`);
    const after = p.card.slice(at);
    assert.ok(after.includes('"Let it in"') && after.includes('"Decline"'), `${p.name}: Let it in and Decline`);
    // And a name nothing has asked under says, on the phone that made it,
    // that it will be let in by itself.
    assert.match(p.card, p.name === 'iOS' ? /if w\.requests\.isEmpty && mine\.contains\(w\.hostId\) \{\s*Text\(HolderJoin\.byItself\(w\.hostId\)\)/ : /if \(!asked && mine\) Text\(HolderJoin\.byItself\(waiting\.hostId\)/, `${p.name}: the line under a name not yet asked under`);
  }
});

test('both phones say it in the same words', () => {
  const names = {
    iOS: { hostId: 'hostId', address: 'address', why: 'why' },
    Android: { hostId: 'hostId', address: 'address', why: 'why' },
  };
  for (const p of PHONES) {
    for (const pieces of SAID) {
      for (const piece of pieces) {
        const said = fill(piece, p.put, names[/** @type {'iOS'|'Android'} */ (p.name)]);
        assert.ok(p.words.includes(said), `${p.name}: ${said}`);
      }
    }
  }
});

test('the policy form offers to make it again, and says what the new one does, in the same words', () => {
  const lines = [
    ['Make it again'],
    ['Removes {name}, disk and all, and makes a new one that asks to join. For one that never joined the fleet.'],
    ['to be awake. Once it is up it asks to join, and this phone ', 'lets it in to hold the pool by itself, as the phone that made it.'],
  ];
  for (const p of PHONES) {
    for (const pieces of lines) {
      for (const piece of pieces) {
        const said = fill(piece, p.put, { name: 'mine.name' });
        assert.ok(p.form.includes(said), `${p.name}: ${said}`);
      }
    }
    // Only from a machine that makes the new one ask (C-2).
    assert.match(p.form, p.name === 'iOS' ? /if choice\.holderAskChoice \{\s*Toggle\(isOn: \$choice\.holderAgain\)/ : /if \(choice\.holderAskChoice\) \{\s*CheckRow\(\s*checked = choice\.holderAgain/);
  }
});

test('on Android a secret from before is opened by the check itself, never a yes or no the app believes', () => {
  // REPORTED BY A SCANNER at HolderJoin.kt's prompt: biometric authentication
  // that does not use a Keystore-backed key can be bypassed by a privileged app
  // or by hooking (Frida). The key needed the owner, but for thirty seconds
  // after ANY check, and the prompt had no CryptoObject: a hooked callback
  // after the phone was unlocked opened every secret. Now the private half
  // needs the owner per use, the prompt is handed the cipher, and only the
  // cipher the system gives back opens a secret. A secret kept since the phone
  // let machines in by itself is not behind the owner at all (above), so this
  // holds for the ones from before, which a tap still opens.
  const kt = A('HolderJoin.kt');
  assert.match(kt, /\.setUserAuthenticationRequired\(true\)\s*\.setUserAuthenticationParameters\(0, KeyProperties\.AUTH_BIOMETRIC_STRONG or KeyProperties\.AUTH_DEVICE_CREDENTIAL\)/, 'the key is usable without a check of its own');
  assert.doesNotMatch(kt, /setUserAuthenticationParameters\([1-9]/, 'a time-bound key is opened by any recent unlock');
  assert.match(kt, /prompt\.authenticate\(\s*BiometricPrompt\.CryptoObject\(cipher\),/, 'the prompt is not bound to the key');
  assert.match(kt, /cont\.resume\(result\.cryptoObject\?\.cipher\)/, 'the app decrypts with something other than what the check authorised');
  assert.match(kt, /val unlocked = authenticate\(context, cipher, title, waiting\.address\) \?: return null\s*val value = runCatching \{\s*String\(unlocked\.doFinal\(/, 'a secret is opened with a cipher the check did not hand back');
  // Nothing sealed to the old key is read, and the old key goes.
  assert.match(kt, /private const val KEY_ALIAS = "fleetwright\.holder-join\.2"/);
  assert.match(kt, /if \(store\.containsAlias\(OLD_KEY_ALIAS\)\) dropKey\(OLD_KEY_ALIAS\)/);
  assert.match(kt, /settings\.holderSecrets\(address\)\.filter \{ it\.startsWith\(QUIET\) \|\| it\.startsWith\(SEALED\) \}/);
});
