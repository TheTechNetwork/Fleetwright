// Box-wide verbs against admins the machine pins itself.
//
//   node --test test/pinned-admins.test.js
//
// A coordinator can name anybody an admin. Once this file has a name in it,
// reboot, upgrade, update and a restore of somebody else's work need a
// signature from one of those names, even on a box that does not otherwise
// require signatures. Empty is the old behaviour, on purpose: a box enrolled
// before anyone could pin has nobody to ask. The phone's words are
// test/pinned-admins-in-apps.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { startStubHub } from './helpers/stub-hub.js';

/** @param {object} [opts] */
function fakeTransport({ origin = 'https://coord.example.workers.dev' } = {}) {
  /** @type {object[]} */
  const sent = [];
  return {
    origin,
    sent,
    onMessage: () => {},
    send: (/** @type {object} */ msg) => {
      sent.push(msg);
    },
    start: async () => true,
    stop: async () => true,
  };
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ dir?: string|null, facts?: Record<string, unknown>, verdict?: string|null }} [opts]
 */
async function box(t, { dir, facts = {}, verdict = null } = {}) {
  const stateDir = dir === undefined ? mkdtempSync(path.join(os.tmpdir(), 'pinned-admins-')) : dir;
  if (typeof stateDir === 'string') t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const stub = await startStubHub({ facts });
  t.after(() => stub.close());
  /** @type {{ verdict: string|null }} */
  const say = { verdict };
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, token: null, readTimeoutMs: 2000 }),
    transport: /** @type {any} */ (fakeTransport()),
    hostId: 'unabandoned',
    healthIntervalMs: 0,
    watch: false,
    xoStateDir: stateDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  // The constructor builds IntentKeys only when this process holds a vault
  // key. A test that wants a verdict assigns the checker handle() already
  // calls; leaving it unset is a box that cannot check, which is unsigned.
  if (verdict) {
    sidecar.intentKeys = /** @type {any} */ ({
      check: async () => ({ verdict: say.verdict }),
      isSigner: () => true,
      problem: null,
      report: () => ({ keys: 1, keysAt: null, checked: {}, problem: null }),
    });
  }
  return { stub, sidecar, say, stateDir };
}

let seq = 0;
/**
 * @param {string} verb
 * @param {Record<string, unknown>} [params]
 * @param {string|null} [actor]
 */
const intent = (verb, params = {}, actor = 'ada@example.com') => ({
  v: PROTOCOL_VERSION,
  kind: 'intent',
  id: `idem-pin-${String(++seq).padStart(4, '0')}`,
  verb,
  params,
  actor,
  issuedAt: Date.now(),
});

/** @param {string} dir */
const pins = (dir) => JSON.parse(readFileSync(path.join(dir, 'pinned-admins.json'), 'utf8'));

test('with nobody pinned, an unsigned reboot still reaches the machine', async (t) => {
  const { sidecar, stub, stateDir } = await box(t);
  const r = await sidecar.handle(intent('reboot', {}, 'ada@example.com'));
  assert.equal(r.ok, true);
  assert.deepEqual(stub.commands, ['/reboot']);
  assert.equal(existsSync(path.join(/** @type {string} */ (stateDir), 'pinned-admins.json')), false);
});

test('an empty pin file is nobody pinned, and so is a machine with nowhere to keep one', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pinned-empty-'));
  writeFileSync(path.join(dir, 'pinned-admins.json'), '{"admins":[]}\n');
  const empty = await box(t, { dir });
  assert.equal((await empty.sidecar.handle(intent('reboot'))).ok, true);
  assert.deepEqual(empty.stub.commands, ['/reboot']);

  const none = await box(t, { dir: null, verdict: 'signed' });
  const reboot = await none.sidecar.handle(intent('reboot'));
  assert.equal(reboot.ok, true);
  assert.deepEqual(none.stub.commands, ['/reboot']);
  const pin = await none.sidecar.handle(intent('pinadmin', { email: 'ada@example.com', op: 'add' }));
  assert.equal(pin.ok, false);
  assert.equal(pin.error.code, 'pinned_admins');
  assert.match(pin.text, /nowhere to keep a pinned admin/);
  assert.deepEqual(none.stub.commands, ['/reboot']);
});

test('once somebody is pinned, an unsigned or badly signed box-wide verb does not reach the machine', async (t) => {
  const { sidecar, stub, say, stateDir } = await box(t, { verdict: 'signed' });
  const pinned = await sidecar.handle(intent('pinadmin', { email: 'ada@example.com', op: 'add' }));
  assert.equal(pinned.ok, true);
  assert.match(pinned.text, /Pinned ada@example.com\. Box-wide actions on this machine now require a pinned admin’s signature\./);
  assert.deepEqual(pins(/** @type {string} */ (stateDir)), { admins: ['ada@example.com'] });
  assert.equal(statSync(path.join(/** @type {string} */ (stateDir), 'pinned-admins.json')).mode & 0o777, 0o600);

  say.verdict = null;
  for (const verb of ['reboot', 'upgrade', 'update']) {
    const r = await sidecar.handle(intent(verb));
    assert.equal(r.ok, false, verb);
    assert.equal(r.error.code, 'pinned_admins', verb);
    assert.match(r.text, /not signed by one of them/);
  }
  say.verdict = 'bad-signature';
  const bad = await sidecar.handle(intent('reboot'));
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'pinned_admins');
  assert.deepEqual(stub.commands, [], 'a refused box-wide verb reached the hub');
});

