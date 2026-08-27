// APNs over HTTP/2, for the coordinator running as a Node process.
//
// Apple requires HTTP/2 and will not answer anything else. A Worker's fetch
// negotiates it; Node's does not, and the usual answer is to add undici and
// hand it an Agent with allowH2. node:http2 is already in the runtime and is
// about thirty lines, which is cheaper than a dependency in a project that has
// none.
//
// Kept OUT of push.js deliberately. That file runs in a Worker, where
// node:http2 does not exist and importing it would break the bundle — the
// transport is injected for exactly this reason.

import http2 from 'node:http2';

/**
 * A transport for apnsPusher.
 *
 * The session is reused across notifications and reconnected when it drops.
 * Apple explicitly asks for a persistent connection: opening one per push is
 * both slow and something they will eventually throttle.
 *
 * @param {string} [host]
 * @returns {import('./push.js').Deliver}
 */
export function http2Deliver(host = 'api.push.apple.com') {
  /** @type {import('node:http2').ClientHttp2Session|null} */
  let session = null;

  function connect() {
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(`https://${host}`);
    // A dead session must not become a permanently broken sender, and an idle
    // one must not hold the process open — a coordinator that will not exit
    // because it is waiting on Apple is a worse bug than a slow push.
    session.on('error', () => { session = null; });
    session.on('close', () => { session = null; });
    session.unref();
    return session;
  }

  return (token, payload, headers) =>
    new Promise((resolve, reject) => {
      const request = connect().request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        ...headers,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });

      let status = 0;
      let body = '';
      request.on('response', (h) => {
        status = Number(h[':status']) || 0;
      });
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => resolve({ status, body }));
      request.on('error', reject);
      // Apple answers in milliseconds. A request that has not, has hung.
      request.setTimeout(10_000, () => {
        request.close();
        reject(new Error('APNs request timed out'));
      });
      request.end(payload);
    });
}
