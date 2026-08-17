// The sidecar, end to end: a fake transport in front, a stub agent-hub behind.
//
//   node --test test/
//
// The stub speaks agent-hub's real HTTP API (test/helpers/stub-hub.js), so
// these exercise the actual path an intent takes — validate, translate, POST
// /api/command, repair the reply — rather than a mock of it. What is faked is
// the coordinator, which does not exist yet, and tmux, which agent-hub owns.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Sidecar, toCommandLine, REPLAY_TTL_MS } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { startStubHub, sessionRecord } from './helpers/stub-hub.js';

const RC_URL = 'https://claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M';
const RC_PANE = `/remote-control is active · Continue here, on your phone, or at\n${RC_URL}`;

/** A transport that hands messages in and collects what comes back out. */
function fakeTransport({ origin = 'https://coord.example.workers.dev' } = {}) {
  /** @type {object[]} */
  const sent = [];
  /** @type {((msg: unknown) => Promise<void>)|null} */
  let handler = null;
  let started = false;
  return {
    origin,
    sent,
    get started() {
      return started;
    },
    onMessage: (/** @type {any} */ h) => {
      handler = h;
    },
    send: (/** @type {object} */ msg) => {
      sent.push(msg);
    },
    start: async () => {
      started = true;
      return true;
    },
    stop: async () => {
      started = false;
      return true;
    },
    deliver: (/** @type {unknown} */ msg) => {
      if (!handler) throw new Error('nothing is listening');
      return handler(msg);
    },
  };
}

/** @param {import('node:test').TestContext} t @param {object} [hubOpts] @param {object} [sidecarOpts] */
async function setup(t, hubOpts = {}, sidecarOpts = {}) {
  const stub = await startStubHub(hubOpts);
  t.after(() => stub.close());
  const warnings = /** @type {string[]} */ ([]);
  const hub = new HubClient({ baseUrl: stub.baseUrl, token: hubOpts.token ?? null, readTimeoutMs: 2000 });
  const transport = fakeTransport(sidecarOpts);
  const sidecar = new Sidecar({
    hub,
    transport: /** @type {any} */ (transport),
    hostId: 'unabandoned',
    labels: ['gpu', 'debian13'],
    logger: {
      debug() {},
      info() {},
      warn: (/** @type {any[]} */ ...m) => warnings.push(m.join(' ')),
      error() {},
    },
    ...sidecarOpts,
  });
  return { stub, hub, transport, sidecar, warnings };
}

/** @param {object} patch */
const intent = (patch) => ({
  v: PROTOCOL_VERSION,
  kind: 'intent',
  id: 'idem-0000001',
  verb: 'list',
  params: {},
  issuedAt: Date.now(),
  ...patch,
});

// --- the allowlist ----------------------------------------------------------

test('login and code cannot be reached through the sidecar', async (t) => {
  // This matters more out-of-process than it did in: /api/command runs ANY
  // line it is handed, /login included, and the sidecar holds the hub's token.
  // The verb set is not defence in depth here — it is the defence.
  const { sidecar, stub } = await setup(t);

  for (const verb of ['login', 'code', 'auth', 'exec', 'shell']) {
    const r = await sidecar.handle(intent({ verb }));
    assert.equal(r.ok, false, `${verb} must be refused`);
    assert.equal(r.error.code, 'unknown_verb');
  }
  assert.deepEqual(stub.commands, [], 'nothing may have reached agent-hub');
});

test('a raw command string is not a shape the sidecar accepts', async (t) => {
  const { sidecar, stub } = await setup(t);

  for (const msg of [
    '/stop bigjob',
    { command: '/login' },
    { v: 1, kind: 'command', id: 'idem-0000001', line: '/login', issuedAt: Date.now() },
    intent({ verb: 'list', params: { command: '/login' } }),
  ]) {
    const r = await sidecar.handle(msg);
    assert.equal(r.ok, false, `${JSON.stringify(msg)} must be refused`);
  }
  assert.deepEqual(stub.commands, []);
});

test('a session name can never become a flag or a second command', async (t) => {
  const { sidecar, stub } = await setup(t);

  for (const name of ['--dangerous', '--safe', '-x', '--', 'bad;name', 'has space', '$(whoami)', '../escape']) {
    const r = await sidecar.handle(intent({ verb: 'start', params: { name } }));
    assert.equal(r.ok, false, `name ${JSON.stringify(name)} must be refused`);
  }
  assert.deepEqual(stub.commands, []);
});

