// A transport that speaks newline-delimited JSON over stdin/stdout.
//
// The coordinator does not exist yet. Rather than ship a sidecar that cannot be
// run until it does, this lets the whole path be driven by hand and in tests
// against a real agent-hub:
//
//     echo '{"v":1,"kind":"intent","id":"idem-0000001","verb":"list","issuedAt":0}' \
//       | agent-fleet-sidecar --transport stdio
//
// It is also the shape the WebSocket transport will have: dial, hand messages
// to a handler, send replies, stop. Swapping one for the other is a constructor
// argument in bin/agent-fleet-sidecar and nothing else — which is the point of
// §4's "build the host agent so transport is one swappable module".
//
// `origin` is a label here rather than a pinned TLS origin, because there is no
// network leg to pin. It is still required, so that the sidecar's refusal to
// start without one is exercised on this path too rather than only in tests.

import { createInterface } from 'node:readline';

export class StdioTransport {
  /**
   * @param {{ origin?: string, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [opts]
   */
  constructor({ origin = 'stdio:local', input = process.stdin, output = process.stdout } = {}) {
    this.origin = origin;
    this.input = input;
    this.output = output;
    /** @type {((msg: unknown) => Promise<void>)|null} */
    this.handler = null;
    /** @type {import('node:readline').Interface|null} */
    this.rl = null;
    /** Resolves when stdin closes, so the process knows when to exit. */
    this.closed = new Promise((resolve) => {
      this.markClosed = () => resolve(null);
    });
  }

  /** @param {(msg: unknown) => Promise<void>} handler */
  onMessage(handler) {
    this.handler = handler;
  }

  async start() {
    this.rl = createInterface({ input: this.input, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Deliberately not silent: an unparseable line on this transport is a
        // caller mistake, and swallowing it looks like the sidecar hanging.
        this.send({ kind: 'reply', id: null, ok: false, error: { code: 'bad_envelope' }, text: 'line was not JSON' });
        return;
      }
      // Sequential rather than concurrent: replies then arrive in the order the
      // lines did, which is what anyone driving this by hand expects.
      this.queue = Promise.resolve(this.queue).then(() => this.handler?.(parsed));
    });
    this.rl.on('close', () => this.markClosed?.());
    return true;
  }

  /** @param {object} msg */
  send(msg) {
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  async stop() {
    this.rl?.close();
    this.rl = null;
    return true;
  }
}
