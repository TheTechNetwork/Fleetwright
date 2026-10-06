// The boot-time network script a pool's machine runs (install/fleetwright-net):
// the fence on the uplink and the place on a group network. It changes the
// machine's firewall and interfaces, so it is run here against stand-ins for
// nft, ip and systemctl that write down what they were asked, and a stand-in
// interface list, and what they were asked is checked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'install', 'fleetwright-net');
const linux = os.platform() === 'linux';
const MAC = '02:11:11:11:11:11';

/**
 * A machine in a temp dir: stand-in commands that log their arguments (nft
 * logs the ruleset it was fed too), and an interface list with eth0 on the
 * uplink and eth1 carrying `mac`.
 *
 * @param {any} t @param {{ nftFails?: boolean, mac?: string }} [o]
 */
function machine(t, { nftFails = false, mac = MAC } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'net-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const bin = path.join(base, 'bin');
  const sys = path.join(base, 'sys');
  mkdirSync(bin);
  for (const [dev, addr] of [['lo', '00:00:00:00:00:00'], ['eth0', '02:aa:bb:cc:dd:ee'], ['eth1', mac]]) {
    mkdirSync(path.join(sys, dev), { recursive: true });
    writeFileSync(path.join(sys, dev, 'address'), `${addr}\n`);
  }
  const log = path.join(base, 'log');
  const stub = (/** @type {string} */ name, /** @type {string} */ body = '') => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >>'${log}'\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  stub('nft', nftFails ? 'exit 1' : `[ "$1" = "-f" ] && cat >>'${log}'\nexit 0`);
  stub('ip');
  stub('systemctl');
  stub('avahi-daemon');
  const run = (/** @type {any} */ net) => {
    const file = path.join(base, 'net.json');
    if (net !== null) writeFileSync(file, typeof net === 'string' ? net : JSON.stringify(net));
    const r = spawnSync('bash', [SCRIPT, file], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FLEETWRIGHT_SYS_NET: sys }, encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
  };
  return { run };
}

const ISOLATE = { subnet: '10.254.0.0/24', gateway: '10.254.0.1' };

test('on the uplink, only the router may open a connection in, and replies still come back', { skip: !linux }, (t) => {
  const { status, log } = machine(t).run({ v: 1, isolate: ISOLATE });
  assert.equal(status, 0);
  assert.match(log, /nft delete table inet fleetwright/, 'replaced, not added to, at each boot');
  const rules = log.slice(log.indexOf('table inet fleetwright'));
  const order = ['ct state established,related accept', 'iifname "lo" accept', 'ip saddr 10.254.0.1 accept', 'ip saddr 10.254.0.0/24 drop', 'meta nfproto ipv6 drop'];
  const at = order.map((r) => rules.indexOf(r));
  assert.ok(at.every((i) => i >= 0), rules);
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in this order: replies, itself, the router, then the rest of the uplink');
  assert.ok(!/policy drop/.test(rules), 'out and everything else is left as it was');
});

test('in a group, the interface with its MAC gets its address and everything on it is let in', { skip: !linux }, (t) => {
  const { status, log } = machine(t).run({ v: 1, isolate: ISOLATE, group: { mac: MAC, address: '10.200.4.9/16' } });
  assert.equal(status, 0);
  assert.match(log, /ip link set eth1 up/);
  assert.match(log, /ip addr replace 10\.200\.4\.9\/16 dev eth1/);
  assert.match(log, /systemctl enable --now avahi-daemon/, 'names on the group network');
  const rules = log.slice(log.indexOf('table inet fleetwright'));
  assert.ok(rules.indexOf('iifname "eth1" accept') < rules.indexOf('ip saddr 10.254.0.0/24 drop'), 'the group before the uplink’s drop');
});

test('a group whose interface is missing is said, and the machine is still fenced', { skip: !linux }, (t) => {
  const { status, out, log } = machine(t, { mac: '02:99:99:99:99:99' }).run({ v: 1, isolate: ISOLATE, group: { mac: MAC, address: '10.200.4.9/16' } });
  assert.equal(status, 0);
  assert.match(out, /no interface has 02:11:11:11:11:11/);
  assert.ok(!/ip addr/.test(log));
  assert.match(log, /ip saddr 10\.254\.0\.0\/24 drop/);
});

test('a fence that cannot be put in place powers the machine off rather than leave it open', { skip: !linux }, (t) => {
  const { status, log } = machine(t, { nftFails: true }).run({ v: 1, isolate: ISOLATE });
  assert.equal(status, 1);
  assert.match(log, /systemctl poweroff/);
});

test('anything that is not an address is refused before it reaches a ruleset or a command', { skip: !linux }, (t) => {
  const m = machine(t);
  for (const bad of [
    { isolate: { subnet: '10.254.0.0/24; flush ruleset', gateway: '10.254.0.1' } },
    { isolate: { subnet: '10.254.0.0/24', gateway: '10.254.0.1 accept' } },
    { isolate: { subnet: '10.254.0.0/24' } },
    { group: { mac: '02:11:11:11:11:11 ; reboot', address: '10.200.4.9/16' } },
    { group: { mac: MAC, address: '10.200.4.9/16 dev lo' } },
  ]) {
    const r = m.run({ v: 1, ...bad });
    assert.equal(r.status, 1, JSON.stringify(bad));
    assert.ok(!/^(nft|ip) /m.test(r.log), JSON.stringify(bad));
  }
});

test('a machine with no network file, or neither part in it, is left as it is', { skip: !linux }, (t) => {
  const m = machine(t);
  assert.equal(m.run(null).status, 0);
  const r = m.run({ v: 1 });
  assert.equal(r.status, 0);
  assert.equal(r.log, '');
});
