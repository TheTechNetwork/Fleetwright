// Facts the app could not show, because nothing sent them.
//
// All four already existed on the box: the workspace in the registry, the
// start time on the record, the plan in auth status, the commit in git. They
// stopped at the sidecar. Additive fields on health and on the session list,
// so no protocol bump -- an old client ignores what it does not know.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HostRegistry } from '../src/fleet/coordinator/registry.js';

function withHealth(health) {
  const r = new HostRegistry();
  r.connect('box', () => {});
  r.recordHealth('box', { hub: { reachable: true }, maxSessions: 5, running: 1, free: 4, labels: [], ...health });
  return r.list()[0];
}

test('a session carries where, when, and whose account', () => {
  const entry = withHealth({
    sessions: [{
      name: 'job', status: 'running', createdBy: 'fleet:a@b.com',
      cwd: '/home/user/agent-runs/job', startedAt: 1_700_000_000_000, account: 'a@b.com',
    }],
  });
  const s = entry.health.sessions[0];
  assert.equal(s.cwd, '/home/user/agent-runs/job');
  assert.equal(s.startedAt, 1_700_000_000_000);
  assert.equal(s.account, 'a@b.com');
});

test('start time travels as a timestamp, not a duration', () => {
  // A duration is stale the moment it is serialised. The phone doing the
  // arithmetic is the only place it can be right -- the same reason the
  // console freezes age counters when the fleet is unreachable.
  const s = withHealth({ sessions: [{ name: 'j', status: 'running', startedAt: 1_700_000_000_000 }] }).health.sessions[0];
  assert.equal(typeof s.startedAt, 'number');
});

test('the box reports its account and its version', () => {
  const entry = withHealth({
    account: { email: 'org@example.com', plan: 'max', org: 'Example Org' },
    version: { head: 'abc1234', branch: 'main' },
  });
  assert.equal(entry.health.account.plan, 'max');
  assert.equal(entry.health.version.head, 'abc1234');
});

test('a host that reports none of it is still healthy', () => {
  // Every field is additive. An older sidecar sends nothing new and must not
  // become degraded, unknown, or an error for it.
  const entry = withHealth({});
  assert.equal(entry.state, 'healthy');
  assert.equal(entry.health.account, undefined);
  assert.equal(entry.health.version, undefined);
});

test('a logged-out box reports no account rather than a blank one', () => {
  // null is "not logged in", which the app can say. An object of nulls looks
  // like an account with no name.
  const entry = withHealth({ account: null, loggedIn: false });
  assert.equal(entry.health.account, null);
});
