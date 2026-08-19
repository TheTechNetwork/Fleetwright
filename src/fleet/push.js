// Push notifications: waking a phone when a session needs a person.
//
// design.md §3 lists three meanings of "wake", and this is the third — the one
// that makes the app worth having, because the other two are things you already
// know you want. A session that has hit a prompt at 3am is not something anyone
// is watching for.
//
// PORTABLE ON PURPOSE. Nothing here imports from `node:`; it uses `fetch`,
// `crypto.subtle` and `atob`/`btoa`, all of which exist in both Node 18+ and
// Cloudflare Workers. The coordinator runs in both, so a sender that only works
// in one is a sender that only works half the time.
//
// FCM covers Android directly and iOS through its APNs bridge, which is why it
// is the one implemented first: one integration, both platforms, and no Apple
// signing key needed before the Android app can be tested. A direct APNs sender
// slots in beside it as another object with the same `send` shape — see
// docs/push.md.

/**
 * @typedef {object} PushMessage
 * @property {string} title
 * @property {string} body
 * @property {Record<string, string>} [data]
 */

/**
 * @typedef {object} Pusher
 * @property {(devices: Array<{token: string, platform: string}>, message: PushMessage) => Promise<{sent: number, dead: string[]}>} send
 */

/**
 * A sender that only writes to the log.
 *
 * The default, and not a placeholder: a fleet with no push credentials
 * configured should still run, still record events, and still say what it
 * WOULD have sent. Silently doing nothing is how you discover on the day it
 * matters that push was never wired up.
 *
 * @param {{ info: Function }} logger
 * @returns {Pusher}
 */
export function logPusher(logger) {
  return {
    async send(devices, message) {
      logger.info(`push (not configured, would send to ${devices.length}): ${message.title} — ${message.body}`);
      return { sent: 0, dead: [] };
    },
  };
}

/**
 * Firebase Cloud Messaging, HTTP v1.
 *
 * Wants a service-account JSON — the one Firebase gives you under Project
 * settings → Service accounts. `client_email`, `private_key` and `project_id`
 * are the only fields used.
 *
 * @param {{ client_email: string, private_key: string, project_id: string }} serviceAccount
 * @param {{ logger?: { info: Function, warn: Function }, fetchImpl?: typeof fetch, now?: () => number }} [opts]
 * @returns {Pusher}
 */
export function fcmPusher(serviceAccount, { logger, fetchImpl, now = () => Date.now() } = {}) {
  const log = logger || { info() {}, warn() {} };
  const doFetch = fetchImpl || globalThis.fetch;
  /** @type {{ token: string, expires: number }|null} */
  let cached = null;

  async function accessToken() {
    // Reused until it is nearly expired: an OAuth round trip per notification
    // would double the latency of the thing whose entire point is being fast.
    if (cached && cached.expires > now() + 60_000) return cached.token;

    const iat = Math.floor(now() / 1000);
    const claim = {
      iss: serviceAccount.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat,
      exp: iat + 3600,
    };
    const jwt = await signJwtRS256(claim, serviceAccount.private_key);

    const res = await doFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    if (!res.ok) throw new Error(`FCM token exchange failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = /** @type {any} */ (await res.json());
    cached = { token: body.access_token, expires: now() + (body.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return {
    async send(devices, message) {
      if (!devices.length) return { sent: 0, dead: [] };
      const token = await accessToken();
      const url = `https://fcm.googleapis.com/v1/projects/${serviceAccount.project_id}/messages:send`;

      let sent = 0;
      /** @type {string[]} */
      const dead = [];

      // One request per device: FCM v1 has no multicast in the REST API, and a
      // fleet has tens of devices, not thousands.
      for (const device of devices) {
        const payload = {
          message: {
            token: device.token,
            notification: { title: message.title, body: message.body },
            // Data rides alongside so the app can deep-link to the session
            // rather than just opening.
            data: message.data || {},
            android: { priority: 'HIGH' },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        };
        const res = await doFetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          sent++;
          continue;
        }
        const text = (await res.text()).slice(0, 300);
        // UNREGISTERED means the app was uninstalled or the token was replaced:
        // broken forever, so it is reported back for removal rather than
        // retried on every event.
        if (res.status === 404 || /UNREGISTERED/i.test(text)) {
          dead.push(device.token);
          log.warn(`push: dropping dead token (${res.status})`);
        } else if (/INVALID_ARGUMENT/i.test(text)) {
          // NOT dead — misconfigured, and the distinction matters more than it
          // looks. FCM says INVALID_ARGUMENT for a token that is not an FCM
          // registration token at all, which is exactly what an iOS app that
          // registered with APNs directly posts. Treating that as dead deleted
          // the registration, so the phone silently unregistered ITSELF and
          // the only trace was one line saying a dead token had been dropped.
          // The next send had nobody to send to, and nothing anywhere said
          // why.
          log.warn(
            `push: FCM rejected the ${device.platform} token as INVALID_ARGUMENT — keeping the registration.\n` +
              '  This is what an APNs device token looks like to FCM. An iOS app has to post the token from\n' +
              '  the Firebase SDK (Messaging.messaging().token), not the raw APNs one — see docs/push.md.',
          );
        } else {
          log.warn(`push: FCM ${res.status} ${text}`);
        }
      }
      return { sent, dead };
    },
  };
}

