// The Proxmox driver (src/fleet/host/pve-pools.js) against a stand-in Proxmox
// over real TLS, with a certificate signed by a CA made for the run, so the
// trust the record carries is exercised and not assumed. docs/proxmox.md.
//
// What the stand-in cannot prove is that a live Proxmox answers these paths
// as it does; it answers them as Proxmox VE 9's API documentation has them,
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
import { REQUIRED_HOSTS } from '../src/core/egress.js';

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
async function standIn({ cert, firewall = true, perms = null, version = '9.0.3' } = /** @type {any} */ ({})) {
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
      '/sdn/zones/fwgrp/fwgrp1': { 'SDN.Use': 1, 'SDN.Audit': 1 },
      '/sdn/zones/fwlab/fwlab1': { 'SDN.Use': 1, 'SDN.Audit': 1 },
      '/sdn/zones/fwlab/fwlab2': { 'SDN.Use': 1, 'SDN.Audit': 1 },
      '/': { 'Sys.Audit': 1 },
    },
    /** @type {any[]} */ rules: [],
    /** @type {Record<number, string[]>} */ ipsets: {},
    vnets: [
      { vnet: 'fwgrp1', zone: 'fwgrp', alias: 'fleetwright-group' },
      { vnet: 'fwlab1', zone: 'fwlab', alias: 'fleetwright-lab:open' },
      { vnet: 'fwlab2', zone: 'fwlab', alias: 'fleetwright-lab:closed' },
    ],
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
      if (p === '/version') return ok({ version });
      if (p === '/pools/fleetwright') return ok({ members: [...state.vms.values()].map((v) => ({ type: 'qemu', vmid: v.vmid, node: v.node, name: v.name, template: v.template, tags: v.tags, status: v.status })) });
      if (p === '/cluster/firewall/options') return ok({ enable: state.firewall ? 1 : 0 });
      if (p === '/cluster/firewall/groups') return ok([{ group: PVE_FENCE_GROUP }]);
      if (p === '/cluster/nextid') return ok(String(state.nextid++));
      if (p === '/cluster/sdn/vnets') return ok(state.vnets);
      const subnets = /^\/cluster\/sdn\/vnets\/fwlab(\d)\/subnets$/.exec(p);
      if (subnets) return ok([{ subnet: `fwlab-10.250.${subnets[1]}.0-24`, gateway: `10.250.${subnets[1]}.1` }]);
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
        if (rest === '/firewall/ipset') return (state.ipsets[v.vmid] = []), ok(null);
        if (rest === '/firewall/ipset/fwallow' && req.method === 'GET') return ok((state.ipsets[v.vmid] ?? []).map((cidr) => ({ cidr })));
        if (rest === '/firewall/ipset/fwallow') return (state.ipsets[v.vmid] ??= []).push(params.cidr), ok(null);
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
    assert.equal((await good.get('/version')).version, '9.0.3');
    const bad = new PveApi({ address: fake.address, token: TOKEN, trust: { ca: certs.ca } });
    await assert.rejects(bad.get('/version'), /this cluster's CA did not sign/);
    assert.equal(fake.state.authorized, 0, 'the token reached a server the cluster did not vouch for');
    assert.deepEqual(fake.state.asked, []);
    // A CERTIFICATE OF SOMEBODY'S OWN is reached by handing over its file with
    // its root, as the setup does, and still with the chain checked.
    const own = new PveApi({ address: fake.address, token: TOKEN, trust: { ca: certs.stranger.cert + certs.strangerRoot } });
    assert.equal((await own.get('/version')).version, '9.0.3');
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
    assert.deepEqual(seen.networks.map((/** @type {any} */ n) => [n.name, n.group, n.lab ?? null]), [['fwgrp1', true, null], ['fwlab1', false, 'open'], ['fwlab2', false, 'closed'], ['vmbr1', false, null]]);

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
    assert.deepEqual(pve.state.rules, [{ vmid: 200, type: 'group', action: PVE_FENCE_GROUP, pos: '0', enable: '1' }]);
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
    const chosen = await pools.make({ owner: OWNER, template: seen.images[0].id, ticket: TICKET, network: seen.networks.find((/** @type {any} */ n) => n.name === 'vmbr1').id, coordinatorUrl: 'https://fleet.example.com' });
    assert.equal(chosen.ok, true, chosen.text);
    assert.match(pve.state.vms.get(200).config.net0, /bridge=vmbr1/);
    assert.deepEqual(pve.state.rules, []);
  } finally {
    await pve.close();
  }
});

