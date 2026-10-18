// The egress allowlist: an internal network per person, one proxy, and the
// hosts it lets through.
//
//   node --test test/
//
// Pure decisions and a stub podman, as podman.test.js does: the container
// that would prove the routing does not run in CI, and src/core/egress.js
// says so. What is pinned here is what a box on the allowlist ASKS podman
// for — an internal network for each person with a subnet of its own, a
// proxy on every one of them and on the default network, each session put on
// its owner's network and told that proxy and nothing else — and that the
// four hosts the CLI cannot work without are on every list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  allowlistFor,
  proxyConfig,
  allowListText,
  egressArgs,
  proxyAddress,
  ensureEgress,
  REQUIRED_HOSTS,
  PROXY_CONTAINER,
  CONFIG_LABEL,
} from '../src/core/egress.js';
import { buildCommand } from '../src/core/claude.js';

/** Is this exact name on the list? Whole-string membership, never a substring:
 * the lists here hold hostnames and the question is which ones are present.
 * @param {string[]|undefined} list @param {string} name */
const listed = (list, name) => Array.isArray(list) && list.some((x) => x === name);

test('the four hosts the CLI cannot work without are on every list, and cannot be removed', () => {
  const { hosts } = allowlistFor({ sandboxEgressAllow: [] });
  for (const h of ['api.anthropic.com', 'platform.claude.com', 'claude.ai', 'claude.com']) assert.ok(listed(hosts, h), h);
  assert.deepEqual([...REQUIRED_HOSTS].sort(), ['api.anthropic.com', 'claude.ai', 'claude.com', 'platform.claude.com']);
  // platform.claude.com is the one an allowlist is most likely to omit: it
  // carries token refresh, so omitting it breaks the idle box, not sign-in.
  assert.ok(listed(hosts, 'platform.claude.com'));
});

test('extras are validated as hostnames, lowercased, deduplicated and sorted', () => {
  const { hosts, refused } = allowlistFor({
    sandboxEgressAllow: ['Example.COM', 'example.com', 'pypi.org', 'http://bad', '*.wild.com', 'no spaces', 'localhost', ''],
  });
  assert.ok(listed(hosts, 'example.com'));
  assert.equal(hosts.filter((h) => h === 'example.com').length, 1);
  assert.ok(listed(hosts, 'pypi.org'));
  assert.deepEqual(refused, ['http://bad', '*.wild.com', 'no spaces', 'localhost']);
  assert.deepEqual(hosts, [...hosts].sort(), 'sorted, so the config hashes the same whatever order was typed');
});

test('the proxy config is CONNECT-only to 443, default-deny, exact-match', () => {
  const conf = proxyConfig(['api.anthropic.com']);
  for (const line of ['ConnectPort 443', 'FilterDefaultDeny Yes', 'FilterType ere', 'FilterURLs No', 'Filter /etc/tinyproxy/allow.list', 'Port 3128']) {
    assert.ok(conf.split('\n').includes(line), line);
  }
  assert.doesNotMatch(conf, /^ConnectPort 80$/m, 'no plain HTTP through a proxy that could then read it');
  // tinyproxy's own grammar for the directive (conf.c, 1.11): any other word is
  // a syntax error and the proxy does not start. `fixed` was one (seventh audit).
  const type = conf.split('\n').find((l) => l.startsWith('FilterType'));
  assert.match(type ?? '', /^FilterType (bre|ere|fnmatch)$/);
});

test('each allowed host matches itself and nothing that merely contains it', () => {
  const lines = allowListText(['api.anthropic.com', 'pypi.org']).trimEnd().split('\n');
  // An extended regex as tinyproxy compiles it: unanchored by itself, so the
  // anchors have to be in the line. JS reads this subset of ERE the same way.
  const allows = (/** @type {string} */ host) => lines.some((l) => new RegExp(l, 'i').test(host));
  assert.equal(allows('api.anthropic.com'), true);
  assert.equal(allows('API.Anthropic.com'), true, 'FilterCaseSensitive No');
  assert.equal(allows('pypi.org'), true);
  for (const host of ['api.anthropic.com.attacker.net', 'evil-api.anthropic.com', 'apiXanthropic.com', 'pypiXorg', 'xpypi.org']) {
    assert.equal(allows(host), false, host);
  }
});

