// A pool no machine can reach, added through the phone: what the phones show
// and what they carry. docs/hypervisors.md, "Through the phone".
//
//   node --test test/relay-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. Pinned here is what a person meets — the offer
// only when the fleet named a machine that can take it (C-2), cannot tell said
// as cannot tell (C-5), the same sentences on both phones — and what the
// coordinator and the machine rely on: the frames, the one address, and the
// check that the machine saw the certificate the phone sees itself. The
// coordinator's half is xo-relay-coordinator.test.js, the whole path
// relay-end-to-end.test.js.
//
// THE ANDROID HALF lands on its own branch, stacked on this one
// (CONTRIBUTING.md); the marked block at the bottom is its place.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RELAY_MAX_CHUNK } from '../src/fleet/coordinator/relays.js';
import { VERBS } from '../src/fleet/protocol/intents.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SCREEN = read('apps/ios/Fleetwright/AddHypervisorView.swift');
const RELAY = read('apps/ios/Fleetwright/XORelay.swift');
const FLEET = read('apps/ios/Fleetwright/Fleet.swift');

/** The sentences both phones say, word for word. */
const SAID = [
  'Try through this phone',
  'can work through this phone: it opens HTTPS to Xen Orchestra ',
  'itself, and this phone and the fleet carry only that encrypted connection. Keep this screen open while it runs.',
  'Reached Xen Orchestra through this phone',
  'Reached something through this phone; cannot tell whether it is Xen Orchestra',
  'so something between them answered in Xen Orchestra’s place. Nothing was sent.',
  'Keep this screen open until it is done.',
];

test('iOS: through this phone is offered only when the fleet named a machine that can take it, and never for a policy change', () => {
  // C-2: an older fleet names nobody, and then nothing new is offered.
  assert.match(SCREEN, /throughOffer = isPolicy \? nil : reply\.relay\?\.hostId/);
  assert.match(SCREEN, /if offered\.isEmpty \{[\s\S]{0,700}?if let via = throughOffer, job == nil \{[\s\S]{0,400}?Button\(probing \? "Asking through this phone…" : "Try through this phone"\)/);
  assert.match(FLEET, /var relay: RelayOffer\?/);
  // A new probe, or a new address, takes the offer and any relay away.
  assert.match(SCREEN, /\.onChange\(of: address\)[\s\S]{0,700}?throughOffer = nil\s*endRelay\(\)/);
  for (const words of SAID) assert.ok(SCREEN.includes(words), words);
});

test('iOS: the machine is offered only when it saw the certificate this phone sees itself, and cannot tell stops it', () => {
  const flow = SCREEN.slice(SCREEN.indexOf('private func probeThroughPhone('), SCREEN.indexOf('private func relayClosed('));
  // In this order: this phone's own look, the relay, the probe through it.
  const at = (/** @type {string} */ s) => flow.indexOf(s);
  assert.ok(at('PhoneRelay.ownLook(address: target)') > 0);
  assert.ok(at('PhoneRelay.ownLook(address: target)') < at('carrier.open(settings: settings, host: via)'));
  assert.ok(at('carrier.open(settings: settings, host: via)') < at('fleet.xoprobeThrough(address: target, relay: ready.relay)'));
  // Nothing seen here is cannot tell, and it goes no further (C-5).
  assert.match(flow, /guard let own = await PhoneRelay\.ownLook\(address: target\) else \{\s*probeText = "This phone could not reach \\\(target\) over HTTPS itself/);
  // A different certificate closes the relay and offers nothing.
  assert.match(flow, /guard seen\.cert == own else \{\s*carrier\.close\(\)/);
  // The pin is the SHA-256 of the certificate's DER, in the machine's hex.
  assert.match(RELAY, /SHA256\.hash\(data: der\)\.map \{ String\(format: "%02x", \$0\) \}\.joined\(\)/);
  assert.match(RELAY, /SecCertificateCopyData\(leaf\) as Data/);
});

test('iOS: the phone connects only to the address the person typed, and carries the frames the fleet speaks', () => {
  // One target, parsed once; no frame is read for where to connect.
  assert.match(RELAY, /NWConnection\(host: target\.host, port: target\.port, using: \.tcp\)/);
  assert.ok(!/frame\["(address|host|port)"\]/.test(RELAY), 'a frame never names where the phone connects');
  // What it answers, and what it understands, are the coordinator's ops.
  for (const op of ['opened', 'refused', 'data', 'end']) assert.ok(RELAY.includes(`"op": "${op}"`), op);
  for (const op of ['ready', 'closed', 'open', 'data', 'end']) assert.ok(RELAY.includes(`case "${op}":`), op);
  assert.match(RELAY, new RegExp(`static let chunk = ${RELAY_MAX_CHUNK / 1024} \\* 1024`));
  assert.ok(RELAY.includes('settings.coordinatorURL + "/api/xosetup/relay"'));
  // Not over cleartext: the upgrade carries this device's credential.
  assert.match(RELAY, /if scheme != "https", !Fleet\.isLocal\(parts\.host\) \{/);
  // And iOS says why it asks for the local network, this reason among the
  // others: the one key is shared with a pool's page (manage-in-apps).
  assert.match(read('apps/ios/project.yml'), /NSLocalNetworkUsageDescription: >-[^#]*to reach one you are adding when none of\s+your machines can, at the address you typed and nowhere else\./);
});

test('iOS: the job goes through the relay only for a machine that reached it that way, and the relay ends with it', () => {
  assert.match(SCREEN, /relay: probe\.throughPhone \? relayId : nil\)/);
  assert.match(FLEET, /if let relay \{ params\["relay"\] = relay \}/);
  assert.ok(VERBS.xosetup.params.relay && VERBS.xoprobe.params.relay, 'the protocol carries it');
  // Without its relay, a through-phone machine is not begun on.
  assert.match(SCREEN, /if probe\.throughPhone, relayId == nil \{\s*refuse\("This phone is no longer carrying the connection/);
  // Ended with the job, with the screen, and on Try again.
  assert.match(SCREEN, /if let now = state\.state, !XOSetupWords\.isLive\(now\) \{\s*endRelay\(\)/);
  assert.match(SCREEN, /\.onDisappear \{ endRelay\(\) \}/);
  assert.match(SCREEN, /private func reset\(\) \{\s*endRelay\(\)/);
  // Where the sign-in crosses is said beside what it crosses as.
  assert.ok(SCREEN.includes('It then crosses this phone inside the HTTPS connection \\(chosen.hostId) opens to Xen Orchestra, which neither this phone nor the fleet can read.'));
});

// --- Android ---------------------------------------------------------------
