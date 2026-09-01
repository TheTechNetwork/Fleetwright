// The Durable Object that IS the fleet.
//
// It holds every host's WebSocket, the registry built from what they report,
// and the device registrations push goes to. One instance, so there is exactly
// one place that knows the fleet — which is also the only way the "resume is
// pinned to the box holding the volume" rule can be enforced at all.
//
// The logic is CoordinatorCore, shared verbatim with the Node coordinator. What
// is here is the parts that are genuinely Cloudflare: WebSocket hibernation,
// storage, and alarms.
//
// HIBERNATION MATTERS MORE THAN IT LOOKS. A fleet host holds its socket open
// for weeks and says almost nothing. Without `acceptWebSocket`, that idle
// socket would keep this object in memory the entire time and bill for it. With
// it, the object is evicted between messages and rebuilt on the next one —
// which is why the registry is reconstructed from what hosts report rather than
// held as the authority. That constraint and design.md §3's "the registry is a
// cache with provenance, never the authority" happen to be the same rule, which
// is a good sign the rule was right.

import { CoordinatorCore } from '../../src/fleet/coordinator/core.js';
import { pusherFromEnv } from '../../src/fleet/push.js';
import { verifyActionsToken, DEFAULT_ACTIONS_AUDIENCE, verifyAppleNotification, isWithdrawal } from '../../src/fleet/coordinator/oidc.js';
import { sendInvite } from '../../src/fleet/coordinator/invite-email.js';
import { credentialFrom, isClientCredential } from '../../src/fleet/coordinator/credential.js';
import { callbackPage } from '../../src/fleet/coordinator/github-oauth.js';
import { identify } from '../../src/fleet/coordinator/identity.js';
import { mcpRoutes, isMcpPath } from '../../src/mcp/routes.js';

/** How often to ask hosts for health if they have gone quiet. */
const ALARM_MS = 30_000;


/**
 * A comma or whitespace separated list from an environment variable.
 *
 * The Node coordinator has had one of these for a while; the Worker had not
 * needed one. Written out rather than imported because everything the Worker
 * shares with the Node side is deliberate, and a helper this small is not worth
 * a new coupling between them.
 *
 * @param {string|undefined} value
 */
