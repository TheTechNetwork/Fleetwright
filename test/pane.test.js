// Reading a Remote Control URL back out of a captured pane.
//
//   node --test test/
//
// The wrapping cases are not hypothetical: they are the verbatim CLI 2.1.233
// capture from design.md §10, re-wrapped at the widths a real pane actually
// takes. Each one was measured failing against the unguarded matcher before
// this module existed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { dewrapPane, extractRcUrl, isRemoteControlOnline, reconcileRcUrl } from '../src/host/pane.js';

const RC_URL = 'https://claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M';

// Verbatim from a container session on CLI 2.1.233 in an 80-column pane. At
// this width the URL lands on a line of its own and nothing wraps, which is
// exactly why the bug below stayed hidden.
const RC_PANE_80 = [
  '/remote-control is active · Continue here, on your phone, or at',
  RC_URL,
].join('\n');

const RC_ONE_LINE = `/remote-control is active · Continue here, on your phone, or at ${RC_URL}`;

/**
 * Hard-wrap like a terminal does: a fixed-width grid breaks a line mid-token,
 * with no hyphen and no marker. Building the fixtures this way rather than
 * pasting pre-wrapped text keeps them honest about what tmux hands us at a
 * given width.
 * @param {string} text @param {number} cols
 */
function wrapAt(text, cols) {
  return text
    .split('\n')
    .flatMap((line) => line.match(new RegExp(`.{1,${cols}}`, 'g')) || [''])
    .join('\n');
}

// --- de-wrapping ------------------------------------------------------------

test('de-wrapping leaves prose alone', () => {
  const prose = 'a short line\nanother short line\nthird';
  assert.equal(dewrapPane(prose), prose);
});

test('the prompt after a URL is not glued onto it', () => {
  // The regression that shaped the rule: joining any newline followed by a
  // non-space appended "Paste" (from "Paste code here if prompted >") to an
  // OAuth state parameter — a URL that loads and then fails authorization for
  // no visible reason.
  const pane = [
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=t",
    'rue&state=BdlKPcnMGAOoaVqz6VKYhLJNyUoE2DuuCw2NHQg7lTA',
    'Paste code here if prompted > ',
  ].join('\n');
  const joined = dewrapPane(pane);
  assert.match(joined, /state=BdlKPcnMGAOoaVqz6VKYhLJNyUoE2DuuCw2NHQg7lTA/);
  assert.ok(!/lTAPaste/.test(joined));
});

test('de-wrapping tolerates empty and absent input', () => {
  assert.equal(dewrapPane(''), '');
  assert.equal(dewrapPane(/** @type {any} */ (null)), '');
  assert.equal(dewrapPane(/** @type {any} */ (undefined)), '');
});

// --- the failure this module exists for -------------------------------------

test('the Remote Control URL is read off an 80-column pane', () => {
  assert.equal(extractRcUrl(RC_PANE_80), RC_URL);
});

test('the URL survives every pane width that wraps it', () => {
  // Measured against agent-hub's unguarded matcher, these produce:
  //   64 → correct (by luck)   70 → null   80 → null   100 → truncated
  for (const cols of [64, 70, 72, 80, 96, 100, 120]) {
    assert.equal(extractRcUrl(wrapAt(RC_ONE_LINE, cols)), RC_URL, `wrapped at ${cols} columns`);
  }
});

test('a longer session id wraps even at 80 columns and is still recovered whole', () => {
  const longUrl = `https://claude.ai/code/session_${'0123456789abcdef'.repeat(3)}`;
  assert.equal(extractRcUrl(wrapAt(longUrl, 80)), longUrl);
});

test('a box-drawing character after the URL is not swallowed into it', () => {
  // De-wrapping can only ever join MORE text onto the end of the URL, and the
  // pane is a TUI: a whitespace-free line following a full-width one may well
  // be a box border. Matching \S+ would make it part of the URL.
  const pane = [`${RC_URL}${'x'.repeat(80 - RC_URL.length)}`, `╰${'─'.repeat(62)}╯`].join('\n');
  const found = extractRcUrl(pane);
  assert.ok(found);
  assert.ok(!/[╰╯─]/.test(found), `box drawing leaked into the URL: ${found}`);
});