// --- translation, against the real API --------------------------------------

test('each verb produces the command line agent-hub actually receives', async (t) => {
  const { sidecar, stub } = await setup(t, { sessions: [sessionRecord('bigjob')] });

  await sidecar.handle(intent({ id: 'idem-0000a', verb: 'list' }));
  await sidecar.handle(intent({ id: 'idem-0000b', verb: 'status' }));
  await sidecar.handle(intent({ id: 'idem-0000c', verb: 'status', params: { name: 'bigjob' } }));
  await sidecar.handle(intent({ id: 'idem-0000d', verb: 'start', params: { name: 'api', mode: 'safe' } }));
  await sidecar.handle(intent({ id: 'idem-0000e', verb: 'resume', params: { name: 'bigjob', choice: 'full' } }));
  await sidecar.handle(intent({ id: 'idem-0000f', verb: 'stop', params: { name: 'bigjob' } }));
  await sidecar.handle(intent({ id: 'idem-0000g', verb: 'forget', params: { name: 'bigjob' } }));

  assert.deepEqual(stub.commands, [
    '/list',
    '/status',
    '/status bigjob',
    '/new api --safe',
    '/resume bigjob full',
    '/stop bigjob',
    '/forget bigjob',
  ]);
});

test('the command-line mapping is pinned', () => {
  assert.equal(toCommandLine({ verb: 'start', params: {} }), '/new');
  assert.equal(toCommandLine({ verb: 'start', params: { mode: 'dangerous' } }), '/new --dangerous');
  assert.equal(toCommandLine({ verb: 'resume', params: { name: 'x' } }), '/resume x');
  assert.throws(() => toCommandLine({ verb: 'peek', params: { name: 'x' } }), /no command mapping/);
  assert.throws(() => toCommandLine({ verb: 'health', params: {} }), /no command mapping/);
});

test("a command agent-hub refuses is reported as refused, not as an error", async (t) => {
  const { sidecar } = await setup(t, { onCommand: () => ({ ok: false, text: 'No session named "ghost".' }) });
  const r = await sidecar.handle(intent({ verb: 'stop', params: { name: 'ghost' } }));

  assert.equal(r.ok, false);
  assert.match(r.text, /No session named/);
  assert.equal(r.error, undefined, 'a refusal is not a transport failure');
});

// --- repairing the Remote Control URL ---------------------------------------

test('a URL agent-hub never captured is recovered from the pane', async (t) => {
  // The width-70 case: agent-hub's unguarded matcher found nothing, so the
  // session reads as online and unreachable. This is the whole reason `peek`
  // is on the hub API.
  const { sidecar, warnings } = await setup(t, {
    sessions: [sessionRecord('live', { status: 'running', rcUrl: null })],
    panes: { live: RC_PANE },
    onCommand: () => ({ ok: true, text: 'ok', sessions: [sessionRecord('live', { status: 'running', rcUrl: null })] }),
  });

  const r = await sidecar.handle(intent({ verb: 'status', params: { name: 'live' } }));

  assert.equal(r.sessions[0].rcUrl, RC_URL);
  assert.equal(r.sessions[0].rcUrlRepaired, 'missing');
  assert.match(warnings.join('\n'), /repaired the Remote Control URL/);
});

test('a truncated URL is repaired and flagged as truncated', async (t) => {
  // The width-100 case, and the dangerous one: what agent-hub recorded is
  // well-formed, loads, and goes nowhere.
  const truncated = 'https://claude.ai/code/session_016zf';
  const { sidecar } = await setup(t, {
    panes: { live: RC_PANE },
    onCommand: () => ({
      ok: true,
      text: 'ok',
      sessions: [sessionRecord('live', { status: 'running', rcUrl: truncated })],
    }),
  });

  const r = await sidecar.handle(intent({ verb: 'status', params: { name: 'live' } }));

  assert.equal(r.sessions[0].rcUrl, RC_URL);
  assert.equal(r.sessions[0].rcUrlRepaired, 'truncated');
});

