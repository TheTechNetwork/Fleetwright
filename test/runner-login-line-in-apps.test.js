// A runner's machine row says what its sessions run on, and calls it a fault
// only when nothing can start one.
//
//   node --test test/runner-login-line-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. The coordinator's half, a runner that has not
// heard back yet is unknown rather than degraded, is in coordinator.test.js.
//
// REPORTED FROM A PHONE: a runner row read "healthy" and, in the attention
// colour beneath it, "Nobody has connected a Claude account here — sessions
// will not start". Nobody links an account on a runner; its sessions run on
// its owner's kept login or the repository's API key, and the host says which.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';

const IOS = iosSources();

const SAID = [
  'Sessions run on the Claude login its owner keeps for runners',
  "Sessions run on the runner repository's API key",
  "No Claude login is kept for this runner's owner and its repository has no API key — sessions will not start",
  'Fetching the Claude login its sessions will run on',
];

test('iOS: a runner row says what its sessions run on', () => {
  for (const words of SAID) assert.ok(IOS.includes(words), `iOS does not say: ${words}`);
  assert.match(IOS, /let runnerAuth: String\?/);
  assert.match(IOS, /var ephemeral: Bool\?/);
  // Both places a machine is described pass what the host said.
  const passes = IOS.match(/describeWhoCanStart\(accounts, account: [^)]*runnerAuth: [^)]*runner: runner\)/g) ?? [];
  assert.equal(passes.length, 2, 'the machine list and the machine page');
});

test('iOS: the attention colour and ring are for a machine nothing can start on', () => {
  assert.match(IOS, /func whoCanStartIsFault\(_ accounts: Int, runnerAuth: String\?, runner: Bool\) -> Bool \{\s*guard accounts == 0 else \{ return false \}/);
  assert.match(IOS, /case "owner", "key": return false\s*case "none": return true\s*default: return !runner/);
  assert.match(IOS, /let unusable = whoCanStartIsFault\(/);
  assert.doesNotMatch(IOS, /\.foregroundStyle\(accounts == 0 \? Design\.Palette\.attention/);
});
