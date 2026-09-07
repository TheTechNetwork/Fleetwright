import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readLabels, addLabel, removeLabel, describeLabels } from '../src/core/labels.js';

const box = () => ({ stateDir: mkdtempSync(path.join(tmpdir(), 'labels-')) });

test('a box nobody has labelled from an app has none set', () => {
  assert.deepEqual(readLabels(box()), []);
});

test('a label added from an app survives the command that set it', () => {
  const cfg = box();
  const r = addLabel(cfg, 'gpu');
  assert.equal(r.ok, true);
  assert.deepEqual(r.labels, ['gpu']);
  // The whole reason this is a file in the state directory and not a variable.
  assert.deepEqual(readLabels(cfg), ['gpu']);
});

test('a label is lower-cased on the way in, once', () => {
  // `tag` is compared for equality by the scheduler, so `GPU` stored and `gpu`
  // aimed is a label that exists and can never be matched — which looks exactly
  // like tags being broken.
  const cfg = box();
  addLabel(cfg, 'GPU');
  assert.deepEqual(readLabels(cfg), ['gpu']);
  assert.equal(removeLabel(cfg, 'Gpu').ok, true);
});

test('a fact the machine derives cannot be removed, and says where it comes from', () => {
  // THE RULE THIS FILE EXISTS AROUND. `arm64` is a fact; a fact somebody can
  // switch off from a phone is not one, and `tag: arm64` finding a box that
  // turned its label off is the scheduler lying about what it matched.
  const cfg = box();
  const r = removeLabel(cfg, 'arm64', ['arm64', 'linux']);
  assert.equal(r.ok, false);
  assert.match(r.message, /comes from the machine itself or from AGENT_FLEET_LABELS/);
  // AND IT SAYS WHAT TO DO INSTEAD. "no such label" about a label the app is
  // displaying is the least useful true sentence available.
  assert.match(r.message, /edit AGENT_FLEET_LABELS/);
});

test('adding a label the box already derives changes nothing and says so', () => {
  // Not an error: the box HAS the label. But storing a second copy would make a
  // later remove look like it worked and change nothing at all.
  const cfg = box();
  const r = addLabel(cfg, 'arm64', ['arm64']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.labels, []);
  assert.deepEqual(readLabels(cfg), []);
});

test('a string that could never be matched is refused', () => {
  const cfg = box();
  for (const bad of ['-gpu', 'a b', 'gpu!', '', 'x'.repeat(41), '1'.repeat(41)]) {
    assert.equal(addLabel(cfg, bad).ok, false, `${JSON.stringify(bad)} was accepted`);
  }
  // The charset is the protocol's `name` type on purpose: two validators
  // disagreeing about what a label may contain is how a label gets stored that
  // nothing can ever aim at.
  assert.equal(addLabel(cfg, 'rack-4.b_2').ok, true);
});

test('a leading dash cannot be stored, because it would become a flag', () => {
  // The same property session names have, and for the same reason: agent-hub's
  // parser treats a token starting with `--` as a flag.
  assert.equal(addLabel(box(), '--dangerous').ok, false);
});

test('removing one that was never set says so without pretending', () => {
  const r = removeLabel(box(), 'gpu');
  assert.equal(r.ok, false);
  assert.match(r.message, /does not have "gpu"/);
});

test('a line somebody typed into the file by hand is dropped, not repaired', () => {
  const cfg = box();
  writeFileSync(path.join(cfg.stateDir, 'labels'), 'gpu\nnot a label\n-flagish\nPROD\n\n');
  // `PROD` is lower-cased on read for the same reason it is on write: a stored
  // label the scheduler can never match is worse than one that is missing.
  assert.deepEqual(readLabels(cfg), ['gpu', 'prod']);
});

test('the file is whole or it is the old one', () => {
  const cfg = box();
  addLabel(cfg, 'gpu');
  addLabel(cfg, 'prod');
  assert.deepEqual(readdirSync(cfg.stateDir), ['labels']);
  assert.equal(readFileSync(path.join(cfg.stateDir, 'labels'), 'utf8'), 'gpu\nprod\n');
});

test('removing the last one leaves an empty file rather than a stale one', () => {
  const cfg = box();
  addLabel(cfg, 'gpu');
  assert.deepEqual(removeLabel(cfg, 'gpu').labels, []);
  assert.deepEqual(readLabels(cfg), []);
});

test('there is a bound, because this is read on a path taken per health frame', () => {
  const cfg = box();
  for (let i = 0; i < 64; i++) addLabel(cfg, `l${i}`);
  const r = addLabel(cfg, 'one-more');
  assert.equal(r.ok, false);
  assert.match(r.message, /which is the limit/);
});

test('where a label came from travels as data, and the least removable wins', () => {
  // AN APP THAT SHOWED A FLAT LIST would offer to remove `arm64` and be
  // refused — a control that exists and does not work. And a label present in
  // two sources must be reported as the one that decides removability, or the
  // app offers the Remove anyway.
  const all = describeLabels({ auto: ['arm64', 'linux'], env: ['gpu', 'arm64'], set: ['noisy', 'gpu'] });
  assert.deepEqual(all, [
    { name: 'arm64', source: 'auto' },
    { name: 'gpu', source: 'env' },
    { name: 'linux', source: 'auto' },
    { name: 'noisy', source: 'set' },
  ]);
});

test('a caller with no state directory is asking about a configuration', () => {
  // auto-labels does this. Answering [] rather than throwing, and said out loud
  // rather than left to a caught TypeError that happens to give it.
  assert.deepEqual(readLabels(/** @type {any} */ ({})), []);
});
