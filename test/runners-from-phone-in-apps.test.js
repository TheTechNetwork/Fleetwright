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
  // "Runners from this phone" was the heading over all of this, inside the
  // section for adding a machine. The sign-in is an account the phone holds
  // now, under You, and neither app draws that heading.
  for (const words of [
    'Sign in to GitHub here and this phone starts your machines itself, with no permanent box. ',
    'What this phone sends is sealed to your fleet\'s minter, so nothing in between can read it.',
    'Looking for your fleet\'s minter…',
    'This fleet\'s minter does not answer for its own key. Paste the key whoever runs your fleet gave you.',
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
    'Update it from github.com/TheTechNetwork/Fleetwright-Runners-Template.',
  ]) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
});

test('a phone finds the minter key at the fleet address, and offers to paste one only when nothing answers', () => {
  // Nobody hunts for a key: the minter answers for its own at a path the
  // deploy routes past the coordinator (worker/src/minter.js, KEY_PATH). The
  // field to paste one is the fallback for a fleet with no such route, and is
  // drawn only then (C-2), never beside a key the phone already has.
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    assert.ok(src.includes('/.well-known/fleetwright-minter'), `${name} does not look the minter key up`);
    const gate = src.indexOf('minterFound == false');
    assert.ok(gate > 0, `${name} draws the key field whether or not the minter answered`);
    assert.ok(src.indexOf('Minter key from whoever runs your fleet', gate) > gate, `${name} draws the key field outside the fallback`);
  }
});

test('a phone seals to the key the minter answers with, and a saved one only when it does not answer', () => {
  // A key saved before the minter's was rotated must not win: a phone that
  // preferred it sealed every GitHub sign-in to the old key and failed. So in
  // the one function both phones seal through, the lookup comes before the
  // saved key.
  for (const [name, src] of [['iOS', IOS], ['Android', ANDROID]]) {
    const body = src.slice(src.search(/func? minterKey\(/));
    const lookup = body.indexOf('minterOwnKey()');
    const saved = body.indexOf('settings.minterPin');
    assert.ok(lookup >= 0 && saved >= 0, `${name} lost its minterKey`);
    assert.ok(lookup < saved, `${name} prefers a saved key over the one the minter answers with`);
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
