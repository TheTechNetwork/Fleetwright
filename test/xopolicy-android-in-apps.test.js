// Changing what the fleet may use on a hypervisor pool, from the Android
// phone: where it is offered, what is checked before anything is sealed,
// where the keys live, and the words.
//
//   node --test test/xopolicy-android-in-apps.test.js
//
// A read of the Kotlin, like xosetup-android-in-apps.test.js beside it: it
// compiles only in CI. The arithmetic (the inventory parse with its nulls, the
// defaults and their clamps, the rules Apply waits on, the payload, both
// seals) is RUN by XoPolicyTest.kt; what is pinned here is what the machine
// and the coordinator rely on and a person meets. The machine's half is
// xo-setup.js (`policy`, `checkPolicy`, `inventoryOf`).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { xosetupAad, xosetupInventoryAad, xosetupPolicyAad } from '../src/fleet/seal.js';
import { XOPOLICY_STEPS } from '../src/fleet/protocol/intents.js';
import { STEP_WORDS } from '../src/fleet/host/xo-setup.js';

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

test('Android: the pool and the choice are sealed under the machine’s own bindings', () => {
  const policy = file('XoPolicy.kt');
  // Kotlin's string template, built from seal.js with the template's own
  // placeholders, so a binding renamed on either side fails here.
  const inventory = xosetupInventoryAad('$job', '$address');
  const choice = xosetupPolicyAad('$job', '$address');
  assert.ok(policy.includes(`fun inventoryAad(job: String, address: String): String = "${inventory}"`), inventory);
  assert.ok(policy.includes(`fun policyAad(job: String, address: String): String = "${choice}"`), choice);
  // Opened and sealed with the app's one seal, under those bindings.
  assert.ok(policy.includes('Seal.open(key, inventoryAad(job, address), box)'));
  assert.ok(policy.includes('Seal.seal(key, policyAad(job, address), payload(inv, c))'));
  // The sign-in goes under setup's binding: it is `run`, and the machine
  // opens it before it knows which kind of job it is.
  assert.equal(xosetupAad('J', 'A'), 'fleetwright-xosetup/v1:J:A');
  assert.ok(policy.includes('Seal.seal(key, XoSetup.aad(job, address), payload)'));
});

test('Android: the purpose rides inside the seal, never beside it', () => {
  const policy = file('XoPolicy.kt');
  assert.ok(policy.includes('const val PURPOSE = "policy"'));
  const seal = fn(policy, 'fun sealSignIn(');
  assert.match(seal, /\.put\("reply", reply\)\s*\.put\("purpose", PURPOSE\)/);
  // No intent param carries it: not the client, not the sheet.
  const fleet = file('Fleet.kt');
  const xosetup = fleet.slice(fleet.indexOf('suspend fun xosetup('), fleet.indexOf('/** Forget a stored credential.'));
  assert.ok(xosetup.length > 0 && !xosetup.includes('"purpose"'), 'purpose is never an xosetup param');
  assert.doesNotMatch(file('HypervisorSheet.kt'), /purpose\s*=/);
});

