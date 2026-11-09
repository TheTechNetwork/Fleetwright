// A web view on a phone whose connections leave from this box: this box's
// half. The coordinator's is src/fleet/coordinator/browse.js, which says the
// shape; docs/browse.md says why.
//
// WHAT THIS IS: a switchboard of lengths of wire, one per connection the web
// view makes, and the ONE PLACE that decides where each may go. The
// coordinator is the party this project treats as compromised, so nothing it
// sends is taken as permission: it names a person, a session, and whether the
// box's own rules apply, and every connection is held to what this box's
// owner wrote in its env file and to what the hub says of the session.
//
// WHERE A CONNECTION MAY GO (decideBrowse), in order:
//
//   1. `localhost` is the session's, on any port, and only on a socket opened
//      on one. The hub dials it inside that session's container
//      (src/core/session-port.js), because the container is the hub's and
//      this process runs as its own user. Never this box's own loopback,
//      which is the hub, the sidecar and every service on it.
//   2. A name this box lists, as this box's resolver answers it.
//   3. Any other name is resolved HERE, once, and the box connects to the
//      address it got: a name that resolves to a private address the second
//      time a proxy asks is the trick DNS rebinding plays, and there is no
//      second time. An address inside a range this box lists.
//   4. A public address on 80 or 443, when the owner turned the web on.
//   5. Nothing else, and never one of this box's own addresses.
//
// Rules 2 to 4 only on a socket the coordinator opened for somebody who
// administers this box, and never for somebody this box does not pin when it
// pins its admins (pinned-admins.js).
//
// WHAT THE COORDINATOR CAN DO TO THIS ONE: what the owner turned on. Pages on
// the names they listed and on the public web, from this box's address, and a
// person's own session's ports when the hub agrees the session is theirs.

import net from 'node:net';
import dns from 'node:dns';
import os from 'node:os';

/** The largest piece one frame carries, before base64: the coordinator's bound. */
export const BROWSE_CHUNK = 48 * 1024;
/** Connections this box carries at once, across every phone. */
export const MAX_BOX_STREAMS = 64;
/** A connection that has carried nothing for this long is closed here. */
const IDLE_MS = 30 * 60_000;
/** How long a name may take to resolve here. */
const LOOKUP_MS = 10_000;
/**
 * How many bytes of one connection may be on their way to the phone before
 * the phone has said it has them. Past it the box stops reading that
 * connection until the phone acknowledges: without it a page served at LAN
 * speed to a phone on a slow link piled up in the sockets between, the
 * coordinator's among them. 128 KiB a connection is 4 MiB a page at most.
 */
export const BROWSE_WINDOW = 128 * 1024;
/** The ports the public web is opened on. */
export const WEB_PORTS = Object.freeze([80, 443]);
const ID_RE = /^[0-9a-f]{24}$/;
const STREAM_RE = /^[1-9][0-9]{0,8}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const NAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The names `localhost` goes by. A web view asks for any of them; each is the
 * session's on a socket opened on one, and nobody's otherwise.
 *
 * @param {string} host
 */
export function isLocalName(host) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

// --- public, and not ---------------------------------------------------------

/**
 * Every range that is not the public internet, IPv4 and IPv6: loopback,
 * private, shared (CGNAT), link-local, documentation, benchmarking, multicast,
 * reserved, and the IPv6 forms that carry an IPv4 address or a tunnel. From
 * the IANA special-purpose registries; what is left is the web.
 */
const NOT_PUBLIC_V4 = (() => {
  const list = new net.BlockList();
  for (const [a, p] of /** @type {Array<[string, number]>} */ ([
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ])) list.addSubnet(a, p, 'ipv4');
  return list;
})();

/**
 * IPv6 IS PUBLIC ONLY INSIDE 2000::/3, the global unicast block, and outside
 * the special ranges carved from it. Everything below it (unspecified,
 * loopback, the IPv4 forms) and above it (unique local, link-local,
 * multicast) is not, so it is a list of what may be rather than of what may
 * not.
 *
 * TWO LISTS AND NOT ONE, on purpose: Node's BlockList matches an IPv4
 * address against an IPv4-mapped IPv6 rule, so a `::ffff:0:0/96` in a shared
 * list called every IPv4 address private. A mapped address is turned into its
 * IPv4 form before either list is asked (plainAddress).
 */
