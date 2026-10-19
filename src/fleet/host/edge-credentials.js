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
// THE KEY IS KEPT where the next policy job finds it and nobody below an admin
// of Xen Orchestra can read it (EDGE_KEPT, below), beside the pair's CARP
// password, and it goes to the person's phone sealed at the end of a policy
// job, which keeps it in their vault with the pool's token. Only a box they
// approved for the pool holds it.
//
// NOT ON THE ROUTERS, where it was. Both were kept in each router's
// xenStoreData, on the word that only Xen Orchestra's admins could read it and
// the fleet's token could not see the routers at all. Measured on Xen
// Orchestra 5.211.0, `xo.getAllObjects` has no permission check: every
// signed-in user, the fleet's limited token on every approved box and any
// unrelated user of that Xen Orchestra, reads every VM with its xenStoreData,
// and read both back verbatim. What a router carries now is a mark of each,
// useless to whoever reads it (markCarp, the certificate's pin), so the job
// can tell whether what it kept is what the router has.

import { createHash, generateKeyPairSync, randomBytes, scryptSync, sign } from 'node:crypto';

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
/**
 * A certificate's time, as RFC 5280 requires it: UTCTime through 2049 and
 * GeneralizedTime from 2050. UTCTime has a two-digit year read as 1950-2049,
 * so a twenty-year certificate made from 2030 on said it had expired in 1950.
 * The box pins the certificate and never reads its dates; anything that does
 * would refuse it.
 *
 * @param {Date} d
 */