test('a cluster older than Proxmox VE 9 is reported as such, and no machine is made on it', { skip }, async () => {
  const certs = certificates();
  const pve = await standIn({ cert: certs.leaf, version: '8.4.1' });
  try {
    const pools = new PvePools({ now: () => NOW, ...fast });
    pools.adopt(vaultWith(recordFor(pve.address, certs.ca)));
    await pools.refresh();
    const [seen] = pools.report();
    assert.equal(seen.supported, false);
    const r = await pools.make({ owner: OWNER, template: seen.images[0].id, ticket: TICKET, coordinatorUrl: 'https://fleet.example.com' });
    assert.equal(r.ok, false);
    assert.match(r.text, /runs Proxmox VE 8\.4\.1/);
    assert.ok(!pve.state.asked.some((a) => a.endsWith('/clone')), 'a clone was made on an unsupported cluster');
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

test('a machine is given longer from when it was made, refused past the cap, and ended with a clean shutdown', { skip }, async () => {
  const certs = certificates();
  const pve = await standIn({ cert: certs.leaf });
  const made = NOW / 1000 - 60;
  pve.state.vms.set(302, { vmid: 302, node: 'pve1', name: 'vm-cccccccccccc', template: 0, tags: 'fleetwright-session', status: 'running', config: { description: markText({ for: OWNER, until: made + 3600, made }) } });
  try {
    const pools = new PvePools({ now: () => NOW, ...fast });
    pools.adopt(vaultWith(recordFor(pve.address, certs.ca)));
    const hour = await pools.control({ owner: OWNER, name: 'vm-cccccccccccc', action: 'extend', minutes: 60 });
    assert.equal(hour.ok, true, hour.text);
    assert.equal(hour.until, (made + 7200) * 1000);
    const cap = await pools.control({ owner: OWNER, name: 'vm-cccccccccccc', action: 'extend', minutes: 400 });
    assert.equal(cap.ok, true, cap.text);
    assert.equal(cap.until, (made + 350 * 60) * 1000);
    const past = await pools.control({ owner: OWNER, name: 'vm-cccccccccccc', action: 'extend', minutes: 60 });
    assert.equal(past.ok, false);
    assert.match(past.text, /longest a machine can/);
    const end = await pools.control({ owner: OWNER, name: 'vm-cccccccccccc', action: 'stop' });
    assert.equal(end.ok, true, end.text);
    assert.ok(pve.state.asked.includes('POST /nodes/pve1/qemu/302/status/shutdown'));
    assert.ok(!pve.state.asked.includes('POST /nodes/pve1/qemu/302/status/stop'));
  } finally {
    await pve.close();
  }
});

test('a machine in a group gets a second interface at its own address, let through before the fence', { skip }, async () => {
  const certs = certificates();
  const pve = await standIn({ cert: certs.leaf });
  try {
    const pools = new PvePools({ now: () => NOW, ...fast });
    pools.adopt(vaultWith(recordFor(pve.address, certs.ca)));
    await pools.refresh();
    const [seen] = pools.report();
    const grp = seen.networks.find((/** @type {any} */ n) => n.group);
    assert.equal(grp?.name, 'fwgrp1');
    const r = await pools.make({ owner: OWNER, template: seen.images[0].id, ticket: TICKET, group: grp.id, coordinatorUrl: 'https://fleet.example.com' });
    assert.equal(r.ok, true, r.text);
    const vm = pve.state.vms.get(200);
    assert.match(vm.config.net1, /^virtio=02:01:23:45:67:89,bridge=fwgrp1,firewall=1$/);
    assert.match(vm.config.ipconfig1, /^ip=10\.200\.\d+\.\d+\/16$/);
    assert.deepEqual(pve.state.rules.map((/** @type {any} */ x) => [x.pos, x.type, x.iface ?? x.action]), [['0', 'in', 'net1'], ['1', 'out', 'net1'], ['2', 'group', PVE_FENCE_GROUP]]);
    const mark = markOf(vm.config.description);
    assert.equal(mark?.grp, 'fwgrp1');
    assert.equal(`ip=${mark?.gip}/16`, vm.config.ipconfig1);
  } finally {
    await pve.close();
  }
});

test('a closed lab machine is alone on its lab, asks only its gateway for names, and reaches only the fleet and Claude', { skip }, async () => {
  const certs = certificates();
  const pve = await standIn({ cert: certs.leaf });
  /** @type {string[]} */
  const asked = [];
  try {
    const pools = new PvePools({ now: () => NOW, ...fast, resolve: async (h) => (asked.push(h), h === 'fleet.example.com' ? ['203.0.113.7'] : ['198.51.100.9']) });
    pools.adopt(vaultWith(recordFor(pve.address, certs.ca)));
    await pools.refresh();
    const [seen] = pools.report();
    const closed = seen.networks.find((/** @type {any} */ n) => n.lab === 'closed');
    assert.equal(closed?.name, 'fwlab2');
    assert.equal(closed?.taken, false);
    const r = await pools.make({ owner: OWNER, template: seen.images[0].id, ticket: TICKET, lab: true, network: closed.id, coordinatorUrl: 'https://fleet.example.com' });
    assert.equal(r.ok, true, r.text);
    const vm = pve.state.vms.get(200);
    assert.match(vm.config.net0, /bridge=fwlab2/);
    assert.equal(vm.firewall.policy_out, 'DROP');
    assert.deepEqual(pve.state.rules.map((/** @type {any} */ x) => [x.type, x.proto ?? '', x.dport ?? '', x.dest ?? '']), [
      ['out', 'udp', '67:68', ''],
      ['out', 'udp', '53', '10.250.2.1'],
      ['out', 'tcp', '53', '10.250.2.1'],
      ['out', 'tcp', '443', '+guest/fwallow'],
    ]);
    assert.ok(!pve.state.rules.some((/** @type {any} */ x) => x.type === 'group'), 'a closed lab went behind the fence, which lets the internet through');
    assert.deepEqual(pve.state.ipsets[200].sort(), ['198.51.100.9', '203.0.113.7']);
    assert.ok(asked.includes('fleet.example.com') && asked.includes('api.anthropic.com'));
    await pools.refresh();
    assert.equal(pools.report()[0].networks.find((/** @type {any} */ n) => n.name === 'fwlab2')?.taken, true);
    const again = await pools.make({ owner: OWNER, template: seen.images[0].id, ticket: `fwt_0123456789ac_${'d'.repeat(48)}`, lab: true, network: closed.id, coordinatorUrl: 'https://fleet.example.com' });
    assert.equal(again.ok, false);
    assert.match(again.text, /has a machine on it/);
  } finally {
    await pve.close();
  }
});

test('an open lab machine asks only its gateway for names and is fenced from everything private', { skip }, async () => {
  const certs = certificates();
  const pve = await standIn({ cert: certs.leaf });
  try {
    const pools = new PvePools({ now: () => NOW, ...fast });
    pools.adopt(vaultWith(recordFor(pve.address, certs.ca)));
    await pools.refresh();
    const [seen] = pools.report();
    const open = seen.networks.find((/** @type {any} */ n) => n.lab === 'open');
    const r = await pools.make({ owner: OWNER, template: seen.images[0].id, ticket: TICKET, lab: true, network: open.id, coordinatorUrl: 'https://fleet.example.com' });
    assert.equal(r.ok, true, r.text);
    assert.equal(pve.state.vms.get(200).firewall.policy_out, 'ACCEPT');
    assert.deepEqual(pve.state.rules.map((/** @type {any} */ x) => [x.type, x.action, x.dport ?? '', x.dest ?? '']), [
      ['out', 'ACCEPT', '53', '10.250.1.1'],
      ['out', 'ACCEPT', '53', '10.250.1.1'],
      ['out', 'DROP', '53', ''],
      ['out', 'DROP', '53', ''],
      ['group', PVE_FENCE_GROUP, '', ''],
    ]);
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
  // A CLOSED LAB'S NAMES are the sandbox's required hosts, as the edge router's are.
  assert.deepEqual(/^REQUIRED="([^"]+)"/m.exec(script)?.[1].split(' '), [...REQUIRED_HOSTS]);
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

// THE LINE CROSSES THREE LANGUAGES: the script prints it, both phones read
// it, and the boxes read it again. The Swift and Kotlin compile only in CI,
// so what they read is held to the JavaScript here, as text: the prefix a
// line must start with, and the one command both phones show for the node.
test('both phones read the line the boxes read, and show the same command for the node', () => {
  const ios = readFileSync(new URL('../apps/ios/Fleetwright/AddProxmoxView.swift', import.meta.url), 'utf8');
  const android = readFileSync(new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/ProxmoxSheet.kt', import.meta.url), 'utf8');
  assert.equal(/static let prefix = "([^"]+)"/.exec(ios)?.[1], CONNECTION_PREFIX);
  assert.equal(/const val PREFIX = "([^"]+)"/.exec(android)?.[1], CONNECTION_PREFIX);
  const url = (/static let scriptURL = "([^"]+)"/.exec(ios) ?? [])[1];
  assert.equal((/const val SCRIPT_URL = "([^"]+)"/.exec(android) ?? [])[1], url);
  assert.ok(url?.endsWith('/install/fleetwright-pve-setup'), 'the command fetches something other than the setup script');
  // The same command with the fleet's address after it, which closed labs need.
  const ran = (/** @type {string} */ s, /** @type {RegExp} */ re) =>
    (re.exec(s)?.[1] ?? '').replace(/\\\(scriptURL\)|\$SCRIPT_URL/, url ?? '').replace(/\\\(coordinator\)|\$coordinator/, 'https://fleet.example');
  const iosRan = ran(ios, /static func setupCommand\(coordinator: String\) -> String \{\s*"([^"]+)"/);
  assert.equal(iosRan, ran(android, /fun setupCommand\(coordinator: String\): String = "([^"]+)"/));
  assert.ok(iosRan.endsWith('--coordinator https://fleet.example'), iosRan);
});

// SETUP FROM THE PHONE runs the same commands on the node from either app,
// and the script takes what they pass it. Read as text, as above.
test('both phones start, follow and take the setup on the node with the same commands', () => {
  const ios = readFileSync(new URL('../apps/ios/Fleetwright/ProxmoxSSH.swift', import.meta.url), 'utf8');
  const android = readFileSync(new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/ProxmoxSsh.kt', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../install/fleetwright-pve-setup', import.meta.url), 'utf8');
  const constant = (/** @type {string} */ s, /** @type {string} */ name) => new RegExp(`(?:static let|const val) ${name} = "([^"]+)"`).exec(s)?.[1];
  assert.equal(constant(ios, 'unit'), constant(android, 'UNIT'));
  assert.equal(constant(ios, 'lineFile'), constant(android, 'LINE_FILE'));
  // The commands, with each language's interpolation written one way.
  const norm = (/** @type {string} */ s) => s
    .replace(/\\\((unit|lineFile|since|run)\)/g, (_, n) => `{${n}}`)
    .replace(/\$\{?(UNIT|LINE_FILE|since|run)\}?/g, (_, n) => `{${({ UNIT: 'unit', LINE_FILE: 'lineFile' })[n] ?? n}}`)
    .replace(/"\s*\+\s*"/g, '')
    .replace(/\\"/g, '"');
  const grab = (/** @type {string} */ s, /** @type {RegExp} */ re) => norm(re.exec(s)?.[1] ?? '');
  // To the end of the return statement, which either language may break
  // across lines with a `+`.
  assert.equal(
    grab(ios, /static func startCommand[\s\S]*?return ("[\s\S]*?")\n\s*\}/),
    grab(android, /fun startCommand[\s\S]*?return ("[\s\S]*?")\n\s*\}/),
  );
  assert.equal(
    grab(ios, /static func pollCommand[\s\S]*?\{\s*("[\s\S]*?")\n\s*\}/),
    grab(android, /fun pollCommand\(since: Long\): String =\s*("[\s\S]*?")\n\n/),
  );
  assert.equal(norm(constant(ios, 'takeLine') ?? ''), norm(constant(android, 'TAKE_LINE') ?? ''));
  // What they pass the script is what it takes, and the lines it prints are
  // the ones they read.
  assert.match(script, /--line-file\) LINE_FILE=/);
  assert.match(script, /--coordinator\) COORDINATOR=/);
  assert.match(script, /step\(\) \{ printf 'fleetwright-step: %s\\n'/);
  assert.match(script, /fleetwright-error: %s/);
  for (const step of ['pool', 'user', 'token', 'fence', 'networks', 'image', 'line', 'done']) {
    assert.match(script, new RegExp(`^step ${step}$`, 'm'), `the script has no step ${step}`);
    assert.ok(ios.includes(`case "${step}":`) && android.includes(`"${step}" ->`), `a phone has no words for ${step}`);
  }
});