/**
 * Build whichever sender the environment is configured for.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ info: Function, warn: Function }} logger
 * @returns {Pusher}
 */
export function pusherFromEnv(env, logger) {
  const raw = env.AGENT_FLEET_FCM_SERVICE_ACCOUNT;
  if (!raw) return logPusher(logger);
  const parsed = parseServiceAccount(raw);
  if (!parsed) {
    logger.warn(
      'push: AGENT_FLEET_FCM_SERVICE_ACCOUNT is neither JSON nor base64-encoded JSON — falling back to logging.\n' +
        '  base64 -w0 service-account.json',
    );
    return logPusher(logger);
  }
  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    logger.warn('push: FCM service account is missing client_email, private_key or project_id — falling back to logging');
    return logPusher(logger);
  }
  logger.info(`push: FCM configured for project ${parsed.project_id}`);
  return fcmPusher(parsed, { logger });
}

/**
 * A service account from an environment variable, in either of the two forms
 * it survives being one.
 *
 * BASE64 IS THE FORM THAT ALWAYS WORKS, and the reason is systemd. The
 * coordinator on a box reads its configuration through `EnvironmentFile=`,
 * which has no multi-line values — and a service-account JSON as Google hands
 * it to you is pretty-printed across a dozen lines. Flattening it to one line
 * is not enough either: systemd expands C escapes inside double-quoted values,
 * so the `\n` sequences in `private_key` become REAL newlines, and a raw
 * newline inside a JSON string is a parse error. The failure then looks like
 * push quietly not working rather than like a malformed secret.
 *
 * Raw JSON is still accepted, because it works everywhere that is not an env
 * file — `wrangler secret put` takes it on stdin, and a secret already set that
 * way should not have to be re-entered to pick up this change.
 *
 * @param {string} raw
 * @returns {any|null}
 */
export function parseServiceAccount(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // JSON first: it is unambiguous, and base64 of a JSON document never starts
  // with a brace.
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  try {
    // Whitespace is stripped because a base64 blob that has been through a
    // YAML block or an editor's line wrapping is still perfectly good base64.
    const binary = atob(trimmed.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// --- JWT --------------------------------------------------------------------

/**
 * Sign a service-account JWT with RS256, using WebCrypto so it works unchanged
 * in Workers.
 *
 * @param {Record<string, unknown>} claim
 * @param {string} pem PKCS#8, as it appears in the service-account JSON
 */
export async function signJwtRS256(claim, pem) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encoder = new TextEncoder();
  const unsigned = `${b64url(encoder.encode(JSON.stringify(header)))}.${b64url(encoder.encode(JSON.stringify(claim)))}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToBytes(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(signature))}`;
}

/**
 * A PEM private key as bytes. The `\n` in a service-account JSON is often a
 * literal backslash-n by the time it has been through an environment variable,
 * which produces an import error that says nothing useful — so both forms are
 * accepted.
 * @param {string} pem
 */
export function pemToBytes(pem) {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** @param {Uint8Array} bytes */
function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
