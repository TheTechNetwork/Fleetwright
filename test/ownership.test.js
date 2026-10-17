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
      // Forgotten sessions, as the sidecar reports them: whose they were
      // travels so the coordinator can filter on it.
      bin: [
        { name: 'their-old', title: 'the admin’s old work', createdBy: 'fleet:admin@example.com', deletedAt: 1, expiresAt: 2 },
        { name: 'my-old', title: 'my old work', createdBy: 'fleet:member@example.com', deletedAt: 1, expiresAt: 2 },
        { name: 'nobodys-old', title: 'from the CLI', createdBy: null, deletedAt: 1, expiresAt: 2 },
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

  // THE BIN IS SOMEBODY'S TOO. It reached every member through the spread of
  // the rest of the health frame: names, titles and who forgot them.
  assert.deepEqual(seen.bin.map((b) => b.name), ['my-old']);
});

/**
 * A fan-out of one host, answering `list` the way a real one does: with the
 * records AND with the listing a person reads. `send` is the seam — the
 * registry hands it the intent, and the reply comes back through the same
 * door a socket would use.
 *
 * @param {CoordinatorCore} core
 */
function answerList(core, hostId = 'box') {
  // Exactly what fleetwright's /list renders, glyphs and all — see
  // src/adapters/commands.js. The point of the test is that this prose never
  // reaches somebody it is not about.
  const text = [
    '2/4 running on box',
    '',
    '▶ theirs · the admin’s work',
    '   started 3m ago · fleet:admin@example.com',
    '   https://rc.example.com/theirs',
    '▶ mine · my work',
    '   started 1m ago · fleet:member@example.com',
  ].join('\n');
  core.registry.connect(hostId, (/** @type {any} */ intent) => {
    queueMicrotask(() =>
      core.onHostMessage(hostId, {
        kind: 'reply',
        id: intent.id,
        ok: true,
        text,
        sessions: [
          { name: 'theirs', status: 'running', title: 'the admin’s work', createdBy: 'fleet:admin@example.com', rcUrl: 'https://rc.example.com/theirs' },
          { name: 'mine', status: 'running', title: 'my work', createdBy: 'fleet:member@example.com', rcUrl: 'https://rc.example.com/mine' },
        ],
      }),
    );
  });
  core.registry.recordHealth(hostId, { hostId, running: 2, sessions: [] });
  return text;
}

test('the listing a member reads is not the one the host wrote', async () => {
  // The filter on `list` removed other people's sessions from `sessions` and
  // left them in `text` — the SAME FACTS, rendered by the host for a person.
  // The apps draw the records, so they were right; the MCP server renders
  // `text`, because that is what an agent reads, so `fleet_list` handed every
  // member the whole fleet: names, titles, who started them, and a live
  // Remote Control URL into anything running.
  const core = new CoordinatorCore({ log: quiet });
  const hostWrote = answerList(core);

  const seen = await core.dispatch({ verb: 'list', params: {}, requester: MEMBER });
  assert.deepEqual((seen.sessions || []).map((/** @type {any} */ s) => s.name), ['mine']);
  for (const rendered of [String(seen.text), String(seen.hosts[0].text)]) {
    assert.equal(rendered.includes('theirs'), false, 'somebody else’s session is named');
    assert.equal(rendered.includes('admin@example.com'), false, 'and attributed');
    assert.equal(rendered.includes('rc.example.com/theirs'), false, 'with a live link into it');
    // Their OWN work survives — a filter that renders nothing is a filter
    // nobody can tell from a broken fleet.
    assert.match(rendered, /mine/);
  }

  // And it says whose absence it is describing. "No sessions" would be a claim
  // about the box; this is a claim about the caller, which is the only one
  // that is true.
  const stranger = await core.dispatch({
    verb: 'list',
    params: {},
    requester: { email: 'nobody@example.com', admin: false },
  });
  assert.match(String(stranger.text), /nothing of yours/);
  assert.equal(String(stranger.text).includes('mine'), false);

  // The admin and the break-glass token still read the host's own words.
  const asAdmin = await core.dispatch({ verb: 'list', params: {}, requester: ADMIN });
  assert.equal(String(asAdmin.text), `box: ${hostWrote}`);
  assert.equal(String((await core.dispatch({ verb: 'list', params: {} })).text), `box: ${hostWrote}`);
});

