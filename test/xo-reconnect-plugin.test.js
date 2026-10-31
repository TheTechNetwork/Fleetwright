// Fleetwright's reconnect watchdog, the xo-server plugin in
// xo-plugin/xo-server-fleetwright-reconnect (docs/hypervisors.md, "When Xen
// Orchestra loses a pool"). Driven against a stand-in for xo-server's app
// that keeps the rules the real one keeps (xen-servers.mjs): connect refuses
// anything not `disconnected`, disconnect turns `enabled` off on its way.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installerConfig } from '../src/fleet/host/xo-deploy.js';

const DIR = fileURLToPath(new URL('../xo-plugin/xo-server-fleetwright-reconnect/', import.meta.url));
const plugin = createRequire(import.meta.url)(DIR);
const { Watchdog, DISCONNECTED_GRACE_MS, CONNECTING_STUCK_MS, MAX_BACKOFF_MS } = plugin;
const MIN = 60e3;

/** A stand-in xo-server: servers by id, and every call made of it. */
function fakeXo(servers, { connectFails = () => null } = {}) {
  const calls = [];
  const byId = new Map(servers.map((s) => [s.id, { ...s }]));
  return {
    calls,
    byId,
    async getAllXenServers() {
      return [...byId.values()].map((s) => ({ ...s }));
    },
    async getXenServer(id) {
      return { ...byId.get(id) };
    },
    async updateXenServer(id, props) {
      calls.push(['update', id, props]);
      Object.assign(byId.get(id), props);
    },
    async disconnectXenServer(id) {
      calls.push(['disconnect', id]);
      Object.assign(byId.get(id), { enabled: false, status: 'disconnected' });
    },
    async connectXenServer(id, opts) {
      calls.push(['connect', id, opts]);
      const s = byId.get(id);
      if (s.status !== 'disconnected') throw new Error('incorrect state');
      if (opts?.enable) s.enabled = true;
      const fail = connectFails(id);
      if (fail) throw fail;
      Object.assign(s, { status: 'connected', error: null });
    },
  };
}

function watch(xo) {
  let now = 0;
  const said = [];
  const log = { info: (m) => said.push(m), warn: (m) => said.push(m) };
  const w = new Watchdog(xo, { now: () => now, log });
  return { w, said, at: (t) => (now = t) };
}

test('xo-server loads it as it finds it: a factory, with no settings to wait on', async () => {
  const mod = (await import(`${DIR}index.js`)).default;
  assert.equal(typeof mod, 'function');
  // No schema is what makes Xen Orchestra count it configured and load it.
  assert.equal(mod.configurationSchema, undefined);
  const instance = mod({ xo: fakeXo([]) });
  assert.equal(typeof instance.load, 'function');
  assert.equal(typeof instance.unload, 'function');
  instance.load();
  instance.unload();
});

test('a server stuck connecting is disconnected and connected again, as Reconnect in the app does', async () => {
  const xo = fakeXo([{ id: 's1', label: 'tn-pool', enabled: true, status: 'connecting' }]);
  const { w, at } = watch(xo);
  at(0);
  await w.check();
  at(CONNECTING_STUCK_MS - 1);
  await w.check();
  assert.deepEqual(xo.calls, [], 'not before it has been stuck long enough');
  at(CONNECTING_STUCK_MS);
  await w.check();
  assert.deepEqual(xo.calls.map((c) => c[0]), ['disconnect', 'connect']);
  assert.equal(xo.byId.get('s1').status, 'connected');
  assert.equal(xo.byId.get('s1').enabled, true);
});

test('a cycle that fails still leaves the server turned on, for Xen Orchestra to keep trying', async () => {
  const xo = fakeXo([{ id: 's1', enabled: true, status: 'connecting' }], { connectFails: () => new Error('host unreachable') });
  const { w, at, said } = watch(xo);
  at(0);
  await w.check();
  at(CONNECTING_STUCK_MS);
  await w.check();
  assert.equal(xo.byId.get('s1').enabled, true);
  assert.ok(said.some((m) => /did not connect: host unreachable/.test(m)));
});

test('a server left disconnected is connected after Xen Orchestra had its own first tries, never enabling it', async () => {
  const xo = fakeXo([{ id: 's1', enabled: true, status: 'disconnected' }]);
  const { w, at } = watch(xo);
  at(0);
  await w.check();
  at(DISCONNECTED_GRACE_MS - 1);
  await w.check();
  assert.deepEqual(xo.calls, []);
  at(DISCONNECTED_GRACE_MS);
  await w.check();
  assert.deepEqual(xo.calls, [['connect', 's1', { enable: false }]]);
});

