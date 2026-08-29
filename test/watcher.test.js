// The session watcher: noticing that a session needs a person.
//
//   node --test test/
//
// The behaviour worth pinning is what it does NOT do. A session parked at a
// prompt for an hour must produce one notification, not 180 — a phone that
// cries wolf gets its notifications turned off, which costs you the one that
// mattered.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SessionWatcher } from '../src/fleet/host/watcher.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { startStubHub, sessionRecord } from './helpers/stub-hub.js';

const RESUME_DIALOG = [
  'This session is 6d 12h old and 347.8k tokens.',
  '  > 1. Resume from summary (recommended)',
  '    2. Resume full session as-is',
].join('\n');

/**
 * @param {import('node:test').TestContext} t
 * @param {object} [hubOpts]
 */
async function watcherFor(t, hubOpts = {}) {
  const stub = await startStubHub(hubOpts);
  t.after(() => stub.close());
  /** @type {Record<string, any>[]} */
  const events = [];
  const watcher = new SessionWatcher({
    hub: new HubClient({ baseUrl: stub.baseUrl, readTimeoutMs: 2000 }),
    emit: (e) => events.push(e),
  });
  return { stub, watcher, events };
}

test('the first pass is quiet, because a restart is not news', async (t) => {
  // Everything is "new" when the sidecar starts. Announcing all of it would
  // mean a notification storm every time the service is restarted.
  const { watcher, events } = await watcherFor(t, {
    sessions: [sessionRecord('live', { status: 'running' })],
    panes: { live: RESUME_DIALOG },
  });

  await watcher.tick({ quiet: true });

  assert.deepEqual(events, []);
});

test('a session that starts waiting produces exactly one event', async (t) => {
  const { stub, watcher, events } = await watcherFor(t, {
    sessions: [sessionRecord('live', { status: 'running' })],
    panes: { live: 'working away, nothing to see' },
  });
  await watcher.tick({ quiet: true });

  stub.panes.live = RESUME_DIALOG;
  await watcher.tick();
  await watcher.tick();
  await watcher.tick();

  const waiting = events.filter((e) => e.event === 'session.awaiting-input');
  assert.equal(waiting.length, 1, 'the transition is the event, not the state');
  assert.equal(waiting[0].name, 'live');
});

test('answering the prompt and hitting another one notifies again', async (t) => {
  // Deduplication must not become "tell me once, ever".
  const { stub, watcher, events } = await watcherFor(t, {
    sessions: [sessionRecord('live', { status: 'running' })],
    panes: { live: 'busy' },
  });
  await watcher.tick({ quiet: true });

  stub.panes.live = RESUME_DIALOG;
  await watcher.tick();
  stub.panes.live = 'busy again';
  await watcher.tick();
  stub.panes.live = 'Do you want to proceed?';
  await watcher.tick();

  assert.equal(events.filter((e) => e.event === 'session.awaiting-input').length, 2);
});

test('a session that ends is reported once', async (t) => {
  const { stub, watcher, events } = await watcherFor(t, {
    sessions: [sessionRecord('live', { status: 'running' })],
    panes: { live: 'busy' },
  });
  await watcher.tick({ quiet: true });

  stub.sessions[0].status = 'stopped';
  delete stub.panes.live;
  await watcher.tick();
  await watcher.tick();

  const ended = events.filter((e) => e.event === 'session.ended');
  assert.equal(ended.length, 1);
  assert.equal(ended[0].name, 'live');
});

test('a session that errors is an error, not an ordinary ending', async (t) => {
  const { stub, watcher, events } = await watcherFor(t, {
    sessions: [sessionRecord('live', { status: 'running' })],
    panes: { live: 'busy' },
  });
  await watcher.tick({ quiet: true });

  stub.sessions[0].status = 'error';
  stub.sessions[0].detail = 'session exited immediately';
  delete stub.panes.live;
  await watcher.tick();

  const [event] = events;
  assert.equal(event.event, 'session.error');
  assert.match(event.text, /exited immediately/);
});

