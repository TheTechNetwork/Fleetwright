// The Remote Control URL survives Anthropic's domain migration.
//
// login.js widened its URL regex when the login banner moved to claude.com.
// The RC pattern existed in TWO copies and neither moved: a new CLI printed
// claude.com, the extractor matched nothing, every start waited out the full
// RC window (the "15 second hang"), and every session on every host came up
// with no Open button. One pattern now, in core/pane.js, imported by both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { RC_URL_RE } from '../src/core/pane.js';
import { extractRcUrl } from '../src/fleet/host/pane.js';
import { extractRcUrl as extractOnHub } from '../src/core/claude.js';

test('both domains, both extractors', () => {
  for (const fn of [extractRcUrl, extractOnHub]) {
    assert.equal(fn('go to https://claude.com/code/session_abc123 now'), 'https://claude.com/code/session_abc123');
    assert.equal(fn('go to https://claude.ai/code/session_abc123 now'), 'https://claude.ai/code/session_abc123');
    assert.equal(fn('nothing here'), null);
  }
});

test('trailing sentence punctuation is not part of the link', () => {
  assert.equal(extractRcUrl('online: https://claude.com/code/s_1.'), 'https://claude.com/code/s_1');
});

test('there is exactly one copy of the pattern in the tree', () => {
  // The bug was the second copy. Grep the sources: RC_URL_RE may be DEFINED
  // once and imported everywhere else.
  const files = [
    'src/core/pane.js',
    'src/core/claude.js',
    'src/fleet/host/pane.js',
  ];
  let definitions = 0;
  for (const f of files) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    definitions += (src.match(/^export const RC_URL_RE|^const RC_URL_RE/gm) || []).length;
  }
  assert.equal(definitions, 1, 'a second RC_URL_RE definition is the copy that will not get updated');
  assert.ok(RC_URL_RE.source.includes('claude\\.com'), 'the one copy knows about claude.com');
});
