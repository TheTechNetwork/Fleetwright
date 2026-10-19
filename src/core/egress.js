// Where a session may reach, when the box says so.
//
// docs/security.md SEC-SESSION-4: egress from a session is OPEN by design
// today, and SEC-INJECT-2 says the fix is a default-deny egress through a
// named allowlist — and that it is not built. This is it, opt-in:
//
//   FLEETWRIGHT_SANDBOX_EGRESS=allowlist
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
// ONE INTERNAL NETWORK PER PERSON, not one per box (docs/security.md G9).
// "Exactly the other containers on it" was the problem: every allowlisted
// session on a box joined one `agent-egress`, so anybody's session could open
// a connection to any port anybody else's was listening on — a dev server, a
// debugger, an MCP server bound to 0.0.0.0 — which the open default never
// allowed, because there each container has a network namespace of its own.
// Now a session joins `agent-egress-<ownerTag>`, keyed exactly as the
// person's download cache is (accounts.js ownerTag), and the one container on
// more than one of those networks is the proxy. Sessions of the same person
// share theirs, which is no more than their own /work already allows.
//
// THE PROXY DOES NOT JOIN THEM UP. A session's only route is its own subnet,
// and it holds no CAP_NET_ADMIN to add one through the proxy; the other side
// has no route back either. The proxy is started with forwarding off in its
// own namespace, said explicitly because a new namespace can inherit the
// host's setting and a podman host has it on. (A proxy started before this
// change runs without it until it is next replaced; the route and the
// capability above hold either way.) And its filter is hostnames, so a
// CONNECT to another network's address is refused like any other name that
// is not on the list.
//
// THE SUBNETS. FLEETWRIGHT_SANDBOX_EGRESS_SUBNET used to be the one network's
// subnet. It is now the FIRST person's: each network gets a subnet that size,
// counted upward from it, and the first that podman agrees is free — podman
// refuses one that overlaps any network it knows or any route on the host, so
// a refusal is the collision check and the next candidate is tried. The
// choice is recorded nowhere but podman: a person's network, once it exists,
// is read back with `podman network inspect`, and their proxy is always the
// second address of whatever subnet it has. Every candidate is kept inside
// the private ranges, which is what tinyproxy's Allow lines name.
//
// A BOX THAT ALREADY HAS `agent-egress` keeps it and stops using it: no new
// session joins it, and nothing here removes it, because sessions started
// before this change may still be on it. Its subnet is the default's first
// candidate, so podman refuses that one and the first person gets the next.
// The running proxy keeps its leg on the old network until it is next
// replaced, so those sessions keep their way out until they restart onto
// their own. `podman network rm agent-egress` once nothing is on it.
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
// would make the feature one nobody turns on. FLEETWRIGHT_SANDBOX_EGRESS_ALLOW
// extends it; nothing removes the required four.
//
// NOT MEASURED ON HARDWARE. Every podman call below is one the manual
// documents, and the proxy config is tinyproxy's own grammar, but this box has
// no podman and the container that would prove it does not run in CI. The
// test is a session on a box with the setting on: `curl https://example.com`
// refused by the proxy, `claude` signing in and answering. security.md
// SEC-INJECT-2 stays marked until that has been seen. For G9 add two people's
// sessions on one box, one listening on 0.0.0.0, and the other unable to
// reach it while both still reach the proxy.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { ownerTag } from './accounts.js';
import { podman, podmanAsync } from './podman.js';

/** Every person's internal network is this and their ownerTag. Each is created
 * once and never removed by this code. */
const NETWORK_PREFIX = 'agent-egress-';
/** The proxy container, on every person's internal network and the default one. */
export const PROXY_CONTAINER = 'agent-egress-proxy';
/** Where the proxy listens, inside the internal networks. */
export const PROXY_PORT = 3128;
/** The first person's subnet, and the size of everybody's: the proxy's address
 * on each network is fixed by it, so no session depends on name resolution to
 * find its only way out. */
export const DEFAULT_SUBNET = '10.89.201.0/24';
/** How many subnets are tried, counting up, before a box says it has none
 * free: enough for every person a box serves and the networks it already has. */
const SUBNET_TRIES = 64;
/** The ranges every person's subnet is kept inside, and that tinyproxy allows. */
const PRIVATE_RANGES = [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]];
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

/** A coding agent's working set. Extended by FLEETWRIGHT_SANDBOX_EGRESS_ALLOW. */
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
 * @typedef {{ network?: string, proxy?: string }} EgressRoute
 *   the internal network a session joins, and its proxy's `address:port`
 *   there: both set by ensureEgress under an allowlist, neither when open
 */

