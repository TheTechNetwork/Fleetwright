// Signing an engine in on a machine, in the coordinator (docs/engines.md,
// "Signing in on the machine"): what it refuses in a person's words before
// anything is sent, what it passes on, who is shown which machine's
// sign-ins, and who is told when an attempt ends.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorCore } from '../src/fleet/coordinator/core.js';
import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const eli = { email: 'eli@example.com', admin: true };

/** A fleet with the boxes given, each speaking a protocol and reporting engines, and the agent Debbie. */
function fleet(/** @type {Array<[string, number, string[]|undefined]>} */ boxes) {
  const core = new CoordinatorCore({});
  assert.equal(core.setMember(eli, 'eli', { name: 'Eli', kind: 'person', email: eli.email, role: 'owner' }).ok, true);
  assert.equal(core.setMember(eli, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'eli', engines: [{ engine: 'codex' }] }).ok, true);
  for (const [hostId, protocol, runs] of boxes) {
    core.registry.connect(hostId, () => {});
    core.registry.recordHealth(hostId, { hub: { reachable: true }, protocol, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [], ...(runs ? { engines: runs } : {}) });
  }
  /** @type {Array<{ hostId: string, verb: string, params: any }>} */
  const sent = [];
  /** What the box answers; a test replaces it. @type {{ reply: any }} */
  const box = { reply: { ok: true, state: 'waiting', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', text: 'Open the page.' } };
  core.send = /** @type {any} */ (async (/** @type {any} */ host, /** @type {any} */ spec) => {
    sent.push({ hostId: host.hostId, verb: spec.verb, params: spec.params });
    return { ...box.reply, hostId: host.hostId };
  });
  const signin = (/** @type {string} */ host, /** @type {any} */ params = {}, /** @type {any} */ who = eli) =>
    core.dispatch({ verb: 'enginesignin', params: { member: 'debbie', engine: 'codex', action: 'start', ...params }, actor: who.email, requester: who, ...(host ? { preferHost: host } : {}) });
  return { core, sent, box, signin };
}

test('a box older than protocol 22 is refused a sign-in by name, as a machine to update, and is sent nothing', async () => {
  const { sent, signin } = fleet([['box-21', 21, ['claude-code', 'codex']], ['box-22', PROTOCOL_VERSION, ['claude-code', 'codex']]]);
  for (const action of ['start', 'status', 'cancel', 'signout']) {
    const r = await signin('box-21', { action });
    assert.equal(r.error?.code, 'host_outdated', action);
    assert.equal(r.text, 'box-21 is too old to sign an engine in. It speaks protocol 21, and this needs 22. Update fleetwright on box-21, or pick another machine.');
  }
  assert.deepEqual(sent, []);
  const now = await signin('box-22');
  assert.equal(now.ok, true, now.text);
  assert.deepEqual(sent, [{ hostId: 'box-22', verb: 'enginesignin', params: { member: 'debbie', engine: 'codex', action: 'start' } }]);
});

const dana = { email: 'dana@example.com', admin: false };
const here = [['ops-box', PROTOCOL_VERSION, ['claude-code', 'codex']]];

test('no such member, somebody who may not act for it, and a fleet that cannot tell who may are refused in the person’s words, and nothing is sent', async () => {
  const { core, sent, signin } = fleet(/** @type {any} */ (here));
  // NOBODY HAS SAID WHO MAY YET. An admin's is passed on for the box to decide; anybody else's is not.
  const early = await signin('ops-box', {}, dana);
  assert.equal(early.error?.code, 'custody_unknown');
  assert.equal(early.text, 'This fleet has no vault to say who may sign an engine in for Debbie, so it cannot tell whether you may, and no machine would do it. Nothing was sent.');
  assert.equal((await signin('ops-box')).ok, true);
  sent.length = 0;

  core.memberCustody = new Map([['debbie', [eli.email]], ['eli', [eli.email]]]);
  for (const action of ['start', 'status', 'cancel', 'signout']) {
    const r = await signin('ops-box', { action }, dana);
    assert.equal(r.error?.code, 'not_custodian', action);
    assert.equal(r.text, 'You are not one of Debbie’s custodians, so you cannot sign an engine in for it. A custodian can add you from its Credentials.');
  }
  // A person's own engines are theirs and their managers' to sign in.
  assert.equal((await signin('ops-box', { member: 'eli' }, dana)).text, 'Only Eli, and managers Eli has let manage their credentials, can sign an engine in for them.');
  const ghost = await signin('ops-box', { member: 'ghost' });
  assert.deepEqual([ghost.error?.code, ghost.text], ['no_member', 'There is no member called ghost. fleet_members lists them.']);
  // No member at all is nobody's engine, and the refusal says what to name.
  const whose = await core.dispatch({ verb: 'enginesignin', params: { engine: 'codex', action: 'start' }, actor: eli.email, requester: eli, preferHost: 'ops-box' });
  assert.deepEqual([whose.error?.code, whose.text], ['bad_params', 'Say whose engine this is: an engine is signed in for a member, by its id. To sign in your own, name your own member record. fleet_members lists them.']);
  // The break-glass token names nobody, and a sign-in is made by somebody.
  assert.equal((await core.dispatch({ verb: 'enginesignin', params: { member: 'debbie', engine: 'codex', action: 'start' }, preferHost: 'ops-box' })).error?.code, 'not_signed_in');
  assert.deepEqual(sent, []);
  // The custodian's own is sent, as it was asked, and the box's answer comes back whole.
  const ok = await signin('ops-box');
  assert.deepEqual([ok.ok, ok.state, ok.url, ok.code, ok.hostId], [true, 'waiting', 'https://auth.openai.com/codex/device', 'ABCD-EFGH', 'ops-box']);
  assert.deepEqual(sent, [{ hostId: 'ops-box', verb: 'enginesignin', params: { member: 'debbie', engine: 'codex', action: 'start' } }]);
});

test('a machine that says which engines it runs, and not this one, is refused before anything is sent; one that said nothing is asked', async () => {
  const { sent, signin } = fleet([['plain', PROTOCOL_VERSION, ['claude-code']], ['codex-only', PROTOCOL_VERSION, ['claude-code', 'codex']], ['silent', PROTOCOL_VERSION, undefined]]);
  for (const action of ['start', 'status', 'cancel', 'signout']) {
    const r = await signin('plain', { action });
    assert.equal(r.error?.code, 'no_engine', action);
    assert.equal(r.text, 'plain does not run Codex. It runs Claude Code. Sign Codex in on a machine that runs it.');
  }
  assert.equal((await signin('codex-only', { engine: 'opencode' })).text, 'codex-only does not run OpenCode. It runs Claude Code, Codex. Sign OpenCode in on a machine that runs it.');
  assert.deepEqual(sent, []);
  // Cannot tell is not a no: the machine answers for itself.
  assert.equal((await signin('silent')).ok, true);
  assert.deepEqual(sent.map((s) => s.hostId), ['silent']);
});

test('the machine is named, never chosen: several say which run the engine, and a temporary one or somebody else’s box is not where a sign-in is kept', async () => {
  const { core, sent, signin } = fleet([['ops-a', PROTOCOL_VERSION, ['claude-code', 'codex']], ['ops-b', PROTOCOL_VERSION, ['claude-code']], ['ops-c', PROTOCOL_VERSION, ['claude-code', 'codex']]]);
  const which = await signin('');
  assert.equal(which.error?.code, 'ambiguous_host');
  assert.equal(which.text, 'Which machine should it be signed in on? ops-a, ops-c. A sign-in is kept on the machine it is made on, and used by sessions there.');
  const gone = await signin('ops-z');
  assert.deepEqual([gone.error?.code, gone.error?.why], ['host_unavailable', 'offline']);
  assert.match(String(gone.text), /^ops-z is not a connected permanent machine\. These are: ops-a, ops-b, ops-c\.$/);
  // A runner, and a box Dana enrolled for herself.
  const health = { hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [], engines: ['claude-code', 'codex'] };
  core.registry.connect('gha-runner', () => {}, { ephemeral: true, owner: eli.email, actsFor: eli.email });
  core.registry.recordHealth('gha-runner', health);
  core.registry.connect('danas-box', () => {}, { actsFor: dana.email });
  core.registry.recordHealth('danas-box', health);
  const temporary = await signin('gha-runner');
  assert.equal(temporary.error?.code, 'host_unavailable');
  assert.match(String(temporary.text), /^gha-runner is a temporary machine\. A sign-in is kept on the machine it is made on, and that one is gone within hours\./);
  const theirs = await signin('danas-box');
  assert.deepEqual([theirs.error?.code, theirs.error?.why], ['host_unavailable', 'enrolled_by_other']);
  // With where it can be done, as the other refusals here say: whose machine it is names the problem and not the way on.
  assert.equal(theirs.text, 'danas-box acts for the person who enrolled it, and keeps nobody else’s sign-ins. Sign in on a machine that acts for you: ops-a, ops-b, ops-c.');
  assert.deepEqual(sent, []);
});

test('the same id again while the machine is still answering the first is told to wait, in those words, and nothing is sent twice', async () => {
  // A start waits up to 45 seconds for the engine's code. Its retry was
  // answered `host_timeout`, "an intent with id … is already in flight": a
  // timeout that was none, and nothing to do about it.
  const core = new CoordinatorCore({ intentTimeoutMs: 2_000 });
  core.setMember(eli, 'eli', { name: 'Eli', kind: 'person', email: eli.email, role: 'owner' });
  core.setMember(eli, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'eli' });
  /** Every frame the box was sent. @type {any[]} */
  const frames = [];
  core.registry.connect('ops-box', (/** @type {any} */ frame) => { frames.push(frame); });
  core.registry.recordHealth('ops-box', { hub: { reachable: true }, protocol: PROTOCOL_VERSION, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [], engines: ['claude-code', 'codex'] });
  const ask = (/** @type {string} */ id) => core.dispatch({ verb: 'enginesignin', params: { member: 'debbie', engine: 'codex', action: 'start' }, id, actor: eli.email, requester: eli, preferHost: 'ops-box' });
  const first = ask('app-0000-same-id');
  await new Promise((r) => setTimeout(r, 20));
  const retry = await ask('app-0000-same-id');
  assert.deepEqual([retry.ok, retry.error?.code], [false, 'in_flight']);
  // With a next step for a caller whose first request was given up on, who has no answer to wait for.
  assert.equal(retry.text, 'ops-box is still answering the request sent under this id, so nothing new was sent. If that request is still open, its answer is the one to wait for. If it was given up on, ask again in a few seconds: once ops-box has answered, the same id is answered with where the sign-in stands. Asking again does not start a second sign-in.');
  assert.equal(frames.length, 1);
  // The first is answered as it would have been, and the id is then free for the box's own cache to answer a retry.
  await core.onHostMessage('ops-box', { v: PROTOCOL_VERSION, kind: 'reply', id: 'app-0000-same-id', ok: true, state: 'waiting', text: 'A code is out.' });
  assert.deepEqual([(await first).ok, (await first).state], [true, 'waiting']);
  void ask('app-0000-same-id').catch(() => {});
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(frames.length, 2);
  await core.onHostMessage('ops-box', { v: PROTOCOL_VERSION, kind: 'reply', id: 'app-0000-same-id', ok: true, state: 'waiting', replayed: true, text: 'A code is out.' });
});

