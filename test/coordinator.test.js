// The coordinator: registry, scheduler, and the whole loop end to end.
//
//   node --test test/
//
// The end-to-end tests run a real coordinator, a real sidecar over a real
// WebSocket, and a stub speaking agent-hub's HTTP API — so an intent travels
// the same path it will in production, minus tmux.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Coordinator } from '../src/fleet/coordinator/server.js';
import { HostRegistry, HEALTH_STALE_MS } from '../src/fleet/coordinator/registry.js';
import { place } from '../src/fleet/coordinator/scheduler.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { WebSocketTransport } from '../src/fleet/host/transports/websocket.js';
import { startStubHub, sessionRecord } from './helpers/stub-hub.js';

// --- the registry: `unknown` is a state, not a default ----------------------

/** @param {Partial<any>} patch */
const health = (patch = {}) => ({
  hostId: 'h',
  protocol: 1,
  labels: [],
  maxSessions: 5,
  running: 0,
  free: 5,
  resumable: [],
  sessions: [],
  loadavg: [0, 0, 0],
  loggedIn: true,
  hub: { reachable: true },
  ...patch,
});

test('a host that has never reported is unknown, with a reason', () => {
  let now = 1000;
  const reg = new HostRegistry({ now: () => now });
  reg.connect('box', () => {});

  assert.equal(reg.get('box')?.state, 'unknown');
  assert.match(reg.get('box')?.reason || '', /no health report/);
  assert.deepEqual(reg.schedulable(), [], 'never schedulable on no information');
});

test('a host goes unknown when its reports go stale, not stays healthy', () => {
  // The whole point of §3: silence must never read as health. A cache that
  // keeps serving its last good answer is how the two-plane design failed.
  let now = 1000;
  const reg = new HostRegistry({ now: () => now });
  reg.connect('box', () => {});
  reg.recordHealth('box', health());
  assert.equal(reg.get('box')?.state, 'healthy');

  now += HEALTH_STALE_MS + 1000;

  assert.equal(reg.get('box')?.state, 'unknown');
  assert.match(reg.get('box')?.reason || '', /last health report was \d+s ago/);
  assert.equal(reg.schedulable().length, 0);
});

test('a host whose session manager is unreachable is degraded, not healthy', () => {
  // Its socket is fine and it answers us — but it cannot start anything, and
  // reporting "healthy" because the sidecar replied is the benign-looking lie.
  const reg = new HostRegistry();
  reg.connect('box', () => {});
  reg.recordHealth('box', health({ hub: { reachable: false, reason: 'ECONNREFUSED' }, free: null }));

  assert.equal(reg.get('box')?.state, 'degraded');
  assert.match(reg.get('box')?.reason || '', /ECONNREFUSED/);
  assert.equal(reg.schedulable().length, 0);
});

test('a host that is not logged into Claude is degraded', () => {
  const reg = new HostRegistry();
  reg.connect('box', () => {});
  reg.recordHealth('box', health({ loggedIn: false }));
  assert.equal(reg.get('box')?.state, 'degraded');
});

test('a disconnected host is kept, marked offline, with its last known sessions', () => {
  // Deleting it would lose the only clue about where a resume would have to
  // land once it comes back.
  const reg = new HostRegistry();
  reg.connect('box', () => {});
  reg.recordHealth('box', health({ sessions: [{ name: 'bigjob', status: 'stopped', resumable: true }] }));
  reg.disconnect('box', 'socket closed: 1006');

  const entry = reg.get('box');
  assert.equal(entry?.state, 'offline');
  assert.match(entry?.reason || '', /1006/);
  assert.equal(reg.findSession('bigjob')?.host.hostId, 'box');
});

// --- the scheduler ----------------------------------------------------------

/** @param {Array<[string, any]>} hosts */
function registryWith(hosts) {
  const reg = new HostRegistry();
  for (const [id, h] of hosts) {
    reg.connect(id, () => {});
    reg.recordHealth(id, health({ hostId: id, ...h }));
  }
  return reg;
}

