// What a box needs to read how a pool's edge routers are, and what the
// routers need to let it. docs/hypervisors.md, "Watching the edge routers".
//
// ASKED FOR: "Why is there no live info of opnsense in the app to help trouble
// shoot this?", during a two-router DNS failure that nothing on the phone could
// explain. The routers had no login and no API on purpose, so the answer was
// in them and nowhere else.
//
// WHAT THIS ADDS TO A ROUTER, and only this:
//   - a user, `fleetwright-watch`, with no password and one API key, whose
//     privileges are the four status pages a person troubleshooting the routers
//     needs: CARP, Unbound, gateways and dnsmasq's leases. OPNsense has no
//     read-only form of any of them (each privilege covers its whole page,
//     service control included), so the user also gets `user-config-readonly`,
//     which refuses every change to the configuration. What is left that the
//     key can do is what docs/security.md says: stop or start those services,
//     put CARP into maintenance, and nothing to the firewall's rules.
//   - a TLS certificate made here, so the box that reads the API holds the
//     connection to its SHA-256 and the key is never sent to anything else.
//   - one rule, on the WAN, passing HTTPS to the router from private addresses
//     only. Every inside network already blocks private destinations, the
//     router's own addresses among them, so nothing behind it reaches the API.
//   - syslog sent to the boxes named, which is how what happened before a box
//     looked survives the router's memory-backed /var.
//
// THE KEY IS KEPT where the next rebuild finds it, on the routers in Xen
// Orchestra beside the pair's CARP password (only Xen Orchestra's admins can
// read it; the fleet's token cannot see the routers at all), and it goes to the
// person's phone sealed at the end of a policy job, which keeps it in their
// vault with the pool's token. Only a box they approved for the pool holds it.

import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export const EDGE_WATCH = Object.freeze({
  user: 'fleetwright-watch',
  uid: 2000,
  /**
   * From OPNsense 26.7's ACL.xml files: get_vip_status, unbound/service/status,
   * routes/gateway/status and dnsmasq/leases/search, and nothing else of
   * theirs is asked. `user-config-readonly` refuses every model save.
   */
  privileges: Object.freeze(['page-status-carp', 'page-services-unbound', 'page-system-gateways', 'page-services-dnsforwarder', 'user-config-readonly']),
  /** Where syslog goes on a box: a port above 1024, so the sidecar can listen without root. */
  syslogPort: 5514,
  /** syslog-ng program names (plugins_syslog in OPNsense's plugins.inc.d): CARP comes from the kernel. */
  programs: Object.freeze(['kernel', 'unbound', 'dnsmasq', 'dpinger', 'suricata']),
  /** On a router built with all of the above. One without it is rebuilt once to get it. */
  tag: 'fleetwright-edge-watch',
  /** Where the key is kept on each router in Xen Orchestra. */
  key: 'fleetwright-watch',
});

const CRYPT64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** The byte order SHA-512-crypt encodes its digest in, three bytes at a time (the spec's b64_from_24bit calls). */
const CRYPT_ORDER = [
  [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48],
  [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13],
  [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41],
];

/**
 * SHA-512-crypt (`$6$`), as glibc's crypt(3) and PHP's crypt() make it, with
 * the default 5,000 rounds. What OPNsense keeps of an API secret, and checks
 * with password_verify (OPNsense/Auth/API.php). Ulrich Drepper's
 * specification, step by step; the test holds it to its published vector and
 * to `openssl passwd -6`.
 *
 * @param {string} password @param {string} salt up to 16 characters of ./0-9A-Za-z
 */
export function sha512Crypt(password, salt) {
  const P = Buffer.from(password, 'utf8');
  const S = Buffer.from(salt.slice(0, 16), 'utf8');
  const h = () => createHash('sha512');
  const B = h().update(P).update(S).update(P).digest();
  const a = h().update(P).update(S);
  for (let n = P.length; n > 0; n -= 64) a.update(n > 64 ? B : B.subarray(0, n));
  for (let n = P.length; n > 0; n >>= 1) a.update(n & 1 ? B : P);
  let A = a.digest();
  const dp = h();
  for (let i = 0; i < P.length; i++) dp.update(P);
  const DP = dp.digest();
  const pSeq = Buffer.alloc(P.length);
  for (let i = 0; i < P.length; i++) pSeq[i] = DP[i % 64];
  const ds = h();
  for (let i = 0; i < 16 + A[0]; i++) ds.update(S);
  const DS = ds.digest();
  const sSeq = Buffer.alloc(S.length);
  for (let i = 0; i < S.length; i++) sSeq[i] = DS[i % 64];
  for (let i = 0; i < 5000; i++) {
    const c = h();
    c.update(i & 1 ? pSeq : A);
    if (i % 3) c.update(sSeq);
    if (i % 7) c.update(pSeq);
    c.update(i & 1 ? A : pSeq);
    A = c.digest();
  }
  let out = '';
  const put = (/** @type {number} */ w, /** @type {number} */ n) => {
    for (let i = 0; i < n; i++, w >>= 6) out += CRYPT64[w & 0x3f];
  };
  for (const [b2, b1, b0] of CRYPT_ORDER) put((A[b2] << 16) | (A[b1] << 8) | A[b0], 4);
  put(A[63], 2);
  return `$6$${S.toString('utf8')}$${out}`;
}

// DER, the few shapes a certificate needs.
/** @param {number} tag @param {Buffer} body */
const der = (tag, body) => {
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (/** @type {Buffer[]} */ ...parts) => der(0x30, Buffer.concat(parts));
/** @param {string} dotted */
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  /** @type {number[]} */
  const bytes = [40 * a + b];
  for (const v of rest) {
    const chunk = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
};
/** @param {Date} d */
const utcTime = (d) => der(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii'));
const name = (/** @type {string} */ cn) => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn, 'utf8')))));

