// A port inside a session's container, opened for the sidecar: the hub's half
// of a session's page on a phone. docs/browse.md; the box's switchboard is
// src/fleet/host/browse.js.
//
// WHY THE HUB. The container is the hub's: rootless podman keeps containers
// per account, and the sidecar runs as its own user (#270), so it cannot
// reach them and should not be able to. It asks here, over the loopback it
// already speaks to the hub on, with its own token, and gets back one byte
// stream to one port in one session.
//
// HOW. An HTTP upgrade on the hub's own listener, `GET /api/session-port`
// with `Upgrade: fleetwright-port`. The hub runs one short `podman exec` into
// the session's container per connection: Node, which every session image
// has, connects to the port on the container's own loopback (IPv4, then
// IPv6, because a dev server may listen on either) and pumps its stdin and
// stdout. It says first whether it connected, one byte, so a port nothing
// listens on is an answer with a sentence and not a socket that closes.
//
// WHAT IS CHECKED, here and again on the box, because each is the one that
// knows:
//
//   - THE CALLER holds the operator's or the sidecar's token.
//   - THE BOX CONTAINS ITS SESSIONS. On a box that runs them as plain panes a
//     session's `localhost` is this box's own, the hub and the sidecar
//     included, so its ports are not opened at all.
//   - THE SESSION is running and was started by the person named.
//
// Nothing about the container but its name is taken from the caller: the
// name is checked against the hub's own registry and the container is derived
// from it (podman.js sandboxNames), as files.js derives the volume.

import { spawn } from 'node:child_process';

import { isValidName } from './names.js';
import { sandboxNames } from './podman.js';
import { emailFromActor } from './accounts.js';

/** The upgrade token both ends name. */
export const SESSION_PORT_UPGRADE = 'fleetwright-port';
/** Ports opened at once into sessions on this box: the box's own bound on connections. */
export const MAX_SESSION_PORTS = 64;
/** How long a connection inside the container may take to be made. */
const CONNECT_MS = 15_000;

/**
 * What runs inside the container: connect to the port on loopback, say
 * whether it worked in one byte (1, or 0 and the error's code), then pump.
 * No shell, and the port arrives as an argument, never as text in the script.
 */
export const DIAL_SCRIPT = [
  "const net=require('net');const port=Number(process.argv[1]);const hosts=['127.0.0.1','::1'];let i=0;let why='';",
  '(function go(){let up=false;const s=net.connect({host:hosts[i],port});',
  "s.on('connect',()=>{up=true;process.stdout.write(Buffer.from([1]));process.stdin.pipe(s);s.pipe(process.stdout);process.stdin.on('end',()=>s.end());});",
  // THE REFUSAL WINS: a port refused on IPv4 and unreachable on IPv6 (a
  // container with no IPv6) is a port nothing listens on, not a network fault.
  "s.on('error',(e)=>{if(!up&&(!why||e.code==='ECONNREFUSED'))why=String(e.code||'failed');if(!up&&++i<hosts.length)return go();if(!up){process.stdout.write(Buffer.concat([Buffer.from([0]),Buffer.from(why)]));process.exitCode=3;}process.stdin.destroy();});",
  "s.on('close',()=>process.stdin.destroy());})();",
].join('');

/**
 * The podman command line for one connection.
 *
 * @param {string} podmanBin @param {string} session @param {number} port
 * @returns {[string, string[]]}
 */
export function dialArgv(podmanBin, session, port) {
  return [podmanBin, ['exec', '-i', sandboxNames(session).container, 'node', '-e', DIAL_SCRIPT, String(port)]];
}

/**
 * Whether a request is the session-port upgrade.
 *
 * @param {import('node:http').IncomingMessage} req
 */
export function isSessionPortUpgrade(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  return url.pathname === '/api/session-port' && String(req.headers.upgrade || '').toLowerCase() === SESSION_PORT_UPGRADE;
}

/**
 * @typedef {object} SessionPortDeps
 * @property {'operator'|'sidecar'|null} principal  who the request's token says it is
 * @property {boolean} contained  whether this box contains its sessions (http.js uncontained is empty)
 * @property {(name: string) => { status?: string, createdBy?: string|null }|undefined} record  the hub's own record of a session
 * @property {(session: string, port: number) => import('node:child_process').ChildProcessWithoutNullStreams} [exec]
 * @property {string} [podmanBin]
 * @property {{ info: Function, warn: Function }} [log]
 */

