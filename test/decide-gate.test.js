// The coordinator's gate in front of the decision model
// (src/fleet/coordinator/decide.js refuseUnlessMasked), and its agreement with
// the host's mask.
//
// The gate refuses and never cleans, so a mask that can produce a gate hit is
// a feature that silently never fires for some panes. The second test holds
// the two to each other over every pane this repository has labelled.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { refuseUnlessMasked } from '../src/fleet/coordinator/decide.js';
import { maskPane } from '../src/core/mask-pane.js';
import { corpus } from '../scripts/decide-corpus.mjs';

test('each gate rule refuses, by name', () => {
  const ok = 'Do you want to proceed?\n 1. Yes\n 2. No';
  /** @type {Array<[string, any]>} */
  const cases = [
    ['images', { state: ok, images: [] }],
    ['no-state', { state: '' }],
    ['no-state', { state: 42 }],
    ['too-long', { state: 'word '.repeat(900) }],
    ['too-many-lines', { state: 'a\n'.repeat(41) }],
    ['long-run', { state: `${ok}\n${'x'.repeat(20)}` }],
    ['credential-shape', { state: `${ok}\nsk-ant-oat01` }],
    ['credential-shape', { state: `${ok}\nfwk_abc` }],
    ['credential-shape', { state: `${ok}\nsee http://x` }],
    ['credential-shape', { state: `${ok}\nme@example.org` }],
    ['credential-shape', { state: `${ok}\n-----BEGIN` }],
  ];
  for (const [why, msg] of cases) assert.equal(refuseUnlessMasked(msg), why, JSON.stringify(msg).slice(0, 80));
  assert.equal(refuseUnlessMasked({ state: ok }), null);
});

test('the gate passes everything the mask produces, from every labelled pane and the cases built to break it', () => {
  const fixtures = readdirSync(new URL('./fixtures/', import.meta.url))
    .filter((f) => /^claude-.*\.txt$/.test(f))
    .map((f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
  const adversarial = [
    // A capitalised word of exactly 20 letters is a word to the mask and a long run to the gate.
    'Internationalisation is a word',
    // A rule of dashes next to a kept all-caps word.
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    // A bare scheme whose core is the word "https".
    'see (https:// here',
    '__________________________ underscores',
  ];
  for (const pane of [...fixtures, ...corpus().map((i) => i.text), ...adversarial]) {
    const state = maskPane(pane);
    assert.equal(refuseUnlessMasked({ state }), null, `the gate refused the mask's own output:\n${state.slice(0, 300)}`);
  }
});
