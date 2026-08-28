# The app, voice and the CLI are the product

Written because the gap was noticed from the outside — *"I don't like that
Telegram has so much more than the app as it stands today"* — and then corrected
in a way that changes the target: **the app, Siri, Google Assistant and the CLI
are the hub for most people. Telegram is an option, and it stays, but it is not
the reference implementation for what this can do.**

That correction matters more than the feature list under it. "Catch the app up
to Telegram" would have produced an app shaped like a chat window: a surface
where every capability is a command someone types, because that is what the
thing being copied looked like. The right question is what each surface is
*good* at, and then whether the protocol underneath can serve all of them.

## What the gap actually is

The chat surface exposes **16 commands**:

```
help new resume stop list status forget login code
logs update upgrade reboot enroll identity whoami
```

Both apps already carry clients for `list start resume stop forget peek
enrolledHosts mintHostPin revokeHost signIn registerDevice`. So the honest
scoreboard is not "Telegram has more features" — it is three different problems
wearing one coat:

| | what is missing | cost |
|---|---|---|
| **Already built, not on screen** | `forget` exists in `Fleet.swift` and `Fleet.kt` and appears **nowhere** in either UI — 0 references in `FleetView.swift` and `MainActivity.kt` | a button |
| **Needs a new intent verb** | `logs`, `update`, `upgrade`, `reboot`, `login`/`code` | protocol work — see below |
| **Needs data nobody collects yet** | workspace path, context-window usage, plan limits, host version and whether it is behind | host-side reporting first |

**The middle row is the real one, and it is deliberate.** `PROTOCOL_VERSION` is
`1`, matched exactly with no negotiation, and there are eight fixed verbs:
`list status peek health start resume stop forget`. Telegram reaches `logs`,
`update`, `reboot` and `login` because it talks to `agent-hub` **on that box**,
not through the fleet. An app talking to a coordinator has no such path, and
adding one is a coordinated release of coordinator, Worker, host and both apps
at once.

> **Closed, 2026-08-28.** Rows one and two are done, in one coordinated release
> — `PROTOCOL_VERSION` is now `2` with thirteen verbs, and everything below
> except `login`/`code` and the filesystem is shipped on **all** of coordinator,
> Worker, host, iOS and Android. The scoreboard above is left as written because
> the shape of the diagnosis is what made the fix cheap: three problems wearing
> one coat, priced separately. See "What actually shipped" at the end.

That is the design working, not a bug in it. But it means "add all the features
to the app" is a protocol decision before it is an app decision, and pretending
otherwise would produce five verbs designed one at a time.

## The order I would build it

**1. Things that need no protocol change at all.** Fastest real progress, and
they are the ones asked for most often.

- **`forget` in both UIs.** The client method already exists.
- **Choose which host a session lands on.** `start` already takes a host
  constraint at the coordinator; the apps just never offer it. The scheduler
  filters on labels before ranking by capacity, so this is a picker plus a
  parameter, not new routing.
- **Show the workspace directory.** Already known host-side. Needs to travel in
  the `list`/`status` payload, which is additive and does not change the verb.
- **Telegram setup and removal from the app.** Configuration, not an intent.

**2. Reporting, which is additive to existing verbs.** No new verbs, so no
version bump — a field an old client ignores costs nothing.

- session length and context-window usage
- the Claude plan limits already visible on the host
- host version, and whether it is behind the branch it tracks
- `agent-hub` checking for system and app updates **on a schedule**, so the
  answer is ready when asked rather than computed while somebody waits

**3. Protocol v2, once, for the verbs that genuinely need it.** Designed
together rather than one at a time, because the version is exact-match and every
addition costs a coordinated release:

- `logs` — read a service journal
- `update` / `upgrade` — pull code, apply system updates
- `reboot` — already behind three confirmations in chat, and must stay so
- `login` / `code` — the Claude account flow, which is the one that most
  deserves to be in the app: it is the only step that needs a human, and doing
  it over SSH is exactly what this project exists to avoid
- `answer` — already designed in `plan.md` §4, and it belongs in the same bump

**4. The filesystem, last and deliberately.** Browse the workspace, copy, edit,
delete. This is the largest new attack surface in the whole product — an
authenticated app that can read and write arbitrary paths on every host in a
fleet — so it wants its own design pass, a path model that cannot escape the
workspace, and probably a capability a host can decline to offer. It is not a
feature to bolt onto a release that is also changing authentication.

## iOS App Intents: opening the app after a spoken start

Asked for specifically: when a session is started through an App Intent, let the
user turn on auto-open.

This section used to argue for it being **a setting rather than a default**, and
that reasoning still holds — an intent invoked from a Shortcut, an automation or
the Action button often runs when nobody is looking at the phone, and launching
an app then is an interruption nobody asked for.

