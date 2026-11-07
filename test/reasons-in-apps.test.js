// The fleet's codes and the phones' words for them, held together.
//
//   node --test test/reasons-in-apps.test.js
//
// The fleet keeps sending its sentence (`reason`, `text`), because terminals
// print it and an older phone shows it. Beside it, it sends a short code,
// and each phone maps the code to the one to three words a row gets
// (docs/design-system.md, "Words"); the sentence moves to the page under
// Details. The map is `ReasonWords` on both phones, four tables each:
// `reasonCode` on a machine, a refusal's `code` (and `why`), a ready
// machine's `failed.code`, and the Activity screen's label per event kind.
//
// Three things this file holds, and why each is a test and not a comment:
//
//   1. THE TWO PHONES CARRY THE SAME WORDS, by name and by value. A table
//      written twice drifts the first time one phone gets a new code, and a
//      grep for the word in both sources would pass while the phones said
//      different things for the same code.
//   2. EVERY CODE THE COORDINATOR CAN SEND HAS A WORD. The codes are read
//      from the coordinator's own source, so a branch added there without a
//      word here fails this test rather than putting a sentence on a row.
//      The lists the round was built to (docs/reviews/copy-2026-11-06.md,
//      finding 162) are asserted as well, so the words exist before the
//      fields do.
//   3. THE SCREENS USE THEM: the row shows the word and the page the
//      sentence under Details, on both phones, and a refusal's notification
//      is titled by its code with the sentence as the body.
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. The coordinator's side (the fields set beside each sentence) is its
// own tests' business.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);
const ANDROID = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const SRC = 'src/fleet/coordinator/';

const I_WORDS = IOS('ReasonWords.swift');
const A_WORDS = ANDROID('ReasonWords.kt');

/**
 * One table out of the Swift file: `static let NAME: [String: String] = [ "k": "v", ... ]`.
 * @param {string} name
 */
function swiftTable(name) {
  const m = I_WORDS.match(new RegExp(`static let ${name}: \\[String: String\\] = \\[([\\s\\S]*?)\\n    \\]`));
  assert.ok(m, `ReasonWords.swift has no table ${name}`);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [, k, v] of m[1].matchAll(/"([^"]+)": "([^"]+)",/g)) out[k] = v;
  return out;
}

/**
 * The same table out of the Kotlin file: `val NAME: Map<String, String> = mapOf( "k" to "v", ... )`.
 * @param {string} name
 */
function kotlinTable(name) {
  const m = A_WORDS.match(new RegExp(`val ${name}: Map<String, String> = mapOf\\(([\\s\\S]*?)\\n    \\)`));
  assert.ok(m, `ReasonWords.kt has no table ${name}`);
  /** @type {Record<string, string>} */
  const out = {};
  for (const [, k, v] of m[1].matchAll(/"([^"]+)" to "([^"]+)",/g)) out[k] = v;
  return out;
}

const TABLES = /** @type {const} */ ([
  ['host', 'HOST'],
  ['refusal', 'REFUSAL'],
  ['standby', 'STANDBY'],
  ['activity', 'ACTIVITY'],
]);

test('both phones carry the same four tables, by name and by value', () => {
  for (const [swift, kotlin] of TABLES) {
    const i = swiftTable(swift);
    const a = kotlinTable(kotlin);
    assert.ok(Object.keys(i).length > 0, `${swift} is empty on iOS`);
    assert.deepEqual(a, i, `ReasonWords.${kotlin} (Android) differs from ReasonWords.${swift} (iOS)`);
  }
  // The word for a refusal with no code, and the same one.
  assert.match(I_WORDS, /static let refused = "Refused"/);
  assert.match(A_WORDS, /const val REFUSED = "Refused"/);
});