const certTime = (d) => {
  const digits = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return d.getUTCFullYear() >= 2050
    ? der(0x18, Buffer.from(`${digits}Z`, 'ascii'))
    : der(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'));
};
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
  // POSITIVE AND WITH NO LEADING ZERO, both of which DER requires of an
  // INTEGER. Clearing the top bit alone left a first byte of zero one time in
  // 128, and OpenSSL refuses that serial as "illegal padding" whenever the
  // next byte would have stood on its own: a router in every 256 or so came
  // up with a certificate its own web server could not load.
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    ecdsaSha256,
    name(cn),
    seq(certTime(new Date(now - 86_400_000)), certTime(new Date(now + 20 * 365 * 86_400_000))),
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
 * WHERE THE POLICY JOB KEEPS WHAT IT MUST REMEMBER: the pair's CARP password,
 * which a router rebuilt beside a running one must share, and the routers'
 * key, which a rebuild keeps so the person's vault stays right. In the
 * preferences of a user of Xen Orchestra made for it, `fleetwright-edge-keys`,
 * one entry per pool.
 *
 * WHY THERE. It has to be in Xen Orchestra, because the next job may run on
 * another box and the box that ran this one keeps nothing (xo-setup.js). And
 * it has to be somewhere only an admin reads, which xenStoreData, other_config,
 * tags and names are not: `xo.getAllObjects` shows all of them to anybody
 * signed in. A user's preferences come back from `user.getAll`, which is
 * `permission = 'admin'`, and from `session.getUser`, which answers only the
 * user signed in. Measured on 5.211.0 with the fleet's token and with a plain
 * user: `user.getAll` refused, "not enough permissions"; `session.getUser`
 * their own user; `user.set` on the keeper refused, "a user can only change
 * its own properties"; the REST API's `/rest/v0/users` an empty list and
 * `/rest/v0/users/<id>` 403; and no answer to `xo.getAllObjects`, `group`,
 * `acl`, `resourceSet`, `cloudConfig` or token calls carried the value. An
 * admin read it back with `user.getAll`.
 *
 * NOBODY SIGNS IN AS IT: it is made with a random password nobody keeps, and
 * with permission `none`, so it can do nothing if somebody did. An admin who
 * deletes it loses nothing the routers need; the next job finds nothing kept,
 * and makes and hands on new ones, the way a pair that lost its password is
 * made again (edge-router.js, ensureEdge).
 */
export const EDGE_KEPT = Object.freeze({
  user: 'fleetwright-edge-keys',
  /** The preference a pool's entry is under. @param {string} pool */
  entry: (pool) => `fleetwright-edge:${pool}`,
  /** On each router, in xenStoreData: a mark of the pair's password, and the pin of the key's certificate. */
  carpMark: 'fleetwright-carp-mark',
  watchPin: 'fleetwright-watch-pin',
  /** Where both were kept in the clear, before: cleared from every router that still has them. */
  exposed: Object.freeze(['fleetwright-carp', 'fleetwright-watch']),
});

/**
 * A mark of the pair's CARP password, for a router to carry where anybody
 * signed in can read it: scrypt, salted with a label of its own, of 128 random
 * bits. It says which password a router has and nothing about what it is.
 *
 * SCRYPT, NOT A PLAIN HASH. 128 random bits need no stretching to stay unread,
 * and a SHA-256 of them would do; but this is read by everybody signed in to
 * the Xen Orchestra, and the stretching is what keeps it so if the password is
 * ever one a person chose. One call a policy run, deterministic by the salt so
 * the next job can compare.
 *
 * @param {string} password
 */
export const markCarp = (password) => scryptSync(password, 'fleetwright-carp-mark/v2', 32).toString('hex');

/**
 * A value set on a router with `vm.set`'s xenStoreData, read back, or null.
 *
 * UNDER `vm-data/`: Xen Orchestra files every key it is given there (its
 * vm.set prefixes them) and hands xenstore_data back as XAPI holds it, prefix
 * and all. Read by the name it was set with, the key was never there, so every
 * policy run found neither the routers' key nor the pair's CARP password, made
 * new ones, and rebuilt both routers the way a pair that lost its password is.
 *
 * @param {any} vm @param {string} key @returns {string|null}
 */
export function keptOn(vm, key) {
  const raw = vm?.xenStoreData?.[`vm-data/${key}`];
  return typeof raw === 'string' ? raw : null;
}

/** A router that still carries the pair's password or the key in the clear, as buildEdge kept them before. @param {any} vm */
export const exposedOn = (vm) => EDGE_KEPT.exposed.some((k) => keptOn(vm, k) !== null);

/**
 * Those values taken off every router that has them (`vm.set` deletes a key
 * given as null; measured on 5.211.0). What they were is not trusted again:
 * the job finds nothing kept for them, and builds the routers again with new
 * ones (edge-router.js, ensureEdge).
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin @param {any[]} vms
 * @returns {Promise<number>} how many were cleared
 */
export async function clearExposed(admin, vms) {
  let n = 0;
  for (const vm of vms.filter(exposedOn)) {
    await admin.call('vm.set', { id: vm.id, xenStoreData: Object.fromEntries(EDGE_KEPT.exposed.map((k) => [k, null])) });
    n++;
  }
  return n;
}

/**
 * A key, held to what newWatch makes, or null.
 *
 * @param {any} w @returns {Watch|null}
 */
function asWatch(w) {
  const b64 = /^[A-Za-z0-9+/]{80}$/;
  if (w?.v !== 1 || !b64.test(w.key) || !b64.test(w.secret) || !/^[./0-9A-Za-z]{1,16}$/.test(w.salt) || !/^[0-9a-f]{13}$/.test(w.refid)) return null;
  if (!/^[0-9a-f]{64}$/.test(w.pin) || !String(w.crt).includes('BEGIN CERTIFICATE') || !String(w.prv).includes('BEGIN PRIVATE KEY')) return null;
  return { v: 1, key: w.key, secret: w.secret, salt: w.salt, refid: w.refid, crt: w.crt, prv: w.prv, pin: w.pin };
}

/** @param {{ call: (method: string, params?: any) => Promise<any> }} admin */
async function keeperOf(admin) {
  const users = await admin.call('user.getAll');
  return (Array.isArray(users) ? users : []).find((u) => u?.email === EDGE_KEPT.user) ?? null;
}

/**
 * What the policy job kept for a pool: the pair's CARP password and the
 * routers' key, each or null. Called with the admin session.
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin @param {string} pool
 * @returns {Promise<{ carp: string|null, watch: Watch|null }>}
 */
export async function keptFor(admin, pool) {
  const raw = (await keeperOf(admin))?.preferences?.[EDGE_KEPT.entry(pool)];
  try {
    const k = typeof raw === 'string' ? JSON.parse(raw) : null;
    return { carp: typeof k?.carp === 'string' && /^[0-9a-f]{16,64}$/.test(k.carp) ? k.carp : null, watch: asWatch(k?.watch) };
  } catch {
    return { carp: null, watch: null };
  }
}

/**
 * The pair's password and the routers' key kept for a pool, the keeper made
 * first when there is none. Before the routers that hold them are made, so a
 * router never has one nothing kept.
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin @param {string} pool
 * @param {{ carp: string|null, watch: Watch|null }} kept
 */
export async function keepFor(admin, pool, { carp, watch }) {
  let id = (await keeperOf(admin))?.id;
  if (!id) {
    id = await admin.call('user.create', { email: EDGE_KEPT.user, password: randomBytes(32).toString('base64url'), permission: 'none' });
    if (typeof id !== 'string' || !id) throw new Error('Xen Orchestra made the user the edge routers’ keys are kept with without saying its id');
  }
  await admin.call('user.set', { id, preferences: { [EDGE_KEPT.entry(pool)]: JSON.stringify({ v: 1, carp, watch }) } });
}

/**
 * The key a router was built with, when it is the one the job kept: the
 * router carries its certificate's pin, and only the kept key with that pin is
 * it. Null for a router built with another, or with none.
 *
 * @param {any} vm @param {Watch|null} kept @returns {Watch|null}
 */
export function watchOf(vm, kept) {
  return kept && keptOn(vm, EDGE_KEPT.watchPin) === kept.pin ? kept : null;
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
