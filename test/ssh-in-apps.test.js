// SSH IN THE APP, on both phones. Asked for: "if it's not on local network
// should be able to reach it somehow as well as ssh". Each phone makes its own
// key and keeps it, puts only the public half in the vault under the item the
// boxes read beside the pasted keys, signs in as fleetwright, holds a machine
// to the host key it showed first, and from away goes through a tunnel that
// names the machine. Both say it in the same words.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SSH_PHONE_KEY_PREFIX } from '../src/fleet/host/xo-pools.js';

const raw = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = 'apps/ios/Fleetwright/';
const KT = 'apps/android/app/src/main/java/network/thetech/fleetwright/';

test('both phones make their own key, and only its public half goes to the vault, as the item the boxes read', () => {
  const iosKey = raw(`${IOS}PhoneSSHKey.swift`);
  const ktKey = raw(`${KT}SshTerminal.kt`);
  const item = SSH_PHONE_KEY_PREFIX.replace(/^secret:/, '');
  assert.ok(iosKey.includes(`"${item}" + digest.prefix(6)`), 'iOS names its key otherwise than the boxes read');
  assert.ok(ktKey.includes(`"${item}" + MessageDigest.getInstance("SHA-256")`), 'Android names its key otherwise than the boxes read');
  // Made on the phone, kept on the phone.
  assert.match(iosKey, /let key = Curve25519\.Signing\.PrivateKey\(\)\s*Keychain\.set\(key\.rawRepresentation\.base64EncodedString\(\), for: account\)/);
  assert.match(ktKey, /KeyPairGenerator\.getInstance\("Ed25519", bc\)\.generateKeyPair\(\)\s*settings\.putSecret\(/);
  // What goes to the vault is the public line and nothing else.
  assert.match(iosKey, /keepSecret\(Fleet\(settings: settings\), name: itemName\(\), value: publicLine\(\)\)/);
  assert.match(ktKey, /keepSecret\(Fleet\(settings\), itemName\(settings\), publicLine\(settings\)\)/);
  // Gone at sign-out.
  assert.match(raw(`${IOS}Fleet.swift`), /ProxmoxKept\.forgetAll\(\)\s*PhoneSSHKey\.forgetAll\(\)/);
  assert.match(raw(`${KT}Fleet.kt`), /"secret\.ssh-phone-key", "secret\.ssh-host-keys"/);
});

test('both phones sign in as fleetwright with that key, hold a machine to its first host key, and go through a tunnel naming it from away', () => {
  const iosTerm = raw(`${IOS}SSHTerminal.swift`);
  const ktTerm = raw(`${KT}SshTerminal.kt`);
  assert.match(iosTerm, /NIOSSHUserAuthenticationOffer\(username: "fleetwright", serviceName: "", offer: \.privateKey/);
  assert.match(ktTerm, /ssh\.authPublickey\("fleetwright", ssh\.loadKeys\(PhoneSshKey\.keyPair\(settings\)\)\)/);
  // The first host key a machine showed, and no other after.
  assert.match(iosTerm, /if let first = PhoneSSHKey\.hostKey\(of: machine\), first != seen \{\s*validationCompletePromise\.fail/);
  assert.match(ktTerm, /if \(first != null && first != seen\) \{\s*other = seen\s*return false/);
  // From away, a tunnel naming the machine, after the machine's own network did not answer.
  assert.match(raw(`${IOS}ConsoleTunnel.swift`), /URLQueryItem\(name: "machine", value: \$0\)/);
  assert.match(raw(`${KT}ConsoleTunnel.kt`), /"&machine=" \+ URLEncoder\.encode\(it, "UTF-8"\)/);
  assert.match(raw(`${IOS}SSHTerminalView.swift`), /ConsoleTunnel\(address: address, machine: machine\)/);
  assert.match(raw(`${KT}TerminalPage.kt`), /ConsoleTunnel\(address, machine\)/);
  // The key never reaches the page.
  for (const f of [`${IOS}SSHTerminalView.swift`, `${KT}TerminalPage.kt`]) {
    assert.ok(!/evaluate[jJ]ava[sS]cript\([^)]*(key|Key)/.test(raw(f)), `${f} hands the key to the page`);
  }
});

test('both phones offer the terminal for a running machine with an address, and say it in the same words', () => {
  assert.match(raw(`${IOS}VMMachineView.swift`), /if m\.state == "Running", let ip = m\.ip \{\s*NavigationLink \{\s*SSHTerminalView\(settings: settings, machine: m\.name, address: m\.address, ip: ip\)/);
  assert.match(raw(`${KT}VmMachinePage.kt`), /if \(m\.state == "Running" && m\.ip != null\) \{\s*OpenRow\(TerminalWords\.OPEN\) \{ terminal = true \}/);
  const ios = raw(`${IOS}SSHTerminalView.swift`);
  const kt = raw(`${KT}TerminalPage.kt`);
  const words = [...ios.matchAll(/static let (\w+) = "([^"]+)"/g)];
  assert.ok(words.length >= 8);
  const kotlinName = (/** @type {string} */ n) => n.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
  for (const [, name, text] of words) {
    if (name === 'base') continue;
    assert.ok(kt.includes(`const val ${kotlinName(name)} = "${text}"`), `Android says ${name} otherwise`);
  }
});
