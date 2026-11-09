// What a Proxmox VE machine printed while it booted, kept by the box that made
// it, for the machine that never joins.
//
// Asked for: "add some troubleshooting for VMs that dont join as we cant ssh
// and get the logs". A machine that never joins is the one nothing can reach:
// it has no session to read, SSH reaches it only on a network the person can
// see, and the router in front of it has no login. What it said is on its
// serial console, which is also its screen (the image is made with
// `--serial0 socket --vga serial0`), and Proxmox VE hands that console to the
// fleet's token through `termproxy` and `vncwebsocket`, the privilege the
// phone's console already uses (VM.Console). So the box that made a machine
// opens the console the moment the machine starts and keeps what scrolls by.
//
// WHAT IS ON IT. The kernel, systemd and cloud-init say themselves; the join
// script's own lines are there; and the vendor snippet every machine boots
// with (pve-pools.js, pveVendorConfig) prints a few `fleetwright-join:` lines
// of its own, at one, three, seven and twelve minutes, while the machine has
// not joined: its addresses, its route, what its name server says for the
// fleet, whether the fleet answers, and the sidecar's last lines with
// anything that looks like a ticket or a token taken out. Once it joins it
// says `fleetwright-join: joined`, and this stops reading.
//
// NOTHING IS SENT TO THE MACHINE. Not a keystroke: the console is read, and
// the only thing written to the socket is the login Proxmox asks for and the
// keepalive. A machine nobody can run a command on stays one.
//
// HOW LONG, AND HOW MUCH. A machine has 15 minutes to join (the coordinator's
// ticket, vm-standby.js PENDING_MS), so reading stops at that, at the
// `joined` line, or when the console closes, whichever is first. Each keeps
// its last KEEP_BYTES. MAX_MACHINES are kept, the newest, for a day: about a
// megabyte at worst, in this process's memory, and gone with it. While this
// reads, the console is this box's: Proxmox VE's own Console button on that
// machine waits until it is done.

/** The ticket's life: a machine not joined by then never will be. */
export const RECORD_MS = 15 * 60_000;
/** The last of what each said. Enough for a boot and the join's reports. */
export const KEEP_BYTES = 48 * 1024;
/** The newest machines kept. */
export const MAX_MACHINES = 16;
/** How long one is kept after it was made. */
export const KEEP_MS = 24 * 60 * 60_000;
/** Proxmox's terminal proxy closes a socket that says nothing for a minute. */
const PING_MS = 30_000;
/** The line the vendor snippet prints once the machine has joined. */
export const JOINED_LINE = 'fleetwright-join: joined';

/**
 * A terminal's output as plain lines: escape sequences out (colours, cursor
 * moves, titles), a carriage return that rewrites its line kept as the last
 * thing written, and no control character but a newline and a tab.
 *
 * @param {string} text @returns {string}
 */