const GLOBAL_V6 = (() => {
  const list = new net.BlockList();
  list.addSubnet('2000::', 3, 'ipv6');
  return list;
})();
const NOT_PUBLIC_V6 = (() => {
  const list = new net.BlockList();
  for (const [a, p] of /** @type {Array<[string, number]>} */ ([
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ])) list.addSubnet(a, p, 'ipv6');
  return list;
})();

/**
 * The eight hextets of an IPv6 address, or null. Any spelling: compressed,
 * zero-padded, written out, or with an IPv4 address in its last 32 bits.
 *
 * @param {string} a
 * @returns {number[]|null}
 */
function hextets(a) {
  if (net.isIPv6(a) === false) return null;
  let text = a.toLowerCase();
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    text = `${text.slice(0, -dotted[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const left = head ? head.split(':') : [];
  const right = tail === null ? [] : tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - left.length - right.length;
  const all = [...left, ...Array(Math.max(0, fill)).fill('0'), ...right];
  if (all.length !== 8) return null;
  return all.map((h) => parseInt(h, 16));
}

/**
 * An address as the family it really is: an IPv4 address written inside IPv6
 * (`::ffff:10.0.0.1`, or `::ffff:a00:1`, which is the same address in hex) is
 * that IPv4 address, or a range check on its IPv6 form would call a private
 * address public, and a check of the box's own addresses would miss it.
 *
 * @param {string} address
 * @returns {{ address: string, family: 4|6 }|null}
 */
export function plainAddress(address) {
  const a = address.replace(/^\[(.*)\]$/, '$1');
  if (net.isIPv4(a)) return { address: a, family: 4 };
  if (!net.isIPv6(a)) return null;
  const h = hextets(a);
  if (h && h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return { address: [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join('.'), family: 4 };
  }
  return { address: a, family: 6 };
}

/**
 * Is this address on the public internet?
 *
 * @param {string} address
 */
export function isPublicAddress(address) {
  const plain = plainAddress(address);
  if (!plain) return false;
  if (plain.family === 4) return !NOT_PUBLIC_V4.check(plain.address, 'ipv4');
  return GLOBAL_V6.check(plain.address, 'ipv6') && !NOT_PUBLIC_V6.check(plain.address, 'ipv6');
}

/**
 * What this box is, and the networks it sits on, as ranges checked by
 * number rather than by spelling: `2a02:1234:0:0:0:0:0:5` is the box at
 * `2a02:1234::5`, and comparing the two as text called it somewhere else.
 *
 * `self` is never opened, whatever is listed: every address of this box's
 * own, loopback, and the unspecified addresses, which a connect sends to
 * this box. `onLink` is the networks those addresses are on, which the web
 * rule leaves out: on an IPv6 network the neighbours of a box have global
 * addresses too, and are its owner's network, not the web.
 *
 * @param {{ addresses?: string[], networks?: string[] }} [own]
 */
export function ownRanges(own = {}) {
  const self = new net.BlockList();
  self.addSubnet('127.0.0.0', 8, 'ipv4');
  self.addSubnet('0.0.0.0', 8, 'ipv4');
  self.addAddress('::1', 'ipv6');
  self.addAddress('::', 'ipv6');
  const onLink = new net.BlockList();
  for (const a of own.addresses ?? []) {
    const plain = plainAddress(a);
    if (plain) self.addAddress(plain.address, plain.family === 4 ? 'ipv4' : 'ipv6');
  }
  for (const cidr of own.networks ?? []) {
    const [addr, bits] = String(cidr).split('/');
    const plain = plainAddress(addr || '');
    const prefix = Number(bits);
    if (!plain || !Number.isInteger(prefix)) continue;
    const max = plain.family === 4 ? 32 : 128;
    // A host route (/32, /128) says nothing about who else is on the link.
    if (prefix < 1 || prefix >= max) continue;
    try {
      onLink.addSubnet(plain.address, prefix, plain.family === 4 ? 'ipv4' : 'ipv6');
    } catch { /* not a range BlockList takes */ }
  }
  /** @param {net.BlockList} list @param {string} address */
  const has = (list, address) => {
    const plain = plainAddress(address);
    return Boolean(plain) && list.check(/** @type {any} */ (plain).address, /** @type {any} */ (plain).family === 4 ? 'ipv4' : 'ipv6');
  };
  return {
    /** @param {string} address */ self: (address) => has(self, address),
    /** @param {string} address */ onLink: (address) => has(onLink, address),
  };
}

// --- what the owner listed ----------------------------------------------------

/**
 * @typedef {object} BrowseEntry
 * @property {string} raw  as the owner wrote it, which is what a phone is shown
 * @property {'name'|'range'} kind
 * @property {string} [name]
 * @property {net.BlockList} [range]
 * @property {number|null} port  null is 80 and 443
 */

/**
 * FLEETWRIGHT_BROWSE_HOSTS, one entry at a time: a name (`nas.lan`), an
 * address (`192.168.1.10`, `[fd00::10]`) or a range (`192.168.1.0/24`,
 * `[fd00::/64]`), each with `:port` or without, which is 80 and 443. IPv6
 * takes brackets when it has a port, and may go without them when it has
 * none.
 *
 * @param {string[]} items
 * @returns {{ entries: BrowseEntry[], bad: string[] }}
 */
export function parseBrowseHosts(items) {
  /** @type {BrowseEntry[]} */
  const entries = [];
  /** @type {string[]} */
  const bad = [];
  for (const item of items) {
    const raw = String(item).trim();
    if (!raw) continue;
    const parsed = parseEntry(raw);
    if (parsed) entries.push(parsed);
    else bad.push(raw);
  }
  return { entries, bad };
}

/** @param {string} raw @returns {BrowseEntry|null} */
function parseEntry(raw) {
  if (raw.length > 120) return null;
  let target = raw;
  /** @type {number|null} */
  let port = null;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(raw);
  if (bracketed) {
    target = bracketed[1];
    if (bracketed[2] !== undefined) port = Number(bracketed[2]);
  } else if (!raw.includes('::') && (raw.match(/:/g) || []).length === 1) {
    const at = raw.lastIndexOf(':');
    target = raw.slice(0, at);
    if (!/^\d{1,5}$/.test(raw.slice(at + 1))) return null;
    port = Number(raw.slice(at + 1));
  }
  if (port !== null && (port < 1 || port > 65535)) return null;
  const slash = target.indexOf('/');
  const addressPart = slash >= 0 ? target.slice(0, slash) : target;
  const plain = plainAddress(addressPart);
  if (plain) {
    const max = plain.family === 4 ? 32 : 128;
    const prefixText = slash >= 0 ? target.slice(slash + 1) : String(max);
    if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > max) return null;
    const range = new net.BlockList();
    try {
      range.addSubnet(plain.address, Number(prefixText), plain.family === 4 ? 'ipv4' : 'ipv6');
    } catch {
      return null;
    }
    return { raw, kind: 'range', range, port };
  }
  if (slash >= 0) return null;
  const name = target.toLowerCase().replace(/\.$/, '');
  if (!NAME_RE.test(name) || isLocalName(name)) return null;
  return { raw, kind: 'name', name, port };
}

/** @param {BrowseEntry} entry @param {number} port */
function portFits(entry, port) {
  return entry.port === null ? WEB_PORTS.includes(port) : entry.port === port;
}

/** @param {BrowseEntry} entry @param {string} address */
function inRange(entry, address) {
  const plain = plainAddress(address);
  if (!plain || !entry.range) return false;
  return entry.range.check(plain.address, plain.family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * This box's own addresses on every interface, and the networks they are on
 * (ownRanges says what each is used for).
 *
 * @returns {{ addresses: string[], networks: string[] }}
 */
export function ownAddresses() {
  /** @type {string[]} */
  const addresses = [];
  /** @type {string[]} */
  const networks = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      const address = String(i.address).split('%')[0];
      if (plainAddress(address)) addresses.push(address);
      if (!i.internal && i.cidr) networks.push(String(i.cidr).split('%')[0]);
    }
  }
  return { addresses, networks };
}

/**
 * @typedef {{ to: 'session', port: number } | { to: 'tcp', host: string, port: number } | { refused: string }} BrowseDecision
 */

/**
 * Where one connection may go. Pure but for `lookup`.
 *
 * @param {{
 *   host: string, port: number,
 *   session: string|null,
 *   box: boolean,
 *   policy: { web: boolean, entries: BrowseEntry[] },
 *   lookup: (name: string) => Promise<string[]>,
 *   own?: { addresses?: string[], networks?: string[] },
 *   lookupMs?: number,
 * }} ask
 * @returns {Promise<BrowseDecision>}
 */
export async function decideBrowse({ host, port, session, box, policy, lookup, own = {}, lookupMs = LOOKUP_MS }) {
  const name = String(host).toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (isLocalName(name)) {
    if (session) return { to: 'session', port };
    return { refused: 'This machine does not open its own addresses. Open a port from one of your sessions instead.' };
  }
  if (!box) {
    return {
      refused: session
        ? `${name} is not one of ${session}'s ports. Only people who administer this machine open other addresses through it.`
        : 'Only people who administer this machine open addresses through it.',
    };
  }
  const ranges = ownRanges(own);
  /** @param {string} address */
  const ours = (address) => ranges.self(address);

  // A NAME THE OWNER LISTED is theirs to mean what their resolver says.
  const named = policy.entries.filter((e) => e.kind === 'name' && e.name === name);
  if (named.length) {
    if (!named.some((e) => portFits(e, port))) {
      const ports = [...new Set(named.flatMap((e) => (e.port === null ? WEB_PORTS : [e.port])))].sort((a, b) => a - b);
      return { refused: `This machine opens ${name} only on ${ports.length > 1 ? `${ports.slice(0, -1).join(', ')} and ${ports.at(-1)}` : ports[0]}.` };
    }
    const addresses = await resolve(name, lookup, lookupMs);
    const usable = addresses.find((a) => !ours(a));
    if (!usable) return { refused: addresses.length ? `${name} is this machine itself, which it does not open.` : `${name} has no address this machine can find.` };
    return { to: 'tcp', host: /** @type {any} */ (plainAddress(usable)).address, port };
  }

  const addresses = await resolve(name, lookup, lookupMs);
  if (!addresses.length) return { refused: `${name} has no address this machine can find.` };
  let anyPrivate = false;
  let anyOwn = false;
  for (const address of addresses) {
    if (ours(address)) {
      anyOwn = true;
      continue;
    }
    const plain = /** @type {{ address: string }} */ (plainAddress(address));
    if (policy.entries.some((e) => e.kind === 'range' && inRange(e, address) && portFits(e, port))) return { to: 'tcp', host: plain.address, port };
    // THE WEB IS PUBLIC AND NOT THIS BOX'S OWN NETWORK: a neighbour with a
    // global IPv6 address is on the owner's network, opened only if listed.
    if (isPublicAddress(address) && !ranges.onLink(address)) {
      if (policy.web && WEB_PORTS.includes(port)) return { to: 'tcp', host: plain.address, port };
    } else {
      anyPrivate = true;
    }
  }
  if (anyOwn && !anyPrivate) return { refused: `${name} is this machine itself, which it does not open.` };
  if (anyPrivate) return { refused: `${name} is on a private address, which this machine opens only when its owner lists it.` };
  if (!policy.web) return { refused: `This machine opens only the addresses its owner listed, and ${name} is not one of them.` };
  return { refused: 'This machine opens the web on ports 80 and 443 only.' };
}

