// The two Cloudflare globals this Worker names in JSDoc.
//
// Deliberately not @cloudflare/workers-types: that package is large, changes on
// its own schedule, and would replace two names with a full ambient environment
// this repository has managed without. What is needed here is only enough for
// `tsc` to stop reporting them as undefined, so that TS2304 means what it
// should — an identifier that does not exist anywhere, which is always a bug.
//
// See tsconfig.names.json. `splitList` was called in the enrolment route and
// defined nowhere; it type-checked clean because worker/src was outside the
// project entirely, and it would have thrown in the production coordinator on a
// route no test reaches.

declare class DurableObjectState {
  storage: {
    get(key: string): Promise<unknown>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
    list(options?: unknown): Promise<Map<string, unknown>>;
  };
  waitUntil(promise: Promise<unknown>): void;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

declare class DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
