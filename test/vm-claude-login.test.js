// A machine from somebody's pool, and the Claude login it runs on.
//
//   node --test test/vm-claude-login.test.js
//
// docs/security.md, G14: a session machine booted with its owner's Claude
// login on its cloud-init drive, and Xen Orchestra lets every box holding the
// fleet's token export that drive (`disk.exportContent`, measured on 5.211.0)
// until boot destroys it. So one box's token read another person's login.
// Now the drive carries only the ticket, and the machine asks for the login
// once it has enrolled, over its own socket; the box that made it hands it
// over sealed to the machine's key.
//
// Driven through the real pieces: the coordinator core, the box's sidecar
// with its pools (Xen Orchestra played by a stand-in that records what it was
// asked and keeps the VMs it made), the machine's enrolment from the file its
// drive held, and the machine's sidecar and hub over their real loopback API,
// as test/claude-login.test.js drives a runner's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { XoPools } from '../src/fleet/host/xo-pools.js';
import { VM_IMAGE } from '../src/fleet/host/vm-image.js';
import { enrolVmOnce, vmLogin, forgetJoin } from '../src/fleet/host/vm-join.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { runnerTokenFile } from '../src/core/runner-login.js';
import { generateKeyPair } from '../src/fleet/crypto.js';
import { startStubHub } from './helpers/stub-hub.js';
import { admit } from './helpers/enrolled-hosts.js';

const ELI = 'eli@example.com';
const CLAUDE = `sk-ant-oat01-${'e'.repeat(40)}`;
const IMAGE = '0b1e8c2a-3f4d-4e5a-9b6c-7d8e9f0a1b2c';

/**
 * Xen Orchestra as the fleet's limited user sees it: the pool, the image and
 * the uplink in the fleet's set, and every VM it makes kept, running, in that
 * set, under the id vm.create answers with, as xo-server does.
 */
function pool() {
  /** @type {any[]} */
  const objects = [
    { type: 'pool', id: 'pool-1', name_label: 'rack' },
    { type: 'VM-template', id: IMAGE, name_label: 'Fleetwright Debian 13', $pool: 'pool-1', tags: [VM_IMAGE.tag] },
    { type: 'network', id: 'net-uplink', name_label: 'fleetwright-uplink', $pool: 'pool-1' },
  ];
  /** @type {Array<{ method: string, params: any }>} */
  const calls = [];
  const rpc = {
    async call(/** @type {string} */ method, /** @type {any} */ params = {}) {
      calls.push({ method, params });
      if (method === 'session.signIn') return { id: 'u1', permission: 'none' };
      if (method === 'xo.getAllObjects') {
        const f = params.filter || {};
        return Object.fromEntries(objects.filter((o) => Object.entries(f).every(([k, v]) => o[k] === v)).map((o) => [o.id, o]));
      }
      if (method === 'resourceSet.getAll') return [{ id: 'set-1', name: 'fleetwright', subjects: ['u1'], objects: objects.filter((o) => o.type !== 'VM').map((o) => o.id) }];
      if (method === 'vm.create') {
        const id = `vm-uuid-${calls.filter((c) => c.method === 'vm.create').length}`;
        objects.push({ type: 'VM', id, name_label: params.name_label, tags: params.tags, resourceSet: params.resourceSet, power_state: 'Running', $pool: 'pool-1' });
        return id;
      }
      return true;
    },
    close() {},
  };
  return { rpc, calls, objects };
}

/** @param {() => boolean} ok @param {string} what */
async function until(ok, what) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), what);
}

