// The edge router: one OPNsense VM per pool, the only way out of every lab.
// docs/hypervisors.md, "The uplink" and "The edge router".
//
// WHAT IT IS. A private network inside the pool, `fleetwright-uplink`, that
// labs put their own router's WAN on, and one OPNsense VM, `fleetwright-edge`,
// with its WAN on the network the person chose as the way out and its LAN on
// the uplink. Its rules are written once, here, and nothing in the fleet can
// change them: labs reach the internet, and nothing private, link-local or
// multicast, so a lab cannot reach the person's LAN, the pool's API or
// another lab. It has no login at all (root's password is `*`), because the
// one thing that could log into it is a lab on its LAN side.
//
// HOW IT IS BUILT WITHOUT ANYBODY AT A CONSOLE, which is the part that was
// open. OPNsense takes no cloud-init, and its configuration importer waits for
// a key press at the console, so neither a config drive nor a second disk is
// read unattended. What first boot does read is /usr/local/etc/config.xml:
// with no /conf/config.xml yet, the importer's boot mode times out and copies
// that file into place (opnsense-importer, bootstrap_and_exit). The nano image
// is a plain UFS2 file system written by makefs, and that file is 5,234
// contiguous bytes at a fixed offset in it (found by reading the published
// 26.7 image; the whole image is pinned by its SHA-256 below, so the offset
// cannot drift under us). So the image is streamed from the download to Xen
// Orchestra with exactly those bytes replaced by this file's configuration,
// padded to the same length, and the file system is otherwise untouched:
// same inode, same size, same blocks. XML allows the trailing whitespace the
// padding is made of. Before a byte is replaced, the original is checked
// against the default configuration's own SHA-256, so a wrong offset fails
// instead of corrupting the disk.
//
// WHAT RUNS WHERE. The machine running the policy job downloads the image
// (once, kept in its state directory, checked before every use), unpacks it
// with bzip2 and uploads it through Xen Orchestra's own disk import, over the
// same pinned connection as everything else. Xen Orchestra makes the VDI;
// the VM is made from the pool's built-in "Other install media" template with
// no disks of its own, the imported disk attached, TX checksum offload turned
// off on both interfaces (XCP-ng's advice for FreeBSD guests, which otherwise
// drop forwarded traffic), and started.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { connectPinnedTls, splitAddress } from './xo-ws.js';

/**
 * The image, pinned. A new OPNsense release is a new entry here, with the
 * offset found again in its image: nothing is worked out at run time that
 * could disagree with what was checked.
 */
export const OPNSENSE_IMAGE = Object.freeze({
  release: '26.7',
  url: 'https://pkg.opnsense.org/releases/mirror/OPNsense-26.7-nano-amd64.img.bz2',
  /** As published in OPNsense-26.7-checksums-amd64.sha256, and as downloaded. */
  sha256: '28d5e2f37e40d87468a924e3006ef10e2ddc6de485b85333d9e3958c84d0cb9d',
  compressedSize: 490849116,
  rawSize: 3221225472,
  /** /usr/local/etc/config.xml, as the nano build left it, and its SHA-256. */
  config: Object.freeze({ offset: 712876032, length: 5234, sha256: '1e81cde6bebe59e0aa769bd6b187f2247bd1155cddb52253ca1f2a17c51fe2e5' }),
});

/** Names in Xen Orchestra. The edge is not tagged `fleetwright`, so the fleet's token cannot touch it. */
export const EDGE = Object.freeze({
  vm: 'fleetwright-edge',
  tag: 'fleetwright-edge',
  uplink: 'fleetwright-uplink',
  template: 'Other install media',
  /** The edge's LAN, which is the uplink: a range a home or office LAN rarely uses. */
  lan: Object.freeze({ address: '10.254.0.1', prefix: 24, from: '10.254.0.100', to: '10.254.0.250' }),
  cpus: 2,
  memory: 2 * 1024 ** 3,
});