test('a host that refused keeps its reason, and the other fan-outs keep their words', async () => {
  // The rewrite is scoped to replies that carried sessions. A refusal has none
  // — and answering "nothing of yours" to a box that never answered would be
  // the failure this file exists to stop, pointed the other way: a fleet that
  // looks empty instead of broken.
  const core = new CoordinatorCore({ log: quiet });
  core.registry.connect('box', (/** @type {any} */ intent) => {
    queueMicrotask(() =>
      core.onHostMessage('box', {
        kind: 'reply',
        id: intent.id,
        ok: false,
        error: { code: 'hub_unreachable' },
        text: 'the session manager is not answering on this box',
      }),
    );
  });
  core.registry.recordHealth('box', { hostId: 'box', running: 0, sessions: [] });

  const refused = await core.dispatch({ verb: 'list', params: {}, requester: MEMBER });
  assert.match(String(refused.text), /session manager is not answering/);

  // `profiles` fans out too, and carries no sessions at all.
  const profiles = await core.dispatch({ verb: 'profiles', params: {}, requester: MEMBER });
  assert.match(String(profiles.text), /session manager is not answering/);
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
});

test('a box’s service journal is read by the admin, or by the one person the box acts for', async () => {
  // A later audit: this file said a service journal is a question about the
  // box and asserted any member could read one. The sidecar journals every
  // intent with its actor, so a member reading the operator's box, or a box
  // another member enrolled, read who else used it, their session names, the
  // secret and archive of each start and the files each wrote. It stays a
  // member's on a box that acts for them alone, which is how they find out
  // their own box is sick.
  const { admit } = await import('./helpers/enrolled-hosts.js');
  const core = new CoordinatorCore({ log: quiet });
  /** @type {string[]} */
  const delivered = [];
  const journal = (/** @type {string} */ hostId) => (/** @type {any} */ intent) => {
    delivered.push(hostId);
    queueMicrotask(() => core.onHostMessage(hostId, { kind: 'reply', id: intent.id, ok: true, text: 'sidecar: fleet:carol@example.com → /new carol-payroll' }));
  };
  await admit(core, 'ops-box', { send: journal('ops-box') });
  await admit(core, 'carol-box', { enrolledBy: 'carol@example.com', send: journal('carol-box') });
  await admit(core, 'member-box', { enrolledBy: MEMBER.email, send: journal('member-box') });
  const read = (/** @type {any} */ requester, /** @type {string} */ host = '') =>
    core.dispatch({ verb: 'logs', params: { service: 'sidecar', lines: 200 }, preferHost: host, actor: requester?.email, requester });

  for (const host of ['ops-box', 'carol-box']) {
    const r = await read(MEMBER, host);
    assert.equal(r.error?.code, 'not_admin', `a member read the journal of ${host}`);
  }
  assert.deepEqual(delivered, [], 'a journal read reached a box that does not act for the member alone');

  // Their own box, named or as the only one they may read.
  assert.equal((await read(MEMBER, 'member-box')).ok, true);
  assert.equal((await read(MEMBER)).ok, true);
  // The admin and the break-glass token read any box's.
  assert.equal((await read(ADMIN, 'ops-box')).ok, true);
  assert.equal((await read(null, 'carol-box')).ok, true);
  assert.deepEqual(delivered, ['member-box', 'member-box', 'ops-box', 'carol-box']);
});

/**
 * Every verb that names a session and hands back, or changes, something
 * belonging to it. The workspace five are the ones this list was missing, and
 * `answer` after them: it types a digit into somebody's waiting prompt, and
 * it went where free capacity sent it, with nobody asking whose prompt it was.
 */
const SESSION_VERBS = ['peek', 'logs', 'files', 'readfile', 'writefile', 'copyfile', 'deletefile', 'answer'];

/** Params wide enough for any of them; place() reads only `name`. */
const withName = (/** @type {string} */ name) => ({ name, path: 'notes.md', to: 'copy.md', content: 'x', option: 1 });