/**
 * Every address for a name, or the name itself when it is an address.
 *
 * @param {string} name @param {(name: string) => Promise<string[]>} lookup @param {number} [limitMs]
 */
async function resolve(name, lookup, limitMs = LOOKUP_MS) {
  const plain = plainAddress(name);
  if (plain) return [plain.address];
  /** @type {any} */
  let timer = null;
  try {
    // NOT FOR EVER: a resolver that does not answer is a page that does not
    // load, said, and not a connection slot held until the page is closed.
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve([]), limitMs);
      timer.unref?.();
    });
    const found = /** @type {string[]} */ (await Promise.race([lookup(name), late]));
    return found.filter((a) => plainAddress(a));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** The system resolver, every address. @param {string} name */
export async function systemLookup(name) {
  const found = await dns.promises.lookup(name, { all: true, verbatim: true });
  return found.map((f) => f.address);
}

// --- the switchboard ---------------------------------------------------------

/**
 * @typedef {{ write: (b: Buffer) => unknown, end: () => unknown, destroy: () => unknown, on: Function, once: Function, pause?: Function, resume?: Function, setTimeout?: Function }} Wire
 */

/**
 * @typedef {object} Socket
 * @property {string} owner
 * @property {string|null} session
 * @property {boolean} box
 * @property {Map<number, { wire: Wire|null, ended: boolean, credit: number }>} streams
 */

