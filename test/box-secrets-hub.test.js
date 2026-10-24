// Which store answers a session's `fleet-secret <name>`, through the real
// start and resume path: the command a sidecar sends, the session manager,
// the record it writes, and the resolver the hook socket calls.
//
// `start { secret: NAME }` is the grant, and members can start on an
// operator's box. The box's own secret of that name answered first for every
// session, so a member naming DEPLOY_KEY was served the operator's, and their
// own vault secret of that name was hidden behind it. The coordinator now says
// on the start and the resume whether the box's secrets are this session's
// owner's to have (`--box-secrets`, protocol v14; box-secrets.test.js is that
// half), and the hub keeps it on the record.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';
import { dispatch } from '../src/adapters/commands.js';
import { applyVault } from '../src/core/vault-store.js';
import { sessionSecret } from '../src/core/secret-store.js';

const UUID = '22222222-2222-2222-2222-222222222222';

/**
 * A sandboxed box with stub tmux and podman on PATH, its operator's
 * DEPLOY_KEY in its store, and bob's DEPLOY_KEY in what his vault gave it.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string>} [env]  more of the box's environment
 */
function box(t, env = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'box-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  const live = path.join(dir, 'live');
  mkdirSync(live);
  writeFileSync(path.join(bin, 'podman'), '#!/bin/sh\ncase "$1 $2" in\n "volume inspect") exit 0;;\n "container exists") exit 1;;\nesac\nexit 0\n', { mode: 0o755 });
  // A pane per session name, so one session's start does not read as another's,
  // and one that has ended by the time anybody reads it: a resume then waits
  // out no dialog, and the same session can be resumed again.
  writeFileSync(
    path.join(bin, 'tmux'),
    '#!/bin/sh\nname=""\nprev=""\nfor a in "$@"; do [ "$prev" = "-s" ] || [ "$prev" = "-t" ] && { name="${a#=}"; name="${name%:}"; }; prev="$a"; done\n' +
      'case "$1" in\n new-session) touch "$STUB_LIVE/$name"; exit 0;;\n has-session) [ -e "$STUB_LIVE/$name" ] && exit 0; exit 1;;\n capture-pane) rm -f "$STUB_LIVE/$name"; echo; exit 0;;\nesac\nexit 0\n',
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
    FLEETWRIGHT_REMOTE_CONTROL: '0',
    ...env,
  });
  mkdirSync(cfg.secretsDir, { recursive: true });
  writeFileSync(path.join(cfg.secretsDir, 'DEPLOY_KEY'), 'operators-deploy-key\n');
  writeFileSync(path.join(cfg.secretsDir, 'OPS_ONLY'), 'operators-other\n');
  assert.equal(applyVault(cfg, { accounts: [{ email: 'bob@example.com', items: [{ name: 'secret:DEPLOY_KEY', value: 'bobs-deploy-key' }] }] }).ok, true);
  const registry = new Registry({ stateFile: path.join(dir, 'sessions.json'), spoolFile: path.join(dir, 'spool') });
  const sessions = new SessionManager(cfg, registry, null);
  /** @param {string} actor @param {string} line */
  const run = (actor, line) => dispatch(/** @type {any} */ ({ cfg, sessions, actor, login: {} }), line);
  /** @param {string} name @param {string} asked */
  const fetched = (name, asked = 'DEPLOY_KEY') => {
    const r = sessionSecret(cfg, registry.get(name), asked);
    return r.ok ? r.value : r.error;
  };
  return { cfg, registry, run, fetched };
}

test('a member’s session is answered from their own vault, never from the box’s store', async (t) => {
  const { run, fetched } = box(t);
  const r = await run('fleet:bob@example.com', '/new mine --secret=DEPLOY_KEY --box-secrets=no');
  assert.equal(r.ok, true, r.text);
  assert.equal(fetched('mine'), 'bobs-deploy-key', 'the operator’s secret answered a member’s session');

  // A name only the box holds is not there for him at all.
  await run('fleet:bob@example.com', '/new probe --secret=OPS_ONLY --box-secrets=no');
  assert.equal(fetched('probe', 'OPS_ONLY'), 'no_secret');
});

test('a session of somebody who administers the box, or of somebody on it, is answered from the box first', async (t) => {
  const { run, fetched } = box(t);
  await run('fleet:admin@example.com', '/new theirs --secret=DEPLOY_KEY --box-secrets=yes');
  assert.equal(fetched('theirs'), 'operators-deploy-key');
  // The console and the CLI on the box are its operator, as they always were.
  await run('web', '/new local --secret=DEPLOY_KEY');
  assert.equal(fetched('local'), 'operators-deploy-key');
});

test('a start or resume from a coordinator that does not say is answered from the vault alone', async (t) => {
  // Fail closed: an older coordinator cannot be asked who administers the
  // box, so a fleet session gets its owner's vault and nothing of the box's.
  const { run, registry, fetched } = box(t);
  await run('fleet:bob@example.com', '/new quiet --secret=DEPLOY_KEY');
  assert.equal(fetched('quiet'), 'bobs-deploy-key');

  // A resume is decided again: a session that had the box's secrets loses
  // them when the coordinator says no or says nothing, and somebody on the
  // box resuming it leaves the record's word alone.
  const cwd = registry.get('quiet')?.cwd;
  registry.upsert('was-admin', { status: 'stopped', uuid: UUID, cwd, createdBy: 'fleet:bob@example.com', secret: 'DEPLOY_KEY', boxSecrets: true, account: 'shared' });
  assert.equal(fetched('was-admin'), 'operators-deploy-key');
  const local = await run('web', '/resume was-admin full');
  assert.match(local.text, /^Resumed "was-admin"/);
  assert.equal(fetched('was-admin'), 'operators-deploy-key', 'somebody on the box changed the coordinator’s word');
  const fleet = await run('fleet:bob@example.com', '/resume was-admin full');
  assert.match(fleet.text, /^Resumed "was-admin"/);
  assert.equal(fetched('was-admin'), 'bobs-deploy-key');
});

test('a --box-secrets that is not yes or no is refused, not guessed at', async (t) => {
  const { run, registry } = box(t);
  const r = await run('fleet:bob@example.com', '/new odd --secret=DEPLOY_KEY --box-secrets=maybe');
  assert.equal(r.ok, false);
  assert.equal(r.text, '--box-secrets is yes or no.');
  assert.equal(registry.get('odd'), null, 'a session was started on a word nobody can read');
});

test('a session somebody started on the box itself is answered from the box, then from its operator’s vault', async (t) => {
  // On a vault box the box's own command line runs as a person who approved
  // it (accounts.js, operatorAccount), so their vault is the one after the
  // box's store, as a member's own vault is after it for an admin's session.
  // Bob is the operator, named in FLEETWRIGHT_OPERATOR.
  const { cfg, run, fetched } = box(t, { FLEETWRIGHT_OPERATOR: 'bob@example.com' });
  applyVault(cfg, { accounts: [{ email: 'bob@example.com', items: [{ name: 'secret:DEPLOY_KEY', value: 'bobs-deploy-key' }, { name: 'secret:BOB_NPM', value: 'bobs-npm' }] }] });
  await run('cli', '/new local --secret=BOB_NPM');
  assert.equal(fetched('local', 'BOB_NPM'), 'bobs-npm');
  await run('web', '/new mixed --secret=DEPLOY_KEY');
  assert.equal(fetched('mixed'), 'operators-deploy-key', 'the box’s own store still answers first');
});
