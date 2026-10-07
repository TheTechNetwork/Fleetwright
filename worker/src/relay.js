// The relays' Worker: push and the GitHub OAuth callback, for coordinators
// that are not ours. What it answers and what it keeps is in
// src/fleet/relay/relay.js and docs/relay-terms.md; this file is only the
// Worker around it.
//
//   cd worker && npx wrangler deploy --config wrangler.relay.toml
//
// EVERY REQUEST GOES THROUGH ONE DURABLE OBJECT, `RelayState`, so the fleets
// and the counters have one reader and one writer and a cap is exact. The
// object keeps rows in its own storage and nothing else does: no KV, no
// analytics binding, no queue, and observability off in wrangler.relay.toml.

import { RELAY_PREFIX, answerRelay } from '../../src/fleet/relay/relay.js';

export class RelayState {
  /** @param {any} state @param {Record<string, string|undefined>} env */
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
  }

  /** @param {Request} request */
  async fetch(request) {
    const storage = this.storage;
    return answerRelay(request, {
      env: this.env,
      store: {
        get: (key) => storage.get(key),
        put: (key, value) => storage.put(key, value),
        delete: async (key) => {
          await storage.delete(key);
        },
      },
    });
  }
}

export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${RELAY_PREFIX}/`)) return new Response('Not found', { status: 404 });
    const relay = env.RELAY.get(env.RELAY.idFromName('relay'));
    return relay.fetch(request);
  },
};
