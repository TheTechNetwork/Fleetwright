// `fleetwright join` — the third line of a three-line setup.
//
// What has to hold: a bare hostname means https (a Worker answers on nothing
// else), a loopback one means http (the local coordinator has no certificate),
// an explicit scheme is kept as typed, and nothing runs as root or gets written
// anywhere until the address has answered as a coordinator.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { coordinatorUrl, probeCoordinator, joinPlan, rootRefusal, runJoin } from '../src/core/join.js';

const url = (s) => {
  const r = coordinatorUrl(s);
  assert.equal(r.ok, true, `${s}: ${/** @type {any} */ (r).message}`);
  return /** @type {{ url: string }} */ (r).url;
};

test('a bare hostname is https', () => {
  assert.equal(url('fleet.example.com'), 'https://fleet.example.com');
  assert.equal(url('fleet.example.com/'), 'https://fleet.example.com');
  assert.equal(url('fleet.example.com:8443'), 'https://fleet.example.com:8443');
  assert.equal(url('  fleet.example.com  '), 'https://fleet.example.com');
});

test('a loopback address is http, because there is no certificate to be had', () => {
  assert.equal(url('localhost:8791'), 'http://localhost:8791');
  assert.equal(url('127.0.0.1:8791'), 'http://127.0.0.1:8791');
  assert.equal(url('[::1]:8791'), 'http://[::1]:8791');
});

test('a scheme somebody typed is kept, http included', () => {
  assert.equal(url('https://fleet.example.com'), 'https://fleet.example.com');
  assert.equal(url('http://fleet.internal:8791'), 'http://fleet.internal:8791');
  assert.equal(url('https://example.com/fleet/'), 'https://example.com/fleet');
});

test('what is not an address a sidecar can dial is refused, with why', () => {
  for (const bad of ['', '   ', 'ftp://fleet.example.com', 'https://fleet.example.com/?x=1', 'https://fleet.example.com/#a', 'http://']) {
    const r = coordinatorUrl(bad);
    assert.equal(r.ok, false, `${JSON.stringify(bad)} was accepted`);
    assert.ok(/** @type {any} */ (r).message.length > 0);
  }
});

test('the probe asks /healthz, and says what it got', async () => {
  const seen = [];
  const good = await probeCoordinator('https://fleet.example.com', {
    fetch: /** @type {any} */ (async (u) => { seen.push(u); return { ok: true, status: 200 }; }),
  });
  assert.equal(good.ok, true);
  assert.deepEqual(seen, ['https://fleet.example.com/healthz']);

  const notOurs = await probeCoordinator('https://example.com', {
    fetch: /** @type {any} */ (async () => ({ ok: false, status: 404 })),
  });
  assert.equal(notOurs.ok, false);
  assert.match(notOurs.message, /404/);

  const nothing = await probeCoordinator('https://nowhere.invalid', {
    fetch: /** @type {any} */ (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }),
  });
  assert.equal(nothing.ok, false);
  assert.match(nothing.message, /ENOTFOUND/);
});

test('the plan is the installer\'s wizard, told the fleet, and the pin only when given', () => {
  const env = { PATH: '/usr/bin' };
  const without = joinPlan({ url: 'https://f.example', root: '/opt/fleetwright/current', node: '/n', env });
  assert.deepEqual(without.argv, ['bash', '/opt/fleetwright/current/install/install.sh', '--wizard']);
  assert.equal(without.env.FLEETWRIGHT_COORDINATOR_URL, 'https://f.example');
  assert.equal('FLEETWRIGHT_ENROL_PIN' in without.env, false, 'blank pin: the wizard asks for it');
  assert.equal(without.env.FLEETWRIGHT_NODE_BIN, '/n', 'on a deb box this node is the only one');

  const withPin = joinPlan({ url: 'https://f.example', pin: '123456', root: '/r', node: '/n', env: { FLEETWRIGHT_NODE_BIN: '/mine' } });
  assert.equal(withPin.env.FLEETWRIGHT_ENROL_PIN, '123456');
  assert.equal(withPin.env.FLEETWRIGHT_NODE_BIN, '/mine', 'an operator\'s own choice is not overridden');
});