function splitList(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export class Fleet {
  /**
   * @param {DurableObjectState} state
   * @param {Record<string, string|undefined>} env
   */
  constructor(state, env) {
    this.state = state;
    this.env = env;
    const logger = {
      info: (/** @type {any[]} */ ...a) => console.log(...a),
      warn: (/** @type {any[]} */ ...a) => console.warn(...a),
      error: (/** @type {any[]} */ ...a) => console.error(...a),
      debug: () => {},
    };
    // The CURRENT socket per host. In-memory and rebuilt on wake, because it
    // is derived state: the truth is the attachment tags, this is the dedupe.
    /** @type {Map<string, WebSocket>} */
    this.sockets = new Map();

    this.core = new CoordinatorCore({
      logger,
      push: pusherFromEnv(env, logger),
      // A Worker request cannot outlive its invocation the way a Node process
      // can, so an intent waits far less long here than on a box.
      intentTimeoutMs: 60_000,
      // Absent is the normal case for a deployment that has not registered an
      // App, and is not an error: the paste route is first-class and a fresh
      // clone of this repo must work with no GitHub App at all.
      githubApp: {
        clientId: env.AGENT_FLEET_GITHUB_CLIENT_ID,
        clientSecret: env.AGENT_FLEET_GITHUB_CLIENT_SECRET,
        slug: env.AGENT_FLEET_GITHUB_APP_SLUG,
      },
    });

    // Coalesced per invocation: several events can be recorded while handling
    // one message, and a DO storage write per line would be wasteful.
    let pending = null;
    this.core.onEvents = () => {
      if (pending) return;
      pending = Promise.resolve()
        .then(() => {
          pending = null;
          return this.#saveEvents();
        })
        // CAUGHT, and this line is load-bearing. `state.waitUntil?.()` below
        // guards itself into doing nothing when waitUntil is absent, so this
        // promise floats — and an unhandled rejection ABORTS THE WHOLE DURABLE
        // OBJECT: every WebSocket resets (hosts see 1006 read ECONNRESET),
        // every in-flight request dies (phones see "the network connection was
        // lost"), on every action that records an event. A fleet-wide outage,
        // caused by failing to persist a log line. The event ring is a
        // convenience; losing one write of it must never cost more than a
        // warning.
        .catch((e) => console.warn(`fleet: could not persist the event ring: ${e?.message || e}`));
      this.state.waitUntil?.(pending);
    };

    // Rebuilt on wake: hibernation means this object is evicted between
    // messages, and every socket that is still open comes back with the host id
    // we attached to it.
    this.state.blockConcurrencyWhile(async () => {
      this.core.hostIds.restore(/** @type {any[]} */ ((await this.state.storage.get('hostIds')) || []));
      this.core.clients.restore(/** @type {any[]} */ ((await this.state.storage.get('clients')) || []));
      // Separate store, separate key. A runner token that did not survive a
      // deploy would break every repository holding one, silently.
      this.core.runnerTokens.restore(/** @type {any[]} */ ((await this.state.storage.get('runnerTokens')) || []));
      this.core.invites.load((await this.state.storage.get('invites')) || []);
      this.core.enrollment.restore(/** @type {any[]} */ ((await this.state.storage.get('enrollment')) || []));
      // MCP clients that registered themselves. A Durable Object is evicted
      // between messages as a matter of course, so a registration held only
      // in memory is one that expires whenever traffic goes quiet — and the
      // client finds out after a person has already signed in.
      this.core.mcpAuthorizations.restore(/** @type {any[]} */ ((await this.state.storage.get('mcpClients')) || []));
      // The event ring, under its OWN key. Hibernation is by design here, so a
      // RAM-only ring meant "what happened while you were asleep" was answered
      // by whatever had accumulated since the last eviction — usually nothing.
      const events = /** @type {any[]} */ ((await this.state.storage.get('events')) || []);
      if (Array.isArray(events)) this.core.events.push(...events);
      const devices = (await this.state.storage.get('devices')) || [];
      for (const device of /** @type {any[]} */ (devices)) this.core.devices.set(device.token, device);
      // One socket per host, and only one. After a reconnect storm — which is
      // what an outage is — getWebSockets() can hold SEVERAL sockets tagged
      // with the same hostId: the live one and the half-open corpses of every
      // previous connection. Registering them in a loop means last-one-wins,
      // and the last may be a corpse: sends then go into a dead socket with no
      // error and every intent waits out its full timeout. Everything logs
      // "connected"; nothing routes. So duplicates are closed as they are
      // found, and the survivor is the registered one.
      for (const socket of this.state.getWebSockets()) {
        const hostId = this.#hostIdOf(socket);
        if (!hostId) continue;
        const previous = this.sockets.get(hostId);
        if (previous && previous !== socket) {
          try { previous.close(1012, 'superseded'); } catch { /* already gone */ }
        }
        this.sockets.set(hostId, socket);
        this.core.hostConnected(hostId, (msg) => socket.send(JSON.stringify(msg)));
      }
    });
  }

  /**
   * Who is signing in, and are they allowed.
   *
   * One function for `/api/session` and for the remote MCP sign-in, and the
   * SAME function the Node coordinator calls — see identity.js.
   *
   * @param {string} idToken
   */
  #identify(idToken) {
    return identify(idToken, {
      issuers: split(this.env.AGENT_FLEET_AUTH_ISSUERS),
      audiences: split(this.env.AGENT_FLEET_AUTH_AUDIENCES),
      allow: split(this.env.AGENT_FLEET_AUTH_ALLOW),
      invites: this.core.invites,
    });
  }

  /**
   * What the MCP routes need from this object.
   *
   * EVERY ONE OF THESE ALREADY EXISTED. Remote MCP adds a transport and an
   * OAuth dance in front of it; no new way to become somebody, no new kind of
   * credential, no new list of who is allowed.
   *
   * @param {URL} url  the request's own URL, for the fallback public origin
   * @returns {import('../../src/mcp/routes.js').Deps}
   */
  #mcpDeps(url) {
    const audiences = split(this.env.AGENT_FLEET_AUTH_AUDIENCES);
    return {
      authorizations: this.core.mcpAuthorizations,
      verifyCredential: (token) => this.core.clients.verify(token),
      verifyIdentity: (idToken) => this.#identify(idToken),
      issueCredential: (who, deviceName) => this.core.issueClient(who, deviceName),
      // Fire-and-forget on purpose: the reply does not depend on the write, and
      // a Durable Object write that has been issued will complete. The same
      // treatment the event ring gets, for the same reason.
      save: () => {
        this.state.waitUntil?.(this.#saveClients());
      },
      // WHERE THIS OBJECT SENDS INTENTS, which is not where the client reached
      // us. A Worker cannot call itself on loopback, so this is its public URL
      // — pinned by configuration when set, because `url.origin` is derived
      // from the request. Cloudflare only routes hostnames the operator
      // configured, so the exposure is far smaller here than on the Node
      // coordinator, but "smaller" is not a reason to keep the shape that was
      // wrong there.
      selfOrigin: this.env.AGENT_FLEET_PUBLIC_ORIGIN || url.origin,
      signIn: {
        // Google's web client, picked out of the audience list rather than set
        // twice — a separate variable would eventually disagree with the list
        // the token is actually verified against.
        google: audiences.find((a) => a.endsWith('.apps.googleusercontent.com')) || null,
        // A SERVICES ID, which is not the iOS bundle id sitting in the same
        // list. Sign in with Apple JS answers `invalid_client` for a bundle id
        // and says nothing about why, so an unset one shows no Apple button
        // rather than a broken one. It has to be in AGENT_FLEET_AUTH_AUDIENCES
        // too, or the token it mints will not verify here.
        apple: this.env.AGENT_FLEET_AUTH_APPLE_SERVICE || null,
      },
    };
  }

  /** @param {WebSocket} socket */
  #hostIdOf(socket) {
    try {
      return /** @type {any} */ (this.state.getTags?.(socket) || [])[0] || socket.deserializeAttachment?.()?.hostId || null;
    } catch {
      return null;
    }
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);

    // --- the remote MCP endpoint --------------------------------------------
    //
    // ABOVE THE CREDENTIAL CHECK, not merely above the routes. A REVOKED
    // credential on /mcp would otherwise get the generic 401 below, which
    // carries no WWW-Authenticate — leaving a client that used to work with
    // no way to discover it should sign in again. Discovery is read before a
    // client holds one, the sign-in page is a browser with none, and `/mcp`
    // must reach its own handler unauthenticated so it can answer the 401 that
    // carries WWW-Authenticate — the header the whole flow starts from.
    //
    // isMcpPath first, and the body only after: reading it to decide would
    // consume the stream for every other route in this object.
    if (isMcpPath(url.pathname)) {
      const answer = await mcpRoutes(
        {
          method: request.method,
          path: url.pathname,
          origin: url.origin,
          query: url.searchParams,
          body: request.method === 'POST' ? await readMcpBody(request) : null,
          authorization: request.headers.get('authorization'),
        },
        this.#mcpDeps(url),
      );
      if (answer) {
        // An absent header is dropped rather than written as the string
        // "undefined". The routes return a union in which one branch's header
        // is another branch's missing key.
        /** @type {Record<string,string>} */
        const extra = {};
        for (const [k, v] of Object.entries(answer.headers || {})) if (v != null) extra[k] = String(v);

        if (answer.html !== undefined) {
          return new Response(answer.html, {
            status: answer.status,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra },
          });
        }
        // 202 and nothing to say — a batch that was all notifications. A body
        // would be a JSON-RPC message with no id to match it to.
        if (answer.json === null || answer.json === undefined) {
          return new Response(null, { status: answer.status, headers: extra });
        }
        return new Response(JSON.stringify(answer.json), {
          status: answer.status,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
        });
      }
    }

    // A device credential, if that is what arrived. worker.js has already
    // established this is not the shared token, so anything reaching here with
    // an fwk_ prefix is either a live client or a revoked one — and a revoked
    // one must be refused rather than falling through to the routes below.
    // credentialFrom, NOT a second extraction. This read the header only, while
    // worker.js also accepted ?token= — so `?token=fwk_` passed the Worker's
    // "let the object judge it" check and arrived here looking like no
    // credential at all, which meant no judging and no refusal.
    const presented = credentialFrom(request.headers.get('authorization'), url);
    let client = null;
    if (isClientCredential(presented)) {
      client = await this.core.clients.verify(presented);
      if (!client) {
        return json({ ok: false, error: { code: 'unauthorised' }, text: 'That device credential is not valid.' }, 401);
      }
    }

    if (url.pathname === '/host/connect') return this.#acceptHost(request, url);

    // --- enrolment ---------------------------------------------------------
    //
    // A machine with no credential asking for one. The code is the whole of the
    // authorisation, which is why it is short-lived and single-use — see
    // enrollment.js.
    // A CI JOB ENROLLING ITSELF — no pin, and no secret that can admit a
    // machine. GitHub mints a short-lived token per job naming the repository,
    // the workflow file and the run; this is the same verifier used for
    // sign-in, pointed at a different issuer, with an allowlist of REPOSITORIES
    // rather than people because the subject is a job.
    //
    // Before the client check, deliberately: a runner has no fleet credential
    // and the whole point is that it does not need one.
    if (url.pathname === '/api/enroll/actions' && request.method === 'POST') {
      const body = await readJson(request);
      const repositories = splitList(this.env.AGENT_FLEET_ACTIONS_REPOS);
      if (!repositories.length) {
        return json(
          {
            ok: false,
            error: { code: 'not_configured' },
            text: 'This coordinator does not admit CI runners. Set AGENT_FLEET_ACTIONS_REPOS to the repositories that may.',
          },
          503,
        );
      }

      let job;
      try {
        job = await verifyActionsToken(String(body?.token || ''), {
          audiences: splitList(this.env.AGENT_FLEET_ACTIONS_AUDIENCE).length
            ? splitList(this.env.AGENT_FLEET_ACTIONS_AUDIENCE)
            : [DEFAULT_ACTIONS_AUDIENCE],
          repositories,
          workflowRef: this.env.AGENT_FLEET_ACTIONS_WORKFLOW || null,
        });
      } catch (e) {
        return json({ ok: false, error: { code: 'bad_token' }, text: /** @type {Error} */ (e).message }, 403);
      }

      // Reusable, revocable, and powerless on its own: the machine was admitted
      // by GitHub's token above. This only answers whose runner it is.
      const claim = await this.core.runnerTokens.verify(String(body?.claim || ''));
      if (!claim || !claim.email) {
        return json(
          {
            ok: false,
            error: { code: 'unclaimed' },
            text:
              'That runner token is not one this fleet issued, or it has been revoked. ' +
              'Mint one in the app under Hosts → Runner tokens and put it in the repository ' +
              'or organisation secret the workflow reads.',
          },
          403,
        );
      }

      // DERIVED, NOT ACCEPTED. A job that could choose its own name could
      // choose a permanent host's, and re-enrolment replaces a key.
      const hostId = `gha-${job.repository.replace(/[^A-Za-z0-9]+/g, '-')}-${job.runId}-${job.runAttempt}`;
      const result = await this.core.hostIds.enrol({
        hostId,
        publicJwk: body?.publicJwk,
        enrolledBy: `actions:${job.repository}`,
        owner: claim.email.toLowerCase(),
        ephemeral: true,
      });
      await this.#saveEnrollment();
      if (!result.ok || !result.host) {
        return json({ ok: false, error: { code: 'bad_request' }, text: result.error }, 400);
      }
      this.core.record({
        event: 'host.enrolled',
        hostId: result.host.hostId,
        fingerprint: result.host.fingerprint,
        text: `a runner from ${job.repository} enrolled itself for ${claim.email}`,
      });
      return json({ ok: true, hostId, fingerprint: result.host.fingerprint, ephemeral: true }, 200);
    }

    if (url.pathname === '/api/enroll/host' && request.method === 'POST') {
      const body = await readJson(request);
      const wanted = String(body?.hostId || '');
      const spent = await this.core.enrollment.redeem(String(body?.code || ''), 'host', wanted);
      // Saved either way: a spent code must not come back if this object is
      // evicted between the redemption and the next write.
      await this.#saveEnrollment();
      if (!spent.ok) return json({ ok: false, error: { code: 'bad_code' }, text: spent.reason }, 403);


      const result = await this.core.hostIds.enrol({
        hostId: wanted,
        publicJwk: body?.publicJwk,
        enrolledBy: spent.entry.actor,
        readmit: spent.entry.readmit,
        boundToThisHost: Boolean(spent.entry.hostId),
      });
      if (!result.ok) return json({ ok: false, error: { code: 'bad_request' }, text: result.error }, 400);
      await this.#saveHosts();

      this.core.record({ event: 'host.enrolled', hostId: result.host.hostId, fingerprint: result.host.fingerprint });

      // A re-enrolment REPLACES the key, and the machine holding the old one
      // may still be connected on this name. Leaving that socket open means two
      // machines are one host: the old one keeps answering intents addressed to
      // a name whose key it no longer holds, and which of them a `resume` lands
      // on is whichever the registry saw last. Close it and let whoever holds
      // the current key dial back in.
      if (result.replaced) {
        for (const socket of this.state.getWebSockets()) {
          if (this.#hostIdOf(socket) === result.host.hostId) {
            try {
              socket.close(1008, 're-enrolled');
            } catch { /* already gone */ }
          }
        }
      }
      return json({
        ok: true,
        hostId: result.host.hostId,
        fingerprint: result.host.fingerprint,
        replaced: result.replaced,
        text: result.readmitted
          ? `Readmitted ${result.host.hostId}, which had been revoked.`
          : result.replaced
            ? `Re-enrolled ${result.host.hostId}. The previous key no longer works.`
            : `Enrolled ${result.host.hostId}.`,
      });
    }

    // A nonce to sign. Unauthenticated by necessity — it is what an
    // unauthenticated party asks for in order to become authenticated — and it
    // gives nothing away: a nonce is only useful to whoever holds the key.
    // Apple's server-to-server notification.
    //
    // PUBLIC BY NECESSITY — Apple has no credential of ours, and the signature
    // on the JWT is the whole authentication. Anyone can POST here; only a
    // message signed by Apple, for our audience, does anything.
    //
    // It answers 200 to everything it can parse, including notifications it
    // ignores, because Apple retries on failure and there is nothing to gain
    // from making it retry a message we understood and did not act on.
    if (url.pathname === '/apple/notifications' && request.method === 'POST') {
      const body = await readJson(request);
      const audiences = split(this.env.AGENT_FLEET_AUTH_AUDIENCES);
      if (!audiences.length) return json({ ok: false, text: 'no audience configured' }, 503);
      try {
        const note = await verifyAppleNotification(String(body?.payload || ''), { audiences });
        if (isWithdrawal(note.type) && note.email) {
          const r = this.core.revokePerson(note.email, `withdrew consent at Apple (${note.type})`);
          if (r.revoked) {
            await this.#saveClients();
            await this.#saveDevices();
          }
        }
        return json({ ok: true });
      } catch {
        return json({ ok: false, text: 'that notification did not verify' }, 401);
      }
    }

    if (url.pathname === '/api/host/challenge' && request.method === 'POST') {
      const body = await readJson(request);
      const hostId = String(body?.hostId || '');
      return json({ ok: true, nonce: await this.core.hostIds.challenge(hostId) });
    }

    // The same check `/host/connect` makes, without the socket. `sidecar doctor`
    // asks this so an operator finds out that the key on disk was never enrolled
    // — or was revoked — from a diagnostic that says so, instead of from a
    // reconnect loop in the journal. It reveals nothing a connect attempt would
    // not, and it spends the challenge exactly the same way.
    if (url.pathname === '/api/host/verify' && request.method === 'POST') {
      const body = await readJson(request);
      const outcome = await this.core.hostIds.prove(
        String(body?.hostId || ''),
        String(body?.proof || ''),
        String(body?.nonce || ''),
      );
      if (!outcome.ok) return json({ ok: false, text: outcome.reason }, 401);
      return json({ ok: true, hostId: outcome.host.hostId, fingerprint: outcome.host.fingerprint });
    }

    if (url.pathname === '/api/hosts/enrolled' && request.method === 'GET') {
      return json({ ok: true, hosts: this.core.hostIds.list() });
    }

    // The destructive routes, checked BEFORE any of them run.
    //
    // This sat ninety lines further down, after the /api/hosts/ DELETE it was
    // supposed to guard, so it never fired here. The Node coordinator had the
    // identical bug and the tests caught it there — because they only
    // exercised that one. Same rule, same place, both now covered.
    if (/^\/api\/(hosts|clients)\//.test(url.pathname) && request.method === 'DELETE' && client && !client.admin) {
      return json(
        {
          ok: false,
          error: { code: 'not_admin' },
          text: 'Removing machines and other people\u2019s devices needs an admin credential on this fleet.',
        },
        403,
      );
    }

    // INVITING IS ADMIN, IN EVERY DIRECTION — reading the list included,
    // because a list of who has been invited is a list of colleagues and a
    // member has no reason to hold one. An invited person is a member and
    // cannot invite anybody else; otherwise "invite" would be a way to hand out
    // the fleet, one step removed. See src/fleet/coordinator/invites.js.
    if (url.pathname.startsWith('/api/invites') && client && !client.admin) {
      return json({ ok: false, error: { code: 'not_admin' }, text: 'Inviting people to this fleet needs an admin credential.' }, 403);
    }

    if (url.pathname === '/api/invites' && request.method === 'GET') {
      return json({ ok: true, invites: this.core.invites.list() });
    }

    if (url.pathname === '/api/invites' && request.method === 'POST') {
      const body = await readJson(request);
      const r = this.core.invites.add(String(body?.email || ''), {
        invitedBy: client?.email || 'admin',
        note: body?.note ? String(body.note) : null,
      });
      if (r.ok) await this.#saveInvites();
      // BEST EFFORT, AND SAID EITHER WAY. The list is the authority and the
      // mail is a courtesy: an invitation whose email bounced is still an
      // invitation, which is why `add` has already succeeded by here. What the
      // reply must not do is imply an email went when it did not — the whole
      // point of sending one is that the person knows which address to use.
      const posted = r.ok
        ? await sendInvite(this.#mailer(), {
          email: r.invite?.email ?? '',
          fleet: this.env.AGENT_FLEET_NAME || 'this Fleetwright fleet',
          invitedBy: client?.email || 'admin',
          note: r.invite?.note ?? null,
          apps: {
            ios: this.env.AGENT_FLEET_APP_IOS || null,
            android: this.env.AGENT_FLEET_APP_ANDROID || null,
          },
        })
        : { sent: false, why: 'not invited' };
      const text = r.ok
        ? `${r.message}${posted.sent ? '\nAn email is on its way to them.' : `\nNo email sent — ${posted.why}. Send them the app yourself.`}`
        : r.message;
      return json({ ...r, text, invites: this.core.invites.list() }, r.ok ? 200 : 400);
    }

    if (url.pathname.startsWith('/api/invites/') && request.method === 'DELETE') {
      const r = this.core.invites.remove(decodeURIComponent(url.pathname.slice('/api/invites/'.length)));
      if (r.ok) await this.#saveInvites();
      return json({ ...r, invites: this.core.invites.list() }, r.ok ? 200 : 404);
    }

    if (url.pathname.startsWith('/api/hosts/') && request.method === 'DELETE') {
      const hostId = decodeURIComponent(url.pathname.slice('/api/hosts/'.length));
      // Revoking twice is agreement, not an error. This used to answer 404
      // "is not enrolled" for a host that IS enrolled and revoked — so a person
      // whose first tap seemed not to work (the list bug in hosts.js) tapped
      // again and was told the host did not exist, while still looking at it.
      const existing = this.core.hostIds.hosts.get(hostId);
      if (existing?.revokedAt) {
        return json({ ok: true, text: `${hostId} was already revoked.` });
      }
      const gone = this.core.hostIds.revoke(hostId);
      if (gone) {
        await this.#saveHosts();
        // Disconnected as well as revoked: a revoked host with a live socket is
        // still in the fleet until something closes it, and "revoked" that
        // leaves the machine working is not revoked.
        for (const socket of this.state.getWebSockets()) {
          if (this.#hostIdOf(socket) === hostId) {
            try {
              socket.close(1008, 'revoked');
            } catch { /* already gone */ }
          }
        }
        this.core.hostDisconnected(hostId, 'revoked');
      }
      return json({ ok: gone, text: gone ? `${hostId} is out of the fleet.` : 'No such host, or already revoked.' }, gone ? 200 : 404);
    }

    // Signing in: the one route that takes an identity token rather than a
    // fleet credential, because it is where a fleet credential comes from.
    if (url.pathname === '/api/session' && request.method === 'POST') {
      const body = await readJson(request);
      // The same four checks the remote MCP sign-in makes, from the same
      // function. This was a verbatim copy of the Node coordinator's, which is
      // the shape every parity bug in this repository has had.
      const who = await this.#identify(String(body?.idToken || ''));
      if (!who.ok) return json({ ok: false, error: { code: who.code }, text: who.text }, who.status);

      const issued = await this.core.issueClient(who, body?.deviceName ? String(body.deviceName) : undefined);
      await this.#saveClients();
      return json({ ok: true, ...issued });
    }

    // Minting a pin. Requires an existing credential — this is the operator
    // handing out an invitation, not a way in — and the pin it returns is the
    // only thing shown, once, because it is written down and typed somewhere
    // else.
    // Runner tokens: reusable, revocable, and powerless on their own.
    //
    // Lives in a GitHub secret — organisation-wide or per repository — so it is
    // spent on every run rather than once. Which of those you choose decides
    // who the runners belong to: an ORGANISATION secret means every runner from
    // that org belongs to whoever minted the token; a REPOSITORY or environment
    // secret lets different repositories belong to different people. The fleet
    // cannot tell the difference and does not need to.
    if (url.pathname === '/api/runner-tokens' && request.method === 'POST') {
      if (!client?.email) {
        return json({ ok: false, text: 'Sign in first — a runner token belongs to a person.' }, 403);
      }
      const body = await readJson(request);
      const { client: issued, token } = await this.core.runnerTokens.issue(
        body?.name ? String(body.name) : 'a repository',
        {},
      );
      issued.email = client.email.toLowerCase();
      await this.#saveClients();
      // Shown once, like every other secret this coordinator issues.
      return json({ ok: true, id: issued.id, token, email: issued.email }, 200);
    }

    if (url.pathname === '/api/runner-tokens' && request.method === 'GET') {
      const mine = this.core.runnerTokens
        .list()
        .filter((t) => client?.admin || t.email === client?.email?.toLowerCase());
      return json({ ok: true, tokens: mine }, 200);
    }

    if (url.pathname.startsWith('/api/runner-tokens/') && request.method === 'DELETE') {
      const id = url.pathname.slice('/api/runner-tokens/'.length);
      const found = this.core.runnerTokens.list().find((t) => t.id === id);
      // "No such token" rather than "not yours", so the endpoint does not list
      // what exists for anybody who can guess an id.
      if (!found || !(client?.admin || found.email === client?.email?.toLowerCase())) {
        return json({ ok: false, text: 'No such runner token.' }, 404);
      }
      const gone = this.core.runnerTokens.revoke(id);
      await this.#saveClients();
      return json(
        { ok: gone, text: gone ? 'Revoked. Runs using it will no longer be attributed to you.' : 'No such runner token.' },
        gone ? 200 : 404,
      );
    }

    if (url.pathname === '/api/enroll' && request.method === 'POST') {
      const body = await readJson(request);
      const kind = body?.kind === 'device' ? 'device' : 'host';
      // Whoever signed in owns the code. A caller using the admin token can
      // name themselves, and if they do not, the event says so — an enrolment
      // nobody is attached to is a thing worth being able to see later.
      const actor = client?.email || (body?.actor ? String(body.actor) : null);
      const issued = this.core.enrollment.mint({
        purpose: kind,
        label: body?.label ? String(body.label) : '',
        actor,
        hostId: body?.hostId ? String(body.hostId) : null,
        readmit: Boolean(body?.readmit),
        // EPHEMERAL IS DECIDED WHEN THE PIN IS MINTED, which is the whole
        // design (docs/ephemeral-hosts.md) — a host that could declare itself
        // temporary is a host that could decline to be cleaned up. mint() has
        // accepted this since the framework was built; the HTTP layer dropped
        // it, so every runner enrolled as a PERMANENT host and its entry
        // survived the job that created it. One corpse per build, and the
        // retirement code that exists to prevent exactly that never ran.
        ephemeral: Boolean(body?.ephemeral),
      });
      await this.#saveEnrollment();
      this.core.record({ event: 'enrol.minted', hostId: null, text: `a ${kind} code was minted by ${actor || 'the admin token'}` });
      return json({ ok: true, ...issued });
    }

    if (url.pathname === '/api/enroll' && request.method === 'GET') {
      return json({ ok: true, codes: this.core.enrollment.outstanding() });
    }

    // Which devices can reach this fleet, and dropping one.

    if (url.pathname === '/api/clients' && request.method === 'GET') {
      return json({ ok: true, clients: this.core.clients.list() });
    }
    if (url.pathname.startsWith('/api/clients/') && request.method === 'DELETE') {
      const id = url.pathname.slice('/api/clients/'.length);
      // Revoke the credential AND stop notifying the device that held it —
      // otherwise a stolen phone loses the ability to ASK the fleet anything
      // and keeps the ability to be TOLD everything.
      const { revoked, devices } = this.core.revokeClient(id);
      if (revoked || devices) {
        await this.#saveClients();
        await this.#saveDevices();
      }
      return json(
        {
          ok: revoked,
          text: revoked
            ? `Revoked${devices ? `, and stopped ${devices} push registration${devices === 1 ? '' : 's'}` : ''}.`
            : 'No such client, or already revoked.',
        },
        revoked ? 200 : 404,
      );
    }

    if (url.pathname === '/oauth/github/callback') {
      const result = await this.core.finishGithubAuthorization({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        origin: url.origin,
      });
      // HTML, not JSON: the thing reading this is a browser somebody was sent
      // to, and a raw object on screen is how a working flow looks broken.
      return new Response(callbackPage(result), {
        status: result.ok ? 200 : 400,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/api/hosts' && request.method === 'GET') {
      // WHO IS ASKING. This returned every host's health blob verbatim —
      // every session's name, title, working directory, owner and live prompt
      // — to any member, while the visibility filter on `list` was being
      // enforced one route over.
      return json({ ok: true, ...this.core.snapshot(requesterFor(client)) });
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      // What a phone asks for when it opens, having been asleep while things
      // happened. Push wakes it; this tells it what it missed.
      return json({ ok: true, events: this.core.recentEvents(requesterFor(client)) });
    }

    if (url.pathname === '/api/devices' && request.method === 'POST') {
      const body = await readJson(request);
      const r = this.core.registerDevice({
        platform: String(body?.platform || ''),
        token: String(body?.token || ''),
        // The credential this registration belongs to, so revoking a phone can
        // stop the fleet talking to it. The Node coordinator does the same.
        clientId: client?.id,
        actor: client?.email || (body?.actor ? String(body.actor) : undefined),
      });
      if (r.ok) await this.#saveDevices();
      return json(r, r.ok ? 200 : 400);
    }

    // A notification a person asked for, so they can find out whether push
    // works before they need it to.
    if (url.pathname === '/api/devices/test' && request.method === 'POST') {
      const body = await readJson(request);
      const r = await this.core.testPush(body?.token ? String(body.token) : undefined);
      if (!r.ok && r.error?.code === 'not_delivered') await this.#saveDevices();
      return json(r, r.ok ? 200 : 400);
    }

    if (url.pathname === '/api/devices' && request.method === 'DELETE') {
      const body = await readJson(request);
      const r = this.core.unregisterDevice(String(body?.token || ''));
      await this.#saveDevices();
      return json(r);
    }

    if (url.pathname === '/api/intent' && request.method === 'POST') {
      const body = await readJson(request);
      if (!body || typeof body.verb !== 'string') {
        return json({ ok: false, error: { code: 'bad_request' }, text: 'send {verb, params}' }, 400);
      }
      const reply = await this.core.dispatch({
          verb: body.verb,
          params: body.params && typeof body.params === 'object' ? body.params : {},
          // The client's own identity wins over anything the request claims:
          // an actor a caller can choose is a label, not an attribution.
          actor: client?.email || (typeof body.actor === 'string' ? body.actor : undefined),
          // A caller-supplied idempotency key is honoured, so a phone that
          // retries a `start` gets the original outcome rather than a second
          // session.
          id: typeof body.id === 'string' ? body.id : undefined,
          // Which host, when the person picked one in the app. A placement
          // preference, never an intent parameter — see scheduler.js.
          preferHost: typeof body.host === 'string' ? body.host : undefined,
        preferLabels: body.tag ?? body.labels ?? null,
          // Placement, like `host` — see the comment in scheduler.js on why a tag
          // cannot be an intent parameter.
          preferLabels: body.tag ?? body.labels ?? null,
          // The VERIFIED caller, for visibility. Null for the break-glass token,
          // which sees everything — it is what you hold when identity is broken.
          requester: requesterFor(client),
        });
      // A `connect` reply carries the host's catalogue, which offers the paste
      // route because a host knows nothing about a GitHub App — correctly, the
      // client id and secret belong to the deployment rather than to any
      // machine. The coordinator is the only part that can improve on that, so
      // it rewrites the one entry it can and leaves the rest alone.
      return json(
        body.verb === 'connect'
          ? this.core.offerGithubApp(
              reply,
              typeof body.host === 'string' ? body.host : (reply?.hostId ?? ''),
              client?.email ?? null,
              url.origin,
            )
          : reply,
      );
    }

    // Shortcut-friendly shorthand: GET /api/<verb>/<name>. §7 wants flat JSON
    // and one round trip, because the caller is as often a spoken phrase routed
    // through "Get Contents of URL" as it is an app.
    const shorthand = url.pathname.match(
      /^\/api\/(list|status|peek|resume|stop|start|health)(?:\/([A-Za-z0-9][A-Za-z0-9_-]{0,39}))?$/,
    );
    if (shorthand) {
      const [, verb, name] = shorthand;
      /** @type {Record<string, any>} */
      const params = name ? { name } : {};
      const choice = url.searchParams.get('choice');
      if (verb === 'resume' && choice) params.choice = choice;
      // THE SHORTHAND IS NOT A BACK DOOR, and this copy was the worse of the
      // two: it omitted `requester` (so the ownership check had nothing to
      // check against, and `stop`/`resume`/`peek` reached any member's session
      // by name) AND it took the actor straight from the query string rather
      // than preferring the verified client, so the attribution it recorded
      // was whatever the caller typed.
      return json(
        await this.core.dispatch({
          verb,
          params,
          actor: client?.email || url.searchParams.get('actor') || undefined,
          requester: requesterFor(client),
        }),
      );
    }

    return json({ ok: false, error: { code: 'not_found' } }, 404);
  }

  /** @param {Request} request @param {URL} url */
  async #acceptHost(request, url) {
    if (request.headers.get('upgrade') !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const hostId = url.searchParams.get('hostId') || '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(hostId)) {
      return new Response('hostId missing or malformed', { status: 400 });
    }

    // THE HANDSHAKE. A host proves it holds the enrolled private key by
    // signing a nonce this coordinator issued moments ago, and the signature
    // arrives in a header on the upgrade request.
    //
    // Nothing reusable crosses the wire. The old arrangement sent a shared
    // bearer token on every connection, so anything that saw one connection
    // could open its own — and every host sent the same one, so seeing any
    // host's connection was as good as seeing all of them.
    //
    // The reason is in the response body rather than a bare 401, because the
    // party reading it is a machine whose operator will be reading its journal:
    // "not enrolled", "revoked" and "signature does not match" send them to
    // three different actions.
    const proof = request.headers.get('x-fleet-proof') || '';
    const nonce = request.headers.get('x-fleet-nonce') || '';
    const outcome = await this.core.hostIds.prove(hostId, proof, nonce);
    if (!outcome.ok) {
      this.core.record({ event: 'host.refused', hostId, text: outcome.reason });
      // In the reason phrase as well as the body. A refused upgrade is read out
      // of a journal on the box, and some clients only surface the status line
      // — a bare "401 Unauthorized" throws away the one sentence that says
      // which of three completely different problems this is.
      return new Response(outcome.reason, { status: 401, statusText: outcome.reason.replace(/[^\x20-\x7e]/g, ' ') });
    }
    await this.#saveHosts();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernatable, and tagged with the host id so the socket can be matched
    // back to its host after this object has been evicted and rebuilt.
    this.state.acceptWebSocket(server, [hostId]);
    server.serializeAttachment?.({ hostId });

    // Retire the connection this one replaces. A sidecar that reconnects —
    // after a network blip, a restart, an outage — arrives while its old
    // socket may still look open from this side. Leaving both means two
    // sockets race to be "the" connection, and the close of the loser used to
    // clobber the winner's registration.
    const previous = this.sockets.get(hostId);
    if (previous && previous !== server) {
      try { previous.close(1012, 'superseded'); } catch { /* already gone */ }
    }
    this.sockets.set(hostId, server);

    this.core.hostConnected(hostId, (msg) => server.send(JSON.stringify(msg)));
    await this.state.storage.setAlarm(Date.now() + ALARM_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** @param {WebSocket} socket @param {string|ArrayBuffer} message */
  async webSocketMessage(socket, message) {
    const hostId = this.#hostIdOf(socket);
    // LOGGED, because for one whole outage this handler was invisible: a
    // health frame that registered logged nothing, a frame dropped for a
    // missing tag logged nothing, and a reply that resolved logged nothing —
    // so a tail full of "Ok" could not say whether host frames were arriving
    // at all. One line per frame, and hosts send one health frame per 15s, so
    // the cost is four log lines a minute per fleet.
    console.log(`fleet: frame from ${hostId || 'UNTAGGED-SOCKET'}: ${String(message).slice(0, 80)}`);
    if (!hostId) return;
    let parsed;
    try {
      parsed = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      console.warn(`fleet: ${hostId} sent a non-JSON frame`);
      return;
    }
    await this.core.onHostMessage(hostId, parsed);
    // A push that reported dead tokens is the only chance to drop them; the
    // provider will not tell us again. But it is bookkeeping: a throw escaping
    // webSocketMessage resets the socket that delivered a perfectly good
    // message, so the host pays for our storage problem.
    try {
      await this.#saveDevices();
    } catch (e) {
      console.warn(`fleet: could not persist devices: ${e?.message || e}`);
    }
  }

  /** @param {WebSocket} socket @param {number} code @param {string} reason */
  async webSocketClose(socket, code, reason) {
    this.#socketGone(socket, `socket closed: ${code}${reason ? ` ${reason}` : ''}`);
  }

  /** @param {WebSocket} socket @param {any} error */
  async webSocketError(socket, error) {
    this.#socketGone(socket, `socket error: ${error?.message ?? error}`);
  }

  /**
   * A socket ended. That is only news about the HOST if it was the host's
   * current socket — the close of a superseded connection arriving after its
   * replacement used to mark a freshly-connected host offline, which is how a
   * fleet looks connected in every log while routing to nobody.
   *
   * @param {WebSocket} socket @param {string} why
   */
  #socketGone(socket, why) {
    const hostId = this.#hostIdOf(socket);
    if (!hostId) return;
    if (this.sockets.get(hostId) !== socket) return; // a corpse, not the connection
    this.sockets.delete(hostId);
    this.core.hostDisconnected(hostId, why);
  }

  /**
   * Hosts push their own health, so this is a backstop rather than the
   * mechanism: it re-arms while any socket is open, and asks anything that has
   * gone quiet. A DO alarm is far too coarse to poll on.
   */
  async alarm() {
    const sockets = this.state.getWebSockets();
    if (!sockets.length) return;
    for (const host of this.core.registry.schedulable()) {
      // Only the ones we have not heard from recently; a healthy host is
      // already telling us.
      const age = Date.now() - (host.healthAt ?? 0);
      if (age > ALARM_MS) void this.core.send(host, { verb: 'health' }, 10_000).catch(() => {});
    }
    await this.state.storage.setAlarm(Date.now() + ALARM_MS);
  }

  async #saveHosts() {
    await this.state.storage.put('hostIds', this.core.hostIds.serialise());
  }

  async #saveClients() {
    await this.state.storage.put('clients', this.core.clients.serialise());
    await this.state.storage.put('runnerTokens', this.core.runnerTokens.serialise());
    await this.state.storage.put('mcpClients', this.core.mcpAuthorizations.serialise());
  }

  /**
   * The Cloudflare email binding, wrapped so the core never sees one.
   *
   * Absent on a deployment that has not added the binding, which is most of
   * them and is not an error — see sendInvite. `from` must be an address on a
   * domain this account controls; Cloudflare refuses anything else, and that
   * refusal reaches the person inviting rather than a log.
   */
  #mailer() {
    const binding = /** @type {any} */ (this.env).EMAIL;
    const from = this.env.AGENT_FLEET_INVITE_FROM || null;
    if (!binding || !from) return { send: null, from };
    return {
      from,
      send: async (/** @type {{to: string, subject: string, text: string}} */ message) => {
        // THE EMAIL SENDING API, not the Email Routing one. The first version
        // of this built a raw MIME document and wrapped it in an `EmailMessage`
        // from `cloudflare:email` — which is how you REPLY to mail a Worker
        // received, and is a different product from sending one to somebody who
        // has never written to you. Sending takes a plain object and does the
        // MIME itself.
        //
        // Dropping that also drops a Node problem it had brought with it:
        // `cloudflare:email` exists only in the Workers runtime, so importing
        // it made this module unloadable under Node, which is where most of
        // this project's tests run.
        //
        // Text only, deliberately. This message is four short paragraphs whose
        // most important line is an email address; HTML would add a rendering
        // surface, an escaping question and nothing a reader gains.
        await binding.send({ to: message.to, from, subject: message.subject, text: message.text });
      },
    };
  }

  async #saveInvites() {
    await this.state.storage.put('invites', this.core.invites.toJSON());
  }

  async #saveEvents() {
    // Bounded by SERIALISED SIZE, not by count. DO storage refuses values over
    // 128KiB, and a count cap cannot promise a size: 200 events carrying 500
    // chars of text and 500 of url each is ~220KB. The ring fills slowly and
    // crosses the limit weeks after the code shipped, on a box where nothing
    // changed — which is exactly how it presented.
    //
    // (This also wrote slice(-500) while core caps the ring at 200 — a stale
    // copy of an older bound. One number, owned by the serialiser.)
    let events = this.core.events.slice(-200);
    while (events.length > 1 && JSON.stringify(events).length > 100_000) {
      // Oldest half first: the recent events are the ones a waking phone asks
      // for, and half-steps reach a fit in a few iterations rather than
      // re-serialising once per dropped event.
      events = events.slice(Math.ceil(events.length / 2));
    }
    await this.state.storage.put('events', events);
  }

  async #saveEnrollment() {
    await this.state.storage.put('enrollment', this.core.enrollment.serialise());
  }

  async #saveDevices() {
    await this.state.storage.put('devices', [...this.core.devices.values()]);
  }
}

