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

// --- the update check must not sit on the health path ------------------------

test('health never blocks on git or apt', async () => {
  // `updates` used to do the work inline: a `git fetch` and an apt list refresh,
  // inside the function that builds a health frame. Frames go every fifteen
  // seconds and are what the coordinator ranks hosts on, so most were instant
  // and the one after a cache expiry was not — a host that went quiet for a
  // moment every so often, with nothing pointing at why.
  //
  // ROADMAP asked for this and said why: "so the answer is ready when asked
  // rather than computed while somebody waits".
  const { readFileSync } = await import('node:fs');
  const bin = readFileSync(new URL('../bin/agent-fleet-sidecar', import.meta.url), 'utf8');

  // The injected function reads a variable. It does not call anything.
  assert.match(bin, /updates: \(\) => lastUpdates,/);

  // And the work happens on a timer instead.
  assert.match(bin, /setInterval\(refreshUpdates/);
  assert.match(bin, /setTimeout\(refreshUpdates, 0\)/);

  // Both unref'd, or the sidecar is a process that will not exit.
  const timers = bin.match(/set(Timeout|Interval)\(refreshUpdates[^\n]*/g) || [];
  assert.equal(timers.length, 2);
  for (const t of timers) assert.match(t, /\.unref\?\.\(\)/, `${t} keeps the process alive`);
});

test('a failed update check keeps the last answer rather than erasing it', async () => {
  // Null means CANNOT TELL in the health frame, and the app is careful not to
  // render it as "no updates". Replacing a good answer with null on a transient
  // network failure would report "cannot tell" to a fleet that could tell five
  // minutes ago — worse than being slightly stale.
  const { readFileSync } = await import('node:fs');
  const bin = readFileSync(new URL('../bin/agent-fleet-sidecar', import.meta.url), 'utf8');
  const refresh = bin.slice(bin.indexOf('function refreshUpdates'), bin.indexOf('setTimeout(refreshUpdates'));
  assert.match(refresh, /catch/);
  assert.equal(/lastUpdates = null/.test(refresh), false, 'a failed check erases the previous answer');
});
