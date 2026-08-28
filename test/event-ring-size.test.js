// The event ring must fit in one Durable Object storage value.
//
// DO storage refuses values over 128KiB. The ring is capped by COUNT (200), and
// a count is not a size: events carry up to 500 chars of text and 500 of url,
// so a full ring of chatty events is ~220KB. storage.put rejects, the rejection
// was unhandled, and an unhandled rejection aborts the whole object -- every
// host socket resets, every in-flight phone request dies. A fleet-wide outage
// caused by failing to persist a log line, arriving weeks after the code
// shipped, on a day nothing was deployed.
//
// These tests pin the serialiser's promise: whatever is in the ring, what gets
// written fits.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The same trimming #saveEvents does, extracted here as the contract.
function fitForStorage(all) {
  let events = all.slice(-200);
  while (events.length > 1 && JSON.stringify(events).length > 100_000) {
    events = events.slice(Math.ceil(events.length / 2));
  }
  return events;
}

const bigEvent = (i) => ({
  hostId: 'host-' + i,
  event: 'session.awaiting-input',
  name: 'session-' + i,
  text: 'x'.repeat(500),
  url: 'https://example.com/' + 'y'.repeat(480),
  at: 1_700_000_000_000 + i,
});

test('a ring of maximum-size events serialises under the DO limit', () => {
  const events = fitForStorage(Array.from({ length: 200 }, (_, i) => bigEvent(i)));
  const bytes = JSON.stringify(events).length;
  assert.ok(bytes <= 100_000, `${bytes} bytes -- would be refused by DO storage`);
  assert.ok(events.length > 0, 'trimming must keep something');
});

test('trimming drops the OLDEST, because a waking phone asks for the recent', () => {
  const events = fitForStorage(Array.from({ length: 200 }, (_, i) => bigEvent(i)));
  assert.equal(events[events.length - 1].at, bigEvent(199).at);
});

test('a small ring is written whole', () => {
  const all = Array.from({ length: 40 }, (_, i) => ({ event: 'e', at: i }));
  assert.equal(fitForStorage(all).length, 40);
});

test('even one absurd event does not loop forever', () => {
  const events = fitForStorage([{ event: 'e', text: 'z'.repeat(400_000), at: 1 }]);
  assert.equal(events.length, 1); // cannot shrink below one; the catch upstream owns that case
});
