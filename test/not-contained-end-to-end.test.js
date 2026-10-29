// What a refused member is told about a box that does not contain a session,
// from the box's environment to the fleet's sentence, when more than one
// thing keeps it from being contained.
//
//   node --test test/not-contained-end-to-end.test.js
//
// The box reported one reason, the first, and the fleet said that reason's
// fix "opens it to everyone it acts for". With two, that was false. A
// root-run box with FLEETWRIGHT_SANDBOX=0 was told to turn its sandbox on;
// after that it reported root, and nothing it had been told was true. The
// same for root with FLEETWRIGHT_SANDBOX_USERNS=host, with docker and with
// an unsafe FLEETWRIGHT_SANDBOX_ARGS, and for docker with `host`.
//
// So this runs the whole path the words take: loadConfig reads the box's
// environment, HttpAdapter answers /api/state, the sidecar's factsFrom reads
// that reply into the health frame, and CoordinatorCore.dispatch refuses a
// member's start with what the frame said. Each case asserts the sentence
// names every fix, then makes every fix it named and asserts the box is then
// contained, which is the claim "it takes all of them" makes. Root is the
// uid loadConfig asks process.getuid for, swapped for the one call, so the
// root cases run the same on a root CI box and on a laptop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { factsFrom } from '../src/fleet/host/sidecar.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { admit, makeAdmin } from './helpers/enrolled-hosts.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const BOB = { email: 'bob@example.test', admin: false };

/**
 * A box as its operator set it up: the sandbox, its arguments, the engine,
 * the namespace asked for, and whether the service runs as root.
 *
 * @typedef {{ sandbox: boolean, args: string, engine: 'podman'|'docker', userns: 'nomap'|'host', root: boolean }} Box
 */

/** Each reason, the words its fix is named by, and the fix made to the box. */
const FIXES = /** @type {const} */ ({
  off: { named: 'its sandbox on (FLEETWRIGHT_SANDBOX=1)', make: (/** @type {Box} */ b) => ({ ...b, sandbox: true }) },
  unsafe_args: { named: 'FLEETWRIGHT_SANDBOX_ARGS', make: (/** @type {Box} */ b) => ({ ...b, args: '' }) },
  userns_root: { named: 'its own user', make: (/** @type {Box} */ b) => ({ ...b, root: false }) },
  userns_docker: { named: 'under podman', make: (/** @type {Box} */ b) => ({ ...b, engine: /** @type {const} */ ('podman') }) },
  userns_host: { named: 'FLEETWRIGHT_SANDBOX_USERNS back to nomap', make: (/** @type {Box} */ b) => ({ ...b, userns: /** @type {const} */ ('nomap') }) },
});

/**
 * What the box's /api/state says, read through the real config and adapter.
 *
 * @param {import('node:test').TestContext} t @param {Box} box
 */
async function stateOf(t, box) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'not-contained-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const realUid = process.getuid;
  process.getuid = () => (box.root ? 0 : 1000);
  let cfg;
  try {
    cfg = loadConfig({
      ...process.env,
      FLEETWRIGHT_STATE_DIR: dir,
      FLEETWRIGHT_WORKDIR: path.join(dir, 'work'),
      FLEETWRIGHT_BIND: '127.0.0.1',
      FLEETWRIGHT_PORT: '0',
      FLEETWRIGHT_TOKEN: '',
      FLEETWRIGHT_SANDBOX: box.sandbox ? '1' : '0',
      FLEETWRIGHT_SANDBOX_ARGS: box.args,
      FLEETWRIGHT_SANDBOX_ALLOW_UNSAFE_ARGS: box.args ? '1' : '',
      FLEETWRIGHT_PODMAN_BIN: box.engine,
      FLEETWRIGHT_SANDBOX_USERNS: box.userns,
    });
  } finally {
    process.getuid = realUid;
  }
  const sessions = /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] });
  const login = /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null });
  const token = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions, login, token });
  await adapter.start();
  try {
    const port = /** @type {any} */ (adapter.server).address().port;
    return await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json();
  } finally {
    adapter.server?.close();
  }
}

