// A session runs below fleetwright itself when the box asks it to.
//
// A macOS runner building an app and booting a simulator reached a load of
// 167; the session manager, at the same priority as the build, missed the
// sidecar's reads and the fleet lost sight of the session. FLEETWRIGHT_SESSION_NICE
// puts the session — and so everything it starts — below the services.
//
// Measured, not inferred from the arguments: the stub tmux below runs the
// pane's command the way tmux does, and the command reports its own niceness.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { newSession } from '../src/core/tmux.js';

/** A tmux whose new-session runs the pane command in the foreground. */
function stubTmux(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    path.join(dir, 'tmux'),
    // new-session -d -s NAME -c CWD <command...>: drop the first six, run the rest.
    '#!/bin/sh\n[ "$1" = new-session ] || exit 0\nshift 6\nexec "$@"\n',
    { mode: 0o755 },
  );
  const before = process.env.PATH;
  process.env.PATH = `${dir}:${before}`;
  t.after(() => { process.env.PATH = before; });
  return dir;
}

/** @param {string} dir @param {number} nice */
function niceOfSession(dir, nice) {
  const out = path.join(dir, `ni-${nice}`);
  const r = newSession({ name: 'job', cwd: dir, command: `ps -o ni= -p $$ > ${out}`, nice });
  assert.equal(r.status, 0, r.stderr);
  return Number(readFileSync(out, 'utf8').trim());
}

test('a session started with a niceness runs that much below the process that started it', (t) => {
  const dir = stubTmux(t);
  const base = os.getPriority();
  assert.equal(niceOfSession(dir, 10), Math.min(19, base + 10));
});

test('at 0, as before, a session shares the priority of the process that started it', (t) => {
  const dir = stubTmux(t);
  assert.equal(niceOfSession(dir, 0), os.getPriority());
});
