// A host on the wrong protocol version, which the fleet used to say nothing
// about until somebody tripped over it.
//
// Findings C5 (#321) and D2 (#323). Both are about the same box and the two
// halves are not the same problem:
//
//   C5  nothing announced it. Health is not version-gated, so a drifted host
//       reported `healthy`, the scheduler kept sending it work, and every
//       command came back refused.
//   D2  it cannot be fixed from the product. That was TRUE and the issue named
//       the wrong reason: `update` is not denied any more (it came off
//       DEFAULT_DENY), it is REFUSED — by the same version check as everything
//       else, before the verb is read.
//
// D2 is no longer true, which is why several assertions here now say the
// opposite of what they said. `update` travels in a frozen envelope whose
// version field is not consulted (RESCUE_VERB, pinned in intents.test.js), and
// the coordinator labels it with a drifted host's own version so the boxes
// already out there — running code from before any of this — accept it too.
// What is left of the finding is the direction: a host that is BEHIND can be
// repaired from the app, and a host that is AHEAD is waiting for a coordinator
// deploy and always was.

import test from 'node:test';
import assert from 'node:assert/strict';

import { HostRegistry } from '../src/fleet/coordinator/registry.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** A health frame that is fine in every way except the one under test. */
const health = (patch = {}) => ({
  hostId: 'h',
  protocol: PROTOCOL_VERSION,
  labels: [],
  maxSessions: 5,
  running: 0,
  free: 5,
  resumable: [],
  sessions: [],
  hub: { reachable: true },
  claudeAccounts: 1,
  ...patch,
});

function fleet(patch) {
  const r = new HostRegistry();
  r.connect('h', () => {});
  r.recordHealth('h', health(patch));
  return r.list().find((x) => x.hostId === 'h');
}

test('a drifted host is degraded, so no new work is sent to it', () => {
  // It reported `healthy` before this: the scheduler ranked it, chose it, and
  // the session start came back refused. Every one of them.
  const h = fleet({ protocol: PROTOCOL_VERSION - 1 });
  assert.equal(h.state, 'degraded');
  assert.match(h.reason, new RegExp(`speaks protocol ${PROTOCOL_VERSION - 1}`));
  assert.match(h.reason, new RegExp(`fleet speaks ${PROTOCOL_VERSION}`));
});

test('a host that is AHEAD says so, and names the deploy rather than the installer', () => {
  // THE ONE DIRECTION THE FLEET STILL CANNOT FIX, and it never could: the box
  // is newer than the thing refusing it, so pulling code on it is the fleet
  // prescribing its own symptom. This is also the ordinary upgrade window —
  // hosts first, then the coordinator — so it is half a deploy rather than a
  // broken machine.
  //
  // It used to name the installer, for both directions, which was wrong here
  // twice over: it sends somebody to a machine that is already correct, to
  // re-install the correct half.
  const h = fleet({ protocol: PROTOCOL_VERSION + 1 });
  assert.match(h.reason, /cannot fix/i);
  assert.match(h.reason, /coordinator to be deployed/);
  assert.doesNotMatch(h.reason, /installer/, 'the box is not the half that is behind');
});

test('a host that is BEHIND is offered the one command that still reaches it', () => {
  // FINDING D2, INVERTED. The reason a screen shows must not say the fleet is
  // helpless when a rescue `update` is sent in this box's own version and does
  // arrive — that would send somebody to a machine they need not visit.
  const h = fleet({ protocol: PROTOCOL_VERSION - 1 });
  assert.match(h.reason, /Apply update/);
  assert.doesNotMatch(h.reason, /cannot fix/i);
  // And it still names the case the update cannot answer: a box pinned to a
  // channel with no newer release pulls, finds nothing, and comes back on the
  // same version. That one does need somebody on the machine, and saying so is
  // the difference between offering a remedy and promising one.
  assert.match(h.reason, /installer/);
});

test('a host that never reports a protocol is not faulted for it', () => {
  // CANNOT TELL IS NOT DRIFT. A host too old to send the field reads as
  // undefined, and degrading on that would take out exactly the boxes least
  // able to recover — the same rule `claudeAccounts` learned when every host
  // reported `loggedIn: false` and the whole fleet went permanently degraded.
  for (const protocol of [undefined, null, 'three', NaN]) {
    const h = fleet({ protocol });
    assert.equal(h.state, 'healthy', `protocol=${String(protocol)} was treated as drift`);
  }
});

test('drift is checked before the rungs whose remedies it would block', () => {
  // A drifted host with no Claude account has two faults, and only one of them
  // is reachable. Reporting "link an account from the app" would name a fix
  // that cannot be delivered — the link verb is refused for the same reason as
  // everything else.
  const h = fleet({ protocol: PROTOCOL_VERSION - 1, claudeAccounts: 0, hub: { reachable: false, reason: 'down' } });
  assert.match(h.reason, /speaks protocol/);
  assert.doesNotMatch(h.reason, /Link one from the app/);
});

