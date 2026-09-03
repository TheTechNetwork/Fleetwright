// What the list has to answer for somebody who has forgotten everything.
//
// Both beta rounds put this first. Twelve sessions, one identical grey glyph,
// no dates and no owner — a returning user found their own work only because
// past-them happened to put their name in it, and three sessions shared a
// title with no way to tell which attempt was real.
//
// Every fact below was already in the record. None of it was on the screen
// where the choosing happens, which is the whole finding.

import test from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS } from '../src/adapters/commands.js';

const now = Date.now();
const ctx = /** @type {any} */ ({
  cfg: { maxSessions: 5, hostname: 'deb13' },
  login: { status: () => ({ loggedIn: false }) },
  sessions: {
    list: () => [
      {
        name: 'cc-eli-diskreport',
        // Somebody pasted the whole task in as a title.
        title: "Please run 'df -h' for overall disk usage, then run 'du -x -h --max-depth=1 /var' and report",
        status: 'stopped',
        uuid: 'u1',
        createdBy: 'fleet:eli@example.com',
        createdAt: now - 3 * 86400_000,
        stoppedAt: now - 3 * 86400_000,
        updatedAt: now - 3 * 86400_000,
      },
      {
        name: 'cc-brave-narwhal',
        title: null,
        status: 'stopped',
        uuid: null,
        createdBy: 'web',
        createdAt: now - 9 * 3600_000,
        updatedAt: now - 9 * 3600_000,
      },
      {
        name: 'live-one',
        title: 'build the thing',
        status: 'running',
        uuid: 'u2',
        createdBy: 'app:ios',
        createdAt: now - 20 * 60_000,
        updatedAt: now,
      },
    ],
  },
});

const text = () => String(COMMANDS.list.run(ctx, [], new Set()).text);

test('a stopped session says when, and by whom', () => {
  const out = text();
  assert.match(out, /3d ago/);
  assert.match(out, /fleet:eli@example\.com/);
  // Both facts exist in `status` output and did not exist here, which is the
  // screen where somebody decides which session is theirs.
  assert.match(out, /9h ago/);
  assert.match(out, /web/);
});

test('a running session says how long it has been going', () => {
  assert.match(text(), /started 20m ago/);
});

test('"finished", "died" and "no conversation" are not one glyph', () => {
  const out = text();
  // The returning user could not tell a completed job from abandoned clutter.
  assert.match(out, /stopped · 3d ago/);
  assert.match(out, /no saved conversation · 9h ago/);
});

test('a title that is really a pasted command is truncated, not rendered whole', () => {
  const out = text();
  assert.match(out, /Please run 'df -h'/);
  // One line, bounded — the naming design is recognition-not-recall, and a
  // paragraph in a list defeats it.
  assert.equal(out.includes('--max-depth=1 /var'), false, 'the whole pasted task is on the screen');
  assert.match(out, /…/);
});

test('every line of the list stays one line', () => {
  // A list is scanned, not read. Facts go on their own indented line beneath
  // the name; the name line must not grow.
  for (const line of text().split('\n')) {
    assert.ok(line.length <= 100, `too long to scan: ${line}`);
  }
});