/** @param {unknown} body @param {number} [status] */
/**
 * The identity an authorisation check is made against.
 *
 * `null` means "no client at all", which is the break-glass token — what you
 * hold when identity itself is broken, and deliberately unfiltered. Every
 * route must pass this rather than omitting it: a missing requester reads as
 * "do not filter", so forgetting it is the fail-OPEN direction. Both
 * coordinators carry the same helper for the same reason.
 *
 * @param {{ email?: string|null, admin?: boolean }|null|undefined} client
 */
function requesterFor(client) {
  return client ? { email: client.email ?? null, admin: Boolean(client.admin) } : null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** @param {Request} request */
async function readJson(request) {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? /** @type {any} */ (parsed) : null;
  } catch {
    return null;
  }
}

/**
 * The body of an MCP or OAuth request.
 *
 * NOT readJson(), and both differences are real bugs otherwise:
 *
 *   A JSON-RPC BATCH IS AN ARRAY, and readJson returns null for one because
 *   every other route here takes an object.
 *
 *   /oauth/token IS FORM-ENCODED. RFC 6749 says so and clients follow it; a
 *   token endpoint that reads only JSON refuses every conforming client at the
 *   last step of a flow the person has already completed.
 *
 * @param {Request} request
 */
async function readMcpBody(request) {
  try {
    if (String(request.headers.get('content-type') || '').includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(await request.text()));
    }
    return await request.json();
  } catch {
    return null;
  }
}

/** A comma or space separated setting, as a list. */
function split(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