/** A fleet whose boxes report as their sidecars would, and a member asking. */
async function fleetOf(/** @type {Record<string, any>} */ facts) {
  const core = new CoordinatorCore({ logger: quiet });
  await makeAdmin(core, 'admin@example.test');
  for (const [hostId, f] of Object.entries(facts)) {
    await admit(core, hostId, {
      send: (/** @type {any} */ intent) =>
        queueMicrotask(() => core.onHostMessage(hostId, { kind: 'reply', id: intent.id, ok: true, text: 'done' })),
    });
    core.registry.recordHealth(hostId, {
      hostId, protocol: PROTOCOL_VERSION, hub: { reachable: true }, maxSessions: 5, running: 0, free: 5, labels: ['linux'],
      loadavg: [0, 0, 0], claudeAccounts: 1, sessions: [],
      sandboxed: f.sandboxed, sandboxedWhy: f.sandboxedWhy, sandboxedAlso: f.sandboxedAlso,
    });
  }
  return core;
}

/** @type {Box} */
const CONTAINED = { sandbox: true, args: '', engine: 'podman', userns: 'nomap', root: false };

/** Each box, and the reasons it has, in the order it gives them. @type {Array<[string, Box, Array<keyof typeof FIXES>]>} */
const PAIRS = [
  ['root with the sandbox off', { ...CONTAINED, root: true, sandbox: false }, ['off', 'userns_root']],
  ['root with FLEETWRIGHT_SANDBOX_USERNS=host', { ...CONTAINED, root: true, userns: 'host' }, ['userns_host', 'userns_root']],
  ['root with docker', { ...CONTAINED, root: true, engine: 'docker' }, ['userns_root', 'userns_docker']],
  ['root with --privileged let through', { ...CONTAINED, root: true, args: '--privileged' }, ['unsafe_args', 'userns_root']],
  ['docker with FLEETWRIGHT_SANDBOX_USERNS=host', { ...CONTAINED, engine: 'docker', userns: 'host' }, ['userns_host', 'userns_docker']],
];

for (const [what, box, reasons] of PAIRS) {
  test(`${what}: the refusal names both fixes, and making them contains the box`, async (t) => {
    const facts = factsFrom(await stateOf(t, box));
    assert.equal(facts.sandboxed, false);
    const core = await fleetOf({ box: facts });
    const r = await core.dispatch({ verb: 'start', params: { name: 'job', task: 'a job' }, actor: BOB.email, requester: BOB, preferHost: 'box' });
    assert.equal(r.error?.code, 'unsandboxed');
    const text = String(r.text);
    for (const code of reasons) assert.ok(text.includes(FIXES[code].named), `${code} is not named in: ${text}`);
    assert.match(text, /It takes both to open it to everyone it acts for: /, text);
    assert.doesNotMatch(text, / opens it to everyone/, `no one fix is said to open it: ${text}`);
    assert.deepEqual([facts.sandboxedWhy, ...(facts.sandboxedAlso ?? [])], reasons);

    // Every fix the sentence named, made: the box is contained, and the
    // member's work goes there.
    const after = factsFrom(await stateOf(t, reasons.reduce((b, code) => FIXES[code].make(b), box)));
    assert.equal(after.sandboxed, true, `after every fix named, still: ${after.sandboxedWhy}`);
    const now = await fleetOf({ box: after });
    assert.equal((await now.dispatch({ verb: 'start', params: { name: 'job', task: 'a job' }, actor: BOB.email, requester: BOB, preferHost: 'box' })).ok, true);
  });
}

test('several boxes: one that is off and run as root is not in the sentence that says turning the sandbox on opens them', async (t) => {
  // "Turning a box's sandbox on opens it" was said of every box while each
  // had said off, and a root-run box with the sandbox off had said only off.
  const core = await fleetOf({
    'root-box': factsFrom(await stateOf(t, { ...CONTAINED, root: true, sandbox: false })),
    'plain-box': factsFrom(await stateOf(t, { ...CONTAINED, sandbox: false })),
  });
  const r = await core.dispatch({ verb: 'start', params: { name: 'job', task: 'a job' }, actor: BOB.email, requester: BOB, preferLabels: 'linux' });
  assert.equal(r.error?.code, 'unsandboxed');
  assert.doesNotMatch(String(r.text), /Turning a box’s sandbox on/);
  assert.match(String(r.text), /root-box runs sessions without the sandbox and runs fleetwright as root/);
  assert.match(String(r.text), /plain-box runs sessions without the sandbox(;|\.)/);
});