test('new work goes to the host with the most free capacity, not round robin', () => {
  // Round robin is the wrong default: hosts differ in capacity and sessions
  // differ wildly in weight.
  const reg = registryWith([
    ['small', { maxSessions: 2, running: 1, free: 1 }],
    ['big', { maxSessions: 10, running: 2, free: 8 }],
  ]);
  const p = place(reg, { verb: 'start', params: {} });
  assert.equal(p.kind, 'host');
  assert.equal(p.host?.hostId, 'big');
});

test('equal capacity is broken by load, then by round robin', () => {
  const reg = registryWith([
    ['a', { free: 5, loadavg: [2, 0, 0] }],
    ['b', { free: 5, loadavg: [0.1, 0, 0] }],
  ]);
  assert.equal(place(reg, { verb: 'start', params: {} }).host?.hostId, 'b', 'lower load wins');

  const tied = registryWith([
    ['a', { free: 5, loadavg: [1, 0, 0] }],
    ['b', { free: 5, loadavg: [1, 0, 0] }],
  ]);
  const picks = [
    place(tied, { verb: 'start', params: {} }).host?.hostId,
    place(tied, { verb: 'start', params: {} }).host?.hostId,
  ];
  assert.notEqual(picks[0], picks[1], 'a genuine tie must not always land on the same box');
});

test('labels filter before capacity ranks', () => {
  const reg = registryWith([
    ['plain', { free: 9, labels: [] }],
    ['gpubox', { free: 1, labels: ['gpu'] }],
  ]);
  const p = place(reg, { verb: 'start', params: { labels: ['gpu'] } });
  assert.equal(p.host?.hostId, 'gpubox', 'a constraint is not a preference');

  const none = place(reg, { verb: 'start', params: { labels: ['fpga'] } });
  assert.equal(none.kind, 'refused');
  assert.equal(none.code, 'no_host_matches');
});

test('a full fleet is refused with the numbers, not silently queued', () => {
  const reg = registryWith([['a', { maxSessions: 2, running: 2, free: 0 }]]);
  const p = place(reg, { verb: 'start', params: {} });
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'at_capacity');
  assert.match(p.reason || '', /a 2\/2/);
});

test('resume is pinned to the host holding the session', () => {
  // claude-<name> is a host-local volume. Round robin applies to placement of
  // NEW sessions only.
  const reg = registryWith([
    ['empty', { free: 9, sessions: [] }],
    ['holder', { free: 1, sessions: [{ name: 'bigjob', status: 'stopped', resumable: true }] }],
  ]);
  const p = place(reg, { verb: 'resume', params: { name: 'bigjob' } });
  assert.equal(p.host?.hostId, 'holder', 'must not go to the emptier box');
});

test('a resume for a session nobody reports is refused, never redirected', () => {
  // Redirecting would start an empty conversation under a name someone
  // believes is their long-running one.
  const reg = registryWith([['a', { free: 9, sessions: [] }]]);
  const p = place(reg, { verb: 'resume', params: { name: 'ghost' } });
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'unknown_session');
  assert.match(p.reason || '', /empty conversation/);
});

test('a session on an offline host is unreachable, not reassigned', () => {
  const reg = registryWith([['holder', { sessions: [{ name: 'bigjob', status: 'stopped', resumable: true }] }]]);
  reg.disconnect('holder', 'socket closed: 1006');
  const p = place(reg, { verb: 'resume', params: { name: 'bigjob' } });
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'host_unreachable');
  assert.match(p.reason || '', /holder/);
});

test('a placement claim too old to trust is refused rather than guessed', () => {
  let now = 1000;
  const reg = new HostRegistry({ now: () => now });
  reg.connect('holder', () => {});
  reg.recordHealth('holder', health({ sessions: [{ name: 'bigjob', status: 'stopped', resumable: true }] }));
  now += 10 * 60_000;

  const p = place(reg, { verb: 'resume', params: { name: 'bigjob' } }, { maxPinAgeMs: 120_000 });
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'stale_placement');
});

