// Put the build that was just uploaded in front of the internal testers.
//
// An upload is not a delivery. A build lands in App Store Connect, processes
// for anywhere between two minutes and half an hour, and then sits there until
// something adds it to a group. The alternative to this script is a checkbox
// in App Store Connect labelled "automatic distribution", which works — but it
// lives in a web UI nobody can review, and it silently stops applying if the
// group is renamed or recreated. This is the same behaviour, written down.
//
// Runs on ubuntu, deliberately: it is HTTP and a JWT, and there is no reason
// to hold a macOS runner open for it.
//
// Zero dependencies. ES256 via WebCrypto, which is why this is .mjs and not a
// shell script — signing an ES256 JWT in bash is a tar pit.

const KEY_ID = env('APPSTORE_KEY_ID');
const ISSUER_ID = env('APPSTORE_ISSUER_ID');
const PRIVATE_KEY = env('APPSTORE_PRIVATE_KEY');
const BUNDLE_ID = env('BUNDLE_ID');
const BUILD_NUMBER = env('BUILD_NUMBER');
// internal (default) or external. They are genuinely different deliveries, not
// two names for one: an internal group is App Store Connect users and needs no
// review, an external group is anybody and Apple reviews the first build.
const AUDIENCE = (process.env.AUDIENCE || 'internal').toLowerCase();
if (AUDIENCE !== 'internal' && AUDIENCE !== 'external') {
  throw new Error(`AUDIENCE must be internal or external, got ${JSON.stringify(AUDIENCE)}`);
}
const IS_INTERNAL = AUDIENCE === 'internal';
// Named per audience so external distribution never has to rename the other
// one — a rename is the change that leaves a variable unset somewhere, and
// unset here is not an error, it is a silent fallback to whichever group
// happens to be first.
const GROUP_NAME =
  (IS_INTERNAL ? process.env.INTERNAL_BETA_GROUP_NAME : process.env.EXTERNAL_BETA_GROUP_NAME) || '';

// Processing is the slow part and nothing here can hurry it. Twenty minutes is
// long enough for every build this project has produced and short enough that a
// stuck one is not billed for an hour.
const POLL_TIMEOUT_MS = 20 * 60_000;
const POLL_INTERVAL_MS = 30_000;

/** @param {string} name */
function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** A short-lived ES256 assertion, which is the only thing this API accepts. */
async function token() {
  const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  // 20 minutes: Apple rejects anything over 20, and a token that outlives the
  // job is a credential sitting in a log for no reason.
  const claim = { iss: ISSUER_ID, iat, exp: iat + 20 * 60, aud: 'appstoreconnect-v1' };

  const pkcs8 = PRIVATE_KEY.replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bytes = Uint8Array.from(atob(pkcs8), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(sig))}`;
}

/** @param {string|Uint8Array} input */
function b64url(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} path @param {RequestInit} [init] */
async function api(path, init = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 204) return null;
  const body = await res.text();
  if (!res.ok) {
    // Apple's errors carry the useful part in a nested array, and printing the
    // raw body is how you end up reading JSON in a log with no line breaks.
    let detail = body.slice(0, 400);
    try {
      const parsed = JSON.parse(body);
      detail = (parsed.errors || []).map((/** @type {any} */ e) => `${e.title}: ${e.detail}`).join('\n  ') || detail;
    } catch {}
    throw new Error(`${init.method || 'GET'} ${path} → ${res.status}\n  ${detail}`);
  }
  return JSON.parse(body);
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const apps = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`);
  const app = apps.data[0];
  if (!app) throw new Error(`no app record for ${BUNDLE_ID} — create it in App Store Connect first`);
  console.log(`app ${app.attributes.name} (${app.id})`);

  // Build "version" in this API means the build number, not the marketing
  // version. Naming it after the thing it is not has cost people whole
  // afternoons.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let build = null;
  for (;;) {
    const found = await api(`/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(BUILD_NUMBER)}&limit=1`);
    build = found.data[0];
    const state = build?.attributes?.processingState;
    if (state === 'VALID') break;
    if (state === 'FAILED' || state === 'INVALID') throw new Error(`build ${BUILD_NUMBER} is ${state}`);
    if (Date.now() > deadline) {
      throw new Error(build ? `build ${BUILD_NUMBER} still ${state} after 20 minutes` : `build ${BUILD_NUMBER} never appeared`);
    }
    console.log(build ? `build ${BUILD_NUMBER} is ${state}, waiting…` : `build ${BUILD_NUMBER} not visible yet, waiting…`);
    await sleep(POLL_INTERVAL_MS);
  }
  console.log(`build ${BUILD_NUMBER} is VALID (${build.id})`);

  const groups = await api(
    `/v1/apps/${app.id}/betaGroups?filter[isInternalGroup]=${IS_INTERNAL}&limit=200`,
  );
  const candidates = groups.data;
  const where = IS_INTERNAL ? 'TestFlight → Internal Testing' : 'TestFlight → External Testing';
  if (!candidates.length) throw new Error(`no ${AUDIENCE} beta group — create one in ${where}`);
  const group = GROUP_NAME
    ? candidates.find((/** @type {any} */ g) => g.attributes.name === GROUP_NAME)
    : candidates[0];
  if (!group) {
    throw new Error(
      `no ${AUDIENCE} group named ${JSON.stringify(GROUP_NAME)} — have: ` +
        candidates.map((/** @type {any} */ g) => g.attributes.name).join(', '),
    );
  }

  await api(`/v1/betaGroups/${group.id}/relationships/builds`, {
    method: 'POST',
    body: JSON.stringify({ data: [{ type: 'builds', id: build.id }] }),
  });
  console.log(`build ${BUILD_NUMBER} → "${group.attributes.name}"`);

  if (IS_INTERNAL) return;

  // External testers are the public, so Apple reviews the build before any of
  // them see it. Submitting is all this can do — review takes hours to a day,
  // and waiting for it would mean holding a runner open for a decision no
  // amount of polling influences. The build appears for testers when it
  // passes.
  //
  // Already-submitted is not a failure. A release re-run, or a build already
  // sent for review by hand, should be idempotent rather than red.
  try {
    await api('/v1/betaAppReviewSubmissions', {
      method: 'POST',
      body: JSON.stringify({
        data: { type: 'betaAppReviewSubmissions', relationships: { build: { data: { type: 'builds', id: build.id } } } },
      }),
    });
    console.log(`build ${BUILD_NUMBER} submitted for beta app review`);
  } catch (e) {
    if (/already|conflict|409|state/i.test(String(e.message))) {
      console.log(`beta app review not resubmitted: ${e.message.split('\n')[0]}`);
    } else {
      throw e;
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