test('a server a person turned off is left off, whatever its state', async () => {
  const xo = fakeXo([
    { id: 'off', enabled: false, status: 'disconnected' },
    { id: 'off2', enabled: false, status: 'connecting' },
  ]);
  const { w, at } = watch(xo);
  for (const t of [0, 60 * MIN, 120 * MIN]) {
    at(t);
    await w.check();
  }
  assert.deepEqual(xo.calls, []);
});

test('a wrong stored password is never retried, and is said once', async () => {
  const xo = fakeXo([{ id: 's1', label: 'tn-pool', enabled: true, status: 'disconnected', error: { code: 'SESSION_AUTHENTICATION_FAILED', message: 'wrong password' } }]);
  const { w, at, said } = watch(xo);
  for (const t of [0, 10 * MIN, 60 * MIN]) {
    at(t);
    await w.check();
  }
  assert.deepEqual(xo.calls, []);
  assert.equal(said.filter((m) => /not reconnecting tn-pool: wrong password/.test(m)).length, 1);
});

test('a second server for a pool another holds stands by, and is connected once that one drops', async () => {
  // A pool master that answers on two addresses by turns, listed twice:
  // `a` holds the pool, `b` was turned away for it. Xen Orchestra never
  // retries `b` (the error ends its loop), and before this neither did the
  // watchdog, so when the host moved and `a` dropped, the pool stayed gone.
  const turnedAway = { name: 'PoolAlreadyConnected', message: 'this pool is already connected', poolId: 'p1', connectedServerId: 'a', connectingServerId: 'b' };
  const xo = fakeXo(
    [
      { id: 'a', label: 'pool at .11', enabled: true, status: 'connected', poolId: 'p1' },
      { id: 'b', label: 'pool at .12', enabled: true, status: 'disconnected', error: turnedAway },
    ],
    { connectFails: (id) => (id === 'a' ? new Error('connect ECONNREFUSED') : null) },
  );
  const { w, at, said } = watch(xo);
  for (const t of [0, 10 * MIN, 60 * MIN]) {
    at(t);
    await w.check();
  }
  assert.deepEqual(xo.calls, [], 'left alone while a holds the pool');
  assert.equal(said.filter((m) => /pool at \.12 stands by: its pool is connected through pool at \.11/.test(m)).length, 1);
  // The host moves: a drops and will not come back on its address.
  Object.assign(xo.byId.get('a'), { status: 'disconnected', error: { message: 'connect ECONNREFUSED' } });
  delete xo.byId.get('a').poolId;
  const t0 = 61 * MIN;
  at(t0);
  await w.check();
  at(t0 + DISCONNECTED_GRACE_MS - 1);
  await w.check();
  assert.ok(!xo.calls.some((c) => c[1] === 'b'), 'the usual grace first');
  at(t0 + DISCONNECTED_GRACE_MS);
  await w.check();
  assert.ok(xo.calls.some((c) => c[0] === 'connect' && c[1] === 'b'), `b is connected: ${JSON.stringify(xo.calls)}`);
  assert.equal(xo.byId.get('b').status, 'connected');
});

test('a server turned away by an error that names no holder is left alone, as before', async () => {
  const xo = fakeXo([
    { id: 'a', enabled: true, status: 'disconnected', error: { message: 'connect ECONNREFUSED' } },
    { id: 'b', enabled: true, status: 'disconnected', error: { message: 'this pool is already connected' } },
  ]);
  const { w, at } = watch(xo);
  for (const t of [0, 10 * MIN, 60 * MIN]) {
    at(t);
    await w.check();
  }
  assert.ok(!xo.calls.some((c) => c[1] === 'b'), `nothing guessed for b: ${JSON.stringify(xo.calls)}`);
});

test('it waits longer after each try that does not take, up to half an hour', async () => {
  const xo = fakeXo([{ id: 's1', enabled: true, status: 'disconnected' }], { connectFails: () => new Error('host unreachable') });
  const { w, at } = watch(xo);
  const tries = [];
  for (let t = 0; t <= 6 * 60 * MIN; t += MIN) {
    at(t);
    const before = xo.calls.length;
    await w.check();
    // A failed connect leaves the stand-in disconnected, as xo-server does.
    xo.byId.get('s1').status = 'disconnected';
    if (xo.calls.length > before) tries.push(t / MIN);
  }
  const gaps = tries.slice(1).map((t, i) => t - tries[i]);
  assert.deepEqual(gaps.slice(0, 3), [6, 12, 24], `tries at ${tries}`);
  assert.ok(gaps.every((g) => g <= MAX_BACKOFF_MS / MIN), `no wait over half an hour: ${gaps}`);
});

