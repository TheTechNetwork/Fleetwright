// The coordinator: registry, scheduler, and the whole loop end to end.
//
//   node --test test/
//
// The end-to-end tests run a real coordinator, a real sidecar over a real
// WebSocket, and a stub speaking agent-hub's HTTP API — so an intent travels
// the same path it will in production, minus tmux.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

import { Coordinator } from '../src/fleet/coordinator/server.js';
import { HostRegistry, HEALTH_STALE_MS } from '../src/fleet/coordinator/registry.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { place } from '../src/fleet/coordinator/scheduler.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { WebSocketTransport } from '../src/fleet/host/transports/websocket.js';
import { generateKeyPair, sign, signingInput } from '../src/fleet/crypto.js';
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
  claudeAccounts: 1,
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

test('a box with no Claude account of its own is NOT degraded for it', () => {
  // THIS ASSERTED THE OPPOSITE UNTIL docs/one-account-per-person.md. A machine
  // has no Claude account now, so `loggedIn: false` is the ordinary state of
  // every host — and this rule made every host permanently degraded,
  // permanently unschedulable, and re-announced on every coordinator deploy. A
  // stale rule producing a stream of notifications about a fault that no longer
  // exists.
  const reg = new HostRegistry();
  reg.connect('box', () => {});
  reg.recordHealth('box', health({ loggedIn: false, claudeAccounts: 2 }));
  assert.equal(reg.get('box')?.state, 'healthy');
});

test('a box nobody has linked an account on is degraded, because nothing can start', () => {
  // The question that replaced it. Zero is a real fault with a real remedy;
  // WHOSE account is missing is a per-session question, answered by name at the
  // point somebody asks.
  const reg = new HostRegistry();
  reg.connect('box', () => {});
  reg.recordHealth('box', health({ claudeAccounts: 0 }));

  assert.equal(reg.get('box')?.state, 'degraded');
  assert.match(reg.get('box')?.reason || '', /nobody has linked/);
  assert.equal(reg.schedulable().length, 0);
});

test('an older host that does not report accounts is not faulted for it', () => {
  // Absent is cannot-tell, never a fault — the same rule the credential field
  // follows, and the one this codebase keeps having to restate.
  const reg = new HostRegistry();
  reg.connect('box', () => {});
  reg.recordHealth('box', health({ claudeAccounts: null }));
  assert.equal(reg.get('box')?.state, 'healthy');
});

test('a host whose sessions would get a dead credential is degraded, though it is logged in', () => {
  // A SECOND WAY TO BE UNUSABLE, and the one that was invisible. `loggedIn`
  // reports on the box's own home directory; a sandboxed session runs on a
  // copy of a file. A box can be logged in and hand every new session a token
  // that expired hours ago — which is what "deb13-staging wouldn't work until
  // I clicked sign in again" was — and the scheduler kept sending it work
  // because the only question being asked was answered "yes".
  const reg = new HostRegistry();
  reg.connect('box', () => {});
  reg.recordHealth('box', health({
    loggedIn: true,
    credential: { state: 'expired', refreshable: false, expiresAt: 1, account: null, plan: null, summary: '' },
  }));

  assert.equal(reg.get('box')?.state, 'degraded');
  assert.match(reg.get('box')?.reason || '', /credential/);
  assert.equal(reg.schedulable().length, 0);
});

test('an expired credential that can renew itself does not degrade the host', () => {
  // The ordinary state of a box nobody has touched for an hour: the CLI inside
  // the session renews it on the way up. Degrading on this would take the
  // whole fleet offline every night, and a warning that fires on the ordinary
  // case is one people stop reading.
  const reg = new HostRegistry();
  reg.connect('box', () => {});
  reg.recordHealth('box', health({
    credential: { state: 'expired', refreshable: true, expiresAt: 1, account: null, plan: null, summary: '' },
  }));

  assert.equal(reg.get('box')?.state, 'healthy');
});