test('a single-session reply hoists the URL to the top level', async (t) => {
  // §7: flat JSON, one round trip per action, because the consumer is a
  // Shortcut as often as it is an app.
  const { sidecar } = await setup(t, {
    panes: { api: RC_PANE },
    onCommand: () => ({ ok: true, text: 'Started "api".', sessions: [sessionRecord('api', { status: 'running' })] }),
  });

  const r = await sidecar.handle(intent({ verb: 'start', params: { name: 'api' } }));

  assert.equal(r.rcUrl, RC_URL);
});

test('a correct recorded URL is left alone and not flagged', async (t) => {
  const { sidecar, warnings } = await setup(t, {
    panes: { live: RC_PANE },
    onCommand: () => ({
      ok: true,
      text: 'ok',
      sessions: [sessionRecord('live', { status: 'running', rcUrl: RC_URL })],
    }),
  });

  const r = await sidecar.handle(intent({ verb: 'list' }));

  assert.equal(r.sessions[0].rcUrl, RC_URL);
  assert.equal(r.sessions[0].rcUrlRepaired, undefined);
  assert.ok(!warnings.join('\n').includes('repaired'));
});

test('a stopped session is not peeked at all', async (t) => {
  // Its pane does not exist; asking would be a guaranteed 404 per session.
  const { sidecar } = await setup(t, {
    panes: {},
    onCommand: () => ({ ok: true, text: 'ok', sessions: [sessionRecord('bigjob', { status: 'stopped' })] }),
  });

  const r = await sidecar.handle(intent({ verb: 'list' }));

  assert.equal(r.sessions[0].rcUrl, null, 'the record had none and there is no pane to read');
  assert.equal(r.sessions[0].rcUrlRepaired, undefined);
});

test('a pane that cannot be read does not fail the command that asked', async (t) => {
  // The session list is still the answer even if one pane is unreadable.
  const { sidecar } = await setup(t, {
    panes: {}, // every peek 404s
    onCommand: () => ({
      ok: true,
      text: 'ok',
      sessions: [sessionRecord('live', { status: 'running', rcUrl: RC_URL })],
    }),
  });

  const r = await sidecar.handle(intent({ verb: 'list' }));

  assert.equal(r.ok, true);
  assert.equal(r.sessions[0].rcUrl, RC_URL, 'falls back to what agent-hub recorded');
});

test('several running sessions are all enriched', async (t) => {
  const names = ['a', 'b', 'c', 'd', 'e'];
  const { sidecar } = await setup(t, {
    panes: Object.fromEntries(names.map((n) => [n, `banner\nhttps://claude.ai/code/session_${n}${'0'.repeat(20)}`])),
    onCommand: () => ({
      ok: true,
      text: 'ok',
      sessions: names.map((n) => sessionRecord(n, { status: 'running', rcUrl: null })),
    }),
  });

  const r = await sidecar.handle(intent({ verb: 'list' }));

  assert.equal(r.sessions.length, 5);
  for (const s of r.sessions) {
    assert.equal(s.rcUrl, `https://claude.ai/code/session_${s.name}${'0'.repeat(20)}`);
  }
});

// --- peek -------------------------------------------------------------------

test('peek returns the pane, the URL and whether Remote Control is up', async (t) => {
  const { sidecar } = await setup(t, { panes: { live: RC_PANE } });
  const r = await sidecar.handle(intent({ verb: 'peek', params: { name: 'live' } }));

  assert.equal(r.ok, true);
  assert.match(r.text, /remote-control is active/);
  assert.equal(r.rcUrl, RC_URL);
  assert.equal(r.remoteControl, true);
});

test('peek of a session that is not running is a clean failure', async (t) => {
  const { sidecar } = await setup(t, { panes: {} });
  const r = await sidecar.handle(intent({ verb: 'peek', params: { name: 'ghost' } }));

  assert.equal(r.ok, false);
  assert.match(r.text, /not running/);
});

test('peek does not go through the command registry', async (t) => {
  const { sidecar, stub } = await setup(t, { panes: { live: 'pane' } });
  await sidecar.handle(intent({ verb: 'peek', params: { name: 'live' } }));
  assert.deepEqual(stub.commands, []);
});

// --- health -----------------------------------------------------------------