test('Android: the key the pool comes back to lives in memory, never on disk or in a Bundle', () => {
  const sheet = file('HypervisorSheet.kt');
  const runPolicy = fn(sheet, 'suspend fun runPolicy(');
  // A one-off key, not XoHandoff's, which writes its private half down so a
  // token can be collected with the app closed.
  assert.match(runPolicy, /val reply = Seal\.newKey\(\)\s*(?:pendingSave = [^\n]*\s*)?val sealed = XoPolicy\.sealSignIn\([^\n]*reply\.publicKey\)\s*password = ""/);
  assert.ok(!runPolicy.includes('XoHandoff'), 'the policy path never touches XoHandoff');
  // Held in `remember`, which a rotation drops, not `rememberSaveable`.
  assert.match(sheet, /var policyKey by remember \{ mutableStateOf<Seal\.OneUseKey\?>\(null\) \}/);
  // And dropped once the choice is taken.
  assert.match(fn(sheet, 'fun applyChoice('), /if \(r\.ok\) \{[\s\S]*?policyKey = null/);
  // Nothing in the policy logic writes anything anywhere.
  assert.doesNotMatch(file('XoPolicy.kt'), /putSecret|Settings|SharedPreferences|Log\.[idwe]\(/);
  // A screen rebuilt while the machine waits says it cannot open the pool
  // and offers Cancel, rather than a form it cannot fill.
  assert.ok(sheet.includes('"What the pool has did not open with this screen\'s key, so it cannot be shown. That key is kept " +'));
});

test('Android: a policy sign-in goes only to a machine that says it can, asked before anything is sealed', () => {
  const fleet = file('Fleet.kt');
  // `can` is read from the `begin` answer, and the pool from `status`.
  assert.match(fleet, /can = s\.optJSONArray\("can"\)/);
  assert.match(fleet, /inventory = s\.optString\("inventory"\)\.takeIf \{ it\.split\("\."\)\.size == 3 \}/);
  const sheet = file('HypervisorSheet.kt');
  // In begin: refused before the key check, before the comparison screen,
  // and before `run`, which is where the sign-in is sealed.
  const begin = fn(sheet, 'fun begin(');
  const refuse = begin.indexOf('policy && XoPolicy.PURPOSE !in setup.can ->');
  assert.ok(refuse > 0, 'begin checks `can` for a policy job');
  for (const later of ['XoSetup.verifyKeySig(', 'approved -> run(pending)', 'else -> unvouched = pending']) {
    assert.ok(begin.indexOf(later) > refuse, `the can check comes before ${later}`);
  }
  assert.ok(sheet.includes('"$hostId is older than changing a policy, so nothing was sent.'));
  // And again at the last line before the seal.
  const runPolicy = fn(sheet, 'suspend fun runPolicy(');
  assert.ok(runPolicy.indexOf('XoPolicy.PURPOSE !in p.setup.can') < runPolicy.indexOf('XoPolicy.sealSignIn('));
  // A setup never takes the policy path, nor a policy job setup's.
  assert.match(fn(sheet, 'suspend fun run('), /if \(policy\) \{\s*runPolicy\(p\)\s*return\s*\}/);
});

test('Android: the choice goes to the key `begin` gave and the phone checked, never one from a status answer', () => {
  const sheet = file('HypervisorSheet.kt');
  const runPolicy = fn(sheet, 'suspend fun runPolicy(');
  assert.match(runPolicy, /val key = p\.setup\.key \?: return[\s\S]*?jobKey = key/);
  const apply = fn(sheet, 'fun applyChoice(');
  assert.match(apply, /val key = jobKey \?: return/);
  assert.ok(apply.includes('XoPolicy.sealChoice(key, setup.job, address.trim(), inv, c)'));
  assert.ok(apply.includes('fleet.xosetup("policy", job = setup.job, sealed = sealed)'));
  assert.ok(!apply.includes('host ='), '`policy` names the job alone');
  // Apply is offered only for a choice the machine would take.
  assert.match(apply, /if \(XoPolicy\.problem\(inv, c\) != null\) return/);
  assert.match(sheet, /enabled = !applying && !cancelling && problem == null,\s*onClick = \{ applyChoice\(setup\) \}/);
  // A refusal keeps the form: the machine is still waiting.
  assert.match(apply, /\} else \{\s*choiceRefusal = r\.text/);
});

test('Android: the poll carries on through choosing and opens the pool once', () => {
  const sheet = file('HypervisorSheet.kt');
  const poll = sheet.slice(sheet.indexOf('LaunchedEffect(job, asks)'), sheet.indexOf('FullScreen('));
  // Only the three ends stop it; choosing is not one of them, and every
  // pass waits before it asks.
  assert.match(poll, /if \(state == "done" \|\| state == "failed" \|\| state == "cancelled"\) break/);
  assert.ok(!/state == "choosing"\)? break/.test(poll), 'choosing does not end the poll');
  assert.ok(poll.includes('delay(2_000)'));
  assert.match(poll, /r\.xosetup\.state == "choosing" && pool != null && inventory == null && !applied && !unopened/);
  assert.ok(poll.includes('XoPolicy.openInventory(pool, id, address.trim(), it)'));
});

test('Android: Hypervisors on Machines lists the pools this phone holds, for admins only', () => {
  const machines = file('MachinesScreen.kt');
  assert.match(machines, /if \(settings\.configured && admin == true && held\.isNotEmpty\(\)\) \{[\s\S]*?SectionHead\("Hypervisors"\)/);
  // Each opens the pool's page (PoolPage, docs/manage.md), and the policy is
  // a row on that page, for an admin, as it is on iOS.
  assert.match(machines, /HeldRow\(h, Manage\.lastLooked\(settings, h\.address\), onClick = \{ managing = h\.address \}\)/);
  assert.ok(machines.includes('onClickLabel = "Opens its page"'));
  assert.match(machines, /PoolPage\(settings, pool, admin, onChangePolicy = \{ policyFor = address \}/);
  assert.match(file('PoolPage.kt'), /if \(admin == true\) \{[\s\S]{0,200}?OpenRow\(Manage\.Words\.changePolicy\) \{ onChangePolicy\(\) \}/);
  assert.match(machines, /HypervisorSheet\(settings, policyFor = pool,/);
  // The list is what collect records when it keeps a token, and only the
  // addresses whose token is still here are shown.
  const handoff = file('XoHandoff.kt');
  // Under the address the record names: the job's own for a setup, the Xen
  // Orchestra it installed for an install.
  assert.match(handoff, /val at = recordAddress\(record\) \?: entry\.address\s*settings\.putSecret\(tokenName\(at\), record\)\s*hold\(settings, at\)/);
  assert.match(handoff, /settings\.secret\(tokenName\(address\)\)\?\.let \{ Held\(address, poolNames\(it\)\) \}/);
  // Not a secret: an address list, beside the pending list.
  assert.match(file('Fleet.kt'), /var xoHeld: String\s*get\(\) = prefs\.getString\("xoHeld", ""\)/);
});

test('Android: the words are the machine’s and iOS’s', () => {
  const sheet = file('HypervisorSheet.kt');
  const form = file('PolicyForm.kt');
  const policy = file('XoPolicy.kt');
  assert.ok(sheet.includes('if (policy) "What the fleet may use" else "Add a hypervisor"'));
  for (const head of ['Storage', 'Networks', 'Way out', 'Limits']) {
    assert.ok(form.includes(`SectionHead("${head}")`), `the form has ${head}`);
  }
  assert.ok(form.includes('title = "None yet"'));
  assert.ok(sheet.includes('Text(if (applying) "Applying…" else "Apply")'));
  // The way out says what it records and names the router it is for; the
  // router is offered by a machine that can build it, with a way out, and
  // its cost said first: iOS's words.
  assert.ok(form.includes('"The network the edge router, an OPNsense VM, will put its WAN on, so labs reach the internet through it and not " +'));
  assert.ok(form.includes('is too old to build the router; update it to have it built from here.'));
  assert.match(form, /if \(canEdge && choice\.egress != null\) \{/);
  assert.ok(form.includes('title = if (there == null) "Build the edge router on it" else "Keep the edge router on it"'));
  assert.ok(form.includes('downloads OPNsense once, about 470 MB, and builds it while you wait.'));
  assert.ok(form.includes('onClick = { onChange(choice.copy(egress = null, edge = false, image = false, images = emptySet(), groups = 0, holder = false)) }'));
  assert.match(sheet, /canEdge = "edge" in p\.setup\.can/);
  assert.match(policy, /\.put\("edge", c\.edge\)/);
  assert.ok(policy.includes('The edge router needs a way out: choose the network its WAN goes on.'));
  assert.ok(sheet.includes('"$machine waits ten minutes for your choice, then lets go without changing anything."'));
  assert.ok(sheet.includes('"Used once, on ${pick.hostId}, to read the pool and apply what you choose, and not kept. " +'));
  // Every step the protocol has, in its order, said as the machine says it.
  let last = -1;
  for (const key of XOPOLICY_STEPS) {
    const i = policy.indexOf(`"${key}" to "${STEP_WORDS[key]}"`);
    assert.ok(i > last, `${key} is said as "${STEP_WORDS[key]}", in order`);
    last = i;
  }
  // The rules Apply waits on, in checkPolicy's words.
  for (const line of [
    'Choose at least one storage repository: a VM needs somewhere for its disk.',
    'The way out has to be one of the networks the fleet may use.',
    'vCPUs are between 1 and $maxCpus, what the pool has.',
    'Memory is between 1 GiB and ${gib(maxMemory)}, what the pool has.',
    'Disk is between 10 GiB and ${gib(maxDisk)}, the size of the storage chosen.',
  ]) {
    assert.ok(policy.includes(line), `the app says: ${line}`);
  }
});

test('Android: the form is the design’s tokens, 48dp, with nothing offered that cannot be done', () => {
  const form = file('PolicyForm.kt');
  assert.doesNotMatch(form, /Color\(0x|Color\.(Red|Green|Blue|Yellow|Gray|White|Black)\b/, 'no colour outside the palette');
  const buttons = form.match(/OutlinedButton\(/g)?.length ?? 0;
  const tall = form.match(/modifier = Modifier\.heightIn\(min = 48\.dp\)/g)?.length ?? 0;
  assert.equal(tall, buttons, `${buttons} buttons, ${tall} of them 48dp`);
  for (const role of ['Role.Checkbox', 'Role.RadioButton']) {
    assert.match(form, new RegExp(`\\.heightIn\\(min = 48\\.dp\\)\\s*\\.(?:toggleable|selectable)\\([^\\n]*role = ${role.replace('.', '\\.')}`));
  }
  // A stepper's button that would go past its bound is off, not a press
  // that does nothing (C-2).
  assert.ok(form.includes('enabled = enabled && value > min'));
  assert.ok(form.includes('enabled = enabled && value < max'));
  // The way out offers what the machine takes: any of the pool's networks
  // where it said `egress-any`, and only the fleet's where it did not.
  // Less the pool's group networks, which are no way out (vm-groups-in-apps).
  assert.ok(form.includes('choosable.filter { anyWayOut || it.id in choice.networks }.forEach'));
  assert.ok(file('HypervisorSheet.kt').includes('anyWayOut = "egress-any" in p.setup.can'));
  // ASKED FOR: "this needs proper progress, also which disk did it put it on?"
  assert.ok(file('HypervisorSheet.kt').includes('edgeDisk = "edge-disk" in p.setup.can'));
  assert.ok(form.includes('if (choice.edgeDiskChoice && (buildEdge || buildImage)) {'));
  assert.ok(form.includes('there.sr?.let { " Its disk is on $it." }'));
  assert.ok(file('HypervisorSheet.kt').includes('part != null -> part.fill / 1000f'));
  // ASKED FOR: "Why no actual updates in the live activity?", while a machine
  // image built and the screen called it the edge router. Named from the
  // host's key, in one place, for the sheet and the ongoing notification.
  for (const [key, words] of [['edge', 'building the edge router'], ['image', 'building the machine image'], ['holder', 'making the pool’s own machine']]) {
    assert.ok(file('XoSetup.kt').includes(`"${key}" -> "${words}"`), `no words for a ${key} build`);
  }
  assert.ok(file('HypervisorSheet.kt').includes('part?.let { XoSetup.buildDetail(it.build, it.stage, it.stages) }'));
  assert.ok(!file('HypervisorSheet.kt').includes('building the edge router'), 'the sheet names one build for every build again');
  assert.ok(file('XoSetupNotice.kt').includes('XoSetup.buildDetail(data["build"], data["stage"]?.toIntOrNull(), data["stages"]?.toIntOrNull())'));
  assert.ok(file('Fleet.kt').includes('BuildPart(stage, stages, fill, build)'));
});
