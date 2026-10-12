// A pool's own machine asking to join, on the phones: one approval that lets
// it in and lets it hold that pool and nothing else, checked against the
// secret this phone made before anything is let in, offered only when there
// is a request, and said in the same words on both.
//
//   node --test test/holder-join-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. The proof itself is run, not read: HolderJoinTests.swift and
// HolderJoinTest.kt hold it to test/fixtures/parity/holder-join.json. ASKED
// FOR: "Should it ask us for a pin we request it from the app it gets Face
// ID", and "If I approve why shouldn't it approve both?". docs/hypervisors.md,
// "A machine of its own".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HYPERVISOR_PREFIX } from '../src/fleet/minter/vault.js';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const A = (/** @type {string} */ f) => read(`apps/android/app/src/main/java/network/thetech/fleetwright/${f}`);
const I = (/** @type {string} */ f) => read(`apps/ios/Fleetwright/${f}`);

const PHONES = [
  {
    name: 'iOS',
    words: I('HolderJoin.swift'),
    card: I('HoldersAskingView.swift'),
    vault: I('PhoneVault.swift'),
    form: I('AddHypervisorView.swift'),
    /** A name as Swift interpolates it. */
    put: (/** @type {string} */ v) => `\\(${v})`,
  },
  {
    name: 'Android',
    words: A('HolderJoin.kt'),
    card: A('HoldersAsking.kt'),
    vault: A('PhoneVault.kt'),
    form: A('PolicyForm.kt'),
    put: (/** @type {string} */ v) => (v.includes('.') ? `\${${v}}` : `$${v}`),
  },
];

/**
 * What both phones say, word for word, with the names they fill in. A long
 * sentence is split where both sources break the line, so each piece is one
 * literal on both.
 */
const SAID = [
  ['{hostId} asks to join'],
  ['To hold {address}. This phone checks it is the machine you made before it lets it in.'],
  ['{hostId} has not asked to join yet. If it never does, make it again from the pool’s policy.'],
  ['Let {hostId} join and hold {address}'],
  ['None of the requests under {hostId} was made by the machine this phone made, so nothing was let in. ', 'Decline it, and make the pool’s own machine again if it never asks.'],
  ['This phone did not make {hostId}, so it cannot check it. Let it in from the phone that applied the policy, or make it again from this one.'],
  ['{hostId} has joined and holds {address}.'],
  ['{hostId} has joined, and could not be approved to hold its pool: {why} Approve it under its page.'],
];

const fill = (/** @type {string} */ s, /** @type {(v: string) => string} */ put, /** @type {Record<string, string>} */ names) =>
  s.replace(/\{(\w+)\}/g, (_, k) => put(names[k] ?? k));

test('the one approval lets the machine hold that pool and nothing else of yours', () => {
  for (const p of PHONES) {
    // The vault's own name for a pool's record, and only it: a grant
    // without `only` would hand the machine every item the person keeps.
    const only = p.name === 'iOS' ? `"only": ["${HYPERVISOR_PREFIX}\\(address)"]` : `.put("only", JSONArray().put("${HYPERVISOR_PREFIX}$address"))`;
    assert.ok(p.vault.includes(only), `${p.name}: the holder's grant is scoped to its pool`);
  }
});

test('nothing is let in before this phone’s secret proves the request, and the key let in is the one proved', () => {
  for (const p of PHONES) {
    const unlock = p.card.indexOf('HolderJoin.unlock(');
    const proven = p.card.indexOf('HolderJoin.proven(');
    const admit = p.card.indexOf('.approveHolder(');
    assert.ok(unlock > 0 && unlock < proven && proven < admit, `${p.name}: the owner's check, then the proof, then the fleet`);
    // A request none of the secrets proves is said, and the card stops there.
    assert.match(p.card.slice(proven, admit), /notProven\(/, `${p.name}: an unproved request is refused in words`);
    // The vault is asked for the same key the fleet let in, after it did.
    const vault = p.card.indexOf('PhoneVault(');
    assert.ok(vault > admit, `${p.name}: holding the pool follows joining`);
    assert.match(p.card.slice(vault, vault + 200), /request\.publicJwk/, `${p.name}: the vault approves the key that was proved`);
  }
});

test('Let it in and Decline are offered only for a name something has asked under', () => {
  for (const p of PHONES) {
    const offer = p.name === 'iOS' ? /if !w\.requests\.isEmpty && !isIn\(w\) \{/ : /if \(asked && !admitted\) \{/;
    const at = p.card.search(offer);
    assert.ok(at > 0, `${p.name}: the buttons are behind a request`);
    const after = p.card.slice(at);
    assert.ok(after.includes('"Let it in"') && after.includes('"Decline"'), `${p.name}: Let it in and Decline`);
  }
});

test('both phones say it in the same words', () => {
  const names = {
    iOS: { hostId: 'hostId', address: 'address', why: 'why' },
    Android: { hostId: 'hostId', address: 'address', why: 'why' },
  };
  for (const p of PHONES) {
    for (const pieces of SAID) {
      for (const piece of pieces) {
        const said = fill(piece, p.put, names[/** @type {'iOS'|'Android'} */ (p.name)]);
        assert.ok(p.words.includes(said), `${p.name}: ${said}`);
      }
    }
  }
});

test('the policy form offers to make it again, and says what the new one does, in the same words', () => {
  const lines = [
    ['Make it again'],
    ['Removes {name}, disk and all, and makes a new one that asks to join. For one that never joined the fleet.'],
    ['to be awake. Once it is up it asks to join, and this phone ', 'asks you to let it in and hold the pool.'],
  ];
  for (const p of PHONES) {
    for (const pieces of lines) {
      for (const piece of pieces) {
        const said = fill(piece, p.put, { name: 'mine.name' });
        assert.ok(p.form.includes(said), `${p.name}: ${said}`);
      }
    }
    // Only from a machine that makes the new one ask (C-2).
    assert.match(p.form, p.name === 'iOS' ? /if choice\.holderAskChoice \{\s*Toggle\(isOn: \$choice\.holderAgain\)/ : /if \(choice\.holderAskChoice\) \{\s*CheckRow\(\s*checked = choice\.holderAgain/);
  }
});
