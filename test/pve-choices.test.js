// WHAT A PROXMOX VE NODE HAS TO CHOOSE FROM (src/fleet/host/pve-setup.js,
// CHOICES_FIND and choicesOf): the storage and the bridge the setup takes,
// listed from the node rather than typed blind. Asked for: "Why not list
// networks and storage instead of asking blindly".
//
//   node --test test/pve-choices.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { CHOICES_FIND, choicesOf, pveOptionsOf } from '../src/fleet/host/pve-setup.js';

// What pvesh answers on a node with two disk storages and two bridges,
// trimmed to the fields that matter.
const STORAGE = [
  { storage: 'local-lvm', type: 'lvmthin', active: 1, enabled: 1, shared: 0, avail: 812_000_000_000, total: 900_000_000_000, content: 'images,rootdir' },
  { storage: 'ceph-vm', type: 'rbd', active: 1, enabled: 1, shared: 1, avail: 4_000_000_000_000, content: 'images' },
  { storage: 'nfs-down', type: 'nfs', active: 0, enabled: 1, shared: 1, content: 'images' },
  { storage: 'bad name!', type: 'dir', active: 1 },
];
const BRIDGES = [
  { iface: 'vmbr1', type: 'bridge', active: 1, comments: 'Lab uplink\n' },
  { iface: 'vmbr0', type: 'bridge', active: 1, cidr: '10.69.10.10/24', address: '10.69.10.10' },
  { iface: 'not a bridge name at all', type: 'bridge' },
];
const answer = `storage: ${JSON.stringify(STORAGE)}\nbridges: ${JSON.stringify(BRIDGES)}\n`;

test('the node’s disk storages and bridges, in names the setup takes', () => {
  const { storages, bridges } = choicesOf(answer);
  // Active ones only, sorted, with what is free when the node said.
  assert.deepEqual(storages, [
    { id: 'ceph-vm', type: 'rbd', free: 4_000_000_000_000, shared: true },
    { id: 'local-lvm', type: 'lvmthin', free: 812_000_000_000, shared: false },
  ]);
  assert.deepEqual(bridges, [
    { name: 'vmbr0', address: '10.69.10.10/24', comment: null },
    { name: 'vmbr1', address: null, comment: 'Lab uplink' },
  ]);
  // Everything listed is something the setup accepts.
  for (const s of storages) assert.equal(pveOptionsOf({ storage: s.id }).problem, null);
  for (const b of bridges) assert.equal(pveOptionsOf({ bridge: b.name }).problem, null);
});

test('a node that said nothing, or something else, lists nothing and is not taken for one with none', () => {
  assert.deepEqual(choicesOf(''), { storages: [], bridges: [] });
  assert.deepEqual(choicesOf('storage: not json\nbridges: {"a":1}'), { storages: [], bridges: [] });
  // One line missing leaves the other.
  assert.equal(choicesOf(`storage: ${JSON.stringify(STORAGE)}`).storages.length, 2);
});

test('the command asks this node for disk storage that is on, and for bridges, read only', () => {
  assert.match(CHOICES_FIND, /pvesh get "\/nodes\/\$n\/storage" --content images --enabled 1 --output-format json/);
  assert.match(CHOICES_FIND, /pvesh get "\/nodes\/\$n\/network" --type any_bridge --output-format json/);
  assert.doesNotMatch(CHOICES_FIND, /pvesh (set|create|delete)/);
});
