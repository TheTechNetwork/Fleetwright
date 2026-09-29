// The apt Worker: signed metadata served as assets, packages streamed from the
// GitHub release they were built into and kept in Cloudflare's cache.
//
// What has to hold: the upstream is exactly the release asset the builder's
// Filename names, and nothing a crafted path says (or the Worker is an open
// proxy on a trusted domain); a package is fetched from GitHub once and then
// served from cache; a failure is never cached. The end-to-end version (apt
// installing and upgrading through the Worker, and refusing a tampered deb) was
// run by hand; see the PR.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { handle } from '../apt/src/index.js';

const DEB = 'https://github.com/TheTechNetwork/Fleetwright/releases/download/v0.3.0/fleetwright_0.3.0_amd64.deb';

/** A Cache API stand-in that keeps whole bodies, the way the edge does. */
function memoryCache() {
  const store = new Map();
  return {
    store,
    async match(/** @type {Request} */ k) {
      const hit = store.get(k.url);
      return hit ? new Response(hit.body, { status: 200, headers: hit.headers }) : undefined;
    },
    async put(/** @type {Request} */ k, /** @type {Response} */ r) {
      store.set(k.url, { body: await r.arrayBuffer(), headers: new Headers(r.headers) });
    },
  };
}

function world({ assets = {}, upstream = (/** @type {string} */ _u) => new Response('DEB-BYTES', { headers: { 'content-length': '9' } }) } = {}) {
  const fetched = [];
  const pending = [];
  const cache = memoryCache();
  const env = {
    GITHUB_REPOSITORY: 'TheTechNetwork/Fleetwright',
    CACHE: cache,
    FETCH: /** @type {any} */ (async (u) => { fetched.push(u); return upstream(u); }),
    ASSETS: {
      async fetch(/** @type {Request} */ req) {
        const p = new URL(req.url).pathname;
        return p in assets ? new Response(assets[p]) : new Response('not found', { status: 404 });
      },
    },
  };
  const ctx = { waitUntil: (/** @type {Promise<unknown>} */ p) => pending.push(p) };
  const get = async (path, init = {}) => {
    const r = await handle(new Request(`https://fleet-apt.thetech.network${path}`, init), env, ctx);
    return r;
  };
  const settle = () => Promise.all(pending.splice(0));
  return { get, fetched, cache, settle };
}

test('a package is fetched from exactly its release asset, once, then served from cache', async () => {
  const w = world();
  const first = await w.get('/pool/v0.3.0/fleetwright_0.3.0_amd64.deb');
  assert.equal(first.status, 200);
  assert.equal(await first.text(), 'DEB-BYTES');
  assert.equal(first.headers.get('content-type'), 'application/vnd.debian.binary-package');
  await w.settle();
  assert.deepEqual(w.fetched, [DEB]);

  const second = await w.get('/pool/v0.3.0/fleetwright_0.3.0_amd64.deb');
  assert.equal(await second.text(), 'DEB-BYTES');
  assert.equal(w.fetched.length, 1, 'the second download went to GitHub again');
});

test('HEAD and a Range request find the object a GET stored', async () => {
  const w = world();
  await (await w.get('/pool/v0.3.0/fleetwright_0.3.0_amd64.deb', { method: 'HEAD' })).arrayBuffer();
  await w.settle();
  const ranged = await w.get('/pool/v0.3.0/fleetwright_0.3.0_amd64.deb', { headers: { range: 'bytes=0-3' } });
  assert.equal(await ranged.text(), 'DEB-BYTES');
  assert.equal(w.fetched.length, 1);
  const head = await w.get('/pool/v0.3.0/fleetwright_0.3.0_amd64.deb', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
});

test('a failure upstream is said, and never cached', async () => {
  const gone = world({ upstream: () => new Response('nope', { status: 404 }) });
  assert.equal((await gone.get('/pool/v0.3.0/fleetwright_0.3.0_amd64.deb')).status, 404);
  const broken = world({ upstream: () => new Response('down', { status: 503 }) });
  assert.equal((await broken.get('/pool/v0.3.0/fleetwright_0.3.0_amd64.deb')).status, 502);
  await gone.settle();
  await broken.settle();
  assert.equal(gone.cache.store.size + broken.cache.store.size, 0);
});

test('nothing but our own package shape reaches GitHub', async () => {
  const w = world();
  for (const p of [
    '/pool/v0.3.0/evil_1.0_amd64.deb',
    '/pool/v0.3.0/fleetwright_0.3.0_i386.deb',
    '/pool/../x/fleetwright_0.3.0_amd64.deb',
    '/pool/v0.3.0%2F..%2F..%2Fx/fleetwright_0.3.0_amd64.deb',
    '/pool/v0.3.0/sub/fleetwright_0.3.0_amd64.deb',
    '/pool/.hidden/fleetwright_0.3.0_amd64.deb',
    '/pool//fleetwright_0.3.0_amd64.deb',
  ]) {
    assert.equal((await w.get(p)).status, 404, p);
  }
  assert.deepEqual(w.fetched, []);
  // And an rc's tag and version shape is ours too.
  assert.equal((await w.get('/pool/v0.3.0-rc1/fleetwright_0.3.0~rc1_arm64.deb')).status, 200);
});

test('metadata comes from the assets, and a missing file is a 404', async () => {
  const w = world({ assets: { '/dists/stable/InRelease': 'signed', '/fleetwright.gpg': 'key' } });
  assert.equal(await (await w.get('/dists/stable/InRelease')).text(), 'signed');
  assert.equal(await (await w.get('/fleetwright.gpg')).text(), 'key');
  assert.equal((await w.get('/dists/stable/nope')).status, 404);
});

test('the front page says how to install, with the signed line and join', async () => {
  const text = await (await world().get('/')).text();
  assert.match(text, /signed-by=\/usr\/share\/keyrings\/fleetwright\.gpg/);
  assert.match(text, /fleetwright join/);
  assert.doesNotMatch(text, /trusted=yes/);
});

test('read-only', async () => {
  const r = await world().get('/dists/stable/InRelease', { method: 'POST', body: 'x' });
  assert.equal(r.status, 405);
});

test('the Worker is configured for the domain and logs, and never ships packages', () => {
  const toml = readFileSync(new URL('../apt/wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /pattern = "fleet-apt\.thetech\.network", custom_domain = true/);
  assert.match(toml, /\[observability\]\nenabled = true/);
  // Without this, an existing asset is served before the Worker runs and no
  // apt update is ever logged.
  assert.match(toml, /run_worker_first = \["\/dists\/\*"\]/);
  assert.match(readFileSync(new URL('../apt/.gitignore', import.meta.url), 'utf8'), /^public\/$/m);
});
