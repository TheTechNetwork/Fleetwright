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

import { sealTo } from './push-crypto.js';

/**
 * @typedef {object} Pusher
 * @property {(devices: Array<{token: string, platform: string, pushKey?: string}>, message: PushMessage) => Promise<{sent: number, dead: string[]}>} send
 */

/**
 * What actually goes on the wire for one device.
 *
 * THE FALLBACK IS THE INTERESTING HALF. A device that registered a public key
 * gets an envelope and a deliberately empty-of-detail alert; one that did not —
 * an app installed before encryption existed, and there are some — gets the
 * plain title and body exactly as before. Refusing to send to it would be
 * choosing "no notification" over "a notification Apple can read", which is the
 * wrong trade for somebody waiting on a session.
 *
 * THE FALLBACK TEXT IS SHOWN WHEN DECRYPTION FAILS, so it has to be a sentence
 * rather than a placeholder. An extension that times out, a phone restored from
 * a backup with a key it no longer has, a version skew — all of them end here,
 * and "New notification" in that moment is the contentless wake this design
 * rejected. It says what is true without saying what about: something in the
 * fleet needs a person, open the app.
 *
 * @param {{ pushKey?: string }} device
 * @param {{ title: string, body: string, data?: Record<string, string> }} message
 * @returns {Promise<{ encrypted: boolean, title: string, body: string, data: Record<string, string> }>}
 */
