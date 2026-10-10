// The key a box reads a pool's edge routers with, and the certificate it
// holds them to. docs/hypervisors.md, "Watching the edge routers".
//
//   node --test test/edge-credentials.test.js
//
// ASKED FOR: "Why is there no live info of opnsense in the app to help trouble
// shoot this?" The routers learn the key's SHA-512-crypt hash and serve the
// certificate; a box sends the key only over TLS held to that certificate.

import test from 'node:test';
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';

import { EDGE_WATCH, newWatch, sha512Crypt, watchConfig, watchOf } from '../src/fleet/host/edge-credentials.js';
import { connectPinnedTls } from '../src/fleet/host/xo-ws.js';

test('a secret is kept as OPNsense checks it: SHA-512-crypt, matching glibc and openssl', () => {
  // The specification's own vector, and `openssl passwd -6` for a secret as
  // long as the ones made here, which crosses the digest's 64-byte blocks.
  assert.equal(sha512Crypt('Hello world!', 'saltstring'), '$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1');
  assert.equal(sha512Crypt('x'.repeat(80), 'aB3./xYz90abcdef'), '$6$aB3./xYz90abcdef$qYBxturwljtma/vivB96LRqJLf98rOOh.rhMftl3O7EalgQtGmou5NmtLE7EJhb0aD6MvUXFE1nl0r8/ep4qn1');
});

test('the router’s certificate is one TLS serves, and a box holds the connection to it and to nothing else', async (t) => {
  const w = newWatch();
  const cert = new X509Certificate(w.crt);
  assert.equal(cert.subject, 'CN=fleetwright-edge');
  assert.ok(cert.verify(cert.publicKey), 'self-signed with its own key');
  assert.ok(new Date(cert.validTo).getTime() > Date.now() + 19 * 365 * 86_400_000, 'outlives the router: nobody can log in to renew it');
  const server = tls.createServer({ cert: w.crt, key: w.prv }, (s) => s.end());
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => server.close());
  const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  const ok = await connectPinnedTls({ host: '127.0.0.1', port, pin: w.pin });
  ok.destroy();
  await assert.rejects(connectPinnedTls({ host: '127.0.0.1', port, pin: newWatch().pin }), 'another certificate is not this router');
});

test('what a router is given: one user with only the status pages and the key’s hash, its certificate, and syslog to private addresses', () => {
  const w = newWatch();
  const parts = watchConfig(w, ['192.168.1.20', 'holder.lan', '8.8.8.8x', '10.0.0.5', '10.0.0.6']);
  const [, key, hash] = /** @type {RegExpExecArray} */ (/<apikeys>([^|<]+)\|([^<]+)<\/apikeys>/.exec(parts.user));
  assert.equal(key, w.key);
  assert.equal(hash, sha512Crypt(w.secret, w.salt), 'the secret itself is never written');
  assert.ok(!parts.user.includes(w.secret));
  assert.match(parts.user, /<password>\*<\/password>/, 'no login anywhere: only the key');
  assert.equal(/<priv>([^<]*)<\/priv>/.exec(parts.user)?.[1], 'page-status-carp,page-services-unbound,page-system-gateways,page-services-dnsforwarder,user-config-readonly');
  assert.equal(Buffer.from(/** @type {string} */ (/<crt>([^<]*)<\/crt>/.exec(parts.cert)?.[1]), 'base64').toString(), w.crt, 'OPNsense keeps the PEM base64’d');
  assert.equal(parts.certref, `<ssl-certref>${w.refid}</ssl-certref>`);
  assert.deepEqual([...parts.syslog.matchAll(/<hostname>([^<]*)<\/hostname>/g)].map((m) => m[1]), ['192.168.1.20', '10.0.0.5'], 'addresses only, two at most');
  assert.match(parts.syslog, /^<Syslog version="1\.0\.1">/, 'one below 1.0.2, so the model is migrated and saved with its defaults');
  assert.match(parts.syslog, new RegExp(`<transport>udp4</transport><program>${EDGE_WATCH.programs.join(',')}</program>`));
  assert.equal(watchConfig(w, []).syslog, '', 'no box to send to, no destination');
});

test('the key is found again where a router keeps it, and anything else is no key', () => {
  const w = newWatch();
  assert.deepEqual(watchOf({ xenStoreData: { [EDGE_WATCH.key]: JSON.stringify(w) } }), w);
  for (const bad of [undefined, '', 'not json', JSON.stringify({ ...w, key: 'a|b' }), JSON.stringify({ ...w, pin: 'short' }), JSON.stringify({ ...w, v: 2 })]) {
    assert.equal(watchOf({ xenStoreData: { [EDGE_WATCH.key]: bad } }), null, String(bad).slice(0, 40));
  }
});
