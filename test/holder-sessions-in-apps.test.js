// A pool's own machine runs no sessions, and both phones say so: in the same
// words where the account line would be, never in the attention colour for
// having nobody's account, and never offered under New session › Where.
//
//   node --test test/holder-sessions-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. The rule itself is run, not read: test/host-picker.test.js (never
// placed, refused by name, never degraded) and test/coordinator.test.js
// (takesSessions and holder in the snapshot). ASKED FOR: "Should the pool's
// own machine ever run sessions? No". docs/hypervisors.md, "A machine of its
// own".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const A = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const I = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);

const PHONES = [
  { name: 'iOS', lines: I('FleetView.swift'), fleet: I('Fleet.swift'), start: I('StartSheet.swift') },
  { name: 'Android', lines: A('Screens.kt'), fleet: A('Fleet.kt'), start: A('StartSheet.kt') },
];

const SAID = 'This pool’s own machine. It holds the pool for the fleet and runs no sessions.';

test('both phones name the pool’s own machine in the same words', () => {
  for (const p of PHONES) assert.ok(p.lines.includes(`"${SAID}"`), p.name);
});

test('having nobody’s account there is not a fault (no attention colour)', () => {
  // The fault answers false for a holder before it looks at accounts: a
  // holder's zero is the ordinary state, and the ring said otherwise.
  assert.match(PHONES[0].lines, /guard accounts == 0, !holder else \{ return false \}/, 'iOS');
  assert.match(PHONES[1].lines, /if \(accounts != 0 \|\| host\.holder\) return false/, 'Android');
});

test('a degraded box with no account says it once, in the fleet’s reason', () => {
  for (const p of PHONES) {
    assert.match(p.lines, /accounts == 0 && state == "degraded"/, `${p.name}: the line steps aside`);
  }
});

