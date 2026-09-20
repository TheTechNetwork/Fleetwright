// Where a session may reach, when the box says so.
//
// docs/security.md SEC-SESSION-4: egress from a session is OPEN by design
// today, and SEC-INJECT-2 says the fix is a default-deny egress through a
// named allowlist — and that it is not built. This is it, opt-in:
//
//   AGENT_HUB_SANDBOX_EGRESS=allowlist
//
// THE SHAPE, from docs/recommendations-review.md §3, and the precision it
// insists on: podman's `--internal` network is a ROUTING control, not a
// firewall. "IP forwarding is disabled on the bridge interface instead of
// setting up a firewall. No default route will be added to the container."
// A session on that network can reach exactly the other containers on it and
// nothing else. One of those is a proxy container that also sits on the
// default network, so it is the only path out — and the allowlist lives in
// the proxy, because the network cannot express one.
//
// The proxy is tinyproxy: CONNECT only, `FilterDefaultDeny`, a filter file of
// exact hostnames, port 443 only. A CONNECT proxy does not terminate TLS, so
// no CA bundle enters the container; the session needs HTTPS_PROXY and
// nothing else — Claude Code "respects standard proxy environment variables"
// and needs NODE_EXTRA_CA_CERTS only for TLS-inspection proxies, which this
// is not. SOCKS is unsupported by the CLI, which is why the proxy is HTTP.
//
// WHAT THE LIST CANNOT OMIT, from Claude Code's network page: api.anthropic.com
// for every request, and platform.claude.com for "OAuth token exchange,
// refresh, and revocation" — an allowlist without it breaks the idle-box
// renewal keepalive.js exists for, not sign-in. claude.ai and claude.com are
// the sign-in itself. Those four are REQUIRED and cannot be configured away.
//
// WHAT IS ADDED BY DEFAULT is a coding agent's working set — GitHub and the
// npm registry — because a session that cannot clone or install is a session
// that cannot do the work it was started for, and refusing those by default
// would make the feature one nobody turns on. AGENT_HUB_SANDBOX_EGRESS_ALLOW
// extends it; nothing removes the required four.
//
// NOT MEASURED ON HARDWARE. Every podman call below is one the manual
// documents, and the proxy config is tinyproxy's own grammar, but this box has
// no podman and the container that would prove it does not run in CI. The
// test is a session on a box with the setting on: `curl https://example.com`
// refused by the proxy, `claude` signing in and answering. security.md
// SEC-INJECT-2 stays marked until that has been seen.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { podman, podmanAsync } from './podman.js';

/** The internal network sessions join. Created once, never removed by this code. */
export const EGRESS_NETWORK = 'agent-egress';
/** The proxy container, on both the internal network and the default one. */
export const PROXY_CONTAINER = 'agent-egress-proxy';
/** Where the proxy listens, inside the internal network. */
export const PROXY_PORT = 3128;
/** The subnet the internal network gets, so the proxy's address is fixed and
 * no session depends on name resolution to find its only way out. */
export const DEFAULT_SUBNET = '10.89.201.0/24';
/** The label the proxy container carries, naming the config it was started
 * with — so a changed allowlist is a restart and an unchanged one is not. */
export const CONFIG_LABEL = 'agent-egress-config';

/** Hosts the CLI cannot work without. Never configurable away. */
export const REQUIRED_HOSTS = Object.freeze([
  'api.anthropic.com',
  'platform.claude.com',
  'claude.ai',
  'claude.com',
]);

/** A coding agent's working set. Extended by AGENT_HUB_SANDBOX_EGRESS_ALLOW. */
export const DEFAULT_HOSTS = Object.freeze([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
]);

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * The proxy's address on the internal network: the second host of the subnet,
 * because netavark keeps the first for the gateway.
 * @param {string} subnet
 */
export function proxyAddress(subnet) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(subnet);
  if (!m || Number(m[5]) > 30) throw new Error(`not a usable egress subnet: ${subnet}`);
  return `${m[1]}.${m[2]}.${m[3]}.${Number(m[4]) + 2}`;
}

/**
 * Every host a session may reach: the required four, the working set, and
 * whatever the box added — validated as hostnames, deduplicated, sorted so the
 * config hashes the same whatever order somebody typed them in.
 *
 * @param {{ sandboxEgressAllow?: string[] }} cfg
 * @returns {{ hosts: string[], refused: string[] }}
 */