test('a workspace verb is checked like peek, not routed like new work', () => {
  // THE FIVE VERBS THAT HAND BACK FILES HAD NO OWNERSHIP CHECK AT ALL.
  //
  // `files`, `readfile`, `writefile`, `copyfile` and `deletefile` each take a
  // session name and act on that session's workspace, and none of them was in
  // PINNED — so place() fell through to the new-work path, which filters on
  // free capacity and never consults the requester. `peek` was checked and
  // `logs <name>` was checked; the verbs that return whole files were not, and
  // three of them are mutating, so it was somebody else's workspace open for
  // writing and deleting as well as reading.
  //
  // Found by a tester probing their own fleet over MCP: a made-up name
  // answered "that session has no workspace", a real name belonging to
  // somebody else got as far as trying to mount the container, and the thing
  // that stopped the read was a runtime mount error rather than any rule here.
  const core = fleet();
  for (const verb of SESSION_VERBS) {
    const refused = place(core.registry, { verb, params: withName('theirs') }, { requester: MEMBER });
    assert.equal(refused.kind, 'refused', `${verb} reached another member's session`);
    assert.equal(refused.code, 'unknown_session', verb);
  }
});

test('the workspace refusal is the same one an absent name gets', () => {
  // Held constant with the name, like the logs case above: a distinct "not
  // yours" would confirm that a guessed name is real and belongs to somebody
  // else, which is an existence oracle built out of an access control.
  const core = fleet();
  const empty = new CoordinatorCore({ log: quiet });
  for (const verb of SESSION_VERBS) {
    const theirs = place(core.registry, { verb, params: withName('theirs') }, { requester: MEMBER });
    const absent = place(empty.registry, { verb, params: withName('theirs') }, { requester: MEMBER });
    assert.equal(theirs.code, absent.code, verb);
    assert.equal(theirs.reason, absent.reason, verb);
  }
});

test('your own workspace still opens, on the box actually holding it', () => {
  // The other half, and the half a fix could quietly break. It also pins:
  // a workspace is a host-local volume, and the new-work path this used to
  // fall into ranks by FREE CAPACITY — which sends `files` to the machine
  // least likely to be holding anybody's session. One host hides that
  // completely, which is why it survived.
  const core = fleet();
  core.registry.hosts.set('spare', {
    hostId: 'spare',
    state: 'healthy',
    connected: true,
    healthAt: Date.now(),
    // Emptier than `box`, so a capacity ranking would choose it every time.
    health: { hostId: 'spare', running: 0, maxSessions: 8, free: 8, sessions: [] },
  });

  for (const verb of SESSION_VERBS) {
    const mine = place(core.registry, { verb, params: withName('mine') }, { requester: MEMBER });
    assert.equal(mine.kind, 'host', `${verb} refused a member their own workspace`);
    assert.equal(mine.host?.hostId, 'box', `${verb} went to the box that does not hold the session`);

    // And the admin reaches everything, from the same list.
    const asAdmin = place(core.registry, { verb, params: withName('theirs') }, { requester: ADMIN });
    assert.equal(asAdmin.kind, 'host', verb);
    assert.equal(asAdmin.host?.hostId, 'box', verb);
  }
});