test('with no hosts at all the refusal says why, per host', () => {
  const reg = registryWith([['a', { hub: { reachable: false, reason: 'ECONNREFUSED' } }]]);
  const p = place(reg, { verb: 'start', params: {} });
  assert.equal(p.code, 'no_hosts');
  assert.match(p.reason || '', /a: degraded .*ECONNREFUSED/);
});

test('list fans out to every host', () => {
  const reg = registryWith([['a', {}], ['b', {}]]);
  const p = place(reg, { verb: 'list', params: {} });
  assert.equal(p.kind, 'fanout');
  assert.equal(p.hosts?.length, 2);
});

// --- end to end -------------------------------------------------------------

/**
 * A coordinator, a stub agent-hub, and a sidecar joined over a real WebSocket.
 * @param {import('node:test').TestContext} t
 * @param {object} [hubOpts]
 */
async function fleet(t, hubOpts = {}) {
  const stub = await startStubHub(hubOpts);
  const coordinator = new Coordinator({ healthIntervalMs: 500 });
  const port = await coordinator.listen(0, '127.0.0.1');

  const transport = new WebSocketTransport({
    origin: `http://127.0.0.1:${port}`,
    hostId: 'unabandoned',
  });
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: stub.baseUrl, readTimeoutMs: 2000 }),
    transport: /** @type {any} */ (transport),
    hostId: 'unabandoned',
    labels: ['debian13'],
  });
  await sidecar.start();

  t.after(async () => {
    await sidecar.stop();
    await coordinator.close();
    await stub.close();
  });

  // Wait for the host to be schedulable rather than sleeping a fixed amount.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !coordinator.registry.schedulable().length) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return { stub, coordinator, sidecar, port };
}

test('GET /api/hosts describes the host and never the socket carrying it', async (t) => {
  // A registry entry is serialised straight out of this endpoint. When the
  // live WsConnection was stored ON the entry, every reply carried the raw
  // socket, the http.Server and its connection table — a few kilobytes of
  // server internals per host, handed to anyone holding the API token, and one
  // circular reference away from a 500.
  const { port } = await fleet(t);

  const res = await fetch(`http://127.0.0.1:${port}/api/hosts`);
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.hosts.length, 1);
  assert.deepEqual(
    Object.keys(body.hosts[0]).sort(),
    ['connected', 'connectedAt', 'health', 'healthAt', 'hostId', 'reason', 'state'],
    'the entry is a description of the host, not a window onto the process serving it',
  );

  const serialised = JSON.stringify(body);
  for (const leak of ['_connectionKey', '_readableState', 'maxMessageBytes', 'httpAllowHalfOpen']) {
    assert.ok(!serialised.includes(leak), `/api/hosts leaked ${leak}`);
  }
});

test('an intent travels coordinator → websocket → sidecar → agent-hub and back', async (t) => {
  // The host must already report holding `bigjob`, because `stop` is pinned —
  // a fleet where no host claims the session refuses rather than picking one.
  const { coordinator, stub } = await fleet(t, {
    sessions: [sessionRecord('bigjob', { status: 'running' })],
    onCommand: (line) => ({ ok: true, text: `ran ${line}` }),
  });

  const reply = await coordinator.dispatch({ verb: 'stop', params: { name: 'bigjob' }, actor: 'telegram:1' });

  assert.equal(reply.ok, true);
  assert.equal(reply.text, 'ran /stop bigjob');
  assert.equal(reply.hostId, 'unabandoned');
  assert.deepEqual(stub.commands, ['/stop bigjob']);
});

test('the host reports health and becomes schedulable on its own', async (t) => {
  const { coordinator } = await fleet(t, {
    sessions: [sessionRecord('bigjob'), sessionRecord('live', { status: 'running' })],
  });

  const [host] = coordinator.registry.list();
  assert.equal(host.hostId, 'unabandoned');
  assert.equal(host.state, 'healthy');
  assert.equal(host.health?.maxSessions, 5);
  assert.deepEqual(host.health?.labels, ['debian13']);
  assert.deepEqual(
    host.health?.sessions?.map((s) => s.name).sort(),
    ['bigjob', 'live'],
  );
});