test('trailing sentence punctuation is not part of the URL', () => {
  assert.equal(extractRcUrl(`reach it at ${RC_URL}.`), RC_URL);
  assert.equal(extractRcUrl(`reach it at (${RC_URL})`), RC_URL);
});

test('a pane with no Remote Control URL yields null', () => {
  assert.equal(extractRcUrl('Welcome to Claude Code\n> '), null);
  assert.equal(extractRcUrl(''), null);
  // The status-line-only form: RC came up via remoteControlAtStartup rather
  // than --remote-control <name>, so there is no URL to hand out.
  assert.equal(extractRcUrl('/rc active'), null);
});

test('a lookalike host is not accepted as a Remote Control URL', () => {
  assert.equal(extractRcUrl('https://claude.ai.evil.example/code/session_x'), null);
  assert.equal(extractRcUrl('https://notclaude.ai/code/session_x'), null);
});

// --- online detection -------------------------------------------------------

test('Remote Control is detected online across the marker forms', () => {
  assert.ok(isRemoteControlOnline(RC_PANE_80));
  assert.ok(isRemoteControlOnline('/remote-control is active'));
  assert.ok(isRemoteControlOnline('Continue coding in the Claude mobile app'));
  assert.ok(isRemoteControlOnline(`banner · Connected`));
});

test('online detection survives a wrapped URL marker', () => {
  // The URL itself is one of the markers, so a pane narrow enough to split
  // "claude.ai/code" across rows would otherwise read as offline.
  const urlOnly = wrapAt(RC_URL, 30);
  assert.ok(isRemoteControlOnline(urlOnly), 'a wrapped URL must still count as online');
});

test('an ordinary pane is not mistaken for Remote Control being up', () => {
  assert.ok(!isRemoteControlOnline('Welcome to Claude Code\n> '));
  assert.ok(!isRemoteControlOnline('/rc active'));
});

// --- repairing what agent-hub recorded --------------------------------------

test('a URL agent-hub failed to capture at all is recovered from the pane', () => {
  // The width-70 case: agent-hub recorded nothing, and the session looks
  // online and unreachable.
  const r = reconcileRcUrl({ recorded: null, pane: wrapAt(RC_ONE_LINE, 70) });
  assert.equal(r.url, RC_URL);
  assert.equal(r.source, 'pane');
  assert.equal(r.repaired, true);
  assert.equal(r.reason, 'missing');
});

test('a truncated recorded URL is repaired and named as truncated', () => {
  // The width-100 case, and the dangerous one: the recorded link is
  // well-formed, loads, and goes nowhere.
  const r = reconcileRcUrl({ recorded: 'https://claude.ai/code/session_016zf', pane: RC_PANE_80 });
  assert.equal(r.url, RC_URL);
  assert.equal(r.repaired, true);
  assert.equal(r.reason, 'truncated');
});

test('a record that agrees with the pane is left alone', () => {
  const r = reconcileRcUrl({ recorded: RC_URL, pane: RC_PANE_80 });
  assert.equal(r.url, RC_URL);
  assert.equal(r.repaired, false);
  assert.equal(r.source, 'record');
});

test('a record that disagrees outright is replaced, and flagged as a mismatch', () => {
  // Not a truncation — a different session id entirely, e.g. the record is
  // stale after a restart. The live pane wins.
  const r = reconcileRcUrl({ recorded: 'https://claude.ai/code/session_OLDOLDOLD', pane: RC_PANE_80 });
  assert.equal(r.url, RC_URL);
  assert.equal(r.repaired, true);
  assert.equal(r.reason, 'mismatch');
});

test('the record is the fallback once the banner has scrolled away', () => {
  const r = reconcileRcUrl({ recorded: RC_URL, pane: 'some later output\n> ' });
  assert.equal(r.url, RC_URL);
  assert.equal(r.source, 'record');
  assert.equal(r.repaired, false);
});

test('no record and no pane is not an error, just nothing', () => {
  const r = reconcileRcUrl({});
  assert.deepEqual(r, { url: null, source: null, repaired: false, reason: null });
});
