// The Node floor, in the two places that disagree about it.
//
// package.json says what this code needs. install/install.sh is what stops
// somebody running it on a box that cannot. They drifted: the manifest said
// `>=24` and docs/deployment.md said 24, while the installer checked for 18 and
// recommended nodesource's 22 line — so `install.sh --check` printed
// **"ok node v20.19.2"** and exited 0 on a machine that cannot run this.
//
// A floor nobody enforces is a hope. This one was a hope that printed the word
// "ok", which is worse: it is the same shape as the beta finding where a
// `--check` passed on a script that could not get past its own fourth line.
//
// They live in different files and only one of them is read when the
// requirement changes, which is exactly the kind of pair this repository pins.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** The major from `">=24"`, `"^24.11.0"`, `">=24 <27"`. */
function floorOf(range) {
  const m = /(\d+)/.exec(String(range || ''));
  assert.ok(m, `cannot read a major version out of ${JSON.stringify(range)}`);
  return Number(m[1]);
}

test('the installer refuses exactly what the manifest refuses', () => {
  const wanted = floorOf(JSON.parse(read('package.json')).engines?.node);
  const sh = read('install/install.sh');

  const gate = /\[ "\$NODE_MAJOR" -ge (\d+) \]/.exec(sh);
  assert.ok(gate, 'the installer no longer checks a node major at all');
  assert.equal(
    Number(gate[1]),
    wanted,
    `install.sh admits node ${gate[1]} while package.json needs ${wanted} — a box that installs cleanly and cannot run`,
  );
});

test('the message it prints names the same version it enforces', () => {
  // The number in the sentence and the number in the comparison were different
  // for months. Somebody reading "this needs 18 or newer" and installing 18
  // would have been refused by a check that said 24 — or, as it actually
  // happened, admitted by a check that said 18 while the code needed 24.
  const wanted = floorOf(JSON.parse(read('package.json')).engines?.node);
  const sh = read('install/install.sh');

  const said = /this needs (\d+) or newer/.exec(sh);
  assert.ok(said, 'the refusal no longer says which version it wants');
  assert.equal(Number(said[1]), wanted);

  // And the nodesource line it hands somebody has to install a version that
  // passes. Recommending setup_22.x under a floor of 24 sends them round the
  // loop a second time.
  //
  // EVERY occurrence, not the first. A stale version left anywhere in this file
  // is a stale recommendation, and the first match is whichever line happens to
  // sort earliest — including a comment.
  const suggested = [...sh.matchAll(/setup_(\d+)\.x/g)].map((m) => Number(m[1]));
  assert.ok(suggested.length, 'the installer no longer suggests a way to get node');
  for (const major of suggested) {
    assert.ok(major >= wanted, `install.sh suggests nodesource ${major}.x under a floor of ${wanted}`);
  }

  assert.match(sh, new RegExp(`Install Node ${wanted} or newer`), 'the could-not-install path names a different version');
});

test('the documents agree with the installer', () => {
  // docs/deployment.md is what somebody reads before running any of this, and
  // it was the one place that was already right — which is how the drift
  // survived: the document and the manifest agreed, and the only file that
  // could actually stop anybody was the one nobody re-read.
  const wanted = floorOf(JSON.parse(read('package.json')).engines?.node);
  const deployment = read('docs/deployment.md');
  assert.ok(
    new RegExp(`[Nn]ode[^.\n]*${wanted}`).test(deployment),
    `docs/deployment.md does not say node ${wanted}`,
  );
});