test('Remote Control coming online is announced with its URL', async (t) => {
  // The one event that is useful rather than urgent: it is the moment the
  // session becomes drivable from the phone that just got the notification.
  const { stub, watcher, events } = await watcherFor(t, {
    sessions: [sessionRecord('live', { status: 'running' })],
    panes: { live: 'starting up' },
  });
  await watcher.tick({ quiet: true });

  stub.panes.live = '/remote-control is active · Continue here, on your phone, or at\nhttps://claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M';
  await watcher.tick();
  await watcher.tick();

  const rc = events.filter((e) => e.event === 'session.rc-online');
  assert.equal(rc.length, 1, 'once, not on every poll');
  assert.equal(rc[0].url, 'https://claude.ai/code/session_016zfBs7LYmQwg7WqfD6dY3M');
});

test('the hub being unreachable is not an event, and forgets nothing', async (t) => {
  // The hub going down is already reported through health. If it cleared what
  // we know, every session would "start" again when it came back.
  const stub = await startStubHub({
    sessions: [sessionRecord('live', { status: 'running' })],
    panes: { live: 'busy' },
  });
  /** @type {Record<string, any>[]} */
  const events = [];
  const watcher = new SessionWatcher({
    hub: new HubClient({ baseUrl: stub.baseUrl, readTimeoutMs: 500 }),
    emit: (e) => events.push(e),
  });
  await watcher.tick({ quiet: true });
  await stub.close();

  await watcher.tick();

  assert.deepEqual(events, [], 'a hub outage is not a session event');
  assert.ok(watcher.seen.has('live'), 'and it must not forget what it knew');
});

test('a forgotten session is dropped, so a reused name is not a stale ending', async (t) => {
  const { stub, watcher } = await watcherFor(t, {
    sessions: [sessionRecord('gone', { status: 'running' })],
    panes: { gone: 'busy' },
  });
  await watcher.tick({ quiet: true });

  stub.sessions.length = 0;
  await watcher.tick();

  assert.equal(watcher.seen.has('gone'), false);
});

// --- restarting a session that stopped moving -------------------------------
//
// "Auto restart sessions that are idle." The useful case is a session that
// wedged overnight, where the fix is mechanical and nobody was awake to do it.
// Every test below is about a case where it must NOT fire, because the cost of
// the two mistakes is not symmetric: a wedged session recovers an hour later
// than it might have, and a restarted one loses work that was happening.

/**
 * @param {import('node:test').TestContext} t
 * @param {object} hubOpts
 * @param {number} idleRestartMs
 */
async function restartingWatcherFor(t, hubOpts, idleRestartMs) {
  const stub = await startStubHub(hubOpts);
  t.after(() => stub.close());
  /** @type {Record<string, any>[]} */
  const events = [];
  const watcher = new SessionWatcher({
    hub: new HubClient({ baseUrl: stub.baseUrl, readTimeoutMs: 2000 }),
    emit: (e) => events.push(e),
    idleRestartMs,
  });
  return { stub, watcher, events };
}

/** Pretend the pane has been frozen for `ms`. @param {SessionWatcher} w @param {string} name @param {number} ms */
function frozenFor(w, name, ms) {
  const entry = w.idle.get(name);
  if (entry) entry.since = Date.now() - ms;
}

test('a session frozen past the threshold is stopped and resumed', async (t) => {
  const { stub, watcher, events } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('wedged', { status: 'running' })], panes: { wedged: 'nothing has happened for hours' } },
    60 * 60_000,
  );
  await watcher.tick({ quiet: true });
  frozenFor(watcher, 'wedged', 90 * 60_000);

  await watcher.tick();

  // Stop then resume, rather than anything cleverer: resume is the path that
  // keeps the conversation, and it is the one a person would use.
  assert.deepEqual(stub.commands, ['/stop wedged', '/resume wedged summary']);
  const said = events.filter((e) => e.event === 'session.restarted');
  assert.equal(said.length, 1, 'a fleet that quietly restarts things is one nobody can debug');
  assert.match(said[0].text, /conversation was kept/);
});

