// What the vault screens say a box holds, on iOS.
//
//   node --test test/vault-approval-ios-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: Swift and Kotlin
// compile only in CI, so what a person sees is pinned here as words.
//
// A pool's own machine is approved for one record (`only`), and the box's page
// said "Your credentials: Approved" over it, and the vault list "Held by" it,
// as if it held the whole vault (eighth audit, CLAUDE.md C-5). The page also
// found the grant by the key's sixteen-character start, not the whole hash the
// minter names it by.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = read('apps/ios/Fleetwright/RunnersFromPhone.swift');

test('a box approved for part of the vault is shown holding only that', () => {
  assert.match(IOS, /grant\.only\.isEmpty \? "Approved" : "Only " \+ grant\.only\.map\(PhoneVault\.label\)/);
  // The vault list names what a scoped box holds beside its name.
  assert.match(IOS, /grant\.only\.isEmpty \? name : "\\\(name\) \(\\\(grant\.only\.map\(PhoneVault\.label\)\.joined\(separator: ", "\)\) only\)"/);
});

test('the box page finds its grant by the whole key hash, not its start', () => {
  assert.match(IOS, /grant = contents\.grants\.first \{ \$0\.key == whole \}/);
  assert.doesNotMatch(IOS, /grant = contents\.grants\.first \{ \$0\.fingerprint == fingerprint \}/);
});