test('health reports what the scheduler ranks on', async (t) => {
  const { sidecar } = await setup(t, {
    sessions: [sessionRecord('live', { status: 'running' }), sessionRecord('bigjob')],
    maxSessions: 5,
  });

  const r = await sidecar.handle(intent({ verb: 'health' }));
  const h = r.health;

  assert.equal(r.ok, true);
  assert.equal(h.hostId, 'unabandoned');
  assert.equal(h.hub.reachable, true);
  assert.equal(h.maxSessions, 5);
  assert.equal(h.running, 1);
  assert.equal(h.free, 4);
  assert.deepEqual(h.labels, ['gpu', 'debian13']);
  assert.equal(h.loggedIn, true);
  assert.equal(h.loadavg.length, 3);
});

test('health names the sessions this host can resume', async (t) => {
  // Resume is pinned: claude-<name> is a host-local volume, so a /resume must
  // land on the box holding it rather than being round-robined.
  const { sidecar } = await setup(t, {
    sessions: [
      sessionRecord('live', { status: 'running' }),
      sessionRecord('bigjob'),
      sessionRecord('never-started', { uuid: null }),
    ],
  });

  const r = await sidecar.handle(intent({ verb: 'health' }));

  assert.deepEqual(r.health.resumable, ['bigjob'], 'a session with no uuid is not resumable');
});

test('an unreachable hub reports capacity as null, never zero', async (t) => {
  // §3: `unknown` is a state with a reason, never a default that reads as
  // benign. A scheduler seeing 0 free slots skips this host quietly; one
  // seeing null can say why.
  const stub = await startStubHub();
  const baseUrl = stub.baseUrl;
  await stub.close();

  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl, readTimeoutMs: 500 }),
    transport: /** @type {any} */ (fakeTransport()),
    hostId: 'unabandoned',
  });

  const r = await sidecar.handle(intent({ verb: 'health' }));
  const h = r.health;

  assert.equal(r.ok, true, 'the sidecar is alive even when the hub is not');
  assert.equal(h.hub.reachable, false);
  assert.ok(h.hub.reason, 'an unknown state must carry a reason');
  assert.equal(h.free, null);
  assert.equal(h.running, null);
  assert.equal(h.maxSessions, null);
  assert.notEqual(h.free, 0);
});

test('an unreachable hub is a retryable failure code on ordinary verbs', async (t) => {
  const stub = await startStubHub();
  const baseUrl = stub.baseUrl;
  await stub.close();

  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl, commandTimeoutMs: 500, readTimeoutMs: 500 }),
    transport: /** @type {any} */ (fakeTransport()),
  });

  const r = await sidecar.handle(intent({ verb: 'stop', params: { name: 'bigjob' } }));

  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'hub_unreachable');
  assert.match(r.text, /not answering/);
});

test('a rejected hub token is reported distinctly from an unreachable hub', async (t) => {
  const stub = await startStubHub({ token: 'the-real-token-16ch' });
  t.after(() => stub.close());
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, token: 'wrong' }),
    transport: /** @type {any} */ (fakeTransport()),
  });

  const r = await sidecar.handle(intent({ verb: 'list' }));

  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'hub_unauthorised');
});

// --- idempotency ------------------------------------------------------------

test('a replayed mutating intent is answered from cache, not run twice', async (t) => {
  const { sidecar, stub } = await setup(t);
  const msg = intent({ id: 'idem-start-99', verb: 'start', params: { name: 'api' } });

  const first = await sidecar.handle(msg);
  const second = await sidecar.handle(msg);

  assert.deepEqual(stub.commands, ['/new api'], 'agent-hub must see it exactly once');
  assert.equal(first.text, second.text);
  assert.equal(second.replayed, true);
  assert.ok(!first.replayed);
});

test('a retry landing while the first attempt is in flight waits for it', async (t) => {
  // Which is exactly when a retry lands. Caching the promise rather than the
  // result is what makes this hold.
  let release = () => {};
  const gate = new Promise((r) => (release = () => r(null)));
  const stub = await startStubHub();
  t.after(() => stub.close());

  const hub = new HubClient({ baseUrl: stub.baseUrl });
  const realCommand = hub.command.bind(hub);
  hub.command = async (/** @type {string} */ line) => {
    await gate;
    return realCommand(line);
  };
  const sidecar = new Sidecar({ hub, transport: /** @type {any} */ (fakeTransport()) });

  const msg = intent({ id: 'idem-race-001', verb: 'start', params: { name: 'api' } });
  const both = Promise.all([sidecar.handle(msg), sidecar.handle(msg)]);
  release();
  const [a, b] = await both;

  assert.deepEqual(stub.commands, ['/new api']);
  assert.equal(a.text, b.text);
});