test('a host that does not report a credential at all stays healthy', () => {
  // Every host running one release back, and every non-sandboxed one. Absent
  // is cannot-tell, never a fault — a fleet that flags older hosts as broken
  // teaches people to ignore the flag.
  const reg = new HostRegistry();
  reg.connect('box', () => {});
  reg.recordHealth('box', health({ credential: null }));

  assert.equal(reg.get('box')?.state, 'healthy');
  assert.equal(reg.schedulable().length, 1);
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
 * Enrol a fresh key the way a real box does — mint a pin, spend it over HTTP —
 * and hand back the proof function the transport calls on every dial.
 *
 * Going through the actual endpoint rather than poking core.hostIds keeps the
 * enrolment path itself under test in every end-to-end case.
 *
 * @param {import('../src/fleet/coordinator/server.js').Coordinator} coordinator
 * @param {number} port
 * @param {string} hostId
 */
async function enrolledProof(coordinator, port, hostId) {
  const keys = await generateKeyPair();
  const { code } = coordinator.core.enrollment.mint({ purpose: 'host' });
  const res = await fetch(`http://127.0.0.1:${port}/api/enroll/host`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, hostId, publicJwk: keys.publicJwk }),
  });
  assert.equal(res.status, 200, 'enrolment succeeded');

  return async () => {
    const chal = await fetch(`http://127.0.0.1:${port}/api/host/challenge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostId }),
    });
    const { nonce } = await chal.json();
    return { nonce, proof: await sign(keys.privateJwk, signingInput('host-connect', { hostId, nonce })) };
  };
}

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
    proof: await enrolledProof(coordinator, port, 'unabandoned'),
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
    // `ephemeral` and `owner` are descriptions of the host — is it expected to
    // vanish, and whose runner is it — so they belong here. The pin exists to
    // catch the OTHER kind of addition: a socket, a server, a process handle.
    ['connected', 'connectedAt', 'ephemeral', 'health', 'healthAt', 'hostId', 'owner', 'reason', 'state'],
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
  // From the constant, not a literal. A hardcoded 1 here means the day the
  // protocol is bumped this test fails for a reason that has nothing to do
  // with what it is checking — that BOTH coordinators say the same thing.
  assert.equal(body.protocol, PROTOCOL_VERSION);
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

test('a host that was never enrolled cannot connect at all', async (t) => {
  const coordinator = new Coordinator();
  const port = await coordinator.listen(0, '127.0.0.1');
  t.after(() => coordinator.close());

  // A well-formed proof from a key the coordinator has never seen. This is the
  // interesting impostor: not a missing header, a real signature over a real
  // nonce, made by the wrong key.
  const keys = await generateKeyPair();
  const transport = new WebSocketTransport({
    origin: `http://127.0.0.1:${port}`,
    hostId: 'imposter',
    proof: async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/host/challenge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostId: 'imposter' }),
      });
      const { nonce } = await res.json();
      return { nonce, proof: await sign(keys.privateJwk, signingInput('host-connect', { hostId: 'imposter', nonce })) };
    },
    maxBackoffMs: 50,
  });
  t.after(() => transport.stop());
  await transport.start();
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(coordinator.registry.list().length, 0, 'a refused host never enters the registry');
});