test('a machine’s drive carries no Claude login, and the box that made it hands the login over once the machine has joined', async (t) => {
  const core = new CoordinatorCore({});
  /** Every frame between the coordinator and the two hosts, both ways. @type {any[]} */
  const wire = [];

  // THE BOX: Eli's, holding her pool and, from her vault, her Claude login.
  const xo = pool();
  const pools = new XoPools({ connect: /** @type {any} */ (async () => xo.rpc), connectPlain: /** @type {any} */ (async () => xo.rpc) });
  pools.adopt([{ email: ELI, items: [
    { name: 'hypervisor:xo.lan', value: JSON.stringify({ v: 1, address: 'xo.lan', pin: 'a'.repeat(64), token: 'xo-limited-token', resourceSet: 'set-1' }) },
    { name: 'claude', value: CLAUDE },
  ] }]);
  await pools.refresh();
  const stub = await startStubHub();
  t.after(() => stub.close());
  const box = new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, token: null }),
    transport: /** @type {any} */ ({ origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {}, send: () => true }),
    hostId: 'eli-box', watch: false, healthIntervalMs: 0, renewIntervalMs: 0, vaultIntervalMs: 0, xoPools: pools,
  });
  await admit(core, 'eli-box', {
    enrolledBy: ELI,
    send: (/** @type {any} */ frame) => {
      wire.push(frame);
      void box.handle(frame).then((reply) => {
        wire.push(reply);
        if (reply?.kind === 'reply') void core.onHostMessage('eli-box', reply);
      });
    },
  });
  core.registry.recordHealth('eli-box', { hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 5, running: 0, free: 5, labels: [], xo: pools.report() });

  // ASKED FOR, and made.
  const asked = await core.dispatch({ verb: 'provision', params: { platform: 'vm', template: IMAGE }, actor: ELI, requester: { email: ELI, admin: false } });
  assert.equal(asked.ok, true, asked.text);

  // WHAT THE DRIVE HOLDS, which another box holding the fleet's token can export.
  const drive = String(xo.calls.find((c) => c.method === 'vm.create')?.params.cloudConfig);
  assert.ok(!drive.includes(CLAUDE), 'the drive carries the Claude login');
  const joinFile = JSON.parse(/** @type {string} */ (drive.split('\n').find((l) => l.trim().startsWith('{"v":1'))).trim());
  assert.equal(joinFile.claude, undefined);

  // THE MACHINE ENROLS with the ticket from its drive, as its first boot does.
  const dir = mkdtempSync(join(tmpdir(), 'fw-vm-login-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'vm-join.json');
  writeFileSync(file, JSON.stringify(joinFile), { mode: 0o600 });
  const key = await generateKeyPair();
  const name = await enrolVmOnce({
    file, origin: 'https://fleet.test', hostKeyFile: join(dir, 'host-key.json'), publicJwk: key.publicJwk,
    fetchImpl: /** @type {any} */ (async (/** @type {URL} */ url, /** @type {any} */ init) => {
      assert.equal(new URL(url).pathname, '/api/enroll/vm');
      const r = await core.enrolVm(JSON.parse(init.body));
      return new Response(JSON.stringify(r.body), { status: r.status });
    }),
  });
  assert.equal(name, asked.vm);
  const given = vmLogin(file);
  assert.deepEqual(given, { email: ELI, token: null }, 'it knows whose it is, and holds no login yet');

  // ITS SIDECAR AND HUB, over the hub's real loopback API.
  const stateDir = mkdtempSync(join(tmpdir(), 'fw-vm-hub-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const cfg = /** @type {any} */ ({ stateDir, bind: '127.0.0.1', port: 0, token: '', hostname: String(name), workdir: join(stateDir, 'work'), maxSessions: 1, sandbox: false });
  const hubToken = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions: /** @type {any} */ ({ list: () => [], running: () => [] }), login: /** @type {any} */ ({}), token: hubToken });
  await adapter.start();
  t.after(() => adapter.server?.close());
  const machine = new Sidecar({
    hub: new HubClient({ baseUrl: `http://127.0.0.1:${/** @type {any} */ (adapter.server).address().port}`, token: hubToken }),
    transport: /** @type {any} */ ({
      origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {},
      send: (/** @type {any} */ frame) => {
        wire.push(frame);
        void core.onHostMessage(String(name), frame);
        return true;
      },
    }),
    hostId: String(name), watch: false, healthIntervalMs: 0, renewIntervalMs: 0,
    vmLogin: given, onVmLoginHanded: () => forgetJoin(file),
  });
  core.hostConnected(String(name), (/** @type {any} */ frame) => {
    wire.push(frame);
    void machine.handle(frame);
  });
  await machine.start();
  t.after(() => machine.stop());
  await machine.claudeLoginReady;

  // HANDED OVER: the hub runs Eli's sessions on her login, and the file is gone.
  const record = JSON.parse(readFileSync(join(stateDir, 'runner-login.json'), 'utf8'));
  assert.equal(record.email, ELI);
  assert.equal(readFileSync(runnerTokenFile(cfg), 'utf8'), CLAUDE);
  assert.equal(existsSync(file), false);
  // ASKED OF THE BOX THAT MADE IT, and never readable on the way.
  const ask = wire.find((f) => f?.kind === 'intent' && f.verb === 'vmlogin');
  assert.deepEqual([ask?.params.name, ask?.actor], [name, ELI]);
  assert.ok(!JSON.stringify(wire).includes(CLAUDE), 'the Claude login crossed the coordinator readable');
  await until(() => core.events.some((e) => e.event === 'vm.claude'), 'the hand-over was recorded');

  // ONCE: asked again, by the coordinator or by anything else holding the
  // name, the box hands nothing.
  const again = await box.handle({ v: PROTOCOL_VERSION, kind: 'intent', id: 'idem-vmlogin-2', verb: 'vmlogin', params: { name: String(name), key: ask.params.key }, actor: ELI, issuedAt: Date.now() });
  assert.equal(/** @type {any} */ (again).ok, false);
  assert.equal(/** @type {any} */ (again).sealed, undefined);
  // AND NOBODY CAN ASK FOR IT THROUGH THE FLEET'S FRONT DOOR.
  const forged = await core.dispatch({ verb: 'vmlogin', params: { name: String(name), key: ask.params.key }, actor: ELI, requester: { email: ELI, admin: true } });
  assert.equal(forged.error?.code, 'coordinator_only');
});