export class BrowseCarrier {
  /**
   * @param {{
   *   send: (frame: Record<string, unknown>) => unknown,
   *   policy: () => { web: boolean, entries: BrowseEntry[] },
   *   checkSession: (owner: string, session: string) => Promise<{ ok: true } | { ok: false, text: string }>,
   *   dialSession: (owner: string, session: string, port: number) => Promise<{ ok: true, wire: Wire } | { ok: false, text: string }>,
   *   pinned?: () => string[]|null,
   *   lookup?: (name: string) => Promise<string[]>,
   *   connect?: (opts: { host: string, port: number }) => net.Socket,
   *   own?: () => { addresses?: string[], networks?: string[] },
   *   connectTimeoutMs?: number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   * }} opts
   */
  constructor({ send, policy, checkSession, dialSession, pinned = () => [], lookup = systemLookup, connect = (o) => net.connect(o), own = ownAddresses, connectTimeoutMs = 15_000, log }) {
    // A FRAME THAT COULD NOT BE SENT is a page with a hole in it: the
    // socket to the coordinator dropped, and the bytes in between are gone.
    // That page is closed here, so its connections and their processes do
    // not wait out the idle timer, and the coordinator is told it is gone
    // the next time it names it.
    this.send = (/** @type {Record<string, unknown>} */ frame) => {
      const sent = send(frame);
      if (sent === false && typeof frame.browse === 'string' && this.sockets.has(frame.browse)) this.#closeSocket(frame.browse);
      return sent;
    };
    this.policy = policy;
    this.checkSession = checkSession;
    this.dialSession = dialSession;
    this.pinned = pinned;
    this.lookup = lookup;
    this.connect = connect;
    this.own = own;
    this.connectTimeoutMs = connectTimeoutMs;
    this.log = log || { info() {}, warn() {} };
    /** @type {Map<string, Socket>} */
    this.sockets = new Map();
  }

