// The public face: the demo fleet and the product page, on a Worker of their
// own.
//
// WHY THIS IS A SEPARATE SCRIPT AND NOT A HOSTNAME BRANCH.
//
// The demo used to live inside the coordinator, answered above the host routes
// on its own hostname. That was correct and it was tested, and it was still one
// script: the same bundle that holds the Durable Object binding, the GitHub App
// client secret, the APNs key and the sign-in path was also the thing serving
// an unauthenticated page to anybody who found it. The security argument was
// "control returns before it reaches the door" — true, but it is an argument
// about ORDER, and order is a property of code that gets edited.
//
// Here there is no argument to make. This script has no FLEET binding, no
// secrets, and no import of the coordinator: a bug in it cannot reach a
// session, because there is nothing in scope that could. `wrangler.demo.toml`
// is the whole surface, and it is short enough to read in one sitting.
//
// It also decouples two very different release cadences. The page describing
// the product changes when the words are wrong; the coordinator changes when
// the fleet does. Shipping the second to fix the first is how a deploy that
// evicts every live Durable Object gets made for a typo.
//
// NOTHING HERE IS REAL. Every session, host and event is a constant in
// demo.js. There is no state, no storage, and no credential — which is why the
// demo token is not checked: it never guarded anything, and a check that can
// only ever pass is a check nobody maintains.

import { demoReply } from './demo.js';
import { DOCS, PRIVACY } from './pages.js';

/**
 * @param {any} body
 * @param {number} [status]
 */
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/** @param {string} html */
const page = (html) =>
  new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      // A page with no credential to steal still gets the headers, because the
      // reason to set them is that somebody will later add a form.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });

/** @param {Request} request */
async function readJsonSafely(request) {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export default {
  /**
   * @param {Request} request
   * @param {{ DEMO_RATE_LIMIT?: { limit: (o: {key: string}) => Promise<{success: boolean}> } }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // THE PRODUCT PAGE, and the reason this Worker is worth having at all.
    //
    // Unauthenticated by design and unauthenticated in fact: it says nothing
    // about any fleet, because this script cannot see one. No host names, no
    // session names, no counts — there is nobody to ask and nothing to ask.
    if (url.pathname === '/' || url.pathname === '/docs') return page(DOCS);
    if (url.pathname === '/privacy') return page(PRIVACY);

    // The budget is per client address rather than per credential: the demo is
    // open, and one abuser must not be able to lock out an App Store reviewer
    // by exhausting a shared allowance. Absent binding means local dev, where
    // there is nothing to protect.
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

    // `demo: true` on every reply, so a support question is never ambiguous
    // about which fleet somebody was looking at.
    return reply ? json({ ...reply, demo: true }) : json({ ok: false, error: { code: 'not_found' }, demo: true }, 404);
  },
};
