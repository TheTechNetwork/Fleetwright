// Logs go to one named box, and take an enum rather than a service name.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateIntent, PROTOCOL_VERSION, isMutating } from '../src/fleet/protocol/intents.js';
import { HostRegistry } from '../src/fleet/coordinator/registry.js';
import { place } from '../src/fleet/coordinator/scheduler.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';

const logs = (params = {}) => ({
  v: PROTOCOL_VERSION, kind: 'intent', id: 'abcd1234', verb: 'logs', params, issuedAt: Date.now(),
});

function fleet(ids, { full = false } = {}) {
  const r = new HostRegistry();
  for (const id of ids) {
    r.connect(id, () => {});
    r.recordHealth(id, {
      hub: { reachable: true }, maxSessions: 5, running: full ? 5 : 0, free: full ? 0 : 5, labels: [],
    });
  }
  return r;
}

test('the service is an enum, so a caller cannot name any unit on the box', () => {
  assert.equal(validateIntent(logs({ service: 'hub' })).ok, true);
  for (const bad of ['sshd', 'systemd-journald', '../../etc', '']) {
    assert.equal(validateIntent(logs({ service: bad })).ok, false, JSON.stringify(bad));
  }
});

test('lines are bounded', () => {
  assert.equal(validateIntent(logs({ lines: 200 })).ok, true);
  assert.equal(validateIntent(logs({ lines: 201 })).ok, false);
  assert.equal(validateIntent(logs({ lines: 0 })).ok, false);
});

test('reading a log changes nothing', () => {
  assert.equal(isMutating('logs'), false);
});

test('one host means no choice to make', () => {
  const p = place(fleet(['only-box']), logs(), {});
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'only-box');
});

test('several hosts and no preference is refused, with the names', () => {
  // Picking one silently would be guessing at which box somebody meant --
  // the same reasoning that refuses an ambiguous session name rather than
  // resolving it by iteration order.
  const p = place(fleet(['a-box', 'b-box']), logs(), {});
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'ambiguous_host');
  assert.match(p.reason, /a-box/);
  assert.match(p.reason, /b-box/);
});

test('a preference resolves it', () => {
  const p = place(fleet(['a-box', 'b-box']), logs(), { preferHost: 'b-box' });
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'b-box');
});

test('a FULL box can still be asked about itself', () => {
  // The new-work path filters on free capacity. Falling through to it would
  // have made a busy box unable to explain why it was busy.
  const p = place(fleet(['busy-box'], { full: true }), logs(), {});
  assert.equal(p.kind, 'host');
});

test('the command line carries only constrained tokens', () => {
  assert.equal(toCommandLine({ verb: 'logs', params: { service: 'sidecar', lines: 50 } }), '/logs sidecar 50');
  assert.equal(toCommandLine({ verb: 'logs', params: {} }), '/logs');
});

test('a session name is accepted, and beats a service when both arrive', () => {
  assert.equal(validateIntent(logs({ name: 'bigjob' })).ok, true);
  assert.equal(
    toCommandLine({ verb: 'logs', params: { name: 'bigjob', service: 'hub', lines: 60 } }),
    '/logs bigjob 60',
    'naming a session is the more specific request',
  );
});

test('a session name is still a name -- nothing else fits through', () => {
  for (const bad of ['../etc/passwd', 'a b', 'name;rm -rf /', '']) {
    assert.equal(validateIntent(logs({ name: bad })).ok, false, JSON.stringify(bad));
  }
});