test('a session on the allowlist is put on the network it was given and told that proxy, and nothing else', () => {
  assert.deepEqual(egressArgs({ sandboxEgress: 'open' }), []);
  assert.deepEqual(egressArgs({}), []);
  const route = { network: 'agent-egress-0123456789abcdef', proxy: '10.89.202.2:3128' };
  const args = egressArgs({ sandboxEgress: 'allowlist' }, route);
  assert.deepEqual(args.slice(0, 2), ['--network', 'agent-egress-0123456789abcdef']);
  assert.ok(listed(args, 'HTTPS_PROXY=http://10.89.202.2:3128'));
  assert.ok(listed(args, 'NO_PROXY=localhost,127.0.0.1,::1'));
  assert.equal(args.some((a) => /CA_CERTS|NODE_EXTRA/.test(a)), false, 'a CONNECT proxy terminates no TLS, so no CA bundle');
  // No route is no network to put it on: refused, rather than guessed at.
  assert.throws(() => egressArgs({ sandboxEgress: 'allowlist' }), /needs the route/);
  assert.equal(proxyAddress('10.89.201.0/24'), '10.89.201.2');
  assert.throws(() => proxyAddress('not a subnet'), /not a usable egress subnet/);
});

/** A sandboxed box's config, as buildCommand reads it. @param {Partial<any>} patch @returns {any} */
const launchCfg = (patch = {}) => ({
  claudeBin: 'claude', remoteControl: true, skipPermissions: true, sandbox: true, podmanBin: 'podman',
  sandboxImage: 'localhost/fleetwright-session:latest', sandboxMemory: '8g', sandboxCpus: '2', sandboxPidsLimit: '512',
  sandboxExtraArgs: [], sandboxHookSocket: false, sandboxHookSocketDir: '/run/fleetwright-sidecar', sandboxUserns: 'nomap',
  sandboxEgress: 'open', ...patch,
});
/** The network a launch line puts its container on. @param {string} line */
const networkOf = (line) => /'--network' '([^']+)'/.exec(line)?.[1];
/** The proxy a launch line tells its session. @param {string} line */
const proxyOf = (line) => /'HTTPS_PROXY=http:\/\/([^']+)'/.exec(line)?.[1];

test('the launch line carries the egress arguments under an allowlist and none when open', () => {
  assert.ok(!buildCommand(launchCfg(), { name: 'api' }).includes('--network'));
  const line = buildCommand(launchCfg({ sandboxEgress: 'allowlist' }), {
    name: 'api', owner: 'fleet:eli@example.com', egress: { network: 'agent-egress-0123456789abcdef', proxy: '10.89.201.2:3128' },
  });
  assert.equal(networkOf(line), 'agent-egress-0123456789abcdef');
  assert.equal(proxyOf(line), '10.89.201.2:3128');
});

// --- what podman is asked for -------------------------------------------------

/**
 * A podman that remembers what it was asked to make, the way the real one
 * does: networks with their subnets, refusing one that overlaps, and one
 * proxy container with its label and the networks it is on.
 * @param {import('node:test').TestContext} t
 * @param {{ networks?: Record<string, string>, imageExists?: boolean }} [opts]
 */
function stubPodman(t, { networks = { podman: '10.88.0.0/16' }, imageExists = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  const net = path.join(dir, 'net');
  mkdirSync(net);
  for (const [name, subnet] of Object.entries(networks)) writeFileSync(path.join(net, name), `${subnet} \n`);
  const bin = path.join(dir, 'podman');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> ${log}
for last; do :; done
case "$1 $2" in
  "network inspect") [ -f "${net}/$last" ] && { cat "${net}/$last"; exit 0; }; echo "Error: unable to find network $last" >&2; exit 125 ;;
  "network create")
    prev=""; subnet=""
    for a; do [ "$prev" = "--subnet" ] && subnet=$a; prev=$a; done
    if cat ${net}/* | grep -qxF "$subnet "; then echo "Error: subnet $subnet is already used on the host or by another config" >&2; exit 125; fi
    echo "$subnet " > "${net}/$last"; exit 0 ;;
  "network ls") ls ${net}; exit 0 ;;
  "network connect") echo "$5" >> ${dir}/proxy.nets; exit 0 ;;
  "image inspect") ${imageExists ? 'exit 0' : `grep -q '^build' ${log} && exit 0; exit 1`} ;;
  "container inspect") [ -f ${dir}/proxy.label ] || exit 125; printf 'true|%s|%s\\n' "$(cat ${dir}/proxy.label)" "$(tr '\\n' ' ' < ${dir}/proxy.nets)"; exit 0 ;;
esac
case "$1" in
  run)
    prev=""; : > ${dir}/proxy.nets
    for a; do
      case "$prev" in
        --label) echo "\${a#*=}" > ${dir}/proxy.label ;;
        --network) echo "\${a%%:*}" >> ${dir}/proxy.nets ;;
      esac
      prev=$a
    done
    exit 0 ;;
  rm) rm -f ${dir}/proxy.label ${dir}/proxy.nets; exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(bin, 0o755);
  const state = path.join(dir, 'state');
  mkdirSync(state);
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return {
    dir,
    calls,
    /** The subnet a network was created with: its last create, the one podman
     * did not refuse. @param {string|undefined} name */
    subnetOf: (name) => calls().findLast((c) => c.startsWith('network create') && c.endsWith(` ${name}`))?.split(' ')[4],
    /** @param {Partial<any>} patch @returns {any} */
    cfg: (patch = {}) => ({
      podmanBin: bin,
      stateDir: state,
      sandboxEgress: 'allowlist',
      sandboxEgressAllow: [],
      sandboxEgressSubnet: '10.89.201.0/24',
      sandboxEgressImage: 'localhost/agent-egress:latest',
      sandboxEgressContainerfile: path.join(dir, 'Containerfile'),
      ...patch,
    }),
  };
}