test('an in-step host is untouched by any of this', () => {
  const h = fleet();
  assert.equal(h.state, 'healthy');
  assert.equal(h.reason, 'reporting normally');
});

/** A coordinator holding one host that refuses everything on version grounds. */
function drifted(protocol) {
  const core = new CoordinatorCore({ log: quiet });
  core.registry.hosts.set('old', {
    hostId: 'old', state: 'degraded', connected: true, healthAt: Date.now(),
    health: { hostId: 'old', protocol, sessions: [] },
    send: async () => ({ ok: false, error: { code: 'unsupported_version' }, text: `unsupported protocol version ${PROTOCOL_VERSION}` }),
  });
  core.send = async () => ({ ok: false, error: { code: 'unsupported_version' }, text: `unsupported protocol version ${PROTOCOL_VERSION}` });
  return core;
}

test('unsupported_version explains itself, and names the command that still lands', async () => {
  // It had NO explanation at all — `unknown_verb` had one and this did not, so
  // the more serious of the two failures was the one that reached a phone as a
  // single word. Finding D2 says the drift error "names `agent-hub update
  // --restart`"; that is the other error, and this one named nothing.
  const reply = await drifted(PROTOCOL_VERSION - 1).dispatch({ verb: 'upgrade', params: {}, preferHost: 'old' });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'unsupported_version', 'the code stays machine-readable');
  assert.match(reply.text, new RegExp(`speaks protocol ${PROTOCOL_VERSION - 1}`), 'it says which version the host is on');
  assert.match(reply.text, new RegExp(`fleet speaks ${PROTOCOL_VERSION}`));
  // AND IT OFFERS THE UPDATE, which is the sentence that reversed. It used to
  // say the fleet could not help, because it could not: `update` was refused
  // by the same check as everything else. It is now the one envelope that
  // survives the mismatch, so withholding it would send somebody to a machine
  // for a repair the app can do.
  assert.match(reply.text, /Apply update, on old/);
  assert.doesNotMatch(reply.text, /CANNOT FIX THIS ONE/);
  // The installer stays named, for the case the update cannot answer: a pull
  // that finds nothing newer. Offered as the second thing rather than the only
  // one.
  assert.match(reply.text, /install \| sudo sh/);
});

test('a host ahead of the fleet is told the truth, which is the opposite one', async () => {
  // Same refusal, same code, other direction. `update` here would pull a box
  // that is already newer than the coordinator refusing it, so the message must
  // not offer it — the fleet is what needs deploying.
  const reply = await drifted(PROTOCOL_VERSION + 1).dispatch({ verb: 'upgrade', params: {}, preferHost: 'old' });
  assert.equal(reply.error.code, 'unsupported_version');
  assert.match(reply.text, /AHEAD OF THE FLEET/);
  assert.match(reply.text, /CANNOT FIX THIS ONE/);
  assert.doesNotMatch(reply.text, /Apply update, on old/, 'it offers a button that is the wrong direction');
});

test('a rescue update aimed at a drifted host goes out in the version that box waits for', async () => {
  // THE FIX ITSELF, end to end from dispatch. Everything above is the words;
  // this is whether the envelope that carries the repair is labelled with the
  // number the box is waiting for. A host in the field runs code from before
  // any of this and checks that number, so getting it wrong here makes every
  // sentence above a promise the product does not keep.
  const core = drifted(PROTOCOL_VERSION - 1);
  /** @type {any[]} */
  const sent = [];
  // THE REAL `send`, not the stub the other tests use — the thing under test is
  // the envelope it builds, so short-circuiting it would test nothing. The host
  // answers by the ordinary route so the waiter resolves.
  delete core.send;
  core.registry.hosts.get('old').send = (/** @type {any} */ intent) => {
    sent.push(intent);
    core.onHostMessage('old', { kind: 'reply', id: intent.id, ok: true, text: 'pulled' });
  };

  const reply = await core.dispatch({ verb: 'update', params: { restart: 'yes' }, preferHost: 'old' });
  assert.equal(reply.ok, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].v, PROTOCOL_VERSION - 1, 'the drifted box is spoken to in its own version');
  assert.equal(sent[0].verb, 'update');
  assert.deepEqual(sent[0].params, { restart: 'yes' });

  // And nothing else is: `upgrade` at the same box still goes out in ours and
  // is still refused, which is what keeps this an escape hatch rather than a
  // second protocol.
  await core.dispatch({ verb: 'upgrade', params: {}, preferHost: 'old' });
  assert.equal(sent[1].v, PROTOCOL_VERSION);
});
