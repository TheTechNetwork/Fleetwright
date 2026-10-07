// Managing a Xen Orchestra pool from a phone, directly: what a person sees,
// and what the phone holds itself to. docs/manage.md, "The first slice".
//
//   node --test test/manage-in-apps.test.js
//
// WHAT IS PROVEN WHERE. The rules (which row an object becomes, which actions
// a method list draws, how each asks, every sentence) are run on both phones
// against one table, test/fixtures/parity/manage.json, by
// FleetwrightTests/ManageParityTests.swift and its Kotlin twin. This file
// checks that table against the host's own definitions, so a phone and the
// machine that ran the setup cannot disagree about a pin or a method name
// without one of them failing here, and reads the Swift for the few things
// a table cannot hold: that the pin is checked in the TLS challenge, that no
// password is reached for, that a screen draws only what the model offers, and
// where the page is.
//
// THE ANDROID HALF IS NOT HERE YET. It lands on its own branch, stacked on this
// one (CONTRIBUTING.md); the marked block at the bottom is its place, and the
// "both phones" assertions belong there once it exists.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';
import { certSha256 } from '../src/fleet/host/xo-ws.js';
import { RESIZE_METHODS } from '../src/fleet/host/xo-setup.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const TABLE = JSON.parse(read('test/fixtures/parity/manage.json'));
const IOS = iosSources();
const IOS_MODEL = read('apps/ios/Fleetwright/Manage.swift');
const IOS_LINK = read('apps/ios/Fleetwright/XOLink.swift');
const IOS_WATCH = read('apps/ios/Fleetwright/PoolWatch.swift');
const IOS_SCREEN = read('apps/ios/Fleetwright/ManageView.swift');
const IOS_MACHINES = read('apps/ios/Fleetwright/MachinesView.swift');

test('the pin the phone compares is the one the machine wrote', () => {
  // The machine records the pin as certSha256 of the certificate's DER
  // (xo-ws.js); both phones compute the same from the same bytes, run against
  // this row of the table.
  assert.equal(certSha256(Buffer.from(TABLE.pin.der, 'base64')), TABLE.pin.sha256);
  // And the record the table hands both phones carries it as setup writes it.
  const record = JSON.parse(TABLE.records[0].text);
  assert.equal(record.pin, TABLE.pin.sha256);
  assert.equal(TABLE.records[0].pin, TABLE.pin.sha256);
});

test('a disk grows through the call the host uses, in the host’s order', () => {
  // RESIZE_METHODS is what the machine image is grown with; the phone asks
  // the same server the same way, and prefers what the host prefers.
  const all = TABLE.methods.all;
  for (const m of RESIZE_METHODS) assert.ok(all.includes(m), `${m} is not in the table's method list`);
  const running = TABLE.tuning.find((/** @type {any} */ t) => t.component === 'vm-1' && t.methods === 'all');
  assert.equal(running.grow, RESIZE_METHODS[0]);
  const older = TABLE.tuning.find((/** @type {any} */ t) => Array.isArray(t.methods) && t.methods.length === 1 && t.methods[0] === RESIZE_METHODS[1]);
  assert.equal(older.grow, RESIZE_METHODS[1]);
});

test('the table offers nothing a server does not list, and nothing for a state it cannot tell', () => {
  // C-2 as data: every offered action's method is one the case listed.
  const all = new Set(TABLE.methods.all);
  for (const d of TABLE.details) {
    const listed = d.methods === 'all' ? all : new Set(d.methods);
    assert.ok(listed.has(d.method), `${d.component} ${d.action} calls ${d.method}, which its case does not list`);
  }
  const offered = (/** @type {string} */ id, /** @type {any} */ methods) =>
    TABLE.actions.find((/** @type {any} */ a) => a.component === id && JSON.stringify(a.methods) === JSON.stringify(methods)).offered;
  assert.deepEqual(offered('vm-1', []), []);
  assert.deepEqual(offered('vm-1', null), []);
  assert.deepEqual(offered('vm-7', 'all'), [], 'a VM whose state is not known is offered something');
  // What it costs decides how it asks, and the table holds that ladder.
  for (const d of TABLE.details) {
    const kind = { reversible: 'none', interrupting: 'ask', destructive: 'type' }[/** @type {'reversible'|'interrupting'|'destructive'} */ (d.cost)];
    assert.equal(d.confirm.kind, kind, `${d.component} ${d.action} costs ${d.cost} and asks ${d.confirm.kind}`);
    if (kind === 'type') assert.ok(d.confirm.title.includes(d.confirm.name), 'a typed confirmation names what is typed');
  }
});