test('a first start creates the person\'s network and runs the proxy on it and the default network at a fixed address', async (t) => {
  const s = stubPodman(t);
  const r = await ensureEgress(s.cfg(), 'fleet:eli@example.com');
  assert.equal(r.ok, true, r.message);
  assert.match(String(r.network), /^agent-egress-[0-9a-f]{16}$/, 'named for the person without spelling out who they are');
  assert.equal(r.proxy, '10.89.201.2:3128');
  const calls = s.calls();
  assert.ok(calls.includes(`network create --internal --subnet 10.89.201.0/24 ${r.network}`), calls.join('\n'));
  const run = calls.find((c) => c.startsWith('run -d'));
  assert.ok(run, 'the proxy was started');
  assert.match(run, new RegExp(`--name ${PROXY_CONTAINER}`));
  assert.ok(run.includes(`--network ${r.network}:ip=10.89.201.2 `), 'the internal side, at the address sessions are told');
  assert.match(run, /--network podman/, 'and the default network, which is the only way out');
  assert.match(run, /--sysctl net\.ipv4\.ip_forward=0/, 'and it forwards nothing from one network to another');
  assert.match(run, new RegExp(`--label ${CONFIG_LABEL}=[0-9a-f]{16}`));
  assert.match(run, /tinyproxy\.conf:\/etc\/tinyproxy\/tinyproxy\.conf:ro/);
  assert.match(run, /allow\.list:\/etc\/tinyproxy\/allow\.list:ro/);
  assert.ok(!run.includes('--userns'), 'the proxy is the box\'s, not a session\'s');
  assert.ok(!calls.some((c) => c.startsWith('build')), 'the image was already there');

  const conf = readFileSync(path.join(s.cfg().stateDir, 'egress', 'tinyproxy.conf'), 'utf8');
  const allow = readFileSync(path.join(s.cfg().stateDir, 'egress', 'allow.list'), 'utf8');
  assert.match(conf, /FilterDefaultDeny Yes/);
  const literal = (/** @type {string} */ h) => h.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  for (const h of REQUIRED_HOSTS) assert.ok(listed(allow.split('\n'), `^${literal(h)}$`), h);
});

test('two people\'s sessions go on two networks, each told a proxy on its own, and joining the second restarts nothing (G9)', async (t) => {
  const s = stubPodman(t);
  const cfg = s.cfg();
  const eli = await ensureEgress(cfg, 'fleet:eli@example.com');
  const sam = await ensureEgress(cfg, 'fleet:sam@example.com');
  assert.equal(eli.ok && sam.ok, true, eli.message ?? sam.message);
  const eliLine = buildCommand(launchCfg({ sandboxEgress: 'allowlist' }), { name: 'eli-api', owner: 'fleet:eli@example.com', egress: eli });
  const samLine = buildCommand(launchCfg({ sandboxEgress: 'allowlist' }), { name: 'sam-web', owner: 'fleet:sam@example.com', egress: sam });

  // THE FINDING: one network for the box put every session beside every other,
  // where a dev server or a debugger on 0.0.0.0 answers anybody on it.
  const eliNet = networkOf(eliLine);
  const samNet = networkOf(samLine);
  assert.notEqual(eliNet, samNet, `two people's sessions share ${eliNet}, so each can reach every port the other listens on`);

  // Each is told the proxy's address on its own network, which is the second
  // address of the subnet that network was given.
  const eliSubnet = s.subnetOf(eliNet);
  const samSubnet = s.subnetOf(samNet);
  assert.ok(eliSubnet && samSubnet && eliSubnet !== samSubnet, `${eliSubnet} / ${samSubnet}`);
  assert.equal(proxyOf(eliLine), `${proxyAddress(eliSubnet)}:3128`);
  assert.equal(proxyOf(samLine), `${proxyAddress(samSubnet)}:3128`);

  // And the proxy is on both: started on the first, joined to the second at
  // that address, without being replaced, so the first person's tunnels stay up.
  const calls = s.calls();
  assert.ok(calls.find((c) => c.startsWith('run -d'))?.includes(`--network ${eliNet}:ip=${proxyAddress(eliSubnet)} `));
  assert.ok(calls.includes(`network connect --ip ${proxyAddress(samSubnet)} ${samNet} ${PROXY_CONTAINER}`), calls.join('\n'));
  assert.equal(calls.filter((c) => c.startsWith('run ') || c.startsWith('rm ')).length, 1, 'one start, no restart');
});