export function allowlistFor(cfg) {
  const refused = [];
  const set = new Set([...REQUIRED_HOSTS, ...DEFAULT_HOSTS]);
  for (const raw of cfg.sandboxEgressAllow ?? []) {
    const host = String(raw).trim().toLowerCase();
    if (!host) continue;
    if (!HOST_RE.test(host)) {
      refused.push(host);
      continue;
    }
    set.add(host);
  }
  return { hosts: [...set].sort(), refused };
}

/**
 * tinyproxy's configuration for one allowlist.
 *
 * CONNECT to 443 and nothing else: no plain HTTP through the proxy, because a
 * request the proxy could read is a request it could be made to rewrite, and
 * the CLI speaks TLS to everything on its list. `FilterType fixed` matches the
 * whole hostname exactly, so `evil-api.anthropic.com.attacker.net` does not
 * match `api.anthropic.com` the way a substring filter would.
 *
 * @param {string[]} hosts
 * @param {{ port?: number }} [opts]
 */
export function proxyConfig(hosts, { port = PROXY_PORT } = {}) {
  return [
    '# Written by agent-hub. Edit AGENT_HUB_SANDBOX_EGRESS_ALLOW instead; this file is regenerated.',
    `Port ${port}`,
    'Listen 0.0.0.0',
    'Timeout 600',
    'MaxClients 64',
    'DisableViaHeader Yes',
    'LogLevel Info',
    // The internal network is the only way to reach this listener, and it
    // has no route in from anywhere else — but a proxy that answers anybody
    // is still the wrong default, so the private ranges podman hands out are
    // named and nothing else is.
    'Allow 10.0.0.0/8',
    'Allow 172.16.0.0/12',
    'Allow 192.168.0.0/16',
    'ConnectPort 443',
    'FilterType fixed',
    'FilterCaseSensitive No',
    'FilterURLs No',
    'FilterDefaultDeny Yes',
    'Filter /etc/tinyproxy/allow.list',
    '',
  ].join('\n');
}

/**
 * The environment a session gets, so every HTTPS client in it goes through
 * the proxy. `NO_PROXY` keeps loopback direct, which is where nothing listens
 * in a session anyway; the CLI never sends loopback through a proxy on its own
 * account (its network page says so), and other tools in the session should
 * not either.
 *
 * @param {{ sandboxEgress?: string, sandboxEgressSubnet?: string }} cfg
 * @returns {string[]}  `podman run` arguments, empty when egress is open
 */
export function egressArgs(cfg) {
  if (cfg.sandboxEgress !== 'allowlist') return [];
  const proxy = `http://${proxyAddress(cfg.sandboxEgressSubnet ?? DEFAULT_SUBNET)}:${PROXY_PORT}`;
  return [
    '--network', EGRESS_NETWORK,
    '-e', `HTTPS_PROXY=${proxy}`,
    '-e', `HTTP_PROXY=${proxy}`,
    '-e', `https_proxy=${proxy}`,
    '-e', `http_proxy=${proxy}`,
    '-e', 'NO_PROXY=localhost,127.0.0.1,::1',
    '-e', 'no_proxy=localhost,127.0.0.1,::1',
  ];
}

/**
 * Make the network and the proxy exist, with the current allowlist, before a
 * session is put on them.
 *
 * Idempotent and cheap when nothing changed: an existing network is left as
 * it is, and a running proxy whose config label matches the config on disk
 * is left running. A changed allowlist replaces the proxy container — which
 * drops the live CONNECT tunnels of every running session for a second, and
 * that is the honest cost of changing what a fleet may reach.
 *
 * NEVER TOUCHES A SESSION VOLUME, so it carries no --userns: the proxy is the
 * box's, not a session's, and it reads a config file the service user wrote.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {Promise<{ ok: boolean, message?: string, proxy?: string, hosts?: string[] }>}
 */