/** What a lab may not reach: private, shared, link-local and multicast space. */
export const NOT_FROM_LABS = Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16', '224.0.0.0/4']);

/**
 * The edge's whole configuration, padded with spaces to exactly the length
 * of the file it replaces. Interfaces are Xen's netfront names in the order
 * the VM's interfaces are made: xn0 the WAN, xn1 the LAN.
 *
 * What is kept from the default: the nano image's memory file systems and
 * serial console, outbound NAT left automatic, Unbound answering DNS and
 * dnsmasq handing out addresses. What changes: the interfaces, no IPv6, the
 * WAN allowed to sit on a private LAN (it does: it is the person's), no
 * anti-lockout rule and no login, the offloads XCP-ng asks to be off, and
 * three LAN rules in order: DNS to the edge itself, nothing private, then
 * anything else.
 *
 * @param {{ length?: number, wanIf?: string, lanIf?: string }} [opts]
 * @returns {Buffer}
 */
export function edgeConfig({ length = OPNSENSE_IMAGE.config.length, wanIf = 'xn0', lanIf = 'xn1' } = {}) {
  const { address, prefix, from, to } = EDGE.lan;
  /** @param {number} seq @param {string} action @param {string} body @param {string} descr */
  const rule = (seq, action, body, descr) =>
    `<rule><enabled>1</enabled><sequence>${seq}</sequence><action>${action}</action><quick>1</quick><interface>lan</interface>` +
    `<direction>in</direction><ipprotocol>inet</ipprotocol>${body}<description>${descr}</description></rule>`;
  const xml =
    '<?xml version="1.0"?>\n<opnsense>\n<theme>opnsense</theme>\n<system>\n' +
    '<use_mfs_tmp/><use_mfs_var/><serialspeed>115200</serialspeed><primaryconsole>serial</primaryconsole><secondaryconsole>video</secondaryconsole>\n' +
    '<optimization>normal</optimization><hostname>fleetwright-edge</hostname><domain>internal</domain>\n' +
    '<group><name>admins</name><description>System Administrators</description><scope>system</scope><gid>1999</gid><member>0</member><priv>page-all</priv></group>\n' +
    // `*` is a locked account to FreeBSD and a hash PHP never verifies: no
    // login on the console, over SSH or in the web interface.
    '<user><name>root</name><descr>System Administrator</descr><scope>system</scope><groupname>admins</groupname><password>*</password><uid>0</uid></user>\n' +
    '<timezone>Etc/UTC</timezone><timeservers>0.opnsense.pool.ntp.org 1.opnsense.pool.ntp.org</timeservers>\n' +
    '<webgui><protocol>https</protocol><noantilockout>1</noantilockout></webgui>\n' +
    '<disablenatreflection>yes</disablenatreflection><usevirtualterminal>1</usevirtualterminal><disableconsolemenu/>\n' +
    '<disablechecksumoffloading>1</disablechecksumoffloading><disablesegmentationoffloading>1</disablesegmentationoffloading><disablelargereceiveoffloading>1</disablelargereceiveoffloading>\n' +
    '<pf_share_forward>1</pf_share_forward><lb_use_sticky>1</lb_use_sticky>\n' +
    '</system>\n<interfaces>\n' +
    `<wan><enable>1</enable><if>${wanIf}</if><descr>WAN</descr><ipaddr>dhcp</ipaddr><blockpriv>0</blockpriv><blockbogons>0</blockbogons></wan>\n` +
    `<lan><enable>1</enable><if>${lanIf}</if><descr>LAN</descr><ipaddr>${address}</ipaddr><subnet>${prefix}</subnet></lan>\n` +
    '</interfaces>\n' +
    `<dnsmasq><enable>1</enable><port>53053</port><interface>lan</interface><dhcp_ranges><interface>lan</interface><start_addr>${from}</start_addr><end_addr>${to}</end_addr></dhcp_ranges></dnsmasq>\n` +
    '<unbound><enable>1</enable></unbound>\n' +
    '<nat><outbound><mode>automatic</mode></outbound></nat>\n<filter/>\n' +
    '<OPNsense><Firewall>\n' +
    '<Alias><aliases><alias><enabled>1</enabled><name>fleetwright_private</name><type>network</type>' +
    `<content>${NOT_FROM_LABS.join('\n')}</content><description>What labs may not reach</description></alias></aliases></Alias>\n` +
    '<Filter><rules>\n' +
    rule(1, 'pass', '<protocol>TCP/UDP</protocol><source_net>lan</source_net><destination_net>lanip</destination_net><destination_port>53</destination_port>', 'Labs ask the edge for names') +
    '\n' +
    rule(2, 'block', '<protocol>any</protocol><source_net>lan</source_net><destination_net>fleetwright_private</destination_net>', 'Nothing private from a lab') +
    '\n' +
    rule(3, 'pass', '<protocol>any</protocol><source_net>lan</source_net><destination_net>any</destination_net>', 'Labs reach the internet') +
    '\n</rules><snatrules/><npt/><onetoone/></Filter>\n</Firewall></OPNsense>\n</opnsense>\n';
  const body = Buffer.from(xml, 'utf8');
  if (body.length > length) {
    throw new Error(`the edge configuration is ${body.length} bytes and the file it replaces is ${length}`);
  }
  return Buffer.concat([body, Buffer.alloc(length - body.length, 0x20)]);
}