test('a pinned admin’s signature lets the verb through, and somebody else’s does not', async (t) => {
  const { sidecar, stub, say, stateDir } = await box(t, { verdict: 'signed' });
  await sidecar.handle(intent('pinadmin', { email: 'Ada@Example.com', op: 'add' }, 'Ada@Example.com'));
  assert.deepEqual(pins(/** @type {string} */ (stateDir)), { admins: ['ada@example.com'] });

  say.verdict = 'delegated';
  const ok = await sidecar.handle(intent('reboot', {}, 'ada@example.com'));
  assert.equal(ok.ok, true);
  const other = await sidecar.handle(intent('upgrade', { apply: 'yes' }, 'bea@example.com'));
  assert.equal(other.ok, false);
  assert.match(other.text, /bea@example.com is not a pinned admin on this machine, and this reaches everybody’s work on it/);
  const updated = await sidecar.handle(intent('update', { restart: 'yes' }, 'ada@example.com'));
  assert.equal(updated.ok, true);
  assert.deepEqual(stub.commands, ['/reboot', '/update --restart']);
});

test('a signed person may restore their own binned session, and not somebody else’s, unless they are pinned', async (t) => {
  const { sidecar, stub } = await box(t, {
    verdict: 'signed',
    facts: {
      bin: [
        { name: 'mine', createdBy: 'fleet:bea@example.com' },
        { name: 'bare', createdBy: 'bea@example.com' },
        { name: 'theirs', createdBy: 'fleet:ada@example.com' },
        { name: 'web', createdBy: 'web' },
      ],
    },
  });
  await sidecar.handle(intent('pinadmin', { email: 'ada@example.com', op: 'add' }));

  const own = await sidecar.handle(intent('restore', { name: 'mine' }, 'bea@example.com'));
  assert.equal(own.ok, true, own.text);
  const bare = await sidecar.handle(intent('restore', { name: 'bare' }, 'bea@example.com'));
  assert.equal(bare.ok, true, bare.text);
  const theirs = await sidecar.handle(intent('restore', { name: 'theirs' }, 'bea@example.com'));
  assert.equal(theirs.ok, false);
  assert.match(theirs.text, /that session is somebody else’s/);
  const unknown = await sidecar.handle(intent('restore', { name: 'web' }, 'bea@example.com'));
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /cannot tell whose that session is/);
  const missing = await sidecar.handle(intent('restore', { name: 'gone' }, 'bea@example.com'));
  assert.equal(missing.ok, false);
  assert.match(missing.text, /cannot tell whose/);
  const admin = await sidecar.handle(intent('restore', { name: 'theirs' }, 'ada@example.com'));
  assert.equal(admin.ok, true, admin.text);
  assert.deepEqual(stub.commands, ['/restore mine', '/restore bare', '/restore theirs']);
});

test('a pin file that cannot be read refuses the box-wide verbs and is left as it was', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pinned-corrupt-'));
  const file = path.join(dir, 'pinned-admins.json');
  writeFileSync(file, '{');
  const { sidecar, stub } = await box(t, { dir, verdict: 'signed' });
  const reboot = await sidecar.handle(intent('reboot'));
  assert.equal(reboot.ok, false);
  assert.match(reboot.text, /cannot be read/);
  const pin = await sidecar.handle(intent('pinadmin', { email: 'ada@example.com', op: 'add' }));
  assert.equal(pin.ok, false);
  assert.equal(readFileSync(file, 'utf8'), '{');
  assert.deepEqual(stub.commands, []);
});

test('pinning is itself a signed intent, and the first pin is the signer', async (t) => {
  const unsigned = await box(t, { verdict: 'unsigned' });
  const refused = await unsigned.sidecar.handle(intent('pinadmin', { email: 'ada@example.com', op: 'add' }));
  assert.equal(refused.ok, false);
  assert.match(refused.text, /This one was not signed/);
  assert.throws(() => pins(/** @type {string} */ (unsigned.stateDir)));

  const { sidecar, stateDir } = await box(t, { verdict: 'signed' });
  const other = await sidecar.handle(intent('pinadmin', { email: 'bea@example.com', op: 'add' }, 'ada@example.com'));
  assert.equal(other.ok, false);
  assert.match(other.text, /names somebody else/);
  assert.throws(() => pins(/** @type {string} */ (stateDir)));

  const self = await sidecar.handle(intent('pinadmin', { email: 'ada@example.com', op: 'add' }));
  assert.equal(self.ok, true);
  const again = await sidecar.handle(intent('pinadmin', { email: 'ada@example.com', op: 'add' }));
  assert.match(again.text, /already pinned/);
  assert.deepEqual(pins(/** @type {string} */ (stateDir)), { admins: ['ada@example.com'] });

  const stranger = await sidecar.handle(intent('pinadmin', { email: 'cy@example.com', op: 'add' }, 'bea@example.com'));
  assert.equal(stranger.ok, false);
  assert.match(stranger.text, /bea@example.com is not a pinned admin/);
  const added = await sidecar.handle(intent('pinadmin', { email: 'bea@example.com', op: 'add' }));
  assert.match(added.text, /Pinned bea@example.com\. They can reboot, upgrade and update this machine/);
  assert.deepEqual(pins(/** @type {string} */ (stateDir)).admins, ['ada@example.com', 'bea@example.com']);

  const last = await sidecar.handle(intent('pinadmin', { email: 'ada@example.com', op: 'remove' }, 'bea@example.com'));
  assert.equal(last.ok, true, last.text);
  const stuck = await sidecar.handle(intent('pinadmin', { email: 'bea@example.com', op: 'remove' }, 'bea@example.com'));
  assert.equal(stuck.ok, false);
  assert.match(stuck.text, /last pinned admin cannot be removed/);
  assert.deepEqual(pins(/** @type {string} */ (stateDir)).admins, ['bea@example.com']);
});
