// Both phones start runners themselves, and say so in the same words.
//
//   node --test test/runners-from-phone-in-apps.test.js
//
// A read of the sources, not a run, like runner-repo-in-apps.test.js: the
// Swift and the Kotlin compile only in CI, and the seal each phone builds is
// held to the minter's own bytes by SealTest.kt and SealTests.swift. What
// neither can check is that the OTHER phone offers the same thing, seals under
// the same purposes, and asks a person the same questions.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEPOSIT_AAD, GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, VAULT_REQUEST_AAD, VAULT_REPLY_AAD } from '../src/fleet/seal.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const IOS = ['Fleet.swift', 'PhoneGitHub.swift', 'RunnersFromPhone.swift', 'Seal.swift', 'DeviceSignIn.swift', 'PhoneVault.swift']
  .map((f) => read(`apps/ios/Fleetwright/${f}`))
  .join('\n');
const ANDROID = ['Fleet.kt', 'PhoneGitHub.kt', 'RunnersFromPhone.kt', 'Seal.kt', 'DeviceSignIn.kt', 'PhoneVault.kt', 'YourVault.kt']
  .map((f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`))
  .join('\n');

test('both phones seal under the purposes the minter opens with', () => {
  // A phone sealing under a stale string gets "that did not open" from the
  // minter and nothing else, so the strings are checked against seal.js itself.
  for (const aad of [DEPOSIT_AAD, GITHUB_REQUEST_AAD, GITHUB_REPLY_AAD, VAULT_REQUEST_AAD, VAULT_REPLY_AAD]) {
    assert.ok(IOS.includes(`"${aad}"`), `iOS does not seal under ${aad}`);
    assert.ok(ANDROID.includes(`"${aad}"`), `Android does not seal under ${aad}`);
  }
});

test('the words about runners from a phone are the same on both', () => {
  for (const words of [
    'Runners from this phone',
    'Sign in to GitHub here and this phone starts your machines itself, with no permanent box. ',
    'The minter key makes sure what this phone sends can be read by your fleet\'s minter and nothing in between.',
    'Minter key from whoever runs your fleet',
    'Check and save key',
    'Sign in to GitHub',
    'Sign out of GitHub',
    'Signed out of GitHub on this phone. Machines you start now go through a permanent box.',
    'Runners you start can use your Claude subscription instead of the runner repository\'s API key. ',
    'Make the token on a computer with claude setup-token, and paste it here.',
    'Token from claude setup-token',
    'Keep for my runners',
    'Forget my Claude login',
    'The fleet\'s minter has a different key from the one you were given, so nothing was saved. Ask whoever runs your fleet.',
    'It takes a few minutes to boot and then ',
    'Update it from install/runner-central/ in the Fleetwright repository.',
  ]) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
});

test('a phone signed in to GitHub starts the machine itself, and one that is not still can', () => {
  // The whole point: no permanent box when the phone can dispatch. And the
  // fallback stays, because a fleet with a box and a person who never signs
  // in on the phone should lose nothing.
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.match(src, /startRunner\(/, `${name} cannot dispatch from the phone`);
    assert.ok(src.includes('/api/runners/dispatch'), `${name} never asks the fleet for a dispatch ticket`);
    assert.ok(src.includes('/actions/workflows/'), `${name} never makes the dispatch itself`);
    assert.match(src, /intent\(\s*"provision"/, `${name} lost the box fallback`);
  }
});

test('the GitHub sign-in is PKCE with a state the phone checks, and the code goes to the minter sealed', () => {
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.ok(src.includes('code_challenge_method'), `${name} signs in without PKCE`);
    assert.match(src, /"state"\)?\s*==\s*state/, `${name} does not check the state that comes back`);
    assert.ok(src.includes('/api/github/device'), `${name} does not finish the sign-in through the minter`);
    // The client secret is the minter's and nowhere else. A phone that holds
    // one has given it to everybody who can unzip the app.
    assert.doesNotMatch(src, /client_secret|clientSecret/, `${name} holds a client secret`);
  }
});

test('the words about a vault are the same on both phones', () => {
  for (const words of [
    'Your vault',
    'Keep each credential here once. A box you approve gets them when a session needs them, ',
    'and loses them when you remove it.',
    'Nothing kept yet.',
    'Kept: ',
    'Loading your vault…',
    'Keep GitHub for my boxes',
    'Keep Cloudflare for my boxes',
    'Secret name',
    'Secret value',
    'Keep secret',
    'Boxes',
    'Approve a box only if fleetwright-sidecar identity on it prints the same fingerprint.',
    'Approved',
    'Approve',
    'Remove',
    'no key listed',
    'This phone does not know which fleet account it is signed in as. Sign in to the fleet again.',
  ]) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
});

test('both phones reach the vault through the fleet, and approve a box by a fingerprint they work out themselves', () => {
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.ok(src.includes('/api/vault'), `${name} never reaches the vault`);
    assert.ok(src.includes('/api/cloudflare/device'), `${name} cannot sign in to Cloudflare for the vault`);
    for (const op of ['"list"', '"put"', '"forget"', '"connect"', '"grant"', '"revoke"']) {
      assert.ok(src.includes(op), `${name} never asks the vault to ${op}`);
    }
    // THE FINGERPRINT IS COMPUTED, over the canonical key, never read off the
    // fleet's listing: the fleet listing a fingerprint beside a key of its own
    // choosing is exactly the attack the comparison exists to catch.
    assert.match(src, /SHA-256|SHA256/, `${name} does not hash the key itself`);
    assert.match(src, /\{\\"crv\\":/, `${name} does not build the canonical key`);
  }
});