export async function ensureEgress(cfg) {
  if (cfg.sandboxEgress !== 'allowlist') return { ok: true };
  const subnet = cfg.sandboxEgressSubnet || DEFAULT_SUBNET;
  const { hosts, refused } = allowlistFor(cfg);
  for (const r of refused) log.warn(`egress: ignoring "${r}" in AGENT_HUB_SANDBOX_EGRESS_ALLOW — not a hostname`);

  // The network, once.
  if (podman(cfg, ['network', 'inspect', EGRESS_NETWORK]).status !== 0) {
    const made = podman(cfg, ['network', 'create', '--internal', '--subnet', subnet, EGRESS_NETWORK]);
    if (made.status !== 0) return { ok: false, message: `could not create the ${EGRESS_NETWORK} network: ${made.stderr.trim().slice(0, 200)}` };
    log.info(`egress: created the internal network ${EGRESS_NETWORK} (${subnet})`);
  }

  // The config on disk, and its hash — the label the container carries.
  const dir = path.join(cfg.stateDir, 'egress');
  const conf = path.join(dir, 'tinyproxy.conf');
  const allow = path.join(dir, 'allow.list');
  const confText = proxyConfig(hosts);
  const allowText = `${hosts.join('\n')}\n`;
  const digest = createHash('sha256').update(confText).update('\n--\n').update(allowText).digest('hex').slice(0, 16);
  try {
    // Readable by the proxy's own user inside the container, which is not the
    // service user: nothing here is secret — it is a list of public hostnames.
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    if (!existsSync(conf) || readFileSync(conf, 'utf8') !== confText) writeFileSync(conf, confText, { mode: 0o644 });
    if (!existsSync(allow) || readFileSync(allow, 'utf8') !== allowText) writeFileSync(allow, allowText, { mode: 0o644 });
  } catch (e) {
    return { ok: false, message: `could not write the egress config under ${dir}: ${/** @type {Error} */ (e).message}` };
  }

  // The proxy, if it is not already the one this config describes.
  const running = podman(cfg, ['container', 'inspect', '--format', `{{.State.Running}} {{index .Config.Labels "${CONFIG_LABEL}"}}`, PROXY_CONTAINER]);
  if (running.status === 0 && running.stdout.trim() === `true ${digest}`) {
    return { ok: true, proxy: `${proxyAddress(subnet)}:${PROXY_PORT}`, hosts };
  }
  const image = await ensureProxyImage(cfg);
  if (!image.ok) return image;
  if (running.status === 0) {
    log.info(`egress: the allowlist changed (${running.stdout.trim().split(' ')[1] || 'none'} → ${digest}) — replacing the proxy`);
    podman(cfg, ['rm', '-f', PROXY_CONTAINER]);
  }
  const started = podman(cfg, [
    'run', '-d', '--name', PROXY_CONTAINER,
    '--label', `${CONFIG_LABEL}=${digest}`,
    // Both networks: the internal one the sessions are on, with the fixed
    // address they are told about, and the default one, which is the only
    // way out. Named first so the address applies to it.
    '--network', `${EGRESS_NETWORK}:ip=${proxyAddress(subnet)}`,
    '--network', 'podman',
    '--restart', 'unless-stopped',
    '-v', `${conf}:/etc/tinyproxy/tinyproxy.conf:ro`,
    '-v', `${allow}:/etc/tinyproxy/allow.list:ro`,
    cfg.sandboxEgressImage,
  ]);
  if (started.status !== 0) {
    return { ok: false, message: `could not start the egress proxy: ${started.stderr.trim().slice(0, 300)}` };
  }
  log.info(`egress: proxy ${PROXY_CONTAINER} up at ${proxyAddress(subnet)}:${PROXY_PORT}, ${hosts.length} hosts allowed`);
  return { ok: true, proxy: `${proxyAddress(subnet)}:${PROXY_PORT}`, hosts };
}

/**
 * The proxy image: built from sandbox/egress/Containerfile when it names
 * `localhost/`, pulled otherwise — the same rule the session image follows.
 * @param {import('../config.js').Config} cfg
 */
async function ensureProxyImage(cfg) {
  const image = cfg.sandboxEgressImage;
  if (podman(cfg, ['image', 'inspect', image]).status === 0) return { ok: true };
  if (!image.startsWith('localhost/')) {
    const pulled = await podmanAsync(cfg, ['pull', image]);
    return pulled.status === 0 ? { ok: true } : { ok: false, message: `could not pull ${image}: ${pulled.stderr.trim().slice(0, 300)}` };
  }
  const file = cfg.sandboxEgressContainerfile;
  if (!existsSync(file)) return { ok: false, message: `the egress proxy image ${image} is not built and ${file} does not exist` };
  log.warn(`egress: ${image} is not built — building it now`);
  const built = await podmanAsync(cfg, ['build', '-t', image, '-f', file, path.dirname(file)], { timeout: 10 * 60_000 });
  if (built.status !== 0) {
    const tail = String(built.stderr || built.stdout || '').trim().split('\n').slice(-6).join('\n');
    return { ok: false, message: `could not build ${image}:\n${tail}` };
  }
  return { ok: true };
}
