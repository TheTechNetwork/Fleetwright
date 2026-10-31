// What of a pane may leave a host for the decision model (src/core/mask-pane.js).
//
// The contract is privacy, so the tests are the credentials the fleet itself
// issues or prints, planted in a real capture, and the dialog prose that has
// to survive for the model to read anything at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { maskPane, PANE_MASK, MASK_MAX_BYTES, MASK_MAX_LINES } from '../src/core/mask-pane.js';

const fixture = (/** @type {string} */ name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const TRUST = fixture('claude-2.1.234-trust.txt');

// Shapes, not real values: each is what the fleet would have to keep off the
// wire if it appeared in a pane.
const PLANTED = {
  'setup token': 'sk-ant-oat01-Xq3vR9mZ7kLp2WnB8cYt4HsJ6dFgA1eU',
  'fleet key': 'fwk_9c1e7a4b2d8f6e3a5c0b7d9e1f2a4c6b',
  'Remote Control URL': 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv',
  'Remote Control URL, new domain': 'https://claude.com/code/session_01AbCdEfGhIjKlMnOpQrStUv',
  email: 'someone.person@example.org',
  'ssh public key': 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq8b2kVx3T0pY5wN7mR1sL4cH9dJ6fE2aZ0uK3vB8yQ dev@build-01',
  'ssh private key header': '-----BEGIN OPENSSH PRIVATE KEY-----',
  'env dump line': 'GITHUB_TOKEN=ghp_R2d2C3p0BbEeKk9AaZz7Yy6Xx5Ww4Vv3Uu2T',
};

test('every credential shape the fleet issues or prints is gone, planted in a real dialog', () => {
  for (const [what, secret] of Object.entries(PLANTED)) {
    const pane = TRUST.replace(' /work', ` /work\n\n ${secret}`);
    const masked = maskPane(pane);
    // The secret's distinctive part, which is what a leak would carry.
    for (const piece of secret.split(/\s+/).filter((p) => p.length >= 12)) {
      assert.ok(!masked.includes(piece), `${what}: "${piece}" survived the mask`);
    }
    assert.ok(!/sk-ant-|fwk_|https?:\/\/|@[a-z0-9-]+\.[a-z]{2,}|-----BEGIN|[A-Za-z0-9_-]{20,}/i.test(masked), `${what}: a credential shape survived`);
  }
});

test('the dialog prose the model has to read survives', () => {
  const masked = maskPane(TRUST);
  for (const kept of ['Is this a project you created or one you trust?', '1. Yes, I trust this folder', '2. No, exit', 'Enter to confirm']) {
    assert.ok(masked.includes(kept), `"${kept}" did not survive the mask`);
  }
  const permission = '\n Bash command\n\n   rm -rf /tmp/build-7f3a9c\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n';
  const m = maskPane(permission);
  for (const kept of ['Do you want to proceed?', '1. Yes', '2. No']) assert.ok(m.includes(kept), `"${kept}" did not survive the mask`);
  assert.ok(!m.includes('build-7f3a9c'), 'the command line survived');
});

test('a URL tmux wrapped across rows is masked whole, not as word-shaped fragments', () => {
  // De-wrap first, or the tail of a wrapped URL is a bare word and survives.
  const url = `https://claude.ai/code/session_${'a1'.repeat(40)}hunter`;
  const width = 100;
  const pane = ` ${url.slice(0, width - 1)}\n${url.slice(width - 1)}\n`;
  assert.ok(pane.split('\n')[1].endsWith('hunter'));
  const masked = maskPane(pane);
  assert.ok(!masked.includes('hunter'), 'a fragment of a wrapped URL survived as a word');
});

test('what leaves is the last 40 lines and at most 4,096 bytes, even when masking makes it longer', () => {
  // Trailing blank rows are not lines of the dialog: a tall pane is mostly
  // empty below one, and counting them would push the dialog out.
  const tall = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n'.repeat(60);
  const lines = maskPane(tall).split('\n');
  assert.equal(lines.length, MASK_MAX_LINES);
  assert.equal(lines[lines.length - 1], 'line 199');

  // Two-byte tokens the mask turns into twelve: 1,400 bytes in, ~8 KB out
  // before the second cut.
  const dense = Array.from({ length: 35 }, () => Array.from({ length: 20 }, () => 'a1').join(' ')).join('\n');
  const masked = maskPane(dense);
  assert.ok(Buffer.byteLength(masked) <= MASK_MAX_BYTES, `${Buffer.byteLength(masked)} bytes left the mask`);
  assert.ok(masked.includes(PANE_MASK));
});
