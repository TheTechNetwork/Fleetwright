// Both phones keep a person's Claude login in their vault and nowhere else:
// no machine's page signs anybody in, and a setup-token is not passed off as
// the sign-in Remote Control needs.
//
//   node --test test/claude-signin-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. The host's half (setup-token.test.js) and the
// minter's (vault.test.js) hold the rest.
//
// WRITTEN WHEN IT WAS ASKED: "Make every cred come from the minter, why is
// there a Claude page on the host." A machine's page signed a person in on
// that machine, which then held its own refresh token beside the vault's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { iosSources } from './helpers/ios-sources.js';

const IOS = iosSources();
const HOST_VIEW = readFileSync(new URL('../apps/ios/Fleetwright/HostView.swift', import.meta.url), 'utf8');

// The sentences a person reads, the same on both phones.
const SAID = [
  'signs you in to Claude, the kind of login Remote Control needs. It comes back ',
  'It runs sessions but cannot open Remote Control.',
  'Your Claude login is a setup-token: it runs sessions but cannot open Remote Control. ',
  'Make it on a machine below to have Remote Control.',
  'is older and made a setup-token, which runs sessions but cannot open Remote Control.',
  'do not use these any more; forget them to take them off the box.',
];

test('iOS: a machine’s page signs nobody in to Claude', () => {
  assert.doesNotMatch(HOST_VIEW, /NavigationLink\("Sign in to Claude"\)/);
  assert.doesNotMatch(IOS, /CredentialsView\(settings: settings, host: hostId, onlyClaude: true\)/);
  assert.doesNotMatch(IOS, /CredentialsView\(settings: settings, host: nil, onlyClaude: true\)/);
});

test('iOS: the words about a sign-in and a setup-token', () => {
  for (const words of SAID) {
    assert.ok(IOS.includes(words), `iOS does not say: ${words}`);
  }
  // Said only when the minter said which kind it keeps (C-5).
  assert.match(IOS, /if kept\.items\.first\(where: \{ \$0\.name == "claude" \}\)\?\.kind == "token" \{/);
});
