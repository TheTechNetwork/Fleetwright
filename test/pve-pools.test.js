// The Proxmox driver (src/fleet/host/pve-pools.js) against a stand-in Proxmox
// over real TLS, with a certificate signed by a CA made for the run, so the
// trust the record carries is exercised and not assumed. docs/proxmox.md.
//
// What the stand-in cannot prove is that a live Proxmox answers these paths
// as it does; it answers them as Proxmox VE 8's API documentation has them,
// and the first run on a real cluster is listed in docs/proxmox.md as not done.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PveApi } from '../src/fleet/host/pve-api.js';
import {
  PvePools, parseConnection, pveRecord, markOf, markText, wideOf, pveIdOf, pveVendorConfig, pveBuildConfig,
  CONNECTION_PREFIX, PVE_FENCE_GROUP, PVE_ROLE_PRIVS, PVE_STORAGE_PRIVS, PVE_NET_PRIVS, PVE_ROOT_PRIVS,
} from '../src/fleet/host/pve-pools.js';
import { poolRecord } from '../src/fleet/host/xo-pools.js';
import { Pools } from '../src/fleet/host/pools.js';
import { DEBIAN_IMAGE } from '../src/fleet/host/vm-image.js';

const openssl = spawnSync('openssl', ['version']).status === 0;
const skip = !openssl && 'needs openssl to make certificates for the stand-in';
const OWNER = 'eli@example.com';
const TOKEN = 'fleetwright@pve!fleet=0b8e6f0e-6a3e-4c55-9f4c-7c5d2b1a9e01';
const TICKET = `fwt_0123456789ab_${'c'.repeat(48)}`;
const NOW = 1_800_000_000_000;

/** A CA and a leaf it signed, and a second CA nobody chose. */
function certificates() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pve-'));
  const run = (/** @type {string[]} */ args) => {
    const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const ca = (/** @type {string} */ n) => run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${n}.key`, '-out', `${n}.pem`, '-days', '1', '-subj', `/CN=${n}`]);
  ca('cluster');
  ca('other');
  const leaf = (/** @type {string} */ by) => {
    run(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${by}-leaf.key`, '-out', `${by}-leaf.csr`, '-subj', '/CN=pve1']);
    run(['x509', '-req', '-in', `${by}-leaf.csr`, '-CA', `${by}.pem`, '-CAkey', `${by}.key`, '-CAcreateserial', '-out', `${by}-leaf.pem`, '-days', '1']);
  };
  leaf('cluster');
  leaf('other');
  const f = (/** @type {string} */ n) => readFileSync(path.join(dir, n), 'utf8');
  return { ca: f('cluster.pem'), leaf: { key: f('cluster-leaf.key'), cert: f('cluster-leaf.pem') }, stranger: { key: f('other-leaf.key'), cert: f('other-leaf.pem') }, strangerRoot: f('other.pem') };
}

/**
 * A Proxmox with one node, a pool, a template, and whatever VMs a test puts
 * in it. `asked` is every request, `authorized` whether any carried a token.
 */