test('a revoked host is disconnected and stays out', async (t) => {
  const coordinator = new Coordinator({ apiToken: 'a-token-at-least-16ch' });
  const port = await coordinator.listen(0, '127.0.0.1');
  t.after(() => coordinator.close());

  const transport = new WebSocketTransport({
    origin: `http://127.0.0.1:${port}`,
    hostId: 'condemned',
    proof: await enrolledProof(coordinator, port, 'condemned'),
    maxBackoffMs: 50,
  });
  t.after(() => transport.stop());
  await transport.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(coordinator.registry.list().length, 1, 'enrolled host connected');

  const res = await fetch(`http://127.0.0.1:${port}/api/hosts/condemned`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer a-token-at-least-16ch' },
  });
  assert.equal(res.status, 200);

  // It will retry — that is what the transport does — and every retry must be
  // refused. A revocation that only holds until the host reconnects is not one.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(coordinator.registry.hosts.get('condemned')?.connected, false);
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

test('losing the coordinator makes the sidecar reconnect, not exit', async (t) => {
  // Every timer in the transport was unref'd. While a retry is pending it is
  // the ONLY thing holding the event loop open — the socket is gone, that is
  // why we are retrying — so node decided there was nothing left to do and
  // exited. Under systemd that reads as a restart loop with no reason in it;
  // run by hand, the process simply vanishes.
  const transport = new WebSocketTransport({
    origin: 'http://127.0.0.1:9',
    hostId: 'persistent',
    maxBackoffMs: 100,
    proof: async () => ({ nonce: 'n', proof: 'p' }),
  });
  await transport.start();
  t.after(() => transport.stop());

  // If the loop were empty this would never resolve, because node would be
  // gone. Asserting on a real wait rather than on the flag is the point.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(transport.retryTimer, 'a retry is pending and holding the process up');
});

test('a box that is degraded is still asked what it has', async (t) => {
  // `list` fanned out over schedulable(), which requires state === 'healthy'.
  // So a degraded box — agent-hub answering, sessions running — dropped out of
  // the answer entirely. Not greyed out, not flagged: absent. The phone showed
  // a shorter list and said nothing, and the sessions it hid were the ones on
  // the box that needed attention.
  //
  // Degraded via `claudeAccounts: 0` now. It used to be a logged-out box, which
  // stopped being a fault when the machine stopped having an account.
  //
  // Asserted on which HOSTS were reached rather than on the sessions returned,
  // because the stub hub answers /list without a session payload — the property
  // under test is that the box is still asked, not what it says back.
  const { coordinator, stub } = await fleet(t, { sessions: [sessionRecord('inherited')] });
  await new Promise((r) => setTimeout(r, 600));

  stub.setClaudeAccounts(0);
  await new Promise((r) => setTimeout(r, 1200));

  const host = coordinator.registry.hosts.get('unabandoned');
  assert.notEqual(host?.state, 'healthy', 'the box is degraded, which is the whole point');
  assert.equal(host?.connected, true, 'and still on the end of a socket');

  const reply = await coordinator.dispatch({ verb: 'list' });
  assert.equal(reply.ok, true, 'not refused as no_hosts');
  assert.ok(
    (reply.hosts || []).some((h) => h.hostId === 'unabandoned'),
    'the degraded box is still asked, because a read is not a placement',
  );
});

test('a degraded host is still refused new work', async (t) => {
  // The other half, and the reason the two selectors exist separately: placing
  // a session on a box nobody can start a session on is placing it nowhere.
  const { coordinator, stub } = await fleet(t);
  await new Promise((r) => setTimeout(r, 600));
  stub.setClaudeAccounts(0);
  await new Promise((r) => setTimeout(r, 1200));

  const reply = await coordinator.dispatch({ verb: 'start', params: { name: 'nope' } });
  assert.equal(reply.ok, false);
  assert.match(String(reply.text || reply.error?.code), /no_hosts|linked|degraded/i);
});

test('a host that goes degraded says so once, not every fifteen seconds', async () => {
  // deb132's shared credential expired on a Saturday afternoon. agent-hub
  // warned hourly for THIRTY HOURS, the coordinator marked the host degraded,
  // the app showed it three storeys down in Settings — and nobody was told.
  // docs/psychology.md §7 is exactly this: silence has to be trustworthy before
  // it is comfortable, and a warning that reaches a log file is silence.
  //
  // The transition is the event. A host reports health every fifteen seconds,
  // so a box degraded since yesterday must produce one notification and not
  // five thousand — the same discipline the session watcher uses.
  const reg = new HostRegistry();
  reg.connect('box', () => {});

  // A fresh host starts `unknown`, so its first healthy report IS a transition
  // and the registry says so. Whether it is worth a notification is the
  // coordinator's judgement, not the registry's bookkeeping — see
  // #onHostState, which drops unknown→healthy precisely because every connect
  // and every deploy would otherwise ring a phone to say a box is fine.
  assert.equal(reg.recordHealth('box', health())?.from, 'unknown');
  assert.equal(reg.recordHealth('box', health()), null, 'a repeat of the same state is not news');
  const down = reg.recordHealth('box', health({ claudeAccounts: 0 }));
  assert.equal(down?.to, 'degraded');
  assert.match(String(down?.reason), /nobody has linked/);

  assert.equal(reg.recordHealth('box', health({ claudeAccounts: 0 })), null, 'still degraded is not a new event');
  assert.equal(reg.recordHealth('box', health({ claudeAccounts: 0 })), null);

  // RECOVERY IS NEWS TOO. Somebody told a box is broken and never told it came
  // back checks manually forever after, which relocates the anxiety rather than
  // removing it.
  const up = reg.recordHealth('box', health());
  assert.equal(up?.to, 'healthy');
});

test('a host whose reason changes has changed, even staying degraded', () => {
  // "not logged in" and "the credential a session would get has expired" are
  // both `degraded` and are different problems with different remedies.
  const reg = new HostRegistry();
  reg.connect('box', () => {});
  reg.recordHealth('box', health({ claudeAccounts: 0 }));

  const moved = reg.recordHealth('box', health({
    claudeAccounts: 2,
    credential: { state: 'expired', refreshable: false, expiresAt: 1, account: null, plan: null, summary: '' },
  }));

  assert.equal(moved?.to, 'degraded');
  assert.match(String(moved?.reason), /credential/);
});

test('a host that keeps reconnecting does not keep announcing the same fault', async (t) => {
  // REPORTED FROM A LOCK SCREEN within minutes of host events shipping: a
  // stream of identical notifications about one broken machine.
  //
  // The registry's memory of a host's previous state is reset by `connect()`,
  // so every reconnect looks like a fresh transition — and a degraded box
  // reconnects for all the ordinary reasons: a service restart, an update, a
  // socket blip, the coordinator itself being replaced. deb132 was restarted
  // several times in an hour while broken.
  //
  // This is the "cries wolf" failure the watcher's transition rule exists to
  // avoid, arriving through the one path that had no such rule.
  let clock = 1_000_000;
  const sent = [];
  const c = new CoordinatorCore({
    now: () => clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    push: { send: async (_d, msg) => { sent.push(msg); } },
  });
  c.devices.set('phone', { token: 't', platform: 'ios' });

  const flap = () => {
    c.hostConnected('box', () => {});
    return c.onHostMessage('box', { kind: 'health', health: health({ claudeAccounts: 0 }) });
  };

  await flap();
  assert.equal(sent.length, 1, 'the first time is news');
  assert.match(sent[0].body, /cannot start sessions/);
  // AND THE TITLE IS NOT "deb132 on deb132". A host event's name IS the host;
  // the template was written for sessions, where the two differ.
  assert.equal(sent[0].title, 'box');

  for (let i = 0; i < 5; i++) await flap();
  assert.equal(sent.length, 1, 'five reconnects later, still one notification');

  // Tomorrow it says so again, because a fault reported once at midnight and
  // never repeated is a fault somebody scrolls past.
  clock += 61 * 60_000;
  await flap();
  assert.equal(sent.length, 2);
});

test('a host whose fault CHANGES says so, even inside the quiet hour', async () => {
  // "not logged in" and "the credential a session would get has expired" are
  // different problems with different remedies. Keyed on the reason, not just
  // the state.
  let clock = 1_000_000;
  const sent = [];
  const c = new CoordinatorCore({
    now: () => clock,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    push: { send: async (_d, m) => { sent.push(m); } },
  });
  c.devices.set('phone', { token: 't', platform: 'ios' });
  c.hostConnected('box', () => {});

  await c.onHostMessage('box', { kind: 'health', health: health({ claudeAccounts: 0 }) });
  clock += 60_000;
  await c.onHostMessage('box', {
    kind: 'health',
    health: health({
      claudeAccounts: 2,
      credential: { state: 'expired', refreshable: false, expiresAt: 1, account: null, plan: null, summary: '' },
    }),
  });

  assert.equal(sent.length, 2);
  assert.match(sent[1].body, /credential/);
});

test('a coordinator restart does not re-announce a fault it already announced', async () => {
  // "Notifications still spamming", after the first fix. That fix kept an
  // in-memory map — and this coordinator is a Durable Object replaced on every
  // deploy, of which there were six in one day. Every deploy emptied the map
  // and re-announced every standing fault.
  //
  // The event ring is already persisted for exactly this class of question, and
  // a notification we sent IS an event in it, so suppression reads from there
  // and survives what an in-memory map could not.
  let clock = 5_000_000;
  const sent = [];
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  const push = { send: async (_d, m) => { sent.push(m); } };

  const first = new CoordinatorCore({ now: () => clock, logger: quiet, push });
  first.devices.set('phone', { token: 't', platform: 'ios' });
  first.hostConnected('box', () => {});
  await first.onHostMessage('box', { kind: 'health', health: health({ claudeAccounts: 0 }) });
  assert.equal(sent.length, 1);

  // The deploy. A new object, and the ring restored from storage — which is
  // what `onEvents` persists and what a real restart loads back.
  const restored = new CoordinatorCore({ now: () => clock, logger: quiet, push });
  restored.devices.set('phone', { token: 't', platform: 'ios' });
  restored.events.push(...first.events);
  restored.hostConnected('box', () => {});
  await restored.onHostMessage('box', { kind: 'health', health: health({ claudeAccounts: 0 }) });

  assert.equal(sent.length, 1, 'the deploy re-announced a fault the fleet had already been told about');
});
