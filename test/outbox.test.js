// The rules a device-side queue has to hold to, asserted against both apps.
//
// Neither app compiles here, so this reads their source. That is a weaker check
// than running them and a much stronger one than nothing: every rule below is a
// property somebody could delete in one line while the app still built, and
// three of them are the difference between "held safely" and "did it twice".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const swift = readFileSync(new URL('../apps/ios/Fleetwright/Outbox.swift', import.meta.url), 'utf8');
const kotlin = readFileSync(
  new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/Outbox.kt', import.meta.url),
  'utf8',
);
const swiftFleet = readFileSync(new URL('../apps/ios/Fleetwright/Fleet.swift', import.meta.url), 'utf8');
const kotlinFleet = readFileSync(
  new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/Fleet.kt', import.meta.url),
  'utf8',
);

test('a queue never holds a verb that carries a credential', () => {
  // THE RULE THAT MATTERS MOST. `link` and `renew` take a token; `connect` can
  // mint one. A queue is a file on a phone, and writing a credential to it to
  // send later is what this project refuses everywhere else.
  for (const [name, source] of [['iOS', swift], ['Android', kotlin]]) {
    // The DECLARATION, not the first mention: the comment above it says the
    // word too, and matching that matched an empty list.
    const list = /(static let holdable: Set<String> = \[[^\]]*\])|(val HOLDABLE = setOf\([^)]*\))/is.exec(source)?.[0] ?? '';
    assert.ok(list, `${name}: no holdable list found`);
    for (const forbidden of ['link', 'renew', 'connect', 'exchange']) {
      assert.equal(
        new RegExp(`["']${forbidden}["']`).test(list),
        false,
        `${name} would hold "${forbidden}", which carries a credential`,
      );
    }
    // And it holds the ones worth holding.
    for (const expected of ['start', 'stop', 'writefile']) {
      assert.match(list, new RegExp(`["']${expected}["']`), `${name} does not hold ${expected}`);
    }
  }
});

test('reads are not queued', () => {
  // A `list` that failed is worth repeating now, not in an hour: the answer
  // would be stale before it arrived, and the app refreshes anyway.
  for (const [name, source] of [['iOS', swift], ['Android', kotlin]]) {
    const list = /(static let holdable: Set<String> = \[[^\]]*\])|(val HOLDABLE = setOf\([^)]*\))/is.exec(source)?.[0] ?? '';
    for (const read of ['list', 'status', 'peek', 'health', 'files', 'readfile']) {
      assert.equal(new RegExp(`["']${read}["']`).test(list), false, `${name} queues the read "${read}"`);
    }
  }
});