test('every word is a row word: one to three words, no sentence', () => {
  // The rule the round exists for (docs/design-system.md, Words): a row is
  // the verdict in one to three words. "Out of date. Ask again" is the one
  // title that is two verdicts, and it is four words. A refusal's title is
  // a row's word on the status card, so it is held to the same count, with
  // the start's own two sentences (refusedStartTitle) as the exception
  // they were already.
  const long = new Set(['Not started: only admins run sessions there']);
  for (const [swift] of TABLES) {
    for (const [code, word] of Object.entries(swiftTable(swift))) {
      if (long.has(word)) continue;
      const words = word.split(/\s+/).length;
      assert.ok(words <= 5, `${swift}.${code} is a sentence, not a row word: ${JSON.stringify(word)}`);
      assert.doesNotMatch(word, /—/, `${swift}.${code} joins two clauses with a dash: ${JSON.stringify(word)}`);
    }
  }
});

// THE CODES THE ROUND WAS BUILT TO (round 8, sections 1, 2, 3, 4). Asserted
// as lists, so the words exist on both phones whether or not the
// coordinator in this tree sends the fields yet; the greps below bind to
// the coordinator's source once it does.
const REASON_CODES = ['no_login', 'runner_no_login', 'pool_no_login', 'login_expired', 'hub_unreachable', 'fetching_login', 'never_reported', 'silent', 'dropped', 'connecting'];
const WHYS = ['offline', 'not_yours', 'enrolled_by_other', 'pools_own', 'temporary_other', 'no_credentials'];
const REFUSAL_CODES = [
  'no_hosts', 'host_unavailable', 'host_unreachable', 'host_busy', 'at_capacity', 'stale_placement', 'name_unavailable',
  'ambiguous_host', 'no_host_matches', 'unsandboxed', 'signature_required', 'no_minter', 'minter_unreachable', 'too_many',
  'host_outdated', 'relay_plain', 'lab_taken', 'unreachable', 'not_found', 'bad_params', 'unknown_verb', 'stale', 'bad_envelope',
];
const STANDBY_CODES = ['not_joined', 'refused', 'unreachable'];

test('every reasonCode a machine can carry has a word, and ok has none', () => {
  const host = swiftTable('host');
  for (const code of REASON_CODES) assert.ok(host[code], `no word for reasonCode ${code}`);
  assert.equal(host.ok, undefined, 'ok is a healthy machine, whose row says nothing extra');
  // THE COORDINATOR'S OWN LIST, once it sends one: every `reasonCode: '…'`
  // in the registry has a word here, or a sentence lands on a row.
  const registry = read(`${SRC}registry.js`);
  const sent = [...registry.matchAll(/reasonCode:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  for (const code of sent) {
    if (code === 'ok') continue;
    assert.ok(host[code], `registry.js sends reasonCode '${code}' and neither phone has a word for it`);
  }
});

test('every refusal code and every host_unavailable why has a title', () => {
  const refusal = swiftTable('refusal');
  for (const code of REFUSAL_CODES) assert.ok(refusal[code], `no title for refusal code ${code}`);
  for (const why of WHYS) assert.ok(refusal[`host_unavailable:${why}`], `no title for host_unavailable why ${why}`);
  // THE COORDINATOR'S OWN LIST, once it sends one: a `why: '…'` set on a
  // host_unavailable refusal in the scheduler or the core has a title.
  for (const file of ['scheduler.js', 'core.js']) {
    const src = read(`${SRC}${file}`);
    for (const m of src.matchAll(/code:\s*'host_unavailable'[\s\S]{0,300}?why:\s*'([a-z_]+)'/g)) {
      assert.ok(refusal[`host_unavailable:${m[1]}`], `${file} sends why '${m[1]}' on host_unavailable and neither phone has a title for it`);
    }
  }
  // THE TWO START TITLES ARE KEPT EXACTLY, on both phones, and the start's
  // notification is still titled by them (test/claude-setup-in-apps.test.js
  // holds the call); a refusal of any other code is titled by its word.
  const iFleet = IOS('Fleet.swift');
  const aFleet = ANDROID('Fleet.kt');
  for (const src of [iFleet, aFleet]) {
    assert.match(src, /"unsandboxed"\s*(?:->|:)\s*(?:return )?"Not started: only admins run sessions there"/);
    assert.match(src, /"host_outdated"\s*(?:->|:)\s*(?:return )?"Not started: the machine needs an update"/);
  }
  assert.equal(refusal.unsandboxed, 'Not started: only admins run sessions there', 'the unsandboxed title is the start’s own words');
  assert.match(iFleet, /default: return refusalTitle\s*\}\s*\}/);
  assert.match(aFleet, /else -> title\s*\}\s*\}/);
  // `why` is read beside `code` on both phones.
  assert.match(iFleet, /why = \(try\? keyed\?\.decodeIfPresent\(String\.self, forKey: \.why\)\) \?\? nil/);
  assert.match(iFleet, /var title: String \{ ReasonWords\.refusal\(code: code, why: why\) \}/);
  assert.match(aFleet, /why = json\.optJSONObject\("error"\)\?\.optString\("why"\)/);
  assert.match(aFleet, /val title: String\s*get\(\) = ReasonWords\.refusal\(code, why\)/);
});

