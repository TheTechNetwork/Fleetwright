// A box that holds a newer release than it runs is not "up to date".
//
// The health frame now carries `version.installed` beside `version.head`:
// what the box's disk holds, and what the service sending the frame is
// running. When they differ the box is waiting on a restart and nothing else,
// and that is a state a phone has to be able to say. It could not: the row's
// "up to date" was decided by what was left to download, so a fleet showed
// `main-88 · up to date` about a box whose disk held main-102.
//
// A grep, not a run; the Swift is compiled by CI's iOS job. The Android half
// joins this file with its own pull request.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

test('iOS reads what the disk holds beside what runs, and derives the gap once', () => {
  const swift = iosSources();
  assert.match(swift, /let installed: String\?/);
  assert.match(swift, /var restartWaitingFor: String\? \{/, 'one definition of the gap, on the model');
  assert.match(swift, /installed != head/, 'the gap is a difference, not a flag from the host');
});

test('the row says restart waiting before it says anything about downloads', () => {
  const swift = iosSources();
  const row = swift.indexOf('private func describeRunning(');
  assert.ok(row > 0);
  const body = swift.slice(row, swift.indexOf('private func describeAccounts('));
  const restart = body.indexOf('restartWaitingFor');
  const behind = body.indexOf('behind > 0');
  const current = body.indexOf('"up to date"');
  assert.ok(restart > 0 && restart < behind, 'the restart branch comes before the commits-behind branch');
  assert.ok(current > restart, '"up to date" is unreachable while a restart is waiting');
  assert.match(body, /installed, restart waiting/);
});

test('the host page names the release on disk and says what applies it', () => {
  const swift = iosSources();
  assert.match(swift, /is on this box and not yet running\. A restart applies it\./);
  assert.match(swift, /restartWaitingFor[\s\S]{0,600}Design\.Palette\.attention/, 'in the attention colour');
});

test('Android reads what the disk holds and derives the gap once, on the model', () => {
  const kotlin = androidSources();
  assert.match(kotlin, /val installed: String\? = null/);
  assert.match(kotlin, /val restartWaitingFor: String\?/);
  assert.match(kotlin, /it != version/, 'a difference between two strings, never a flag from the host');
});

test('both phones put restart waiting first, in the same words', () => {
  const kotlin = androidSources();
  const row = kotlin.indexOf('private fun describeRunning(');
  assert.ok(row > 0);
  const body = kotlin.slice(row, kotlin.indexOf('return if (parts.isEmpty())', row));
  const restart = body.indexOf('restartWaitingFor');
  const behind = body.indexOf('behind > 0 ->');
  assert.ok(restart > 0 && restart < behind, 'the restart branch comes before the commits-behind branch');
  assert.match(body, /installed, restart waiting/);

  const swift = iosSources();
  for (const sentence of ['installed, restart waiting', 'is on this box and not yet running. A restart applies it.']) {
    assert.ok(swift.includes(sentence), `iOS lost: ${sentence}`);
    assert.ok(kotlin.includes(sentence), `Android lost: ${sentence}`);
  }
});