/**
 * A self-signed certificate for the router's web interface and API: ECDSA
 * P-256, signed with SHA-256, for 20 years (nobody can log in to renew it;
 * the next rebuild makes the router again and keeps it). OPNsense keeps its
 * PEM base64'd in a top-level <cert> (Trust/Cert.xml) and lighttpd serves it.
 *
 * @param {{ cn: string, now?: number }} opts
 * @returns {{ crt: string, prv: string, pin: string }} PEMs, and the SHA-256 of the DER the box pins
 */
export function selfSigned({ cn, now = Date.now() }) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const serial = randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ecdsaSha256,
    name(cn),
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 20 * 365 * 86_400_000))),
    name(cn),
    spki,
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const cert = seq(tbs, ecdsaSha256, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;
  return { crt: pem, prv: String(privateKey.export({ type: 'pkcs8', format: 'pem' })), pin: createHash('sha256').update(cert).digest('hex') };
}

/**
 * @typedef {{ v: 1, key: string, secret: string, salt: string, refid: string, crt: string, prv: string, pin: string }} Watch
 */

/**
 * A new key and certificate for a pool's routers: the key as OPNsense makes
 * one (80 base64 characters), the secret the same, which may hold neither
 * `|` nor `:` (OPNsense splits on both), and the certificate's id in its
 * own form, thirteen hex digits.
 *
 * @param {{ now?: number }} [opts] @returns {Watch}
 */
export function newWatch({ now = Date.now() } = {}) {
  const b64 = () => randomBytes(60).toString('base64');
  const salt = randomBytes(12).toString('base64').replace(/[+=]/g, '.').slice(0, 16);
  const { crt, prv, pin } = selfSigned({ cn: 'fleetwright-edge', now });
  return { v: 1, key: b64(), secret: b64(), salt, refid: randomBytes(7).toString('hex').slice(0, 13), crt, prv, pin };
}

/**
 * The key a router was built with, where buildEdge kept it, or null.
 *
 * @param {any} vm @returns {Watch|null}
 */
export function watchOf(vm) {
  const raw = vm?.xenStoreData?.[EDGE_WATCH.key];
  if (typeof raw !== 'string') return null;
  try {
    const w = JSON.parse(raw);
    const b64 = /^[A-Za-z0-9+/]{80}$/;
    if (w?.v !== 1 || !b64.test(w.key) || !b64.test(w.secret) || !/^[./0-9A-Za-z]{1,16}$/.test(w.salt) || !/^[0-9a-f]{13}$/.test(w.refid)) return null;
    if (!/^[0-9a-f]{64}$/.test(w.pin) || !String(w.crt).includes('BEGIN CERTIFICATE') || !String(w.prv).includes('BEGIN PRIVATE KEY')) return null;
    return { v: 1, key: w.key, secret: w.secret, salt: w.salt, refid: w.refid, crt: w.crt, prv: w.prv, pin: w.pin };
  } catch {
    return null;
  }
}

/**
 * What the router's config.xml gains, in four parts edgeConfig puts in place.
 * Syslog goes to each of `to` that is an IPv4 address, and is left out when
 * none is: a destination the router cannot send to is worse than none.
 *
 * @param {Watch} w @param {string[]} [to]
 */
export function watchConfig(w, to = []) {
  const hosts = to.filter((ip) => /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/.test(ip)).slice(0, 2);
  const b64 = (/** @type {string} */ s) => Buffer.from(s, 'utf8').toString('base64');
  return {
    // No password (`*`, as root's), so no login anywhere: only the key.
    user:
      `<user><name>${EDGE_WATCH.user}</name><descr>Fleetwright reads how the router is</descr><scope>user</scope><password>*</password><uid>${EDGE_WATCH.uid}</uid>` +
      `<priv>${EDGE_WATCH.privileges.join(',')}</priv><apikeys>${w.key}|${sha512Crypt(w.secret, w.salt)}</apikeys></user>\n`,
    cert: `<cert uuid="5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e10"><refid>${w.refid}</refid><descr>Fleetwright</descr><crt>${b64(w.crt)}</crt><prv>${b64(w.prv)}</prv></cert>\n`,
    certref: `<ssl-certref>${w.refid}</ssl-certref>`,
    // Stamped one below 1.0.2, as edgeConfig stamps every model (VERSIONS
    // STAMPED ONE BELOW CURRENT there): M1_0_2 runs, finds no legacy
    // <syslog>, and the model is saved with its defaults written in.
    syslog: hosts.length
      ? '<Syslog version="1.0.1"><destinations>' +
        hosts
          .map(
            (ip, i) =>
              `<destination uuid="5c0e8a3e-6f1d-4b8a-9d2e-1a7b3c4d5e2${i}"><enabled>1</enabled><transport>udp4</transport><program>${EDGE_WATCH.programs.join(',')}</program>` +
              `<hostname>${ip}</hostname><port>${EDGE_WATCH.syslogPort}</port><rfc5424>0</rfc5424><description>Fleetwright</description></destination>`,
          )
          .join('') +
        '</destinations></Syslog>\n'
      : '',
  };
}
