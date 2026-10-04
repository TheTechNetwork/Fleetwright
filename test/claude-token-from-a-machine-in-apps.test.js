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
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

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

test('Android: a connected machine is offered, and its page opens by itself', () => {
  assert.match(ANDROID, /machines = Fleet\(settings\)\.fleetHosts\(\)\.filter \{ it\.state != "offline" \}\.map \{ it\.hostId \}\.sorted\(\)/);
  assert.match(ANDROID, /Text\(if \(busy\) "Starting…" else "Make it on \$machine"\)/);
  assert.match(ANDROID, /val reply = Fleet\(settings\)\.setupToken\(machine\)[\s\S]{0,500}?uri\.openUri\(url\)/);
  assert.ok(ANDROID.includes('Token from claude setup-token'));
});

test('Android: the token comes back sealed to a key made for that one answer, and is kept like a pasted one', () => {
  assert.match(ANDROID, /const val SETUP_TOKEN_AAD = "fleetwright-setup-token\/v1"/);
  const keep = ANDROID.slice(ANDROID.indexOf('suspend fun keepTokenFromMachine('), ANDROID.indexOf('private fun github('));
  assert.match(keep, /val key = Seal\.newKey\(\)/);
  assert.match(keep, /fleet\.setupToken\(host, code = code, reply = key\.publicKey\)/);
  assert.match(keep, /Seal\.open\(key, Seal\.SETUP_TOKEN_AAD, sealed\)/);
  assert.match(keep, /depositClaudeLogin\(fleet, token\)/);
  assert.match(ANDROID, /"setuptoken",[\s\S]{0,200}?idempotencyKey = "app-"/);
});

test('both phones say the same things', () => {
  for (const words of [
    'runs claude setup-token for you. The token comes back sealed to this phone, ',
    'and the machine keeps no copy.',
    '1. Open the sign-in page',
    '2. Sign in to Claude, copy the code the page shows, and paste it here.',
    'Code from the sign-in page',
    '3. Keep my Claude login',
    'Or, on a computer, run claude setup-token, sign in, and paste the line it prints here.',
  ]) {
    assert.ok(IOS.includes(words), `iOS does not say: ${words}`);
    assert.ok(ANDROID.includes(words), `Android does not say: ${words}`);
  }
});
