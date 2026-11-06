// WHICH KIND OF HYPERVISOR answers at an address, without asking the person.
// Asked for: "Instead of ask which kind detect don't ask question you can find
// the answer to". The probe a phone already sends (`xoprobe`) also looks at
// Proxmox VE's API port: true when the server says it is pve-api-daemon,
// false when something else answered there, null when nothing did.

import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { probePve } from '../src/fleet/host/xo-setup.js';
import { narrowProbe } from '../src/fleet/coordinator/core.js';

const skip = spawnSync('openssl', ['version']).status !== 0 && 'needs openssl to make a certificate';

/** A TLS server answering every request with these headers. @param {string} server */
async function answering(t, server) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pve-detect-'));
  assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '1', '-subj', '/CN=pve'], { cwd: dir }).status, 0);
  /** @type {string[]} */
  const asked = [];
  const srv = tls.createServer({ key: readFileSync(path.join(dir, 'k.pem')), cert: readFileSync(path.join(dir, 'c.pem')) }, (s) => {
    s.once('data', (d) => {
      asked.push(d.toString('latin1'));
      s.end(`HTTP/1.1 401 No ticket\r\nServer: ${server}\r\nContent-Length: 0\r\n\r\n`);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => srv.close());
  return { port: /** @type {import('node:net').AddressInfo} */ (srv.address()).port, asked };
}

test('Proxmox VE is told from what answers on its port, and nothing of anybody\'s is sent to find out', { skip }, async (t) => {
  const pve = await answering(t, 'pve-api-daemon/3.0');
  assert.equal(await probePve(`127.0.0.1:${pve.port}`, { timeoutMs: 3000 }), true);
  // ONE GET, of the version, with no token and no body.
  assert.equal(pve.asked.length, 1);
  assert.match(pve.asked[0], /^GET \/api2\/json\/version HTTP\/1\.1\r\n/);
  assert.ok(!/authorization|cookie|csrf/i.test(pve.asked[0]), pve.asked[0]);

  const other = await answering(t, 'nginx');
  assert.equal(await probePve(`127.0.0.1:${other.port}`, { timeoutMs: 3000 }), false);
  // NOTHING THERE is cannot tell, never "not Proxmox".
  assert.equal(await probePve('127.0.0.1:1', { timeoutMs: 2000 }), null);
});

test('the fleet passes the box\'s word on to the phone, and invents none', () => {
  assert.equal(narrowProbe({ reachable: false, pve: true }).pve, true);
  assert.equal(narrowProbe({ reachable: true, xo: true, pve: false }).pve, false);
  assert.ok(!('pve' in narrowProbe({ reachable: true, xo: true })), 'an older box did not look, and the phone is not told it did');
  assert.ok(!('pve' in narrowProbe({ reachable: true, pve: 'yes' })));
});
