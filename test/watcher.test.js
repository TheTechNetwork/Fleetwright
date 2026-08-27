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