test('the same person reuses their network and an unchanged proxy; a changed allowlist puts the new proxy back on every network', async (t) => {
  const s = stubPodman(t);
  const eli = await ensureEgress(s.cfg(), 'fleet:eli@example.com');
  const sam = await ensureEgress(s.cfg(), 'fleet:sam@example.com');
  const before = s.calls().length;

  const again = await ensureEgress(s.cfg(), 'eli@example.com');
  assert.deepEqual([again.network, again.proxy], [eli.network, eli.proxy], 'an actor and the bare email are the same person');
  const untouched = s.calls().slice(before);
  assert.ok(!untouched.some((c) => /^(run|rm|network create|network connect) /.test(c)), `nothing made or restarted: ${untouched.join(' | ')}`);

  const changed = await ensureEgress(s.cfg({ sandboxEgressAllow: ['pypi.org'] }), 'fleet:eli@example.com');
  assert.equal(changed.ok, true, changed.message);
  const after = s.calls().slice(before);
  assert.ok(after.some((c) => c === `rm -f ${PROXY_CONTAINER}`), 'the old proxy goes');
  const run = after.find((c) => c.startsWith('run -d'));
  for (const r of [eli, sam]) {
    assert.ok(run?.includes(`--network ${r.network}:ip=${String(r.proxy).split(':')[0]} `), `back on ${r.network} where its sessions were told: ${run}`);
  }
  assert.match(readFileSync(path.join(s.cfg().stateDir, 'egress', 'allow.list'), 'utf8'), /^\^pypi\\\.org\$$/m);
});

test('a box that already has the one shared network leaves it alone and counts past its subnet', async (t) => {
  const s = stubPodman(t, { networks: { podman: '10.88.0.0/16', 'agent-egress': '10.89.201.0/24' } });
  const r = await ensureEgress(s.cfg(), 'fleet:eli@example.com');
  assert.equal(r.ok, true, r.message);
  assert.equal(r.proxy, '10.89.202.2:3128', 'the default\'s first subnet is taken, so the next one');
  const calls = s.calls();
  assert.ok(!calls.some((c) => / agent-egress(:|$| )/.test(c)), `the old network is neither joined nor removed: ${calls.join(' | ')}`);
});

test('the subnets never leave the private ranges the proxy allows, and one too small to hold a proxy is refused', async (t) => {
  const full = stubPodman(t, { networks: { other: '192.168.255.0/24' } });
  const r = await ensureEgress(full.cfg({ sandboxEgressSubnet: '192.168.255.0/24' }), 'fleet:eli@example.com');
  assert.equal(r.ok, false);
  assert.match(String(r.message), /no free subnet/);
  assert.ok(!full.calls().some((c) => c.includes('192.169.')), 'past 192.168/16 is outside every Allow line');

  const bad = stubPodman(t);
  const odd = await ensureEgress(bad.cfg({ sandboxEgressSubnet: '10.89.201.0/31' }), 'fleet:eli@example.com');
  assert.match(String(odd.message), /not a usable egress subnet/);
});

test('a missing local image is built before the proxy is started, and a hostname that is not one is ignored with a warning', async (t) => {
  const s = stubPodman(t, { imageExists: false });
  writeFileSync(path.join(s.dir, 'Containerfile'), 'FROM docker.io/library/alpine:3.20\n');
  const r = await ensureEgress(s.cfg({ sandboxEgressAllow: ['ok.example', 'nope nope'] }), null);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.network, 'agent-egress-box', 'nobody behind it is the box\'s own, as its download cache is');
  const calls = s.calls();
  const build = calls.findIndex((c) => c.startsWith('build -t localhost/agent-egress:latest'));
  const run = calls.findIndex((c) => c.startsWith('run -d'));
  assert.ok(build >= 0 && run > build, 'built, then started');
  assert.ok(listed(r.hosts, 'ok.example'));
  assert.ok(!listed(r.hosts, 'nope nope'));
});

test('with egress open, nothing is asked of podman at all', async (t) => {
  const s = stubPodman(t);
  const r = await ensureEgress(s.cfg({ sandboxEgress: 'open' }), 'fleet:eli@example.com');
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(s.calls(), []);
});
