// Who may see, and act on, somebody else's work.
//
// The fleet's visibility rule is stated in coordinator/core.js: a member sees
// the sessions their verified identity created; unattributed sessions belong
// to the fleet, which is to say the admin. That rule was enforced on `list`
// and on the pinned verbs and NOWHERE ELSE, and three routes went around it.
//
// It had never actually bitten, for a reason worth writing down: `createdBy`
// was being stored bare while the comparison expected `fleet:<email>`, so the
// checks matched nothing and every member request failed closed. Fixing the
// actor prefix is what made these routes matter — an authorisation model that
// starts working is also an authorisation model whose gaps start counting.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { place } from '../src/fleet/coordinator/scheduler.js';

const quiet = { info() {}, warn() {}, error() {} };
const ADMIN = { email: 'admin@example.com', admin: true };
const MEMBER = { email: 'member@example.com', admin: false };

/** A core with one host holding three sessions with different owners. */
function fleet() {
  const core = new CoordinatorCore({ log: quiet });
  core.registry.hosts.set('box', {
    hostId: 'box',
    state: 'healthy',
    // reachable() filters on this; a host with no live socket is not a
    // placement candidate and every verb would refuse with no_hosts instead.
    connected: true,
    healthAt: Date.now(),
    health: {
      hostId: 'box',
      running: 3,
      resumable: ['theirs', 'mine', 'nobodys'],
      sessions: [
        { name: 'theirs', title: 'the admin’s work', cwd: '/work/secret', createdBy: 'fleet:admin@example.com' },
        { name: 'mine', title: 'my work', cwd: '/work/mine', createdBy: 'fleet:member@example.com' },
        { name: 'nobodys', title: 'from the CLI', cwd: '/work/x', createdBy: null },
      ],
    },
  });
  return core;
}

test('a member’s fleet snapshot does not carry other people’s sessions', () => {
  // /api/hosts returned every host's health blob verbatim — and that blob
  // carries each session's name, title, working directory, owner, account and
  // LIVE PROMPT TEXT. The filter on `list` was being enforced one route over.
  const core = fleet();
  const seen = core.snapshot(MEMBER).hosts[0].health;
  assert.deepEqual(seen.sessions.map((s) => s.name), ['mine']);

  // And the resumable list with it: a list of names you cannot act on is an
  // existence oracle wearing a convenience.
  assert.deepEqual(seen.resumable, ['mine']);

  // An unattributed session belongs to the fleet, which is to say the admin —
  // erring open here would break the exact promise this exists for.
  assert.equal(seen.sessions.some((s) => s.name === 'nobodys'), false);
});

test('topology is not filtered, because a member needs the host picker', () => {
  const core = fleet();
  const host = core.snapshot(MEMBER).hosts[0];
  assert.equal(host.hostId, 'box');
  assert.equal(host.state, 'healthy');
  assert.equal(host.health.running, 3, 'capacity is the box’s, not a person’s');
});

test('the admin and the break-glass token see everything', () => {
  const core = fleet();
  assert.equal(core.snapshot(ADMIN).hosts[0].health.sessions.length, 3);
  // null requester is the break-glass token: what you hold when identity
  // itself is broken.
  assert.equal(core.snapshot(null).hosts[0].health.sessions.length, 3);
});

test('the event ring stops telling a member what everyone else is doing', () => {
  const core = fleet();
  core.record({ event: 'intent', verb: 'connect', actor: 'admin@example.com', text: 'admin asked for connect claude for the box itself' });
  core.record({ event: 'intent', verb: 'start', actor: 'member@example.com', name: 'mine', text: 'member asked for start mine' });
  core.record({ event: 'host.connected', hostId: 'box', text: 'box connected' });

  const seen = core.recentEvents(MEMBER);
  assert.equal(seen.some((e) => String(e.text).includes('box itself')), false,
    'this line tells a member exactly when a login is open to be finished');
  assert.ok(seen.some((e) => e.event === 'host.connected'), 'topology stays');
  assert.ok(seen.some((e) => e.name === 'mine'), 'their own work stays');
  assert.equal(core.recentEvents(ADMIN).length >= 3, true);
});

test('logs naming a session is checked like peek, not like a box question', () => {
  // `peek` is pinned and ownership-checked. `logs <name>` returns the same
  // session's output — container stderr, which outlives the pane — and was
  // routed as a plain one-box question, so place() never consulted the
  // requester at all.
  const core = fleet();
  const intent = (params) => ({ verb: 'logs', params });

  const refused = place(core.registry, intent({ name: 'theirs' }), { requester: MEMBER });
  assert.equal(refused.kind, 'refused');
  assert.equal(refused.code, 'unknown_session');

  // BYTE-IDENTICAL to what that same name would get if it did not exist at
  // all. Compared with the name held constant, because the message names the
  // session — a refusal that differed would tell a member that a guessed name
  // is real and belongs to somebody else, which is an existence oracle built
  // out of an access control.
  const empty = new CoordinatorCore({ log: quiet });
  const absent = place(empty.registry, intent({ name: 'theirs' }), { requester: MEMBER });
  assert.equal(refused.code, absent.code);
  assert.equal(refused.reason, absent.reason);

  assert.equal(place(core.registry, intent({ name: 'mine' }), { requester: MEMBER }).kind, 'host');
  assert.equal(place(core.registry, intent({ name: 'theirs' }), { requester: ADMIN }).kind, 'host');
  // A service journal is a question about the BOX, not about a session, and
  // stays available — it is how a member finds out their own host is sick.
  assert.equal(place(core.registry, intent({ service: 'hub' }), { requester: MEMBER }).kind, 'host');
});

test('the shorthand route is not a way around any of this', async () => {
  // GET /api/<verb>/<name> omitted `requester` entirely on BOTH coordinators,
  // so `if (spec.requester && !spec.requester.admin)` and the pinned-verb
  // ownership check were skipped: a member could stop, resume or peek any
  // other member's session by name. The Worker's copy was worse — it took the
  // actor from the query string rather than preferring the verified client, so
  // the attribution it recorded was whatever the caller typed.
  //
  // A source-level tripwire, because both routes need a live server and a
  // credential to reach, and "the check is skipped because nobody passed a
  // requester" is invisible in any test that passes one.
  const { readFileSync } = await import('node:fs');
  for (const file of ['../src/fleet/coordinator/server.js', '../worker/src/fleet-do.js']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    // Every dispatch call carries a requester. A missing one reads as
    // "do not filter", so forgetting it is the fail-OPEN direction.
    for (const [, call] of src.matchAll(/dispatch\(\{([\s\S]{0,600}?)\}\)/g)) {
      assert.match(call, /requester:/, `${file} dispatches without a requester:\n${call}`);
    }
    // And the snapshot and event routes are asked on somebody's behalf.
    assert.match(src, /snapshot\(requesterFor\(client\)\)/, `${file} snapshots unfiltered`);
    assert.match(src, /recentEvents\(requesterFor\(client\)\)/, `${file} returns the ring unfiltered`);
  }
});