/**
 * Is this the default configuration the nano image ships, byte for byte?
 * Checked on the bytes about to be replaced, so an offset that is wrong for
 * the image fails the build before the disk is written.
 *
 * @param {Buffer} original
 */
export function isDefaultConfig(original) {
  return createHash('sha256').update(original).digest('hex') === OPNSENSE_IMAGE.config.sha256;
}

/**
 * The image as it streams by, with the configuration's bytes replaced and
 * every other byte passed through untouched. The replaced region is held
 * until it has all arrived and been checked, then let go in one piece; the
 * total is checked at the end, so a short or long image is an error rather
 * than a disk that is quietly wrong.
 */
export class ConfigPatch extends Transform {
  /**
   * @param {{ offset: number, replacement: Buffer, total: number, check?: (original: Buffer) => boolean }} opts
   */
  constructor({ offset, replacement, total, check = isDefaultConfig }) {
    super();
    this.offset = offset;
    this.regionEnd = offset + replacement.length;
    this.replacement = replacement;
    this.total = total;
    this.check = check;
    this.at = 0;
    /** @type {Buffer[]} */
    this.held = [];
    /** @type {Buffer[]} */
    this.original = [];
  }

  /** @param {Buffer} chunk @param {BufferEncoding} _enc @param {(e?: Error|null) => void} done */
  _transform(chunk, _enc, done) {
    const start = this.at;
    const stop = start + chunk.length;
    this.at = stop;
    // Wholly before or after the region, or after it has been let go.
    if (stop <= this.offset || start >= this.regionEnd) {
      if (this.held.length) this.held.push(chunk);
      else this.push(chunk);
      return done();
    }
    // Overlapping: what precedes the region goes now; the rest is held.
    const from = Math.max(0, this.offset - start);
    const to = Math.min(chunk.length, this.regionEnd - start);
    if (from > 0 && !this.held.length) this.push(chunk.subarray(0, from));
    this.original.push(chunk.subarray(from, to));
    this.held.push(chunk.subarray(this.held.length ? 0 : from));
    if (stop < this.regionEnd) return done();
    // The whole region is in: check it, then replace it.
    const original = Buffer.concat(this.original);
    if (!this.check(original)) {
      return done(new Error('the OPNsense image does not have the default configuration where it should, so it was not written'));
    }
    const held = Buffer.concat(this.held);
    this.held = [];
    this.original = [];
    this.push(Buffer.concat([this.replacement, held.subarray(this.replacement.length)]));
    done();
  }

