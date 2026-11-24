// The fleet's own machine image: what a container made from it runs, and
// what it is built from. docs/api-engines.md, "A machine on a box of your
// own".
//
// The entrypoint is run here for real, as bash runs it, against a release
// that is two small programs standing in for the hub and the sidecar: what
// they are started with is the contract, and neither can be started here for
// real without a fleet to join. The image itself is built and started in CI
// (.github/workflows/sandbox.yml); nothing here needs a container engine.
//
//   node --test test/machine-image.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSidecarToken as readTokenFileFor } from '../src/core/api-token.js';

const ENTRY = fileURLToPath(new URL('../sandbox/machine/entrypoint', import.meta.url));
const CONTAINERFILE = readFileSync(new URL('../sandbox/machine/Containerfile', import.meta.url), 'utf8');
const TICKET = `fwt_${'a1'.repeat(6)}_${'b2'.repeat(24)}`;

/**
 * A release with a hub and a sidecar that write down what they were started
 * with and stop: the sidecar with `exit`, the hub when it is told to.
 *
 * @param {import('node:test').TestContext} t @param {{ exit?: number }} [o]
 */
function release(t, { exit = 0 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-machine-'));
  t.after(() => spawnSync('rm', ['-rf', dir]));
  mkdirSync(path.join(dir, 'root', 'bin'), { recursive: true });
  const seen = (/** @type {string} */ who) => path.join(dir, `${who}.json`);
  const stand = (/** @type {string} */ who, /** @type {string} */ then) => `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(seen(who))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));
${then}
`;
  writeFileSync(path.join(dir, 'root', 'bin', 'fleetwright'), stand('hub', 'setInterval(() => {}, 1000);'));
  writeFileSync(path.join(dir, 'root', 'bin', 'fleetwright-sidecar'), stand('sidecar', `setTimeout(() => process.exit(${exit}), 150);`));
  /** @param {Record<string, string>} env */
  const run = (env) =>
    spawnSync('bash', [ENTRY], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: process.env.PATH ?? '', FLEETWRIGHT_MACHINE_ROOT: path.join(dir, 'root'), FLEETWRIGHT_MACHINE_STATE: path.join(dir, 'state'), FLEETWRIGHT_STATE_DIR: path.join(dir, 'hub'), ...env },
    });
  const read = (/** @type {string} */ who) => (existsSync(seen(who)) ? JSON.parse(readFileSync(seen(who), 'utf8')) : null);
  return { dir, run, read, join: path.join(dir, 'state', 'vm-join.json'), token: path.join(dir, 'hub', 'sidecar-token') };
}

