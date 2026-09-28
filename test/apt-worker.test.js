// The apt Worker: signed metadata served as assets, packages redirected to the
// GitHub release they were built into.
//
// The redirect is the part worth pinning down. It must go exactly where the
// repository builder's Filename says, and nowhere a crafted path says — a
// Worker on a trusted domain that redirected anywhere would be an open
// redirect. The end-to-end version of this (apt installing and upgrading
// through the redirect, and refusing a tampered deb behind it) was run by hand;
// see docs/packaging.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { handle } from '../apt/src/index.js';

const env = (assets = {}) => ({
  GITHUB_REPOSITORY: 'TheTechNetwork/Fleetwright',
  ASSETS: {
    async fetch(/** @type {Request} */ req) {
      const p = new URL(req.url).pathname;
      return p in assets ? new Response(assets[p]) : new Response('not found', { status: 404 });
    },
  },
});
const get = (path, e = env(), init = {}) => handle(new Request(`https://apt.thetech.network${path}`, init), e);

test('a package is redirected to the release asset with the same tag and name', async () => {
  const r = await get('/pool/v0.3.0/fleetwright_0.3.0_amd64.deb');
  assert.equal(r.status, 302);
  assert.equal(
    r.headers.get('location'),
    'https://github.com/TheTechNetwork/Fleetwright/releases/download/v0.3.0/fleetwright_0.3.0_amd64.deb',
  );
  const arm = await get('/pool/v0.3.0-rc1/fleetwright_0.3.0~rc1_arm64.deb');
  assert.equal(arm.status, 302);
});

test('nothing but our own package shape is redirected', async () => {
  for (const p of [
    '/pool/v0.3.0/evil_1.0_amd64.deb',
    '/pool/v0.3.0/fleetwright_0.3.0_i386.deb',
    '/pool/../x/fleetwright_0.3.0_amd64.deb',
    '/pool/v0.3.0%2F..%2F..%2Fx/fleetwright_0.3.0_amd64.deb',
    '/pool/v0.3.0/sub/fleetwright_0.3.0_amd64.deb',
    '/pool/.hidden/fleetwright_0.3.0_amd64.deb',
    '/pool//fleetwright_0.3.0_amd64.deb',
  ]) {
    const r = await get(p);
    assert.notEqual(r.status, 302, `${p} was redirected to ${r.headers.get('location')}`);
  }
});

test('metadata comes from the assets, and a missing file is a 404', async () => {
  const e = env({ '/dists/stable/InRelease': 'signed', '/fleetwright.gpg': 'key' });
  assert.equal(await (await get('/dists/stable/InRelease', e)).text(), 'signed');
  assert.equal(await (await get('/fleetwright.gpg', e)).text(), 'key');
  assert.equal((await get('/dists/stable/nope', e)).status, 404);
});

test('the front page says how to install, with the signed line and join', async () => {
  const text = await (await get('/')).text();
  assert.match(text, /signed-by=\/usr\/share\/keyrings\/fleetwright\.gpg/);
  assert.match(text, /fleetwright join/);
  assert.doesNotMatch(text, /trusted=yes/);
});

test('read-only', async () => {
  const r = await get('/dists/stable/InRelease', env(), { method: 'POST', body: 'x' });
  assert.equal(r.status, 405);
});

test('the Worker is configured for the domain and logs, and never ships packages', () => {
  const toml = readFileSync(new URL('../apt/wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /pattern = "apt\.thetech\.network", custom_domain = true/);
  assert.match(toml, /\[observability\]\nenabled = true/);
  assert.match(readFileSync(new URL('../apt/.gitignore', import.meta.url), 'utf8'), /^public\/$/m);
});