test('a session waiting at a prompt is never restarted, however long it waits', async (t) => {
  // THE ONE THAT WOULD HURT. A pane waiting for an answer is perfectly still
  // and is the most active thing in the fleet — somebody has to answer it.
  // Restarting throws the question away, and the person about to answer never
  // learns why.
  const { stub, watcher } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('asking', { status: 'running' })], panes: { asking: RESUME_DIALOG } },
    60 * 60_000,
  );
  await watcher.tick({ quiet: true });
  frozenFor(watcher, 'asking', 24 * 60 * 60_000);

  await watcher.tick();

  assert.deepEqual(stub.commands, [], 'the question was still there to answer');
});

test('a session that is still moving is left alone', async (t) => {
  const { stub, watcher } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('busy', { status: 'running' })], panes: { busy: 'tick 1' } },
    60 * 60_000,
  );
  await watcher.tick({ quiet: true });
  stub.panes.busy = 'tick 2';

  await watcher.tick();

  assert.deepEqual(stub.commands, []);
});

test('zero minutes means off, which is a supported answer', async (t) => {
  const { stub, watcher } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('wedged', { status: 'running' })], panes: { wedged: 'frozen' } },
    0,
  );
  await watcher.tick({ quiet: true });
  frozenFor(watcher, 'wedged', 999 * 60_000);

  await watcher.tick();

  assert.deepEqual(stub.commands, []);
});

test('a session that goes straight back to idle is given up on, out loud', async (t) => {
  // A session idle because it is BROKEN comes back broken. A restarter with no
  // memory sits in that loop indefinitely — burning a slot, and doing it
  // silently, which is worse.
  const { stub, watcher, events } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('broken', { status: 'running' })], panes: { broken: 'same as it ever was' } },
    60 * 60_000,
  );
  await watcher.tick({ quiet: true });

  for (let i = 0; i < 5; i++) {
    frozenFor(watcher, 'broken', 90 * 60_000);
    await watcher.tick();
  }

  const restarts = stub.commands.filter((c) => c.startsWith('/stop'));
  assert.equal(restarts.length, 2, 'twice, then it stops — a third try only delays somebody finding out');
  const gaveUp = events.filter((e) => e.event === 'session.stuck');
  assert.equal(gaveUp.length, 1);
  // Says what happens next, which is nothing. A message that only reports a
  // failure leaves somebody waiting for a retry that is not coming.
  assert.match(gaveUp[0].text, /Not trying again/);
});

test('a restart that works resets the budget, so next week it may restart again', async (t) => {
  // The count is cleared when the pane MOVES, not on a timer, so the limit
  // counts restarts that did not help rather than restarts. A long-lived
  // session that wedges once a week is not the same problem as one that
  // wedges every time it comes up.
  const { stub, watcher } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('flaky', { status: 'running' })], panes: { flaky: 'frozen' } },
    60 * 60_000,
  );
  await watcher.tick({ quiet: true });

  frozenFor(watcher, 'flaky', 90 * 60_000);
  await watcher.tick();

  // Moving again, a full idle window later — which is what recovery means
  // here. A pane that moved one tick after the restart proves nothing: the
  // restart is what moved it.
  stub.panes.flaky = 'moving again after the restart';
  const restarted = watcher.restarts.get('flaky');
  if (restarted) restarted.at = Date.now() - 90 * 60_000;
  await watcher.tick();

  frozenFor(watcher, 'flaky', 90 * 60_000);
  await watcher.tick();
  frozenFor(watcher, 'flaky', 90 * 60_000);
  await watcher.tick();

  assert.equal(stub.commands.filter((c) => c.startsWith('/stop')).length, 3);
  assert.equal(watcher.restarts.get('flaky')?.count, 2, 'the budget started again, it did not carry over');
});

// --- the state that broke it in production ----------------------------------
//
// Reported from a phone within a day of auto-restart shipping, as three
// notifications arriving together:
//
//   cc-brave-narwhal on deb132 — finished
//   Restarted after 60 minutes with nothing happening. The conversation was kept.
//   Restarted 2 times and it went straight back to idle. Not trying again.
//
// Every one of them was wrong in its own way, and the first is the one that
// mattered: the session had FINISHED. A session that completed its work sits
// at the input prompt forever, and a pane at an input prompt does not change —
// so by the only measurement the watcher had, "done" and "wedged" were the
// same thing. They are opposites.

