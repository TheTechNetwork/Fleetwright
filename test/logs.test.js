// /logs, against a stub journalctl.
//
//   node --test test/
//
// The branches worth testing are the ones that only show up on a box that is
// slightly wrong: a user who cannot read the journal, a unit that has never
// run, a log too long for a chat message. Those are exactly the ones nobody
// exercises by hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readLogs, resolveSource, LOG_SOURCES } from '../src/core/logs.js';

/**
 * A journalctl that answers however the test needs, and records its arguments.
 * @param {import('node:test').TestContext} t
 * @param {{ stdout?: string, stderr?: string, missing?: boolean }} [opts]
 */
function stubJournal(t, { stdout = '', stderr = '', missing = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'logs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const argsFile = path.join(dir, 'args');
  const bin = path.join(dir, 'journalctl');

  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" > ${argsFile}
${stderr ? `printf '%s\\n' ${JSON.stringify(stderr)} >&2` : ''}
${stdout ? `cat <<'STUBEOF'\n${stdout}\nSTUBEOF` : ''}
exit 0
`,
  );
  chmodSync(bin, 0o755);

  return {
    /** @returns {string} */
    args: () => (existsSync(argsFile) ? readFileSync(argsFile, 'utf8').trim() : ''),
    /** @returns {any} */
    cfg: () => ({ journalctlBin: missing ? path.join(dir, 'nope') : bin, systemctlBin: '/bin/false' }),
  };
}

// --- naming a service -------------------------------------------------------

test('the services are a fixed list, not a pattern', () => {
  // A unit name from the wire would read any unit on the box. Everyone who can
  // run this can already start a session with a shell in it, but that is not a
  // reason to add a second way.
  assert.deepEqual(Object.keys(LOG_SOURCES).sort(), ['coordinator', 'hub', 'sidecar']);
});

test('the names people actually reach for all resolve', () => {
  assert.equal(resolveSource('hub'), 'hub');
  assert.equal(resolveSource('agent-hub'), 'hub');
  assert.equal(resolveSource('coord'), 'coordinator');
  assert.equal(resolveSource('COORDINATOR'), 'coordinator');
  assert.equal(resolveSource('fleet'), 'sidecar');
  assert.equal(resolveSource('sidecar'), 'sidecar');
});

test('anything else resolves to nothing, rather than to a unit name', () => {
  for (const word of ['ssh', 'sshd.service', '../etc', '', 'systemd-journald']) {
    assert.equal(resolveSource(word), null, `${JSON.stringify(word)} must not name a unit`);
  }
});

test('an unknown service is refused with the list of real ones', (t) => {
  const s = stubJournal(t);
  const r = readLogs(s.cfg(), { source: 'sshd' });
  assert.equal(r.ok, false);
  assert.match(r.text, /not a service I can read/);
  assert.match(r.text, /hub, coordinator, sidecar/);
  assert.equal(s.args(), '', 'journalctl must not even be invoked');
});

// --- reading ----------------------------------------------------------------

test('the hub is the default, and the tail is what is asked for', (t) => {
  const s = stubJournal(t, { stdout: 'line one\nline two\n' });

  const r = readLogs(s.cfg());

  assert.equal(r.ok, true);
  assert.equal(r.source, 'hub');
  assert.match(s.args(), /-u agent-hub/);
  assert.match(s.args(), /-n 40/);
  assert.match(s.args(), /--no-pager/);
  assert.match(r.text, /line two/);
});

test('a line count is honoured and clamped', (t) => {
  const s = stubJournal(t, { stdout: 'x' });

  readLogs(s.cfg(), { lines: 5 });
  assert.match(s.args(), /-n 5/);

  readLogs(s.cfg(), { lines: 100000 });
  assert.match(s.args(), /-n 200/, 'a chat message is not a place for an unbounded log');

  readLogs(s.cfg(), { lines: 0 });
  assert.match(s.args(), /-n 40/, 'zero lines is not an answer');
});

test('each service maps to its own unit', (t) => {
  const s = stubJournal(t, { stdout: 'x' });
  readLogs(s.cfg(), { source: 'coordinator' });
  assert.match(s.args(), /-u agent-fleet-coordinator/);
  readLogs(s.cfg(), { source: 'sidecar' });
  assert.match(s.args(), /-u agent-fleet-sidecar/);
});

test('a log too long for chat keeps the END of it', (t) => {
  // The end says what went wrong. The beginning is the part that was fine.
  const s = stubJournal(t, { stdout: `${'filler line\n'.repeat(2000)}THE ACTUAL ERROR\n` });

  const r = readLogs(s.cfg());

  assert.ok(r.text.length < 9000, 'must be bounded');
  assert.match(r.text, /THE ACTUAL ERROR/);
  assert.match(r.text, /trimmed/);
});

// --- boxes that are slightly wrong ------------------------------------------

test('a user who cannot read the journal is told that, not "no entries"', (t) => {
  // journalctl does not fail here — it returns nothing and mentions it on
  // stderr. Untranslated, /logs looks like a service that has never logged.
  const s = stubJournal(t, {
    stdout: '',
    stderr: 'Hint: You are currently not seeing messages from other users and the system.',
  });

  const r = readLogs(s.cfg(), { source: 'hub' });

  assert.equal(r.ok, false);
  assert.match(r.text, /not allowed to see system logs/);
  assert.match(r.text, /systemd-journal/, 'and how to fix it');
});

test('a service that has never run says so plainly', (t) => {
  const s = stubJournal(t, { stdout: '-- No entries --\n' });

  const r = readLogs(s.cfg(), { source: 'coordinator' });

  assert.equal(r.ok, true, 'nothing is wrong; there is just nothing to show');
  assert.match(r.text, /No log entries for agent-fleet-coordinator/);
  assert.match(r.text, /may never have been started/);
});

test('a box with no journalctl says where to look instead', (t) => {
  // A container, WSL without systemd, a distro that does not use journald.
  const s = stubJournal(t, { missing: true });

  const r = readLogs(s.cfg(), { source: 'hub' });

  assert.equal(r.ok, false);
  assert.match(r.text, /No journalctl on this box/);
  assert.match(r.text, /wherever the service was started/);
});