const cli = (...args) =>
  spawnSync(process.execPath, ['bin/fleetwright', ...args], { encoding: 'utf8', env: { ...process.env, FLEETWRIGHT_ENV_FILE: '/nonexistent' } });

test('join refuses bad input before it needs root or the network', () => {
  const none = cli('join');
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Which fleet/);

  const pin = cli('join', 'fleet.example.com', '--pin', '12ab');
  assert.equal(pin.status, 2);
  assert.match(pin.stderr, /six digits/);

  const two = cli('join', 'a.example', 'b.example');
  assert.equal(two.status, 2);
  assert.match(two.stderr, /one coordinator at a time/);
});

test('not root: the sudo line to run, echoing what was typed', () => {
  assert.equal(rootRefusal(0, 'fleet.example.com', false), null);
  assert.equal(rootRefusal(undefined, 'fleet.example.com', false), null);
  assert.match(rootRefusal(1000, 'fleet.example.com', false), /sudo fleetwright join fleet\.example\.com$/);
  // The pin is not echoed into a line that ends up in shell history.
  assert.match(rootRefusal(1000, 'fleet.example.com', true), /--pin …$/);
});

test('join checks the address answers before anything else, root or not', () => {
  const r = cli('join', 'nowhere.invalid');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /could not reach https:\/\/nowhere\.invalid/);
  assert.match(r.stderr, /Nothing was changed/);
});

test('fleetwright --help names join and the short name', () => {
  const r = cli('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /fleetwright join <coordinator>/);
  assert.match(r.stdout, /also: fw/);
});

test('runJoin: the address, then root, then the installer — with the terminal and the pin', async () => {
  const runs = [];
  const out = [];
  const err = [];
  const common = {
    root: '/opt/fleetwright/current',
    node: '/usr/lib/fleetwright/node/bin/node',
    fetch: /** @type {any} */ (async () => ({ ok: true, status: 200 })),
    spawn: (/** @type {string} */ cmd, /** @type {string[]} */ argv, /** @type {any} */ opts) => { runs.push({ cmd, argv, opts }); return { status: 0 }; },
    out: (/** @type {string} */ s) => out.push(s),
    err: (/** @type {string} */ s) => err.push(s),
  };
  assert.equal(await runJoin(['fleet.example.com', '--pin=123456'], { ...common, uid: 0 }), 0);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].cmd, ...runs[0].argv], ['bash', '/opt/fleetwright/current/install/install.sh', '--wizard']);
  assert.equal(runs[0].opts.stdio, 'inherit', 'the wizard asks on the terminal the person typed into');
  assert.equal(runs[0].opts.env.FLEETWRIGHT_COORDINATOR_URL, 'https://fleet.example.com');
  assert.equal(runs[0].opts.env.FLEETWRIGHT_ENROL_PIN, '123456');
  assert.match(out.join('\n'), /is a coordinator/);

  // Not root: refused after the address answered, and nothing ran.
  assert.equal(await runJoin(['fleet.example.com'], { ...common, uid: 1000 }), 2);
  assert.equal(runs.length, 1);
  assert.match(err.at(-1), /sudo fleetwright join fleet\.example\.com/);

  // --no-check skips the probe entirely.
  let probed = false;
  const noProbe = { ...common, fetch: /** @type {any} */ (async () => { probed = true; return { ok: false, status: 500 }; }) };
  assert.equal(await runJoin(['fleet.example.com', '--no-check'], { ...noProbe, uid: 0 }), 0);
  assert.equal(probed, false);

  assert.equal(await runJoin(['fleet.example.com', '--force'], { ...common, uid: 0 }), 2);
  assert.match(err.at(-1), /unknown option --force/);
  await assert.rejects(runJoin(['fleet.example.com'], { ...common, spawn: undefined, uid: 0 }), /needs a spawn/);
});