test('read-only verbs are not cached — a repeated /list is a fresh read', async (t) => {
  const { sidecar, stub } = await setup(t);
  const msg = intent({ id: 'idem-list-001', verb: 'list' });

  await sidecar.handle(msg);
  const second = await sidecar.handle(msg);

  assert.deepEqual(stub.commands, ['/list', '/list'], 'a stale session list is worse than a re-read');
  assert.ok(!second.replayed);
});

test('different ids for the same action both run', async (t) => {
  const { sidecar, stub } = await setup(t);
  await sidecar.handle(intent({ id: 'idem-stop-a01', verb: 'stop', params: { name: 'bigjob' } }));
  await sidecar.handle(intent({ id: 'idem-stop-b02', verb: 'stop', params: { name: 'bigjob' } }));
  assert.equal(stub.commands.length, 2);
});

test('the freshness window must be shorter than the replay cache remembers', async (t) => {
  // Otherwise there is a band — older than the cache, younger than the skew
  // limit — where a replayed `start` passes the freshness check against a cache
  // that has already forgotten it, and runs a second time. That is the exact
  // failure the idempotency key exists to prevent, reintroduced by two
  // constants drifting apart.
  const stub = await startStubHub();
  t.after(() => stub.close());
  const hub = new HubClient({ baseUrl: stub.baseUrl });

  assert.throws(
    () => new Sidecar({ hub, transport: /** @type {any} */ (fakeTransport()), maxSkewMs: REPLAY_TTL_MS }),
    /must be less than the replay cache TTL/,
  );
  assert.throws(
    () => new Sidecar({ hub, transport: /** @type {any} */ (fakeTransport()), maxSkewMs: REPLAY_TTL_MS + 1 }),
    /must be less than the replay cache TTL/,
  );
});

test('an intent older than the freshness window is refused', async (t) => {
  const { sidecar, stub } = await setup(t, {}, { maxSkewMs: 30_000 });

  const r = await sidecar.handle(intent({ verb: 'stop', params: { name: 'bigjob' }, issuedAt: Date.now() - 120_000 }));

  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'stale');
  assert.deepEqual(stub.commands, []);
});

// --- transport contract -----------------------------------------------------

test('the sidecar refuses to start without a pinned coordinator origin', async (t) => {
  const { sidecar } = await setup(t, {}, { origin: '' });
  await assert.rejects(() => sidecar.start(), /pinned coordinator origin/);
});

test('a message delivered by the transport is answered on the transport', async (t) => {
  const { sidecar, transport } = await setup(t);
  await sidecar.start();
  assert.equal(transport.started, true);

  await transport.deliver(intent({ id: 'idem-list-002', verb: 'list' }));

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].id, 'idem-list-002');
  assert.equal(transport.sent[0].kind, 'reply');
  assert.equal(transport.sent[0].ok, true);

  await sidecar.stop();
  assert.equal(transport.started, false);
});

test('a refused intent still gets a reply, correlated by id', async (t) => {
  // A coordinator that gets no answer cannot tell a refused intent from a dead
  // host, and "dead host" is the one it will retry.
  const { sidecar, transport } = await setup(t);
  await sidecar.start();

  await transport.deliver(intent({ id: 'idem-bad-0001', verb: 'exec' }));

  assert.equal(transport.sent[0].id, 'idem-bad-0001');
  assert.equal(transport.sent[0].ok, false);
  assert.equal(transport.sent[0].error.code, 'unknown_verb');
});

test('an envelope too broken to correlate is answered with a null id', async (t) => {
  const { sidecar } = await setup(t);
  const r = await sidecar.handle({ v: PROTOCOL_VERSION, kind: 'intent', id: 'x', verb: 'list', issuedAt: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.id, null);
});

test('stopping the sidecar leaves agent-hub and its sessions alone', async (t) => {
  const { sidecar, stub } = await setup(t);
  await sidecar.start();
  await sidecar.stop();
  assert.deepEqual(stub.commands, [], 'no /stop is issued on shutdown');
});
