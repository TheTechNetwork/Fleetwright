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
  // THE WAY OUT IS THE PREREQUISITE STEP, not a nodesource command pasted into
  // a refusal. The installer names a supported command; prereq.sh is what knows
  // about apt repositories, and it is separate precisely so that adding one is
  // a line somebody typed.
  assert.match(sh, /\/prereq \| sudo sh/);
  // COMMENTS ARE WHERE THE HISTORY LIVES, and one of them records that this
  // script used to recommend nodesource's 22 line. Asserting over raw text
  // would fire on the sentence explaining why it no longer does.
  assert.equal(/nodesource/.test(sh.replace(/^\s*#.*$/gm, '')), false,
    'install.sh is back to naming a third-party repository');

  // From the variable, like everything else — the could-not-install path used
  // to carry its own literal, which is the fourth copy that made this drift.
  assert.match(sh, /Install Node \$NODE_FLOOR or newer/, 'the could-not-install path names its own version');
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

test('the prerequisite step installs the floor, and nothing else', () => {
  // Its whole justification is being narrow: it exists because install.sh will
  // not add a third-party apt repository on somebody's behalf. A prereq script
  // that also installed podman, or wrote config, would be the installer again
  // with the argument removed.
  const sh = readFileSync(new URL('../install/prereq.sh', import.meta.url), 'utf8');
  const wanted = floorOf(JSON.parse(read('package.json')).engines?.node);

  assert.match(sh, new RegExp(`^FLOOR=${wanted}$`, 'm'), 'prereq.sh wants a different node than package.json');
  assert.match(sh, /nvm install \$FLOOR/, 'the installed version is not built from the floor');

  // NVM RATHER THAN NODESOURCE, which is the same argument that made this a
  // separate command: NodeSource permanently adds a third-party apt repository
  // and signing key and can replace the distribution's nodejs. nvm is one
  // directory in one home, removed with `rm -rf`.
  // The code, not the comment that explains why NodeSource was rejected.
  assert.equal(/nodesource/i.test(sh.replace(/^\s*#.*$/gm, '')), false,
    'prereq.sh is back to adding an apt repository');
  assert.match(sh, /nvm-sh\/nvm\/\$NVM_RELEASE/, 'the nvm version is not pinned');
  assert.match(sh, /^NVM_RELEASE=v\d+\.\d+\.\d+$/m, 'nvm is fetched from a moving ref');

  const body = sh.replace(/^\s*#.*$/gm, '');
  for (const other of ['podman', 'tmux', 'systemctl', 'useradd', '/etc/']) {
    assert.equal(body.includes(other), false, `prereq.sh is doing installer work: ${other}`);
  }

  // AS THE RUN USER, NOT ROOT. nvm is per-user and root's home is 0700, so a
  // node in /root/.nvm is unreadable by the service, which runs as somebody
  // else. This is the whole reason the script has to know who that is.
  assert.match(sh, /RUN_USER="\$\{AGENT_HUB_USER:-\$\{SUDO_USER:-\}\}"/);
  assert.match(sh, /su - "\$RUN_USER"/);
  assert.match(sh, /= root \]/, 'installing as root would put node where the service cannot read it');

  // AND IT DOES NOT EDIT ANYBODY'S SHELL. The units use an absolute path, so
  // shell integration buys nothing, and rewriting a login profile somebody else
  // uses is a side effect nobody asked for.
  assert.match(sh, /PROFILE=\/dev\/null/);

  // ALREADY FINE IS A NO-OP. A box with node 26 from nvm must not get a system
  // node landing on top of it — this is run by people following instructions
  // who will not check first.
  assert.match(sh, /is already new enough — nothing to do/);
  // And it says what it is about to do to the machine BEFORE doing it, which is
  // the entire reason the step is separate — including how to undo it and that
  // nothing will patch it afterwards.
  assert.match(sh, /Nothing system-wide changes/);
  assert.match(sh, /rm -rf/, 'it does not say how to undo itself');
  assert.match(sh, /Nothing patches it afterwards/, 'the cost of nvm is not stated');
});

test('Renovate can see the nvm pin, and would see a change to it', async () => {
  // A version in a shell script is invisible to every manager Renovate has, so
  // it is annotated in place and matched by a custom manager. The failure mode
  // is silent in both directions: the regex stops matching and the pin quietly
  // stops being maintained, or the annotation is edited and nothing says so.
  //
  // This matters more than an ordinary pin. prereq.sh runs as root and pipes
  // nvm's installer into bash — an unpinned ref would be arbitrary code from a
  // moving target, and a pinned one nobody bumps is a known-old one. Renovate
  // is what makes "pinned" and "current" the same thing.
  const config = JSON.parse(read('renovate.json'));
  const manager = (config.customManagers || []).find((m) =>
    (m.managerFilePatterns || []).some((f) => f.includes('prereq')),
  );
  assert.ok(manager, 'renovate.json has no custom manager for install/prereq.sh');

  const sh = read('install/prereq.sh');
  const matched = new RegExp(manager.matchStrings[0]).exec(sh);
  assert.ok(matched, 'the custom manager matches nothing in install/prereq.sh');
  assert.equal(matched.groups.depName, 'nvm-sh/nvm');
  assert.equal(matched.groups.datasource, 'github-releases');
  assert.match(matched.groups.currentValue, /^v\d+\.\d+\.\d+$/, 'the pin is not an exact release');

  // And what it matched is what the script actually uses — an annotation above
  // a variable nobody reads would be maintained for nothing.
  assert.match(sh, new RegExp(`NVM_RELEASE=${matched.groups.currentValue}\\b`));
  assert.match(sh, /nvm-sh\/nvm\/\$NVM_RELEASE\/install\.sh/);
});
