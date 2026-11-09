// A VM's console for a phone away from the pool: this box's half. The
// coordinator's is src/fleet/coordinator/tunnels.js, which says the shape.
//
// WHAT THIS IS: a length of wire. The coordinator says "open" with the person
// and the pool's address; this box connects with plain TCP to that address,
// only if it holds that person's token for exactly that pool (XoPools
// consoleAddress), and pumps bytes both ways as `tunnel` frames. Nothing here
// speaks TLS: the phone opens it through these bytes and holds it to the
// pool's pin, so what this box carries is TLS records, the console's token,
// the screen and every key typed inside them, readable by the phone and Xen
// Orchestra alone.
//
// WHAT THE COORDINATOR CAN DO TO THIS ONE, since it is the party this project
// treats as compromised: ask it to connect to a pool it holds for that person,
// which is where the page's reads already go; send bytes into that connection,
// which are whatever the phone's TLS would be; or end it. It cannot name an
// address this box does not hold a pool at for that person, so a tunnel is
// never a way from the coordinator into this box's network.

import net from 'node:net';

/** The largest piece one frame carries, before base64: the coordinator's bound (tunnels.js). */
export const TUNNEL_CHUNK = 48 * 1024;
/** Consoles this box carries at once. */
export const MAX_BOX_TUNNELS = 8;
/** A console that has carried nothing for this long is closed here: the coordinator's whole life of one (tunnels.js). */
const IDLE_MS = 30 * 60_000;
const TUNNEL_ID_RE = /^[0-9a-f]{24}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export class ConsoleTunnels {
  /**
   * @param {{
   *   send: (frame: Record<string, unknown>) => unknown,
   *   where: (owner: string, address: string, machine: string|null) => { host: string, port: number }|null,
   *   connect?: (opts: { host: string, port: number }) => net.Socket,
   *   connectTimeoutMs?: number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   * }} opts
   */
  constructor({ send, where, connect = (o) => net.connect(o), connectTimeoutMs = 15_000, log }) {
    this.send = send;
    this.where = where;
    this.connect = connect;
    this.connectTimeoutMs = connectTimeoutMs;
    this.log = log || { info() {}, warn() {} };
    /** @type {Map<string, net.Socket>} */
    this.open = new Map();
  }

  /**
   * One frame from the coordinator. Never throws; anything it does not
   * understand is dropped.
   *
   * @param {any} msg
   */
  onFrame(msg) {
    const id = typeof msg?.tunnel === 'string' && TUNNEL_ID_RE.test(msg.tunnel) ? msg.tunnel : null;
    if (!id) return;
    if (msg.op === 'open') return this.#open(id, String(msg.owner || ''), String(msg.address || ''), typeof msg.machine === 'string' && /^vm-[0-9a-f]{12}$/.test(msg.machine) ? msg.machine : null);
    const socket = this.open.get(id);
    if (!socket) return;
    if (msg.op === 'data') {
      const data = typeof msg.data === 'string' && msg.data.length % 4 === 0 && BASE64_RE.test(msg.data) ? Buffer.from(msg.data, 'base64') : null;
      if (!data || !data.length || data.length > TUNNEL_CHUNK) return this.#end(id, true);
      socket.write(data);
    } else if (msg.op === 'end') {
      this.#end(id, false);
    }
  }

  /**
   * SSH TO A MACHINE OF THE PERSON'S, when the frame names one: its address
   * on the pool's network and port 22, and only a running machine made for
   * them (Pools.consoleAddress). The phone speaks SSH through the bytes, so
   * this box carries ciphertext as it does for a console.
   *
   * @param {string} id @param {string} owner @param {string} address @param {string|null} machine
   */
  #open(id, owner, address, machine) {
    if (this.open.has(id)) return;
    const target = owner && address ? this.where(owner.toLowerCase(), address, machine) : null;
    if (!target) {
      this.send({
        tunnel: id,
        op: 'refused',
        text: machine
          ? `This machine sees no running machine of yours called ${machine} with an address yet, so it does not connect there.`
          : `This machine holds no pool of yours at ${address}, so it does not connect there.`,
      });
      return;
    }
    if (this.open.size >= MAX_BOX_TUNNELS) {
      this.send({ tunnel: id, op: 'refused', text: `This machine is already carrying ${MAX_BOX_TUNNELS} consoles. Close one and open it again.` });
      return;
    }
    const socket = this.connect({ host: target.host, port: target.port });
    this.open.set(id, socket);
    // NOT FOR EVER, whatever the coordinator says or forgets to: a console
    // quiet for as long as the coordinator lets one live is closed here too,
    // so a socket to this box that dropped mid-console strands nothing.
    socket.setTimeout(IDLE_MS, () => socket.destroy());
    let connected = false;
    const timer = setTimeout(() => {
      if (connected) return;
      this.send({ tunnel: id, op: 'refused', text: `${address} did not answer from this machine within ${Math.round(this.connectTimeoutMs / 1000)} seconds.` });
      this.open.delete(id);
      socket.destroy();
    }, this.connectTimeoutMs);
    timer.unref?.();
    socket.once('connect', () => {
      connected = true;
      clearTimeout(timer);
      this.send({ tunnel: id, op: 'opened' });
    });
    socket.on('data', (/** @type {Buffer} */ chunk) => {
      for (let at = 0; at < chunk.length; at += TUNNEL_CHUNK) {
        this.send({ tunnel: id, op: 'data', data: chunk.subarray(at, at + TUNNEL_CHUNK).toString('base64') });
      }
    });
    socket.on('error', (e) => {
      clearTimeout(timer);
      if (!this.open.has(id)) return;
      this.open.delete(id);
      this.send(connected ? { tunnel: id, op: 'end' } : { tunnel: id, op: 'refused', text: `${address} could not be reached from this machine: ${e.message}` });
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!this.open.delete(id)) return;
      this.send({ tunnel: id, op: 'end' });
    });
  }

  /** @param {string} id @param {boolean} tell */
  #end(id, tell) {
    const socket = this.open.get(id);
    if (!socket) return;
    this.open.delete(id);
    socket.destroy();
    if (tell) this.send({ tunnel: id, op: 'end' });
  }

  /** Every console this box carries, ended: the socket to the coordinator went. */
  closeAll() {
    for (const id of [...this.open.keys()]) this.#end(id, false);
  }
}