  /** @param {(e?: Error|null) => void} done */
  _flush(done) {
    if (this.held.length) return done(new Error('the OPNsense image ended inside its configuration'));
    if (this.at !== this.total) return done(new Error(`the OPNsense image unpacked to ${this.at} bytes, not ${this.total}`));
    done();
  }
}

/**
 * The image, downloaded once into `dir` and checked against its pinned
 * SHA-256 every time it is used, so a file damaged on disk is downloaded
 * again rather than built from.
 *
 * @param {{ dir: string, fetchImpl?: typeof fetch, onProgress?: (done: number, total: number) => void }} opts
 * @returns {Promise<string>} the path of the checked file
 */
export async function fetchImage({ dir, fetchImpl = fetch, onProgress = () => {} }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(new URL(OPNSENSE_IMAGE.url).pathname));
  if (existsSync(file) && statSync(file).size === OPNSENSE_IMAGE.compressedSize && (await sha256Of(file)) === OPNSENSE_IMAGE.sha256) {
    return file;
  }
  const part = `${file}.part`;
  rmSync(part, { force: true });
  const res = await fetchImpl(OPNSENSE_IMAGE.url);
  if (!res.ok || !res.body) throw new Error(`OPNsense's mirror answered ${res.status} for the image`);
  const hash = createHash('sha256');
  let got = 0;
  let told = 0;
  const count = new Transform({
    transform(chunk, _e, cb) {
      hash.update(chunk);
      got += chunk.length;
      if (got - told >= 16 * 1024 * 1024) {
        told = got;
        onProgress(got, OPNSENSE_IMAGE.compressedSize);
      }
      cb(null, chunk);
    },
  });
  await pipeline(/** @type {any} */ (res.body), count, createWriteStream(part));
  const seen = hash.digest('hex');
  if (seen !== OPNSENSE_IMAGE.sha256) {
    rmSync(part, { force: true });
    throw new Error(`the OPNsense image downloaded with SHA-256 ${seen.slice(0, 16)}…, not the published ${OPNSENSE_IMAGE.sha256.slice(0, 16)}…, so it was not used`);
  }
  renameSync(part, file);
  return file;
}

