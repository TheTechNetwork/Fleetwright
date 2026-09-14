// The egress allowlist: an internal network, one proxy, and the hosts it lets
// through.
//
//   node --test test/
//
// Pure decisions and a stub podman, as podman.test.js does: the container
// that would prove the routing does not run in CI, and src/core/egress.js
// says so. What is pinned here is what a box on the allowlist ASKS podman
// for — the internal network with a fixed subnet, a proxy on both networks
// at a fixed address, sessions told that address and nothing else — and
// that the four hosts the CLI cannot work without are on every list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  allowlistFor,
  proxyConfig,
  egressArgs,
  proxyAddress,
  ensureEgress,
  REQUIRED_HOSTS,
  EGRESS_NETWORK,
  PROXY_CONTAINER,
  CONFIG_LABEL,
} from '../src/core/egress.js';
import { buildCommand } from '../src/core/claude.js';

test('the four hosts the CLI cannot work without are on every list, and cannot be removed', () => {
  const { hosts } = allowlistFor({ sandboxEgressAllow: [] });
  for (const h of ['api.anthropic.com', 'platform.claude.com', 'claude.ai', 'claude.com']) assert.ok(hosts.includes(h), h);
  assert.deepEqual([...REQUIRED_HOSTS].sort(), ['api.anthropic.com', 'claude.ai', 'claude.com', 'platform.claude.com']);
  // platform.claude.com is the one an allowlist is most likely to omit: it
  // carries token refresh, so omitting it breaks the idle box, not sign-in.
  assert.ok(hosts.includes('platform.claude.com'));
});

test('extras are validated as hostnames, lowercased, deduplicated and sorted', () => {
  const { hosts, refused } = allowlistFor({
    sandboxEgressAllow: ['Example.COM', 'example.com', 'pypi.org', 'http://bad', '*.wild.com', 'no spaces', 'localhost', ''],
  });
  assert.ok(hosts.includes('example.com'));
  assert.equal(hosts.filter((h) => h === 'example.com').length, 1);
  assert.ok(hosts.includes('pypi.org'));
  assert.deepEqual(refused, ['http://bad', '*.wild.com', 'no spaces', 'localhost']);
  assert.deepEqual(hosts, [...hosts].sort(), 'sorted, so the config hashes the same whatever order was typed');
});

test('the proxy config is CONNECT-only to 443, default-deny, exact-match', () => {
  const conf = proxyConfig(['api.anthropic.com']);
  for (const line of ['ConnectPort 443', 'FilterDefaultDeny Yes', 'FilterType fixed', 'FilterURLs No', 'Filter /etc/tinyproxy/allow.list', 'Port 3128']) {
    assert.ok(conf.split('\n').includes(line), line);
  }
  assert.doesNotMatch(conf, /^ConnectPort 80$/m, 'no plain HTTP through a proxy that could then read it');
});

test('a session on the allowlist is put on the internal network and told the proxy, and nothing else', () => {
  assert.deepEqual(egressArgs({ sandboxEgress: 'open' }), []);
  assert.deepEqual(egressArgs({}), []);
  const args = egressArgs({ sandboxEgress: 'allowlist' });
  assert.deepEqual(args.slice(0, 2), ['--network', EGRESS_NETWORK]);
  assert.ok(args.includes('HTTPS_PROXY=http://10.89.201.2:3128'));
  assert.ok(args.includes('NO_PROXY=localhost,127.0.0.1,::1'));
  assert.equal(args.some((a) => /CA_CERTS|NODE_EXTRA/.test(a)), false, 'a CONNECT proxy terminates no TLS, so no CA bundle');
  assert.ok(egressArgs({ sandboxEgress: 'allowlist', sandboxEgressSubnet: '10.7.0.0/24' }).includes('HTTPS_PROXY=http://10.7.0.2:3128'));
  assert.equal(proxyAddress('10.89.201.0/24'), '10.89.201.2');
  assert.throws(() => proxyAddress('not a subnet'), /not a usable egress subnet/);
});

test('the launch line carries the egress arguments under an allowlist and none when open', () => {
  /** @param {Partial<any>} patch @returns {any} */
  const cfg = (patch = {}) => ({
    claudeBin: 'claude', remoteControl: true, skipPermissions: true, sandbox: true, podmanBin: 'podman',
    sandboxImage: 'localhost/agent-session:latest', sandboxMemory: '8g', sandboxCpus: '2', sandboxPidsLimit: '512',
    sandboxExtraArgs: [], sandboxHookSocket: false, sandboxHookSocketDir: '/run/agent-fleet', sandboxUserns: 'nomap',
    sandboxEgress: 'open', ...patch,
  });
  assert.ok(!buildCommand(cfg(), { name: 'api' }).includes('--network'));
  const line = buildCommand(cfg({ sandboxEgress: 'allowlist' }), { name: 'api' });
  assert.match(line, /'--network' 'agent-egress'/);
  assert.match(line, /'HTTPS_PROXY=http:\/\/10\.89\.201\.2:3128'/);
});

// --- what podman is asked for -------------------------------------------------