test('a verb the protocol does not have is refused at the coordinator', async (t) => {
  const { coordinator, stub } = await fleet(t);
  const reply = await coordinator.dispatch({ verb: 'login', params: {} });

  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'unknown_verb');
  assert.deepEqual(stub.commands, [], 'it must not reach the host, let alone agent-hub');
});

test('the HTTP API routes an intent and answers flat JSON', async (t) => {
  const { port, stub } = await fleet(t, { onCommand: () => ({ ok: true, text: 'started' }) });

  const res = await fetch(`http://127.0.0.1:${port}/api/intent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'start', params: { name: 'api' }, actor: 'app:phone' }),
  });
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.equal(body.text, 'started');
  assert.deepEqual(stub.commands, ['/new api']);
});

test('the Shortcut-friendly shorthand works with one round trip', async (t) => {
  // "Hey Siri, resume bigjob" becomes a Get Contents of URL against this.
  const { port, stub } = await fleet(t, {
    sessions: [sessionRecord('bigjob')],
    onCommand: (line) => ({ ok: true, text: `ran ${line}` }),
  });

  const res = await fetch(`http://127.0.0.1:${port}/api/resume/bigjob?choice=summary`);
  const body = await res.json();

  assert.equal(body.ok, true);
  assert.deepEqual(stub.commands, ['/resume bigjob summary']);
});

test('/healthz is the one unauthenticated surface and leaks nothing', async (t) => {
  const { port } = await fleet(t);
  const body = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json();
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'protocol']);
});

test('both coordinators answer /api/hosts in the same shape', async (t) => {
  // The Worker returns core.snapshot(); this one used to return its own
  // {ok, hosts}. A client cannot see "the same code runs in both places" —
  // the response shape is the only part of that claim it can check, and the
  // two disagreeing means every client carries both shapes.
  const { port } = await fleet(t);

  const body = await (await fetch(`http://127.0.0.1:${port}/api/hosts`)).json();
  assert.deepEqual(
    Object.keys(body).sort(),
    ['devices', 'events', 'hosts', 'ok', 'protocol'],
    'same keys the Worker sends',
  );
  assert.equal(body.protocol, 1);
  assert.equal(typeof body.devices, 'number');
  assert.ok(Array.isArray(body.events));
});

test('an API token is enforced when set', async (t) => {
  const stub = await startStubHub();
  const coordinator = new Coordinator({ apiToken: 'a-token-at-least-16ch' });
  const port = await coordinator.listen(0, '127.0.0.1');
  t.after(async () => {
    await coordinator.close();
    await stub.close();
  });

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/hosts`)).status, 401);
  const ok = await fetch(`http://127.0.0.1:${port}/api/hosts`, {
    headers: { authorization: 'Bearer a-token-at-least-16ch' },
  });
  assert.equal(ok.status, 200);
});

test('a host with the wrong token cannot connect at all', async (t) => {
  const coordinator = new Coordinator({ hostToken: 'right-token-16chars' });
  const port = await coordinator.listen(0, '127.0.0.1');
  t.after(() => coordinator.close());

  const transport = new WebSocketTransport({
    origin: `http://127.0.0.1:${port}`,
    hostId: 'imposter',
    token: 'wrong',
    maxBackoffMs: 50,
  });
  await transport.start();
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(coordinator.registry.list().length, 0, 'a refused host never enters the registry');
  await transport.stop();
});

test('a host that drops is marked offline and its work is refused, not misrouted', async (t) => {
  const { coordinator, sidecar } = await fleet(t, {
    sessions: [sessionRecord('bigjob')],
  });
  assert.equal(coordinator.registry.list()[0].state, 'healthy');

  await sidecar.stop();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && coordinator.registry.list()[0]?.connected) {
    await new Promise((r) => setTimeout(r, 25));
  }

  const entry = coordinator.registry.list()[0];
  assert.equal(entry.state, 'offline');
  const reply = await coordinator.dispatch({ verb: 'resume', params: { name: 'bigjob' } });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'host_unreachable');
});
