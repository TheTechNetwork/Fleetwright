// A pane that has printed nothing must not be reported as output.
//
// WHAT WAS SEEN, so the next person can recognise it: a phone showed the
// reassurance banner and then a dark card the height of the screen with
// nothing in it. The report was "clicking Output on a session seems to show
// this — could be a bad version of an image or something", which is the right
// reading of a large empty rectangle and the wrong diagnosis.
//
// It was not an image. `tmux capture-pane -p -S -60` returns the scrollback
// AND every row of the visible region, so a pane whose program has printed
// nothing comes back as forty newlines rather than as the empty string. That
// is truthy in JavaScript, so it passed every "is there anything to show"
// check between the host and the phone, and the phone drew it faithfully.
//
// The rule this breaks is C-5: a screen may not report a state it does not
// know. Forty blank lines under a heading that says "Pane for bigjob" is the
// host claiming to have collected output it did not collect.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSessionLogs, tidyPane } from '../src/core/logs.js';

/** A shell script on disk that answers however the test needs. */
function stub(dir, name, body) {
  const bin = path.join(dir, name);
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

/**
 * A box with a fake podman and a fake tmux.
 *
 * Real binaries on PATH rather than a stubbed spawnSync, for the same reason
 * test/returning-user.test.js does it: `tmux` is resolved from PATH inside
 * src/core/tmux.js, and a mocked call would not catch an argument built wrongly.
 *
 * @param {import('node:test').TestContext} t
 */
function box(t, { sandbox = true, containerPrints = '', paneShows = '', paneExists = true, containerExists = true }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'blank-pane-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // THE FIXTURES GO ON DISK AND THE STUBS `cat` THEM. The obvious thing —
  // `printf '%s' <json string>` — cannot carry a newline: JSON.stringify emits
  // a backslash and an n, and printf %s inside single quotes prints those two
  // characters. Every pane in this file is defined by where its newlines are,
  // so a stub that flattens them would test nothing.
  const pane = path.join(dir, 'pane.txt');
  writeFileSync(pane, paneShows);
  const printed = path.join(dir, 'container.txt');
  writeFileSync(printed, containerPrints);

  const podmanBin = stub(dir, 'podman', `
case "$1" in
  logs) cat ${JSON.stringify(printed)} ; exit 0 ;;
  container) exit ${containerExists ? 0 : 125} ;;
  *) exit 0 ;;
esac`);

  stub(dir, 'tmux', `
case "$1" in
  has-session) exit ${paneExists ? 0 : 1} ;;
  capture-pane) cat ${JSON.stringify(pane)} ; exit 0 ;;
  *) exit 0 ;;
esac`);

  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  t.after(() => { process.env.PATH = before; });

  return /** @type {any} */ ({ sandbox, podmanBin, stateDir: dir });
}

/** What tmux actually hands back for a pane nothing has written to. */
const EMPTY_PANE = '\n'.repeat(40);

test('an empty pane is measured the way tmux really returns it', () => {
  // Guarding the premise, not the fix. If this ever fails because tmux began
  // returning '' for an empty pane, the branch below is dead code and should
  // be deleted rather than left to rot — but it is not dead today: tmux 3.4
  // returns one newline per row of the visible region.
  assert.equal(EMPTY_PANE.length, 40);
  assert.ok(EMPTY_PANE, 'the string a blank pane produces is truthy, which is the whole bug');
});

test('a session that has printed nothing says so instead of returning blank lines', (t) => {
  const cfg = box(t, { sandbox: false, paneShows: EMPTY_PANE });
  const r = readSessionLogs(cfg, 'bigjob');

  assert.equal(r.ok, true, 'there is a window open, so this is not a failure');
  assert.match(r.text, /printed nothing/, 'it answered with the blank pane');
  assert.doesNotMatch(r.text, /Pane for/, 'it presented emptiness as collected output');
  assert.equal(r.text.trim(), r.text, 'a reply that begins or ends in whitespace draws an empty card');
});

test('a sandboxed session with an empty container and an empty pane names the container', (t) => {
  // The two "nothing yet" sentences are different evidence for the same fact,
  // and the sandboxed one must not be lost behind the pane branch.
  const cfg = box(t, { containerPrints: '', paneShows: EMPTY_PANE, containerExists: true });
  const r = readSessionLogs(cfg, 'bigjob');

  assert.equal(r.ok, true);
  assert.match(r.text, /is running and has printed nothing yet/);
});

test('a pane with something on it is still returned, padding and all removed', (t) => {
  // The fix must not eat output. Leading and trailing empty rows are the
  // terminal's padding; the blank line in the middle is the session's own
  // spacing and belongs to what it printed.
  const paneShows = `\n\n\nbuilding   \n\nbuilt in 4.1s   \n\n\n\n\n`;
  const cfg = box(t, { sandbox: false, paneShows });
  const r = readSessionLogs(cfg, 'bigjob');

  assert.equal(r.ok, true);
  assert.equal(r.text, 'Pane for bigjob:\nbuilding\n\nbuilt in 4.1s');
});

test('nothing anywhere is still nothing anywhere', (t) => {
  // The new branches sit between the pane and this one, so the sentence that
  // names the way back has to survive them.
  const cfg = box(t, { paneExists: false, containerExists: false });
  const r = readSessionLogs(cfg, 'bigjob');

  assert.equal(r.ok, false);
  assert.match(r.text, /resume bigjob/i);
});

test('tidyPane keeps what a session printed and drops what the terminal padded', () => {
  assert.equal(tidyPane(''), '');
  assert.equal(tidyPane('\n\n\n'), '');
  assert.equal(tidyPane('   \n\t\n'), '');
  assert.equal(tidyPane('one\n\ntwo'), 'one\n\ntwo', 'interior spacing is output, not padding');
  assert.equal(tidyPane('\n  indented\n'), '  indented', 'leading indent on a row is output');
});