test('a machine started with a ticket writes the join file a VM has, and starts the hub and the sidecar without the ticket', (t) => {
  const m = release(t);
  const r = m.run({ FLEETWRIGHT_COORDINATOR: 'https://fleet.example', FLEETWRIGHT_TICKET: TICKET, FLEETWRIGHT_OWNER: 'eli@example.com', FLEETWRIGHT_MINUTES: '90' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /joining https:\/\/fleet\.example as its owner’s temporary machine|joining https:\/\/fleet\.example as its owner's temporary machine/);
  // THE FILE THE SIDECAR ENROLS FROM, as install/fleetwright-vm-join leaves it, readable by nobody else.
  assert.deepEqual(JSON.parse(readFileSync(m.join, 'utf8')), { v: 1, coordinator: 'https://fleet.example', ticket: TICKET, owner: 'eli@example.com', minutes: 90 });
  assert.equal(statSync(m.join).mode & 0o777, 0o600);
  const hub = m.read('hub');
  const sidecar = m.read('sidecar');
  assert.deepEqual(hub.argv, ['serve']);
  assert.deepEqual(sidecar.argv, []);
  // WHAT THE SIDECAR IS TOLD, and nothing from a file somebody left in the image.
  assert.equal(sidecar.env.FLEETWRIGHT_COORDINATOR_URL, 'https://fleet.example');
  assert.equal(sidecar.env.FLEETWRIGHT_VM_JOIN, m.join);
  assert.equal(sidecar.env.FLEETWRIGHT_SIDECAR_ENV_FILE, '/dev/null');
  assert.equal(sidecar.env.FLEETWRIGHT_HOST_KEY, path.join(path.dirname(m.join), 'host-key.json'));
  // THE TICKET IS IN THE FILE AND NOWHERE ELSE: neither process inherits it, so no pane does.
  for (const p of [hub, sidecar]) assert.equal(JSON.stringify(p.env).includes(TICKET), false);
  // THE TOKEN THE SIDECAR SHOWS THE HUB IS THERE BEFORE EITHER STARTS, in the
  // hub's state, which both are pointed at: two processes started together
  // do not race for it. The shape and the mode are what api-token.js reads.
  assert.match(readFileSync(m.token, 'utf8'), /^[0-9a-f]{48}\n$/);
  assert.equal(statSync(m.token).mode & 0o777, 0o600);
  for (const p of [hub, sidecar]) assert.equal(p.env.FLEETWRIGHT_STATE_DIR, path.dirname(m.token));
  assert.equal(readTokenFileFor(path.dirname(m.token)), readFileSync(m.token, 'utf8').trim(), 'and the sidecar’s own reader takes it');
});

test('a machine started with nothing to join with says so and starts nothing', (t) => {
  for (const [env, said] of /** @type {Array<[Record<string, string>, RegExp]>} */ ([
    [{}, /no https coordinator in FLEETWRIGHT_COORDINATOR/],
    // The ticket would cross in the clear.
    [{ FLEETWRIGHT_COORDINATOR: 'http://fleet.example', FLEETWRIGHT_TICKET: TICKET }, /no https coordinator/],
    [{ FLEETWRIGHT_COORDINATOR: 'https://fleet.example' }, /no ticket in FLEETWRIGHT_TICKET, so it cannot join https:\/\/fleet\.example/],
    [{ FLEETWRIGHT_COORDINATOR: 'https://fleet.example', FLEETWRIGHT_TICKET: 'fwt_not-one' }, /no ticket in FLEETWRIGHT_TICKET/],
  ])) {
    const m = release(t);
    const r = m.run(env);
    assert.equal(r.status, 64, JSON.stringify(env));
    assert.match(r.stdout, said);
    assert.match(r.stdout, /Nothing was started\./);
    assert.equal(m.read('hub'), null);
    assert.equal(m.read('sidecar'), null);
    assert.equal(existsSync(m.join), false, 'and no join file is left for a later start to find');
    assert.equal(existsSync(m.token), false);
  }
});

test('a machine started again joins from the file it has, and ends with the sidecar’s own status', (t) => {
  const m = release(t, { exit: 3 });
  assert.equal(m.run({ FLEETWRIGHT_COORDINATOR: 'https://fleet.example', FLEETWRIGHT_TICKET: TICKET }).status, 3, 'the sidecar’s status is the machine’s');
  // The sidecar spends the ticket and blanks it in the file (vm-join.js); a
  // restart of the container finds the file and needs no ticket.
  const spent = { ...JSON.parse(readFileSync(m.join, 'utf8')), ticket: null, hostId: 'vm-a1a1a1a1a1a1' };
  writeFileSync(m.join, `${JSON.stringify(spent)}\n`);
  chmodSync(m.join, 0o600);
  const again = m.run({ FLEETWRIGHT_COORDINATOR: 'https://fleet.example' });
  assert.equal(again.status, 3);
  assert.match(again.stdout, /the sidecar ended with status 3, so this machine is ending/);
  assert.deepEqual(JSON.parse(readFileSync(m.join, 'utf8')), spent, 'the file is left as the sidecar wrote it');
  // A count that is not one is the default, never a crash.
  const odd = release(t);
  odd.run({ FLEETWRIGHT_COORDINATOR: 'https://fleet.example', FLEETWRIGHT_TICKET: TICKET, FLEETWRIGHT_MINUTES: 'soon' });
  assert.equal(JSON.parse(readFileSync(odd.join, 'utf8')).minutes, 60);
});

test('the image is the box’s own release on Debian, with what a host needs and nothing that pins a second copy of a version', () => {
  // BUILT FROM A RELEASE, so a machine runs what its box runs: the host's
  // own code is copied in from what the hub laid out, not fetched.
  assert.match(CONTAINERFILE, /^COPY release \/opt\/fleetwright\/current$/m);
  assert.match(CONTAINERFILE, /^COPY --chmod=0755 entrypoint \/usr\/local\/bin\/fleetwright-machine$/m);
  assert.doesNotMatch(CONTAINERFILE, /npm (?:install|ci)|ghcr\.io/, 'nothing of the fleet’s is fetched');
  assert.match(CONTAINERFILE, /^FROM debian:13-slim$/m);
  // What the hub runs a session with as a plain pane: tmux, git, and tini to reap what panes leave.
  assert.match(CONTAINERFILE, /apt-get install -y --no-install-recommends[^\n]*(?:\\\n[^\n]*)*\btmux\b/);
  assert.match(CONTAINERFILE, /\btini\b/);
  assert.match(CONTAINERFILE, /^ENTRYPOINT \["\/usr\/bin\/tini", "--", "\/usr\/local\/bin\/fleetwright-machine"\]$/m);
  // Claude Code as a box's own installer gets it, so there is one pinned
  // version of it in the repository (the session image's) and not two.
  assert.match(CONTAINERFILE, /https:\/\/claude\.ai\/install\.sh/);
  assert.doesNotMatch(CONTAINERFILE, /claude-code@/);
});
