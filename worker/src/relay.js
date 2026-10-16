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

import { RELAY_PREFIX, answerRelay, readBytes, tooBig } from '../../src/fleet/relay/relay.js';

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
        // The idle sweep's page of fleets (relay.js, `sweep`), in key order.
        list: (options) => storage.list(options),
      },
    });
  }
}

export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${RELAY_PREFIX}/`)) return new Response('Not found', { status: 404 });
    // THE BODY IS READ HERE, to the cap and no further, and only what fits is
    // handed to the object. Streamed through instead, a body over the cap
    // made the object answer 413 while this Worker was still pumping the rest
    // into it, and under `wrangler dev` workerd threw "Can't read from request
    // stream after response has been sent" here instead of passing it on.
    // The object reads it bounded again (readBytes), which is what keeps a
    // stranger's upload out of the memory every fleet shares either way.
    if (request.body) {
      const bytes = await readBytes(request);
      if (bytes === undefined) return tooBig();
      request = new Request(request, { body: bytes });
    }
    const relay = env.RELAY.get(env.RELAY.idFromName('relay'));
    return relay.fetch(request);
  },
};
