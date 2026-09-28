// The apt repository's one piece of logic: a package is served from Cloudflare's
// cache, and fetched once from the GitHub release it was built into when the
// cache does not have it.
//
// Everything else — dists/, the key — is a static asset and never reaches this
// code unless it is missing. Static assets cap a file at 25 MiB and a deb is
// ~29 MB, which is why packages are streamed through here instead: a response
// the Worker streams has no such cap, and caching it is what keeps a fleet of
// boxes updating at once from being a fleet of downloads from GitHub.
//
// CACHED FOR GOOD, AND THAT IS SAFE. A tag's deb is reproducible — the release
// pipeline builds it twice and compares — so the bytes behind a pool path never
// change. And apt checks every deb against the sha256 in the signed Packages
// file, so even a stale or wrong cached object is refused rather than
// installed: the cache carries no trust, only bandwidth. The Cache API is per
// data centre, so each location asks GitHub once.
//
// Failures are never cached. A 404 from GitHub stays a 404 (a release that was
// deleted, a Packages file that outlived it); anything else is a 502, and the
// next request tries again.
//
// ONLY OUR OWN PACKAGES. The path is matched against the exact shape the
// repository builder writes — pool/<tag>/fleetwright_<version>_<arch>.deb — and
// anything else is a 404. A Worker on a trusted domain that fetched wherever
// its path said would be an open proxy.

const POOL = /^\/pool\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/(fleetwright_[0-9][A-Za-z0-9.+~]*_(?:amd64|arm64)\.deb)$/;

const FRONT = `Fleetwright apt repository — stable releases whose rollout is complete.

  curl -fsSL https://apt.thetech.network/fleetwright.gpg \\
    | sudo tee /usr/share/keyrings/fleetwright.gpg > /dev/null
  echo "deb [signed-by=/usr/share/keyrings/fleetwright.gpg] https://apt.thetech.network stable main" \\
    | sudo tee /etc/apt/sources.list.d/fleetwright.list
  sudo apt update && sudo apt install fleetwright
  sudo fleetwright join fleet.example.com
`;

/**
 * @typedef {object} Env
 * @property {{ fetch: (r: Request) => Promise<Response> }} ASSETS
 * @property {string} GITHUB_REPOSITORY
 * @property {{ match: (k: Request) => Promise<Response|undefined>, put: (k: Request, r: Response) => Promise<void> }} [CACHE]
 *   stands in for caches.default in a test; unset in production
 * @property {typeof fetch} [FETCH]  stands in for fetch in a test
 */

/**
 * @param {Request} request
 * @param {Env} env
 * @param {{ waitUntil: (p: Promise<unknown>) => void }} [ctx]
 * @returns {Promise<Response>}
 */
export async function handle(request, env, ctx = { waitUntil: () => {} }) {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('read-only\n', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const pool = POOL.exec(url.pathname);
  if (pool) return pkg(request, env, ctx, pool[1], pool[2]);

  if (url.pathname === '/' || url.pathname === '') {
    return new Response(FRONT, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) {
    console.log(JSON.stringify({ event: 'miss', path: url.pathname }));
  } else if (url.pathname.endsWith('/InRelease')) {
    // An apt update, as near as the Worker can tell: every one fetches this.
    console.log(JSON.stringify({ event: 'update', ua: request.headers.get('user-agent') || '' }));
  }
  return asset;
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {{ waitUntil: (p: Promise<unknown>) => void }} ctx
 * @param {string} tag
 * @param {string} file
 */
async function pkg(request, env, ctx, tag, file) {
  const url = new URL(request.url);
  // Keyed on OUR path, always as a GET and with no headers: a Range or HEAD
  // request must find the same object a full GET stored.
  const key = new Request(`${url.origin}${url.pathname}`, { method: 'GET' });
  const cache = env.CACHE ?? /** @type {any} */ (globalThis).caches.default;
  const ua = request.headers.get('user-agent') || '';
  const head = request.method === 'HEAD';

  const hit = await cache.match(key);
  if (hit) {
    console.log(JSON.stringify({ event: 'download', tag, file, cache: 'hit', ua }));
    return head ? new Response(null, { status: hit.status, headers: hit.headers }) : hit;
  }

  // GitHub answers a release download with a redirect to its object store;
  // followed here, so the client only ever talks to this domain.
  const from = `https://github.com/${env.GITHUB_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${file}`;
  const upstream = await (env.FETCH ?? fetch)(from, { redirect: 'follow' });
  if (!upstream.ok || !upstream.body) {
    console.log(JSON.stringify({ event: 'upstream', tag, file, status: upstream.status }));
    const status = upstream.status === 404 ? 404 : 502;
    return new Response(`the release asset answered ${upstream.status}\n`, { status });
  }

  const headers = new Headers({
    'content-type': 'application/vnd.debian.binary-package',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  const length = upstream.headers.get('content-length');
  if (length) headers.set('content-length', length);
  const res = new Response(upstream.body, { status: 200, headers });
  console.log(JSON.stringify({ event: 'download', tag, file, cache: 'miss', ua }));
  // A HEAD has no body to send, so the whole stream goes to the cache.
  if (head) {
    ctx.waitUntil(cache.put(key, res));
    return new Response(null, { status: 200, headers });
  }
  // Stored while it is being sent, not before: the first box does not wait for
  // the cache write. The cache's copy reads from GitHub on its own branch of
  // the stream, so a client that goes away does not cut it short; if GitHub's
  // stream fails, the put fails and nothing is stored.
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default { fetch: handle };
