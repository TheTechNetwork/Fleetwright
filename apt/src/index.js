// The apt repository's one piece of logic: a package request becomes a redirect
// to the GitHub release asset it was built into.
//
// Everything else — dists/, the key — is a static asset and never reaches this
// code unless it is missing. See ../wrangler.toml for why the packages are not
// stored here.
//
// THE REDIRECT IS NOT OPEN. The path is matched against the exact shape the
// repository builder writes — pool/<tag>/fleetwright_<version>_<arch>.deb — and
// anything else is a 404. A Worker on a trusted domain that redirected wherever
// its path said would be a gift to anybody writing phishing links.

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
 * @param {Request} request
 * @param {{ ASSETS: { fetch: (r: Request) => Promise<Response> }, GITHUB_REPOSITORY: string }} env
 * @returns {Promise<Response>}
 */
export async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('read-only\n', { status: 405, headers: { allow: 'GET, HEAD' } });
  }

  const pool = POOL.exec(url.pathname);
  if (pool) {
    const [, tag, file] = pool;
    const to = `https://github.com/${env.GITHUB_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${file}`;
    // One structured line per download: which release, which architecture,
    // and who is asking — the whole reason this is not a static site.
    console.log(JSON.stringify({ event: 'download', tag, file, ua: request.headers.get('user-agent') || '' }));
    return new Response(null, { status: 302, headers: { location: to, 'cache-control': 'public, max-age=300' } });
  }

  if (url.pathname === '/' || url.pathname === '') {
    return new Response(FRONT, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 404) {
    console.log(JSON.stringify({ event: 'miss', path: url.pathname }));
  } else if (url.pathname.endsWith('/InRelease')) {
    // An apt update, as near as a static site can tell: every one fetches this.
    console.log(JSON.stringify({ event: 'update', ua: request.headers.get('user-agent') || '' }));
  }
  return asset;
}

export default { fetch: handle };
