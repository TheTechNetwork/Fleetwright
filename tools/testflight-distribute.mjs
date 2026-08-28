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
// Optional. 4000 characters is Apple's limit and it is truncated rather than
// rejected, because a release note being long is not a reason to fail a
// delivery.
const WHATS_NEW = whatsNew(process.env.WHATS_NEW || '');

/**
 * What testers read, in the character set App Store Connect will take.
 *
 * Apple rejects emoji outright — "Text for whatsNew contains invalid
 * characters: '[🤖]'" — and the text here is a commit message, which on a
 * squash merge is the whole pull request body, footer and all. So the first
 * automated release note this project produced was refused for containing the
 * robot from its own sign-off.
 *
 * For an INTERNAL build only the first line is kept. That build ships on every
 * commit, so the subject line is the change; the body is a pull request
 * description written for reviewers, and handing a tester four paragraphs of
 * rationale is not release notes.
 *
 * @param {string} raw
 */
function whatsNew(raw) {
  const audience = (process.env.AUDIENCE || 'internal').toLowerCase();
  const text = audience === 'internal' ? raw.split('\n')[0] : raw;
  return text
    // Emoji and the pieces that join them. \p{Extended_Pictographic} covers the
    // pictographs; the variation selector and zero-width joiner are what turn
    // several of them into one, and leaving those behind is its own kind of
    // invalid.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]/gu, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// Processing is the slow part and nothing here can hurry it. The first upload
// of a new app took longer than twenty minutes, which is ordinary — Apple's
// queue is not a function of anything on this side.
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 45 * 60_000);
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
      // NOT A FAILURE. The upload is the delivery this pipeline is responsible
      // for and it already succeeded; how long Apple's queue takes is not
      // something the run can influence or should be judged on. Failing here
      // puts a red cross on a green outcome, and a build that goes red when it
      // worked is how people learn to ignore red.
      const waited = Math.round(POLL_TIMEOUT_MS / 60_000);
      console.log(
        `\n::warning::Build ${BUILD_NUMBER} uploaded but was still ${state || 'not visible'} after ${waited} minutes.\n` +
          'Nothing is wrong with it — App Store Connect processing has no deadline, and it is\n' +
          'especially slow for the first build of a new app. It will appear in TestFlight on its\n' +
          'own. To put it in front of testers once it does, either turn on automatic distribution\n' +
          `for the group, or re-run this job.`,
      );
      process.exit(0);
    }
    console.log(build ? `build ${BUILD_NUMBER} is ${state}, waiting…` : `build ${BUILD_NUMBER} not visible yet, waiting…`);
    await sleep(POLL_INTERVAL_MS);
  }
  console.log(`build ${BUILD_NUMBER} is VALID (${build.id})`);

  // Fetched whole and filtered here, rather than asking the API to filter.
  //
  // filter[isInternalGroup] is valid on /v1/betaGroups and NOT on this
  // relationship endpoint, which answers 400 "A given parameter is not allowed
  // for this request" — after the twenty minutes spent waiting for the build to
  // process, which is the worst possible moment to discover a query-string
  // mistake. isInternalGroup is an attribute on every group either way, so
  // reading it here depends on nothing Apple has to agree with.
  const groups = await api(`/v1/apps/${app.id}/betaGroups?limit=200`);
  const candidates = groups.data.filter(
    (/** @type {any} */ g) => Boolean(g.attributes?.isInternalGroup) === IS_INTERNAL,
  );
  const where = IS_INTERNAL ? 'TestFlight → Internal Testing' : 'TestFlight → External Testing';
  if (!candidates.length) {
    const other = groups.data.map((/** @type {any} */ g) => g.attributes?.name).filter(Boolean);
    throw new Error(
      `no ${AUDIENCE} beta group — create one in ${where}` +
        (other.length ? `\n  groups this app does have: ${other.join(', ')}` : '\n  this app has no beta groups at all'),
    );
  }
  const group = GROUP_NAME
    ? candidates.find((/** @type {any} */ g) => g.attributes.name === GROUP_NAME)
    : candidates[0];
  if (!group) {
    throw new Error(
      `no ${AUDIENCE} group named ${JSON.stringify(GROUP_NAME)} — have: ` +
        candidates.map((/** @type {any} */ g) => g.attributes.name).join(', '),
    );
  }

  // "What to Test" — per build, and therefore the one field that would
  // otherwise be typed by hand on every release. Testers see it in TestFlight
  // and reviewers read it during beta review, so leaving it empty is a small
  // ongoing rudeness rather than a failure.
  if (WHATS_NEW) {
    const existing = await api(`/v1/builds/${build.id}/betaBuildLocalizations?limit=200`);
    const en = existing.data.find((/** @type {any} */ l) => l.attributes.locale === 'en-US');
    const body = { whatsNew: WHATS_NEW.slice(0, 4000) };
    if (en) {
      await api(`/v1/betaBuildLocalizations/${en.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ data: { type: 'betaBuildLocalizations', id: en.id, attributes: body } }),
      });
    } else {
      await api('/v1/betaBuildLocalizations', {
        method: 'POST',
        body: JSON.stringify({
          data: {
            type: 'betaBuildLocalizations',
            attributes: { ...body, locale: 'en-US' },
            relationships: { build: { data: { type: 'builds', id: build.id } } },
          },
        }),
      });
    }
    console.log(`what to test: ${WHATS_NEW.split('\n')[0].slice(0, 72)}`);
  }

  // AN INTERNAL GROUP IS NOT ASSIGNED A BUILD. It receives every build the
  // moment processing finishes, and the API says so by refusing:
  //
  //   POST /v1/betaGroups/<id>/relationships/builds → 422
  //     Builds cannot be assigned to this internal group.:
  //     Cannot add internal group to a build.
  //
  // Which is a confusing sentence for a correct rule. It read as a permissions
  // problem and was in fact "you are describing work that has already
  // happened" — the build was VALID and in front of the internal testers
  // before this call was made, and the job went red anyway.
  //
  // The group lookup above stays, because it is still worth failing loudly
  // when the group named in the workflow does not exist. What goes is the
  // assignment.
  if (IS_INTERNAL) {
    console.log(`build ${BUILD_NUMBER} is available to "${group.attributes.name}" — internal groups receive every build automatically`);
    return;
  }

  // External is the opposite: nothing reaches anybody until the build is
  // explicitly given to the group AND Apple has reviewed it.
  await api(`/v1/betaGroups/${group.id}/relationships/builds`, {
    method: 'POST',
    body: JSON.stringify({ data: [{ type: 'builds', id: build.id }] }),
  });
  console.log(`build ${BUILD_NUMBER} → "${group.attributes.name}"`);

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