/** @param {string} ip */
const ipToInt = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
/** @param {number} n */
const intToIp = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

/**
 * A subnet as its first address and its size, aligned to that size.
 * @param {string} subnet
 */
function parseSubnet(subnet) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(subnet).trim());
  const prefix = Number(m?.[5]);
  if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || prefix < 8 || prefix > 30) {
    throw new Error(`not a usable egress subnet: ${subnet}`);
  }
  const size = 2 ** (32 - prefix);
  return { start: Math.floor(ipToInt(`${m[1]}.${m[2]}.${m[3]}.${m[4]}`) / size) * size, size, prefix };
}

/**
 * The proxy's address on an internal network: the second host of the subnet,
 * because netavark keeps the first for the gateway.
 * @param {string} subnet
 */
export function proxyAddress(subnet) {
  return intToIp(parseSubnet(subnet).start + 2);
}

/**
 * The internal network one person's sessions join.
 * @param {string|null} owner  an actor (`fleet:<email>`) or an email
 */
function egressNetworkFor(owner) {
  return `${NETWORK_PREFIX}${ownerTag(owner)}`;
}

/**
 * The i-th candidate subnet counted up from the configured one, or null once
 * the count leaves the private ranges tinyproxy is told to allow.
 * @param {string} first @param {number} i
 */
