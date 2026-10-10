// Watching a pool's edge routers from a box that holds the pool's token and
// the key to read them with. docs/hypervisors.md, "Watching the edge routers".
//
// ASKED FOR: "Why is there no live info of opnsense in the app to help trouble
// shoot this?", during a two-router DNS failure: which router held the gateway
// address, whether either was answering names, and what DHCP handed out were
// all in the routers and nowhere else.
//
// TWO WAYS, because each answers what the other cannot:
//
//   THE API, every half minute, over TLS held to the certificate the policy
//   job made (edge-credentials.js), with the key the person's vault handed
//   this box beside the pool's token: each router's CARP role on the uplink,
//   whether Unbound runs, whether its way out is up, and how many leases it
//   holds. That is how the routers are NOW.
//
//   SYSLOG, as it happens: CARP's changes of master, Unbound's and dnsmasq's
//   complaints, the gateway monitor, Suricata starting. That is what happened
//   BEFORE anybody looked, and it survives the routers' own memory-backed /var,
//   which a restart empties. It also says where a router is: the address its
//   lines come from is the one this box reads it at next.
//
// CANNOT TELL IS NOT FINE. A router that did not answer is `reached: false`
// with the reason, every flag it could not read is null, and the phones say
// both as such. A gateway OPNsense has no measurement of reads "Online" in
// its own API; here it is null.
//
// WHAT TRAVELS is what the coordinator lets through (core.js, EDGE_REPORT):
// the status flags and the last forty lines it keeps, owner only. Firewall
// log lines are not sent here at all: what a session's machine tried to reach
// is not this report's to carry.

import dgram from 'node:dgram';
import http from 'node:http';

import { EDGE_WATCH } from './edge-credentials.js';
import { connectPinnedTls } from './xo-ws.js';

/** How many lines a pool keeps, and how many of them may be DHCP's chatter. */
export const EVENTS = Object.freeze({ keep: 40, dhcp: 12, text: 240 });

/** The routers' names, as their syslog says them (hostname before the domain). */
const NAMES = Object.freeze(['fleetwright-edge', 'fleetwright-edge-b']);

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/**
 * One syslog line as a router sends it (BSD format, syslog-ng's default
 * with rfc5424 off): `<PRI>Mmm dd HH:MM:SS HOST PROGRAM[PID]: MSG`. Null for
 * anything else, or a host that is not one of the routers.
 *
 * @param {string} line
 * @returns {{ router: string, program: string, text: string }|null}
 */