/** A pane showing Claude Code ready and waiting — the ordinary finished state. */
const AT_REST = ['❯ ', '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'].join('\n');

test('a session that has finished is never restarted, however long it sits', async (t) => {
  // THE PRODUCTION BUG. Done is the most common state in the fleet and needs
  // nothing; wedged is rare and is the whole reason the feature exists.
  // Restarting a finished session puts it back at the same prompt — which is
  // exactly what "went straight back to idle" was reporting, the mechanism
  // working perfectly on a question nobody asked.
  const { stub, watcher, events } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('done', { status: 'running' })], panes: { done: AT_REST } },
    60 * 60_000,
  );
  await watcher.tick({ quiet: true });
  frozenFor(watcher, 'done', 24 * 60 * 60_000);

  await watcher.tick();
  await watcher.tick();

  assert.deepEqual(stub.commands, [], 'a finished session was restarted');
  assert.deepEqual(events.filter((e) => e.event === 'session.restarted'), []);
});

test('a pane frozen mid-work, with no prompt on it, still restarts', async (t) => {
  // The narrowing must not turn the feature off. What is left after excluding
  // "waiting for an answer" and "waiting for you" is a pane stopped in the
  // middle of something, which is the case worth acting on.
  const { stub, watcher } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('wedged', { status: 'running' })], panes: { wedged: 'Running tests…' } },
    60 * 60_000,
  );
  await watcher.tick({ quiet: true });
  frozenFor(watcher, 'wedged', 90 * 60_000);

  await watcher.tick();

  assert.deepEqual(stub.commands, ['/stop wedged', '/resume wedged summary']);
});

test('our own stop is not announced as the session finishing', async (t) => {
  // "cc-brave-narwhal on deb132 — finished". It had not finished; we ended it
  // one second earlier, on purpose. Telling somebody their session finished
  // when we stopped it ourselves is the kind of small lie that costs the whole
  // surface its credibility.
  const { stub, watcher, events } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('wedged', { status: 'running' })], panes: { wedged: 'Running tests…' } },
    60 * 60_000,
  );
  await watcher.tick({ quiet: true });
  frozenFor(watcher, 'wedged', 90 * 60_000);
  await watcher.tick();

  // The resume did not take, so the next tick sees it stopped — which is the
  // path that produced the phantom "finished".
  stub.sessions[0].status = 'stopped';
  await watcher.tick();

  assert.deepEqual(events.filter((e) => e.event === 'session.ended'), []);
});

test('an error still gets through, because that is not our doing', async (t) => {
  // The suppression is about OUR action, not about silence. A session that
  // errored while we were restarting it is a fact about the session.
  const { stub, watcher, events } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('wedged', { status: 'running' })], panes: { wedged: 'Running tests…' } },
    60 * 60_000,
  );
  await watcher.tick({ quiet: true });
  frozenFor(watcher, 'wedged', 90 * 60_000);
  await watcher.tick();

  stub.sessions[0].status = 'error';
  await watcher.tick();

  assert.equal(events.filter((e) => e.event === 'session.error').length, 1);
});

test('hitting the cap is one notification, not two', async (t) => {
  // These were separate events, so the last restart sent both "Restarted after
  // 60 minutes with nothing happening" and "Restarted 2 times and it went
  // straight back to idle" — together, the second contradicting the tone of
  // the first, for one decision. An interruption costs far more than the time
  // it takes to read; spending two on one event spends one against the person.
  const { watcher, events } = await restartingWatcherFor(
    t,
    { sessions: [sessionRecord('broken', { status: 'running' })], panes: { broken: 'Running tests…' } },
    60 * 60_000,
  );
  await watcher.tick({ quiet: true });

  for (let i = 0; i < 4; i++) {
    frozenFor(watcher, 'broken', 90 * 60_000);
    await watcher.tick();
  }

  const said = events.filter((e) => e.event === 'session.restarted' || e.event === 'session.stuck');
  assert.equal(said.length, 2, 'two restarts, two messages — one each, never two for one');
  assert.equal(said[0].event, 'session.restarted');
  assert.equal(said[1].event, 'session.stuck');
  assert.match(said[1].text, /Not trying again/);
});
