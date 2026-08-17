// The client for a stock agent-hub, against a stub that speaks its exact API.
//
//   node --test test/
//
// These run over real loopback HTTP rather than a mocked fetch, because the
// things worth checking here are HTTP-shaped: which status codes are ordinary
// answers, which are failures, and whether a failure is one the coordinator
// should retry.

import test from 'node:test';
import assert from 'node:assert/strict';

import { HubClient, HubError } from '../src/host/hub-client.js';
import { startStubHub, sessionRecord } from './helpers/stub-hub.js';

/** @param {import('node:test').TestContext} t @param {object} [opts] */
async function hubFor(t, opts = {}) {
  const stub = await startStubHub(opts);
  t.after(() => stub.close());
  return { stub, client: new HubClient({ baseUrl: stub.baseUrl, token: opts.token ?? null, readTimeoutMs: 2000 }) };
}

// --- the four routes --------------------------------------------------------

test('a command line reaches /api/command and its reply comes back', async (t) => {
  const { stub, client } = await hubFor(t, {
    onCommand: (line) => ({ ok: true, text: `did ${line}`, sessions: [sessionRecord('bigjob')] }),
  });

  const r = await client.command('/stop bigjob');

  assert.deepEqual(stub.commands, ['/stop bigjob']);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'did /stop bigjob');
  assert.equal(r.sessions?.[0].name, 'bigjob');
});

test('a command the hub refuses is a reply, not an error', async (t) => {
  // agent-hub answers 200 with ok:false in the body. Treating that as a
  // transport failure would make the coordinator retry a command that was
  // correctly rejected.
  const { client } = await hubFor(t, { onCommand: () => ({ ok: false, text: 'No session named "ghost".' }) });

  const r = await client.command('/stop ghost');

  assert.equal(r.ok, false);
  assert.match(r.text, /No session named/);
});

test('state carries the cap, the sessions and the auth summary', async (t) => {
  const { client } = await hubFor(t, {
    sessions: [sessionRecord('live', { status: 'running' }), sessionRecord('bigjob')],
    maxSessions: 5,
  });

  const s = await client.state();

  assert.equal(s.maxSessions, 5);
  assert.equal(s.running, 1);
  assert.equal(s.sessions.length, 2);
  assert.equal(s.auth.loggedIn, true);
});

test('peek returns the pane text', async (t) => {
  const { client } = await hubFor(t, { panes: { live: 'line one\nline two' } });
  assert.equal(await client.peek('live'), 'line one\nline two');
});

test('peek of a session that is not running is null, not a failure', async (t) => {
  // agent-hub answers 404 for this, which is an ordinary outcome rather than a
  // transport problem.
  const { client } = await hubFor(t, { panes: {} });
  assert.equal(await client.peek('ghost'), null);
});

test('peek can only narrow, because the hub serves a fixed 60 lines', async (t) => {
  // There is no `lines` parameter on agent-hub's wire — sessions.peek(name, 60)
  // is hardcoded. Trimming client-side rather than pretending otherwise keeps
  // the limitation visible.
  const pane = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const { client } = await hubFor(t, { panes: { live: pane } });

  const all = await client.peek('live');
  assert.equal(all?.split('\n').length, 60, 'the hub caps this at 60 whatever we ask for');

  const narrowed = await client.peek('live', 10);
  assert.equal(narrowed?.split('\n').length, 10);
  assert.equal(narrowed?.split('\n')[9], 'line 199');

  const overAsk = await client.peek('live', 500);
  assert.equal(overAsk?.split('\n').length, 60, 'asking for more than the hub sends does not invent lines');
});

test('a session name with characters needing escaping is encoded in the query', async (t) => {
  // Names are charset-validated upstream, but the client must not be the reason
  // that holds — it is a URL, so it encodes.
  const { client } = await hubFor(t, { panes: { 'a b&c': 'pane' } });
  assert.equal(await client.peek('a b&c'), 'pane');
});

// --- the hook forwarding path ----------------------------------------------