export function parseSyslog(line) {
  const m = /^<\d{1,3}>(?:\d\s)?[A-Z][a-z]{2}\s+\d{1,2}\s\d{2}:\d{2}:\d{2}\s(\S+)\s([^\s:[]+)(?:\[\d+\])?:\s?(.*)$/s.exec(String(line).trim());
  if (!m) return null;
  const router = m[1].split('.')[0];
  if (!NAMES.includes(router)) return null;
  return { router, program: m[2], text: m[3].replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() };
}

/**
 * What kind of line it is, for the phone: by the program that said it, and
 * for the kernel, whether it is CARP's.
 *
 * @param {string} program @param {string} text
 */
export function kindOf(program, text) {
  if (program === 'kernel') return /\bcarp\b/i.test(text) ? 'carp' : 'system';
  if (program === 'unbound') return 'dns';
  if (program.startsWith('dnsmasq')) return 'dhcp';
  if (program === 'dpinger') return 'gateway';
  if (program === 'suricata') return 'ids';
  return 'system';
}

/**
 * What the four status calls said, reduced to the report's flags. Each is
 * null when its answer was missing or unreadable.
 *
 * @param {{ vip?: any, unbound?: any, gateways?: any, leases?: any }} said
 */
export function statusOf({ vip, unbound, gateways, leases }) {
  // CARP: the uplink's shared address, 10.254.0.1. One router alone has none.
  const row = Array.isArray(vip?.rows) ? vip.rows.find((/** @type {any} */ r) => r?.subnet === '10.254.0.1') : null;
  const s = String(row?.status || '').toLowerCase();
  const role = s === 'master' || s === 'backup' || s === 'init' ? s : null;
  const u = String(unbound?.status || '');
  const dns = u === 'running' ? true : u === 'stopped' ? false : null;
  // THE WAY OUT: the one gateway, or the WAN's. dpinger with no data says
  // `none` with `~` everywhere, which OPNsense shows as Online; cannot tell.
  const items = Array.isArray(gateways?.items) ? gateways.items : [];
  const gw = items.length === 1 ? items[0] : items.find((/** @type {any} */ i) => /wan/i.test(String(i?.name || '')));
  const st = String(gw?.status || '');
  const gateway = !gw || gw.monitor === '~' ? null : st === 'down' || st === 'force_down' ? false : ['none', 'delay', 'loss', 'delay+loss'].includes(st) ? true : null;
  const count = Array.isArray(leases?.rows) ? leases.rows.length : Number.isInteger(leases?.total) ? leases.total : null;
  return { role, dns, gateway, leases: count };
}

/**
 * @typedef {{ name: string, address: string|null, reached: boolean|null, role: string|null, dns: boolean|null, gateway: boolean|null, leases: number|null, heardAt: number|null, problem: string|null }} RouterState
 */

export class EdgeWatch {
  /**
   * @param {{
   *   pools: { held: Map<string, { owner: string, record: any }> },
   *   connect?: typeof connectPinnedTls,
   *   createSocket?: () => dgram.Socket,
   *   port?: number,
   *   apiPort?: number,
   *   pollMs?: number,
   *   now?: () => number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   *   onChange?: () => void,
   * }} opts
   */
  constructor({ pools, connect = connectPinnedTls, createSocket = () => dgram.createSocket('udp4'), port = EDGE_WATCH.syslogPort, apiPort = 443, pollMs = 30_000, now = () => Date.now(), log, onChange = () => {} }) {
    this.pools = pools;
    this.apiPort = apiPort;
    this.connect = connect;
    this.createSocket = createSocket;
    this.port = port;
    this.pollMs = pollMs;
    this.now = now;
    this.log = log || { info() {}, warn() {} };
    this.onChange = onChange;
    /** @type {Map<string, { at: number, routers: RouterState[], events: Array<{ at: number, router: string, kind: string, text: string }> }>} keyed `owner address` */
    this.seen = new Map();
    /** @type {Map<string, Map<string, string>>} keyed `owner address`, router name → where its syslog came from */
    this.learned = new Map();
    /** @type {Map<string, number>} keyed `owner address name`, when its syslog was last heard */
    this.heard = new Map();
    /** @type {dgram.Socket|null} */
    this.socket = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
    this.polling = false;
  }

  /** The pools this box holds a key to their routers for. */
  watched() {
    const held = this.pools?.held;
    return held instanceof Map ? [...held.entries()].filter(([, h]) => h?.record?.edge) : [];
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
    void this.poll();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.socket?.close();
    } catch {
      /* closing */
    }
    this.socket = null;
  }

  /**
   * Listen for the routers' syslog, once there is a pool to listen for. A
   * port somebody else has is said once and left: the API still works.
   */
  #listen() {
    if (this.socket) return;
    const s = this.createSocket();
    this.socket = s;
    s.on('message', (msg, rinfo) => this.hear(msg.toString('utf8'), rinfo.address));
    s.on('error', (e) => {
      this.log.warn(`sidecar: cannot listen for the edge routers' syslog on ${this.port}: ${e.message}. How they are is still read from their API.`);
      try {
        s.close();
      } catch {
        /* closing */
      }
    });
    s.bind(this.port);
  }

  /**
   * One syslog line, from `from`. It is the pool's whose routers are at
   * that address; from an address nobody knew, the only watched pool's,
   * and its router is then read there. The API connection is held to the
   * router's certificate, so a line from somewhere else can send this box
   * to the wrong address and never get the key.
   *
   * @param {string} line @param {string} from
   */
  hear(line, from) {
    const got = parseSyslog(line);
    if (!got || !IPV4.test(from)) return;
    const watched = this.watched();
    const known = watched.filter(([k, h]) => this.#addressOf(k, h.record, got.router) === from);
    const [k] = known.length ? known[0] : watched.length === 1 ? watched[0] : [];
    if (!k) return;
    if (!known.length) {
      const map = this.learned.get(k) ?? new Map();
      map.set(got.router, from);
      this.learned.set(k, map);
    }
    const at = this.now();
    this.heard.set(`${k} ${got.router}`, at);
    const entry = this.seen.get(k) ?? { at: 0, routers: [], events: [] };
    entry.events.push({ at, router: got.router, kind: kindOf(got.program, got.text), text: got.text.slice(0, EVENTS.text) });
    // DHCP SAYS SOMETHING EVERY LEASE: past its share, its oldest goes first.
    while (entry.events.filter((e) => e.kind === 'dhcp').length > EVENTS.dhcp) entry.events.splice(entry.events.findIndex((e) => e.kind === 'dhcp'), 1);
    while (entry.events.length > EVENTS.keep) entry.events.shift();
    this.seen.set(k, entry);
  }

  /** Where a router is read: where its syslog last came from, else where the policy job last saw it. @param {string} k @param {any} record @param {string} name */
  #addressOf(k, record, name) {
    const learned = this.learned.get(k)?.get(name);
    if (learned) return learned;
    const r = (record.edge.routers || []).find((/** @type {any} */ x) => x?.name === name);
    return typeof r?.address === 'string' && IPV4.test(r.address) ? r.address : null;
  }

  /** Read every watched pool's routers once. Never throws. */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const watched = this.watched();
      if (watched.length) this.#listen();
      for (const k of [...this.seen.keys()]) if (!watched.some(([w]) => w === k)) this.seen.delete(k);
      for (const [k, { record }] of watched) {
        const names = [...new Set([...(record.edge.routers || []).map((/** @type {any} */ r) => r?.name), ...(this.learned.get(k)?.keys() ?? [])])].filter((n) => NAMES.includes(n));
        /** @type {RouterState[]} */
        const routers = [];
        for (const name of names.sort()) routers.push(await this.#read(k, record, name));
        const entry = this.seen.get(k) ?? { at: 0, routers: [], events: [] };
        entry.at = this.now();
        entry.routers = routers;
        this.seen.set(k, entry);
      }
      if (watched.length) this.onChange();
    } finally {
      this.polling = false;
    }
  }

  /** @param {string} k @param {any} record @param {string} name @returns {Promise<RouterState>} */
  async #read(k, record, name) {
    const address = this.#addressOf(k, record, name);
    const heardAt = this.heard.get(`${k} ${name}`) ?? null;
    const base = { name, address, heardAt };
    if (!address) {
      return { ...base, reached: null, role: null, dns: null, gateway: null, leases: null, problem: 'Xen Orchestra did not know its address when the policy last ran, and it has not sent this machine its logs.' };
    }
    const ask = (/** @type {string} */ method, /** @type {string} */ path) => this.#call(address, record.edge, method, path);
    try {
      // One after another: a router answering slowly is asked one thing at a time.
      const vip = await ask('POST', '/api/diagnostics/interface/get_vip_status');
      const unbound = await ask('GET', '/api/unbound/service/status');
      const gateways = await ask('GET', '/api/routes/gateway/status');
      const leases = await ask('POST', '/api/dnsmasq/leases/search');
      return { ...base, reached: true, ...statusOf({ vip, unbound, gateways, leases }), problem: null };
    } catch (e) {
      return { ...base, reached: false, role: null, dns: null, gateway: null, leases: null, problem: String(/** @type {Error} */ (e).message).slice(0, 200) };
    }
  }

  /**
   * One API call, over TLS held to the routers' certificate, with the key.
   * Nothing is sent before the certificate is checked.
   *
   * @param {string} host @param {{ key: string, secret: string, pin: string }} edge @param {string} method @param {string} path
   */
  async #call(host, edge, method, path) {
    let socket;
    try {
      socket = await this.connect({ host, port: this.apiPort, pin: edge.pin, timeoutMs: 8_000 });
    } catch (e) {
      const why = /** @type {Error} */ (e).message;
      throw new Error(/certificate|pin/i.test(why) ? `something at ${host} answered with a certificate that is not this router’s, so the key was not sent` : `${host} did not answer: ${why}`);
    }
    const body = method === 'POST' ? '{}' : '';
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          createConnection: () => /** @type {any} */ (socket),
          host,
          method,
          path,
          headers: {
            authorization: `Basic ${Buffer.from(`${edge.key}:${edge.secret}`).toString('base64')}`,
            accept: 'application/json',
            connection: 'close',
            ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
          },
          timeout: 8_000,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            if (text.length < 256 * 1024) text += c;
          });
          res.on('end', () => {
            if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error(`the router refused this machine’s key (${res.statusCode}), so it was rebuilt without it or the vault holds an older one: apply the policy again`));
            if (res.statusCode !== 200) return reject(new Error(`the router answered ${path} with ${res.statusCode}`));
            try {
              resolve(JSON.parse(text));
            } catch {
              reject(new Error(`the router’s answer to ${path} was not JSON`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`the router did not answer ${path} in time`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  /**
   * What the health frame says of one pool's routers, or null when this box
   * does not watch them.
   *
   * @param {string} owner @param {string} address
   */
  reportFor(owner, address) {
    const k = `${owner} ${address}`;
    if (!this.watched().some(([w]) => w === k)) return null;
    const e = this.seen.get(k);
    if (!e || !e.at) return null;
    // Heard since the read, as the read itself knew.
    const routers = e.routers.map((r) => ({ ...r, heardAt: this.heard.get(`${k} ${r.name}`) ?? r.heardAt }));
    return { at: e.at, routers, events: [...e.events] };
  }
}
