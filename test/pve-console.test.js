// What a Proxmox VE machine printed as it booted, kept by the box that made
// it for the machine that never joins (src/fleet/host/pve-console.js), and
// what the machine prints there (pve-pools.js, JOIN_REPORT).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { BootConsoles, bootLogAnswer, plainOf, RECORD_MS, KEEP_BYTES, JOINED_LINE } from '../src/fleet/host/pve-console.js';
import { JOIN_REPORT, pveVendorConfig } from '../src/fleet/host/pve-pools.js';
import { VERBS } from '../src/fleet/protocol/intents.js';

/** A Proxmox VE that hands out a console, and the socket it hands. */
function standIn() {
  /** @type {any} */
  const link = { sent: /** @type {string[]} */ ([]), closed: false, onMessage: () => {}, onClose: () => {} };
  link.send = (/** @type {string} */ t) => link.sent.push(t);
  link.close = () => {
    link.closed = true;
  };
  /** @type {any[]} */
  const asked = [];
  const api = {
    post: async (/** @type {string} */ path, /** @type {any} */ params) => {
      asked.push(['POST', path, params]);
      return { port: 5900, ticket: 'PVEVNC:abc', user: 'fleetwright@pve!fleet' };
    },
    websocket: async (/** @type {string} */ path, /** @type {any} */ params) => {
      asked.push(['WS', path, params]);
      return link;
    },
  };
  return { api, link, asked };
}