test('the idempotency key is minted when queued, not when sent', () => {
  // THE LINE THAT MAKES A RETRY SAFE. The coordinator honours the key, so a
  // `start` that was delivered but whose reply was lost returns the original
  // outcome instead of starting a second session. Minted at send time — which
  // is what both apps did before — a retry is a second command.
  assert.match(swift, /id: "app-\\\(UUID\(\)\.uuidString\)"/);
  assert.match(kotlin, /id = "app-" \+ UUID\.randomUUID\(\)/);

  // And the sender uses the queued id when one is supplied: written into the
  // body, or kept first (as `id`) so the phone signs the id it sends
  // (DeviceSigning, docs/signed-intents.md).
  assert.match(swiftFleet, /"id": idempotencyKey \?\? "app-|let id = idempotencyKey \?\? "app-/);
  assert.match(kotlinFleet, /put\("id", idempotencyKey \?: \(|val id = idempotencyKey \?: \("app-"/);
});

test('only a delivery failure is held, never a refusal', () => {
  // A 401, a 403, a refusal from the fleet: those are ANSWERS. Holding an
  // answer and replaying it later is how a revoked credential retries all night.
  assert.match(swiftFleet, /isDeliveryFailure\(error\)/);
  assert.match(kotlinFleet, /isDeliveryFailure\(e\)/);
  // The classifier looks at transport errors only.
  assert.match(swift, /URLError/);
  assert.match(kotlin, /UnknownHostException/);
});

test('a held command expires rather than surprising somebody a day later, and is shown as expired, not dropped', () => {
  assert.match(swift, /static let expiry/);
  assert.match(kotlin, /const val EXPIRY_MS/);
  // RULE 4, THE HALF THAT WAS NOT TRUE. Both files said an expired entry is
  // "shown as expired rather than dropped quietly", and both flushes began
  // with dropExpired(): a start queued on the train was deleted the next
  // afternoon, and the list simply got shorter. A flush sends what is
  // waiting and leaves what expired where a person can see it.
  for (const [name, source, flushHead] of [
    ['iOS', swift, 'func flush(using send'],
    ['Android', kotlin, 'suspend fun flush(send'],
  ]) {
    const start = source.indexOf(flushHead);
    assert.ok(start > 0, `${name}: no flush`);
    const flush = source.slice(start, source.indexOf('\n    }', start) + 6);
    assert.doesNotMatch(flush.replace(/\/\/[^\n]*/g, ''), /dropExpired\(\)/, `${name}: the flush still deletes expired commands`);
    assert.match(flush, /for \(?entry in waiting/, `${name}: the flush must send only what has not expired`);
  }
  assert.match(swift, /var expired: \[Held\] \{ held\.filter \{ \$0\.isExpired \} \}/);
  assert.match(kotlin, /val expired: List<Held> get\(\) = held\.filter \{ it\.isExpired \}/);
  // And each is drawn, in the person's own words, with a way to dismiss it.
  const view = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');
  const main = readFileSync(
    new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt', import.meta.url),
    'utf8',
  );
  assert.match(view, /ForEach\(outbox\.expired\)/);
  assert.match(view, /Text\("Not sent: \\\(entry\.summary\)"\)/);
  assert.match(view, /Button\("Dismiss"\) \{ outbox\.drop\(entry\.id\) \}/);
  assert.match(main, /expired\.forEach \{ entry ->/);
  assert.match(main, /Text\("Not sent: \$\{entry\.summary\}"/);
  assert.match(main, /TextButton\(onClick = \{ outbox\.drop\(entry\.id\)/);
  // Same sentence on both phones.
  const sentence = 'Held for more than 12 hours while the fleet could not be reached, so it was not sent. Ask again if you still want it.';
  assert.ok(view.includes(sentence) && main.includes(sentence));
});

test('a flush stops at the first thing it cannot send', () => {
  // A fleet unreachable for one command is unreachable for all of them, and
  // marching through the queue turns one outage into N two-minute timeouts.
  assert.match(swift, /return sent/);
  assert.match(kotlin, /return sent/);
});

test('both apps show what is being held', () => {
  // A queue nobody can see is not a queue, it is a surprise arriving later.
  // And this is the row docs/app-parity.md exists to catch: the same feature
  // has shipped to one phone and not the other before, and been reported done
  // on both.
  const view = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');
  const main = readFileSync(
    new URL('../apps/android/app/src/main/java/network/thetech/fleetwright/MainActivity.kt', import.meta.url),
    'utf8',
  );
  assert.match(view, /held on this phone/);
  assert.match(main, /held on this phone/);
  // And the count is kept current on refresh, not only after a flush — a
  // command queued a moment ago has to appear without waiting for the fleet.
  // The count is of what WILL be sent; what expired is listed, not counted.
  assert.match(main, /pending = outbox\.waiting\.size/);
  assert.doesNotMatch(main, /outbox\.held\.size/);
  assert.match(view, /outbox\.waiting\.count/);
});

test('nothing recurses between refresh and flush', () => {
  // The first iOS version had refresh() call flushOutbox() and flushOutbox()
  // call refresh(). It terminated because the second pass found an empty queue,
  // which is a property that happens to hold rather than one that is enforced.
  const view = readFileSync(new URL('../apps/ios/Fleetwright/FleetView.swift', import.meta.url), 'utf8');
  // The function body only: from its declaration to the next declaration at
  // the same level. Slicing to `private func refresh` swept up whatever sat
  // between them.
  const start = view.indexOf('private func flushOutbox');
  const flush = view.slice(start, view.indexOf('\n    }', start) + 6);
  assert.equal(/await refresh\(/.test(flush), false, 'flushOutbox calls refresh, which calls flushOutbox');
});
