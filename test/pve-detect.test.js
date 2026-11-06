// WHICH KIND OF HYPERVISOR answers at an address, without asking the person.
// Asked for: "Instead of ask which kind detect don't ask question you can find
// the answer to". The probe a phone already sends (`xoprobe`) also looks at
// Proxmox VE's API port: true when it takes a connection, null when nothing
// answered. A TCP look, as the phone's, with nothing sent and no TLS.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { probePve } from '../src/fleet/host/xo-setup.js';
import { narrowProbe } from '../src/fleet/coordinator/core.js';

test('Proxmox VE\'s port taking a connection is told, and nothing is sent to find out', async (t) => {
  /** @type {Buffer[]} */
  const heard = [];
  const srv = net.createServer((s) => s.on('data', (d) => heard.push(d)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => srv.close());
  const port = /** @type {import('node:net').AddressInfo} */ (srv.address()).port;
  assert.equal(await probePve(`127.0.0.1:${port}`, { timeoutMs: 3000 }), true);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(Buffer.concat(heard).length, 0, 'something was sent to find out');
  // NOTHING THERE is cannot tell, never "not Proxmox".
  assert.equal(await probePve('127.0.0.1:1', { timeoutMs: 2000 }), null);
  // 443 IS XEN ORCHESTRA'S, so an address naming it is looked at on 8006.
  assert.equal(await probePve('127.0.0.1:443', { timeoutMs: 1000 }), null);
});

test('the fleet passes the box\'s word on to the phone, and invents none', () => {
  assert.equal(narrowProbe({ reachable: false, pve: true }).pve, true);
  assert.equal(narrowProbe({ reachable: true, xo: true, pve: false }).pve, false);
  assert.ok(!('pve' in narrowProbe({ reachable: true, xo: true })), 'an older box did not look, and the phone is not told it did');
  assert.ok(!('pve' in narrowProbe({ reachable: true, pve: 'yes' })));
});
