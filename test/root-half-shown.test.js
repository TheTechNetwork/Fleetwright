// A box whose update helper the installer never refreshed says so on a phone.
//
// The health frame carries `version.helper` beside `version.installed`: whether
// root's half of the box — the update helper, and through it the units, the
// hook and the sudoers rules — is the release's own. A box where it is not
// takes every update, restarts its services from the marker, and refreshes
// nothing root owns, and the only place that said so was a warning in the
// hub's journal. The person who needs it is holding a phone.
//
// A grep, not a run; the Swift is compiled by CI's iOS job. The Android half
// joins this file with its own pull request.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';

const HOST_LINE =
  'The update helper on this box is older than the release it runs. Updates still land and the services restart, ' +
  'but nothing root owns is refreshed. Check shows the one command that fixes it, once.';

test('iOS reads whether root’s half is the release’s, and only ever says so when told', () => {
  const swift = iosSources();
  assert.match(swift, /let helper: String\?/);
  // TRUE ONLY WHEN THE HOST SAID SO. Nil is cannot tell and "current" is
  // nothing to say; neither may put a line about root's half on a screen.
  assert.match(swift, /var rootHalfBehind: Bool \{ helper == "stale" \}/);
});

test('the row says the helper is out of date beside, not instead of, what it runs', () => {
  const swift = iosSources();
  const row = swift.indexOf('private func describeRunning(');
  assert.ok(row > 0);
  const body = swift.slice(row, swift.indexOf('private func describeAccounts('));
  const chain = body.indexOf('"up to date"');
  const helper = body.indexOf('rootHalfBehind');
  assert.ok(chain > 0 && helper > chain, 'a box can be up to date and still have a stale helper; both are said');
  assert.match(body, /update helper out of date/);
});

test('the host page says what still works before what to do, and points at Check', () => {
  // What still works comes first, so it reads as one command and not a
  // broken box. Check carries the command with the real path, because the
  // host knows it and the phone does not — and the phone never invents one.
  const swift = iosSources();
  assert.ok(swift.includes(HOST_LINE), 'the host page line changed');
  assert.match(swift, /rootHalfBehind == true[\s\S]{0,1200}Design\.Palette\.attention/, 'in the attention colour');
  assert.doesNotMatch(swift, /sudo install -m 0755/, 'the phone must not carry the command; the host says it');
});

test('the new sentences carry no em dash', () => {
  // The count of em dashes in UI strings is pinned by test/antislop.test.js,
  // so a new sentence may not add one.
  for (const s of [HOST_LINE, 'update helper out of date']) assert.doesNotMatch(s, /—/);
});