test('the pool’s own machine’s page offers Make it again, which does the rest by itself (C-2)', () => {
  // Asked for: "Holder should also allow to rebuild from that page", then
  // "Recreate the holder from the holder page less clicks". The same words
  // on both phones, offered only where the fleet said which pool it holds
  // (`holds`, core.js holdsFor), this phone holds that pool's token, and
  // this person is the admin a policy change takes. The policy screen it
  // opens starts with the switch on, where the machine makes the new one
  // ask and the pool has one, and then SENDS THE CHOICE BY ITSELF: the tap
  // on the page and the sign-in were the asking, and the form with Apply at
  // the bottom of it was a scroll nobody came for.
  const title = 'Make it again';
  const line = 'Removes this machine, disk and all, and makes a new one from the newest build of its suite, which asks to join; this phone lets it in. '
    + 'It asks for the pool’s admin sign-in, or opens the one this phone kept, and does the rest by itself.';
  // iOS
  assert.ok(PHONES[0].lines.includes(`let holderAgainTitle = "${title}"`), 'iOS title');
  assert.ok(PHONES[0].lines.includes(`let holderAgainLine = "${line.slice(0, line.indexOf('It asks'))}"\n    + "${line.slice(line.indexOf('It asks'))}"`), 'iOS line');
  assert.match(PHONES[0].fleet, /var holder: Bool\?[\s\S]{0,400}var holds: String\?/, 'iOS decodes holds');
  const host = I('HostView.swift');
  assert.match(host, /if holder, let holds, holdsHere, settings\.showsAdmin \{[\s\S]{0,200}AddHypervisorView\(settings: settings, policyFor: holds, makeHolderAgain: true\)[\s\S]{0,400}Text\(holderAgainTitle\)[\s\S]{0,80}Text\(holderAgainLine\)/, 'iOS offers it only then');
  assert.match(I('MachinesView.swift'), /holdsHere: reporting\?\.holds\.map \{ a in hypervisors\.contains \{ \$0\.address == a \} \} \?\? false/, 'iOS: only a pool this phone holds');
  const form = I('AddHypervisorView.swift');
  assert.match(form, /if makeHolderAgain, choice\.holderAskChoice, opened\.holder\(on: choice\.egress\) != nil \{ choice\.holderAgain = true \}/, 'iOS opens with the switch on');
  // Android
  assert.ok(PHONES[1].lines.includes(`const val HOLDER_AGAIN_TITLE = "${title}"`), 'Android title');
  assert.ok(PHONES[1].lines.includes(`const val HOLDER_AGAIN_LINE = "${line.slice(0, line.indexOf('It asks'))}" +\n    "${line.slice(line.indexOf('It asks'))}"`), 'Android line');
  assert.match(PHONES[1].fleet, /holds = o\.optString\("holds"\)\.takeIf \{ it\.isNotBlank\(\) && it != "null" \}/, 'Android parses holds');
  const page = A('MachinesScreen.kt');
  assert.match(page, /if \(h\?\.holder == true && holds != null && holdsHere && admin == true\) \{\s*SectionHead\(holds\)\s*OpenRow\(HOLDER_AGAIN_TITLE\) \{ onMakeAgain\(holds\) \}\s*Hint\(HOLDER_AGAIN_LINE\)/, 'Android offers it only then');
  assert.match(page, /holdsHere = fleetHosts\.firstOrNull \{ it\.hostId == id \}\?\.holds\?\.let \{ a -> held\.any \{ it\.address == a \} \} == true/, 'Android: only a pool this phone holds');
  assert.match(page, /HypervisorSheet\(settings, policyFor = pool, makeHolderAgain = true,/, 'Android opens the sheet for it');
  const sheet = A('HypervisorSheet.kt');
  assert.match(sheet, /if \(policy && makeHolderAgain && c\.holderAskChoice && XoPolicy\.holderOn\(opened, c\.egress\) != null\) c\.copy\(holderAgain = true\) else c/, 'Android opens with the switch on');

  // SENT BY ITSELF, on both phones, on the same three conditions and no
  // other: the switch went on, the machine is there, and the choice as it
  // stands is one the machine would take. Apply's own function, so what
  // goes is what a tap on Apply would have sent, secret and all.
  assert.match(form, /if makeHolderAgain \{\s*if choice\.holderAgain, choice\.problem\(in: opened\) == nil, let mine = opened\.holder\(on: choice\.egress\) \{[\s\S]{0,300}straightThrough = true\s*await applyPolicy\(opened, job: job\)/, 'iOS sends it by itself');
  assert.match(sheet, /if \(policy && makeHolderAgain && c != null\) \{\s*val mine = XoPolicy\.holderOn\(opened, c\.egress\)\s*if \(c\.holderAgain && mine != null && XoPolicy\.problem\(opened, c\) == null\) \{[\s\S]{0,300}straight = true\s*applyChoice\(r\.xosetup\)/, 'Android sends it by itself');
  // The form is not drawn under it while it goes; the progress is, and says
  // which machine goes and where the new one is made, in the same words.
  assert.match(form, /if choosing, let inventory, !straightThrough \{\s*policySections\(inventory, job: job\)/, 'iOS draws progress, not the form');
  assert.match(sheet, /straight -> \{\}\s*inv != null && c != null -> \{/, 'Android draws no form while it goes');
  const said = 'Replacing \\(name) with a new one on \\(straightWayOut).';
  assert.ok(form.includes(`"${said}"`), 'iOS says what went');
  assert.ok(sheet.includes('"Replacing $name with a new one on $wayOut."'), 'Android says what went');
  // And when it could not, the form, with why, in the same words.
  const whyNot = [
    'needs an update to do this. Choose below instead.',
    'has no managing VM to replace.',
    'Not done by itself: ',
  ];
  for (const why of whyNot) {
    assert.ok(form.includes(why), `iOS says why not: ${why.slice(0, 30)}`);
    assert.ok(sheet.includes(why), `Android says why not: ${why.slice(0, 30)}`);
  }
});

test('New session › Where offers only machines a start would reach (C-2)', () => {
  for (const p of PHONES) {
    // Live hosts, not the enrolled list: that one has offline boxes in it.
    assert.ok(!/enrolledHosts\(\)/.test(p.start), `${p.name}: not the enrolled list`);
    assert.match(p.start, /fleetHosts\(\)/, `${p.name}: from the snapshot`);
    // Never the holder, and takesSessions where the coordinator says it,
    // healthy where it is too old to.
    assert.match(p.start, p.name === 'iOS'
      ? /\.filter \{ \$0\.holder != true && \(\$0\.takesSessions \?\? \(\$0\.state == "healthy"\)\) \}/
      : /\.filter \{ !it\.holder && \(it\.takesSessions \?: \(it\.state == "healthy"\)\) \}/, p.name);
    // The same two keys the coordinator writes (core.js, the snapshot).
    assert.match(p.fleet, p.name === 'iOS'
      ? /var takesSessions: Bool\?[\s\S]*var holder: Bool\?/
      : /it\.has\("takesSessions"\)[\s\S]*optBoolean\("holder", false\)/, `${p.name}: decoded`);
  }
});
