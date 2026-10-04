// A session keeps the tools it installed across a restart, and a person's
// sessions on one box share what they downloaded.
//
//   node --test test/session-tools-persist.test.js
//
// REPORTED FROM A SESSION: "restart resets /usr/local/bin — putting the tooling
// on the persistent volume this time." Everything outside /work and
// /root/.claude is gone on every stop, by design, so a CLI installed with
// npm -g or a binary dropped in /usr/local/bin had to be installed again, and
// every package downloaded again, on every resume and in every new session.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildCommand, cacheVolumeFor } from '../src/core/claude.js';

const IMAGE = readFileSync(new URL('../sandbox/Containerfile', import.meta.url), 'utf8');
const ENTRY = readFileSync(new URL('../sandbox/entrypoint.sh', import.meta.url), 'utf8');

/** @param {Partial<any>} patch @returns {any} */
const cfg = (patch = {}) => ({
  claudeBin: '/usr/local/bin/claude', remoteControl: true, skipPermissions: true, sandbox: true,
  podmanBin: 'podman', sandboxImage: 'localhost/fleetwright-session:latest', sandboxHookSocket: false,
  sandboxExtraArgs: [], sandboxCache: true, ...patch,
});

test('the package managers install onto the workspace volume, and its bin is on PATH after the fleet\'s shims', () => {
  for (const line of [
    'NPM_CONFIG_PREFIX=/work/.tools',
    'PYTHONUSERBASE=/work/.tools',
    'PIPX_BIN_DIR=/work/.tools/bin',
    'GOBIN=/work/.tools/bin',
    'CARGO_INSTALL_ROOT=/work/.tools',
  ]) assert.ok(IMAGE.includes(line), line);
  // After /usr/local/bin, so a session's gh never shadows the credential shim.
  assert.match(IMAGE, /PATH=\/usr\/local\/sbin:\/usr\/local\/bin:\/work\/\.tools\/bin:\/usr\/sbin:\/usr\/bin/);
  // After the image's own npm install, or the CLI would land under the volume.
  assert.ok(IMAGE.indexOf('NPM_CONFIG_PREFIX=/work/.tools') > IMAGE.indexOf('npm install -g "@anthropic-ai/claude-code'));
  assert.match(ENTRY, /mkdir -p \/work\/\.tools\/bin/);
});

test('the session is told where things last', () => {
  assert.match(IMAGE, /> \/etc\/claude-code\/CLAUDE\.md/);
  assert.match(IMAGE, /Only \/work and ~\/\.claude survive a restart of this session/);
});

test('downloads go to /root/.cache, which is a volume of the person\'s own', () => {
  assert.match(IMAGE, /NPM_CONFIG_CACHE=\/root\/\.cache\/npm/);
  const line = buildCommand(cfg(), { name: 'api', owner: 'fleet:eli@example.com' });
  assert.match(line, new RegExp(`'-v' '${cacheVolumeFor('fleet:eli@example.com')}:/root/\\.cache'`));
});

test('one cache per person, never one for everybody', () => {
  const eli = cacheVolumeFor('fleet:eli@example.com');
  assert.match(eli, /^cache-[0-9a-f]{16}$/);
  assert.equal(cacheVolumeFor('eli@example.com'), eli, 'an actor and the bare email are the same person');
  assert.notEqual(cacheVolumeFor('fleet:sam@example.com'), eli);
  assert.ok(!eli.includes('eli'), 'the volume list does not spell out who uses the box');
  // The box's own surfaces have nobody behind them, and share the operator's.
  assert.equal(cacheVolumeFor(null), 'cache-box');
  assert.equal(cacheVolumeFor('web'), 'cache-box');
});

test('turned off, nothing is mounted', () => {
  const line = buildCommand(cfg({ sandboxCache: false }), { name: 'api', owner: 'fleet:eli@example.com' });
  assert.ok(!line.includes(':/root/.cache'));
});
