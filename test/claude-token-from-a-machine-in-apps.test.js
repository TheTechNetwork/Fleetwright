// Both phones can have one of their machines make the Claude token, rather
// than asking for the output of a command run on a computer.
//
//   node --test test/claude-token-from-a-machine-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. The host's half, running the command and sealing
// what it prints, is proven in setup-token.test.js.
//
// ASKED FOR FROM A PHONE: "If a host is available why not offer to run it,
// return the link, open the page, capture the token?"

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';

const IOS = iosSources();

test('iOS: a connected machine is offered, and its page opens by itself', () => {
  assert.match(IOS, /machines = hosts\.filter \{ \(\$0\.state \?\? ""\) != "offline" \}\.map\(\\\.hostId\)\.sorted\(\)/);
  assert.match(IOS, /Button\(busy \? "Starting…" : "Make it on \\\(machine\)"\)/);
  assert.match(IOS, /let reply = try await Fleet\(settings: settings\)\.setupToken\(host: machine\)[\s\S]{0,400}?openURL\(url\)/);
  // The paste field stays, for a fleet with no machine connected.
  assert.ok(IOS.includes('Token from claude setup-token'));
});

test('iOS: the token comes back sealed to a key made for that one answer, and is kept like a pasted one', () => {
  assert.match(IOS, /static let setupTokenAAD = "fleetwright-setup-token\/v1"/);
  const keep = IOS.slice(IOS.indexOf('func keepTokenFromMachine('), IOS.indexOf('private func github('));
  assert.match(keep, /let key = Seal\.newKey\(\)/);
  assert.match(keep, /setupToken\(host: host, code: code, reply: key\.publicKey\)/);
  assert.match(keep, /Seal\.open\(key, aad: Seal\.setupTokenAAD, sealed: sealed\)/);
  assert.match(keep, /return try await depositClaudeLogin\(fleet, claudeToken: token\)/);
});

test('iOS: a code is never held in the outbox', () => {
  // The outbox writes what it holds to disk and replays it; passing an id is
  // what keeps a send that could not reach the fleet out of it.
  assert.match(IOS, /intent\("setuptoken", params: params, host: host, idempotencyKey: "app-\\\(UUID\(\)\.uuidString\)"\)/);
});
