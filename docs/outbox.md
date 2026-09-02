# Held on the phone

The apps used to send on tap and, when that failed, say so and lose the command.
On a phone that is the wrong answer: the ordinary case is a lift, a tunnel, or a
coordinator restarting, and "try again in a minute" asks somebody to remember
what they wanted and to be watching when it comes back.

A command that could not be **delivered** is now held on the device and sent
when the fleet answers again.

## The four rules, each load-bearing

**1. The idempotency key is minted when the command is queued, and reused on
every retry.** This is the whole reason holding a command is safe. The
coordinator honours the key, so a `start` that was delivered but whose reply was
lost returns the *original outcome* rather than starting a second session. Both
apps minted the id at send time before this, which would have made every retry a
second command — the exact failure a queue is supposed to prevent.

**2. Only a delivery failure is held.** A 401, a 403, a refusal from the fleet:
those are **answers**. Holding an answer and replaying it later is how somebody's
revoked credential retries all night. `isDeliveryFailure` looks at transport
errors only — `URLError` on iOS, `IOException` and friends on Android — and a
refusal the app itself raised is never held.

**3. Never a verb that carries a credential.** `link` and `renew` take a token;
`connect` can mint one. A queue is a file on a phone, and writing a credential to
it to send later is what this project refuses everywhere else. `test/outbox.test.js`
asserts the list, and asserts it by name rather than by count.

**Reads are absent too**, for a duller reason: a `list` that failed is worth
repeating now, not in an hour. The answer would be stale before it arrived and
the app refreshes anyway.

**4. It expires.** Twelve hours — long enough for a commute and a night's sleep,
short enough that nobody is surprised by a session starting on their machine.
Expired entries are dropped on load and on flush; a queue that silently keeps
them is one that lies about what it will do.

## When it flushes

**On refresh, never on a timer.** A refresh is the moment the app has just
learned the fleet is reachable, and it already happens when the app opens, is
pulled, or comes back. A timer retries into an outage.

A flush **stops at the first thing it cannot send**, because a fleet unreachable
for one command is unreachable for all of them — marching through the queue
turns one outage into N two-minute timeouts. Order is preserved: `stop` then
`resume` and `resume` then `stop` are different intentions.

**A refusal counts as delivered.** The fleet answered — "that session is gone",
"you cannot stop that" — and holding a command it has already judged would retry
it forever.

## What it stores, and where

iOS writes `outbox.json` in Application Support with complete file protection and
excluded from backup. Android writes it in `filesDir` — not SharedPreferences,
because a held `writefile` carries the file and preferences are the wrong shape
for a payload measured in kilobytes.

A held command names a session and may carry file contents. It is **not** a
credential, by rule 3, and it is not something to copy into iCloud either.

## One bug worth recording

The first iOS version had `refresh()` call `flushOutbox()` and `flushOutbox()`
call `refresh()`. It terminated, because the second pass found an empty queue —
which is a property that *happens to hold* rather than one that is enforced. A
test now asserts the flush does not call refresh.