  /** Connections open or opening, across every socket. */
  get carried() {
    let n = 0;
    for (const s of this.sockets.values()) n += s.streams.size;
    return n;
  }

  /**
   * One frame from the coordinator. Never throws; anything it does not
   * understand is dropped.
   *
   * @param {any} msg
   */
  onFrame(msg) {
    const id = typeof msg?.browse === 'string' && ID_RE.test(msg.browse) ? msg.browse : null;
    if (!id) return;
    if (msg.op === 'open') return void this.#open(id, String(msg.owner || '').toLowerCase(), typeof msg.session === 'string' && msg.session ? msg.session : null, msg.box === true);
    if (msg.op === 'close') return this.#closeSocket(id);
    const socket = this.sockets.get(id);
    // A PAGE THIS BOX DOES NOT HAVE: it restarted, or closed it when a frame
    // could not be sent. Said, so the phone shows Open again instead of a
    // page whose connections are never answered.
    if (!socket) return void this.send({ browse: id, op: 'closed', text: 'This machine no longer has that page open. Open it again.' });
    const streamText = typeof msg.stream === 'number' ? String(msg.stream) : '';
    if (!STREAM_RE.test(streamText)) return;
    const stream = Number(streamText);
    if (msg.op === 'connect') return void this.#connect(id, socket, stream, String(msg.host || ''), Number(msg.port));
    const s = socket.streams.get(stream);
    if (!s) return;
    if (msg.op === 'data') {
      const data = typeof msg.data === 'string' && msg.data.length % 4 === 0 && BASE64_RE.test(msg.data) ? Buffer.from(msg.data, 'base64') : null;
      if (!data || !data.length || data.length > BROWSE_CHUNK || !s.wire) return this.#endStream(id, stream, true);
      s.wire.write(data);
    } else if (msg.op === 'ack') {
      // THE PHONE HAS THESE BYTES: read on, up to the window again.
      const bytes = typeof msg.bytes === 'number' && Number.isInteger(msg.bytes) && msg.bytes > 0 ? Math.min(msg.bytes, BROWSE_WINDOW) : 0;
      s.credit = Math.min(BROWSE_WINDOW, s.credit + bytes);
      if (s.credit > 0) s.wire?.resume?.();
    } else if (msg.op === 'end') {
      this.#endStream(id, stream, false);
    }
  }