function candidateSubnet(first, i) {
  const { start, size, prefix } = parseSubnet(first);
  const at = start + i * size;
  const inside = PRIVATE_RANGES.some(([base, bits]) => {
    const lo = ipToInt(String(base));
    return at >= lo && at + size <= lo + 2 ** (32 - Number(bits));
  });
  return inside ? `${intToIp(at)}/${prefix}` : null;
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
 * the CLI speaks TLS to everything on its list.
 *
 * EXACT HOSTNAMES, AS ANCHORED EXTENDED REGEXES (allowListText). This said
 * `FilterType fixed` and claimed exact matching, but tinyproxy knows only
 * `bre`, `ere` and `fnmatch`: 1.11's parser calls anything else a syntax error
 * and the proxy does not start, so an allowlisted box had no way out at all
 * (seventh audit), and had it started, its regexes match anywhere in the host.
 *
 * THE FILTER PATH IS QUOTED, for the same parser: conf.c reads `Filter` as a
 * double-quoted string, and an unquoted path is a syntax error on that line.
 * This wrote it bare until the proxy was first run on real podman (podman
 * 4.9.3, tinyproxy 1.11.3 from sandbox/egress/Containerfile), where it logged
 * "Syntax error on line 16", exited, and was restarted by `unless-stopped`
 * forever, so no allowlisted session had a way out; and each next launch saw
 * it not running and replaced it.
 *
 * @param {string[]} hosts
 * @param {{ port?: number }} [opts]
 */
export function proxyConfig(hosts, { port = PROXY_PORT } = {}) {
  return [
    '# Written by fleetwright. Edit FLEETWRIGHT_SANDBOX_EGRESS_ALLOW instead; this file is regenerated.',
    `Port ${port}`,
    'Listen 0.0.0.0',
    'Timeout 600',
    'MaxClients 64',
    'DisableViaHeader Yes',
    'LogLevel Info',
    // The internal networks are the only way to reach this listener, and
    // they have no route in from anywhere else — but a proxy that answers
    // anybody is still the wrong default, so the private ranges are named and
    // nothing else is. candidateSubnet keeps every person's network inside
    // them, which is what keeps these three lines right whatever was chosen.
    'Allow 10.0.0.0/8',
    'Allow 172.16.0.0/12',
    'Allow 192.168.0.0/16',
    'ConnectPort 443',
    'FilterType ere',
    'FilterCaseSensitive No',
    'FilterURLs No',
    'FilterDefaultDeny Yes',
    'Filter "/etc/tinyproxy/allow.list"',
    '',
  ].join('\n');
}

/**
 * The filter file: one line per host, anchored at both ends and with its dots
 * escaped, so `api.anthropic.com` matches that host and not
 * `api.anthropic.com.attacker.net` or `apiXanthropic.com`. HOST_RE has already
 * kept everything but letters, digits, dots and hyphens out; every other
 * regex character is escaped all the same, so the line is a literal whatever
 * a later change lets through.
 *
 * @param {string[]} hosts
 */
export function allowListText(hosts) {
  return hosts.map((h) => `^${h.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$\n`).join('');
}

/**
 * The network a session joins and the environment it gets, so every HTTPS
 * client in it goes through its owner's proxy. `NO_PROXY` keeps loopback
 * direct, which is where nothing listens in a session anyway; the CLI never
 * sends loopback through a proxy on its own account (its network page says
 * so), and other tools in the session should not either.
 *
 * The route is what ensureEgress returned for the session's owner, because
 * only podman knows which subnet that person's network got. Without one an
 * allowlisted launch THROWS: there is no network a session could be put on
 * that would not be either nobody's way out or somebody else's.
 *
 * @param {{ sandboxEgress?: string }} cfg
 * @param {EgressRoute|null} [route]
 * @returns {string[]}  `podman run` arguments, empty when egress is open
 */
export function egressArgs(cfg, route = null) {
  if (cfg.sandboxEgress !== 'allowlist') return [];
  if (!route?.network || !route.proxy) throw new Error('an allowlisted session needs the route ensureEgress gave its owner');
  const proxy = `http://${route.proxy}`;
  return [
    '--network', route.network,
    '-e', `HTTPS_PROXY=${proxy}`,
    '-e', `HTTP_PROXY=${proxy}`,
    '-e', `https_proxy=${proxy}`,
    '-e', `http_proxy=${proxy}`,
    '-e', 'NO_PROXY=localhost,127.0.0.1,::1',
    '-e', 'no_proxy=localhost,127.0.0.1,::1',
  ];
}

/**
 * Make the owner's network and the proxy exist, with the current allowlist,
 * before a session is put on them, and say where that session's way out is.
 *
 * Idempotent and cheap when nothing changed: two podman calls, the same as
 * when there was one network. An existing network is read back as it is; a
 * running proxy whose config label matches the config on disk is left
 * running, and joined to this person's network with `podman network connect`
 * if it is not on it yet, which touches no other person's tunnels. A changed
 * allowlist replaces the proxy container — which drops the live CONNECT
 * tunnels of every running session for a second, and that is the honest cost
 * of changing what a fleet may reach — and the new one is put back on every
 * person's network at the address their sessions were told.
 *
 * NEVER TOUCHES A SESSION VOLUME, so it carries no --userns: the proxy is the
 * box's, not a session's, and it reads a config file the service user wrote.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string|null} [owner]  whose session this is: an actor or an email
 * @returns {Promise<EgressRoute & { ok: boolean, message?: string, hosts?: string[] }>}
 */
export async function ensureEgress(cfg, owner = null) {
  if (cfg.sandboxEgress !== 'allowlist') return { ok: true };
  const { hosts, refused } = allowlistFor(cfg);
  for (const r of refused) log.warn(`egress: ignoring "${r}" in FLEETWRIGHT_SANDBOX_EGRESS_ALLOW — not a hostname`);

  // This person's network, once.
  const own = ensureOwnerNetwork(cfg, egressNetworkFor(owner));
  if (!own.ok) return own;
  const leg = { network: own.network, ip: proxyAddress(own.subnet) };
  const route = { network: leg.network, proxy: `${leg.ip}:${PROXY_PORT}` };

  // The config on disk, and its hash — the label the container carries.
  const dir = path.join(cfg.stateDir, 'egress');
  const conf = path.join(dir, 'tinyproxy.conf');
  const allow = path.join(dir, 'allow.list');
  const confText = proxyConfig(hosts);
  const allowText = allowListText(hosts);
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

  // The proxy, if it is already the one this config describes: on this
  // person's network too, or joined to it now.
  const seen = podman(cfg, ['container', 'inspect', '--format', `{{.State.Running}}|{{index .Config.Labels "${CONFIG_LABEL}"}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}`, PROXY_CONTAINER]);
  const [running = '', label = '', networks = ''] = seen.stdout.trim().split('|');
  if (seen.status === 0 && running === 'true' && label === digest) {
    if (networks.split(/\s+/).includes(leg.network)) return { ok: true, ...route, hosts };
    const joined = podman(cfg, ['network', 'connect', '--ip', leg.ip, leg.network, PROXY_CONTAINER]);
    // Somebody else's launch for the same person can have joined it first.
    if (joined.status !== 0 && !/already connected/i.test(joined.stderr)) {
      return { ok: false, message: `could not put the egress proxy on ${leg.network}: ${joined.stderr.trim().slice(0, 300)}` };
    }
    log.info(`egress: proxy ${PROXY_CONTAINER} joined ${leg.network} at ${leg.ip}`);
    return { ok: true, ...route, hosts };
  }
  const image = await ensureProxyImage(cfg);
  if (!image.ok) return image;
  if (seen.status === 0) {
    log.info(`egress: the allowlist changed (${label || 'none'} → ${digest}) — replacing the proxy`);
    podman(cfg, ['rm', '-f', PROXY_CONTAINER]);
  }
  const started = podman(cfg, [
    'run', '-d', '--name', PROXY_CONTAINER,
    '--label', `${CONFIG_LABEL}=${digest}`,
    // Every person's internal network, each at the address their sessions
    // were told, and the default one, which is the only way out.
    ...everyLeg(cfg, leg).flatMap((l) => ['--network', `${l.network}:ip=${l.ip}`]),
    '--network', 'podman',
    // See "THE PROXY DOES NOT JOIN THEM UP" above.
    '--sysctl', 'net.ipv4.ip_forward=0',
    '--restart', 'unless-stopped',
    '-v', `${conf}:/etc/tinyproxy/tinyproxy.conf:ro`,
    '-v', `${allow}:/etc/tinyproxy/allow.list:ro`,
    cfg.sandboxEgressImage,
  ]);
  if (started.status !== 0) {
    return { ok: false, message: `could not start the egress proxy: ${started.stderr.trim().slice(0, 300)}` };
  }
  log.info(`egress: proxy ${PROXY_CONTAINER} up, ${leg.network} at ${leg.ip}, ${hosts.length} hosts allowed`);
  return { ok: true, ...route, hosts };
}

/**
 * The subnet a network has, from podman, or null when there is no such network.
 * @param {import('../config.js').Config} cfg @param {string} network
 */
function subnetOf(cfg, network) {
  const r = podman(cfg, ['network', 'inspect', '--format', '{{range .Subnets}}{{.Subnet}} {{end}}', network]);
  if (r.status !== 0) return null;
  return /\b\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}\b/.exec(r.stdout)?.[0] ?? '';
}

