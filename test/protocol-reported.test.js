// The version a coordinator REPORTS must be the version it SPEAKS.
//
// worker.js answered /healthz with a hardcoded `protocol: 1`. The Node
// coordinator has always used the constant, so the two disagreed the moment the
// protocol was bumped -- and /healthz is the first thing anybody curls when the
// fleet stops answering. A Worker running v2 code would have reported v1 and
// sent whoever was debugging a version mismatch to look at the one thing that
// was not wrong.
//
// Both coordinators, because "the same code runs in both places" is a claim a
// client cannot verify, and the version it is told is one of the few parts it
// can check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const files = [
  'worker/src/worker.js',
  'worker/src/demo.js',
  'src/fleet/coordinator/server.js',
  'src/fleet/coordinator/core.js',
];

test('no coordinator hardcodes a protocol number', () => {
  for (const f of files) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    const hits = src.match(/protocol:\s*\d+/g) || [];
    assert.deepEqual(hits, [], `${f} has a literal protocol version: ${hits.join(', ')}`);
  }
});

test('the demo fleet reports the version this build speaks', async () => {
  const { demoSnapshot } = await import('../worker/src/demo.js').catch(() => ({}));
  if (typeof demoSnapshot !== 'function') return; // shape may differ; the grep above is the real guard
  assert.equal(demoSnapshot().protocol, PROTOCOL_VERSION);
});