**The mechanism does not.** It cannot be a setting at all, and the compiler is
what says so:

> `openAppWhenRun` must have a compile-time static value and cannot be computed
> or dynamic

That is the AppIntents metadata processor. Shortcut metadata is extracted from
the binary at **build** time, so there is no run in which to consult a
preference — a computed property there fails the build rather than being quietly
ignored.

So it shipped as **two phrases** instead, in `naming.md`: "start a session" and
"start a session and open it", two intents differing only in that constant.
Which is arguably where the choice belonged. Only the person running it knows
which they meant, and they say so at the moment they ask rather than in a screen
they visited last month.

Left here as a correction rather than an edit, because the reasoning was right
and only the mechanism was wrong — and a document that quietly rewrites its own
conclusions teaches nobody anything.

## Voice is a surface, and it constrains the protocol

If Siri and Google Assistant are first-class rather than a bolt-on, they get a
vote on how intents are shaped — and they are the harshest reviewer available,
because anything that cannot be said in one sentence or answered without looking
at a screen simply does not work there.

Three things follow, and they are all cheap to honour now and expensive to
retrofit:

- **Parameters must be nameable out loud.** "Start a session on the Mac" works;
  "start a session with label `macos,gpu` and priority 2" does not. This is an
  argument for the host picker in step 1 resolving *names and labels people
  already say*, not identifiers.
- **`answer` taking an ordinal is the right design for voice, by accident.**
  `plan.md` §4 refuses free text into a pane because `send-keys` reaches a root
  shell. An ordinal into a list the host published is also the only form a voice
  assistant can offer reliably — "the second one" is speakable, a shell command
  is not. A safety decision and a voice decision landing on the same answer is
  usually a sign the answer is right.
- **Replies need a speakable form.** Not a second API — one short sentence
  alongside the structured payload, written by the host that knows what
  happened. A UI can ignore it; a voice assistant cannot invent it.

## Where Telegram sits now

It stays, and nothing here removes it. It has properties the app cannot have:
outbound-only with no port to open, works on a locked phone, survives the app
being uninstalled, and is the only surface that works on a box you have not
enrolled yet — which is how `/enroll` joins a machine without an SSH session.

What changes is that it stops setting the ceiling. A capability is not "done"
because it works in chat, and a capability that is awkward to express in chat is
no longer thereby postponed — that is chat's problem to solve or skip.

## What actually shipped

Written after the round, from the merged code rather than the plan — a parity
document that only ever describes a gap is a document nobody trusts once the gap
closes.

**Thirteen verbs, one bump.** `answer logs update upgrade reboot` joined
`list status peek health start resume stop forget`, all in `v2`, all designed
together for the reason step 3 gave: the version is exact-match, so five
separate bumps would have been five coordinated fleet releases.

**Both apps, same round, field for field.** This is the part the round was
actually about. The rule that came out of it, now in `CONTRIBUTING.md`: a
feature round ships as stacked PRs by layer — worker → host → iOS → Android →
docs — every layer committed before any PR is opened. A verb that reaches one
phone and not the other is the state this document was written to describe, and
it is very easy to re-enter one merge at a time.

**What each surface got:**

| | iOS | Android | Telegram |
|---|---|---|---|
| answer a waiting prompt | buttons from the host's options | buttons from the host's options | `/answer` |
| session and fleet status | ✅ | ✅ | ✅ |
| journals and session output | ✅ | ✅ | ✅ |
| update / upgrade a box | one tap | one tap | ✅ |
| reboot a box | pin + typed hostname | pin + typed hostname | ✅ |

**The two things that stayed hard, and stayed correct:**

- **`answer` sends an ordinal into a list the host published**, with the
  `promptId` attached — so a notification tapped four minutes later is refused
  rather than answered against a different question. Free text into a pane
  reaches a root shell; that has not become acceptable because the surface is
  prettier.
- **`reboot` is still two steps** — the box mints the pin, and the hostname must
  be typed. Both apps disable the button until the typed name matches. A
  coordinator that could mint the pin itself could reboot the fleet, which is
  the whole reason the pin comes from the box.

**Still open, in order:** the reporting in step 2, and the filesystem — still
last, still for the reasons in step 4.

`login`/`code` closed in the round after this one, as `connect`/`link`/`unlink`
— see [connectors.md](./connectors.md). Worth recording one thing from it here,
because this document exists to catch exactly this: **the maintenance row
shipped to iOS and not to Android**, in the round above, while I reported it as
done on both. The client methods were there; nothing was wired to a button. A
parity gap can be one commit wide and still be invisible in a summary, which is
the argument for the checklist rather than the intention.