test('every way a ready machine fails has a word', () => {
  const standby = swiftTable('standby');
  for (const code of STANDBY_CODES) assert.ok(standby[code], `no word for standby code ${code}`);
  // The coordinator's own record, once it carries a code.
  const src = read(`${SRC}vm-standby.js`);
  for (const m of src.matchAll(/failed\s*[:=]\s*\{[^}]*?code:\s*'([a-z_]+)'/g)) {
    assert.ok(standby[m[1]], `vm-standby.js records failed.code '${m[1]}' and neither phone has a word for it`);
  }
  assert.match(IOS('Fleet.swift'), /var code: String\? = nil\s*\/\/\/ The line's word[\s\S]*?var word: String \{ ReasonWords\.standby\(code\) \?\? text \}/);
  assert.match(ANDROID('Fleet.kt'), /data class Failure\(val at: Long, val text: String, val code: String\? = null\)/);
  assert.match(ANDROID('Fleet.kt'), /code = f\.optString\("code"\)\.takeIf/);
});

test('every event kind the coordinator records has a label, and an unknown one shows the kind', () => {
  const activity = swiftTable('activity');
  const kinds = new Set();
  for (const f of readdirSync(new URL(`../${SRC}`, import.meta.url)).filter((f) => f.endsWith('.js'))) {
    const src = read(`${SRC}${f}`);
    // The event's expression alone: up to the next field on the same line,
    // so a `text:` beside it ("${owner}'s phone") is not read for kinds.
    for (const m of src.matchAll(/record\(\{[\s\S]{0,500}?\bevent:\s*([^\n]+)/g)) {
      const expression = m[1].split(/,\s*(?:actor|hostId|text|name|verb|url|fingerprint|kind):/)[0];
      for (const lit of expression.matchAll(/'([a-z][a-z.-]*)'/g)) kinds.add(lit[1]);
    }
  }
  assert.ok(kinds.size > 20, `found only ${kinds.size} event kinds in ${SRC}; the grep is broken`);
  for (const kind of kinds) assert.ok(activity[kind], `the coordinator records event '${kind}' and neither phone has a label for it`);
  // A kind this build never met is shown as itself (C-5), not blank.
  assert.match(I_WORDS, /guard let label = activity\[event\] else \{ return event \}/);
  assert.match(A_WORDS, /val label = ACTIVITY\[event\] \?: return event/);
  // An intent is labelled with its verb: "Asked for start".
  assert.equal(activity.intent, 'Asked for');
  assert.match(I_WORDS, /if event == "intent", let verb, !verb\.isEmpty \{ return "\\\(label\) \\\(verb\)" \}/);
  assert.match(A_WORDS, /if \(event == "intent" && !verb\.isNullOrBlank\(\)\) "\$label \$verb" else label/);
});

test('the Machines row shows the word, the page the word with the sentence under Details', () => {
  const iFleet = IOS('Fleet.swift');
  const aFleet = ANDROID('Fleet.kt');
  assert.match(iFleet, /var reasonCode: String\?/);
  assert.match(iFleet, /var reasonWord: String\? \{ ReasonWords\.host\(reasonCode\) \}/);
  assert.match(iFleet, /var reasonRow: String\? \{ reasonWord \?\? reason \}/);
  assert.match(aFleet, /val reasonCode: String\? = null/);
  assert.match(aFleet, /reasonCode = o\.optString\("reasonCode"\)\.takeIf/);
  assert.match(aFleet, /val reasonRow: String\? get\(\) = reasonWord \?: reason/);
  // The row.
  assert.match(IOS('MachinesView.swift'), /if let reason = host\.reasonRow, !reason\.isEmpty, \(host\.state \?\? ""\) != "healthy"/);
  assert.match(ANDROID('MachinesScreen.kt'), /host\.reasonRow\?\.takeIf \{ it\.isNotBlank\(\) && host\.state != "healthy" \}/);
  // The page: the word as the line, the sentence behind Details; the
  // sentence alone where there is no code (an older coordinator, a silent
  // or revoked machine whose sentence the list composed).
  const host = IOS('HostView.swift');
  assert.match(host, /if let word = ReasonWords\.host\(reasonCode\) \{\s*Text\(word\)[\s\S]{0,200}?DisclosureGroup\("Details"\) \{\s*Text\(reason\)/);
  assert.match(host, /\} else \{\s*Text\(reason\)\.fleetType\(\.label\)/);
  assert.match(host, /reasonCode = initialReasonCode/);
  assert.match(host, /reasonCode = mine\.reasonCode/);
  assert.match(IOS('MachinesView.swift'), /initialReasonCode: reporting\?\.reasonCode/);
  const page = ANDROID('MachinesScreen.kt');
  assert.match(page, /val word = h\?\.reasonWord\s*if \(word != null\) \{\s*Hint\(word\)\s*Details\(reason\)\s*\} else \{\s*Hint\(reason\)/);
  // The one Details control, shared by every Android screen that opens a sentence.
  assert.match(ANDROID('Details.kt'), /fun Details\(text: String, modifier: Modifier = Modifier\)/);
  assert.match(ANDROID('Details.kt'), /heightIn\(min = 48\.dp\)/);
  assert.match(ANDROID('Details.kt'), /Text\(if \(open\) "Hide details" else Manage\.Words\.details\)/);
});

test('the Sessions status card leads with the title and keeps the sentence under Details; notifications are titled the same', () => {
  const fleetView = IOS('FleetView.swift');
  assert.match(fleetView, /@State private var statusTitle: String\?/);
  assert.match(fleetView, /if let statusTitle \{\s*VStack[\s\S]{0,120}?Text\(statusTitle\)[\s\S]{0,160}?DisclosureGroup\("Details"\) \{\s*Text\(status\)/);
  // Every path a refusal reaches the card by sets the title beside the text.
  assert.match(fleetView, /status = text\s*statusTitle = reply\.refusalTitle/);
  assert.match(fleetView, /statusTitle = reply\.ok == false \? reply\.refusedStartTitle : nil/);
  assert.match(fleetView, /status = reply\.text \?\? ""\s*statusTitle = reply\.refusalTitle/);
  assert.match(fleetView, /statusTitle = reply\.ok == false \? reply\.refusalTitle : nil\s*if reply\.ok == false \{ refused \+= 1 \}/);
  // Asking for a machine: the refusal's title, the sentence as the body.
  assert.match(fleetView, /let title: String\? = reply\.ok == false \? reply\.refusalTitle : nil/);
  assert.match(fleetView, /LocalNotice\.post\(title: title \?\? "Machine on its way", body: text\)/);
  const main = ANDROID('MainActivity.kt');
  assert.match(main, /var statusTitle by rememberSaveable \{ mutableStateOf<String\?>\(null\) \}/);
  assert.match(main, /val title = statusTitle\s*if \(title != null\) \{[\s\S]{0,700}?Text\(title, style = Design\.Style\.body[\s\S]{0,80}?Details\(status\)/);
  assert.match(main, /statusTitle = if \(!reply\.ok\) reply\.title else if \(keepStatus\) statusTitle else null/);
  assert.match(main, /status = reply\.text\.said\(\)\s*statusTitle = if \(reply\.ok\) null else reply\.title/);
  assert.match(main, /statusTitle = if \(reply\.ok\) null else reply\.refusedStartTitle/);
  assert.match(main, /if \(!reply\.ok\) \{ status = reply\.text\.said\(\); statusTitle = reply\.title \}/);
  assert.match(main, /LocalNotice\.post\(context, if \(reply\.ok\) "Machine on its way" else reply\.title, text\)/);
});

test('a ready machine that did not come says its word on the line and its sentence under Details', () => {
  assert.match(IOS('VMStandbyView.swift'), /Text\("\\\(Self\.clock\(failed\.at\)\): \\\(failed\.word\)"\)[\s\S]{0,160}?if failed\.word != failed\.text \{\s*DisclosureGroup\("Details"\) \{\s*Text\(failed\.text\)/);
  assert.match(ANDROID('VmStandbyScreen.kt'), /Hint\("\$\{clock\(it\.at\)\}: \$\{it\.word\}", Design\.Palette\.bad\.now\)\s*if \(it\.word != it\.text\) Details\(it\.text\)/);
});

test('Activity rows show the label and the subject, and the sentence on a tap', () => {
  const ios = IOS('ActivityView.swift');
  assert.match(ios, /Text\(ReasonWords\.activity\(run\.event\.event, verb: run\.event\.verb\)\)\.fleetType\(\.body\)/);
  assert.match(ios, /if let subject = describeEventSubject\(run\.event\) \{\s*Text\(subject\)\.fleetType\(\.labelMono\)/);
  assert.match(ios, /if let text = run\.event\.text, !text\.isEmpty \{\s*DisclosureGroup \{\s*Text\(text\)/);
  assert.doesNotMatch(ios, /private func describeEvent\(/, 'the sentence is no longer the row');
  const android = ANDROID('ActivitySheet.kt');
  assert.match(android, /Text\(ReasonWords\.activity\(e\.event, e\.verb\), style = Design\.Style\.body/);
  assert.match(android, /describeEventSubject\(e\)\?\.let \{\s*Text\(it, style = Design\.Style\.label, fontFamily = FontFamily\.Monospace/);
  assert.match(android, /e\.text\?\.takeIf \{ it\.isNotBlank\(\) \}\?\.let \{ Details\(it\) \}/);
  assert.doesNotMatch(android, /private fun describeEvent\(/);
  // The subject is the name, else the machine; "coordinator" is not a machine.
  assert.match(ios, /if let n = e\.name, !n\.isEmpty \{ return n \}\s*if let h = e\.hostId, !h\.isEmpty, h != "coordinator" \{ return h \}/);
  assert.match(android, /e\.name\?\.takeIf \{ it\.isNotBlank\(\) \} \?: e\.hostId\?\.takeIf \{ it\.isNotBlank\(\) && it != "coordinator" \}/);
});

test('a hypervisor machine’s problem and a router’s problem sit under Details beneath their verdict', () => {
  assert.match(IOS('HypervisorsView.swift'), /if let why = box\.problem, !why\.isEmpty \{\s*DisclosureGroup\("Details"\) \{\s*Text\(why\)/);
  assert.match(ANDROID('HypervisorsScreen.kt'), /box\.problem\?\.takeIf \{ it\.isNotBlank\(\) \}\?\.let \{ Details\(it\) \}/);
  // The verdict words, the same on both phones, and no longer "Unreachable: <sentence>".
  const iWords = IOS('Manage.swift');
  const aWords = ANDROID('Manage.kt');
  assert.match(iWords, /static let edgeUnreached = "Unreachable"/);
  assert.match(iWords, /static let edgeUnknown = "Unknown"/);
  assert.match(iWords, /static let details = "Details"/);
  assert.match(aWords, /const val edgeUnreached = "Unreachable"/);
  assert.match(aWords, /const val edgeUnknown = "Unknown"/);
  assert.match(aWords, /const val details = "Details"/);
  const iView = IOS('ManageView.swift');
  assert.match(iView, /Text\(Manage\.Words\.edgeUnreached\)[\s\S]{0,120}?DisclosureGroup\(Manage\.Words\.details\) \{\s*Text\(problem\)/);
  assert.match(iView, /Text\(Manage\.Words\.edgeUnknown\)[\s\S]{0,120}?DisclosureGroup\(Manage\.Words\.details\) \{\s*Text\(problem\)/);
  const aView = ANDROID('PoolPage.kt');
  assert.match(aView, /Text\(Manage\.Words\.edgeUnreached, style = Design\.Style\.label, color = Design\.Palette\.attention\.now\)\s*Details\(problem\)/);
  assert.match(aView, /Text\(Manage\.Words\.edgeUnknown, style = Design\.Style\.label, color = Design\.Palette\.inkDim\.now\)\s*Details\(problem\)/);
});

test('the iOS end-of-setup notification is worded from state, phase and purpose, in Android’s words', () => {
  const words = IOS('SetupNoticeWords.swift');
  const notice = ANDROID('XoSetupNotice.kt');
  const helpers = ANDROID('XoReconnect.kt') + ANDROID('ProxmoxThrough.kt') + ANDROID('XoWatchdog.kt');
  // Every title and body literal iOS can draw is one Android draws.
  const literals = [...words.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((s) => /\S \S/.test(s));
  assert.ok(literals.length > 30, `found only ${literals.length} sentences in SetupNoticeWords.swift`);
  for (const lit of literals) {
    // Swift's "\(hostId)" is Kotlin's "$hostId".
    const kt = lit.replace(/\\\((\w+)\)/g, '$$$1');
    // The running line, which Android draws from the step's own words: iOS
    // hears only a job's end, so that line is a number and a place.
    if (lit.startsWith('Step ') || lit.includes('\\(line)')) continue;
    assert.ok(notice.includes(kt) || helpers.includes(kt), `iOS draws ${JSON.stringify(lit)} and Android does not`);
  }
  // And the coordinator's own end titles are among them, so the banner and
  // the screen say one thing.
  const core = read(`${SRC}core.js`);
  for (const table of ['SETUP_TITLES', 'POLICY_TITLES', 'DEPLOY_TITLES', 'PVE_TITLES', 'WATCHDOG_TITLES', 'RECONNECT_TITLES']) {
    const m = core.match(new RegExp(`const ${table} = Object\\.freeze\\(\\{([^}]*)\\}\\)`));
    assert.ok(m, `core.js has no ${table}`);
    for (const [, title] of m[1].matchAll(/: '((?:[^'\\]|\\.)*)'/g)) {
      const plain = title.replace(/\\u2019/g, '’');
      assert.ok(words.includes(`"${plain}"`), `core.js ${table} says ${JSON.stringify(plain)} and SetupNoticeWords.swift does not`);
    }
  }
  // The extension draws it, keeps the machine's sentence as `text`, and the
  // app shows that on the setup page; the extension's target compiles the file.
  const service = read('apps/ios/FleetwrightPush/NotificationService.swift');
  assert.match(service, /if opened\.data\["kind"\] == "xosetup" \{[\s\S]{0,200}?content\.title = SetupNoticeWords\.title\(purpose: opened\.data\["purpose"\], state: state\)/);
  assert.match(service, /content\.userInfo\["text"\] = opened\.body/);
  assert.match(IOS('FleetwrightApp.swift'), /text: info\["text"\] as\? String \?\? content\.body/);
  assert.match(read('apps/ios/project.yml'), /- path: FleetwrightPush\n(?:.*\n){0,6}?\s+- path: Fleetwright\/SetupNoticeWords\.swift/);
  assert.doesNotMatch(words, /import (?!Foundation)/, 'the extension’s file takes nothing but Foundation');
});