export async function envelopeFor(device, message) {
  const data = { ...(message.data || {}) };
  if (!device.pushKey) return { encrypted: false, title: message.title, body: message.body, data };
  const sealed = await sealTo(device.pushKey, { title: message.title, body: message.body, data });
  return {
    encrypted: true,
    title: 'Fleetwright',
    body: 'Something needs you. Open to see.',
    // `e`, short, because both services cap a payload at 4 KB and every byte of
    // key name is a byte of ciphertext that does not fit.
    data: { e: sealed },
  };
}

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
        const wire = await envelopeFor(device, message);
        // DATA-ONLY WHEN ENCRYPTED, and this is not a detail. A `notification`
        // block is rendered by the system before the app is consulted, so an
        // encrypted body would be displayed as base64. A data message is
        // handed to onMessageReceived, which decrypts and posts the real
        // notification itself.
        //
        // The cost is honest: a data message needs the app to run, so it is
        // not delivered to a force-stopped app and Doze can delay it. HIGH
        // priority is what buys a wake in Doze, and it is set either way.
        const payload = {
          message: {
            token: device.token,
            ...(wire.encrypted ? {} : { notification: { title: wire.title, body: wire.body } }),
            // Data rides alongside so the app can deep-link to the session
            // rather than just opening. When encrypted it carries the whole
            // notification instead.
            data: wire.data,
            android: { priority: 'HIGH' },
            apns: {
              // The alert is STILL SENT on the APNs side of the bridge, because
              // iOS needs something to show if the extension fails — and
              // mutable-content is what runs the extension at all.
              payload: wire.encrypted
                ? { aps: { alert: { title: wire.title, body: wire.body }, sound: 'default', 'mutable-content': 1 } }
                : { aps: { sound: 'default' } },
            },
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
 * Apple Push Notification service, directly.
 *
 * The iOS app registers with APNs and posts the raw device token, which is not
 * an FCM registration token and never becomes one. Until this existed the only
 * sender was FCM, so every iOS device was registered against a service that
 * could not deliver to it — and the failure was silent, which is the worst
 * property a notification system can have.
 *
 * The other route was the Firebase SDK in the app, posting an FCM token
 * instead. That is Google's recommendation and it is a reasonable choice; it
 * also means a dependency in an app that has none, a plist checked in or
 * fetched at build time, and a second vendor between a session needing a
 * person and the person. This is fewer moving parts and no app change at all:
 * the hex encoding in Fleet.swift was already correct for exactly this.
 *
 * PORTABLE, like everything else here. The transport is injected because APNs
 * requires HTTP/2: a Worker's fetch negotiates it, Node's does not, and
 * node:http2 covers Node without adding a dependency — see apns-node.js.
 *
 * @param {{ keyId: string, teamId: string, bundleId: string, privateKey: string, production?: boolean }} config
 * @param {{ deliver?: Deliver, logger?: { info: Function, warn: Function }, now?: () => number }} [opts]
 * @returns {Pusher}
 */
export function apnsPusher(config, { deliver, logger, now = () => Date.now() } = {}) {
  const log = logger || { info() {}, warn() {} };
  const host = config.production === false ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const send = deliver || fetchDeliver(host);

  /** @type {{ token: string, made: number }|null} */
  let cached = null;

  async function bearer() {
    // Apple rejects a token older than an hour and rate-limits regenerating
    // one more often than every 20 minutes. 30 is comfortably inside both.
    if (cached && now() - cached.made < 30 * 60_000) return cached.token;
    const iat = Math.floor(now() / 1000);
    const token = await signJwtES256({ iss: config.teamId, iat }, config.privateKey, config.keyId);
    cached = { token, made: now() };
    return token;
  }

  return {
    async send(devices, message) {
      if (!devices.length) return { sent: 0, dead: [] };
      const authorization = `bearer ${await bearer()}`;
      let sent = 0;
      /** @type {string[]} */
      const dead = [];

      for (const device of devices) {
        const wire = await envelopeFor(device, message);
        // `mutable-content: 1` IS WHAT RUNS THE EXTENSION. Without it iOS
        // renders the alert below and the ciphertext is never opened — the
        // person sees the fallback line and nothing else, forever, with
        // delivery reporting success. Set only when there is something to
        // decrypt, so an unencrypted notification does not pay for an
        // extension launch that has no work to do.
        const payload = JSON.stringify({
          aps: {
            alert: { title: wire.title, body: wire.body },
            sound: 'default',
            ...(wire.encrypted ? { 'mutable-content': 1 } : {}),
          },
          ...wire.data,
        });
        const res = await send(device.token, payload, {
          authorization,
          'apns-topic': config.bundleId,
          'apns-push-type': 'alert',
          // 10 is "deliver now". The whole point is a session waiting on a
          // person, so there is nothing to gain by letting Apple batch it.
          'apns-priority': '10',
        });

        if (res.status === 200) {
          sent++;
          continue;
        }
        // 410 is Apple saying the app is gone. 400 BadDeviceToken means the
        // token was never valid for this environment — most often a sandbox
        // token sent to production, which is worth saying out loud because the
        // fix is a build setting rather than anything at runtime.
        if (res.status === 410 || /BadDeviceToken|Unregistered/i.test(res.body)) {
          dead.push(device.token);
          log.warn(`push: dropping dead APNs token (${res.status} ${res.body.slice(0, 80)})`);
        } else {
          log.warn(`push: APNs ${res.status} ${res.body.slice(0, 200)}`);
        }
      }
      return { sent, dead };
    },
  };
}

/**
 * @typedef {(token: string, payload: string, headers: Record<string, string>)
 *   => Promise<{ status: number, body: string }>} Deliver
 */

/** The default transport: fetch, which is HTTP/2 on Workers. @param {string} host */
function fetchDeliver(host) {
  return async (/** @type {string} */ token, /** @type {string} */ payload, /** @type {Record<string,string>} */ headers) => {
    const res = await fetch(`https://${host}/3/device/${token}`, { method: 'POST', headers, body: payload });
    return { status: res.status, body: await res.text() };
  };
}

/**
 * Sign an APNs JWT with ES256.
 *
 * WebCrypto returns the signature as raw r||s, which is exactly what a JWS
 * wants — the DER wrapping that trips people up here belongs to other APIs.
 *
 * @param {Record<string, unknown>} claim
 * @param {string} pem PKCS#8, the contents of the .p8
 * @param {string} keyId
 */
export async function signJwtES256(claim, pem, keyId) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const encoder = new TextEncoder();
  const unsigned = `${b64url(encoder.encode(JSON.stringify(header)))}.${b64url(encoder.encode(JSON.stringify(claim)))}`;

  const key = await crypto.subtle.importKey('pkcs8', pemToBytes(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned));
  return `${unsigned}.${b64url(new Uint8Array(signature))}`;
}

/**
 * Send each device to the service that can actually reach it.
 *
 * A fleet has both kinds of phone and they are not interchangeable: an APNs
 * token means nothing to FCM and an FCM token means nothing to APNs. Routing
 * by platform is the only thing that makes "the push sender" a single idea.
 *
 * @param {{ ios?: Pusher, other?: Pusher }} senders
 * @returns {Pusher}
 */
export function routingPusher({ ios, other }) {
  return {
    async send(devices, message) {
      const groups = [
        { pusher: ios, devices: devices.filter((d) => d.platform === 'ios') },
        { pusher: other, devices: devices.filter((d) => d.platform !== 'ios') },
      ];
      let sent = 0;
      /** @type {string[]} */
      const dead = [];
      for (const group of groups) {
        if (!group.pusher || !group.devices.length) continue;
        const r = await group.pusher.send(group.devices, message);
        sent += r.sent;
        dead.push(...r.dead);
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
 * @param {{ apnsDeliver?: Deliver }} [opts] the APNs transport, injected by the
 *   Node coordinator because push.js also runs in a Worker
 * @returns {Pusher}
 */
export function pusherFromEnv(env, logger, opts = {}) {
  const { apnsDeliver } = opts;

  // OFF UNLESS ASKED FOR, and the credentials are not the switch.
  //
  // Push used to turn itself on whenever an APNs key and an FCM service
  // account happened to be present, which is a fine rule for one deployment
  // and a bad one for a fork: the credentials that would be there are OURS,
  // and a fork that acquires them by copying a config is a fork sending
  // notifications to our app's device tokens. Making it an explicit switch
  // means turning push on is a line somebody wrote, not a side effect of
  // having pasted a secret.
  //
  // It is also the seam a paid entitlement would sit on later — an account
  // that has paid for the relay flips this rather than the plumbing changing.
  //
  // Unset is off and SAYS SO. Silence here is how a fleet discovers on the day
  // it matters that push was never wired up, which is the exact failure
  // logPusher's own comment is about.
  if (!truthy(env.AGENT_FLEET_PUSH)) {
    logger.info('push: disabled (AGENT_FLEET_PUSH is not set) — notifications are logged, not sent');
    return logPusher(logger);
  }

  const apns = apnsFromEnv(env, logger, apnsDeliver);
  const fcm = fcmFromEnv(env, logger);

  if (apns && fcm) {
    logger.info('push: APNs for iOS, FCM for everything else');
    return routingPusher({ ios: apns, other: fcm });
  }
  // One configured is still useful — a fleet with only Android phones needs no
  // Apple key, and an iOS-only one needs no Firebase project. What must not
  // happen is an iOS token going to FCM, which is what happened before this
  // function knew the difference.
  if (apns) return routingPusher({ ios: apns, other: logPusher(logger) });
  if (fcm) return routingPusher({ ios: logPusher(logger), other: fcm });

  // SWITCHED ON AND UNABLE TO SEND, which is the one combination that used to
  // reach this line saying nothing at all.
  //
  // The comment above the switch says "unset is off and SAYS SO" and it was
  // only true of the unset branch. A fleet that sets AGENT_FLEET_PUSH and has
  // no credentials — which is EVERY FORK deploying this repository's committed
  // wrangler.toml — fell through here silently, and neither apnsFromEnv nor
  // fcmFromEnv warns when its credentials are simply absent, because absent is
  // the ordinary case for the provider you are not using.
  //
  // So the silence was assembled out of three reasonable silences, which is how
  // this failure always happens. push-encryption.md promises the opposite in as
  // many words, and a document asserting something the code does not do is the
  // failure app-parity.md exists to name.
  logger.warn(
    'push: AGENT_FLEET_PUSH is set but no provider is configured — notifications are logged, not sent. ' +
      'APNs needs AGENT_FLEET_APNS_KEY, _KEY_ID and _TEAM_ID; FCM needs AGENT_FLEET_FCM_SERVICE_ACCOUNT. ' +
      'Unset AGENT_FLEET_PUSH if that is deliberate.',
  );
  return logPusher(logger);
}

/**
 * `1`, `true`, `yes`, `on` — anything else, including absent, is off.
 *
 * Deliberately not `Boolean(value)`: the string "0" and the string "false" are
 * both truthy in JavaScript, and a config file where `AGENT_FLEET_PUSH = "0"`
 * turns push ON is a config file nobody can read.
 *
 * @param {string|undefined} value
 */
function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ info: Function, warn: Function }} logger
 * @param {Deliver} [deliver]
 */
function apnsFromEnv(env, logger, deliver) {
  const { AGENT_FLEET_APNS_KEY_ID: keyId, AGENT_FLEET_APNS_TEAM_ID: teamId, AGENT_FLEET_APNS_KEY: privateKey } = env;
  const bundleId = env.AGENT_FLEET_APNS_BUNDLE_ID || 'network.thetech.fleetwright';
  if (!keyId && !teamId && !privateKey) return null;
  if (!keyId || !teamId || !privateKey) {
    logger.warn('push: APNs needs AGENT_FLEET_APNS_KEY_ID, _TEAM_ID and _KEY — all three. iOS push is off.');
    return null;
  }
  logger.info(`push: APNs configured for ${bundleId}`);
  return apnsPusher(
    {
      keyId,
      teamId,
      privateKey,
      bundleId,
      // Production unless told otherwise: a TestFlight or App Store build uses
      // the production environment, and only a build run from Xcode uses the
      // sandbox. Defaulting the other way would make the common case the one
      // that silently fails.
      production: env.AGENT_FLEET_APNS_SANDBOX !== '1',
    },
    { logger, deliver },
  );
}

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ info: Function, warn: Function }} logger
 */
function fcmFromEnv(env, logger) {
  const raw = env.AGENT_FLEET_FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  const parsed = parseServiceAccount(raw);
  if (!parsed) {
    logger.warn(
      'push: AGENT_FLEET_FCM_SERVICE_ACCOUNT is neither JSON nor base64-encoded JSON — falling back to logging.\n' +
        '  base64 -w0 service-account.json',
    );
    return null;
  }
  if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
    logger.warn('push: FCM service account is missing client_email, private_key or project_id — falling back to logging');
    return null;
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