test('asking where a sign-in stands is not written to the fleet’s record, and the other three are, by what was asked for whom', async () => {
  const { core, signin } = fleet(/** @type {any} */ (here));
  for (const action of ['start', 'status', 'status', 'cancel', 'signout', 'status']) await signin('ops-box', { action });
  const asked = core.recentEvents(null).filter((/** @type {any} */ e) => e.verb === 'enginesignin').map((/** @type {any} */ e) => e.text);
  assert.deepEqual(asked, [
    'eli@example.com asked for enginesignin start of codex for debbie',
    'eli@example.com asked for enginesignin cancel of codex for debbie',
    'eli@example.com asked for enginesignin signout of codex for debbie',
  ]);
  // The page and the code a box answered with are in none of it.
  assert.doesNotMatch(JSON.stringify(core.recentEvents(null)), /ABCD-EFGH|auth\.openai\.com/);
});

test('what a machine reports of sign-ins is shown to who may act for that member, from a box that may act for them, and never from a box older than the verb', () => {
  const { core } = fleet([['ops-box', PROTOCOL_VERSION, ['claude-code', 'codex']], ['old-box', 21, ['claude-code', 'codex']], ['quiet-box', PROTOCOL_VERSION, ['claude-code', 'codex']]]);
  assert.equal(core.setMember(eli, 'jason', { name: 'Jason', kind: 'agent', role: 'reviewer' }).ok, true);
  assert.equal(core.setMember(eli, 'dana', { name: 'Dana', kind: 'person', email: dana.email, role: 'engineer' }).ok, true);
  core.registry.connect('danas-box', () => {}, { actsFor: dana.email });
  const at = Date.UTC(2026, 10, 25, 10);
  const health = (/** @type {number} */ protocol, /** @type {any} */ engineSignins) => ({ hub: { reachable: true }, protocol, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [], engines: ['claude-code', 'codex'], ...(engineSignins ? { engineSignins } : {}) });
  const said = [
    { member: 'debbie', engine: 'codex', since: at },
    { member: 'jason', engine: 'opencode', since: at + 1 },
    // Not what a box sends: left out for everybody, with whatever else rode along.
    { member: 'debbie', engine: 'claude-code', since: at }, { member: 'Not An Id', engine: 'codex', since: at }, { member: 'jason', engine: 'codex', since: 'yesterday' },
    { member: 'dana', engine: 'codex', since: at + 2, code: 'ABCD-EFGH', who: { email: 'someone@example.com' } },
  ];
  core.registry.recordHealth('ops-box', health(PROTOCOL_VERSION, said));
  core.registry.recordHealth('old-box', health(21, said));
  core.registry.recordHealth('quiet-box', health(PROTOCOL_VERSION, null));
  // A box Dana enrolled says Debbie is signed in on it: its word reaches Dana, about members she may act for.
  core.registry.recordHealth('danas-box', health(PROTOCOL_VERSION, [{ member: 'debbie', engine: 'codex', since: at }, { member: 'dana', engine: 'codex', since: at }]));
  // Dana may start as herself. Jason's custodian is Eli; Debbie's are Eli and nobody else.
  core.memberCustody = new Map([['debbie', [eli.email]], ['jason', [eli.email]], ['dana', [dana.email]]]);
  const seenBy = (/** @type {any} */ who) => Object.fromEntries(core.snapshot(who).hosts.map((/** @type {any} */ h) => [h.hostId, h.health?.engineSignins]));
  const whole = [{ member: 'debbie', engine: 'codex', since: at }, { member: 'jason', engine: 'opencode', since: at + 1 }, { member: 'dana', engine: 'codex', since: at + 2 }];
  // An admin sees what each box said, shaped. Absent is cannot tell: a box older than the verb, and one that sent no list.
  assert.deepEqual(seenBy(eli), { 'ops-box': whole, 'old-box': undefined, 'quiet-box': undefined, 'danas-box': [{ member: 'debbie', engine: 'codex', since: at }, { member: 'dana', engine: 'codex', since: at }] });
  // Dana sees her own, and nothing of the agents she is no custodian of.
  assert.deepEqual(seenBy(dana), { 'ops-box': [{ member: 'dana', engine: 'codex', since: at + 2 }], 'old-box': undefined, 'quiet-box': undefined, 'danas-box': [{ member: 'dana', engine: 'codex', since: at }] });
  // Somebody with no member to act for is shown that the box answered, and none of it.
  assert.deepEqual(seenBy({ email: 'guest@example.com', admin: false })['ops-box'], []);
  // And a box somebody else enrolled says nothing to anybody it does not act for, whoever it names.
  core.memberCustody = new Map([['debbie', [eli.email, 'sam@example.com']]]);
  assert.deepEqual(seenBy({ email: 'sam@example.com', admin: false }), { 'ops-box': [{ member: 'debbie', engine: 'codex', since: at }], 'old-box': undefined, 'quiet-box': undefined, 'danas-box': [] });
});

