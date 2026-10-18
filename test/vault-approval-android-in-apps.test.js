// What the vault screens say a box holds, on Android.
//
//   node --test test/vault-approval-android-in-apps.test.js
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
const ANDROID = read('apps/android/app/src/main/java/network/thetech/fleetwright/YourVault.kt');

test('a box approved for part of the vault is shown holding only that', () => {
  assert.match(ANDROID, /else "Your credentials: only \$\{held\.only\.joinToString/);
  // The vault list names what a scoped box holds beside its name.
  assert.match(ANDROID, /if \(g\.only\.isEmpty\(\)\) name else "\$name \(\$\{g\.only\.joinToString\(", "\) \{ PhoneVault\.label\(it\) \}\} only\)"/);
});

test('the box page finds its grant by the whole key hash, not its start', () => {
  assert.match(ANDROID, /grant = c\.grants\.firstOrNull \{ it\.key == whole \}/);
  assert.doesNotMatch(ANDROID, /grant = c\.grants\.firstOrNull \{ it\.fingerprint == fingerprint \}/);
});