/** @param {string} file */
async function sha256Of(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * The raw disk, unpacked by bzip2 as it is read. Node has no bzip2 of its
 * own; a machine without the tool is told which package to install.
 *
 * @param {string} file
 * @param {{ spawnImpl?: typeof spawn }} [opts]
 */
export function unpack(file, { spawnImpl = spawn } = {}) {
  const child = spawnImpl('bzip2', ['-dc', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  child.stderr?.on('data', (d) => {
    said = (said + d).slice(-400);
  });
  child.on('error', (/** @type {any} */ e) => {
    child.stdout?.destroy(
      e?.code === 'ENOENT'
        ? new Error('this machine has no bzip2 to unpack the OPNsense image with. Install it (apt install bzip2) and apply again')
        : e,
    );
  });
  child.on('close', (code) => {
    if (code) child.stdout?.destroy(new Error(`bzip2 could not unpack the OPNsense image: ${said.trim() || `exit ${code}`}`));
  });
  return /** @type {import('node:stream').Readable} */ (child.stdout);
}

/**
 * Upload a raw disk to the URL `disk.import` answered with, as the one file
 * part Xen Orchestra's handler expects, over a connection held to the same
 * pin as the API (or plain HTTP when the person accepted that). Answers the
 * new VDI's id.
 *
 * @param {{ address: string, pin: string|null, plain: boolean, sendTo: string, body: import('node:stream').Readable, size: number, onProgress?: (done: number, total: number) => void, connectTls?: typeof connectPinnedTls }} opts
 * @returns {Promise<string>}
 */
export async function uploadDisk({ address, pin, plain, sendTo, body, size, onProgress = () => {}, connectTls = connectPinnedTls }) {
  const { host, port } = splitAddress(address, plain ? 80 : 443);
  const socket = plain ? await connectPlain(host, port) : await connectTls({ host, port, pin: /** @type {string} */ (pin) });
  const boundary = `fleetwright${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="opnsense.img"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const hostHeader = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  return await new Promise((resolve, reject) => {
    const req = http.request({
      method: 'POST',
      path: sendTo,
      headers: {
        Host: hostHeader,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(head.length + size + tail.length),
      },
      createConnection: () => /** @type {any} */ (socket),
    });
    req.on('error', reject);
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        text = (text + d).slice(0, 64 * 1024);
      });
      res.on('end', () => {
        /** @type {any} */
        let answer = null;
        try {
          answer = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        if (res.statusCode === 200 && typeof answer?.result === 'string') return resolve(answer.result);
        reject(new Error(`Xen Orchestra did not take the disk: ${answer?.error?.message ?? `HTTP ${res.statusCode}`}`));
      });
    });
    let sent = 0;
    let told = 0;
    req.write(head);
    body.on('data', (chunk) => {
      sent += chunk.length;
      if (sent - told >= 64 * 1024 * 1024) {
        told = sent;
        onProgress(sent, size);
      }
      if (!req.write(chunk)) body.pause();
    });
    req.on('drain', () => body.resume());
    body.on('error', (e) => {
      req.destroy(e);
      reject(e);
    });
    body.on('end', () => {
      if (sent !== size) {
        req.destroy();
        return reject(new Error(`the disk was ${sent} bytes, not the ${size} announced`));
      }
      req.end(tail);
    });
  });
}

/** @param {string} host @param {number} port @returns {Promise<net.Socket>} */
function connectPlain(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** @param {number} n */
const mb = (n) => Math.round(n / 1024 ** 2);

/**
 * Make the uplink if the pool has none, and let the fleet use it. Answers
 * its id.
 *
 * @param {{ admin: any, pool: string, networks: any[], setId: string, inSet: string[] }} opts
 */
export async function ensureUplink({ admin, pool, networks, setId, inSet }) {
  let uplink = networks.find((n) => n?.name_label === EDGE.uplink && n?.$pool === pool)?.id;
  if (!uplink) {
    uplink = await admin.call('network.create', {
      pool,
      name: EDGE.uplink,
      description: 'The network labs leave through, behind the edge router. Made by Fleetwright.',
    });
  }
  if (!inSet.includes(uplink)) await admin.call('resourceSet.addObject', { id: setId, object: uplink });
  return /** @type {string} */ (uplink);
}

/**
 * The edge router on this pool: left as it is when it is there (its WAN moved
 * to the way out if that changed, and started if it was stopped), built when
 * it is not. Answers the sentence the job finishes with.
 *
 * @param {{
 *   admin: any,
 *   pool: string,
 *   egress: { id: string, name: string },
 *   uplink: string,
 *   srs: any[],
 *   address: string, pin: string|null, plain: boolean,
 *   imageDir: string,
 *   say: (text: string) => void,
 *   getImage?: typeof fetchImage,
 *   unpackImpl?: typeof unpack,
 *   upload?: typeof uploadDisk,
 * }} opts
 */
export async function ensureEdge({ admin, pool, egress, uplink, srs, address, pin, plain, imageDir, say, getImage = fetchImage, unpackImpl = unpack, upload = uploadDisk }) {
  const vms = Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {});
  const edge = /** @type {any} */ (vms.find((v) => /** @type {any} */ (v)?.$pool === pool && /** @type {any} */ (v)?.tags?.includes?.(EDGE.tag)));
  if (edge) {
    const vifs = Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VIF', $VM: edge.id } })) || {});
    const wan = /** @type {any} */ (vifs.find((v) => String(/** @type {any} */ (v)?.device) === '0'));
    const said = [];
    if (wan && wan.$network !== egress.id) {
      await admin.call('vif.set', { id: wan.id, network: egress.id });
      said.push(`Its WAN moved to ${egress.name}.`);
    }
    if (edge.power_state !== 'Running') {
      await admin.call('vm.start', { id: edge.id });
      said.push('It was stopped, and was started.');
    }
    return [`The edge router was already there, on ${egress.name}.`, ...said].join(' ');
  }

  // A disk of 3 GiB, on the chosen storage in this pool with the most room.
  const sr = srs
    .filter((s) => s?.$pool === pool && (Number(s.size) || 0) - (Number(s.physical_usage) || 0) > OPNSENSE_IMAGE.rawSize)
    .sort((a, b) => (b.size - b.physical_usage) - (a.size - a.physical_usage))[0];
  if (!sr) throw new Error('none of the storage the fleet may use in this pool has 3 GiB free for the edge router. Nothing was built');

  const templates = Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {});
  const template = /** @type {any} */ (templates.find((t) => /** @type {any} */ (t)?.$pool === pool && /** @type {any} */ (t)?.name_label === EDGE.template));
  if (!template) throw new Error(`this pool has no "${EDGE.template}" template to make the edge router from. Nothing was built`);

  say(`Downloading OPNsense ${OPNSENSE_IMAGE.release}.`);
  const file = await getImage({
    dir: imageDir,
    onProgress: (d, t) => say(`Downloading OPNsense ${OPNSENSE_IMAGE.release}: ${mb(d)} of ${mb(t)} MB.`),
  });

  /** @type {string|null} */
  let vdi = null;
  /** @type {string|null} */
  let vm = null;
  try {
    say('Writing the edge router’s disk.');
    const { $sendTo } = await admin.call('disk.import', {
      sr: sr.id,
      type: 'iso',
      name: EDGE.vm,
      description: `OPNsense ${OPNSENSE_IMAGE.release}, configured by Fleetwright as the edge router`,
    });
    const body = unpackImpl(file).pipe(new ConfigPatch({ offset: OPNSENSE_IMAGE.config.offset, replacement: edgeConfig(), total: OPNSENSE_IMAGE.rawSize }));
    vdi = await upload({
      address,
      pin,
      plain,
      sendTo: $sendTo,
      body,
      size: OPNSENSE_IMAGE.rawSize,
      onProgress: (d, t) => say(`Writing the edge router’s disk: ${mb(d)} of ${mb(t)} MB.`),
    });

    say('Making the edge router.');
    vm = await admin.call('vm.create', {
      template: template.id,
      name_label: EDGE.vm,
      name_description: 'The only way out of every lab. Made by Fleetwright; its rules are fixed and it has no login.',
      VIFs: [{ network: egress.id }, { network: uplink }],
      VDIs: [],
      CPUs: EDGE.cpus,
      memory: EDGE.memory,
      tags: [EDGE.tag],
      bootAfterCreate: false,
    });
    await admin.call('vm.attachDisk', { vm, vdi, bootable: true, position: '0' });
    const vifs = Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VIF', $VM: vm } })) || {});
    for (const v of vifs) await admin.call('vif.set', { id: /** @type {any} */ (v).id, txChecksumming: false });
    await admin.call('vm.start', { id: vm });
  } catch (e) {
    // Nothing half-made is left for the next run to trip over.
    if (vm) await admin.call('vm.delete', { id: vm, deleteDisks: true }).catch(() => {});
    else if (vdi) await admin.call('vdi.delete', { id: vdi }).catch(() => {});
    throw e;
  }
  const { address: lan, prefix } = EDGE.lan;
  return (
    `The edge router is up: OPNsense ${OPNSENSE_IMAGE.release}, its WAN on ${egress.name} and its LAN on ${EDGE.uplink} at ${lan}/${prefix}. ` +
    'Labs on the uplink reach the internet and nothing private. It has no login; its rules are fixed.'
  );
}