test('a server that comes back is forgotten, so a later drop starts from the short wait again', async () => {
  const xo = fakeXo([{ id: 's1', enabled: true, status: 'disconnected' }]);
  const { w, at } = watch(xo);
  at(0);
  await w.check();
  at(DISCONNECTED_GRACE_MS);
  await w.check();
  assert.equal(xo.byId.get('s1').status, 'connected');
  at(DISCONNECTED_GRACE_MS + MIN);
  await w.check();
  xo.byId.get('s1').status = 'disconnected';
  const t0 = DISCONNECTED_GRACE_MS + 2 * MIN;
  at(t0);
  await w.check();
  at(t0 + DISCONNECTED_GRACE_MS);
  await w.check();
  assert.equal(xo.calls.filter((c) => c[0] === 'connect').length, 2);
});

// ADDING IT TO A XEN ORCHESTRA INSTALLED WITHOUT IT, the script a person runs
// as root on that machine. It checks it is root before anything else, so this
// runs only where the tests do.
const ADD = fileURLToPath(new URL('../xo-plugin/add-reconnect-watchdog.sh', import.meta.url));
const isRoot = process.getuid?.() === 0;

/** A built xo-server and the installer beside it, with this xo-install.cfg. */
function xoMachine(/** @type {string} */ cfg) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fw-xo-add-'));
  const xoServer = path.join(root, 'xo-server');
  mkdirSync(path.join(xoServer, 'node_modules'), { recursive: true });
  writeFileSync(path.join(xoServer, 'package.json'), '{\n  "name": "xo-server"\n}\n');
  const installer = path.join(root, 'installer');
  mkdirSync(installer);
  writeFileSync(path.join(installer, 'xo-install.sh'), 'BUNDLED_PLUGINS="${BUNDLED_PLUGINS:-"none"}"\n');
  writeFileSync(path.join(installer, 'xo-install.cfg'), cfg);
  const run = () => spawnSync('bash', [ADD, '--xo-server', xoServer, '--installer', installer, '--no-restart'], { encoding: 'utf8' });
  const named = () => spawnSync('bash', ['-c', 'source "$1"; printf %s "$BUNDLED_PLUGINS"', 'bash', path.join(installer, 'xo-install.cfg')], { encoding: 'utf8' }).stdout;
  return { xoServer, installer, run, named, cfg: () => readFileSync(path.join(installer, 'xo-install.cfg'), 'utf8') };
}

/** xo-install.cfg as xo-remote-deploy.sh writes it: the configuration, then its own two lines. */
const asWritten = (/** @type {string} */ config) => `${config}\nSELFUPGRADE=false\nBUNDLED_PLUGINS="xo-server-installer-updates"\n`;

test('an install from before the watchdog gets it now and in every later build, once', { skip: !isRoot && 'needs root' }, () => {
  const old = installerConfig().split('# The installer')[0];
  const xo = xoMachine(asWritten(old));
  assert.equal(xo.named(), 'xo-server-installer-updates');
  const first = xo.run();
  assert.equal(first.status, 0, first.stderr);
  assert.ok(existsSync(path.join(xo.xoServer, 'node_modules', 'xo-server-fleetwright-reconnect', 'index.js')));
  assert.ok(existsSync(path.join(xo.installer, 'plugins', 'xo-server-fleetwright-reconnect', 'package.json')));
  // ADDED TO what the file named, not instead of it.
  assert.equal(xo.named(), 'xo-server-installer-updates,xo-server-fleetwright-reconnect');
  const after = xo.cfg();
  assert.equal(xo.run().status, 0);
  assert.equal(xo.cfg(), after, 'a second run adds no second line');
});

test('an install that already builds it in is left as it was', { skip: !isRoot && 'needs root' }, () => {
  const xo = xoMachine(asWritten(installerConfig()));
  const before = xo.cfg();
  const ran = xo.run();
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /already names it/);
  assert.equal(xo.cfg(), before);
});

test('the script refuses a directory that is not xo-server, and changes nothing', { skip: !isRoot && 'needs root' }, () => {
  const xo = xoMachine(asWritten(installerConfig()));
  writeFileSync(path.join(xo.xoServer, 'package.json'), '{ "name": "something-else" }\n');
  const ran = xo.run();
  assert.notEqual(ran.status, 0);
  assert.match(ran.stderr, /^Not added: .* is not xo-server's directory/m);
  assert.ok(!existsSync(path.join(xo.xoServer, 'node_modules', 'xo-server-fleetwright-reconnect')));
});
