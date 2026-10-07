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
  /** On an edge built to drop what its threat rules match, so a policy can tell what it has without logging in, which it cannot. */
  blocksTag: 'fleetwright-edge-blocks',
  uplink: 'fleetwright-uplink',
  template: 'Other install media',
  /** The edge's LAN, which is the uplink: a range a home or office LAN rarely uses. */
  lan: Object.freeze({ address: '10.254.0.1', prefix: 24, from: '10.254.0.100', to: '10.254.0.250' }),
  cpus: 2,
  memory: 2 * 1024 ** 3,
});

/**
 * What the edge filters for every machine behind it (docs/hypervisors.md,
 * "What the edge filters"). Names in OPNsense 26.7's own models, read from
 * its source: Unbound's built-in blocklists by key, Suricata's ET Open rule
 * files by name. Threat feeds only: nothing a session doing ordinary work
 * would trip over.
 */
export const EDGE_FILTER = Object.freeze({
  /** abuse.ch ThreatFox's indicators and Hagezi's threat intelligence feeds: malware, phishing, command and control. */
  blocklists: Object.freeze(['atf', 'hgz011']),
  /** Malware traffic, known botnet controllers, known-bad hosts, Cobalt Strike servers. Logged, and dropped when the policy says block. */
  rules: Object.freeze(['emerging-malware.rules', 'botcc.rules', 'compromised.rules', 'threatview_CS_c2.rules']),
  /** Neither is downloaded at boot (OPNsense fetches them on an apply or from cron), and /var is in memory, so both are fetched on a cron, every half hour. */
  every: '*/30',
  /**
   * Where Suricata takes traffic when it blocks: OPNsense's one divert
   * socket (scripts/filter/list_divert_sockets.php). Divert, not netmap,
   * because divert needs nothing of the network driver, and netmap's support
   * for Xen's netfront is the thing nobody could promise.
   */
  divertPort: 8000,
});

