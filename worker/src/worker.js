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

export { Fleet };

export default {
  /**
   * @param {Request} request
   * @param {{ FLEET: DurableObjectNamespace, AGENT_FLEET_HOST_TOKEN?: string, AGENT_FLEET_API_TOKEN?: string }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // Liveness only, and the one deliberately unauthenticated surface (§5). It
    // says nothing about hosts, sessions or counts.
    if (url.pathname === '/healthz') {
      return json({ ok: true, protocol: 1 });
    }

    // Refusing to run open is not the same as being misconfigured. A
    // coordinator with no credentials is remote control of every box in the
    // fleet for anyone who finds the URL, and a Worker URL is not a secret.
    if (!env.AGENT_FLEET_HOST_TOKEN || !env.AGENT_FLEET_API_TOKEN) {
      return json(
        {
          ok: false,
          error: { code: 'not_configured' },
          text:
            'This coordinator has no tokens set. Run:\n' +
            '  wrangler secret put AGENT_FLEET_HOST_TOKEN\n' +
            '  wrangler secret put AGENT_FLEET_API_TOKEN',
        },
        503,
      );
    }

    const isHost = url.pathname === '/host/connect';
    const expected = isHost ? env.AGENT_FLEET_HOST_TOKEN : env.AGENT_FLEET_API_TOKEN;
    const presented = bearerOf(request.headers.get('authorization')) || url.searchParams.get('token') || '';
    if (!timingSafeEqual(presented, expected)) {
      // Checked HERE, before the request reaches the Durable Object, so an
      // unauthenticated peer never gets as far as something holding state.
      return json({ ok: false, error: { code: 'unauthorised' } }, 401);
    }

    // One instance, one fleet. A fleet is tens of hosts; sharding would buy
    // headroom nobody needs at the cost of a consistency problem.
    const id = env.FLEET.idFromName('fleet');
    return env.FLEET.get(id).fetch(request);
  },
};

/** @param {string|null} header */
function bearerOf(header) {
  const h = header || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

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