/**
 * A podman whose network and proxy state a test controls through two files.
 * @param {import('node:test').TestContext} t
 * @param {{ networkExists?: boolean, imageExists?: boolean }} [opts]
 */
function stubPodman(t, { networkExists = false, imageExists = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  const proxyState = path.join(dir, 'proxy.state');
  const bin = path.join(dir, 'podman');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> ${log}
case "$1 $2" in
  "network inspect") ${networkExists ? 'exit 0' : `grep -q '^network create' ${log} && exit 0; exit 1`} ;;
  "network create") exit 0 ;;
  "image inspect") ${imageExists ? 'exit 0' : `grep -q '^build' ${log} && exit 0; exit 1`} ;;
  "container inspect") [ -f ${proxyState} ] && { cat ${proxyState}; exit 0; }; exit 1 ;;
esac
case "$1" in
  run|rm|build|pull) exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(bin, 0o755);
  const state = path.join(dir, 'state');
  mkdirSync(state);
  return {
    dir,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    /** Make the stub report the proxy as running with this label. @param {string} label */
    proxyRunning: (label) => writeFileSync(proxyState, `true ${label}\n`),
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

test('a first start creates the internal network and runs the proxy on both networks at a fixed address', async (t) => {
  const s = stubPodman(t);
  const r = await ensureEgress(s.cfg());
  assert.equal(r.ok, true, r.message);
  assert.equal(r.proxy, '10.89.201.2:3128');
  const calls = s.calls();
  assert.ok(calls.includes(`network create --internal --subnet 10.89.201.0/24 ${EGRESS_NETWORK}`), calls.join('\n'));
  const run = calls.find((c) => c.startsWith('run -d'));
  assert.ok(run, 'the proxy was started');
  assert.match(run, new RegExp(`--name ${PROXY_CONTAINER}`));
  assert.match(run, new RegExp(`--network ${EGRESS_NETWORK}:ip=10\\.89\\.201\\.2`), 'the internal side, at the address sessions are told');
  assert.match(run, /--network podman/, 'and the default network, which is the only way out');
  assert.match(run, new RegExp(`--label ${CONFIG_LABEL}=[0-9a-f]{16}`));
  assert.match(run, /tinyproxy\.conf:\/etc\/tinyproxy\/tinyproxy\.conf:ro/);
  assert.match(run, /allow\.list:\/etc\/tinyproxy\/allow\.list:ro/);
  assert.ok(!run.includes('--userns'), 'the proxy is the box\'s, not a session\'s');
  assert.ok(!calls.some((c) => c.startsWith('build')), 'the image was already there');

  const conf = readFileSync(path.join(s.cfg().stateDir, 'egress', 'tinyproxy.conf'), 'utf8');
  const allow = readFileSync(path.join(s.cfg().stateDir, 'egress', 'allow.list'), 'utf8');
  assert.match(conf, /FilterDefaultDeny Yes/);
  for (const h of REQUIRED_HOSTS) assert.ok(allow.split('\n').includes(h), h);
});

test('a proxy already running with this config is left alone; a changed allowlist replaces it', async (t) => {
  const s = stubPodman(t, { networkExists: true });
  await ensureEgress(s.cfg());
  const label = /--label agent-egress-config=([0-9a-f]+)/.exec(s.calls().join('\n'))?.[1];
  assert.ok(label);
  s.proxyRunning(label);
  const before = s.calls().length;

  await ensureEgress(s.cfg());
  const untouched = s.calls().slice(before);
  assert.ok(!untouched.some((c) => c.startsWith('run ') || c.startsWith('rm ')), `nothing restarted: ${untouched.join(' | ')}`);

  const changed = await ensureEgress(s.cfg({ sandboxEgressAllow: ['pypi.org'] }));
  assert.equal(changed.ok, true);
  const after = s.calls().slice(before);
  assert.ok(after.some((c) => c === `rm -f ${PROXY_CONTAINER}`), 'the old proxy goes');
  assert.ok(after.some((c) => c.startsWith('run -d')), 'and the new one comes up');
  assert.match(readFileSync(path.join(s.cfg().stateDir, 'egress', 'allow.list'), 'utf8'), /^pypi\.org$/m);
});

test('a missing local image is built before the proxy is started, and a hostname that is not one is ignored with a warning', async (t) => {
  const s = stubPodman(t, { networkExists: true, imageExists: false });
  writeFileSync(path.join(s.dir, 'Containerfile'), 'FROM docker.io/library/alpine:3.20\n');
  const r = await ensureEgress(s.cfg({ sandboxEgressAllow: ['ok.example', 'nope nope'] }));
  assert.equal(r.ok, true, r.message);
  const calls = s.calls();
  const build = calls.findIndex((c) => c.startsWith('build -t localhost/agent-egress:latest'));
  const run = calls.findIndex((c) => c.startsWith('run -d'));
  assert.ok(build >= 0 && run > build, 'built, then started');
  assert.ok(r.hosts?.includes('ok.example'));
  assert.ok(!r.hosts?.includes('nope nope'));
});

test('with egress open, nothing is asked of podman at all', async (t) => {
  const s = stubPodman(t);
  const r = await ensureEgress(s.cfg({ sandboxEgress: 'open' }));
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(s.calls(), []);
});
