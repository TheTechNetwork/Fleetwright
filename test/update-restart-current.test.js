// `/update --restart` on a box installed from releases, when there is nothing
// newer to fetch.
//
//   node --test test/update-restart-current.test.js
//
// SEEN ON A BOX: it reported "already on main-209" and did nothing, while its
// sidecar was still running the release before. A hypervisor setup run there
// handed no token back, because the sidecar running it predated the hand-off.
// The git path has treated an explicit restart as a restart for a long time
// (update.test.js); the release path now does the same, and the marker it
// writes is what brings the sidecar over.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dispatch } from '../src/adapters/commands.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

/** A release install: <base>/current links into <base>/releases/<version>. */
function packagedBox(/** @type {string} */ version) {
  const base = mkdtempSync(path.join(tmpdir(), 'restart-current-'));
  const dir = path.join(base, 'releases', version);
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
  writeFileSync(path.join(dir, 'lib', 'fleetwright.mjs'), '');
  symlinkSync(dir, path.join(base, 'current'));
  const stateDir = path.join(base, 'state');
  mkdirSync(stateDir);
  return { base, cfg: { installDir: path.join(base, 'current'), stateDir, hostname: 'h', releaseManifest: 'https://github.com/o/r/releases/latest/download/manifest.json' } };
}

/** A manifest naming `version`, and nothing else to download. */
const serving = (/** @type {string} */ version) => /** @type {any} */ (async () => ({
  ok: true,
  status: 200,
  json: async () => ({ version, file: `fleetwright-host-${version}.tar.gz`, sha256: 'a'.repeat(64), protocol: PROTOCOL_VERSION }),
}));

test('a restart asked of a box already on the newest release restarts it anyway', async (t) => {
  const box = packagedBox('main-209');
  t.after(() => rmSync(box.base, { recursive: true, force: true }));
  // Not under systemd here, so the restart says it cannot exit on its own
  // rather than exiting the test: what is pinned is that it was attempted.
  const saved = process.env.INVOCATION_ID;
  delete process.env.INVOCATION_ID;
  t.after(() => { if (saved !== undefined) process.env.INVOCATION_ID = saved; });

  const r = await dispatch(/** @type {any} */ ({ cfg: box.cfg, fetch: serving('main-209') }), '/update --restart');
  assert.match(r.text, /already on main-209/);
  assert.match(r.text, /Nothing new to fetch, so this restarts onto the release already here, and the sidecar follows/);
  assert.match(r.text, /Not running under systemd/);
});

test('a plain check on the same box still only reports', async (t) => {
  const box = packagedBox('main-209');
  t.after(() => rmSync(box.base, { recursive: true, force: true }));
  const r = await dispatch(/** @type {any} */ ({ cfg: box.cfg, fetch: serving('main-209') }), '/update --check');
  assert.match(r.text, /already on main-209/);
  assert.doesNotMatch(r.text, /restarts onto/);
});
