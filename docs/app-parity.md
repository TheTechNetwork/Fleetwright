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

**Still open, in order:** the reporting in step 2.

**The filesystem closed on 1 Sep 2026**, last as planned and for the reasons in
step 4 — see [filesystem.md](./filesystem.md) for the design pass it was waiting
on. Shipped on coordinator, Worker, host, MCP, iOS and Android in one round,
because the middle row of the table above is exactly what it would have been:
five new verbs, and an app cannot show what the protocol cannot express.

Two things worth recording from it, both of the kind this document exists for:

- **The listing travels as a FIELD, not as text.** The first version returned
  only the rendered lines, which would have left both apps parsing emoji out of
  a string — the same mistake `connect` avoided by putting the authorization URL
  in a field. Caught while writing the iOS client, one layer after the host.
- **Neither app validates a path, deliberately**, and both say so in a comment.
  The host confines it three times and is the only thing that can, since a
  symlink is invisible from a phone. A `..` check in an app is something
  somebody later relies on.

`login`/`code` closed in the round after this one, as `connect`/`link`/`unlink`
— see [connectors.md](./connectors.md). Worth recording one thing from it here,
because this document exists to catch exactly this: **the maintenance row
shipped to iOS and not to Android**, in the round above, while I reported it as
done on both. The client methods were there; nothing was wired to a button. A
parity gap can be one commit wide and still be invisible in a summary, which is
the argument for the checklist rather than the intention.

## The recycle bin, and a refusal that explains itself

Two things from the round after the connectors work, both worth keeping.

**`/forget` was the only action in the product with no undo.** It killed the
session, dropped the record and deleted both volumes, so a name typed one word
wrong destroyed a conversation and a workspace. Everything else here is
recoverable by trying again. It now bins for seven days; `restore` puts the
record back on top of volumes that never went, and `purge` is the old behaviour
kept as its own word.

The subtle part is that **a name in the bin is taken**. Volumes are keyed by
name, so `claude-<name>` for a binned session is the same volume a new session
of that name would be handed — reusing it either resurrects somebody else's
conversation or destroys a recoverable one, depending on which way the race
fell. A chosen name is refused with both remedies named; a generated one skips
the bin as well as the live list.

**And an old host's refusal now says what to do.** Reported from the live
fleet: *"unknown verb update or upgrade"*. That is the protocol working —
adding a verb costs no version bump precisely because an older host answers
`unknown_verb` rather than misbehaving — but what reached the phone was the
bare word. The verb exists on the coordinator, so the request looked valid and
the failure named a thing rather than a remedy.

The remedy is the awkward part, and saying it out loud is the point: **the verb
that fixes this is often the one that is unknown.** `update` over the fleet
cannot update a box too old to have `update`. What works is that box's own
Telegram bot or a shell on it, both of which reach agent-hub directly rather
than through this protocol. A pull that did not restart looks identical from
the coordinator, and is at least as common — so both routes say `--restart`.

## The round after: one tap, a bin with a home, and a credential that expires

Four things shipped to both phones together, and three of them were fixes to
something that had been reported as working.

**The recycle bin lived under the machines.** Each host's row in settings
carried its own bin entries, because that is where the volumes physically are.
That is an implementation detail leaking into the layout: somebody who just
forgot a session is not thinking about which box held it. It is one fleet-wide
screen now, reachable from the session list, **reachable when empty**, and
sorted by deadline rather than by host. Reported as *"recycle bin was never
added to the app as far as I can tell"* — it had been, in the place nobody
would look, which is nearly the same thing.

It also would have been empty however full it was: `FleetView` never fetched
the hosts, so the count summed an empty array.

**"Done" was the app asking the person to be the callback.** The GitHub App
flow opened an external browser and then had nothing to do but wait, so a
button existed purely so somebody could tell the app about a redirect it had
already been handed. iOS now uses `ASWebAuthenticationSession` and Android a
Custom Tab, and on Android the manifest had claimed `fleetwright://connected`
since the App round with **nothing consuming the Intent** — `onNewIntent` was
never overridden.

The browser choice is not about the tap. Both of those are the *real* browser:
real address bar, real padlock, own process, the user's own cookies. A WebView
needs no dependency and would look tidier, and is a login form drawn by the app
that is asking for the login. A tripwire test refuses one on both platforms.

The paste route keeps its numbered steps deliberately. It does not come back —
there is a token to copy and no redirect to wait for — so an embedded browser
would open a window that never closes itself.

**A host can be signed in and hand every session a dead credential.** `loggedIn`
reports on the box's home directory; a sandboxed session runs on a copy taken
when its volume was made. Both phones now show the second answer, and both show
it **only when the token has expired and there is nothing to renew it with** —
expired-but-refreshable is the ordinary state of a box nobody has touched for an
hour, and a warning that fires on the ordinary case is one people stop reading.

**A token GitHub reports no scopes for is not a token missing every scope.**
Both apps said "GitHub does not report what a token was granted", which is true
of Cloudflare and untrue of GitHub — it reports for classic tokens and not for
app or fine-grained ones. That is a property of the token, not of the provider,
and the catalogue's `wants` was already on screen to tell them apart.
