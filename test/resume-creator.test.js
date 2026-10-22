// WHOSE SESSION A RESUME LEAVES IT, through the real launch path.
//
//   node --test test/resume-creator.test.js
//
// The credential broker answers a session's `fleet-cred github` from the
// record's creator on every request (src/index.js secretsFor → pickSecretsFile),
// and podman.js says why: provider tokens follow the person who STARTED the
// session, never the person pressing resume. #launch wrote the record with the
// actor pressing the button, on a resume as on a start, so an admin resuming a
// member's session made it the admin's, and from then on the member's own
// container (their conversation, their /work, their project hooks) was handed
// the admin's GitHub token (eighth audit). The start path had been fixed for
// the same rewrite; resume and the error paths had not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';
import { pickSecretsFile } from '../src/core/podman.js';
import { Connections } from '../src/core/connectors.js';

const UUID = '11111111-1111-1111-1111-111111111111';

/** A box with stub tmux and podman on PATH, a sandbox config and a stopped session of the member's. */
function box(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'resume-creator-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const live = path.join(dir, 'live');
  // Paths reach the stubs through the environment, never pasted into the script.
  writeFileSync(path.join(bin, 'podman'), '#!/bin/sh\ncase "$1 $2" in\n "volume inspect") exit 0;;\n "container exists") exit 1;;\nesac\nexit 0\n', { mode: 0o755 });
  writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\ncase "$1" in\n new-session) touch "$STUB_LIVE"; exit 0;;\n has-session) [ -e "$STUB_LIVE" ] && exit 0; exit 1;;\n capture-pane) echo; exit 0;;\nesac\nexit 0\n',
    { mode: 0o755 },
  );
  const before = { PATH: process.env.PATH, STUB_LIVE: process.env.STUB_LIVE };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.STUB_LIVE = live;
  t.after(() => {
    process.env.PATH = before.PATH;
    if (before.STUB_LIVE === undefined) delete process.env.STUB_LIVE;
    else process.env.STUB_LIVE = before.STUB_LIVE;
  });
  const cfg = loadConfig({
    ...process.env,
    FLEETWRIGHT_STATE_DIR: dir,
    FLEETWRIGHT_SANDBOX: '1',
    FLEETWRIGHT_PODMAN_BIN: path.join(bin, 'podman'),
    FLEETWRIGHT_WORKDIR: path.join(dir, 'work'),
    FLEETWRIGHT_RESUME_CHOICE: 'full',
    FLEETWRIGHT_SANDBOX_USERNS: 'host',
    FLEETWRIGHT_RC_TIMEOUT_MS: '200',
    // The stub tmux never shows a resume dialog, which is the healthy case:
    // the resume then waits out this before going on. The least it may be,
    // rather than the 45 seconds a real box gives Claude to draw it.
    FLEETWRIGHT_RESUME_DIALOG_WAIT_MS: '5000',
  });
  const registry = new Registry({ stateFile: path.join(dir, 'sessions.json'), spoolFile: path.join(dir, 'spool') });
  registry.upsert('shared1', { status: 'stopped', uuid: UUID, cwd: path.join(dir, 'work'), createdBy: 'fleet:member@example.com', account: 'shared' });
  const tokens = new Connections(dir);
  tokens.save('member@example.com', 'github', 'ghp_MEMBER_dummy');
  tokens.save('admin@example.com', 'github', 'ghp_ADMIN_dummy');
  return { cfg, registry, sessions: new SessionManager(cfg, registry, null) };
}

test('a colleague resuming somebody\'s session does not make it theirs, nor lend it their GitHub', async (t) => {
  const { cfg, registry, sessions } = box(t);
  await sessions.resume({ name: 'shared1', actor: 'fleet:admin@example.com', choice: 'full' });

  assert.equal(registry.get('shared1')?.createdBy, 'fleet:member@example.com', 'still the member\'s session');
  const row = readFileSync(pickSecretsFile(cfg, registry.get('shared1')?.createdBy), 'utf8');
  assert.match(row, /ghp_MEMBER_dummy/, 'the broker answers with the member\'s own token');
  assert.doesNotMatch(row, /ghp_ADMIN_dummy/, 'and never the admin\'s');
});
