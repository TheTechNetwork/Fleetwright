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

import { Fleet as FleetObject } from './fleet-do.js';
import { demoReply } from './demo.js';
import { credentialFrom, isClientCredential } from '../../src/fleet/coordinator/credential.js';
import { PROTOCOL_VERSION } from '../../src/fleet/protocol/intents.js';
import { isMcpPath } from '../../src/mcp/routes.js';
import * as Sentry from '@sentry/cloudflare';
import { sentryOptions } from './sentry.js';

// THE DURABLE OBJECT REPORTS TOO, and it is where the interesting failures
// live: the socket handling, the intent routing, the storage. An unhandled
// throw in here used to be a 500 with a console line nobody was reading.
export const Fleet = Sentry.instrumentDurableObjectWithSentry(sentryOptions, FleetObject);

/**
 * Is this request on the demo hostname?
 *
 * Configured rather than hardcoded, because a second deployment of this Worker
 * is entitled to a different demo domain, and because a literal here would be
 * one more place to forget when the hostname changes. Absent means "no demo
 * domain" — the correct answer for local dev and for anybody who has not set
 * one up, where the token path further down still works.
 *
 * EXACT MATCH, never a suffix test. `endsWith('fleetdemo.thetech.network')`
 * would also accept `notfleetdemo.thetech.network`, and a hostname check that
 * can be widened by prefixing it is not a check.
 *
 * @param {URL} url
 * @param {{ AGENT_FLEET_DEMO_HOST?: string }} env
 */
function isDemoHost(url, env) {
  const configured = String(env.AGENT_FLEET_DEMO_HOST || '').trim().toLowerCase();
  return configured !== '' && url.hostname.toLowerCase() === configured;
}

/**
 * Reach the Durable Object, surviving a deploy that lands mid-request.
 *
 * EVERY WORKER DEPLOY EVICTS LIVE DURABLE OBJECTS. Cloudflare throws
 * "Durable Object reset because its code was updated." into whatever request
 * was in flight, and there is nothing to fix in the object: it is the platform
 * working as designed. It surfaced as this fleet's first production error
 * report, on `/api/host/challenge`, from a host that reconnected seconds later
 * on its own backoff.
 *
 * So this is not an outage. What was wrong is the ANSWER: an unhandled throw
 * became a 500, which tells a host nothing and says "server broken" to anything
 * reading status codes. A deploy is the most predictable interruption this
 * service has, and it should read as "come back in a moment".
 *
 * WHY NOT RETRY EVERYTHING, which is the obvious move and the wrong one. The
 * reset arrives with no way to know whether the object had already acted. Replay
 * `/api/enroll` and a single-use pin is spent twice — the second attempt fails
 * and the machine is told its pin is invalid. Replay `/api/intent` with `start`
 * from a caller that sent no idempotency id and the fleet runs two sessions.
 *
 * A request is replayed only when replaying it is indistinguishable from
 * sending it once:
 *
 *   - GET and HEAD, which change nothing by definition.
 *   - POST /api/host/challenge, which mints a nonce. Getting a second one costs
 *     nothing; the first is simply never spent, and hosts.js already expires
 *     unspent nonces. This is the route the error actually arrived on.
 *
 * Everything else gets 503 with Retry-After. That is the honest answer — the
 * request may or may not have happened, and a caller that knows to come back
 * is better served than one handed a 500 and a guess.
 *
 * @param {any} env
 * @param {Request} request
 */
async function callFleet(env, request) {
  const url = new URL(request.url);
  const replayable =
    request.method === 'GET' ||
    request.method === 'HEAD' ||
    (request.method === 'POST' && url.pathname === '/api/host/challenge');

  // Cloned BEFORE the first attempt, because a body is read once. Only when it
  // could be replayed — cloning every request would buffer bodies this Worker
  // otherwise streams straight through.
  const spare = replayable ? request.clone() : null;

  const id = env.FLEET.idFromName('fleet');
  try {
    return await env.FLEET.get(id).fetch(request);
  } catch (e) {
    if (!isObjectReset(e)) throw e;
    if (spare) {
      // A FRESH STUB, not the old one: the point is to reach the object as
      // rebuilt by the deploy. Storage is durable and unaffected.
      return await env.FLEET.get(env.FLEET.idFromName('fleet')).fetch(spare);
    }
    return json(
      {
        ok: false,
        error: { code: 'restarting' },
        text: 'This coordinator was redeployed while handling your request. Nothing was lost; try again.',
      },
      503,
      { 'retry-after': '2' },
    );
  }
}

