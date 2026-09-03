# Returning-User Report: Fleetwright after three weeks away

**Who:** elibrody2@gmail.com, set Fleetwright up once about three weeks ago, remembered
nothing — not the session name, not which host, not what state I left it in.

**The one job:** find the work I left running, get its output, clean up after it.

**Result:** I got it. The work was a disk usage report of `/var`; the output only still
existed because the conversation transcript kept it. It took **17 tool calls, of which 8
were errors or dead ends, plus 1 forced trip to the reference docs**. It should have been 4:
list → status → read → stop.

---

## 1. The attempt, in order

Every step, including the wrong turns. Wrong turns marked ✗.

1. **`fleet_list`** — got two hosts (`deb132`, `deb13-staging`), `0/5 running` on both, and
   twelve "Resumable" sessions, every one shown as the identical grey `◼`. Eight are named
   things like `cc-brave-narwhal · agent-runs`. Three say `disk usage report`
   (`cc-daring-thrush`, `cc-tough-stoat`, `cc-eli-diskreport`). Nothing running, nothing
   dated, nothing marked done/dead/abandoned.
2. **`fleet_health`** — reported one host's health *without naming the host*, including
   `claude: NOT LOGGED IN — a session here cannot do anything until somebody runs /login on it`.
   Which box? No idea.
3. ✗ **`fleet_status` with a `session:` parameter** — failed twice with
   `Could not reach the fleet: Unexpected token 'e', "error code: 1101" is not valid JSON.
   The fleet may be down or this coordinator unreachable; retrying is reasonable.`
   The fleet was not down — `fleet_list` had just worked. The advice to retry burned a call.
4. ✗ **`fleet_peek` with a `session:` parameter** — got
   `No host reports a session named "undefined".` My input was silently dropped; the correct
   parameter is `name:`, and nothing on the error said so.
5. **Doc lookup #1** — went and read the tool schemas to learn the parameter is `name`.
   (Details in §3.)
6. **`fleet_status name: cc-eli-diskreport`** — `stopped`,
   `last: stopped by fleet:elibrody2@gmail.com`. So past-me stopped it. No date on anything.
7. ✗ **`fleet_peek`** on it — `"cc-eli-diskreport" is not running.` Fair, but peek is
   documented as "how you find out whether work is done", and it's useless on exactly the
   sessions a returning user has.
8. ✗ **`fleet_read_log name: cc-eli-diskreport`** — `Which box? deb132, deb13-staging.`
   The product had shown me the session under `deb13-staging` in step 1, and `fleet_status`
   found it in step 6 without asking. Only `read_log` makes me repeat it back.
9. **`fleet_status`** on the two sibling `disk usage report` sessions — both also stopped,
   both `stopped by fleet:elibrody2@gmail.com`, one `started by: web`. Still no timestamps,
   so no way to tell which of the three attempts was the real/last one.
10. ✗ **`fleet_read_log`, host supplied** —
    `Nothing left to read for "cc-eli-diskreport" — no container and no pane.
    A stopped session keeps its conversation; its output is gone with the container.`
    The output I came for was destroyed when the session stopped.
11. ✗ **`fleet_files`** to check for a report file in the workspace —
    `deb13-staging does not know that command — it is running older code than this
    coordinator (af70d2e, 2 behind).` The product updated under me while I was away; the
    fix it names (`agent-hub update --restart`) requires a shell on that box, which the
    product itself does not give me.
12. **`fleet_status`** (no name) — both hosts say `claude: NOT LOGGED IN — run /login`. At
    this point I believed I was fully locked out.
13. **`fleet_verify provider: claude`** — the turn of the whole session:
    `THESE TWO DISAGREE. `claude auth status` reports signed out while the credential file
    on this box is valid and unexpired. That is a fault in the reporting rather than in the
    credential — sessions here will work.` Also: `Your linked account is signed in
    (11m left on the token).` So the scary red banner in step 12 was false, and I had an
    11-minute countdown I didn't know about until this call.
14. **`fleet_resume name: cc-eli-diskreport choice: full`** — worked.
15. **`fleet_peek`** — the restored pane contained the answer:

    ```
    du -x -h --max-depth=1 /var | sort -rh | head -6:

    8.9M  /var
    7.2M  /var/lib
    1.7M  /var/cache
    88K   /var/log
    4.0K  /var/tmp
    4.0K  /var/spool
    ...
    DONE
    ```

16. ✗ **`fleet_read_log`** to capture it durably — `The container for cc-eli-diskreport has
    printed nothing.` The pane shows a full conversation; the log says nothing exists. The
    peek output is apparently my only copy.
17. **`fleet_stop name: cc-eli-diskreport`** —
    `Stopped "cc-eli-diskreport". Its conversation is kept — /resume cc-eli-diskreport
    brings it back.` Done.

Cleanup caveat: the other eleven stale resumable sessions are still there. They were already
stopped, I'm told I "may only stop sessions you started in this conversation," and there is
no visible delete/archive operation — so the pile I found on return will still be there next
time, one session larger.

## 2. Where I had to remember something

- **Which session was mine.** The list is `cc-brave-narwhal`, `cc-solid-vulture`,
  `cc-clever-dingo`… I found mine only because past-me happened to name one
  `cc-eli-diskreport`. If I had accepted the generated name — which is the default — I would
  have had to resume sessions one by one to identify mine. What would have to exist: a
  **"started by" and "last active" column in `fleet_list`**. Both facts exist (status shows
  `started by`), they're just not on the screen where the choosing happens.
