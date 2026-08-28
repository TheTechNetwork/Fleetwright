// Restoring a forgotten session, and purging one on purpose.
//
// The host half of this shipped already: /forget bins rather than deletes, and
// the volumes stay. What was missing is any way to reach that from a phone —
// a bin nobody can see is not a bin, it is a delay.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateIntent, PROTOCOL_VERSION, VERBS, isMutating } from '../src/fleet/protocol/intents.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';
import { place } from '../src/fleet/coordinator/scheduler.js';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { readFileSync } from 'node:fs';

const quiet = { info() {}, warn() {}, error() {} };
const intent = (verb, params) => ({
  v: PROTOCOL_VERSION, kind: 'intent', id: 'abcd1234', verb, params, issuedAt: Date.now(),
});

test('both verbs take a name and nothing else', () => {
  for (const verb of ['restore', 'purge']) {
    assert.equal(validateIntent(intent(verb, { name: 'bigjob' })).ok, true, verb);
    assert.equal(validateIntent(intent(verb, {})).ok, false, `${verb} without a name`);
    // No confirmation parameter. reboot asks for a pin because the ACTOR might
    // be the attacker; here the risk is a person mistyping, and the answer to
    // that is that forget no longer destroys anything — so the destructive
    // verb is a separate word somebody reaches for on purpose.
    assert.equal(validateIntent(intent(verb, { name: 'bigjob', confirm: 'yes' })).ok, false);
  }
});

test('both change what exists, so a retry cannot report a lie', () => {
  // A retried purge must not answer "no session named that" for work it
  // deleted a moment ago — being mutating is what gets the idempotency key
  // honoured on the host.
  assert.equal(isMutating('restore'), true);
  assert.equal(isMutating('purge'), true);
});

test('each lands on the command that already existed', () => {
  assert.equal(toCommandLine({ verb: 'restore', params: { name: 'bigjob' } }), '/restore bigjob');
  assert.equal(toCommandLine({ verb: 'purge', params: { name: 'bigjob' } }), '/purge bigjob');
});

test('a binned session is findable, or restore could never be placed', () => {
  // THE PART THAT IS EASY TO MISS. A forgotten session is not in health.sessions
  // any more, so without the bin being a claim the coordinator refuses every
  // restore with unknown_session — the session is real, it is just not live.
  const core = new CoordinatorCore({ log: quiet });
  core.registry.hosts.set('box', {
    hostId: 'box',
    state: 'healthy',
    connected: true,
    healthAt: Date.now(),
    health: {
      hostId: 'box',
      sessions: [],
      bin: [{ name: 'bigjob', title: 'the migration', createdBy: 'fleet:me@example.com' }],
    },
  });

  const placed = place(core.registry, intent('restore', { name: 'bigjob' }));
  assert.equal(placed.kind, 'host');
  assert.equal(placed.host.hostId, 'box');

  // And it is pinned: the conversation and workspace are host-local volumes,
  // so the only box that can bring it back is the one still holding them.
  assert.ok(['restore', 'purge'].every((v) => place(core.registry, intent(v, { name: 'bigjob' })).kind === 'host'));
});

test('a member cannot restore somebody else’s forgotten work', () => {
  // Ownership has to hold in the bin exactly as it does in the live list —
  // otherwise "forget" would be a way to launder a session out of the filter.
  const core = new CoordinatorCore({ log: quiet });
  core.registry.hosts.set('box', {
    hostId: 'box', state: 'healthy', connected: true, healthAt: Date.now(),
    health: { hostId: 'box', sessions: [], bin: [{ name: 'theirs', createdBy: 'fleet:admin@example.com' }] },
  });
  const member = { email: 'member@example.com', admin: false };
  const refused = place(core.registry, intent('restore', { name: 'theirs' }), { requester: member });
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.code, 'unknown_session');
  assert.equal(place(core.registry, intent('restore', { name: 'theirs' }), { requester: { email: 'a@b.com', admin: true } }).kind, 'host');
});

test('an old host’s refusal explains itself, and names the way out', () => {
  // `unknown_verb` is the protocol working: adding a verb costs no version
  // bump BECAUSE an old host refuses cleanly. What reached a phone was the
  // bare word — the verb exists on the coordinator, so the request looked
  // valid and the failure named a thing rather than a remedy.
  //
  // And the remedy is the awkward part: the verb that fixes this is often the
  // one that is unknown. `update` over the fleet cannot update a box too old
  // to have `update`.
  const core = new CoordinatorCore({ log: quiet });
  core.registry.hosts.set('old', {
    hostId: 'old', state: 'healthy', connected: true, healthAt: Date.now(),
    health: { hostId: 'old', sessions: [], version: { head: 'abc1234' }, updates: { appBehind: 12 } },
    send: async () => ({ ok: false, error: { code: 'unknown_verb' }, text: 'unknown verb "upgrade"' }),
  });
  core.send = async () => ({ ok: false, error: { code: 'unknown_verb' }, text: 'unknown verb "upgrade"' });

  return core.dispatch({ verb: 'upgrade', params: {}, preferHost: 'old' }).then((reply) => {
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, 'unknown_verb', 'the code stays machine-readable');
    assert.match(reply.text, /older code/);
    assert.match(reply.text, /agent-hub update --restart/);
    assert.match(reply.text, /Telegram/);
    assert.match(reply.text, /abc1234/, 'says which commit it is on');
    assert.match(reply.text, /12 behind/);
    // BOTH remedies carry --restart. A pull that did not restart looks
    // identical from the coordinator — new files, a running service still
    // holding the old command list — and is at least as common as being
    // genuinely behind. Asserted as two specific lines rather than by
    // counting occurrences, because the prose says the word too.
    assert.match(reply.text, /agent-hub update --restart/);
    assert.match(reply.text, /\/update --restart/);
  });
});

test('both apps carry the bin, and neither renders it for an old host', () => {
  // PARITY, checked rather than intended. The maintenance row shipped to iOS
  // and not to Android two rounds ago while I reported it done on both, and
  // docs/app-parity.md exists because a gap one commit wide is invisible in a
  // summary.
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const ios = read('apps/ios/Fleetwright/Fleet.swift') + read('apps/ios/Fleetwright/FleetView.swift');
  const android =
    read('apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt') +
    read('apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt');

  for (const [name, src] of [['iOS', ios], ['Android', android]]) {
    assert.match(src, /\brestore\b/, `${name} cannot restore`);
    assert.match(src, /\bpurge\b/, `${name} cannot purge`);
    assert.match(src, /Restore/, `${name} has no restore button`);
    assert.match(src, /Delete now/, `${name} has no purge button`);
    // The permanent action confirms; the reversible one does not. A
    // confirmation on the reversible action and none on the permanent one is
    // how people learn to tap through both.
    assert.match(src, /for good\?/, `${name} deletes without asking`);
    // The deadline is computed on the phone from a timestamp. A rendered
    // string would freeze the moment it was sent.
    assert.match(src, /remaining/, `${name} does not show how long is left`);
  }
});