async function standIn({ cert, firewall = true, perms = null } = /** @type {any} */ ({})) {
  const state = {
    authorized: 0,
    /** @type {string[]} */ asked: [],
    nextid: 200,
    firewall,
    /** @type {Map<number, any>} */ vms: new Map([
      [100, { vmid: 100, node: 'pve1', name: 'fleetwright-debian-13', template: 1, tags: 'fleetwright-image', status: 'stopped', config: { meta: 'creation-qemu=9.0.2,ctime=1790000000', net0: 'virtio=BC:24:11:00:00:01,bridge=vmbr0,firewall=1', smbios1: 'uuid=11111111-2222-3333-4444-555555555555' } }],
    ]),
    perms: perms ?? {
      '/pool/fleetwright': Object.fromEntries(PVE_ROLE_PRIVS.map((p) => [p, 1])),
      '/storage/local-lvm': { 'Datastore.AllocateSpace': 1, 'Datastore.Audit': 1 },
      '/sdn/zones/localnetwork/vmbr1': { 'SDN.Use': 1 },
      '/': { 'Sys.Audit': 1 },
    },
    /** @type {any[]} */ rules: [],
  };
  const upid = (/** @type {string} */ what) => `UPID:pve1:0000ABCD:00000001:6700000:${what}:100:fleetwright@pve!fleet:`;
  const server = https.createServer(cert, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers.authorization === `PVEAPIToken=${TOKEN}`) state.authorized++;
      const url = new URL(req.url ?? '/', 'https://pve1');
      const p = url.pathname.replace(/^\/api2\/json/, '');
      const params = Object.fromEntries(new URLSearchParams(req.method === 'GET' || req.method === 'DELETE' ? url.search : body));
      state.asked.push(`${req.method} ${p}`);
      const ok = (/** @type {any} */ data) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
      const vmAt = /^\/nodes\/pve1\/qemu\/(\d+)(\/.*)?$/.exec(p);
      if (p === '/access/permissions') return ok(state.perms);
      if (p === '/version') return ok({ version: '8.2.4' });
      if (p === '/pools/fleetwright') return ok({ members: [...state.vms.values()].map((v) => ({ type: 'qemu', vmid: v.vmid, node: v.node, name: v.name, template: v.template, tags: v.tags, status: v.status })) });
      if (p === '/cluster/firewall/options') return ok({ enable: state.firewall ? 1 : 0 });
      if (p === '/cluster/firewall/groups') return ok([{ group: PVE_FENCE_GROUP }]);
      if (p === '/cluster/nextid') return ok(String(state.nextid++));
      if (p.startsWith('/nodes/pve1/tasks/')) return ok({ status: 'stopped', exitstatus: 'OK' });
      if (vmAt) {
        const v = state.vms.get(Number(vmAt[1]));
        const rest = vmAt[2] ?? '';
        if (!v) return res.writeHead(500, `VM ${vmAt[1]} does not exist`).end();
        if (rest === '/clone' && req.method === 'POST') {
          const id = Number(params.newid);
          state.vms.set(id, { vmid: id, node: 'pve1', name: params.name, template: 0, tags: '', status: 'stopped', config: { ...v.config, description: params.description, smbios1: 'uuid=99999999-8888-7777-6666-555555555555' } });
          return ok(upid('qmclone'));
        }
        if (rest === '/config' && req.method === 'GET') return ok({ ...v.config, name: v.name });
        // PUT only: Proxmox's POST here queues a task, and the driver must not
        // read its 200 as done.
        if (rest === '/config' && req.method === 'PUT') {
          if (params.tags !== undefined) v.tags = params.tags;
          Object.assign(v.config, params);
          return ok(null);
        }
        if (rest === '/firewall/options') return (v.firewall = params), ok(null);
        if (rest === '/firewall/rules') return state.rules.push({ vmid: v.vmid, ...params }), ok(null);
        if (rest === '/status/start') return (v.status = 'running'), ok(upid('qmstart'));
        if (rest === '/status/stop') return (v.status = 'stopped'), ok(upid('qmstop'));
        if (rest === '/status/shutdown') return (v.status = 'stopped'), ok(upid('qmshutdown'));
        if (rest === '' && req.method === 'DELETE') return state.vms.delete(v.vmid), ok(upid('qmdestroy'));
      }
      res.writeHead(501, `the stand-in has no ${req.method} ${p}`).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  return { state, address: `127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r(null)); }) };
}

/** @param {string} address @param {string} ca */
const recordFor = (address, ca) => ({ kind: 'proxmox', address, token: TOKEN, pool: 'fleetwright', ca });
/** @param {any} record */
const vaultWith = (record, extra = []) => [{ email: OWNER, items: [{ name: `hypervisor:${record.address}`, value: JSON.stringify(record) }, { name: 'claude', value: 'sk-ant-oat01-' + 'x'.repeat(40) }, ...extra] }];
const fast = { sleep: async () => {} };

test('a cluster is trusted by its own CA, and a server another CA signed is never sent the token', { skip }, async () => {
  const certs = certificates();
  const real = await standIn({ cert: certs.leaf });
  const fake = await standIn({ cert: certs.stranger });
  try {
    const good = new PveApi({ address: real.address, token: TOKEN, trust: { ca: certs.ca } });
    assert.equal((await good.get('/version')).version, '8.2.4');
    const bad = new PveApi({ address: fake.address, token: TOKEN, trust: { ca: certs.ca } });
    await assert.rejects(bad.get('/version'), /this cluster's CA did not sign/);
    assert.equal(fake.state.authorized, 0, 'the token reached a server the cluster did not vouch for');
    assert.deepEqual(fake.state.asked, []);
    // A CERTIFICATE OF SOMEBODY'S OWN is reached by handing over its file with
    // its root, as the setup does, and still with the chain checked.
    const own = new PveApi({ address: fake.address, token: TOKEN, trust: { ca: certs.stranger.cert + certs.strangerRoot } });
    assert.equal((await own.get('/version')).version, '8.2.4');
  } finally {
    await real.close();
    await fake.close();
  }
});

test('the line the setup prints is a record the vault keeps; one that says no way to trust the server is none', () => {
  const ca = '-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(120) + '\n-----END CERTIFICATE-----\n';
  const rec = recordFor('pve.lan:8006', ca);
  const line = CONNECTION_PREFIX + Buffer.from(JSON.stringify(rec)).toString('base64url');
  assert.deepEqual(parseConnection(line), { address: 'pve.lan:8006', token: TOKEN, pool: 'fleetwright', ca, trust: 'ca' });
  assert.ok(pveRecord('hypervisor:pve.lan:8006', JSON.stringify(rec)));
  const { ca: _, ...untrusted } = rec;
  assert.equal(parseConnection(CONNECTION_PREFIX + Buffer.from(JSON.stringify(untrusted)).toString('base64url')), null);
  // NOR IS A PIN ALONE: reaching it would mean turning the chain check off.
  assert.equal(parseConnection(CONNECTION_PREFIX + Buffer.from(JSON.stringify({ ...untrusted, pin: 'a'.repeat(64) })).toString('base64url')), null);
  // XEN ORCHESTRA'S DRIVER passes over it, rather than dial a WebSocket at Proxmox.
  assert.equal(poolRecord('hypervisor:pve.lan:8006', JSON.stringify({ ...rec, pin: 'a'.repeat(64) })), null);
});

test('a machine is cloned into the pool with its join in its SMBIOS, put behind the fence, and started', { skip }, async () => {
  const certs = certificates();
  const pve = await standIn({ cert: certs.leaf });
  try {
    const pools = new PvePools({ now: () => NOW, ...fast });
    pools.adopt(vaultWith(recordFor(pve.address, certs.ca), [{ name: 'secret:SSH_AUTHORIZED_KEYS', value: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq eli@laptop' }]));
    await pools.refresh();
    const [seen] = pools.report();
    assert.equal(seen.reachable, true);
    assert.equal(seen.fenced, true);
    assert.deepEqual(seen.wide, []);
    const image = seen.images[0];
    assert.match(image.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(seen.networks.map((/** @type {any} */ n) => n.name), ['vmbr1']);

    const r = await pools.make({ owner: OWNER, template: image.id, ticket: TICKET, minutes: 90, coordinatorUrl: 'https://fleet.example.com/x' });
    assert.equal(r.ok, true, r.text);
    const vm = pve.state.vms.get(200);
    assert.equal(vm.name, 'vm-0123456789ab');
    assert.equal(vm.status, 'running');
    assert.equal(vm.tags, 'fleetwright-session');
    // ITS OWN UUID KEPT, and the join readable as the guest reads its serial.
    assert.match(vm.config.smbios1, /^uuid=99999999-8888-7777-6666-555555555555,base64=1,serial=/);
    const join = JSON.parse(Buffer.from(/serial=([^,]+)/.exec(vm.config.smbios1)?.[1] ?? '', 'base64').toString('utf8'));
    assert.deepEqual({ coordinator: join.coordinator, ticket: join.ticket, owner: join.owner }, { coordinator: 'https://fleet.example.com', ticket: TICKET, owner: OWNER });
    assert.equal(decodeURIComponent(vm.config.sshkeys), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq eli@laptop');
    assert.match(vm.config.net0, /bridge=vmbr0/);
    assert.match(vm.config.net0, /firewall=1/);
    assert.deepEqual(pve.state.rules, [{ vmid: 200, type: 'group', action: PVE_FENCE_GROUP, enable: '1' }]);
    const mark = markOf(vm.config.description);
    assert.equal(mark?.for, OWNER);
    assert.equal(mark?.until, NOW / 1000 + 90 * 60);
    assert.ok(!JSON.stringify(vm.config).includes('sk-ant-'), 'the Claude login went on the machine');
  } finally {
    await pve.close();
  }
});

test('with the datacenter firewall off, no machine is made where it would reach the person’s network unasked', { skip }, async () => {
  const certs = certificates();
  const pve = await standIn({ cert: certs.leaf, firewall: false });
  try {
    const pools = new PvePools({ now: () => NOW, ...fast });
    pools.adopt(vaultWith(recordFor(pve.address, certs.ca)));
    await pools.refresh();
    const [seen] = pools.report();
    assert.equal(seen.fenced, false);
    const r = await pools.make({ owner: OWNER, template: seen.images[0].id, ticket: TICKET, coordinatorUrl: 'https://fleet.example.com' });
    assert.equal(r.ok, false);
    assert.match(r.text, /firewall is off/);
    assert.ok(!pve.state.asked.some((a) => a.endsWith('/clone')), 'a clone was made anyway');
    // ON A NETWORK THE PERSON CHOSE, it is made, on that bridge.
    const chosen = await pools.make({ owner: OWNER, template: seen.images[0].id, ticket: TICKET, network: seen.networks[0].id, coordinatorUrl: 'https://fleet.example.com' });
    assert.equal(chosen.ok, true, chosen.text);
    assert.match(pve.state.vms.get(200).config.net0, /bridge=vmbr1/);
    assert.deepEqual(pve.state.rules, []);
  } finally {
    await pve.close();
  }
});

test('the sweep removes a machine past its end, and leaves a VM somebody named like one but the fleet did not mark', { skip }, async () => {
  const certs = certificates();
  const pve = await standIn({ cert: certs.leaf });
  const made = NOW / 1000 - 3 * 3600;
  pve.state.vms.set(300, { vmid: 300, node: 'pve1', name: 'vm-aaaaaaaaaaaa', template: 0, tags: 'fleetwright-session', status: 'running', config: { description: markText({ for: OWNER, until: made + 3600, made }) } });
  pve.state.vms.set(301, { vmid: 301, node: 'pve1', name: 'vm-bbbbbbbbbbbb', template: 0, tags: 'fleetwright-session', status: 'stopped', config: { description: 'mine, leave it' } });
  pve.state.vms.set(302, { vmid: 302, node: 'pve1', name: 'vm-cccccccccccc', template: 0, tags: 'fleetwright-session', status: 'running', config: { description: markText({ for: OWNER, until: NOW / 1000 + 3600, made: NOW / 1000 - 60 }) } });
  try {
    const pools = new PvePools({ now: () => NOW, ...fast });
    pools.adopt(vaultWith(recordFor(pve.address, certs.ca)));
    await pools.refresh();
    assert.deepEqual([...pve.state.vms.keys()].sort(), [100, 301, 302]);
    // CLEANLY, so it says goodbye and is retired at once (#1532), not cut off.
    assert.ok(pve.state.asked.includes('POST /nodes/pve1/qemu/300/status/shutdown'));
    assert.ok(!pve.state.asked.includes('POST /nodes/pve1/qemu/300/status/stop'));
    assert.deepEqual(pools.report()[0].machines.map((/** @type {any} */ m) => m.name), ['vm-cccccccccccc']);
  } finally {
    await pve.close();
  }
});

test('the Claude login is handed once, sealed, to a running machine marked as the person’s, and to nothing else', { skip }, async () => {
  const certs = certificates();
  const pve = await standIn({ cert: certs.leaf });
  pve.state.vms.set(302, { vmid: 302, node: 'pve1', name: 'vm-cccccccccccc', template: 0, tags: 'fleetwright-session', status: 'running', config: { description: markText({ for: OWNER, until: NOW / 1000 + 3600, made: NOW / 1000 - 60 }) } });
  pve.state.vms.set(303, { vmid: 303, node: 'pve1', name: 'vm-dddddddddddd', template: 0, tags: 'fleetwright-session', status: 'running', config: { description: markText({ for: 'someone@else.com', until: NOW / 1000 + 3600, made: NOW / 1000 - 60 }) } });
  try {
    const pools = new PvePools({ now: () => NOW, ...fast });
    pools.adopt(vaultWith(recordFor(pve.address, certs.ca)));
    // The key a machine sends: a raw P-256 public key, as seal.js takes one.
    const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']));
    const key = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    const first = await pools.handLogin({ owner: OWNER, name: 'vm-cccccccccccc', key });
    assert.equal(first.ok, true, first.text);
    assert.ok(first.sealed && !JSON.stringify(first.sealed).includes('sk-ant-'));
    assert.equal((await pools.handLogin({ owner: OWNER, name: 'vm-cccccccccccc', key })).ok, false);
    const theirs = await pools.handLogin({ owner: OWNER, name: 'vm-dddddddddddd', key });
    assert.equal(theirs.ok, false);
    assert.equal(theirs.notHere, true);
  } finally {
    await pve.close();
  }
});

test('a token that can do more than the fleet needs is reported, by path and privilege', () => {
  const wide = wideOf({
    '/pool/fleetwright': { 'VM.Allocate': 1, 'VM.Clone': 1 },
    '/': { 'Sys.Audit': 1, 'Permissions.Modify': 1, 'Sys.Modify': 1 },
    '/vms/104': { 'VM.Console': 1 },
  }, 'fleetwright');
  assert.deepEqual(wide, [{ path: '/', privs: ['Permissions.Modify', 'Sys.Modify'] }, { path: '/vms/104', privs: ['VM.Console'] }]);
});

test('Proxmox records go to the Proxmox driver and out of the hub’s bundle, and its images are made there', { skip }, async () => {
  const certs = certificates();
  const pve = await standIn({ cert: certs.leaf });
  try {
    const pools = new Pools({ pve: new PvePools({ now: () => NOW, ...fast }) });
    const stripped = pools.adopt(vaultWith(recordFor(pve.address, certs.ca)));
    assert.deepEqual(stripped[0].items.map((/** @type {any} */ i) => i.name), ['claude']);
    assert.equal(pools.xo.held.size, 0);
    assert.equal(pools.held.size, 1);
    await pools.refresh();
    const image = pools.report()[0].images[0];
    const r = await pools.make({ owner: OWNER, template: image.id, ticket: TICKET, coordinatorUrl: 'https://fleet.example.com' });
    assert.equal(r.ok, true, r.text);
  } finally {
    await pve.close();
  }
});

// THE SCRIPT HAS NO FLEETWRIGHT TO IMPORT FROM, so what it embeds is held to
// the code that relies on it: the snippets a clone boots with, every privilege
// the width check allows, and the pinned image.
test('the setup script embeds the snippets, privileges and image the driver expects', () => {
  const script = readFileSync(new URL('../install/fleetwright-pve-setup', import.meta.url), 'utf8');
  const heredoc = (/** @type {string} */ tag) => {
    const m = new RegExp(`<<'${tag}'[^\\n]*\\n([\\s\\S]*?)\\n${tag}\\n`).exec(script);
    assert.ok(m, `no ${tag} heredoc`);
    return `${m[1]}\n`;
  };
  assert.equal(heredoc('VENDOR'), pveVendorConfig());
  assert.equal(heredoc('BUILD'), pveBuildConfig());
  const privs = (/** @type {string} */ v) => /** @type {string} */ (new RegExp(`^${v}="([^"]+)"`, 'm').exec(script)?.[1]).split(' ');
  assert.deepEqual(privs('ROLE_PRIVS'), [...PVE_ROLE_PRIVS]);
  assert.deepEqual(privs('STORAGE_PRIVS'), [...PVE_STORAGE_PRIVS]);
  assert.deepEqual(privs('NET_PRIVS'), [...PVE_NET_PRIVS]);
  assert.deepEqual(privs('ROOT_PRIVS'), [...PVE_ROOT_PRIVS]);
  // Whole lines compared as text: a URL made into a pattern is a pattern of
  // whatever characters the URL happens to hold.
  const lines = script.split('\n');
  assert.ok(lines.includes(`IMAGE_URL=${DEBIAN_IMAGE.url}`), 'the script downloads another image');
  assert.ok(lines.includes(`IMAGE_SHA512=${DEBIAN_IMAGE.sha512}`), 'the script checks another digest');
  assert.equal(spawnSync('bash', ['-n', fileURLToPathSafe('../install/fleetwright-pve-setup')]).status, 0);
});

/** @param {string} rel */
function fileURLToPathSafe(rel) {
  return new URL(rel, import.meta.url).pathname;
}

test('ids are UUIDs that tell two templates under one number apart', () => {
  const a = pveIdOf('pve.lan:8006', 'image', '100:1790000000');
  const b = pveIdOf('pve.lan:8006', 'image', '100:1790000001');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});