/**
 * Is this the platform interrupting us, rather than a fault?
 *
 * Matched on the message because Cloudflare gives these no code. Kept to the
 * two that mean "the object went away underneath you" — anything broader would
 * swallow a real failure and retry it, which is how a bug becomes a bug that
 * happens twice.
 *
 * @param {unknown} e
 */
function isObjectReset(e) {
  const message = String(/** @type {any} */ (e)?.message || e);
  return /Durable Object reset because its code was updated/i.test(message) || /cannot access storage because the object has been reset/i.test(message);
}

const handler = {
  /**
   * @param {Request} request
   * @param {{ FLEET: DurableObjectNamespace, AGENT_FLEET_API_TOKEN?: string, AGENT_FLEET_DEMO_TOKEN?: string, AGENT_FLEET_DEMO_HOST?: string, DEMO_RATE_LIMIT?: { limit: (o: {key: string}) => Promise<{success: boolean}> }, SIGNIN_RATE_LIMIT?: { limit: (o: {key: string}) => Promise<{success: boolean}> } }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // Liveness only, and the one deliberately unauthenticated surface (§5). It
    // says nothing about hosts, sessions or counts.
    if (url.pathname === '/healthz') {
      // From the constant, NEVER a literal. This is the first thing anybody
      // curls when the fleet stops answering, and a hardcoded 1 makes it lie
      // in exactly that moment: a Worker running v2 code would report v1, and
      // send whoever is debugging a protocol mismatch off to look at the one
      // thing that is not wrong.
      return json({ ok: true, protocol: PROTOCOL_VERSION });
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

    // The contract, served by the thing that implements it.
    //
    // Deliberately the raw document and NOT a bundled Swagger UI. That would be
    // a large third-party script on the origin holding every credential, and it
    // would need the CSP loosened to run — a real cost, for an API of fifteen
    // routes that most people will read in the repository. Point your own
    // Swagger, Redoc or Bruno at this URL instead.
    if (url.pathname === '/openapi.json') {
      return new Response(OPENAPI, {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
      });
    }

    // Apple's notifications carry no credential of ours and cannot — the
    // signature on the JWT is the authentication, checked in the object.
    if (url.pathname === '/apple/notifications' && request.method === 'POST') {
      return callFleet(env, request);
    }

    // THE GITHUB CALLBACK, above the token gate on purpose: GitHub redirects a
    // BROWSER here, and a browser carries no fleet credential. What stands in
    // for one is the `state` — unguessable, single-use, minutes-long, and bound
    // to the host and person who started the flow. That is the whole security
    // of this route, and it is checked inside the Durable Object because that
    // is where the pending flow was minted.
    if (url.pathname === '/oauth/github/callback') {
      return callFleet(env, request);
    }

    // THE REMOTE MCP ENDPOINT, above the token gate and necessarily so.
    //
    // Discovery is what a client reads before it holds any credential, the
    // sign-in page is a browser with none, and `/mcp` itself must reach the
    // object unauthenticated: the 401 it answers carries the WWW-Authenticate
    // header that names where to sign in, and this Worker's generic 401 does
    // not. A client that gets the generic one reports the endpoint as broken
    // rather than as protected, and the flow never starts.
    //
    // The same list as isMcpPath() in src/mcp/routes.js, and it has to be —
    // a path served there and not forwarded here is a 401 with no explanation.
    // test/worker-routes.test.js walks both.
    if (isMcpPath(url.pathname)) {
      // The sign-in POST does the same expensive anonymous work /api/session
      // does — a key-set fetch and a signature verification — so it gets the
      // same bucket. The rest are cheap and carry no secret.
      if (url.pathname === '/oauth/authorize' && request.method === 'POST' && env.SIGNIN_RATE_LIMIT) {
        const key = `signin:${request.headers.get('cf-connecting-ip') || 'unknown'}`;
        const { success } = await env.SIGNIN_RATE_LIMIT.limit({ key });
        if (!success) {
          return json({ ok: false, error: { code: 'rate_limited' }, text: 'Too many sign-in attempts. Try again in a minute.' }, 429);
        }
      }
      return callFleet(env, request);
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

    // THE DEMO LIVES ON ITS OWN HOSTNAME, and that is the whole security
    // property restated in a stronger form.
    //
    // It used to be only a token: hold `AGENT_FLEET_DEMO_TOKEN` and get
    // invented data. That worked, but it meant every real route had to be
    // reached and then not taken, and the argument for safety was "this branch
    // runs first". On the demo hostname the argument is shorter — a request
    // here NEVER REACHES THE ROUTES AT ALL. No host enrolment, no websocket,
    // no sign-in, no Durable Object, and no credential that could change the
    // answer.
    //
    // Note the position: ABOVE the host routes. If this sat where the token
    // check sits, `/host/connect` on the demo domain would have returned
    // earlier and joined the real fleet. "Demo" must not become a way in, and
    // the way to guarantee that is to answer before the door exists rather
    // than to remember not to open it.
    //
    // No credential is checked and none is needed: the data is three invented
    // sessions on two invented machines, identical for everybody.
    if (isDemoHost(url, env)) {
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
      const demoBody = request.method === 'POST' ? await readJsonSafely(request) : null;
      const demoAnswer = demoReply(url, request.method, demoBody);
      return demoAnswer
        ? json({ ...demoAnswer, demo: true })
        : json({ ok: false, error: { code: 'not_found' }, demo: true }, 404);
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
      return callFleet(env, request);
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
      return callFleet(env, request);
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
        return callFleet(env, request);
      }
      return json({ ok: false, error: { code: 'unauthorised' } }, 401);
    }

    // One instance, one fleet. A fleet is tens of hosts; sharding would buy
    // headroom nobody needs at the cost of a consistency problem.
    return callFleet(env, request);
  },
};

// WRAPPED LAST, so everything above is inside the reporting boundary.
//
// `withSentry` takes a function of env rather than a literal because a Worker
// has no environment at module scope — the DSN arrives with the request. No DSN
// configured means no reporting and no code path of its own: a fresh clone, a
// contributor's `wrangler dev` and a self-hosted fleet all run this unchanged
// and post nothing anywhere.
//
// What it may send is decided in ./sentry.js, and the short version is: not the
// URL's query, not a header, not a body. This coordinator carries a credential
// on nearly every request.
export default Sentry.withSentry(sentryOptions, handler);


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
function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    // `extra` is for the headers a status code is meaningless without —
    // Retry-After on a 503 is the difference between "come back in two seconds"
    // and "something is broken, stop trying".
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

// Accurate rather than boilerplate. Every claim here is one the code makes
// true, which is the only kind worth publishing: the app talks to a
// coordinator the operator runs, and this project runs no service that
// collects anything.
// The API contract, inlined at build time so the Worker ships no files.
// openapi.json in the repository root is the source; test/openapi.test.js
// executes it against BOTH coordinators, which is the reason it exists.
const OPENAPI = JSON.stringify({
  "openapi": "3.1.0",
  "info": {
    "title": "Fleetwright coordinator",
    "version": "1.0.0",
    "summary": "Long-running Claude Code sessions on machines you own, driven from a phone.",
    "description": "There are TWO implementations of this API \u2014 a Cloudflare Worker with a Durable Object, and a Node process \u2014 and they are required to behave identically. This document is the contract between them, and `test/openapi.test.js` walks it and asserts both.\n\nThat is the reason it exists. It is not primarily documentation: five separate parity bugs reached this branch before it was written, the last of which (`GET /api/events` existing on one coordinator and not the other) was found in about ten seconds by listing both route tables side by side.\n\nCONVENTIONS THAT ARE NOT OBVIOUS:\n\n- Every response carries `ok`. A 200 with `ok: false` is normal and means the fleet answered and the answer was no.\n- Errors carry `error.code` for a machine and `text` for a person. The text is written to be shown as-is; several of them are the only guidance an operator gets.\n- A credential may arrive as `Authorization: Bearer <token>` OR as `?token=<token>`. The query form is deliberate: a Shortcut calls this through \"Get Contents of URL\" and cannot set headers. Both are read by one function so the two forms can never diverge \u2014 they did once, and `?token=fwk_` was full access.",
    "license": {
      "name": "See repository"
    }
  },
  "servers": [
    {
      "url": "https://fleet.thetech.network",
      "description": "the Cloudflare Worker"
    },
    {
      "url": "http://127.0.0.1:8791",
      "description": "a Node coordinator on a box"
    }
  ],
  "tags": [
    {
      "name": "public",
      "description": "Reachable with no credential, deliberately. Each one is here for a stated reason."
    },
    {
      "name": "identity",
      "description": "Becoming allowed in: signing in, enrolling a machine."
    },
    {
      "name": "fleet",
      "description": "What exists and what it is doing."
    },
    {
      "name": "intents",
      "description": "Doing something to a session."
    },
    {
      "name": "devices",
      "description": "Push registration."
    }
  ],
  "components": {
    "securitySchemes": {
      "bearer": {
        "type": "http",
        "scheme": "bearer",
        "description": "A per-device credential (`fwk_<id>_<secret>`) issued by POST /api/session, or the break-glass admin token. Phones use the former; the latter can stop every session in the fleet."
      },
      "queryToken": {
        "type": "apiKey",
        "in": "query",
        "name": "token",
        "description": "The same credential, for callers that cannot set a header. Shortcuts, mostly."
      }
    },
    "schemas": {
      "Reply": {
        "type": "object",
        "required": [
          "ok"
        ],
        "properties": {
          "ok": {
            "type": "boolean"
          },
          "text": {
            "type": [
              "string",
              "null"
            ],
            "description": "For a person. Shown as-is."
          },
          "error": {
            "type": "object",
            "properties": {
              "code": {
                "type": "string"
              }
            },
            "required": [
              "code"
            ]
          }
        }
      },
      "Session": {
        "type": "object",
        "required": [
          "name",
          "status"
        ],
        "properties": {
          "name": {
            "type": "string",
            "description": "Generated and stable, e.g. cc-brave-otter. The identity everything keys on."
          },
          "title": {
            "type": [
              "string",
              "null"
            ],
            "description": "What the work is. For people."
          },
          "status": {
            "type": "string",
            "enum": [
              "running",
              "stopped",
              "error"
            ]
          },
          "hostId": {
            "type": [
              "string",
              "null"
            ],
            "description": "Which box. Attached by the coordinator on fan-out, because two hosts can hold the same name."
          },
          "rcUrl": {
            "type": [
              "string",
              "null"
            ],
            "description": "Remote Control, if this session has published one."
          },
          "uuid": {
            "type": [
              "string",
              "null"
            ],
            "description": "The conversation. Present means resumable."
          }
        }
      },
      "Host": {
        "type": "object",
        "required": [
          "hostId",
          "connected",
          "state"
        ],
        "properties": {
          "hostId": {
            "type": "string"
          },
          "connected": {
            "type": "boolean"
          },
          "connectedAt": {
            "type": [
              "number",
              "null"
            ]
          },
          "state": {
            "type": "string",
            "enum": [
              "healthy",
              "degraded",
              "unknown",
              "offline"
            ],
            "description": "Four values, not three. `offline` is what a host becomes when its socket drops \u2014 a fact we know, distinct from `unknown`, which is what we say when we have not heard recently enough to be sure. A client that collapses them reports a box we KNOW is gone as a box we cannot see, which is the more alarming of the two and the less accurate."
          },
          "reason": {
            "type": [
              "string",
              "null"
            ],
            "description": "Why it is not healthy, as a sentence. The registry works hard to make \"we don't know\" unrepresentable."
          },
          "health": {
            "type": [
              "object",
              "null"
            ],
            "additionalProperties": true
          },
          "healthAt": {
            "type": [
              "number",
              "null"
            ]
          }
        }
      },
      "EnrolledHost": {
        "type": "object",
        "required": [
          "hostId",
          "fingerprint"
        ],
        "properties": {
          "hostId": {
            "type": "string"
          },
          "fingerprint": {
            "type": "string",
            "description": "16 hex characters of SHA-256 over the public key. Compare against what the box prints."
          },
          "enrolledBy": {
            "type": [
              "string",
              "null"
            ]
          },
          "enrolledAt": {
            "type": [
              "number",
              "null"
            ]
          },
          "lastSeenAt": {
            "type": [
              "number",
              "null"
            ]
          },
          "revokedAt": {
            "type": [
              "number",
              "null"
            ]
          }
        }
      },
      "Event": {
        "type": "object",
        "required": [
          "event",
          "at"
        ],
        "properties": {
          "hostId": {
            "type": [
              "string",
              "null"
            ]
          },
          "event": {
            "type": "string",
            "description": "session.awaiting-input, session.ended, session.error, session.rc-online, host.enrolled, host.refused, host.revoked, enrol.minted, intent"
          },
          "name": {
            "type": [
              "string",
              "null"
            ]
          },
          "text": {
            "type": [
              "string",
              "null"
            ]
          },
          "actor": {
            "type": [
              "string",
              "null"
            ],
            "description": "The verified email of whoever asked. Null for events the fleet originated."
          },
          "verb": {
            "type": [
              "string",
              "null"
            ]
          },
          "url": {
            "type": [
              "string",
              "null"
            ]
          },
          "at": {
            "type": "number"
          }
        }
      },
      "Prompt": {
        "type": "object",
        "description": "What a session is asking, when the host recognised the shape of it. Never raw pane text \u2014 see src/fleet/host/prompt.js.",
        "required": [
          "id",
          "kind",
          "question",
          "options"
        ],
        "properties": {
          "id": {
            "type": "string",
            "description": "Names this question as rendered. An answer that no longer matches is refused rather than typed into whatever is on screen instead."
          },
          "kind": {
            "type": "string",
            "enum": [
              "resume",
              "trust",
              "permission"
            ]
          },
          "question": {
            "type": "string",
            "description": "Written by the fleet, drawn from a fixed vocabulary. Never lifted from the terminal."
          },
          "options": {
            "type": "array",
            "items": {
              "type": "object",
              "required": [
                "index",
                "label"
              ],
              "properties": {
                "index": {
                  "type": "integer"
                },
                "label": {
                  "type": "string",
                  "maxLength": 80
                }
              }
            }
          }
        }
      }
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "queryToken": []
    }
  ],
  "paths": {
    "/healthz": {
      "get": {
        "tags": [
          "public"
        ],
        "security": [],
        "summary": "Liveness, and nothing else",
        "description": "No host names, no counts. A liveness endpoint that leaks the fleet is not a liveness endpoint.",
        "responses": {
          "200": {
            "description": "alive",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "ok",
                    "protocol"
                  ],
                  "properties": {
                    "ok": {
                      "const": true
                    },
                    "protocol": {
                      "type": "integer"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/session": {
      "post": {
        "tags": [
          "identity"
        ],
        "security": [],
        "summary": "Sign in, and receive a credential for this device",
        "description": "The one route that takes an identity token rather than a fleet credential, because it is where a fleet credential comes from. The ID token is verified against the provider's published keys and the address checked against the fleet's allowlist. Rate limited.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "idToken"
                ],
                "properties": {
                  "idToken": {
                    "type": "string",
                    "description": "From Sign in with Apple or Google."
                  },
                  "deviceName": {
                    "type": "string",
                    "description": "Names the credential in the fleet's device list."
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "The only time the credential exists in full. The coordinator keeps a hash.",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "ok",
                    "token"
                  ],
                  "properties": {
                    "ok": {
                      "const": true
                    },
                    "token": {
                      "type": "string",
                      "pattern": "^fwk_"
                    },
                    "client": {
                      "type": "object",
                      "additionalProperties": true
                    }
                  }
                }
              }
            }
          },
          "401": {
            "description": "The token did not verify, and the reason says which check failed."
          },
          "403": {
            "description": "Verified, and not allowed in. `private_relay` means Hide My Email, which can never match a domain."
          },
          "429": {
            "description": "Too many attempts from this address."
          },
          "503": {
            "description": "This coordinator has no sign-in configured."
          }
        }
      }
    },
    "/api/enroll": {
      "post": {
        "tags": [
          "identity"
        ],
        "summary": "Mint a six-digit pin",
        "description": "An invitation, not a way in \u2014 it requires a credential. A pin is short-lived, single-use and purpose-bound. Bind it to a host id to allow replacing that machine's key; an unbound pin may only ADD a machine.",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "kind": {
                    "type": "string",
                    "enum": [
                      "host",
                      "device"
                    ],
                    "default": "host"
                  },
                  "label": {
                    "type": "string"
                  },
                  "hostId": {
                    "type": "string",
                    "description": "Bind the pin to one machine."
                  },
                  "readmit": {
                    "type": "boolean",
                    "description": "Allow this pin to bring back a REVOKED host."
                  },
                  "ephemeral": {
                    "type": "boolean",
                    "description": "Admit a host that is expected to vanish: a disconnect retires the entry and revokes its key, and the scheduler will not place ordinary work on it. Decided here rather than claimed by the host \u2014 see docs/ephemeral-hosts.md."
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "the pin, shown once",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "ok",
                    "code"
                  ],
                  "properties": {
                    "ok": {
                      "const": true
                    },
                    "code": {
                      "type": "string",
                      "pattern": "^[0-9]{6}$"
                    },
                    "expiresAt": {
                      "type": "number"
                    },
                    "purpose": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          },
          "401": {
            "description": "no credential"
          }
        }
      },
      "get": {
        "tags": [
          "identity"
        ],
        "summary": "What pins are outstanding",
        "description": "Codes are masked. This answers \"what did I leave lying around\", not \"what is the pin\".",
        "responses": {
          "200": {
            "description": "outstanding pins, masked"
          },
          "401": {
            "description": "no credential"
          }
        }
      }
    },
    "/api/enroll/host": {
      "post": {
        "tags": [
          "identity"
        ],
        "security": [],
        "summary": "Spend a pin to register a machine's public key",
        "description": "Reachable without a credential BECAUSE it is how a machine that has none gets one. The pin is the authorisation.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "code",
                  "hostId",
                  "publicJwk"
                ],
                "properties": {
                  "code": {
                    "type": "string"
                  },
                  "hostId": {
                    "type": "string"
                  },
                  "publicJwk": {
                    "type": "object",
                    "description": "P-256 public key. A private key here is refused."
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "enrolled, re-enrolled or readmitted \u2014 `text` says which"
          },
          "400": {
            "description": "the key or the host id was not acceptable"
          },
          "403": {
            "description": "the pin was wrong, spent, expired, or minted for another host"
          }
        }
      }
    },
    "/api/host/challenge": {
      "post": {
        "tags": [
          "identity"
        ],
        "security": [],
        "summary": "A nonce to sign",
        "description": "Unauthenticated by necessity \u2014 asking for a nonce is what an unauthenticated party does in order to become authenticated. Nothing is stored: the nonce carries its own proof that this coordinator issued it, so a flood costs the coordinator nothing and cannot evict anybody else's.",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "hostId": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "a nonce",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "ok",
                    "nonce"
                  ],
                  "properties": {
                    "ok": {
                      "const": true
                    },
                    "nonce": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/host/verify": {
      "post": {
        "tags": [
          "identity"
        ],
        "security": [],
        "summary": "The same check /host/connect makes, without the socket",
        "description": "So `agent-fleet-sidecar doctor` can tell an operator that the key on disk was never enrolled, or has been revoked, instead of leaving them to read a reconnect loop out of the journal.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "hostId",
                  "nonce",
                  "proof"
                ],
                "properties": {
                  "hostId": {
                    "type": "string"
                  },
                  "nonce": {
                    "type": "string"
                  },
                  "proof": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "this host would be admitted"
          },
          "401": {
            "description": "and the reason distinguishes not-enrolled, revoked, expired, already-used and wrong-key"
          }
        }
      }
    },
    "/api/hosts": {
      "get": {
        "tags": [
          "fleet"
        ],
        "summary": "Everything a client can see about the fleet",
        "responses": {
          "200": {
            "description": "hosts, device count, recent events",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "ok",
                    "protocol",
                    "hosts"
                  ],
                  "properties": {
                    "ok": {
                      "const": true
                    },
                    "protocol": {
                      "type": "integer"
                    },
                    "hosts": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Host"
                      }
                    },
                    "devices": {
                      "type": "integer"
                    },
                    "events": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Event"
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "description": "no credential"
          }
        }
      }
    },
    "/api/hosts/enrolled": {
      "get": {
        "tags": [
          "identity"
        ],
        "summary": "Which machines are in this fleet, with their key fingerprints",
        "description": "Carries no key material. The fingerprint is for a person to compare against what the box prints.",
        "responses": {
          "200": {
            "description": "enrolled machines",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "ok",
                    "hosts"
                  ],
                  "properties": {
                    "ok": {
                      "const": true
                    },
                    "hosts": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/EnrolledHost"
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "description": "no credential"
          }
        }
      }
    },
    "/api/hosts/{hostId}": {
      "delete": {
        "tags": [
          "identity"
        ],
        "summary": "Remove a machine from the fleet",
        "description": "Revoked AND disconnected: a revoked host holding a live socket is still in the fleet until something closes it. Marked rather than deleted, so a host that reconnects is told it was revoked rather than that it was never known.",
        "parameters": [
          {
            "name": "hostId",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "revoked and disconnected"
          },
          "401": {
            "description": "no credential"
          },
          "404": {
            "description": "no such host, or already revoked"
          }
        }
      }
    },
    "/api/clients": {
      "get": {
        "tags": [
          "identity"
        ],
        "summary": "Which devices can reach this fleet",
        "description": "Without secrets \u2014 the coordinator stores a hash, not a token.",
        "responses": {
          "200": {
            "description": "devices"
          },
          "401": {
            "description": "no credential"
          }
        }
      }
    },
    "/api/clients/{id}": {
      "delete": {
        "tags": [
          "identity"
        ],
        "summary": "Revoke one device, leaving every other alone",
        "description": "Which is the whole point of there being more than one credential.",
        "parameters": [
          {
            "name": "id",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "revoked"
          },
          "401": {
            "description": "no credential"
          },
          "404": {
            "description": "no such client, or already revoked"
          }
        }
      }
    },
    "/api/events": {
      "get": {
        "tags": [
          "fleet"
        ],
        "summary": "What happened while you were asleep",
        "description": "Push wakes a phone; this tells it what it missed. Capped at the same page size on both coordinators.",
        "responses": {
          "200": {
            "description": "recent events, oldest first",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "required": [
                    "ok",
                    "events"
                  ],
                  "properties": {
                    "ok": {
                      "const": true
                    },
                    "events": {
                      "type": "array",
                      "items": {
                        "$ref": "#/components/schemas/Event"
                      }
                    }
                  }
                }
              }
            }
          },
          "401": {
            "description": "no credential"
          }
        }
      }
    },
    "/api/intent": {
      "post": {
        "tags": [
          "intents"
        ],
        "summary": "Do something to a session",
        "description": "The fixed verb set is the security model: this API cannot express a shell string even to itself, so a compromised coordinator can start and stop sessions and can never run anything. A caller-supplied `actor` is a label; a signed-in device's verified email overrides it.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "verb"
                ],
                "properties": {
                  "verb": {
                    "type": "string",
                    "enum": [
                      "answer",
                      "connect",
                      "copyfile",
                      "deletefile",
                      "files",
                      "forget",
                      "health",
                      "link",
                      "list",
                      "logs",
                      "peek",
                      "purge",
                      "readfile",
                      "reboot",
                      "renew",
                      "restore",
                      "resume",
                      "start",
                      "status",
                      "stop",
                      "unlink",
                      "update",
                      "upgrade",
                      "verify",
                      "writefile"
                    ]
                  },
                  "params": {
                    "type": "object",
                    "additionalProperties": true
                  },
                  "actor": {
                    "type": "string"
                  },
                  "id": {
                    "type": "string",
                    "description": "Idempotency key, honoured: a retried `start` returns the original outcome rather than a second session."
                  },
                  "host": {
                    "type": "string",
                    "description": "Placement preference for `start`: run the session on this host. Beside the intent rather than in params, because `start` declares no host parameter \u2014 a host receiving one would refuse the intent. Ignored for pinned and fan-out verbs. Refused by name if the host is unknown, degraded, or full."
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "The fleet answered. `ok: false` here means the answer was no.",
            "content": {
              "application/json": {
                "schema": {
                  "allOf": [
                    {
                      "$ref": "#/components/schemas/Reply"
                    },
                    {
                      "type": "object",
                      "properties": {
                        "sessions": {
                          "type": "array",
                          "items": {
                            "$ref": "#/components/schemas/Session"
                          }
                        },
                        "fanout": {
                          "type": "boolean"
                        },
                        "hosts": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "additionalProperties": true
                          }
                        }
                      }
                    }
                  ]
                }
              }
            }
          },
          "400": {
            "description": "not a well-formed intent"
          },
          "401": {
            "description": "no credential"
          }
        }
      }
    },
    "/api/devices": {
      "post": {
        "tags": [
          "devices"
        ],
        "summary": "Register for push",
        "description": "Keyed by the push token rather than an id we mint, because the token is what identifies a delivery target \u2014 and a reinstall gives the same phone a new one, which should not accumulate as a second registration that fails forever.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "platform",
                  "token"
                ],
                "properties": {
                  "platform": {
                    "type": "string",
                    "enum": [
                      "ios",
                      "android",
                      "web"
                    ]
                  },
                  "token": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "registered"
          },
          "400": {
            "description": "unknown platform, or no token"
          },
          "401": {
            "description": "no credential"
          }
        }
      },
      "delete": {
        "tags": [
          "devices"
        ],
        "summary": "Stop notifying this device",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "token"
                ],
                "properties": {
                  "token": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "forgotten"
          },
          "401": {
            "description": "no credential"
          },
          "404": {
            "description": "not registered"
          }
        }
      }
    },
    "/api/devices/test": {
      "post": {
        "tags": [
          "devices"
        ],
        "summary": "Send this device a notification now",
        "description": "Push fails silently by nature: a registration that never arrived and a provider that was never configured look identical from a phone, which is to say they look like nothing at all. This is the only way to find out before the notification that matters.",
        "responses": {
          "200": {
            "description": "sent, or a reason it was not"
          },
          "401": {
            "description": "no credential"
          }
        }
      }
    },
    "/apple/notifications": {
      "post": {
        "tags": [
          "identity"
        ],
        "security": [],
        "summary": "Apple's server-to-server notification",
        "description": "Apple POSTs a signed JWT here when a user changes mail forwarding, REVOKES this app from their Apple ID settings, or deletes their Apple Account. The last two mean a person has withdrawn consent, and every credential issued to that address is revoked \u2014 along with the push registrations that went with them.\n\nPublic by necessity: Apple holds no credential of ours, so the signature on the JWT is the entire authentication. Anyone may POST here; only a message signed by Apple, for this app's audience, does anything.\n\nAnswers 200 to anything it can verify, including notifications it deliberately ignores, because Apple retries on failure and there is nothing to gain from making it retry a message we understood.",
        "requestBody": {
          "required": true,
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": [
                  "payload"
                ],
                "properties": {
                  "payload": {
                    "type": "string",
                    "description": "A JWT signed by Apple."
                  }
                }
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "verified \u2014 acted on, or deliberately ignored"
          },
          "401": {
            "description": "the notification did not verify"
          },
          "503": {
            "description": "this coordinator has no audience configured, so it cannot check one"
          }
        }
      }
    },
    "/oauth/github/callback": {
      "get": {
        "summary": "Finish a GitHub App authorization",
        "description": "Where GitHub redirects a browser after somebody authorizes the App. Unauthenticated by necessity \u2014 a browser carries no fleet credential \u2014 and secured by `state`: unguessable, single-use, minutes-long, and bound to the host and person who started the flow. Returns HTML, because the thing reading it is a browser. Absent a configured App, every request here is refused.",
        "parameters": [
          {
            "name": "code",
            "in": "query",
            "required": true,
            "schema": {
              "type": "string"
            }
          },
          {
            "name": "state",
            "in": "query",
            "required": true,
            "schema": {
              "type": "string"
            }
          }
        ],
        "responses": {
          "200": {
            "description": "Connected. An HTML page telling the person they can close the tab.",
            "content": {
              "text/html": {
                "schema": {
                  "type": "string"
                }
              }
            }
          },
          "400": {
            "description": "Refused \u2014 unknown, expired or already-used state, or GitHub declined.",
            "content": {
              "text/html": {
                "schema": {
                  "type": "string"
                }
              }
            }
          }
        },
        "security": []
      }
    }
  }
});

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