let open = 0;

/**
 * Answer one upgrade: refuse it with a status and a sentence, or switch
 * protocols and join the socket to a connection inside the container.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {SessionPortDeps} deps
 */
export function answerSessionPort(req, socket, head, deps) {
  const url = new URL(req.url || '/', 'http://localhost');
  /** @param {number} status @param {string} text */
  const refuse = (status, text) => {
    const body = JSON.stringify({ ok: false, text });
    try {
      socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Refused'}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
    } catch { /* already gone */ }
  };
  if (!deps.principal) return refuse(401, 'A session’s port is opened for the fleet’s sidecar, with its token.');
  if (!deps.contained) return refuse(409, 'This machine does not run sessions in containers, so a session here shares the machine’s own addresses and its ports are not opened from a phone.');
  const name = url.searchParams.get('name') || '';
  const owner = (url.searchParams.get('owner') || '').toLowerCase();
  const portText = url.searchParams.get('port') || '';
  if (!isValidName(name) || !owner || !/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) {
    return refuse(400, 'Say which session, whose, and which port.');
  }
  const port = Number(portText);
  const rec = deps.record(name);
  const whose = rec ? (emailFromActor(rec.createdBy ?? null) ?? String(rec.createdBy || '').toLowerCase()) : null;
  if (!rec || whose !== owner) return refuse(404, `This machine has no session of yours called ${name}.`);
  if (rec.status !== 'running') return refuse(409, `${name} is not running, so nothing is listening in it.`);
  if (open >= MAX_SESSION_PORTS) return refuse(429, `This machine already has ${MAX_SESSION_PORTS} connections open into sessions.`);

  const exec = deps.exec ?? ((s, p) => {
    const [bin, args] = dialArgv(deps.podmanBin || 'podman', s, p);
    return spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  });
  /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */
  let child;
  try {
    child = exec(name, port);
  } catch {
    return refuse(502, `This machine could not reach inside ${name}.`);
  }
  open += 1;
  let counted = true;
  const release = () => {
    if (!counted) return;
    counted = false;
    open -= 1;
  };
  let settled = false;
  let first = Buffer.alloc(0);
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill('SIGKILL');
    release();
    refuse(504, `Nothing answered on port ${port} in ${name} within ${CONNECT_MS / 1000} seconds.`);
  }, CONNECT_MS);
  timer.unref?.();
  child.stderr.resume();
  child.on('error', () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    release();
    refuse(502, `This machine could not reach inside ${name}.`);
  });
  child.on('close', () => {
    release();
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      const code = first.length > 1 && first[0] === 0 ? first.subarray(1).toString('latin1').replace(/[^A-Z_]/g, '').slice(0, 32) : '';
      refuse(502, code === 'ECONNREFUSED' ? `Nothing is listening on port ${port} in ${name}.` : `Port ${port} in ${name} could not be reached${code ? ` (${code})` : ''}.`);
      return;
    }
    // END, not destroy: what the container wrote last is still in the
    // socket's buffer, and the page's last bytes are usually the ones that
    // finish it.
    socket.end();
  });
  /** @param {Buffer} chunk */
  const onFirst = (chunk) => {
    if (settled) return;
    first = Buffer.concat([first, chunk]);
    if (first[0] !== 1) return; // a 0 and its code, read on close
    settled = true;
    clearTimeout(timer);
    child.stdout.off('data', onFirst);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: ${SESSION_PORT_UPGRADE}\r\nconnection: Upgrade\r\n\r\n`);
    if (first.length > 1) socket.write(first.subarray(1));
    if (head?.length) child.stdin.write(head);
    child.stdout.pipe(/** @type {any} */ (socket));
    socket.pipe(child.stdin);
    socket.on('close', () => child.kill('SIGTERM'));
    socket.on('error', () => child.kill('SIGTERM'));
    child.stdin.on('error', () => socket.destroy());
    deps.log?.info?.(`session-port: ${name}:${port} opened for ${owner}`);
  };
  child.stdout.on('data', onFirst);
}
