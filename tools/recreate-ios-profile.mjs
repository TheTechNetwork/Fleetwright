/**
 * Delete and recreate the iOS App Store provisioning profile, bound to EVERY
 * currently-valid distribution certificate, and verify it comes back ACTIVE.
 *
 *   ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_P8=… \
 *   BUNDLE_ID=network.thetech.fleetwright PROFILE_NAME='Fleetwright Profile' \
 *   node tools/recreate-ios-profile.mjs
 *
 * ## Why this exists
 *
 * A provisioning profile is bound to specific distribution certificates at
 * creation and is IMMUTABLE afterwards — there is no "edit" in the App Store
 * Connect API, only create and delete. When a distribution certificate is
 * revoked (Apple caps them per team, so freeing a slot for another project
 * means revoking one), every profile that named the revoked certificate turns
 * INVALID, and there is no way to repair the profile in place.
 *
 * The fix is to delete the broken profile and create a fresh one bound to ALL
 * of the team's currently-valid distribution certificates, so the profile is
 * satisfied whichever surviving certificate CI actually signs with — and so a
 * future revocation of any single certificate leaves the others still covering
 * the profile.
 *
 * ## What it does
 *
 *   1. Resolve the bundle id resource (`BUNDLE_ID`).
 *   2. Collect every non-expired distribution certificate on the team
 *      (Apple Distribution + legacy iOS Distribution).
 *   3. Delete any existing profile named `PROFILE_NAME`.
 *   4. Create `PROFILE_NAME` for `PROFILE_TYPE` (default IOS_APP_STORE),
 *      related to the bundle id and to every certificate from step 2.
 *   5. Re-fetch the profile and assert `profileState === 'ACTIVE'`.
 *
 * It prints the new profile's id and the certificates it is bound to, and exits
 * non-zero if the profile does not come back ACTIVE — so a run that "succeeds"
 * has actually produced a signable profile, not just a 201.
 *
 * Zero dependencies: ES256 JWT via node:crypto, App Store Connect over fetch.
 */
import { createSign } from "node:crypto";

const {
  ASC_KEY_ID,
  ASC_ISSUER_ID,
  ASC_KEY_P8,
  BUNDLE_ID = "network.thetech.fleetwright",
  PROFILE_NAME = "Fleetwright Profile",
  // IOS_APP_STORE is the App Store / TestFlight distribution profile. Kept a
  // parameter so the same tool can mint an AD_HOC or a macOS profile without a
  // second copy, but the default is the only one this repo signs with.
  PROFILE_TYPE = "IOS_APP_STORE",
} = process.env;

// The distribution certificate types eligible to sign an iOS App Store build.
// DISTRIBUTION is the modern unified "Apple Distribution" (iOS + macOS);
// IOS_DISTRIBUTION is the legacy iOS-only kind. A team can hold both, and a
// profile may name any it wants to be signable by — so bind every valid one.
const DISTRIBUTION_CERT_TYPES = new Set(["DISTRIBUTION", "IOS_DISTRIBUTION"]);

const API = "https://api.appstoreconnect.apple.com";

function token() {
  const b64u = (b) => Buffer.from(b).toString("base64url");
  const header = b64u(JSON.stringify({ alg: "ES256", kid: ASC_KEY_ID, typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(
    JSON.stringify({ iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: "appstoreconnect-v1" }),
  );
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  // `ieee-p1363` is the raw r||s form JWS requires. node's default DER encoding
  // is accepted by nothing and surfaces as a bare 401.
  const sig = signer.sign({ key: ASC_KEY_P8, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

async function asc(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token()}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  // 204 (DELETE) has no body; everything else we read as JSON.
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

// Walk Apple's pagination so a team with more than one page of certs or
// profiles is handled rather than silently truncated.
async function ascAll(path) {
  const out = [];
  let next = `${API}${path}`;
  while (next) {
    const res = await fetch(next, { headers: { authorization: `Bearer ${token()}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${next} -> ${res.status} ${text}`);
    const page = JSON.parse(text);
    out.push(...(page.data ?? []));
    next = page.links?.next ?? null;
  }
  return out;
}

function requireEnv() {
  const missing = ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_KEY_P8"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`missing required env: ${missing.join(", ")}`);
}

async function main() {
  requireEnv();

  // 1. The bundle id resource.
  const bundleIds = await ascAll(
    `/v1/bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}&limit=200`,
  );
  const bundle = bundleIds.find((b) => b.attributes?.identifier === BUNDLE_ID);
  if (!bundle) {
    throw new Error(
      `no registered bundle id '${BUNDLE_ID}'. Register the App ID in the developer portal first.`,
    );
  }
  console.log(`bundle id: ${BUNDLE_ID} (${bundle.id})`);

  // 2. Every non-expired distribution certificate.
  const now = Date.now();
  const certs = (await ascAll(`/v1/certificates?limit=200`)).filter((c) => {
    const type = c.attributes?.certificateType;
    if (!DISTRIBUTION_CERT_TYPES.has(type)) return false;
    const exp = Date.parse(c.attributes?.expirationDate ?? "");
    // Revoked certs drop out of the API; this guards the expiry case, which the
    // API still lists.
    return !Number.isFinite(exp) || exp > now;
  });
  if (certs.length === 0) {
    throw new Error(
      "no valid distribution certificate on the team — cannot bind a profile to nothing. " +
        "Create/import a distribution certificate first (do NOT let this mint one).",
    );
  }
  for (const c of certs) {
    console.log(
      `  cert ${c.id} ${c.attributes?.certificateType} ` +
        `'${c.attributes?.name ?? ""}' expires ${c.attributes?.expirationDate ?? "?"}`,
    );
  }

  // 3. Delete any existing profile of this name. Profiles are immutable, so the
  // only way to rebind one is to remove it and recreate.
  const existing = (await ascAll(`/v1/profiles?limit=200`)).filter(
    (p) => p.attributes?.name === PROFILE_NAME,
  );
  for (const p of existing) {
    console.log(`deleting existing profile '${PROFILE_NAME}' (${p.id}, was ${p.attributes?.profileState})`);
    await asc(`/v1/profiles/${p.id}`, { method: "DELETE" });
  }

  // 4. Create the profile bound to the bundle id and EVERY valid cert.
  const created = await asc(`/v1/profiles`, {
    method: "POST",
    body: JSON.stringify({
      data: {
        type: "profiles",
        attributes: { name: PROFILE_NAME, profileType: PROFILE_TYPE },
        relationships: {
          bundleId: { data: { type: "bundleIds", id: bundle.id } },
          certificates: { data: certs.map((c) => ({ type: "certificates", id: c.id })) },
        },
      },
    }),
  });
  const id = created.data?.id;
  const createdState = created.data?.attributes?.profileState;
  console.log(`created profile '${PROFILE_NAME}' (${id}) state=${createdState}`);

  // 5. Verify it is ACTIVE by re-reading it — the create response is not proof
  // the profile is signable; the state is.
  const check = await asc(`/v1/profiles/${id}`);
  const state = check.data?.attributes?.profileState;
  if (state !== "ACTIVE") {
    throw new Error(`profile '${PROFILE_NAME}' came back state=${state}, expected ACTIVE`);
  }
  console.log(`::notice::'${PROFILE_NAME}' is ACTIVE, bound to ${certs.length} distribution cert(s).`);
}

main().catch((e) => {
  process.stderr.write(`recreate-ios-profile: ${e.message}\n`);
  process.exit(1);
});