/** The rule files' ids, less their last digit, which is each one's place in EDGE_FILTER.rules. */
const RULE_FILE_UUID = '5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e1';

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
 * four LAN rules in order: DNS to the edge itself, no DNS anywhere else (so
 * the filtering below cannot be stepped around by naming another resolver),
 * nothing private, then anything else.
 *
 * WHAT IT FILTERS (EDGE_FILTER): Unbound answers 0.0.0.0 for anything on its
 * threat blocklists, and Suricata watches the LAN for known-bad traffic and
 * logs it, by the machine's own address.
 *
 * WHEN IT BLOCKS (`block`), Suricata runs inline: the rule that lets labs out
 * hands their traffic to its divert socket first, and one policy turns every
 * alert in the four rule files into a drop. FAIL CLOSED, on purpose: with
 * Suricata stopped, a divert socket with nobody reading it passes nothing, so
 * an edge that blocks and cannot inspect lets nothing out rather than
 * everything. The DNS and private rules above it are not diverted: they
 * decide before Suricata would see the packet.
 *
 * ROOM. It has to fit in the 5,234 bytes of the file it replaces, and blocking
 * all but filled them. What was cut to make room is what OPNsense does
 * anyway: the web interface's theme (nobody can log in to see it), pf's
 * `normal` optimization (its default when unset), sticky load balancing (it
 * does nothing without source tracking, which is off), and the policy's
 * `prio` and description, which OPNsense reads as 0 and none when absent.
 * NOT its `enabled`: booted without it, the policy came up disabled and an
 * alert installed as an alert, because a model default is not written into an
 * item that came from the file. A test keeps both modes inside the file.
 *
 * VERSIONS STAMPED ONE BELOW CURRENT, on purpose. OPNsense's templates read
 * the configuration as written, not the model with its defaults, and the
 * defaults are written in only when a migration runs and saves the model.
 * Stamped at the current version, nothing runs, and the edge booted with
 * Unbound's templates failing on a missing `acls`. Stamped one below, only
 * the newest migration runs (each harmless here, read from 26.7's source),
 * then the whole model is saved: never the older ones, which would read
 * these sections as an older format. That is also why Unbound's legacy
 * `<unbound>` section is gone: it is what an older migration would fold in.
 *
 * @param {{ length?: number, wanIf?: string, lanIf?: string, block?: boolean }} [opts]
 * @returns {Buffer}
 */
export function edgeConfig({ length = OPNSENSE_IMAGE.config.length, wanIf = 'xn0', lanIf = 'xn1', block = false } = {}) {
  const { address, prefix, from, to } = EDGE.lan;
  /** @param {number} seq @param {string} action @param {string} body @param {string} descr */
  const rule = (seq, action, body, descr) =>
    `<rule><enabled>1</enabled><sequence>${seq}</sequence><action>${action}</action><quick>1</quick><interface>lan</interface>` +
    `<direction>in</direction><ipprotocol>inet</ipprotocol>${body}<description>${descr}</description></rule>`;
  const xml =
    '<?xml version="1.0"?>\n<opnsense>\n<system>\n' +
    '<use_mfs_tmp/><use_mfs_var/><serialspeed>115200</serialspeed><primaryconsole>serial</primaryconsole><secondaryconsole>video</secondaryconsole>\n' +
    '<hostname>fleetwright-edge</hostname><domain>internal</domain>\n' +
    '<group><name>admins</name><description>System Administrators</description><scope>system</scope><gid>1999</gid><member>0</member><priv>page-all</priv></group>\n' +
    // `*` is a locked account to FreeBSD and a hash PHP never verifies: no
    // login on the console, over SSH or in the web interface.
    '<user><name>root</name><descr>System Administrator</descr><scope>system</scope><groupname>admins</groupname><password>*</password><uid>0</uid></user>\n' +
    '<timezone>Etc/UTC</timezone><timeservers>0.opnsense.pool.ntp.org 1.opnsense.pool.ntp.org</timeservers>\n' +
    '<webgui><protocol>https</protocol><noantilockout>1</noantilockout></webgui>\n' +
    '<disablenatreflection>yes</disablenatreflection><usevirtualterminal>1</usevirtualterminal><disableconsolemenu/>\n' +
    '<disablechecksumoffloading>1</disablechecksumoffloading><disablesegmentationoffloading>1</disablesegmentationoffloading><disablelargereceiveoffloading>1</disablelargereceiveoffloading>\n' +
    '<pf_share_forward>1</pf_share_forward>\n' +
    '</system>\n<interfaces>\n' +
    `<wan><enable>1</enable><if>${wanIf}</if><descr>WAN</descr><ipaddr>dhcp</ipaddr><blockpriv>0</blockpriv><blockbogons>0</blockbogons></wan>\n` +
    `<lan><enable>1</enable><if>${lanIf}</if><descr>LAN</descr><ipaddr>${address}</ipaddr><subnet>${prefix}</subnet></lan>\n` +
    '</interfaces>\n' +
    `<dnsmasq><enable>1</enable><port>53053</port><interface>lan</interface><dhcp_ranges><interface>lan</interface><start_addr>${from}</start_addr><end_addr>${to}</end_addr></dhcp_ranges></dnsmasq>\n` +
    '<nat><outbound><mode>automatic</mode></outbound></nat>\n<filter/>\n' +
    '<OPNsense><Firewall>\n' +
    '<Alias><aliases><alias><enabled>1</enabled><name>fleetwright_private</name><type>network</type>' +
    `<content>${NOT_FROM_LABS.join('\n')}</content><description>What labs may not reach</description></alias>` +
    '<alias><enabled>1</enabled><name>fleetwright_dns</name><type>port</type><content>53\n853</content><description>DNS and DNS over TLS</description></alias></aliases></Alias>\n' +
    '<Filter><rules>\n' +
    rule(1, 'pass', '<protocol>TCP/UDP</protocol><source_net>lan</source_net><destination_net>lanip</destination_net><destination_port>53</destination_port>', 'Labs ask the edge for names') +
    '\n' +
    rule(2, 'block', '<protocol>TCP/UDP</protocol><source_net>lan</source_net><destination_net>any</destination_net><destination_port>fleetwright_dns</destination_port>', 'No other resolver') +
    '\n' +
    rule(3, 'block', '<protocol>any</protocol><source_net>lan</source_net><destination_net>fleetwright_private</destination_net>', 'Nothing private from a lab') +
    '\n' +
    rule(4, 'pass', `<protocol>any</protocol><source_net>lan</source_net><destination_net>any</destination_net>${block ? `<divert-to>${EDGE_FILTER.divertPort}</divert-to>` : ''}`, 'Labs reach the internet') +
    '\n</rules><snatrules/><npt/><onetoone/></Filter>\n</Firewall>\n' +
    // Fixed ids, so the same edge is the same bytes, and the IDS can name its cron job.
    '<unboundplus version="1.0.14"><general><enabled>1</enabled></general><dnsbl><blocklist uuid="5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e01">' +
    `<enabled>1</enabled><type>${EDGE_FILTER.blocklists.join(',')}</type><description>Threats</description></blocklist></dnsbl></unboundplus>\n` +
    `<IDS version="1.1.1"><general><enabled>1</enabled>${block ? '<mode>divert</mode>' : ''}<interfaces>lan</interfaces><homenet>${EDGE.lan.address.replace(/\.\d+$/, '.0')}/${prefix}</homenet>` +
    '<UpdateCron>5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e03</UpdateCron></general><files>' +
    EDGE_FILTER.rules.map((f, i) => `<file uuid="${RULE_FILE_UUID}${i}"><filename>${f}</filename><enabled>1</enabled></file>`).join('') +
    '</files>' +
    // Every rule in those files whose action is alert becomes drop: OPNsense
    // applies it as it installs each download (installRules.py).
    (block
      ? '<policies><policy uuid="5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e04"><enabled>1</enabled><action>alert</action>' +
        `<rulesets>${EDGE_FILTER.rules.map((_, i) => `${RULE_FILE_UUID}${i}`).join(',')}</rulesets><new_action>drop</new_action></policy></policies>`
      : '') +
    '</IDS>\n<cron version="1.0.3"><jobs>' +
    `<job uuid="5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e02"><enabled>1</enabled><command>unbound dnsbl</command><minutes>${EDGE_FILTER.every}</minutes><hours>*</hours><description>Blocklists</description></job>` +
    `<job uuid="5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e03"><origin>IDS</origin><enabled>1</enabled><command>ids update</command><minutes>${EDGE_FILTER.every}</minutes><hours>*</hours><description>Rules</description></job>` +
    '</jobs></cron>\n</OPNsense>\n</opnsense>\n';
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
 * @param {{ dir: string, fetchImpl?: typeof fetch, onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} opts
 * @returns {Promise<string>} the path of the checked file
 */
export function fetchImage({ dir, fetchImpl = fetch, onProgress = () => {}, signal }) {
  return fetchPinned({
    dir,
    url: OPNSENSE_IMAGE.url,
    size: OPNSENSE_IMAGE.compressedSize,
    algorithm: 'sha256',
    digest: OPNSENSE_IMAGE.sha256,
    label: 'OPNsense',
    fetchImpl,
    onProgress,
    signal,
  });
}

/**
 * A pinned download: kept in `dir` under its own name, used again only while
 * its size and digest still match, and fetched again otherwise. Shared by the
 * edge router's image and the machine image's (vm-image.js), which differ
 * only in what they pin.
 *
 * @param {{ dir: string, url: string, size: number, algorithm: 'sha256'|'sha512', digest: string, label: string, fetchImpl?: typeof fetch, onProgress?: (done: number, total: number) => void, signal?: AbortSignal }} opts
 * @returns {Promise<string>} the path of the checked file
 */
export async function fetchPinned({ dir, url, size, algorithm, digest, label, fetchImpl = fetch, onProgress = () => {}, signal }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(new URL(url).pathname));
  if (existsSync(file) && statSync(file).size === size && (await digestOf(file, algorithm)) === digest) {
    return file;
  }
  const part = `${file}.part`;
  rmSync(part, { force: true });
  const res = await fetchImpl(url, signal ? { signal } : undefined);
  if (!res.ok || !res.body) throw new Error(`${label}'s mirror answered ${res.status} for the image`);
  const hash = createHash(algorithm);
  let got = 0;
  let told = 0;
  const count = new Transform({
    transform(chunk, _e, cb) {
      hash.update(chunk);
      got += chunk.length;
      if (got - told >= 16 * 1024 * 1024) {
        told = got;
        onProgress(got, size);
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(/** @type {any} */ (res.body), count, createWriteStream(part), signal ? { signal } : {});
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  const seen = hash.digest('hex');
  if (seen !== digest) {
    rmSync(part, { force: true });
    const name = algorithm === 'sha512' ? 'SHA-512' : 'SHA-256';
    throw new Error(`the ${label} image downloaded with ${name} ${seen.slice(0, 16)}…, not the published ${digest.slice(0, 16)}…, so it was not used`);
  }
  renameSync(part, file);
  return file;
}

/** @param {string} file @param {'sha256'|'sha512'} algorithm */
async function digestOf(file, algorithm) {
  const hash = createHash(algorithm);
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/**
 * The raw disk, unpacked by bzip2 as it is read. Node has no bzip2 of its
 * own; a machine without the tool is told which package to install.
 *
 * @param {string} file
 * @param {{ spawnImpl?: typeof spawn, signal?: AbortSignal }} [opts]
 */
export function unpack(file, { spawnImpl = spawn, signal } = {}) {
  const child = spawnImpl('bzip2', ['-dc', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  signal?.addEventListener('abort', () => child.kill(), { once: true });
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
 * @param {{ address: string, pin: string|null, plain: boolean, sendTo: string, body: import('node:stream').Readable, size: number, filename?: string, onProgress?: (done: number, total: number) => void, connectTls?: typeof connectPinnedTls, signal?: AbortSignal }} opts
 * @returns {Promise<string>}
 */
export async function uploadDisk({ address, pin, plain, sendTo, body, size, filename = 'opnsense.img', onProgress = () => {}, connectTls = connectPinnedTls, signal }) {
  const { host, port } = splitAddress(address, plain ? 80 : 443);
  const socket = plain ? await connectPlain(host, port) : await connectTls({ host, port, pin: /** @type {string} */ (pin) });
  const boundary = `fleetwright${Date.now().toString(36)}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
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
    // CANCEL STOPS THE BYTES, not only the steps after them: the request is
    // torn down and the body with it, and ensureEdge clears up after.
    signal?.addEventListener(
      'abort',
      () => {
        const e = new Error('cancelled');
        body.destroy();
        req.destroy(e);
        reject(e);
      },
      { once: true },
    );
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

/** What a group network is called in Xen Orchestra, numbered from 1. */
export const GROUP_PREFIX = 'fleetwright-group-';
/** The most group networks a policy makes on one pool. */
export const MAX_GROUPS = 4;

/**
 * Group networks: private networks in the pool with no physical interface,
 * so nothing reaches them but the machines on them. A machine joins one as
 * well as its own network to reach the others in its group (docs/
 * hypervisors.md, "Machines that work together"). Made by the policy job,
 * which holds the admin sign-in, because the fleet's limited user cannot
 * make networks; then put in the resource set, so it can use them. Never
 * removed here: a machine may be on one.
 *
 * @param {{ admin: any, pool: string, networks: any[], setId: string, inSet: string[], count: number }} opts
 * @returns {Promise<string[]>} the names made now
 */
export async function ensureGroups({ admin, pool, networks, setId, inSet, count }) {
  /** @type {string[]} */
  const made = [];
  for (let i = 1; i <= Math.min(count, MAX_GROUPS); i++) {
    const name = `${GROUP_PREFIX}${i}`;
    let id = networks.find((n) => n?.name_label === name && n?.$pool === pool)?.id;
    if (!id) {
      id = await admin.call('network.create', {
        pool,
        name,
        description: 'Machines in a group reach each other here, and nothing else does. Made by Fleetwright.',
      });
      made.push(name);
    }
    if (!inSet.includes(id)) await admin.call('resourceSet.addObject', { id: setId, object: id });
  }
  return made;
}

/**
 * Where the router's disk goes: the storage the person chose for it, or,
 * when they chose none (a phone that predates the choice), the storage the
 * fleet may use in this pool with the most room. Either must be in the pool
 * and have room for the whole raw disk.
 *
 * @param {{ pool: string, srs: any[], fleetSrs: string[], sr?: string|null }} opts
 */
export function edgeStorage({ pool, srs, fleetSrs, sr = null }) {
  const room = (/** @type {any} */ s) => (Number(s?.size) || 0) - (Number(s?.physical_usage) || 0);
  const fits = (/** @type {any} */ s) => s?.$pool === pool && room(s) > OPNSENSE_IMAGE.rawSize;
  if (sr) {
    const chosen = srs.find((s) => s?.id === sr);
    if (!chosen || chosen.$pool !== pool) throw new Error('the storage chosen for the edge router is not in the way out’s pool. Nothing was built');
    if (!fits(chosen)) throw new Error(`${srName(chosen)} has no 3 GiB free for the edge router. Nothing was built`);
    return chosen;
  }
  const best = srs.filter((s) => fleetSrs.includes(s?.id) && fits(s)).sort((a, b) => room(b) - room(a))[0];
  if (!best) throw new Error('none of the storage the fleet may use in this pool has 3 GiB free for the edge router. Choose where its disk goes. Nothing was built');
  return best;
}

/** A storage repository as a person knows it. @param {any} sr */
export const srName = (sr) => String(sr?.name_label || sr?.id || 'the storage').slice(0, 80);

/**
 * How far a build has got, for the bar: which of its stages is running, and
 * how far through the whole build that is, in thousandths. Weighted by the
 * bytes each stage moves (the download, then the disk), because those are
 * nearly all of the time; making and starting the VM is the last fiftieth.
 *
 * @typedef {{ stage: number, stages: number, fill: number }} BuildPart
 */
export const BUILD_STAGES = 3;
const MAKING = 980;
/** @param {number} downloaded @param {number} written */
export function buildFill(downloaded, written) {
  const bytes = OPNSENSE_IMAGE.compressedSize + OPNSENSE_IMAGE.rawSize;
  return Math.min(MAKING, Math.floor((MAKING * (Math.min(downloaded, OPNSENSE_IMAGE.compressedSize) + Math.min(written, OPNSENSE_IMAGE.rawSize))) / bytes));
}

/**
 * The edge router on this pool: left as it is when it is there (its WAN moved
 * to the way out if that changed, and started if it was stopped), built when
 * it is not. Answers the sentence the job finishes with.
 *
 * WHAT THE PERSON IS TOLD, AS IT GOES: which stage of three, how far through
 * the whole build in thousandths (`say`'s second argument), and in the words,
 * the megabytes and the storage the disk is going on. Asked for: "this needs
 * proper progress, also which disk did it put it on?" The first version held
 * the bar at the step and never named the storage.
 *
 * CANCEL STOPS IT. `signal` aborts the download, the unpack and the upload
 * where they are, and what was made is removed: the VM with its disk, the
 * disk on its own, or a partial disk Xen Orchestra kept from an upload that
 * was cut off (unattached, named for the router, on the storage it was going
 * to). The first version's Cancel waited for the build to finish.
 *
 * BLOCK OR WATCH (`block`): true builds an edge that drops what its threat
 * rules match, false one that only logs it, and null leaves an edge that is
 * there as it is (a phone that predates the choice sends nothing, and must
 * not cost anybody their edge). The edge cannot be changed in place, since
 * it has no login, so an edge built the other way is REBUILT: stopped, a new
 * one built beside it, and only then removed. If the new one fails or is
 * cancelled, it is removed and the old one started again, so the pool is
 * never left with neither. What the machines behind it notice is the way out
 * gone for as long as the build takes. `rebuilding` is told first, so the job
 * can say "rebuilding" rather than "building" if it is cancelled.
 *
 * @param {{
 *   admin: any,
 *   pool: string,
 *   egress: { id: string, name: string },
 *   uplink: string,
 *   srs: any[],
 *   fleetSrs: string[],
 *   sr?: string|null,
 *   block?: boolean|null,
 *   rebuilding?: () => void,
 *   address: string, pin: string|null, plain: boolean,
 *   imageDir: string,
 *   say: (text: string, part?: BuildPart) => void,
 *   signal?: AbortSignal,
 *   getImage?: typeof fetchImage,
 *   unpackImpl?: typeof unpack,
 *   upload?: typeof uploadDisk,
 * }} opts
 */
export async function ensureEdge(opts) {
  const { admin, pool, egress, block = null, rebuilding, say } = opts;
  const vms = Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {});
  const edge = /** @type {any} */ (vms.find((v) => /** @type {any} */ (v)?.$pool === pool && /** @type {any} */ (v)?.tags?.includes?.(EDGE.tag)));
  const blocks = edge?.tags?.includes?.(EDGE.blocksTag) === true;
  if (edge && block !== null && block !== blocks) {
    rebuilding?.();
    say(block ? 'Rebuilding the edge router to drop what its threat rules match. Machines behind it have no way out until it is up.' : 'Rebuilding the edge router to log what its threat rules match and drop nothing. Machines behind it have no way out until it is up.');
    if (edge.power_state !== 'Halted') await admin.call('vm.stop', { id: edge.id, force: true });
    let said;
    try {
      said = await buildEdge({ ...opts, block });
    } catch (e) {
      // Never neither: the one that was there comes back as it was.
      await admin.call('vm.start', { id: edge.id }).catch(() => {});
      /** @type {Error} */ (e).message = `${/** @type {Error} */ (e).message}. The edge router it was replacing was started again, as it was`;
      throw e;
    }
    await admin.call('vm.delete', { id: edge.id, deleteDisks: true });
    return `${said} It replaced the one that was there, which was removed.`;
  }
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
    return [`The edge router was already there, on ${egress.name}, ${blocks ? 'dropping' : 'logging'} what its threat rules match.`, ...said].join(' ');
  }
  return buildEdge({ ...opts, block: block === true });
}

/**
 * A new edge router, built, tagged with how it filters, and started.
 *
 * @param {Parameters<typeof ensureEdge>[0] & { block: boolean }} opts
 */
async function buildEdge({ admin, pool, egress, uplink, srs, fleetSrs, sr: chosenSr = null, block, address, pin, plain, imageDir, say, signal, getImage = fetchImage, unpackImpl = unpack, upload = uploadDisk }) {
  const sr = edgeStorage({ pool, srs, fleetSrs, sr: chosenSr });
  const on = srName(sr);

  const templates = Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {});
  const template = /** @type {any} */ (templates.find((t) => /** @type {any} */ (t)?.$pool === pool && /** @type {any} */ (t)?.name_label === EDGE.template));
  if (!template) throw new Error(`this pool has no "${EDGE.template}" template to make the edge router from. Nothing was built`);

  const stage = (/** @type {number} */ n, /** @type {number} */ fill) => ({ stage: n, stages: BUILD_STAGES, fill });
  say(`Downloading OPNsense ${OPNSENSE_IMAGE.release}.`, stage(1, 0));
  let downloaded = 0;
  const file = await getImage({
    dir: imageDir,
    signal,
    onProgress: (d, t) => {
      downloaded = d;
      say(`Downloading OPNsense ${OPNSENSE_IMAGE.release}: ${mb(d)} of ${mb(t)} MB.`, stage(1, buildFill(d, 0)));
    },
  });
  signal?.throwIfAborted();
  if (!downloaded) say(`OPNsense ${OPNSENSE_IMAGE.release} was already downloaded and checked.`, stage(1, buildFill(OPNSENSE_IMAGE.compressedSize, 0)));

  /** @type {string|null} */
  let vdi = null;
  /** @type {string|null} */
  let vm = null;
  try {
    say(`Writing the edge router’s disk to ${on}.`, stage(2, buildFill(OPNSENSE_IMAGE.compressedSize, 0)));
    const { $sendTo } = await admin.call('disk.import', {
      sr: sr.id,
      type: 'iso',
      name: EDGE.vm,
      description: `OPNsense ${OPNSENSE_IMAGE.release}, configured by Fleetwright as the edge router`,
    });
    const body = unpackImpl(file, { signal }).pipe(new ConfigPatch({ offset: OPNSENSE_IMAGE.config.offset, replacement: edgeConfig({ block }), total: OPNSENSE_IMAGE.rawSize }));
    vdi = await upload({
      address,
      pin,
      plain,
      sendTo: $sendTo,
      body,
      size: OPNSENSE_IMAGE.rawSize,
      signal,
      onProgress: (d, t) => say(`Writing the edge router’s disk to ${on}: ${mb(d)} of ${mb(t)} MB.`, stage(2, buildFill(OPNSENSE_IMAGE.compressedSize, d))),
    });
    signal?.throwIfAborted();

    say(`Making the edge router, its disk on ${on}, and starting it.`, stage(3, MAKING));
    vm = await admin.call('vm.create', {
      template: template.id,
      name_label: EDGE.vm,
      name_description: 'The only way out of every lab. Made by Fleetwright; its rules are fixed and it has no login.',
      VIFs: [{ network: egress.id }, { network: uplink }],
      VDIs: [],
      CPUs: EDGE.cpus,
      memory: EDGE.memory,
      tags: block ? [EDGE.tag, EDGE.blocksTag] : [EDGE.tag],
      bootAfterCreate: false,
    });
    await admin.call('vm.attachDisk', { vm, vdi, bootable: true, position: '0' });
    const vifs = Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VIF', $VM: vm } })) || {});
    for (const v of vifs) await admin.call('vif.set', { id: /** @type {any} */ (v).id, txChecksumming: false });
    signal?.throwIfAborted();
    await admin.call('vm.start', { id: vm });
  } catch (e) {
    // Nothing half-made is left for the next run to trip over.
    if (vm) await admin.call('vm.delete', { id: vm, deleteDisks: true }).catch(() => {});
    else if (vdi) await admin.call('vdi.delete', { id: vdi }).catch(() => {});
    else await removePartialDisk(admin, sr.id);
    throw e;
  }
  const { address: lan, prefix } = EDGE.lan;
  return (
    `The edge router is up: OPNsense ${OPNSENSE_IMAGE.release}, its WAN on ${egress.name} and its LAN on ${EDGE.uplink} at ${lan}/${prefix}, its disk on ${on}. ` +
    `Labs on the uplink reach the internet and nothing private, and what its threat rules match is ${block ? 'dropped' : 'logged'}. It has no login; its rules are fixed.`
  );
}

/**
 * A disk an upload left behind when it was cut off: named for the router, on
 * the storage it was going to, and attached to nothing. Only those, so the
 * disk of a router that is there is never touched.
 *
 * @param {any} admin @param {string} sr
 */
async function removePartialDisk(admin, sr) {
  try {
    const vdis = Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VDI', name_label: EDGE.vm, $SR: sr } })) || {});
    for (const d of /** @type {any[]} */ (vdis)) {
      if (!Array.isArray(d?.$VBDs) || d.$VBDs.length === 0) await admin.call('vdi.delete', { id: d.id }).catch(() => {});
    }
  } catch {
    /* clearing up is best effort; the error that brought us here is the one said */
  }
}