/**
 * One person's internal network: read back when it exists, created on the
 * first subnet podman agrees is free when it does not.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} network
 * @returns {{ ok: true, network: string, subnet: string } | { ok: false, message: string }}
 */
function ensureOwnerNetwork(cfg, network) {
  const have = subnetOf(cfg, network);
  if (have !== null) return usableNetwork(network, have);
  const first = cfg.sandboxEgressSubnet || DEFAULT_SUBNET;
  try { parseSubnet(first); } catch (e) { return { ok: false, message: /** @type {Error} */ (e).message }; }
  for (let i = 0; i < SUBNET_TRIES; i++) {
    const subnet = candidateSubnet(first, i);
    if (!subnet) break;
    const made = podman(cfg, ['network', 'create', '--internal', '--subnet', subnet, network]);
    if (made.status === 0) {
      log.info(`egress: created the internal network ${network} (${subnet})`);
      return usableNetwork(network, subnet);
    }
    // Two launches for one person at once: the other one made it.
    const raced = subnetOf(cfg, network);
    if (raced !== null) return usableNetwork(network, raced);
    // Podman's words for an overlap with a network it knows or a host route.
    if (!/subnet .*already used|overlap/i.test(made.stderr)) {
      return { ok: false, message: `could not create the ${network} network: ${made.stderr.trim().slice(0, 200)}` };
    }
  }
  return { ok: false, message: `no free subnet for ${network}: the private ones counted up from ${first} are all taken — set FLEETWRIGHT_SANDBOX_EGRESS_SUBNET somewhere free` };
}

/**
 * A network this code can put the proxy on: an IPv4 subnet with a second
 * address. Anything else under the name was not made here.
 *
 * @param {string} network @param {string} subnet
 * @returns {{ ok: true, network: string, subnet: string } | { ok: false, message: string }}
 */
function usableNetwork(network, subnet) {
  try {
    proxyAddress(subnet);
    return { ok: true, network, subnet };
  } catch {
    return { ok: false, message: `the ${network} network has no usable IPv4 subnet (${subnet || 'none'}) — remove it and it is made again` };
  }
}

/**
 * Every person's network the proxy belongs on, with its address there: this
 * one, and whatever others exist, so a replaced proxy is back where every
 * running session was told it is. A network whose subnet cannot be read is
 * left off with a warning rather than failing this person's start.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ network: string, ip: string }} leg
 */
function everyLeg(cfg, leg) {
  const listed = podman(cfg, ['network', 'ls', '--format', '{{.Name}}']);
  const names = listed.status === 0 ? listed.stdout.split('\n').map((n) => n.trim()) : [];
  const legs = [leg];
  for (const network of new Set(names.filter((n) => n.startsWith(NETWORK_PREFIX) && n !== leg.network))) {
    const subnet = subnetOf(cfg, network);
    try {
      legs.push({ network, ip: proxyAddress(String(subnet)) });
    } catch {
      log.warn(`egress: ${network} has no usable subnet (${subnet || 'none'}) — the proxy is not on it, so its sessions have no way out`);
    }
  }
  return legs;
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
