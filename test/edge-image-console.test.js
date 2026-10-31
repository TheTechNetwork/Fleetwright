// The serial console driver's reading of a shell, without a VM: a command's
// exit status and output recovered from a stream that arrives in arbitrary
// pieces and echoes everything typed (scripts/edge-image/console.mjs).
//
//   node --test test/edge-image-console.test.js
//
// The image build runs only in CI, so this is the one part of it that can be
// wrong on a laptop and found there. The failure it guards: a tty echoes the
// typed marker before the shell prints the real one, and a reader that takes
// the echo for the answer reports every command done with no status at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Console, sentinel, sliceOutput } from '../scripts/edge-image/console.mjs';

/** A console whose guest is a script of what to send back for each typed line. @param {(typed: string) => string} guest */
function harness(guest) {
  /** @type {string[]} */
  const log = [];
  const c = new Console({ send: (t) => queueMicrotask(() => c.feed(guest(t))), log: (t) => log.push(t) });
  return { c, log };
}

test('the typed marker does not match the pattern waited for; the shell’s echo of it does', () => {
  const s = sentinel(7);
  assert.doesNotMatch(s.typed, s.done, 'the typed line would satisfy its own wait');
  assert.match('__FW_DONE_7_0__', s.done);
  assert.match('__FW_DONE_7_127__', s.done);
  assert.doesNotMatch('__FW_DONE_17_0__', s.done, 'another command’s marker');
});

test('a command’s status and output are read even when the stream arrives one byte at a time', async () => {
  const c = new Console({ send: () => {} });
  const p = c.run('uname -s', { timeout: 1000 });
  // What a tty shows: the echoed line, the output, the expanded marker, a prompt.
  const stream = 'uname -s; echo "__FW_""DONE_1_$?__"\r\nFreeBSD\r\n__FW_DONE_1_0__\r\n# ';
  for (const ch of stream) c.feed(Buffer.from(ch));
  const r = await p;
  assert.deepEqual(r, { status: 0, output: 'FreeBSD' });
  assert.equal(c.buf, '\r\n# ', 'the prompt after the marker is left for the next wait');
});

test('a failing command’s status is the shell’s, and `must` turns it into a sentence naming the command', async () => {
  const { c } = harness((typed) => `${typed}\nno such file\r\n__FW_DONE_1_2__\r\n# `);
  const r = await c.run('ls /nope', { timeout: 1000 });
  assert.deepEqual(r, { status: 2, output: 'no such file' });
  const second = harness((typed) => `${typed}\nno such file\r\n__FW_DONE_1_2__\r\n# `);
  await assert.rejects(second.c.must('ls /nope', { timeout: 1000 }), /`ls \/nope` exited 2:\nno such file/);
});

test('output that happens to contain another marker’s text does not end this command early', async () => {
  const c = new Console({ send: () => {} });
  const p = c.run('cat notes', { timeout: 1000 });
  c.feed('cat notes; echo "__FW_""DONE_1_$?__"\r\n__FW_DONE_9_0__ is in the file\r\n__FW_DONE_1_0__\r\n');
  assert.deepEqual(await p, { status: 0, output: '__FW_DONE_9_0__ is in the file' });
});

test('a prompt is waited for at the end of what arrived, and a wait that never ends says so with the last lines', async () => {
  const c = new Console({ send: () => {} });
  const p = c.waitFor(/login: $/, { timeout: 1000, label: 'the login prompt' });
  c.feed('Starting cron.\r\nFreeBSD/amd64 (OPNsense.internal) (ttyu0)\r\n\r\nlogin: ');
  const { before } = await p;
  assert.match(before, /Starting cron/);
  assert.equal(c.buf, '');
  const slow = new Console({ send: () => {} });
  slow.feed('Booting...\r\nstill booting\r\n');
  await assert.rejects(slow.waitFor(/login: $/, { timeout: 20, label: 'the login prompt' }), /the login prompt did not appear within 0s\. The last of the console:\nBooting\.\.\.\nstill booting/);
});

test('the guest going away rejects the wait instead of leaving it to the timeout', async () => {
  const c = new Console({ send: () => {} });
  const p = c.waitFor(/never/, { timeout: 60_000, label: 'a thing' });
  c.feed('The operating system has halted.\r\n');
  c.close();
  await assert.rejects(p, /the console closed while waiting for a thing\. The last of it:\nThe operating system has halted\./);
});

test('one conversation: a second wait while one is pending is refused rather than racing it', async () => {
  const c = new Console({ send: () => {} });
  const first = c.waitFor(/a/, { timeout: 1000, label: 'a' });
  await assert.rejects(c.waitFor(/b/, { timeout: 1000 }), /already waiting for a/);
  c.feed('a');
  await first;
});

test('output without an echo (echo off) is the whole window, carriage returns dropped', () => {
  assert.equal(sliceOutput('line one\r\nline two\r\n', 'DONE_3_$?__"'), 'line one\nline two');
  // The prompt printed after the previous marker opens the window, and goes.
  assert.equal(sliceOutput('\r\n# 26.7.5\r\n', 'DONE_3_$?__"'), '26.7.5');
  assert.equal(sliceOutput('\r\n# \r\n', 'DONE_3_$?__"'), '');
  // An echo a line editor redrew with a carriage return inside it is still found.
  assert.equal(sliceOutput('# x; echo "__FW_""DONE_3_\r$?__"\r\nout\r\n', 'DONE_3_$?__"'), 'out');
  assert.equal(sliceOutput('x; echo "__FW_""DONE_3_$?__"\r\n', 'DONE_3_$?__"'), '');
});

test('a secret is sent as typed, and the log says only what it was', () => {
  const sent = [];
  const logged = [];
  const con = new Console({ send: (s) => sent.push(s), log: (s) => logged.push(s) });
  con.typeSecret('opnsense', 'the root password');
  assert.deepEqual(sent, ['opnsense\r']);
  assert.equal(logged.join(''), '\n>>> [the root password]\n');
  assert.ok(!logged.join('').includes('opnsense'));
});