test('a hook report is forwarded to the loopback endpoint with its name', async (t) => {
  // This is what lets the per-session hook socket work against a stock
  // agent-hub: the sidecar knows which session a report came from, and supplies
  // the name the container was never given.
  const { stub, client } = await hubFor(t);

  const r = await client.recordSessionStart({
    name: 'bigjob',
    cwd: '/work',
    uuid: 'a1b2c3d4-1111-2222-3333-444455556666',
  });

  assert.equal(r.ok, true);
  assert.deepEqual(stub.hookReports, [
    { name: 'bigjob', cwd: '/work', uuid: 'a1b2c3d4-1111-2222-3333-444455556666' },
  ]);
});

test('a hook report the hub rejects comes back as ok:false, not as a throw', async (t) => {
  const { client } = await hubFor(t);
  const r = await client.recordSessionStart({ name: 'bigjob', uuid: 'not-a-uuid' });
  assert.equal(r.ok, false);
  assert.match(String(r.message), /uuid/i);
});

test('the hook endpoint is reached without the operator token', async (t) => {
  // It is deliberately not token-gated on agent-hub's side; sending the token
  // anyway is harmless, but the path must work when there is none to send.
  const stub = await startStubHub({ token: 'a-token-at-least-16-chars' });
  t.after(() => stub.close());
  const client = new HubClient({ baseUrl: stub.baseUrl, token: null });

  const r = await client.recordSessionStart({ name: 'x', uuid: 'a1b2c3d4-1111-2222-3333-444455556666' });
  assert.equal(r.ok, true);
});

// --- auth -------------------------------------------------------------------

test('the token is sent as a bearer header', async (t) => {
  const { client } = await hubFor(t, { token: 'a-token-at-least-16-chars' });
  const r = await client.command('/list');
  assert.equal(r.ok, true);
});

test('a wrong token is a distinct, non-retryable failure', async (t) => {
  const stub = await startStubHub({ token: 'the-real-token-16ch' });
  t.after(() => stub.close());
  const client = new HubClient({ baseUrl: stub.baseUrl, token: 'wrong' });

  await assert.rejects(
    () => client.command('/list'),
    (/** @type {HubError} */ e) => e.code === 'hub_unauthorised' && e.status === 401,
  );
});

// --- failures the coordinator has to tell apart -----------------------------

test('an unreachable hub is hub_unreachable, which is the retryable one', async (t) => {
  const stub = await startStubHub();
  const baseUrl = stub.baseUrl;
  await stub.close();
  const client = new HubClient({ baseUrl, readTimeoutMs: 1000 });

  await assert.rejects(
    () => client.state(),
    (/** @type {HubError} */ e) => e instanceof HubError && e.code === 'hub_unreachable',
  );
});

test('alive() is a boolean, never a throw', async (t) => {
  const { client } = await hubFor(t);
  assert.equal(await client.alive(), true);

  const dead = new HubClient({ baseUrl: 'http://127.0.0.1:1', readTimeoutMs: 500 });
  assert.equal(await dead.alive(), false);
});

test('something that is not agent-hub on that port is an error, not a silent success', async (t) => {
  // A tunnel login page, or a different service entirely. Parsing HTML as an
  // empty reply would make the sidecar report a healthy hub with no sessions.
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>sign in</html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => new Promise((r) => server.close(() => r(null))));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  const client = new HubClient({ baseUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(
    () => client.state(),
    (/** @type {HubError} */ e) => e.code === 'hub_error' && /not JSON/.test(e.message),
  );
});

test('a JSON array where an object was expected is refused', async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('[1,2,3]');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => new Promise((r) => server.close(() => r(null))));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  const client = new HubClient({ baseUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(() => client.state(), (/** @type {HubError} */ e) => e.code === 'hub_error');
});

test('a trailing slash on the base URL does not produce a double slash', async (t) => {
  const stub = await startStubHub();
  t.after(() => stub.close());
  const client = new HubClient({ baseUrl: `${stub.baseUrl}/` });
  assert.equal(await client.alive(), true);
});