  /** @param {string} id @param {string} owner @param {string|null} session @param {boolean} box */
  async #open(id, owner, session, box) {
    if (this.sockets.has(id)) return;
    if (!owner) return void this.send({ browse: id, op: 'refused', text: 'Nobody was named, so this machine opens nothing.' });
    // A BOX THAT PINS ITS ADMINS opens its own rules only for them.
    if (box) {
      const pins = this.pinned();
      if (pins === null || (pins.length > 0 && !pins.includes(owner))) box = false;
    }
    if (session) {
      const checked = await this.checkSession(owner, session).catch(() => ({ ok: /** @type {const} */ (false), text: 'This machine could not check that session just now.' }));
      if (!checked.ok) return void this.send({ browse: id, op: 'refused', text: checked.text });
    } else if (!box) {
      return void this.send({ browse: id, op: 'refused', text: 'This machine opens nothing for you: its admins it pins do not include you.' });
    } else {
      const p = this.policy();
      if (!p.web && !p.entries.length) return void this.send({ browse: id, op: 'refused', text: 'This machine opens no pages: its owner has listed no addresses and has not turned on the web.' });
    }
    this.sockets.set(id, { owner, session, box, streams: new Map() });
    this.log.info(`browse: ${id} opened for ${owner}${session ? ` on ${session}` : ''}${box ? ' with this box’s rules' : ''}`);
    this.send({ browse: id, op: 'opened' });
  }

  /** @param {string} id @param {Socket} socket @param {number} stream @param {string} host @param {number} port */
  async #connect(id, socket, stream, host, port) {
    if (socket.streams.has(stream)) return;
    const fail = (/** @type {string} */ text) => {
      socket.streams.delete(stream);
      this.send({ browse: id, op: 'failed', stream, text });
    };
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !host || host.length > 253) return void this.send({ browse: id, op: 'failed', stream, text: 'That is not an address a page can be on.' });
    if (this.carried >= MAX_BOX_STREAMS) return void this.send({ browse: id, op: 'failed', stream, text: `This machine is already carrying ${MAX_BOX_STREAMS} connections for phones. Close a page and try again.` });
    /** @type {{ wire: Wire|null, ended: boolean, credit: number }} */
    const slot = { wire: null, ended: false, credit: BROWSE_WINDOW };
    socket.streams.set(stream, slot);
    let decided;
    try {
      decided = await decideBrowse({ host, port, session: socket.session, box: socket.box, policy: this.policy(), lookup: this.lookup, own: this.own() });
    } catch {
      decided = { refused: 'This machine could not decide where that goes.' };
    }
    if (slot.ended || this.sockets.get(id) !== socket) return;
    if ('refused' in decided) return fail(decided.refused);
    if (decided.to === 'session') {
      const dialed = await this.dialSession(socket.owner, /** @type {string} */ (socket.session), decided.port).catch(() => ({ ok: /** @type {const} */ (false), text: 'This machine could not reach the session.' }));
      if (slot.ended || this.sockets.get(id) !== socket) {
        if (dialed.ok) dialed.wire.destroy();
        return;
      }
      if (!dialed.ok) return fail(dialed.text);
      return this.#join(id, socket, stream, slot, dialed.wire);
    }
    const wire = this.connect({ host: decided.host, port: decided.port });
    let up = false;
    const timer = setTimeout(() => {
      if (up) return;
      wire.destroy();
      if (socket.streams.get(stream) === slot) fail(`${host} did not answer from this machine within ${Math.round(this.connectTimeoutMs / 1000)} seconds.`);
    }, this.connectTimeoutMs);
    timer.unref?.();
    wire.once('connect', () => {
      up = true;
      clearTimeout(timer);
      if (slot.ended || socket.streams.get(stream) !== slot) return void wire.destroy();
      this.#join(id, socket, stream, slot, wire);
    });
    wire.once('error', (/** @type {Error} */ e) => {
      if (up) return;
      clearTimeout(timer);
      if (socket.streams.get(stream) === slot) fail(`${host} could not be reached from this machine: ${e.message}`);
    });
  }

  /**
   * A connection made: say so, and pump it.
   *
   * @param {string} id @param {Socket} socket @param {number} stream
   * @param {{ wire: Wire|null, ended: boolean, credit: number }} slot @param {Wire} wire
   */
  #join(id, socket, stream, slot, wire) {
    slot.wire = wire;
    // NOT FOR EVER, whatever the coordinator says or forgets to.
    wire.setTimeout?.(IDLE_MS, () => wire.destroy());
    this.send({ browse: id, op: 'connected', stream });
    wire.on('data', (/** @type {Buffer} */ chunk) => {
      for (let at = 0; at < chunk.length; at += BROWSE_CHUNK) {
        this.send({ browse: id, op: 'data', stream, data: chunk.subarray(at, at + BROWSE_CHUNK).toString('base64') });
      }
      // NO FURTHER THAN THE PHONE HAS CAUGHT UP WITH (BROWSE_WINDOW).
      slot.credit -= chunk.length;
      if (slot.credit <= 0) wire.pause?.();
    });
    const gone = () => {
      if (socket.streams.get(stream) !== slot) return;
      socket.streams.delete(stream);
      slot.ended = true;
      this.send({ browse: id, op: 'end', stream });
    };
    wire.on('end', gone);
    wire.on('close', gone);
    wire.on('error', gone);
  }

  /** @param {string} id @param {number} stream @param {boolean} tell */
  #endStream(id, stream, tell) {
    const socket = this.sockets.get(id);
    const slot = socket?.streams.get(stream);
    if (!socket || !slot) return;
    socket.streams.delete(stream);
    slot.ended = true;
    // CLOSED, not half-closed. The coordinator forgets a stream the moment
    // either end ends it, so nothing that came back afterwards would be
    // carried; and a web view ends a connection when it is done with it.
    try {
      slot.wire?.destroy();
    } catch { /* already gone */ }
    if (tell) this.send({ browse: id, op: 'end', stream });
  }

  /** @param {string} id */
  #closeSocket(id) {
    const socket = this.sockets.get(id);
    if (!socket) return;
    this.sockets.delete(id);
    for (const slot of socket.streams.values()) {
      slot.ended = true;
      try {
        slot.wire?.destroy();
      } catch { /* already gone */ }
    }
  }

  /** Every page this box carries, ended. */
  closeAll() {
    for (const id of [...this.sockets.keys()]) this.#closeSocket(id);
  }
}