- **Which of three "disk usage report" sessions was the real one.** No timestamps anywhere
  in list or status output. I guessed by name. What would have to exist: **dates on
  sessions.**
- **Which host the session lived on**, for `fleet_read_log` (`Which box?`). I only knew
  because `fleet_list` groups by host and I scrolled back. The coordinator plainly can find
  sessions by name — `fleet_status` and `fleet_stop` did. `read_log` should too.
- **The parameter name.** Three weeks was enough to forget it's `name:` not `session:`, and
  the product punished that with `error code: 1101` and `session named "undefined"` instead
  of "unknown parameter".

## 3. Where I had to go and read

Once. After `fleet_peek` looked for a session named `"undefined"`, I went to the tool
reference to find out what the parameter is actually called (it's `name`), because the error
gave no hint that my input had been dropped. I found the answer there, along with several
things I'd argue I should never have needed to read to survive a return visit:

- "There is no completion signal; reading the pane is the signal." (peek)
- "READ IT BEFORE YOU STOP THE SESSION: the output lives in the container, so stopping one
  throws it away." (read_log) — this is the single most important fact for a returning user
  and it lives in a tool description, not in any product surface. Past-me stopped the
  session without knowing it; present-me only got the output back by the luck of transcript
  restore.

## 4. What the product told me versus what I needed to know

| It said | I needed |
|---|---|
| `◼ cc-eli-diskreport · disk usage report` (identical to 11 other rows) | "stopped 3 weeks ago by you · finished ('DONE' in transcript) · output recoverable via resume" — dead, done, and abandoned should not share one glyph |
| `claude: NOT LOGGED IN — run /login` (both hosts) | The truth, which `fleet_verify` knew: "auth status display is stale; the credential is valid; sessions will work." A false red banner on the front screen nearly made me give up on the only recovery path. Also: run `/login` *where*? |
| `The fleet may be down or this coordinator unreachable; retrying is reasonable.` | "Your request was malformed" — it was a client-side parameter error, the fleet was fine, and retrying was guaranteed to fail |
| `No host reports a session named "undefined".` | "You passed `session:`; this tool takes `name:`" |
| `Which box? deb132, deb13-staging.` | Nothing — resolve the name like every sibling tool does |
| `A stopped session keeps its conversation; its output is gone with the container.` | Add the one sentence that unsticks: "Resume the session to restore its transcript, which usually contains the output." I discovered that path by inference, not instruction |
| `Your linked account is signed in (11m left on the token).` (buried in fleet_verify) | This countdown on `fleet_list`/`fleet_status`, before I spend my 11 minutes reading errors |
| `deb13-staging does not know that command — it is running older code (af70d2e, 2 behind)` | Honest, and the fix is named — best error in the product — but the fix needs a shell I don't have. Also nothing announced "hosts drifted behind while you were away" until I tripped over it |

## 5. What I would change, ranked by friction removed on a return visit

1. **Make `fleet_list` answer "what state are things in?" instead of "what exists?"**
   Per session: last activity date, who started it, and finished/dead/waiting instead of a
   uniform `◼`. This one screen, fixed, removes steps 2, 6, 9 and the three-way guess
   entirely.
2. **Fix the lying login banner.** `fleet_verify` already knows the status display disagrees
   with the credential file and which one is right. Until the underlying fault is fixed,
   print *its* verdict on status/health, not the raw broken one. A false "NOT LOGGED IN" is
   the most expensive text in the product: it tells a returning user their one recovery path
   is closed.
3. **Put "stopping discards output — resume restores the transcript" in the product, not
   the manual.** Say it in `fleet_stop`'s confirmation and in the "output is gone" error.
   The error currently states the loss and withholds the recovery.
4. **Kill the "undefined" / 1101 failure mode.** Reject unknown parameters by name. Never
   diagnose a client-side error as "the fleet may be down," and never advise a retry that
   cannot succeed.
5. **Let `fleet_read_log` resolve session names fleet-wide** like `fleet_status` and
   `fleet_stop` already do. `Which box?` is the product asking me to remember on its behalf.
6. **Surface the token countdown before it matters.** "Signed in (11m left)" was decisive
   information available only from a verification tool I called out of desperation.
7. **Give stale sessions an exit.** Twelve resumables accumulated in three weeks with no
   delete/archive. The re-entry problem in item 1 compounds every week this is true.

## 6. Would I come back a fourth week?

**Grudgingly, yes — but only because the transcript saved me.** The one property that
mattered was that resuming a stopped session restored the conversation with my output in it;
that turned a data-loss story into a recovery story, and it's a genuinely strong foundation.
Everything around it fought me: the front screen couldn't distinguish my finished job from
eleven pieces of clutter, a false "NOT LOGGED IN" banner told me the recovery path was
closed, and the product's own advice ("retrying is reasonable", "run /login") was wrong or
un-followable both times I was actually stuck. I got my output by ignoring what the screens
said and interrogating a verification tool. A fourth week where I hadn't put my own name in
the session name — or where I'd trusted the login banner and walked away — ends with me not
coming back at all.
