// The Swift CodeQL job compiles on Xcode 26, on purpose.
//
//   node --test test/codeql-swift-runner.test.js
//
// Traced extraction dies once Xcode 27 is installed: Apple dropped the
// x86_64 slices the tracer needs, and the failure on this repo is
// `Bad CPU type in executable` while SPM launches sentry-cocoa's manifest
// helper. ios.yml stays on xcode-27, because that SDK is what draws the
// Duo. This job is not that build. Moving it back onto xcode-27 makes
// every push to main red and uploads no Swift database.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const yml = readFileSync(new URL('../.github/workflows/codeql.yml', import.meta.url), 'utf8');

test('the Swift CodeQL job stays where a traced build can run', () => {
  const swift = yml.split(/^  swift:/m)[1]?.split(/\n  [a-z]/)[0] ?? '';
  assert.ok(swift, 'the swift job is gone');
  assert.match(swift, /\n    runs-on: macos-26\n/);
  assert.doesNotMatch(swift, /select-xcode\.sh/);
  assert.match(swift, /xcodebuild -version/);
});
