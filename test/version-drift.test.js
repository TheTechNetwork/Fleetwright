// What a process RUNS against what is on disk, on a box installed from
// releases.
//
//   node --test test/version-drift.test.js
//
// SEEN ON A BOX: `/updates` said "already on main-209" while its sidecar ran
// the release before, and a hypervisor setup run there kept the pool's token on
// the machine. Every version on the box was read through
// FLEETWRIGHT_INSTALL_DIR=<base>/current, which follows the symlink to the disk,
// so the running code and the disk could never disagree in what was reported.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { versionDrift } from '../src/core/release-apply.js';
import { startStubHub } from './helpers/stub-hub.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

/** Two releases on disk, `current` pointing at the newer. */
function box(t) {
  const base = mkdtempSync(path.join(tmpdir(), 'drift-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  for (const v of ['main-150', 'main-209']) {
    const dir = path.join(base, 'releases', v);
    mkdirSync(path.join(dir, 'lib'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: v }));
  }
  symlinkSync(path.join(base, 'releases', 'main-209'), path.join(base, 'current'));
  return { base, current: path.join(base, 'current'), old: path.join(base, 'releases', 'main-150'), now: path.join(base, 'releases', 'main-209') };
}

test('a process running an older release than the disk says which, and one on the disk says nothing', (t) => {
  const b = box(t);
  assert.deepEqual(versionDrift(b.current, b.old), { running: 'main-150', onDisk: 'main-209' });
  assert.equal(versionDrift(b.current, b.now), null);
  // A tree that is not a release (a checkout) has nothing to compare.
  assert.equal(versionDrift(path.join(b.base, 'nowhere'), b.old), null);
});

test('the sidecar adds its own half to /updates when it is running behind the disk', async (t) => {
  const stub = await startStubHub({ onCommand: (line) => (line.startsWith('/updates') ? { ok: true, text: 'Fleetwright: already on main-209' } : undefined) });
  t.after(() => stub.close());
  const make = (/** @type {any} */ version) =>
    new Sidecar({
      hub: new HubClient({ baseUrl: stub.baseUrl, token: null, readTimeoutMs: 2000 }),
      transport: /** @type {any} */ ({ send() {}, on() {}, connect() {}, close() {} }),
      hostId: 'h',
      healthIntervalMs: 0,
      watch: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      version: () => version,
    });
  const ask = (/** @type {Sidecar} */ s) =>
    s.handle({ v: PROTOCOL_VERSION, kind: 'intent', id: `idem-${Math.random().toString(36).slice(2, 10)}`, verb: 'updates', params: {}, issuedAt: Date.now() });

  const behind = await ask(make({ head: 'main-150', branch: null, installed: 'main-209' }));
  assert.match(behind.text, /already on main-209/);
  assert.match(behind.text, /The sidecar here is still running main-150; main-209 is on disk\./);
  assert.match(behind.text, /\/update --restart/);

  const current = await ask(make({ head: 'main-209', branch: null, installed: 'main-209' }));
  assert.doesNotMatch(current.text, /still running/);
  const unknown = await ask(make(null));
  assert.doesNotMatch(unknown.text, /still running/, 'cannot tell is not behind');
});