test('when an attempt ends the member’s custodians are told by name on their own phones, a cancel is told to nobody, and the feed gets nothing', async () => {
  /** @type {any[]} */
  const sends = [];
  const core = new CoordinatorCore({ push: /** @type {any} */ ({ async send(/** @type {any[]} */ devices, /** @type {any} */ message) { sends.push({ to: devices.map((d) => d.actor).sort(), message }); return { sent: devices.length, dead: [] }; } }) });
  core.setMember(eli, 'eli', { name: 'Eli', kind: 'person', email: eli.email, role: 'owner' });
  core.setMember(eli, 'debbie', { name: 'Debbie', kind: 'agent', role: 'software engineer', reportsTo: 'eli' });
  // Eli and Dana are Debbie's custodians. The other admin is not, and is told nothing.
  for (const [email, admin, token] of /** @type {Array<[string, boolean, string]>} */ ([[eli.email, true, 'a'], [dana.email, false, 'b'], ['ops@example.com', true, 'c'], ['sam@example.com', false, 'd']])) {
    const { client } = /** @type {any} */ (await core.clients.issue(`phone (${email})`, { admin, email }));
    await core.registerDevice({ platform: 'ios', token: token.repeat(64), clientId: client.id, actor: `fleet:${email}` });
  }
  core.memberCustody = new Map([['debbie', [eli.email, dana.email]]]);
  const health = (/** @type {number} */ protocol) => ({ hub: { reachable: true }, protocol, maxSessions: 5, running: 0, free: 5, labels: [], sandboxed: true, sessions: [], engines: ['claude-code', 'codex'] });
  core.registry.connect('ops-box', () => {});
  core.registry.recordHealth('ops-box', health(PROTOCOL_VERSION));
  const says = (/** @type {string} */ hostId, /** @type {any} */ event) => core.onHostMessage(hostId, { kind: 'event', event: 'engine.signin', member: 'debbie', engine: 'codex', at: Date.now(), ...event });
  const before = core.recentEvents(null).length;

  await says('ops-box', { state: 'signed_in', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', text: 'whatever the box wrote', who: 'someone@example.com' });
  assert.deepEqual(sends, [{
    to: [`fleet:${dana.email}`, `fleet:${eli.email}`],
    message: { title: 'Debbie’s Codex sign-in', body: 'Codex is signed in for Debbie on ops-box.', data: { event: 'engine.signin', name: '', hostId: 'ops-box', url: '', member: 'debbie', engine: 'codex', state: 'signed_in' } },
  }]);
  // The same news twice is said once.
  await says('ops-box', { state: 'signed_in' });
  assert.equal(sends.length, 1);
  // Each way an attempt, or a sign-in, ends, in this coordinator's sentence.
  const sentences = {
    expired: 'The Codex sign-in for Debbie on ops-box ran out before anybody approved it. Start again for a new code.',
    failed: 'The Codex sign-in for Debbie on ops-box did not complete. Debbie’s Credentials says why.',
    lost: 'ops-box restarted while a Codex sign-in for Debbie was waiting. Start it again.',
    signed_out: 'Codex was signed out for Debbie on ops-box.',
    ended: 'Codex’s sign-in for Debbie on ops-box no longer works. Sign it in again from Debbie’s Credentials.',
  };
  for (const [state, body] of Object.entries(sentences)) {
    await says('ops-box', { state, detail: 'the engine’s own words, which a box does not send and this would not carry' });
    assert.equal(sends.at(-1).message.body, body, state);
  }
  const told = sends.length;
  // A cancel is told to nobody: whoever cancelled is looking at it.
  await says('ops-box', { state: 'cancelled' });
  // Nor what is not a sign-in ending, a member this fleet has no record of, or an engine a machine does not sign in.
  await says('ops-box', { state: 'waiting' });
  await says('ops-box', { state: 'signed_in', member: 'ghost' });
  await says('ops-box', { state: 'signed_in', engine: 'claude-code' });
  // Nor a box older than the verb, or one that is not this fleet's.
  core.registry.connect('old-box', () => {});
  core.registry.recordHealth('old-box', health(21));
  await says('old-box', { state: 'expired' });
  await says('nobody-knows', { state: 'expired' });
  // A box Sam enrolled speaks to Sam alone, and Sam is no custodian of Debbie.
  core.registry.connect('sams-box', () => {}, { actsFor: 'sam@example.com' });
  core.registry.recordHealth('sams-box', health(PROTOCOL_VERSION));
  await says('sams-box', { state: 'expired' });
  assert.equal(sends.length, told);
  // AND NOT THE FEED: nothing was written where every phone reads, and no code or page anywhere.
  assert.equal(core.recentEvents(null).length, before);
  assert.doesNotMatch(JSON.stringify(sends), /ABCD-EFGH|auth\.openai\.com|someone@example\.com|whatever the box wrote/);
});
