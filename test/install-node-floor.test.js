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

  // The floor is a variable now, named once, because it appears in the gate,
  // two messages and a nodesource URL — four copies is four chances to drift.
  const floor = /^NODE_FLOOR=(\d+)$/m.exec(sh);
  assert.ok(floor, 'the installer no longer names a node floor');
  assert.equal(
    Number(floor[1]),
    wanted,
    `install.sh admits node ${floor[1]} while package.json needs ${wanted} — a box that installs cleanly and cannot run`,
  );
  // And the gate uses it rather than a literal beside it.
  assert.match(sh, /\[ "\$NODE_MAJOR" -ge "\$NODE_FLOOR" \]/);
});

test('the message it prints names the same version it enforces', () => {
  // The number in the sentence and the number in the comparison were different
  // for months. Somebody reading "this needs 18 or newer" and installing 18
  // would have been refused by a check that said 24 — or, as it actually
  // happened, admitted by a check that said 18 while the code needed 24.
  const wanted = floorOf(JSON.parse(read('package.json')).engines?.node);
  const sh = read('install/install.sh');

  assert.match(sh, /this needs \$NODE_FLOOR or newer/, 'the refusal no longer says which version it wants');

  // And the nodesource line it hands somebody has to install a version that
  // passes. Recommending setup_22.x under a floor of 24 sends them round the
  // loop a second time.
  //
  // EVERY occurrence, not the first. A stale version left anywhere in this file
  // is a stale recommendation, and the first match is whichever line happens to
  // sort earliest — including a comment.
  // Built from the floor rather than written out, so a bump cannot leave a
  // nodesource URL pointing at the previous major.
  assert.match(sh, /setup_\$\{NODE_FLOOR\}\.x/);
  assert.equal(/setup_\d+\.x/.test(sh), false, 'a hardcoded nodesource version is back');

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

test('too old is refused, and the refusal says nothing was changed', () => {
  // NOT HEALED, deliberately. Piping a third-party installer into root bash to
  // add an apt repository and a signing key is a different act from
  // `apt-get install nodejs`, and not one this script makes on somebody's
  // behalf — which is the whole reason the ordering below matters instead.
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
  const gate = sh.slice(sh.indexOf('REFUSED, AND NOT HEALED'));
  assert.match(gate, /Nothing has been changed on this box/);
  assert.match(gate, /AGENT_HUB_NODE_BIN/, 'no way out for somebody who already has a new node');
  // And nothing pipes nodesource into a shell.
  assert.equal(/nodesource[^\n]*\|\s*bash/.test(sh.replace(/^\s*#.*$/gm, '')), false,
    'the installer pipes a third-party script into root bash');
});

test('nothing is destroyed before the install is known to be possible', async () => {
  // A BOX WAS STRANDED BY THIS. The previous-install block ran first, so
  // deb13-staging was taken apart — services stopped, identity deleted, config
  // removed — and then refused at the node version. Out of the fleet, with no
  // way back except by hand.
  //
  // docs/packaging.md already states the rule, about the packaged path:
  // "Nothing is removed until the new agent-hub has been SEEN to start.
  // Removing first would leave a box with neither." Only that path had been
  // taught it.
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
  const prerequisites = sh.indexOf('# --- 1. prerequisites');
  const nodeGate = sh.indexOf('|| die "node $NODE_MAJOR');
  const clean = sh.indexOf("uninstall.sh\" --yes");

  assert.ok(prerequisites > 0 && nodeGate > 0 && clean > 0, 'a landmark moved');
  assert.ok(nodeGate < clean, 'the node check runs after the clean — a box can be uninstalled and then refused');
  assert.ok(prerequisites < clean, 'the prerequisites run after the clean');
});
