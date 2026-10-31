// The pool master's addresses, on the phones: kept in the record as the
// machine sealed it, shown on the pool's page in one line only when the
// record says, and said in the same words on both phones.
//
//   node --test test/pool-masters-in-apps.test.js
//
// Read from the source the way every *-in-apps test is: neither phone builds
// here. ASKED FOR: a pool master that flaps between two addresses, so that
// when it stops answering on one the person has the other to hand.
// docs/hypervisors.md, "What ships first" and "When Xen Orchestra loses a
// pool"; the field is poolMastersOf in src/fleet/host/xo-setup.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const I_HANDOFF = read('apps/ios/Fleetwright/XOSetupHandoff.swift');
const I_WORDS = read('apps/ios/Fleetwright/Manage.swift');
const I_PAGE = read('apps/ios/Fleetwright/ManageView.swift');
const HOST = read('src/fleet/host/xo-setup.js');

/** What both phones say, word for word: the line, and how a second address joins it. */
const SHARED = ['"Pool master: ', '", also '];

test('the field the phones read is the one the machine writes, and the record is kept as sealed', () => {
  assert.match(HOST, /\.\.\.\(masters\.length \? \{ masters \} : \{\}\),/, 'the hand-off record carries `masters`, or leaves it out');
  // The phone keeps the record as the machine sealed it, every field: the
  // JSON it opened is what goes in the Keychain, so a field it does not
  // know rides along and is there to read later.
  assert.match(I_HANDOFF, /let json = try\? JSONSerialization\.data\(withJSONObject: record\)/);
  assert.match(I_HANDOFF, /let masters = object\["masters"\] as\? \[String\]/);
});

test('iOS: the pool’s page says where the master answers, only when the record says, and keeps the words selectable', () => {
  // Read once from the record, not on every draw; empty is "not recorded",
  // and then no line at all (C-5).
  assert.match(bare(I_PAGE), /masters = XOSetupHandoff\.masters\(of: pool\.address\)/);
  assert.match(bare(I_PAGE), /if !masters\.isEmpty \{\s*Text\(Manage\.Words\.poolMaster\(masters\)\)[\s\S]{0,200}?\.textSelection\(\.enabled\)/);
  // An address that is not one is not shown.
  assert.match(I_HANDOFF, /return masters\.filter \{ XOSetupKey\.isAddress\(\$0\) \}/);
});

test('both phones say it in the same words, and no button offers a second server yet', () => {
  for (const words of SHARED) assert.ok(I_WORDS.includes(words), `iOS: ${words}`);
  // The sentence: the management address, then the others after "also".
  assert.match(I_WORDS, /"Pool master: \\\(first\)" \+ \(rest\.isEmpty \? "" : ", also \\\(rest\.joined\(separator: ", "\)\)"\)/);
  // Nothing on the page acts on them: a line, not a verb (C-2).
  assert.ok(!/Button\([^)]*(?:master|Master)/.test(bare(I_PAGE)), 'iOS offers no action on the pool master');
});
