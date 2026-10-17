// Reconnecting a pool's servers from the Android phone: where it is offered,
// what is checked before the admin sign-in is sealed, where the outcome's key
// lives, and the notification that offers it.
//
//   node --test test/xoreconnect-android-in-apps.test.js
//
// A read of the Kotlin, like xopolicy-android-in-apps.test.js beside it: it
// compiles only in CI. The arithmetic (the sealed sign-in's shape, the
// outcome's parse and its words, when the pool's page offers it, where a tap
// goes) is RUN by XoReconnectTest.kt; what is pinned here is what the machine
// relies on and a person meets: the binding the machine seals under, the
// order of the checks, the key that never reaches a disk, and a button that
// opens a screen because a fingerprint prompt needs one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as seal from '../src/fleet/seal.js';
import * as intents from '../src/fleet/protocol/intents.js';

const DIR = new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/', import.meta.url);
const file = (/** @type {string} */ name) => readFileSync(new URL(name, DIR), 'utf8');

/** One function, from its signature to its closing brace at its own indentation. */
function fn(/** @type {string} */ source, /** @type {string} */ signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `no ${signature}`);
  const indent = source.slice(source.lastIndexOf('\n', start) + 1, start).match(/^ */)?.[0] ?? '';
  const end = source.indexOf(`\n${indent}}\n`, start);
  assert.ok(end > start, `${signature} has no end`);
  return source.slice(start, end);
}

// THE CONTRACT'S WORDS, until the coordinator's half is on this branch: once
// seal.js and intents.js export them, these tests compare against those
// instead, so a name changed on either side fails here.
const AAD = typeof (/** @type {any} */ (seal).xosetupReconnectAad) === 'function'
  ? /** @type {any} */ (seal).xosetupReconnectAad('$job', '$address')
  : 'fleetwright-xosetup-reconnect/v1:$job:$address';
const SIGNIN_AAD = typeof (/** @type {any} */ (seal).xosetupReconnectSigninAad) === 'function'
  ? /** @type {any} */ (seal).xosetupReconnectSigninAad('$job', '$address')
  : 'fleetwright-xosetup-reconnect-signin/v1:$job:$address';
const STEPS = /** @type {any} */ (intents).XORECONNECT_STEPS ?? ['connect', 'sign-in', 'servers', 'reconnect', 'wait'];

