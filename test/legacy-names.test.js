// The rename, as a box that has not been migrated yet experiences it.
//
// New code reads FLEETWRIGHT_* and the new paths. A box whose units still load
// /etc/agent-hub.env, a coordinator whose Cloudflare secrets are AGENT_FLEET_*,
// and a checkout whose units were never renamed all have to keep working until
// the installer moves them — and a box that WAS moved must never be pulled back
// to an old name. src/fleet/legacy-names.js and legacy-paths.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { adoptLegacyEnv, withCurrentNames, LEGACY_UNITS } from '../src/fleet/legacy-names.js';
import { preferExisting, unitName } from '../src/fleet/legacy-paths.js';
import { loadConfig } from '../src/config.js';
import { loadEnvFile } from '../src/core/env-file.js';
import { DEFAULT_ACTIONS_AUDIENCES } from '../src/fleet/coordinator/oidc.js';

test('both old prefixes read under the new one, and the new name wins', () => {
  const env = adoptLegacyEnv({
    AGENT_HUB_PORT: '1',
    AGENT_FLEET_COORDINATOR_URL: 'https://old.example',
    AGENT_HUB_SANDBOX: '1',
    FLEETWRIGHT_SANDBOX: '0',
    FLEETWRIGHT_EMPTY: '',
    AGENT_HUB_EMPTY: 'filled',
    UNRELATED: 'x',
  });
  assert.equal(env.FLEETWRIGHT_PORT, '1');
  assert.equal(env.FLEETWRIGHT_COORDINATOR_URL, 'https://old.example');
  assert.equal(env.FLEETWRIGHT_SANDBOX, '0', 'an operator who wrote the new name said something more recent');
  assert.equal(env.FLEETWRIGHT_EMPTY, 'filled', 'an empty new value is not a decision');
  assert.equal(env.UNRELATED, 'x');
});

test("a Worker's env is copied, not written to, and left alone when there is nothing old in it", () => {
  const frozen = Object.freeze({ AGENT_FLEET_API_TOKEN: 't', FLEET: {} });
  const out = withCurrentNames(frozen);
  assert.notEqual(out, frozen);
  assert.equal(out.FLEETWRIGHT_API_TOKEN, 't');
  assert.equal(out.FLEET, frozen.FLEET, 'bindings travel by reference');
  const current = { FLEETWRIGHT_API_TOKEN: 't' };
  assert.equal(withCurrentNames(current), current);
});

test('a config read from an old env file comes out under the new names', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-env-'));
  try {
    const file = path.join(dir, 'agent-hub.env');
    writeFileSync(file, 'AGENT_HUB_PORT=4242\nAGENT_HUB_BIND=127.0.0.9\n');
    const env = {};
    loadEnvFile(file, env);
    const cfg = loadConfig(env);
    assert.equal(cfg.port, 4242);
    assert.equal(cfg.bind, '127.0.0.9');
    // And straight through loadConfig, which is what a unit's EnvironmentFile
    // gives the process without any file being read here.
    assert.equal(loadConfig({ AGENT_HUB_PORT: '4343' }).port, 4343);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a default path is the new one, unless only the old one exists', () => {
  const has = (/** @type {string[]} */ ...present) => (/** @type {string} */ p) => present.includes(p);
  assert.equal(preferExisting('/new', '/old', has()), '/new', 'a fresh box never sees an old name');
  assert.equal(preferExisting('/new', '/old', has('/old')), '/old', 'an unmigrated box keeps its state');
  assert.equal(preferExisting('/new', '/old', has('/old', '/new')), '/new', 'a migrated box is never pulled back');
});

test('a unit is named the way this box has it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'legacy-units-'));
  try {
    assert.equal(unitName('fleetwright-upgrade.service', { dir }), 'fleetwright-upgrade.service', 'neither: the new name');
    writeFileSync(path.join(dir, 'agent-hub-upgrade.service'), '');
    assert.equal(unitName('fleetwright-upgrade.service', { dir }), 'agent-hub-upgrade.service');
    assert.equal(unitName('fleetwright', { dir: mkdtempSync(path.join(tmpdir(), 'u-')) }), 'fleetwright');
    writeFileSync(path.join(dir, 'agent-hub.service'), '');
    assert.equal(unitName('fleetwright', { dir }), 'agent-hub', 'bare names answer bare');
    writeFileSync(path.join(dir, 'fleetwright.service'), '');
    assert.equal(unitName('fleetwright', { dir }), 'fleetwright', 'once renamed, the new name');
    assert.equal(unitName('something-else', { dir }), 'something-else');
    writeFileSync(path.join(dir, 'agent-fleet-confirm.timer'), '');
    assert.equal(unitName('fleetwright-confirm.timer', { dir }), 'agent-fleet-confirm.timer');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every unit the installer renames is one the code can resolve', () => {
  // The installer's legacy_unit_for and this map are two lists of one fact.
  const sh = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');
  for (const [current, legacy] of Object.entries(LEGACY_UNITS)) {
    assert.match(sh, new RegExp(`${current}\\) echo ${legacy} ;;`), `${current} → ${legacy} is not in install.sh`);
  }
});

test('runner repositories copied before the rename are still admitted', () => {
  assert.deepEqual([...DEFAULT_ACTIONS_AUDIENCES], ['fleetwright', 'agent-fleet']);
});