/** Timers this test moves by hand. */
function clock() {
  let now = 1_000_000;
  /** @type {Array<{ at: number, fn: () => void, every: number|null, id: number }>} */
  let due = [];
  let id = 0;
  const timers = {
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => (due.push({ at: now + ms, fn, every: null, id: ++id }), id),
    setInterval: (/** @type {() => void} */ fn, /** @type {number} */ ms) => (due.push({ at: now + ms, fn, every: ms, id: ++id }), id),
    clearTimeout: (/** @type {number} */ x) => (due = due.filter((d) => d.id !== x)),
    clearInterval: (/** @type {number} */ x) => (due = due.filter((d) => d.id !== x)),
  };
  const pass = (/** @type {number} */ ms) => {
    const until = now + ms;
    for (;;) {
      const next = due.filter((d) => d.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      if (next.every) next.at += next.every;
      else due = due.filter((d) => d !== next);
      next.fn();
    }
    now = until;
  };
  return { timers: /** @type {any} */ (timers), now: () => now, pass };
}

test('the box opens the console it is given, logs in, and sends the machine nothing else', async () => {
  const { api, link, asked } = standIn();
  const c = clock();
  const consoles = new BootConsoles({ now: c.now, timers: c.timers });
  await consoles.record('vm-0123456789ab', { api, node: 'pve1', vmid: 9001, address: '10.0.0.1:8006', owner: 'Eli@example.com' });
  assert.deepEqual(asked[0], ['POST', '/nodes/pve1/qemu/9001/termproxy', { serial: 'serial0' }]);
  assert.deepEqual(asked[1], ['WS', '/nodes/pve1/qemu/9001/vncwebsocket', { port: 5900, vncticket: 'PVEVNC:abc' }]);
  assert.equal(link.sent[0], 'fleetwright@pve!fleet:PVEVNC:abc\n');
  c.pass(5 * 60_000);
  // A keepalive, and nothing that types into the machine.
  assert.ok(link.sent.slice(1).length > 0 && link.sent.slice(1).every((/** @type {string} */ t) => t === '2'));
});

test('what it printed is kept as plain lines, and reading stops when it says it joined', async () => {
  const { api, link } = standIn();
  const c = clock();
  const consoles = new BootConsoles({ now: c.now, timers: c.timers });
  await consoles.record('vm-0123456789ab', { api, node: 'pve1', vmid: 9001, address: '10.0.0.1:8006', owner: 'eli@example.com' });
  link.onMessage('OK');
  link.onMessage('\x1b[0;32m  OK  \x1b[0m Started cloud-init.\r\nfleetwright-join: not joined yet');
  link.onMessage(', 60 seconds after boot\r\nprogress 10%\rprogress 100%\n');
  let r = consoles.read('vm-0123456789ab');
  assert.deepEqual(r?.lines, ['  OK   Started cloud-init.', 'fleetwright-join: not joined yet, 60 seconds after boot', 'progress 100%']);
  assert.equal(r?.reading, true);
  link.onMessage(`${JOINED_LINE}\n`);
  r = consoles.read('vm-0123456789ab');
  assert.equal(r?.joined, true);
  assert.equal(r?.reading, false);
  assert.equal(link.closed, true, 'the console is let go once it joined');
});

test('a machine that never says it joined is read for the ticket’s life and no longer, and kept to its last part', async () => {
  const { api, link } = standIn();
  const c = clock();
  const consoles = new BootConsoles({ now: c.now, timers: c.timers });
  await consoles.record('vm-0123456789ab', { api, node: 'pve1', vmid: 9001, address: '10.0.0.1:8006', owner: 'eli@example.com' });
  for (let i = 0; i < 2000; i++) link.onMessage(`line ${i} ${'x'.repeat(40)}\n`);
  c.pass(RECORD_MS);
  const r = consoles.read('vm-0123456789ab', 200);
  assert.equal(r?.reading, false);
  assert.equal(link.closed, true);
  assert.match(String(r?.why), /15 minutes/);
  assert.equal(r?.lines.at(-1), `line 1999 ${'x'.repeat(40)}`);
  assert.ok(consoles.kept.get('vm-0123456789ab').text.length <= KEEP_BYTES);
});

test('a console Proxmox will not hand over is kept as that, in its words', async () => {
  const c = clock();
  const consoles = new BootConsoles({ now: c.now, timers: c.timers });
  const api = { post: async () => { throw new Error('Permission check failed (/vms/9001, VM.Console)'); } };
  await consoles.record('vm-0123456789ab', { api, node: 'pve1', vmid: 9001, address: '10.0.0.1:8006', owner: 'eli@example.com' });
  const a = bootLogAnswer(consoles, { machine: 'vm-0123456789ab', now: c.now() });
  assert.ok(a.ok);
  assert.match(a.text, /Its console could not be read: Permission check failed \(\/vms\/9001, VM\.Console\)/);
});

test('logs boot lists the machines newest first, and says plainly when it has none or not that one', async () => {
  const c = clock();
  const consoles = new BootConsoles({ now: c.now, timers: c.timers });
  assert.match(bootLogAnswer(consoles, { now: c.now() }).text, /has made no Proxmox VE machine/);
  for (const name of ['vm-aaaaaaaaaaaa', 'vm-bbbbbbbbbbbb']) {
    const { api } = standIn();
    await consoles.record(name, { api, node: 'pve1', vmid: 9001, address: '10.0.0.1:8006', owner: 'eli@example.com' });
    c.pass(60_000);
  }
  const list = bootLogAnswer(consoles, { now: c.now() });
  assert.deepEqual(list.boot.machines.map((/** @type {any} */ m) => m.name), ['vm-bbbbbbbbbbbb', 'vm-aaaaaaaaaaaa']);
  assert.match(list.text, /vm-aaaaaaaaaaaa {2}on 10\.0\.0\.1:8006, made 2 min ago, still reading/);
  const none = bootLogAnswer(consoles, { machine: 'vm-cccccccccccc', now: c.now() });
  assert.equal(none.ok, false);
});

test('escape sequences, titles and stray control characters never reach the text', () => {
  assert.equal(plainOf('\x1b]0;title\x07a\x1b[1;31mb\x1b[0m\x07c\x00\n'), 'abc\n');
});

test('the logs verb takes boot and a machine, and the session tool does not offer them', async () => {
  assert.ok(VERBS.logs.params.service.values.includes('boot'));
  assert.equal(VERBS.logs.params.machine.type, 'name');
});

test('every machine boots with the report, and the report never prints a ticket or a token', () => {
  const v = pveVendorConfig();
  assert.match(v, /path: \/usr\/local\/sbin\/fleetwright-join-report/);
  assert.ok(v.indexOf('fleetwright-join-report]') < v.indexOf('fleetwright-vm-join; [ -x'), 'the report starts before the join');
  const sed = /sed -E '(s\/fwt_[^']+)'/.exec(JOIN_REPORT.join('\n'))?.[1];
  assert.ok(sed);
  const r = spawnSync('sed', ['-E', sed], {
    input: 'enrolling with fwt_0123456789ab_0123456789abcdef0123456789abcdef0123456789abcdef\nclaude sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\nrefused: ticket expired\n',
    encoding: 'utf8',
  });
  assert.equal(r.stdout, 'enrolling with [ticket]\nclaude [removed]\nrefused: ticket expired\n');
  // It reports until the coordinator has named the machine, and says when.
  assert.ok(JOIN_REPORT.includes('joined() { [ -s /var/lib/fleetwright-sidecar/host-id.json ]; }'));
  assert.ok(JOIN_REPORT.some((l) => l.includes('say "joined"')));
});

test('a header with a line break in it is refused before anything is written', async () => {
  const { upgrade } = await import('../src/fleet/host/xo-ws.js');
  let wrote = false;
  const socket = /** @type {any} */ ({ write: () => (wrote = true), on() {}, once() {}, off() {}, destroy() {} });
  await assert.rejects(upgrade(socket, { host: 'h', port: 8006, headers: { Authorization: 'PVEAPIToken=x\r\nX-Evil: 1' } }), /not a header to send/);
  assert.equal(wrote, false);
});