export function plainOf(text) {
  return String(text)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      return parts.reduce((shown, part) => (part.length >= shown.length ? part : part + shown.slice(part.length)), '');
    })
    .join('\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/**
 * @typedef {{ onMessage: (text: string) => void, onClose: (reason: string) => void, send: (text: string) => void, close: () => void }} Link
 * @typedef {{ name: string, address: string, owner: string, at: number, ended: number|null, why: string|null, text: string, joined: boolean }} Kept
 */

/**
 * Open one machine's serial console: a terminal proxy, then its socket, then
 * the login it asks for on the socket.
 *
 * @param {any} api  a PveApi
 * @param {string} node @param {number} vmid
 * @returns {Promise<Link>}
 */
export async function openSerial(api, node, vmid) {
  const base = `/nodes/${encodeURIComponent(node)}/qemu/${Number(vmid)}`;
  const proxy = await api.post(`${base}/termproxy`, { serial: 'serial0' });
  if (!proxy || !proxy.port || !proxy.ticket) throw new Error('Proxmox VE gave no console to read');
  const link = await api.websocket(`${base}/vncwebsocket`, { port: proxy.port, vncticket: proxy.ticket });
  link.send(`${proxy.user}:${proxy.ticket}\n`);
  return link;
}

export class BootConsoles {
  /**
   * @param {{
   *   now?: () => number,
   *   log?: { info: (m: string) => void, warn: (m: string) => void },
   *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout, setInterval: typeof setInterval, clearInterval: typeof clearInterval },
   * }} [opts]
   */
  constructor({ now = () => Date.now(), log, timers = globalThis } = {}) {
    this.now = now;
    this.log = log || { info() {}, warn() {} };
    this.timers = timers;
    /** @type {Map<string, Kept>} by machine name, oldest first */
    this.kept = new Map();
    /** @type {Map<string, () => void>} the ones still being read, and how to stop each */
    this.reading = new Map();
  }

  /**
   * Start reading a machine that was just started. Never throws: a console
   * that cannot be opened is kept as that, with Proxmox's words, since it is
   * then the one thing known about the machine's boot.
   *
   * @param {string} name @param {{ api: any, node: string, vmid: number, address: string, owner: string }} where
   */
  async record(name, { api, node, vmid, address, owner }) {
    this.#forget();
    /** @type {Kept} */
    const kept = { name, address, owner: String(owner || '').toLowerCase(), at: this.now(), ended: null, why: null, text: '', joined: false };
    this.kept.delete(name);
    this.kept.set(name, kept);
    while (this.kept.size > MAX_MACHINES) {
      const oldest = this.kept.keys().next().value;
      if (oldest === undefined) break;
      this.reading.get(oldest)?.();
      this.kept.delete(oldest);
    }
    /** @type {Link} */
    let link;
    try {
      link = await openSerial(api, node, vmid);
    } catch (e) {
      kept.ended = this.now();
      kept.why = `Its console could not be read: ${String(/** @type {Error} */ (e).message).slice(0, 200)}`;
      this.log.warn(`sidecar: could not read the console of ${name}: ${/** @type {Error} */ (e).message}`);
      return;
    }
    let pending = '';
    const end = (/** @type {string} */ why) => {
      if (kept.ended !== null) return;
      kept.ended = this.now();
      kept.why = why;
      this.timers.clearTimeout(limit);
      this.timers.clearInterval(ping);
      this.reading.delete(name);
      try {
        link.close();
      } catch {
        /* already closed */
      }
    };
    const limit = this.timers.setTimeout(() => end(`Read for ${RECORD_MS / 60_000} minutes, as long as a machine has to join.`), RECORD_MS);
    const ping = this.timers.setInterval(() => {
      try {
        link.send('2');
      } catch {
        /* the close says why */
      }
    }, PING_MS);
    this.reading.set(name, () => end('Stopped, to keep newer machines.'));
    link.onMessage = (text) => {
      // THE LOGIN'S ANSWER is the first message and is not the machine's.
      if (!kept.text && !pending && text === 'OK') return;
      pending += text;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      if (lines.length) this.#append(kept, lines.join('\n') + '\n');
      if (lines.some((l) => l.includes(JOINED_LINE))) {
        kept.joined = true;
        end('It joined, so reading stopped.');
      } else if (pending.length > 4096) {
        this.#append(kept, pending);
        pending = '';
      }
    };
    link.onClose = (reason) => {
      if (pending) this.#append(kept, pending);
      pending = '';
      end(`Its console closed: ${String(reason).slice(0, 120)}.`);
    };
  }

  /** @param {Kept} kept @param {string} raw */
  #append(kept, raw) {
    kept.text += plainOf(raw);
    if (kept.text.length > KEEP_BYTES) kept.text = kept.text.slice(kept.text.length - KEEP_BYTES).replace(/^[^\n]*\n/, '');
  }

  #forget() {
    for (const [name, k] of this.kept) {
      if (this.now() - k.at > KEEP_MS) {
        this.reading.get(name)?.();
        this.kept.delete(name);
      }
    }
  }

  /** Stop reading every console, as this process ends. */
  stopAll() {
    for (const stop of [...this.reading.values()]) stop();
  }

  /**
   * The machines kept, newest first, as one line each: for `logs boot` with
   * no machine named.
   *
   * @returns {Array<{ name: string, address: string, owner: string, at: number, reading: boolean, joined: boolean, lines: number }>}
   */
  list() {
    this.#forget();
    return [...this.kept.values()]
      .reverse()
      .map((k) => ({ name: k.name, address: k.address, owner: k.owner, at: k.at, reading: k.ended === null, joined: k.joined, lines: k.text ? k.text.split('\n').filter(Boolean).length : 0 }));
  }

  /**
   * One machine's last `lines` lines, and how its reading went. Null for one
   * this box does not have.
   *
   * @param {string} name @param {number} [lines]
   */
  read(name, lines = 200) {
    this.#forget();
    const k = this.kept.get(name);
    if (!k) return null;
    const all = k.text.split('\n');
    if (all.at(-1) === '') all.pop();
    return { name: k.name, address: k.address, owner: k.owner, at: k.at, reading: k.ended === null, joined: k.joined, why: k.why, lines: all.slice(-Math.max(1, lines)) };
  }
}

/**
 * The answer to `logs boot`, as text a terminal and an agent read and the
 * phones show as it is.
 *
 * @param {BootConsoles} consoles @param {{ machine?: string|null, lines?: number|null, now?: number }} ask
 * @returns {{ ok: boolean, text: string, boot?: any }}
 */
export function bootLogAnswer(consoles, { machine = null, lines = null, now = Date.now() }) {
  const ago = (/** @type {number} */ at) => {
    const m = Math.max(0, Math.round((now - at) / 60_000));
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };
  if (!machine) {
    const all = consoles.list();
    if (!all.length) return { ok: true, text: 'This box has made no Proxmox VE machine since it started, so it has no boot to show.', boot: { machines: [] } };
    return {
      ok: true,
      text:
        'Machines this box made, newest first. Name one to read what it printed while it booted:\n' +
        all.map((m) => `  ${m.name}  on ${m.address}, made ${ago(m.at)}, ${m.joined ? 'joined' : m.reading ? 'still reading' : 'did not say it joined'}, ${m.lines} lines`).join('\n'),
      boot: { machines: all },
    };
  }
  const r = consoles.read(machine, lines ?? 200);
  if (!r) return { ok: false, text: `This box did not make ${machine}, or made it more than a day ago, or has restarted since.` };
  const head = `${r.name} on ${r.address}, made ${ago(r.at)}. ${r.joined ? 'It joined.' : r.reading ? 'Still reading its console.' : 'It did not say it joined.'}${r.why ? ` ${r.why}` : ''}`;
  return { ok: true, text: `${head}\n\n${r.lines.length ? r.lines.join('\n') : '(nothing printed)'}`, boot: r };
}
