// A box started with ANTHROPIC_API_KEY answers the CLI's question about it.
//
//   node --test test/api-key-approval.test.js
//
// The runner's credential is an API key (docs/ephemeral-hosts.md), and the CLI
// will not use one it finds in its environment without asking — a dialog with
// "No" focused, in a pane nobody is watching. The hub writes the approval the
// CLI itself would have written, keyed the way the CLI keys it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { approveApiKey } from '../src/core/trust.js';
import { AWAITING_RE } from '../src/fleet/host/watcher.js';

const KEY = 'sk-ant-api03-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
const SUFFIX = KEY.slice(-20);

/** Point the CLI's config at a throwaway home for one test. */
function home(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apikey-home-'));
  const before = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => {
    process.env.HOME = before;
    rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, '.claude.json');
}

const read = (/** @type {string} */ f) => JSON.parse(readFileSync(f, 'utf8'));

test('the approval is written the way the CLI writes it: the last twenty characters, under approved', (t) => {
  const file = home(t);
  assert.equal(approveApiKey(KEY), true);
  assert.ok(existsSync(file), 'created when claude has never run as this user');
  assert.deepEqual(read(file).customApiKeyResponses, { approved: [SUFFIX], rejected: [] });
  // Never the key itself.
  assert.equal(readFileSync(file, 'utf8').includes(KEY), false);
});

test('an existing config keeps everything else, and a second start changes nothing', (t) => {
  const file = home(t);
  writeFileSync(file, JSON.stringify({ theme: 'light', hasCompletedOnboarding: true, customApiKeyResponses: { approved: ['someothersuffix00000'], rejected: [] } }));
  approveApiKey(KEY);
  const cfg = read(file);
  assert.equal(cfg.theme, 'light');
  assert.deepEqual(cfg.customApiKeyResponses.approved, ['someothersuffix00000', SUFFIX]);
  const text = readFileSync(file, 'utf8');
  approveApiKey(KEY);
  assert.equal(readFileSync(file, 'utf8'), text, 'idempotent');
});

test('a "No" pressed once by hand does not outrank the environment every start', (t) => {
  const file = home(t);
  writeFileSync(file, JSON.stringify({ customApiKeyResponses: { approved: [], rejected: [SUFFIX] } }));
  approveApiKey(KEY);
  assert.deepEqual(read(file).customApiKeyResponses, { approved: [SUFFIX], rejected: [] });
});

test('a corrupt config is left alone rather than overwritten, and a short key is refused', (t) => {
  const file = home(t);
  writeFileSync(file, '{not json');
  assert.equal(approveApiKey(KEY), false);
  assert.equal(readFileSync(file, 'utf8'), '{not json', 'the operator\'s real settings are not destroyed');
  assert.equal(approveApiKey('short'), false);
  assert.equal(approveApiKey(/** @type {any} */ (undefined)), false);
});

test('the watcher knows the dialog, so a session sitting at it reads as waiting rather than idle', () => {
  assert.match('Detected a custom API key in your environment\n  Do you want to use this API key?\n  ❯ No (recommended)', AWAITING_RE);
});