test('cannot tell is said as cannot tell, never as zero', () => {
  // C-5, in the rows a person reads: a host with no numbers, a VM with no
  // state, storage with no size.
  const rows = Object.fromEntries(TABLE.components.map((/** @type {any} */ c) => [c.id, c]));
  assert.equal(rows['0f1e2d3c4b5a'].state, 'cannot tell');
  assert.match(rows['0f1e2d3c4b5a'].numbers, /cores: cannot tell · memory: cannot tell/);
  assert.equal(rows['vm-7'].state, 'cannot tell');
  assert.equal(rows['sr-3'].numbers, 'space: cannot tell');
  for (const c of TABLE.components) assert.doesNotMatch(`${c.what} ${c.numbers}`, /\b0 (GiB|vCPUs|cores)\b|undefined|null|NaN/);
  // A token that cannot see a host says so rather than naming none.
  assert.equal(rows['vm-6'].what, 'VM on a host this token cannot see');
});

test('iOS: the pin is checked in the TLS challenge, and nothing is sent to any other certificate', () => {
  const code = bare(IOS_LINK);
  // The server-trust challenge, the leaf's SHA-256 against the pin, and a
  // cancelled challenge for anything else.
  assert.match(code, /NSURLAuthenticationMethodServerTrust/);
  assert.match(code, /if XOLink\.fingerprint\(of: trust\) == pin \{\s*completionHandler\(\.useCredential, URLCredential\(trust: trust\)\)\s*\} else \{[\s\S]{0,120}?completionHandler\(\.cancelAuthenticationChallenge, nil\)/);
  assert.equal((code.match(/\.useCredential/g) ?? []).length, 1, 'a second place accepts a certificate');
  assert.match(code, /SHA256|Manage\.fingerprint\(der:/);
  // TLS only: there is no plain-HTTP path, and a pool set up over plain HTTP
  // is told so in words.
  assert.ok(IOS_LINK.includes('URL(string: "wss://\\(address)/api/")'));
  assert.ok(!IOS_LINK.includes('"ws://'));
  assert.match(bare(IOS_WATCH), /guard !record\.plain, let pin = record\.pin else \{\s*phase = \.stopped\(Manage\.Words\.plainPool\(address\), retry: false\)/);
  // The bound xo-ws.js keeps, so a large pool's answer arrives whole.
  assert.match(code, /maximumMessageSize = 16 \* 1024 \* 1024/);
});

test('iOS: the token is the one setup handed back, and no password is reached for', () => {
  const code = [IOS_MODEL, IOS_LINK, IOS_WATCH, IOS_SCREEN].map(bare).join('\n');
  // The record XOSetupHandoff keeps under the address, signed in with as a token.
  assert.match(code, /Keychain\.get\(XOSetupHandoff\.tokenAccount\(address\)\)/);
  assert.match(code, /link\.call\("session\.signIn", \["token": record\.token\]\)/);
  // Never the admin sign-in a person may keep for setup, and never a password.
  for (const banned of ['XOSaved', 'password', 'email']) assert.ok(!code.includes(banned), `the Manage code reaches for ${banned}`);
  // And it is written nowhere: the only thing these files keep is when.
  assert.ok(!/Keychain\.set\(/.test(code), 'the Manage code writes to the Keychain');
  assert.equal((code.match(/UserDefaults\.standard\.set\(/g) ?? []).length, 1, 'the Manage code keeps something besides when it last looked');
});

test('iOS: an action is drawn only from what the model offers, and asks by what it costs', () => {
  const screen = bare(IOS_SCREEN);
  // The buttons are the model's, so the parity table decides which there are.
  assert.match(screen, /let offered = Manage\.offered\(c, methods: methods\)/);
  assert.match(screen, /ForEach\(offered\) \{ a in\s*Button\(a\.label, role: a\.cost == \.destructive \? ButtonRole\.destructive : nil\) \{ tap\(a, c\) \}/);
  for (const d of TABLE.details) {
    assert.ok(!screen.includes(`Button("${d.label}"`), `${d.label} is drawn by the screen rather than offered by the model`);
  }
  // One tap, a question naming the cost, or the name typed back.
  assert.match(screen, /case \.none:\s*Task \{ await perform\(\.action\(a\)\) \}\s*case let \.ask\(title, button\):\s*asking = /);
  assert.match(screen, /case let \.typeName\(title, name, button\):\s*typing = /);
  // The typed one is off until the name matches.
  assert.match(screen, /Button\(button, role: \.destructive\) \{[\s\S]{0,200}?\}\s*\.disabled\(typed\.trimmingCharacters\(in: \.whitespaces\) != name\)/);
  // Nothing to offer is said, and why: unknown methods first.
  assert.match(screen, /\} else if methods == nil \{\s*note\(Manage\.Words\.methodsUnknown\)\s*\} else if offered\.isEmpty && !resize && !needsStopped && disks\.isEmpty \{\s*note\(Manage\.Words\.nothingOffered\)/);
  // A size change that needs the VM stopped is a sentence, not a button.
  assert.match(screen, /if resize \{\s*resizeRows\(c\)\s*\} else if needsStopped \{\s*note\(Manage\.Words\.tuneNeedsStopped\)/);
});

test('iOS: every control on the pool’s pages is a 44pt target', () => {
  const screen = bare(IOS_SCREEN);
  const controls = (screen.match(/\bButton\(|\bStepper\(|NavigationLink \{|TextField\(/g) ?? []).length;
  // The Cancel buttons of the dialog and the sheet's toolbar are the system's own, sized by it.
  const system = (screen.match(/Button\("Cancel"/g) ?? []).length;
  const tall = (screen.match(/\.frame\(minHeight: 44(, alignment: \.leading)?\)/g) ?? []).length;
  assert.ok(controls - system > 0);
  assert.ok(tall >= controls - system, `${controls - system} controls and ${tall} 44pt frames`);
});

test('iOS: the page is under Machines, on the row that names the pool, and says when it was last looked at', () => {
  // Machines → Hypervisors → the pool. The policy is a row on that page now.
  assert.match(IOS_MACHINES, /ForEach\(hypervisors\) \{ pool in\s*NavigationLink \{\s*PoolManageView\(settings: settings, pool: pool\)/);
  assert.match(IOS_SCREEN, /if settings\.showsAdmin \{\s*NavigationLink \{\s*AddHypervisorView\(settings: settings, policyFor: pool\.address\)/);
  // The row says how current the page will be: when, or never.
  assert.match(IOS_MACHINES, /Manage\.lastLooked\(pool\.address\)\.map \{ Manage\.Words\.rowLooked\([^\n]*\n\s*\?\? Manage\.Words\.never\)/);
  // And the page: watching, or the last time, and that nothing watches while closed.
  assert.match(bare(IOS_SCREEN), /case \.live: return Manage\.Words\.watching/);
  assert.match(IOS_MODEL, /static func lookedAt\(_ when: String\) -> String \{ "Last looked at \\\(when\)\. \\\(closed\)" \}/);
  assert.ok(TABLE.words.closed === 'Nothing watches while the app is closed.');
  // The socket closes when the app leaves the foreground, said as such.
  assert.match(bare(IOS_SCREEN), /if now == \.background \{\s*watch\.stop\(\)/);
});

test('iOS: notifications are applied in the order they arrived', () => {
  // The socket hands messages over in order and an enter then exit must not
  // become an exit then enter: the main queue keeps the order, a Task per
  // message need not.
  assert.match(bare(IOS_WATCH), /link\.onNotice = \{ \[weak self, weak link\] method, params in\s*DispatchQueue\.main\.async \{\s*MainActor\.assumeIsolated \{\s*guard let self, let link else \{ return \}\s*self\.notice\(method, params, from: link\)/);
  // And one from a link already let go of is not applied.
  assert.match(bare(IOS_WATCH), /private func notice\(_ method: String, _ params: XOLink\.Answer, from link: XOLink\) \{\s*guard holder\.peek\(\) === link else \{ return \}/);
  assert.ok(!/onNotice = \{[^}]*Task \{/.test(bare(IOS_WATCH)));
});

test('iOS: the question iOS asks before the local network says why', () => {
  const project = read('apps/ios/project.yml');
  assert.match(project, /NSLocalNetworkUsageDescription: >-\s*\n\s*Talking to your Xen Orchestra directly from this phone/);
  // And the table's own words reach the test bundle with the rest.
  assert.match(project, /- path: \.\.\/\.\.\/test\/fixtures\/parity\s*\n\s*type: folder/);
  assert.ok(IOS.includes('forResource: "manage", withExtension: "json", subdirectory: "parity"') || read('apps/ios/FleetwrightTests/ManageParityTests.swift').includes('forResource: "manage", withExtension: "json", subdirectory: "parity"'));
});

// ─── Android ────────────────────────────────────────────────────────────────
// Lands with the Android layer.