test('a host does not publish a count of everybody\u2019s sessions', async () => {
  // The smaller half of the same report: `/status` with no name said
  // "2/4 sessions running, 7 known", and the second number is a count of other
  // people's work. A member's `/list` is filtered; this line told them how many
  // more there were. Nothing can act on the difference — it only says that
  // other people are here.
  //
  // Fixed where the string is written, because the box deliberately does not
  // know who is asking (that is why the filter lives in the coordinator), so a
  // number it cannot scope to a person is one it must not publish. Capacity
  // stays: how full a box is belongs to the box.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/adapters/commands.js', import.meta.url), 'utf8');
  assert.equal(
    /sessions running, \$\{all\.length\} known/.test(src),
    false,
    '/status is publishing a count of every session on the box again',
  );
  assert.match(src, /\$\{running\}\/\$\{ctx\.cfg\.maxSessions\} sessions running/, 'capacity is still reported');
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
  for (const file of ['./helpers/node-coordinator.js', '../worker/src/fleet-do.js']) {
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

/**
 * Two boxes: `ops-box`, the operator's (it may act for anyone), holding
 * alice's real session, and `mal-box`, which mallory enrolled with a pin she
 * minted, so it acts for her alone. mal-box reports sessions and a bin entry
 * it says alice created, and answers `list` the same way. What mal-box is
 * sent is kept in `delivered`.
 */
async function forgedFleet() {
  const { admit } = await import('./helpers/enrolled-hosts.js');
  const core = new CoordinatorCore({ log: quiet });
  /** @type {any[]} */
  const delivered = [];
  const forged = [
    { name: 'forged', status: 'running', title: 'FORGED', cwd: '/forged', createdBy: 'fleet:alice@example.com' },
    { name: 'alice-real', status: 'running', createdBy: 'fleet:alice@example.com' },
  ];
  const real = [{ name: 'alice-real', status: 'running', createdBy: 'fleet:alice@example.com' }];
  await admit(core, 'ops-box', {
    send: (/** @type {any} */ intent) => queueMicrotask(() => core.onHostMessage('ops-box', { kind: 'reply', id: intent.id, ok: true, text: 'ops', sessions: real })),
  });
  await admit(core, 'mal-box', {
    enrolledBy: 'mallory@example.com',
    send: (/** @type {any} */ intent) => {
      delivered.push(intent);
      queueMicrotask(() => core.onHostMessage('mal-box', { kind: 'reply', id: intent.id, ok: true, text: 'mal', sessions: forged }));
    },
  });
  core.registry.recordHealth('ops-box', { hostId: 'ops-box', sessions: real });
  core.registry.recordHealth('mal-box', { hostId: 'mal-box', sessions: forged, bin: [{ name: 'forged-bin', createdBy: 'fleet:alice@example.com' }] });
  return { core, delivered };
}

const ALICE = { email: 'alice@example.com', admin: false };

test('a box a member enrolled cannot file its sessions under somebody else', async () => {
  // A later audit: #notify asked whether the box may act for the creator it
  // named, and nothing else did. mal-box's word that alice made `forged` put
  // it in alice's /api/hosts and her list, with mallory's title, and her
  // writefile, readfile and restore on that name went to mal-box with her
  // content and her name on them.
  const { core, delivered } = await forgedFleet();

  const hosts = core.snapshot(ALICE).hosts;
  const mal = hosts.find((/** @type {any} */ h) => h.hostId === 'mal-box');
  assert.deepEqual(mal.health.sessions, [], 'a member-enrolled box listed its session as another member’s');
  assert.deepEqual(mal.health.bin, [], 'and its bin');
  // An operator's box acts for anyone, so its word is still taken.
  const ops = hosts.find((/** @type {any} */ h) => h.hostId === 'ops-box');
  assert.deepEqual(ops.health.sessions.map((/** @type {any} */ s) => s.name), ['alice-real']);

  const listed = await core.dispatch({ verb: 'list', params: {}, requester: ALICE });
  assert.deepEqual(listed.sessions.map((/** @type {any} */ s) => `${s.name}@${s.hostId}`), ['alice-real@ops-box'], 'her list carried the forged session');

  delivered.length = 0;
  const wrote = await core.dispatch({ verb: 'writefile', params: { name: 'forged', path: 'p.txt', content: 'alice’s words' }, actor: 'alice@example.com', requester: ALICE });
  assert.equal(wrote.error?.code, 'unknown_session');
  assert.deepEqual(delivered, [], 'alice’s file went to a box that does not act for her');

  // Filed under the person the box does act for, who wrote it.
  assert.equal(place(core.registry, { verb: 'peek', params: { name: 'forged' } }, { requester: { email: 'mallory@example.com', admin: false } }).host?.hostId, 'mal-box');
});

test('a claim on the name of a member’s real session does not make it ambiguous', async () => {
  // The denial half of the same audit finding: mal-box also claims
  // `alice-real`, which is alice's on ops-box. Re-attributed to mallory, the
  // claim still counted, and alice's stop was refused ambiguous_session,
  // naming mal-box, with nothing sent to ops-box.
  const { core } = await forgedFleet();
  const stop = place(core.registry, { verb: 'stop', params: { name: 'alice-real' } }, { requester: ALICE });
  assert.equal(stop.kind, 'host', stop.reason);
  assert.equal(stop.host?.hostId, 'ops-box');
});