test('Android: the outcome opens under the machine’s binding, and the sign-in goes under one of its own', () => {
  assert.ok(file('Seal.kt').includes(`fun xosetupReconnectAad(job: String, address: String) = "${AAD}"`), AAD);
  const reconnect = file('XoReconnect.kt');
  assert.ok(reconnect.includes('Seal.open(key, Seal.xosetupReconnectAad(job, address), box)'));
  // Never under setup's, which a machine from before reconnect opens and runs
  // as a whole setup: the machine tries this binding when setup's fails.
  assert.ok(file('Seal.kt').includes(`fun xosetupReconnectSigninAad(job: String, address: String) = "${SIGNIN_AAD}"`), SIGNIN_AAD);
  assert.ok(fn(reconnect, 'fun sealSignIn(').includes('Seal.seal(key, Seal.xosetupReconnectSigninAad(job, address), payload)'));
  assert.ok(!fn(reconnect, 'fun sealSignIn(').includes('XoSetup.aad('), 'a reconnect sign-in is never sealed under setup’s binding');
  assert.ok(reconnect.includes('const val PURPOSE = "reconnect"'));
  assert.ok(reconnect.includes('const val SIGNIN = "reconnect-signin"'));
  // The steps, in the protocol's order.
  const keys = [...reconnect.matchAll(/^ {8}"([a-z-]+)" to "/gm)].map((m) => m[1]);
  assert.deepEqual(keys, [...STEPS]);
  // And the outcome comes back from `status` as epk.iv.ct, as the pool does.
  assert.match(file('Fleet.kt'), /result = s\.optString\("result"\)\.takeIf \{ it\.split\("\."\)\.size == 3 \}/);
});

test('Android: a reconnect sign-in goes only to a machine that says it can, asked before anything is sealed', () => {
  const sheet = file('HypervisorSheet.kt');
  const begin = fn(sheet, 'fun begin(');
  const refuse = begin.indexOf('reconnect && XoReconnect.PURPOSE !in setup.can ->');
  assert.ok(refuse > 0, 'begin checks `can` for a reconnect');
  for (const later of ['XoSetup.verifyKeySig(', 'approved -> run(pending)', 'else -> unvouched = pending']) {
    assert.ok(begin.indexOf(later) > refuse, `the can check comes before ${later}`);
  }
  // Refused, its job is let go rather than left holding a slot.
  assert.match(begin.slice(refuse), /refusal = olderThanReconnect\(hostId\)\s*runCatching \{ fleet\.xosetup\("cancel", job = setup\.job\) \}/);
  assert.ok(sheet.includes('"$hostId is older than reconnecting servers, so nothing was sent.'));
  // A machine that lists reconnect but not the binding the sign-in goes under
  // is refused the same way, with its own sentence: a coordinator can add
  // `reconnect` to an older machine's unsigned `can`, but not make it open a
  // seal under a name it does not know.
  const tooOld = begin.indexOf('reconnect && XoReconnect.SIGNIN !in setup.can ->');
  assert.ok(tooOld > refuse, 'begin checks `can` for the reconnect sign-in after `reconnect`');
  for (const later of ['XoSetup.verifyKeySig(', 'approved -> run(pending)', 'else -> unvouched = pending']) {
    assert.ok(begin.indexOf(later) > tooOld, `the reconnect-signin check comes before ${later}`);
  }
  assert.match(begin.slice(tooOld), /refusal = olderThanReconnectSignin\(hostId\)\s*runCatching \{ fleet\.xosetup\("cancel", job = setup\.job\) \}/);
  assert.ok(sheet.includes('"$hostId is too old for this app to send it a reconnect safely, so nothing was sent. Update it,'));
  // And both again at the last line before the seal.
  const run = fn(sheet, 'suspend fun runReconnect(');
  assert.ok(run.indexOf('XoReconnect.PURPOSE !in p.setup.can') < run.indexOf('XoReconnect.sealSignIn('));
  assert.match(run, /if \(XoReconnect\.SIGNIN !in p\.setup\.can\) \{\s*password = ""\s*refusal = olderThanReconnectSignin\(p\.hostId\)\s*return\s*\}/);
  assert.ok(run.indexOf('XoReconnect.SIGNIN !in p.setup.can') < run.indexOf('XoReconnect.sealSignIn('));
  // A reconnect never takes the setup or the policy path.
  assert.match(fn(sheet, 'suspend fun run('), /if \(reconnect\) \{\s*runReconnect\(p\)\s*return\s*\}\s*if \(policy\)/);
});

test('Android: the key the outcome comes back to lives in memory, and goes when the job ends', () => {
  const sheet = file('HypervisorSheet.kt');
  const run = fn(sheet, 'suspend fun runReconnect(');
  assert.match(run, /val reply = Seal\.newKey\(\)\s*pendingSave = [^\n]*\s*val sealed = XoReconnect\.sealSignIn\([^\n]*reply\.publicKey\)\s*password = ""/);
  assert.ok(!run.includes('XoHandoff'), 'the reconnect never touches XoHandoff');
  assert.match(sheet, /var resultKey by remember \{ mutableStateOf<Seal\.OneUseKey\?>\(null\) \}/);
  // Opened once the job is done, and dropped on every end.
  assert.match(sheet, /XoReconnect\.openResult\(sealedOutcome, id, address\.trim\(\), it\)/);
  assert.match(sheet, /if \(reconnect && \(r\.xosetup\.state == "done" \|\| r\.xosetup\.state == "failed" \|\| r\.xosetup\.state == "cancelled"\)\) resultKey = null/);
  assert.doesNotMatch(file('XoReconnect.kt'), /putSecret|Settings|SharedPreferences|Log\.[idwe]\(/);
});

test('Android: what each server came to is shown however the reconnect ended, a failed one most of all', () => {
  const sheet = file('HypervisorSheet.kt');
  // Opened on any end, not only done: the server that did not come back is
  // the one the person needs named.
  assert.match(sheet, /val ended = r\.xosetup\.state == "done" \|\| r\.xosetup\.state == "failed" \|\| r\.xosetup\.state == "cancelled"\s*if \(reconnect && ended && sealedOutcome != null/);
  assert.match(sheet, /reconnect && setup != null && \(setup\.state == "done" \|\| reconnected != null \|\| outcomeUnopened\) -> \{/);
  // And a failed one still offers to start again.
  assert.match(sheet, /if \(setup\.state == "done"\) \{[\s\S]{0,200}?Text\("Done"\)[\s\S]{0,80}?\} else \{[\s\S]{0,160}?startAgain\(\)[\s\S]{0,120}?Text\("Start again"\)/);
});

test('Android: Reconnect on a lost pool’s notification opens the app, for an admin’s push only', () => {
  const notice = file('PoolNotice.kt');
  // An activity, because the fingerprint or face prompt needs a screen; a
  // broadcast would run it with none.
  assert.ok(notice.includes('PendingIntent.getActivity('));
  assert.ok(!notice.includes('getBroadcast'), 'Reconnect is never a broadcast');
  assert.match(notice, /if \(kind == LOST && data\["category"\] == CATEGORY\) \{\s*builder\.addAction\(0, ACTION_TITLE,/);
  assert.ok(notice.includes('const val CATEGORY = "fleet.pool.reconnect"'));
  assert.ok(notice.includes('const val ACTION = "reconnect"'));
  assert.ok(notice.includes('const val ACTION_TITLE = "Reconnect"'));
  // One notification per pool, so the word it is back replaces the word it went.
  assert.ok(notice.includes('val id = (data["name"]?.takeIf { it.isNotBlank() } ?: "$LOST-$address").hashCode()'));
  // Read before the answerable categories, which it is not one of.
  const messaging = fn(file('Messaging.kt'), 'override fun onMessageReceived(');
  assert.ok(messaging.indexOf('PoolNotice.handles(') > 0);
  assert.ok(messaging.indexOf('PoolNotice.handles(') < messaging.indexOf('NotificationAnswers.titlesFor('));
  // The tap is read on a cold start and on a warm one, and Reconnect lands
  // on the reconnect for that address, starting on the machine that noticed.
  const main = file('MainActivity.kt');
  assert.equal(main.match(/notifiedPool\.value = poolNamedBy\(intent\)/g)?.length, 2);
  assert.match(file('MachinesScreen.kt'), /if \(tap\.reconnect\) \{\s*reconnectVia = tap\.hostId\s*reconnectFor = tap\.address/);
  assert.match(file('MachinesScreen.kt'), /HypervisorSheet\(settings, reconnectFor = pool, via = reconnectVia,/);
});

test('Android: the pool’s page offers it to an admin, only when what it read shows a pool gone', () => {
  const page = file('PoolPage.kt');
  assert.match(page, /val reconnect = XoReconnect\.offered\(admin, watch\.phase == PoolWatch\.Phase\.Live, seen, pool\.pools\)/);
  assert.match(page, /if \(admin == true\) \{[\s\S]{0,300}?OpenRow\(Manage\.Words\.changePolicy\) \{ onChangePolicy\(\) \}\s*if \(reconnect\) OpenRow\(Manage\.Words\.reconnectServers\) \{ onReconnect\(\) \}/);
  // The pools it read, by name, from the snapshot the page draws.
  assert.ok(page.includes('val seen = watch.snapshot.list(Manage.Kind.POOL).map { it.name }'));
});

test('Android: the ongoing notification says the coordinator’s titles for a reconnect', () => {
  const notice = file('XoSetupNotice.kt');
  assert.match(notice, /val reconnect = data\["purpose"\] == XoReconnect\.PURPOSE/);
  assert.match(notice, /val title = if \(reconnect\) \{\s*XoReconnect\.title\(state\)/);
  // The coordinator may write the apostrophe as an escape; it is the same word.
  const core = readFileSync(new URL('../src/fleet/coordinator/core.js', import.meta.url), 'utf8').replace(/\\u2019/g, '’');
  const reconnect = file('XoReconnect.kt');
  for (const title of ['Reconnecting Xen Orchestra’s servers', 'Pools back', 'The pools did not come back', 'Reconnecting cancelled']) {
    assert.ok(reconnect.includes(`"${title}"`), `the notification says: ${title}`);
    // Once the coordinator picks them (RECONNECT_TITLES), they must be its words too.
    if (core.includes('RECONNECT_TITLES')) assert.ok(core.includes(`'${title}'`), `the coordinator says: ${title}`);
  }
});
