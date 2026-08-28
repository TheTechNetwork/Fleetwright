// Maintaining a box from the app: update, upgrade, reboot.
//
// All three are questions about ONE box, and all three are guarded by the same
// rule the chat flow uses -- a remote reboot should be harder than a local one,
// not easier.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateIntent, PROTOCOL_VERSION, isMutating } from '../src/fleet/protocol/intents.js';
import { HostRegistry } from '../src/fleet/coordinator/registry.js';
import { place } from '../src/fleet/coordinator/scheduler.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';

const intent = (verb, params = {}) => ({
  v: PROTOCOL_VERSION, kind: 'intent', id: 'abcd1234', verb, params, issuedAt: Date.now(),
});

function fleet(ids, { full = false } = {}) {
  const r = new HostRegistry();
  for (const id of ids) {
    r.connect(id, () => {});
    r.recordHealth(id, { hub: { reachable: true }, maxSessions: 5, running: full ? 5 : 0, free: full ? 0 : 5, labels: [] });
  }
  return r;
}

test('restarting and applying are opt-in, never by omission', () => {
  // An update that does not restart leaves the box on old code and says so.
  // An unasked-for restart interrupts whatever was happening because somebody
  // typed a word.
  assert.equal(toCommandLine({ verb: 'update', params: {} }), '/update');
  assert.equal(toCommandLine({ verb: 'update', params: { restart: 'yes' } }), '/update --restart');
  assert.equal(toCommandLine({ verb: 'upgrade', params: {} }), '/upgrade');
  assert.equal(toCommandLine({ verb: 'upgrade', params: { apply: 'yes' } }), '/upgrade apply');
});

test('the flags are enums, so nothing else fits through', () => {
  assert.equal(validateIntent(intent('update', { restart: 'maybe' })).ok, false);
  assert.equal(validateIntent(intent('upgrade', { apply: '; rm -rf /' })).ok, false);
});

test('reboot bare is step one; pin plus hostname is step two', () => {
  assert.equal(toCommandLine({ verb: 'reboot', params: {} }), '/reboot');
  assert.equal(
    toCommandLine({ verb: 'reboot', params: { pin: '123456', confirm: 'deb132' } }),
    '/reboot 123456 deb132',
  );
});

test('reboot takes no boolean confirmation', () => {
  // `confirm: true` would be one tap from a phone in a pocket. The guard that
  // survives being remote asks for something only somebody who knows WHICH
  // box can produce.
  assert.equal(validateIntent(intent('reboot', { confirm: true })).ok, false);
  assert.equal(validateIntent(intent('reboot', { force: 'yes' })).ok, false);
});

test('all three change the box, so all three are mutating', () => {
  for (const v of ['update', 'upgrade', 'reboot']) assert.equal(isMutating(v), true, v);
});

test('they go to one named box, and refuse to guess between several', () => {
  for (const v of ['update', 'upgrade', 'reboot']) {
    assert.equal(place(fleet(['only']), intent(v), {}).kind, 'host', v);
    const many = place(fleet(['a', 'b']), intent(v), {});
    assert.equal(many.kind, 'refused', v);
    assert.equal(many.code, 'ambiguous_host', v);
    assert.equal(place(fleet(['a', 'b']), intent(v), { preferHost: 'b' }).host.hostId, 'b', v);
  }
});

test('a full box can still be updated', () => {
  // The new-work path filters on free capacity; falling through to it would
  // have made a busy box unmaintainable.
  assert.equal(place(fleet(['busy'], { full: true }), intent('update'), {}).kind, 'host');
});
