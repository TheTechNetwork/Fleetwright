// The coordinator as a Cloudflare Worker.
//
// This file is only routing and credentials. Everything that carries a decision
// is in ../../src/fleet/, unchanged and shared with the Node coordinator — the
// host registry, placement, the intent protocol and the push senders all import
// nothing from `node:`, which is what lets them run in both places instead of
// becoming two implementations that drift.
//
//     host  ──wss──▶  /host/connect     persistent, the host dials out
//     phone ──https─▶ /api/intent       one round trip, flat JSON
//
// Both on one origin, because a host pins exactly one.

import { Fleet } from './fleet-do.js';
import { demoReply } from './demo.js';
import { credentialFrom, isClientCredential } from '../../src/fleet/coordinator/credential.js';

export { Fleet };

export default {
  /**
   * @param {Request} request
   * @param {{ FLEET: DurableObjectNamespace, AGENT_FLEET_API_TOKEN?: string, AGENT_FLEET_DEMO_TOKEN?: string, DEMO_RATE_LIMIT?: { limit: (o: {key: string}) => Promise<{success: boolean}> }, SIGNIN_RATE_LIMIT?: { limit: (o: {key: string}) => Promise<{success: boolean}> } }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // Liveness only, and the one deliberately unauthenticated surface (§5). It
    // says nothing about hosts, sessions or counts.
    if (url.pathname === '/healthz') {
      return json({ ok: true, protocol: 1 });
    }

    // The second deliberately unauthenticated surface, and it exists for a
    // dull reason: App Store Connect will not accept an app for external
    // testing without a privacy policy at a public URL. Serving it from the
    // coordinator means the URL is stable, versioned with the code it
    // describes, and cannot rot separately from it.
    if (url.pathname === '/privacy') {
      return new Response(PRIVACY, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' },
      });
    }

    // The third, and the reason it is a redirect rather than a copy: the thing
    // people paste into a root shell should be served by the place that has the
    // source, so it cannot go stale here and cannot be edited here either. This
    // Worker answers with a Location and holds no shell script of its own.
    //
    // Above the token gate on purpose. A box being installed has no credential
    // — acquiring one is what the install is for.
    if (url.pathname === '/install' || url.pathname === '/install.sh') {
      return Response.redirect(
        'https://raw.githubusercontent.com/TheTechNetwork/Fleetwright/main/install/bootstrap.sh',
        302,
      );
    }

    // Refusing to run open is not the same as being misconfigured. A
    // coordinator with no credentials is remote control of every box in the
    // fleet for anyone who finds the URL, and a Worker URL is not a secret.
    //
    // Only the admin token is required now. Hosts carry their own keys, and
    // people sign in — so the thing that must exist at boot is the credential
    // that can mint the first enrolment code, and nothing else.
    if (!env.AGENT_FLEET_API_TOKEN) {
      return json(
        {
          ok: false,
          error: { code: 'not_configured' },
          text:
            'This coordinator has no admin token set. Run:\n' +
            '  wrangler secret put AGENT_FLEET_API_TOKEN\n\n' +
            'Hosts and phones do not use it — they enrol and sign in. It exists to ' +
            'mint the first enrolment code and to get back in when nothing else works.',
        },
        503,
      );
    }

    // A host authenticates by SIGNATURE, inside the Durable Object, which is
    // the only thing holding the enrolled keys. There is no shared host token
    // any more: AGENT_FLEET_HOST_TOKEN was one string that every machine
    // presented, so it could not distinguish two hosts, could not revoke one,
    // and was replayable by anything that saw a single connection.
    if (
      url.pathname === '/host/connect' ||
      url.pathname === '/api/host/challenge' ||
      url.pathname === '/api/host/verify' ||
      url.pathname === '/api/enroll/host'
    ) {
      const id = env.FLEET.idFromName('fleet');
      return env.FLEET.get(id).fetch(request);
    }

    const presented = credentialFrom(request.headers.get('authorization'), url);

    // The demo token, if one is configured. Answered HERE, before the Durable
    // Object is reached, which is the whole security property: there is no code
    // path from a demo request to a host socket or a real session. Not "we are
    // careful" — the object is never fetched.
    //
    // App Store review needs credentials that work, and the real API token can
    // stop every session in the fleet. This is the other way to satisfy that.
    //
    // NEVER for a host route: "demo" must not become a way into the fleet. That
    // used to be a condition here; it is now structural — every host route
    // returned above, so control cannot reach this line on one.
    if (env.AGENT_FLEET_DEMO_TOKEN && timingSafeEqual(presented, env.AGENT_FLEET_DEMO_TOKEN)) {
      // A demo token equal to the real one would silently turn the whole
      // coordinator into a toy. Refuse rather than guess which was meant.
      if (timingSafeEqual(env.AGENT_FLEET_DEMO_TOKEN, env.AGENT_FLEET_API_TOKEN || '')) {
        return json({ ok: false, error: { code: 'misconfigured' }, text: 'AGENT_FLEET_DEMO_TOKEN must differ from AGENT_FLEET_API_TOKEN' }, 500);
      }
      // The token is public, so the budget is per client address rather than
      // per token — one abuser must not be able to lock out a reviewer.
      // Absent binding means local dev, where there is nothing to protect.
      if (env.DEMO_RATE_LIMIT) {
        const key = request.headers.get('cf-connecting-ip') || 'unknown';
        const { success } = await env.DEMO_RATE_LIMIT.limit({ key });
        if (!success) {
          return json(
            { ok: false, error: { code: 'rate_limited' }, demo: true, text: 'Too many demo requests. Try again in a minute.' },
            429,
          );
        }
      }
      const body = request.method === 'POST' ? await readJsonSafely(request) : null;
      const reply = demoReply(url, request.method, body);
      return reply ? json({ ...reply, demo: true }) : json({ ok: false, error: { code: 'not_found' }, demo: true }, 404);
    }

    // Signing in cannot require being signed in. The Durable Object verifies
    // the identity token itself, so this route is reachable without a fleet
    // credential and refuses on its own terms.
    //
    // Bounded here rather than there, so a flood never reaches the object that
    // holds the fleet. It is the one unauthenticated route that does real work
    // for an anonymous caller — a key-set fetch, a signature verification, and
    // on success a stored client record.
    if (url.pathname === '/api/session' && request.method === 'POST') {
      if (env.SIGNIN_RATE_LIMIT) {
        const key = `signin:${request.headers.get('cf-connecting-ip') || 'unknown'}`;
        const { success } = await env.SIGNIN_RATE_LIMIT.limit({ key });
        if (!success) {
          return json(
            { ok: false, error: { code: 'rate_limited' }, text: 'Too many sign-in attempts. Try again in a minute.' },
            429,
          );
        }
      }
      const id = env.FLEET.idFromName('fleet');
      return env.FLEET.get(id).fetch(request);
    }

    // The admin token, which is the only shared credential left. Non-empty by
    // the time control gets here: the guard above answers 503 when it is unset,
    // rather than comparing against '' and letting a blank Authorization
    // header through.
    //
    // This was `isHost ? env.AGENT_FLEET_HOST_TOKEN : env.AGENT_FLEET_API_TOKEN`
    // and the declaration went out with the host token while the reference
    // below stayed. Every authenticated request threw ReferenceError. Bundling
    // does not catch that, and neither does anything else that never executes
    // the file — which was everything, until test/worker-routes.test.js.
    const expected = env.AGENT_FLEET_API_TOKEN || '';

    if (!timingSafeEqual(presented, expected)) {
      // Checked HERE, before the request reaches the Durable Object, so an
      // unauthenticated peer never gets as far as something holding state.
      // Not the shared token — but it may be a credential issued to a device.
      // Checked in the Durable Object, which is the only thing holding the
      // client registry; the shared token stays a fast path that never needs
      // it.
      if (isClientCredential(presented)) {
        const id = env.FLEET.idFromName('fleet');
        return env.FLEET.get(id).fetch(request);
      }
      return json({ ok: false, error: { code: 'unauthorised' } }, 401);
    }

    // One instance, one fleet. A fleet is tens of hosts; sharding would buy
    // headroom nobody needs at the cost of a consistency problem.
    const id = env.FLEET.idFromName('fleet');
    return env.FLEET.get(id).fetch(request);
  },
};


/**
 * Constant-time compare. Not because a token is guessable byte by byte over the
 * internet, but because getting into the habit of `===` on secrets is how the
 * one that matters gets compared that way too.
 * @param {string} a @param {string} b
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// Accurate rather than boilerplate. Every claim here is one the code makes
// true, which is the only kind worth publishing: the app talks to a
// coordinator the operator runs, and this project runs no service that
// collects anything.
const PRIVACY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleetwright — Privacy</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem;
         font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  code { font-size: 0.9em; }
</style></head><body>
<h1>Fleetwright — Privacy</h1>
<p><strong>There is no Fleetwright service.</strong> It is a client for a
coordinator you run yourself, there is no account to create here, and there is
no analytics, advertising or tracking of any kind.</p>

<p>Signing in uses <strong>your own Apple or Google account</strong>. Fleetwright
does not create one, does not store a password, and never sees one.</p>

<h2>Your email address</h2>
<p>When you sign in, Apple or Google confirms your email address to your
coordinator, which decides whether that address is allowed in and issues this
device a credential of its own. The address is shown in Settings so you can see
who the app is signed in as, and it is attached to the commands you send so your
coordinator's records say who did what.</p>
<p>It goes to your coordinator and nowhere else. Choose <em>Share My Email</em>
on iOS: a hidden relay address cannot be matched against the list of people your
coordinator allows, and signing in will be refused.</p>

<h2>What stays on your device</h2>
<p>The coordinator's address, the credential issued to this device, and the email
address you signed in with. The credential is held in the iOS Keychain or behind
an Android Keystore key that cannot be exported, and it is sent only to that
coordinator, as an <code>Authorization</code> header over HTTPS.</p>

<h2>What is sent to your coordinator</h2>
<ul>
  <li>The commands you issue — list, start, stop, resume a session.</li>
  <li>The email address you signed in with, so the commands are attributable.</li>
  <li>Your push notification token, if you enable notifications, so the
      coordinator can tell you when a session needs an answer.</li>
</ul>
<p>That coordinator is infrastructure you operate. Its logs and its data are
yours, and this app has no other destination.</p>

<h2>Third parties</h2>
<p>Two, and only for the two things that cannot be done without them: Apple or
Google confirm who you are when you sign in, and Apple or Google deliver a push
notification to your device. No advertising, no tracking, no analytics, and no
third-party SDKs beyond the sign-in components each platform provides.</p>
<p>Your coordinator is not a third party — it is infrastructure you operate.</p>

<h2>Deleting your data</h2>
<p>Deleting the app removes the credential, the coordinator address and the email
address from the device. Revoking the device from your coordinator — from another
signed-in device, or with the admin credential — stops it reaching the fleet at
all and takes its push registration with it.</p>

<h2>Source</h2>
<p>The app and the coordinator are open source:
<a href="https://github.com/TheTechNetwork/Fleetwright">github.com/TheTechNetwork/Fleetwright</a>.
Every claim on this page can be checked against the code.</p>
</body></html>`;

/** @param {Request} request */
async function readJsonSafely(request) {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
