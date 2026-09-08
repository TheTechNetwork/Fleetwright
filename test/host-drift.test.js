// A host on the wrong protocol version, which the fleet used to say nothing
// about until somebody tripped over it.
//
// Findings C5 (#321) and D2 (#323). Both are about the same box and the two
// halves are not the same problem:
//
//   C5  nothing announced it. Health is not version-gated, so a drifted host
//       reported `healthy`, the scheduler kept sending it work, and every
//       command came back refused.
//   D2  it cannot be fixed from the product. That is TRUE and the issue names
//       the wrong reason: `update` is not denied any more (it came off
//       DEFAULT_DENY), it is REFUSED — by the same version check as everything
//       else, before the verb is read.

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

test('the reason says the fleet cannot fix it, because it cannot', () => {
  // THE HALF THAT MATTERS. Every other rung on this ladder names a remedy the
  // fleet can carry out — link an account, sign in again. This one cannot be
  // carried out over the protocol that is refusing it, and a reason that
  // implied otherwise would send somebody to press a button that fails the
  // same way.
  const h = fleet({ protocol: PROTOCOL_VERSION + 1 });
  assert.match(h.reason, /cannot fix/i);
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

test('unsupported_version explains itself, and says the fleet cannot fix it', async () => {
  // It had NO explanation at all — `unknown_verb` had one and this did not, so
  // the more serious of the two failures was the one that reached a phone as a
  // single word. Finding D2 says the drift error "names `agent-hub update
  // --restart`"; that is the other error, and this one named nothing.
  const core = new CoordinatorCore({ log: quiet });
  core.registry.hosts.set('old', {
    hostId: 'old', state: 'degraded', connected: true, healthAt: Date.now(),
    health: { hostId: 'old', protocol: 2, sessions: [] },
    send: async () => ({ ok: false, error: { code: 'unsupported_version' }, text: 'unsupported protocol version 3' }),
  });
  core.send = async () => ({ ok: false, error: { code: 'unsupported_version' }, text: 'unsupported protocol version 3' });

  const reply = await core.dispatch({ verb: 'upgrade', params: {}, preferHost: 'old' });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'unsupported_version', 'the code stays machine-readable');
  assert.match(reply.text, /speaks protocol 2/, 'it does not say which version the host is on');
  assert.match(reply.text, new RegExp(`fleet speaks ${PROTOCOL_VERSION}`));
  // AND IT SAYS `update` WILL NOT HELP. Told the unknown_verb story instead,
  // somebody presses Apply update, watches it refused for the same reason, and
  // concludes the product is broken rather than that this box needs a person.
  assert.match(reply.text, /CANNOT FIX THIS ONE/);
  assert.match(reply.text, /install \| sudo sh/);
  assert.doesNotMatch(reply.text, /Apply update, on old/, 'it offers a button that is refused identically');
});
