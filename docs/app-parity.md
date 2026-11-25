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

> **Executable parity, since #374.** The scoreboard below was kept honest by
> tests that read the Swift and the Kotlin as *text* — which can prove a rule is
> mentioned in both places and cannot prove the two agree. The rules that are
> written twice now have a shared table of inputs and expected outputs in
> `test/fixtures/parity/`, run by a Kotlin unit test and a Swift one. See
> "Testing the apps" in [`ci.md`](./ci.md).

## The apps look like the product now, which they did not

Written down here because "parity" was being read as a feature list, and the
first thing somebody meets is not a feature. iOS was stock SwiftUI and Android
was Material 3 with `dynamicColorScheme` — the phone's *wallpaper* palette — so
the same screen came out teal on one device and mauve on another, neither
agreed with the console, and `amber means something is waiting for you` cannot
be true when amber is whatever the wallpaper had.

Both apps now build from the same token table as the console:
[`docs/design-system.md`](./design-system.md), enforced by
`test/design-parity.test.js`. What is restyled and what is still Material's or
SwiftUI's own layout is listed at the end of that document.

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

**The middle row was the real one, and it was deliberate** (as of 2026-08, the
day this scoreboard was written; the dated notes below say what moved). The
protocol version was `1`, matched exactly with no negotiation, and there were
eight fixed verbs: `list status peek health start resume stop forget`. Telegram
reached `logs`, `update`, `reboot` and `login` because it talked to
`fleetwright` **on that box**, not through the fleet. An app talking to a
coordinator had no such path, and adding one was a coordinated release of
coordinator, Worker, host and both apps at once.

> **Closed, 2026-08-28.** Rows one and two are done, in one coordinated release
> — `PROTOCOL_VERSION` is now `2` with thirteen verbs, and everything below
> except `login`/`code` and the filesystem is shipped on **all** of coordinator,
> Worker, host, iOS and Android. The scoreboard above is left as written because
> the shape of the diagnosis is what made the fix cheap: three problems wearing
> one coat, priced separately. See "What actually shipped" at the end.

> **Still true, and the numbers have moved, 2026-09-10.** Left as a second note
> rather than an edit to the one above, because that one is dated: on 28 August
> the protocol *was* `2` with thirteen verbs, and rewriting it to say otherwise
> would make a record of that day into a claim that was never true on it.
>
> Today `PROTOCOL_VERSION` is **3** and there are **31** verbs. `login`/`code`
> is no longer an exception: it shipped as `connect`/`link`/`unlink`, three
> generic verbs over a table of providers, so adding a provider is a row in
> `src/core/connectors.js` rather than a release. **Row three has moved too** —
> a host's version and whether it is behind are in the health frame now, which
> is what `unknown_verb` and `unsupported_version` use to tell you which of the
> two you are looking at.
>
> **Moved again, 2026-11-06.** `PROTOCOL_VERSION` is **17**, `PROTOCOL_MIN` is
> **2**, and there are **45** verbs. The sentence above about "a coordinated
> release ... at once" is no longer how a verb lands: `validateIntent` accepts
> the range `[PROTOCOL_MIN, PROTOCOL_VERSION]`, the coordinator speaks each
> host its own highest understood version and omits any param newer than it,
> and a routine feature bump strands nobody ([`CONTRIBUTING.md`](../CONTRIBUTING.md),
> [`protocol-negotiation.md`](./protocol-negotiation.md)). What that buys is
> also what it costs: a box can be fifteen versions of behaviour behind, inside
> the accepted range, and the apps learn which capability it lacks one refused
> tap at a time (`unknown_verb`, `unsupported_version`). A per-machine line
> naming what its spoken version cannot do is still to be built; it is on the
> roadmap under the November readiness review.
>
> What is left of the filesystem exception is exactly the apps: the five verbs
> ship on coordinator, Worker, host and MCP, and neither phone has a screen for
> them beyond the Files browser. The session detail screen, the other row the
> roadmap called **partial**, is built on both phones now: the state sentence,
> the pane watched through `peek`, and Remote Control front and centre when
> nothing is being asked.

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
- ~~Telegram setup and removal from the app.~~ Off this list: the per-box
  adapter it would have configured is archived (`telegram.md`). The bot's
  settings belong with the coordinator-level bot on the roadmap, if that is
  built.

**2. Reporting, which is additive to existing verbs.** No new verbs, so no
version bump — a field an old client ignores costs nothing.

- session length and context-window usage
- the Claude plan limits already visible on the host
- host version, and whether it is behind the branch it tracks
- `fleetwright` checking for system and app updates **on a schedule**, so the
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

**What each surface got:** (the `logs` row read three ticks for a week while
neither phone had a screen for it — the client method existed on both, which
is what a grep sees and a person does not. The screens exist now, and the host
says on health which journals a box has so the buttons are only ever live.)

| | iOS | Android | Telegram |
|---|---|---|---|
| answer a waiting prompt | buttons from the host's options | buttons from the host's options | `/answer` |
| session and fleet status | ✅ | ✅ | ✅ |
| **how long it has waited on you, worked, and what it cost** (`awaitingSince`, `phases`, `spent`) | "Waiting for you · 12m"; the session page's two lines under its facts | the same, on the session sheet | `/status <name>`: `time:` and `cost:` |
| journals and session output | Logs on the host page, Output on each session | Logs on the host sheet, Output on each session | ✅ |
| update / upgrade a box | one tap | one tap | ✅ |
| reboot a box | pin + typed hostname | pin + typed hostname | ✅ |
| **who a box takes update and reboot from** (`pinadmin`, health `admins`) | The machine → Pinned admins, where it pins somebody: a pinned admin sees the list, adds by address and removes all but the last; anybody else is told they are not one, and Apply update, upgrade, Reboot, the channel and image pickers and others' Restore are not drawn. Where nobody pinned can sign, the machine's sentence alone, and none of those for anybody; where it can check no signature at all (`unchecked`), not a person's own Restore either. No first pin, which is set on the box | the same section, the same words (`test/pinned-admins-in-apps.test.js`) | — (`fleetwright-sidecar admins` on the box) |
| **start a session with a task** (v3 `profile`) | picker on the start sheet, and on a kind | picker on the start sheet, and on a kind | `/new --profile=<name>` |
| **see what tasks a host has** | fed by `profiles`, fans out | fed by `profiles`, fans out | `/profiles` |
| **grant a session a secret** (v4 `secret`) | picker on the start sheet | picker on the start sheet | `/new --secret=<name>` |
| **permission mode** (`start` `mode`, health `permissions`) | New session → Permissions, after Where. "Box default" first and selected: it sends no mode, and is labelled "asks before each tool" or "permissions bypassed" only when every machine the start could land on reports the same; otherwise it says nothing about the mode. "Permission prompts on" sends `safe`. "Permissions bypassed" only where every such machine reports `bypassed` (one set to ask, one that has not said, or none to judge leaves it out), with the reason when it is missing. A kind saves Box default or prompts on | the same choices, the same words, chips under a Permissions heading (`test/permission-mode-in-apps.test.js`) | `/new --safe` or `--dangerous`; a fleet start asking to bypass on a box set to ask is refused (`test/fleet-permission-ceiling.test.js`) |
| **see what secrets a host holds** | fed by `secrets`, fans out (names only) | fed by `secrets`, fans out (names only) | `/secrets` |
| **readmit a revoked host / replace a host's key** | swipe the host row | button on the host row | curl |
| **which releases a box takes** (v3 `channel`) | segmented picker in the host row | chips in the host row | `/channel` |
| **which image sessions run in** (`sandbox`) | segmented picker on the host page | chips in the host sheet | `/sandbox` |
| **what work aimed at a tag finds** (`labels`) | chips on the host page, Remove on the removable ones | chips in the host sheet, ✕ on the removable ones | `/labels` |
| **ask for a temporary machine** (`provision`) | picker, stepper and button under Add a machine, only when `/api/hosts` names a runner repository | chips, minutes and button under Hosts, same gate | `/provision` |
| **linked repositories** (`/api/linked-repos`) | You › Linked repositories: archive, runners and templates, each with what it means above its field, Check and link, the check one fact per answer, Unlink only when linked | the same page, full screen | `/linkrepo` checks; linking is the app's |
| **where a session is archived** (`archive*` on a session) | a line under the session's facts: the host's sentence about the last push, or that nothing has been pushed yet; a failed push in words and the error colour | the same line on the session sheet | `/archive <name>` pushes now |
| **the organization** (`/api/members`, vault `org`) | You › Organization, for everybody: My team for a manager, each member with whether its vault keeps a Claude sign-in, as the vault answers (*Keeps a Claude sign-in*, *No Claude sign-in kept*, or *Not checked* when the vault could not be asked; kept is all the vault's list says, so neither phone says *signed in*), then Everyone as the tree, Person or Agent in words. A member's page: its record, Edit and Remove member for an admin or its manager. *Remove member* asks first and says the cost by what the member is (an agent: *The vault forgets what it kept and the machines approved for it, and that cannot be undone.*; a person: *What they keep in the vault is their own and stays theirs.*), then tells the vault before the fleet (vault `orgmember` with `remove`, then `DELETE /api/members/{id}`): a vault that refuses stops it, its sentence is the line under the button and nothing is removed, and the one refusal it goes on after is a member the vault never held (`no_member`). With no GitHub sign-in on the phone and a fleet that keeps a vault, nothing is removed and the line is *Sign in to GitHub under Runners first. Removing a member also tells the vault, which keeps who may use its credentials.*; a fleet that keeps no vault is asked alone. Custody as the vault holds it where the vault's tree and the fleet's differ: *File it* only for somebody the vault would take it from (an org admin of the vault; a manager when the vault's own tree puts the member's place under them), and for anybody else a sentence that says who files it (*This is an org admin's to file:* and their addresses; *The vault files a member after whoever it reports to, and Dana is not filed yet.* where that is why). The Organization screen has **Custody** for an org admin of the vault when any member waits: *Custody is not filed for 3 members yet.* and *File all 3*, which files them top of the tree first and then says who was filed and who was not, each refusal in the vault's sentence (*Filed 2 members with the vault: Dana, Debbie.*, *Could not file Eli.* and why); a fleet admin has *Become its first admin* there before anybody administers the vault's organization, and reads *The vault could not be asked.* with the reason when it could not; nothing is drawn when nothing waits. Credentials (the vault, pointed at that member) and Start a session as it, each only for somebody the answer lists. New session asks *As* whom when the fleet names anybody. An agent's page lists its custodians, with *Remove* on its own ones for somebody on the list, never on the last one, which the vault keeps, and asked first (*Remove this custodian?*). A person's page names whoever added them and so manages their credentials, with *Stop managing their credentials* for that person or an org admin of the vault, asked first. You › Credentials has *Your managers*: who added you and manages what you keep, the switch that lets your other managers in, and what any of them changed. Files, for an admin: export, copy, import | the same pages, full screen, the same words (`test/members-in-apps.test.js`) | — |
| **tasks** (`/api/tasks`, `start` with `taskId`) | You › Tasks, beside Organization, once the fleet answered with a list: the tasks that came back first, then the ones being worked on, then the open ones, each row its title, id, assignee by name (the id where the organization has no name for it) and its state in words (*Came back: done*, *blocked* or *failed*; *Came back, outcome not stated*; *Working, cc-x on deb132*; *Open*; *Open, assigned to nobody*). Loading, could not load and *No unfinished tasks* are three different screens. Done and cancelled are under *Finished* and asked for when it is opened. A task's page: title, state, assignee, the branch as what its sessions are told (*nothing checks that it exists*), the brief, why it was reopened, the session that holds it (machine, since when, started by; *not connected, so whether the session is still working is unknown* and *back at its prompt and wrote no result* in those words; the session opens when this phone's list has it), the result as the session wrote it with *Cut at 4000 bytes* and *This is the session's own account*, and every change of hands, oldest first, with its time. Actions, each drawn only where the fleet would take it: *Start a session* when the fleet sent something to sign, showing the words first and sending the fleet's own parameters; *Reassign* on an open task nobody holds, to a member this person acts for or Nobody, with a note; *Release* with a lock, after a question that says the session is not stopped; *Accept the result* on one that came back; *Reopen* on one that came back or is done, its note required; *Edit* and *Cancel task* until it is finished. A refusal is the fleet's sentence. *New task*: title, brief, assignee, repository, kind of work, counts said as the limits are approached, then that task's page. A session started on a task says *Task t12* on its page, which opens the task. The start's answer is a line on the task's page and a notification | the same pages, full screen, the same words (`test/tasks-in-apps.test.js`). A session's sheet has the *Task t12* button. The start's answer is on Sessions and a notification, where every start's answer is on Android | — |
| **a member's engines** (`engines` on `/api/members`) | Edit a member → Engines, where the one Model field was: the list in the order to try, each row its engine and a Model field (*Optional*; for OpenCode *provider/<model>*, with the three ways one is written under it, and what each runs on: *OpenCode needs a model. Written github-copilot/<model>, it runs on the member’s Copilot token. Written openrouter/<model> or vercel/<model>, it runs on an API key and is billed by the token.*). *Up* and *Down* are buttons, said to VoiceOver as *Move Codex up*, drawn once there are two engines; *Remove* is not drawn for the last one; *Add Codex* and *Add OpenCode* only for an engine the list does not name. Under the list: *A session starts on the first of these its machine runs, and moves to the next when one stops at its limit.* Save is not offered, and nothing is sent, with no engine or with an OpenCode that names no model (*OpenCode needs a model.*); any other refusal is the fleet's sentence, a model on a provider it has no row for included. The member's page says the list in words, *Claude Code, then Codex (gpt-5.1-codex)*, and nothing for a record with no engines | the same, on the member's full-screen form and page, the same words (`test/engines-in-apps.test.js`); the Model field carries its name as a label | — |
| **an engine's sign-in** (vault `put` and `forget`, items `codex` and `copilot`) | A member's Credentials, under what is saved: *Codex sign-in* and *GitHub Copilot token*, each drawn only when one of that member's engines runs on it, or it is already kept and can be forgotten. *Kept* or *Not kept*, then *Since* when, and for Codex *Held by deb132* or *Not handed to a machine yet*, and *Goes to one machine. Pasting it again moves it.* *Keep* or *Replace* opens a paste field: many lines for Codex, with *Paste the whole of ~/.codex/auth.json, the file codex login leaves.* and *What you paste is a copy. Whichever of the two renews first ends the other.*; a hidden one for the token. What the vault refuses is its own sentence. The field is emptied once the vault took it and when the screen is left, and nothing kept is read back. *Forget* asks first. No Test: the vault does not try these. You › Credentials draws the same two rows for the engines of the person's own member | the same rows, the same words; the pasted text is never saved with the screen | — |
| **the engine a session is on** (`engines`, `engineAt`, `engineLog`, `turn` on a session) | The session's page, an Engine section drawn only for a session whose machine named its engines: *On Codex (2 of 3)*, the list in order, each move as a sentence with its time (*Moved from Claude Code to Codex: stopped at its account’s limit*), and how its last turn ended when it did not simply end, in the fleet's own sentence (*Codex is not signed in on this machine, or its sign-in has ended.*; a limit says when it lifts, in the phone's time format). The session's row names the engine only when it is not Claude Code | the same, under an Engine heading on the session sheet, the same sentences | — |
| **engines on a task** (`handoffs` kind `engine`, `lock.stopped`) | A task's History says the move as that sentence. Under Session, when its session came back with no result and its turn did not simply end: the turn's sentence, in the attention colour | the same | — |
| **what a machine runs** (health `engines`) | The machine's page: *Runs: Claude Code, Codex*. A machine that names no engines is from before them and is said to run Claude Code; one that has reported nothing gets no line | the same, on the machine's sheet | — |
| **the API providers a machine has on** (health `apiProviders`) | The machine's page, under what it runs: *API keys turned on for: OpenRouter, Vercel AI Gateway*, by the fleet's names (`API_PROVIDERS`); a provider this build never met is shown as sent. A machine that names none gets no line | the same, on the machine's sheet, the same words (`test/api-engines-in-apps.test.js`) | `fleet_health` prints them |
| **an engine's API key** (vault `put` and `forget`, items `apikey:openrouter` and `apikey:ai-gateway`) | A member's Credentials, beside the two sign-ins and by the same row: *OpenRouter API key* and *Vercel AI Gateway API key*, each drawn only when one of that member's engines is on that provider, which its model says (`openrouter/…`, `vercel/…`), or the key is already kept and can be forgotten. An OpenCode on a provider's key is offered that key and no Copilot row. *Kept* or *Not kept*, then *Since* when. *Keep* or *Replace* opens a hidden field with *Paste one OpenRouter API key. OpenCode runs on it.* above it and, under it, *Billed by the token. What it may spend is set at OpenRouter, and no budget here counts it.* What the vault refuses is its own sentence. The field is emptied once the vault took it and when the screen is left. *Forget* asks first. No Test: the vault does not try a key. You › Credentials draws the same rows for the engines of the person's own member | the same rows, the same words; the pasted key is never saved with the screen | the signing page has the same rows, in a member's vault and the person's own |
| **a member on a machine without its engine** (`start` with `member`) | New session, under As, once a machine is chosen that does not run the member's first engine: *deb132 does not run Codex. A session as Debbie there runs on Claude Code.*, or that it has no engine to run on there. Said before sending and never a block: the fleet's own sentence comes back after | the same | — |
| **a session moved to another engine** (event `session.engine`) | Recent activity: *Moved to another engine*, where the row had the bare kind | the same | — |
| **the fleet's routing** (`GET` and `PUT /api/routing`) | You › Organization › Routing, a row for everybody. *When a task has no member*: three choices of one shape, *Off*, *Ask me* and *Choose for me*, each with one line under it (*A task with no member stays with nobody.*; *The rules below place a task. When several members could take it, whoever asked chooses.*; *The same, and the fleet’s model picks among several.*), and a mark on the one chosen, said to VoiceOver as *Chosen*. Where the fleet says it has no model on, *Choose for me* also says *This fleet has no model turned on, so a person is asked. Its operator turns the model on.* and stays a choice. *Rules*: every rule a row, its kind of work and *Goes to Debbie* under it, or *No rules yet.* Under the choices, always: *A task somebody was given is never moved. Routing chooses only among members the person asking could have assigned by hand.*, and who last set it. An admin, as the fleet's answer says who is one (`you.admin`), also has *Remove* on each rule, *Add a rule* (a kind of work, a member, *Add the rule*) and *Save*, which sends the mode and the whole list of rules in one request; a draft that differs says *Not saved yet.*, and what the fleet answers is the line under Save, a refusal's sentence included (a second rule for one kind of work is the fleet's to refuse). Anybody else sees the same page with no control and *An admin sets this. Anybody can read it.* Loading, *Could not load the routing.* with the reason, and *Routing is not on this fleet yet. It may need an update.* are three different screens: the last is an answer with no routing record and no sentence, which is what a fleet from before routing sends, and it is never drawn as *Off* | the same page, full screen, the same words (`test/routing-in-apps.test.js`). The choices are radio buttons for an admin; for anybody else the one the fleet is set to says *Chosen* in words. A new rule's member is chosen from a list of radio rows, where iOS has a menu that starts on *Nobody yet* | — |
| **whose a new task is, and what that sends about routing** (`POST /api/tasks` with `routing`) | New task › Assignee: *Nobody*, *Let the fleet choose*, and the members. *Nobody* means nobody: it sends `routing: "off"` and no assignee, always, so the task stays with nobody on a fleet whose routing is on (a fleet from before routing passes the field over), and while it is the choice the form says *It stays with nobody until somebody assigns it or changes its routing.* under it. *Let the fleet choose* asks *How*: *As your fleet is set*, which sends nothing about routing, *Ask me* (`manual`) or *Choose for me* (`auto`), and no assignee goes with it. A member sends that member and no `routing`. The form then becomes that task's page, which says how it was routed | the same choices, as radio rows: the line under *Nobody* while it is chosen, and the three under *Let the fleet choose* once it is picked | — |
| **how a task was routed** (`route` on a task, `handoffs` kind `routed`) | A task's page, under *Assigned to*: *Routing*, and the fleet's own sentence, head for head with `HOW_WORDS` (*Routed by the fleet’s rule: Debbie. The fleet’s rule sends backend work to Debbie.*; *Waiting for a person to choose. … Choose among Ada, Bo and 3 more.*), members by name where the organization names them and by id where it does not. Drawn only for a task the fleet wrote a decision on. History says each decision as a sentence from the same heads, *Routed by the fleet’s model: Debbie*, with who asked and when under it | the same | — |
| **choose the member a task goes to** (`POST /api/tasks/{id}/route` with `member`) | While the fleet's last decision was to ask (`route.how` is `waiting`) and the task is open, held by no session and has no member, which is where Reassign is offered: *Choose a member*, under the task's head and before its brief. Each member the fleet is choosing among is a button, 44pt, its name in the accent and its role under it; pressing one sends that member, and what the fleet says is the page's line, a refusal's sentence included. *Somebody else* opens the Reassign picker | the same, each member an outlined button the full width and 48dp tall, said to TalkBack as *Choose Debbie, backend engineer* | — |
| **route a task now** (`POST /api/tasks/{id}/route`) | *Route it*, on a task that is open, held by no session, has no member, is not already waiting on a person, and whose own routing is not *Off*: the fleet refuses that one whatever its setting, so the button is not drawn for it, and Edit › *Routing* is where it is turned back on. It sends no member. What the fleet says is the page's line: who it went to, that a person is being asked, or its refusal (the fleet's own routing is off and the task does not ask for it, say) | the same | — |
| **a task's own routing** (`PUT /api/tasks/{id}` with `routing`) | Edit › *Routing*: *As your fleet is set*, *Off*, *Ask me*, *Choose for me*, with *This task’s own setting, used when it is routed.* under it. Sent empty as well as set, since empty is how a task follows the fleet's setting again. A mode from a newer fleet is shown as it was sent and saved back unchanged | the same, as radio rows | — |
| **a task waiting for a member, in the list** (`route.how` `waiting`, `route.asked`) | The row says *Open, waiting for you to choose a member* when the address the fleet asked is this person's, and *Open, waiting for a member to be chosen* otherwise. Those rows take the attention colour and come to the top of the list with the ones that came back, in that order, because both are asking a question. The count beside You › Tasks is still only the ones that came back | the same | — |
| **a task that needs a member, as a notification** (push `kind` `task`, `taskId`) | A tap opens You on that task's page, where the members to choose among are. The id is read as a few letters and digits or not at all | the same; a notification the app drew itself carries `taskId` with the extras it already carried | — |
| **routing in Recent activity** (events `task.routed`, `task.needs-member`, `routing.changed`) | *Task routed*, *Task needs a member*, *Routing changed*, where the row had the bare kind | the same | — |
| **what a member has spent this month** (`GET /api/budgets`, `members[].words` and `over`) | A member's page, under its record: *This month*, and the fleet's own sentence as it was sent (*$12.35 of $50.00 this month, at API prices as each session counted it.*, or *At least …* when a session reported no cost). The phone keeps no figure from that answer, so no line can be rebuilt from one. Past its budget the line reads *Over budget.* before the sentence and takes the page's one attention colour. Only for a member the fleet lists for this person: anybody else's page has no line, never a zero. Nothing is drawn while it loads; a load that failed says *Spending could not be loaded.* with the reason under it; a fleet from before budgets draws nothing | the same, as a fact under the member's record, the same words (`test/budgets-in-apps.test.js`) | `fleet_budgets` reads it over MCP |
| **delegations** (`/api/delegations`; `members` in a grant) | You › Delegations: what this person signed for the fleet to send in their name, each with where and until when, and Revoke. Under *An MCP client*, a switch for each member the fleet lets this person start as (`you.startAs`), *Start sessions as Debbie*, all off until one is turned on, with *The MCP client may start a session as a member turned on here, on that member's sign-ins, and as no other member.*; no switch is drawn when the fleet lists none. *Allow for a day* and *Allow for a week* sign the grant with the members turned on as `members`, each id once and in order, and with none the field is left out, so the grant is the bytes it always was. A delegation that names members ends its row with *starts sessions as Debbie*. A start as a member that the fleet places names that member in the ten-minute grant the phone signs for it | the same, full screen, the same words (`test/delegations-apps.test.js`) | — |
| **approvals** (`GET /api/approvals`, `POST /api/approvals/{id}`) | You › Organization › Approvals, a row for everybody, with *2 waiting on you* beside it when any are and nothing when there are none or the fleet did not say. *Waiting on you* first (waiting, and `mayAnswer`), or *Nothing is waiting on you.*; then *Your asks*, the person's own that somebody else has still to answer; then the rest behind *Finished*, closed. Every approval is the same shape: *Start a session as Debbie*, *Asked by* whom and when, each reason as the fleet's sentence, a note when there is one, *Task t4*, which opens that task, and where it stands in words (*Waiting on you*, *Waiting for an answer*, *Approved by …, for one start within the hour*, *Declined by …*, *Approved by … and used*, *Ran out before it was answered*); a state from a newer fleet is shown as sent. The attention colour is on the state of the ones waiting on this person and on nothing else. *Approve* and *Decline* only on those. Approve asks once, with the reasons and *Approving is for this one start, within the hour.* Decline opens a page for a note: optional, counted in bytes against the fleet's 300, *The note is told to the person who asked.*, and Decline waits while it is over. What the fleet says of an answer is the page's line, a refusal's sentence included. Loading, *Could not load the approvals.*, *No approvals yet. A start that needs one is listed here.* and *Approvals are not on this fleet yet. It may need an update.* are four different screens | the same, full screen: Approve and Decline are two buttons under the approval, Approve's question is a dialog, Decline's note a page of its own, and *Finished* is a row that says Show or Hide | `fleet_approvals` lists them over MCP; no tool answers one |
| **what needs approval** (`GET /api/budgets` `settings`, `PUT /api/budgets/settings`) | Approvals › *What needs approval*, a row for everybody. *When a member is past its budget*: three choices of one shape, *Count only*, *Ask first* and *Refuse*, each with one line under it (*Budgets are shown and stop nothing.*; *A start past a member’s budget waits for approval.*; *A start past a member’s budget is refused until the month turns or the budget is raised.*), a mark on the one chosen, said to VoiceOver as *Chosen*, who last set it, and under them, always: *Counting is at API prices, as each session counts its own cost. Sessions already running are not stopped.* *Before a start*: *Ask before a session that skips permission prompts*, and, only on a fleet that sent the switch (`settings.paidApi`), *Ask before a session on a paid API key*, with *A key is billed by the token and no budget here counts it, so this is on until an admin turns it off.* under it; a fleet from before the guard draws no switch and no word about it. *Kinds of work that need approval*: every kind a row, or *No kinds of work yet.* An admin, as the fleet's answer says who is one (`you.admin`), has the choices as buttons, the switch, *Remove* on each kind, a field and *Add the kind* (not offered at the fleet's 20), and *Save*, which sends all three in one request and then, where the fleet sent the paid-key switch and the draft moved it, `{ paidApi }` in a request of its own; a draft that differs says *Not saved yet.*, and what the fleet says of a save is the line under it. Anybody else reads the same page with no control: each switch as *On* or *Off*, and *A fleet admin sets these. Anybody can read them.* Loading, *Could not load what needs approval.* and *Budgets are not on this fleet yet. It may need an update.* are three different screens, and none of them draws a choice nobody sent | the same, full screen: the choices are radio rows for an admin and say *Chosen* in words for anybody else | — |
| **a start that needs approval, or stopped at a budget** (`start` refused with `needs_approval` or `over_budget`, `approval.mayAnswer`) | Wherever a member start is sent and its answer drawn: Sessions (New session › As), a member's page, a task's page. The fleet's sentence in full, known by its code and never by its wording. Where the fleet says the approval is this person's to give: *Approve and start*, which sends the approval and, when the fleet took it, the same start again, once, with *Approves this one start and sends it again.* under it; on Sessions that card wears the attention ring. Where somebody else must give it: *Try again*, which sends the same start. At a budget the fleet refuses outright: the sentence, and nothing to press. A refusal to approve is its sentence under the button, and then no start is sent. The second answer is drawn like any start's answer. The notification is titled *Needs approval* or *Over budget* | the same card, in one place: every start on Android is sent from Sessions and answered there, so a start from a member's page or a task's shows its card on Sessions | a refused start says the same sentence |
| **what a budget is, on a member's form** (`budgetUsdMonth`) | Edit a member › *Monthly budget (USD)*, with *Dollars a month, at API prices. Approvals decides what happens when it is passed.* under it, where it said nothing enforced it | the same | — |
| **budgets and approvals as notifications** (push `kind` `approval`; `kind` `budget` with `member`) | A tap on an approval's notification, asked of this person or their own ask answered, opens You on Approvals. A tap on a budget's opens You on that member's page, where *This month* is; the id is read as a member's id (lowercase letters, digits and hyphens, at most 40) or not at all | the same; the member's page opens over Organization, and a notification the app drew itself carries `member` with the extras it already carried | — |
| **budgets and approvals in Recent activity** (events `budget.warn`, `budget.over`, `approval.asked`, `approval.answered`, `approval.used`, `budgets.changed`) | *Budget nearly spent*, *Over budget*, *Approval asked*, *Approval answered*, *Approval used*, *Budget rules changed*, where the row had the bare kind | the same | — |
| **a start that waits for a paid key** (approval `reasons` kind `paid-api`) | Drawn as every reason is, by the fleet's sentence (*Debbie has an engine that bills an API key by the token, which no budget here counts.*): on the approval, in Approve's question and on the refused start's card. Neither phone has words of its own for the kind | the same | a refused start says the same sentence |
| **add a sandbox provider** (vault `put` and `forget`, item `sandbox:e2b`) | Machines → Hypervisors → *Add a sandbox provider*, under Add a hypervisor. *Provider*: *E2B*, as text, there being one. Its API key in a hidden field. *Templates*: every one a row with *Remove*, or *No templates yet.*; *Template id* and *Name* (optional, the id when left empty, cut at the vault's 60 characters) and *Add the template*, not offered at the vault's 12; an id the vault could not read is refused there in a sentence, because the vault drops one without a word. *Before you keep it*, above the button: *The key is your whole E2B account.* *A machine made there is on E2B’s cloud, and E2B can read what runs on it.* *It ends on a timer.* *A template has to be built to join your fleet. One that is not stays up, unused, until its time runs out.* *One of your machines makes these, and only after its operator turned E2B on there.* *Keep in your vault* is not offered without a key or without a template, and sends the key and every template as one record to the person's own vault, never a member's; what the vault says is the line, a refusal's sentence included. The key is emptied once it was taken and when the screen is left. A kept one is a row, *E2B, sandbox provider*, *Kept*, *Since* when, with *Replace*, which is the form again, empty, saying *Nothing kept is shown. Enter the key and every template again.*, and *Forget*, which asks first. With no GitHub sign-in on the phone, loading, and a vault that did not answer are three different screens, and the form is not drawn over a vault that did not answer | the same, full screen, the same words; the typed key is never saved with the screen | the signing page has the same row and form in the person's own vault, and none in a member's |
| **a sandbox provider among your hypervisors** (`/api/hosts` `hypervisors`, `kind: sandbox`) | Machines → Hypervisors: a row of the same shape, titled with the provider's name (*E2B*) where a hypervisor has its address and *Sandbox provider* where one says its kind, with the same one status. Its page: the sentence, *3 templates* and how many machines were made there, and each machine of yours that was given its key with *Reached*, *Can't reach* or *Not checked*. No pools, no version, no edge router, no machine of its own, and no setup action | the same | `fleet_status` marks its templates |
| **a machine from a sandbox template** (`vmImages` `kind: sandbox`, `provision` with `platform: vm`) | New session › Where: *New machine from Base image on E2B*, among the machine images, and never *ready now*. Chosen, the line under Where is *A rented machine on E2B’s cloud. It ends when its time runs out, with everything on it.* No network, group or lab is offered for it, whatever was sent, and the Claude prompt is not drawn: a rented machine is handed no sign-in | the same | `fleet_provision` takes the template |
| **a rented machine** (`vmMachines` `kind: sandbox`, `vmctl` `extend` and `stop`) | Machines lists it under *At a sandbox provider*, apart from *On your hypervisor*, with *on E2B* where a machine of yours has its address. Its page: *On* E2B, *State*, *Made from*, *Ends*, and *Rented from E2B, on its cloud. E2B can read what runs on it.* *More time*: *30 minutes from now*, *1 hour from now*, *2 hours from now*, with *The time is counted from now, as E2B counts it.*; *End it now*, which asks first (*E2B removes it, and anything on it is lost.*). No console, no SSH address or terminal, no restart and no size. On the machine's own fleet page the row to it reads *At E2B: more time and end* | the same | `fleet_vmctl` |
| **a machine on one of your own machines** (`hypervisors`, `vmImages` and `vmMachines` with `kind: sandbox` and `own: true`; `provision`, `vmctl` `extend` and `stop`) | The same screens as a sandbox provider's, and none of its words: a container on a machine you enrolled is not rented, is on nobody's cloud and is read by nobody else. A row that says no `own`, as from an older coordinator, is a provider's. Machines → Hypervisors: a row titled with that machine's name (*deb132*) and *One of your machines* where a provider says *Sandbox provider*. Its page counts *1 image* where a provider's counts templates, and says *deb132’s operator turned this on, on that machine, and turns it off there.*; it offers nothing, there being no key to replace or forget, and *Add a sandbox provider* is unchanged. While that machine has no image to offer (it is building one, or the build failed), its own sentence on why is drawn in the attention colour, on the row where the one status would be and on the page where the verdict would be, whether or not it was reached, so neither says *Ready* over it. New session › Where: *New machine from Linux, with the fleet on deb132*, and chosen, *A container on deb132, one of your own machines. It ends when its time runs out, with everything on it.* No network, group or lab is offered. The Claude prompt IS drawn, as for an image on a hypervisor (*Set up Claude first, or this session can't start.*): a machine there is handed your sign-in when it joins. Machines lists it under a third heading, *On one of your machines*, with *on deb132* where a machine on a hypervisor has its address. Its page: *On* deb132, *State*, *Made from*, *Ends*, then *A container on deb132, one of your own machines.* and *A network, a lab, a restart, a resize and a console need a hypervisor.* *More time*: *30 more minutes*, *1 more hour*, *2 more hours*, with *The time is added to when it would have ended.*; *End it now*, which asks first. No console, no SSH address or terminal, no restart and no size. On the machine's own fleet page the row to it reads *On deb132: more time and end*. With no name sent, *one of your machines* stands where the name would be, and the page's line about the switch starts *Its operator turned this on* | the same, the same words (`test/api-engines-in-apps.test.js`, the tests under *A machine on a box of your own*) | `fleet_status` says its image is on one of your own machines; `fleet_vmctl` |
| **runner tokens** (`/api/runner-tokens`) | Runner tokens under Add a machine: mint, shown once, list, revoke | Runner tokens under Hosts, the same | curl |
| **your hypervisors, both kinds** (`/api/hosts` `hypervisors`) | Machines → Hypervisors, admins only: one row per Xen Orchestra pool or Proxmox VE cluster, with what each machine holding it saw; a pool this phone holds opens its page, anything else what each machine saw, its facts, and for Proxmox VE Set it up again | the same page, full screen, the same words (`test/hypervisors-in-apps.test.js`) | — |
| **add a hypervisor** (`xoprobe`, `xosetup`) | Machines → Hypervisors → Add a hypervisor, admins only: the address, both kinds as rows under it, the kind found from the fleet's probe (`xo`, `pve`) and this phone's look at Proxmox VE's port marked *Found at this address* and its setup opened with the address filled in; *Couldn't tell what's at X. Pick one.* above the rows when nothing answered as either | the same | — |
| **install Xen Orchestra on a pool that has none** (`xoprobe`'s `ssh`, `xosetup` `deploy`) | Add a hypervisor → This pool has no Xen Orchestra yet, offered only when no machine found one: the pool master's host key compared, its root password and a new admin password, then the install and the setup as one Live Activity | the same, as its own screen, and one ongoing notification | — |
| **a pool only this phone reaches** (`/api/xosetup/relay`, `relay`) | Try through this phone, when no machine reached it and the fleet named one that can; the phone checks the certificate itself first | the same | — |
| **a Xen Orchestra on plain HTTP** | offered after the HTTPS machines; a warning card says the password and token cross unencrypted, with how to give it HTTPS; Begin waits for "Send it without HTTPS anyway" | the same card and switch; Set up waits for it | — |
| **a certificate that does not check out** | shown in full under Sign in (problems, issued to and by, dates, names, SHA-256); Begin waits for a toggle | the same, in a card; Set up waits for a checkbox | — |
| **setup progress with the app closed** | a Live Activity on the Lock Screen and in the Dynamic Island (`/api/xosetup/activity`) | one ongoing notification with a progress bar, ProgressStyle on Android 16 | — |
| **a notification's words** (`pushKey`, `docs/push-encryption.md`) | the notification service extension opens the envelope and rewrites the alert before it is shown; a seal it cannot open, or runs out of time on, leaves "Something needs you. Open to see." and no buttons; the buttons are the sealed category's, and none when `aps.category` disagrees with it; a Keychain error registers with the last key sent rather than none, and one that lasts three registrations over a day replaces the key (a failed replacement sends the last key sent too, and keeps the count); only a phone with no key sent on record registers without one, which a reinstall whose first registration meets a Keychain error is; You says so while the phone does not know it can open them, in one sentence for a key it could not use ("Notifications sent to this phone may arrive without their words") and another for a seal that did not open ("The last notification sealed for this phone arrived without its words"), learnt from registrations and from what the extension left on the notifications the app is shown | Android 12 and later: `onMessageReceived` opens the envelope before it reads `kind`, and posts the notification itself, data-only and so not to a force-stopped app; the same sentence when it cannot, the same rule for the buttons, and a tap opens what a tray notification's tap opens; a Keystore error, or a self-test failure on a key already sent, registers with the last key sent, and the same three over a day (two in one minute count once) replace the key; no key at all with one sent is a failure too, and still sends the last key sent; the same two sentences on You, learnt from registrations and from each seal `onMessageReceived` opens or cannot, dated by when it was sent. Android 11 registers no key and stays on plaintext | — |
| **what the fleet may use on a pool** (`xosetup` `policy`) | Machines → Hypervisors → the pool → Change what the fleet may use, an admin's row on the pool's page: the admin sign-in, then storage, networks, internet access and limits from the pool's own inventory | the same, under Machines | — |
| **a user per box** (policy `boxes`, `retireShared`; status `boxHandoff`) | Above Apply, where the box says `box-users`: each machine approved for the pool is named and the shared user is withdrawn once each of them has its token. The phone reads its vault and the fleet's machines to name them, sends nobody when it cannot read either, files `hypervisor:<address>+<box>` from the sealed hand-off, and drops the shared item from the vault when the machine says the hand-over is done; the copy on the phone stays | the same sentence, the same send, the same filing (`test/xo-box-cutover-in-apps.test.js`) | — |
| **a pool Xen Orchestra stops showing** (`pool-lost`, `pool-back`, category `fleet.pool.reconnect`) | a notification to the owner and the admins: Reconnect on an admin's phone, whoever's pool it is, `.foreground` and `.authenticationRequired`, opens the reconnect from the machine that noticed; a tap on the body opens the pool's page, or Machines for a pool this phone does not hold. Pools back replaces it where the push is unsealed (`apns-collapse-id`), and arrives beside it where it is sealed | the same, drawn by the app as one notification per pool (`PoolNotice.kt`); Reconnect is an activity PendingIntent, and Pools back always replaces the loss | — |
| **reconnect a pool's servers** (`xosetup`, `purpose: reconnect`) | Reconnect its servers, an admin's row on the pool's page once it has loaded and shows no pool or lacks one kept from setup, and the push's Reconnect: what the machine will do said first, Face ID opens the kept sign-in and begins, sealed under its own binding and sent only to a machine whose `begin` lists `reconnect-signin` (a push's machine that is too old, and the others are asked); then each server's name, address and what became of it, and the pools Xen Orchestra shows now, opened with a key held in the screen's memory, whether the job ended done or not; done while Xen Orchestra shows no pools is said as that, not Pools back | the same row and screen, full screen, behind the fingerprint or face; a machine too old is refused with words; the list of servers is drawn however the job ended, and a failed one offers Start again | — |
| **reconnect progress with the app closed** | a Live Activity marked as a reconnect: Reconnecting Xen Orchestra’s servers, then Pools back, The pools did not come back or Reconnecting cancelled, counts only | the ongoing notification, the same titles; done says to open it for what each server came to | — |
| **add the reconnect watchdog to a Xen Orchestra without it** (`xosetup` `watchdog`, `purpose: watchdog`, through the pool master) | Add the reconnect watchdog, an admin's row on the pool's page: the pool master's address (filled in when this phone's record names one), a machine that reaches it over SSH, its host key compared, its root password, and what will happen said before the button; then the five steps and the machine's last sentence, which says whether Xen Orchestra's VM was started again. A Live Activity marked as a watchdog: Adding the reconnect watchdog, then Watchdog added, The watchdog was not added or Adding the watchdog cancelled | Add the reconnect watchdog, an admin's row on the pool's page: the pool master's address (the one an install kept, else typed), a machine that reaches it over SSH, its host key compared, what happens said (Xen Orchestra's VM shut down for a minute or two and started again), its root password sealed under `xowatchdogAad` with the address Xen Orchestra answers on; then the five steps and the machine's own last sentence, and the ongoing notification with its titles | — |
| **set up Proxmox VE through a machine** (`xosetup` `pve`, `purpose: pve`, for a node the phone cannot reach) | Hypervisors › Add a hypervisor › Proxmox VE › Set it up, when the phone cannot reach the node: opens with the address and password carried over, asks the machines at once and chooses the first that reached it, its host key compared in the node's Shell, the root password sealed under `pvesetupAad` with a key for the line; then the eight steps with how far into each, a Live Activity under Setting up Proxmox VE, and the line opened under `pvesetupHandoffAad` and kept in the vault. The screen may close: the key is in the Keychain (`ProxmoxThroughHandoff`) and the line is collected when the app is next in front | The same, from the same Set it up, with the ongoing notification under the same titles | — |
| **what a Proxmox VE machine showed as it booted** (`logs` `service: boot`, `docs/proxmox.md` "A machine that does not join") | a box's page → Logs → Machines it made: one row per machine the box made, newest first, Joined, Booting or Didn’t join; each opens what its screen showed | the same page, full screen, the same words (`test/boot-logs-in-apps.test.js`) | — |
| **a pool, managed from the phone** (phone-direct, `docs/manage.md`) | Machines → Hypervisors → the pool: when it was last updated, then its pools, hosts, VMs and storage as one kind of card; each opens What it is, How it is, What it can do. The token setup handed back, the certificate pinned at setup checked in the TLS challenge; actions only where the server lists their method: start, resume, unpause, a snapshot, clone, shut down, reboot, pause, suspend, force a restart, force off, delete, vCPUs and memory while stopped, growing a disk, a host's maintenance mode and reboot. One tap, a question naming what it interrupts, or the name typed back | the same page, full screen, the same words (`test/fixtures/parity/manage.json`, run by both) | — |
| **a machine on your hypervisor** (`vmMachines`, `vmctl`) | Machines → On your hypervisor → its page, and from a `vm-` host's page: state, image, pool, network, size, end; the SSH command; Console, in the app, where this phone holds the pool's token and the machine is running (VMConsoleView, the pool page's), else Open its console in Xen Orchestra; Restart, Give it longer, Restart with this size, End it now, each asking first | the same page, full screen (ConsolePage) | — |
| **a VM's console from away** (`GET /api/xoconsole/tunnel`, protocol 17) | Console on a pool's page read through one of your machines opens through one, and a machine's page tries the pool first and that way once; the console's own URLSession through a loopback CONNECT proxy (ConsoleTunnel), the TLS and the pin this phone's; which machine carried it said above the screen | the same, with the pinned TLS layered on a loopback socket (ConsoleTunnel.kt) | — |
| **a page through one of your machines** (`GET /api/browse`, protocol 18, `/api/hosts` `browse`) | Open a port on a running session's page, where its machine contains sessions, asking which port and opening `http://localhost:<port>/`; Browse on a machine's page for somebody who administers it, where its owner listed names or turned on the web, with what it opens listed before any page; an address bar, Back, Forward and Reload, and a line when a page is not secure. The web view's data store is its own and keeps nothing (BrowseView); the proxy on loopback answers only that web view's name and password (BrowseTunnel) | the same, in a full-screen dialog; the proxy set with ProxyController for the screen, `localhost` included, and taken off with the cookies and storage when it closes (BrowsePage.kt, BrowseTunnel.kt) | — |
| **the pool's own machine asking to join** (`/api/holders`, policy `holderSecret`, `holderAgain`) | Machines, first: `<name> asks to join`, with the attention ring; the phone that made it checks the request's proof against the secret Apply made and lets the key in by itself, approving it for that pool's record alone, as the card appears and from the push that says it asks, which wakes the app and then says it joined; Let it in and Decline stay for a request it could not settle (a phone that did not make it, or a secret from before behind Face ID); the push carries Let it in, which opens Machines. The policy's Make it again for one that never joined | the same: let in from the card and from the push as it arrives (HolderNotice), a secret from before behind the fingerprint or the screen lock, the same words (`test/holder-join-in-apps.test.js`) | — |
| **the pool's own machine, which runs no sessions** (`/api/hosts` `holder`, `takesSessions`) | Machines and its page: This pool’s own machine. It holds the pool for the fleet and runs no sessions, where another machine says who can start one, and never the attention ring for it. New session → Where offers only machines a start would reach | the same, the same words (`test/holder-sessions-in-apps.test.js`) | — |
| **Make it again from the pool's own machine's page** (`/api/hosts` `holds`) | Its page, for the admin whose pool it is, on a phone holding that pool's token: Make it again, under the pool's address, opening the pool's policy screen, which after the sign-in sends the choice by itself with the switch on and nothing else changed, saying Replacing `<name>` with a new one on `<uplink>`; the form, with one line on why, only when it could not | the same, the same words (`test/holder-sessions-in-apps.test.js`) | — |
| **a pool's or a cluster's edge routers, and one short of memory** (`/api/hosts` `vmEdges`, each router's `memory` and `needs`) | Edge routers, the second card on a pool's page and on a cluster's: one word per router and its DNS, as the machine reading them last did, or what is known before one has. It opens the routers' page: each in full, and what they logged lately. A router with less memory than it needs has a card of its own directly under that one, in the attention tone and wearing its ring, one sentence per short router (`<name>` has 2 GiB of memory and needs 4 GiB. It crashes with less.), and the same sentence first under its name on the routers' page. Then one button, Rebuild it with 4 GiB, and under it what a rebuild costs (Builds a fresh one. Machines have no internet access while it starts.), only where pressing it can work: for an admin on a Xen Orchestra pool this phone holds the token for, where it opens the pool's policy screen, which after the sign-in sends the pool's choice as it stands by itself (the form, with one line on why, only when it could not); and on a Proxmox VE cluster that says its router is there, where it opens the setup Make the edge router again opens, with the same options. Anywhere else the sentence alone. A router whose memory was not read, or read by a machine from before it said, is not short and draws nothing | the same cards, the same words (`test/manage-in-apps.test.js`) | — |
| **what the pool's machines may do** (policy `grants`, the pool record's `grants`) | The policy's Machines made here: Update their system from the app, Reboot from the app, offered only where the box says `machine-grants`; kept with the pool's token and in the fleet once the job is done | the same, the same words (`test/machine-grants-in-apps.test.js`) | — |
| **what a pool's machine images are built from** (policy `imageChannel`, inventory `images[].channel`) | The policy's Built from, under the images: Released versions or Every merge to main, offered only where the box says `image-channel`, starting from what the image there was built from; an image built from main says so | the same, the same words (`test/image-channel-in-apps.test.js`) | — |
| **SSH keys for those machines** | You → Credentials → SSH keys: public keys only, kept as `SSH_AUTHORIZED_KEYS` | the same, under You → Credentials | — |
| **which operating systems the image is made of** (`xosetup` `policy` `images`) | a switch per image the machine can build, under Internet access | the same | — |
| **the network a new machine goes on** (`provision` `network`) | New session → Where → Network, when the pool has one besides Default (internet only) | the same chips | — |
| **machines that work together** (`provision { group }`, policy `groups`) | the policy's Machines that work together: group networks from the ones there to 4, and what a machine is fenced from by default; New session › Where: Work with others on; a machine's page names its group, its address there and its .local name | the same: a stepper, chips, the same facts | — |
| **machines kept ready** (`/api/vm-standby`) | Machines → Keep machines ready: an image, a network, 0 to 3, how many are ready now and being made, and what it costs; New session marks the image with one ready. Why the last one did not come is the word for its `failed.code` (Didn't join, Refused, Couldn't reach) with the machine's sentence under Details | the same, full screen, the same words | — |
| **why a machine is not healthy** (`/api/hosts` `reasonCode` beside `reason`) | The Machines row says the word for the code (`ReasonWords.swift`: No Claude login, Login expired, Not answering, Getting login…, No report yet, Not reporting, Dropped, Connecting…), and the machine's page says the word with the fleet's sentence under a Details disclosure. No code, from an older coordinator or for a machine the list composed the sentence for, puts the sentence on the row as before | the same words (`ReasonWords.kt`), the same row and page, an expandable Details (`test/reasons-in-apps.test.js` holds the two tables equal by name and value, and to every code the coordinator can send) | the sentence, which the fleet still sends |
| **a refusal on the Sessions status card and over a notification** (`error.code`, `error.why`) | The card leads with the title for the code (`ReasonWords.refusal`: No machine available, Machine offline, Not your machine, Machine busy, Name in use, Which machine?, Refused, and the rest), with the coordinator's sentence under Details, collapsed; a start or a provision refused is a notification titled the same with the sentence as its body. The start keeps its two own titles (Not started: only admins run sessions there; Not started: the machine needs an update) | the same titles, the same card and notifications | the sentence |
| **Recent activity** (`/api/events`) | one row per event, newest first, runs collapsed: the kind's label (`ReasonWords.activity`: Asked for start, Machine enrolled, Pool lost, Claude login ended, and one per kind the coordinator records) with its subject in mono (the session or pool it names, else the machine), who and when under it, and the fleet's sentence on a tap; a kind this build has never met shows the kind itself | the same, with an expandable Details for the sentence | — |
| **a setup's end notification** (`xosetup` push, `state`, `phase`, `purpose`) | the notification service extension words it from the job's state and purpose (`SetupNoticeWords.swift`: Hypervisor added, Hypervisor setup stopped, Pools back, Proxmox VE set up, and the rest), the body saying where and to open it; the machine's sentence travels as `text` and is shown on the setup page a tap opens, not on the Lock Screen. A phone with no push key sent, where no extension runs, shows the coordinator's title and sentence as before | `XoSetupNotice.kt`, the same words, which drew its notification this way already (`test/reasons-in-apps.test.js` holds every iOS title and body to Android's) | — |
| **the pool's token, once set up** | handed back sealed to a key sent inside the sign-in, kept in the Keychain (this device only); collected at launch if the app was closed; the setup screen says it is kept only once it is | the same, kept encrypted under the Keystore key; collected at sign-in and launch | — |

**A gap this table caught, in the round that added the profile row.** Android's
`SessionKind` had no `host` field at all, while iOS has had one since placement
shipped — so a kind naming a box did nothing on Android, silently. A setting
that works on one phone and not the other is worse than one that works on
neither, because nobody goes looking. Both now carry `host` and `profile`, and
the iOS voice path was passing neither: spoken, only `mode` survived.

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

**Step 2 closed too, and mostly before this document noticed.** Going to build
it found it already built — session length ships as `startedAt` (a timestamp,
not a duration: a duration is stale the moment it is serialised, and the phone
doing the arithmetic is the only place it can be right), the Claude plan ships
as `account.plan`, and the host's commit and how far behind it is ship as
`version` and `updates`. Both apps render them.

Two things were genuinely left:

- **The update check sat on the health path.** `updates` did a `git fetch` and
  an apt list refresh *inside the function that builds a health frame* — frames
  go every fifteen seconds and are what the coordinator ranks hosts on, so most
  were instant and the one after a cache expiry was not. It runs on a timer now
  and health reads the last answer, which is what step 2's fourth bullet asked
  for in the first place.
- **Context-window usage is still not knowable.** It lives in the transcript and
  no `claude` status exposes it. Recorded as open rather than estimated: a
  number nobody can check is worse than a gap somebody can see.

**Nothing is left in this list but that one.**

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
cannot update a box too old to have `update`. What works is a shell on that
box, which reaches fleetwright directly rather than through this protocol (its
own Telegram bot did too, before that adapter was archived). A pull that did
not restart looks identical from the coordinator, and is at least as common —
so the shell line says `--restart`.

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

## What is actually proven about the apps

Written because a beta tester found **four documents giving four answers** and
could not tell what installing the beta would get them (#336). One table, and
everything else defers to it.

| | State | Evidence |
|---|---|---|
| Both apps compile | **yes** | CI builds them on every PR |
| Both apps run | **in simulators/emulators only** | `app-testing.md` |
| Sign in, hosts, sessions, pins, revocation | **built, exercised in simulator** | `app-testing.md` |
| **Push delivered to a physical phone** | **confirmed, 3 Sep 2026** | iPhone and Android phone, reported by the maintainer running the fleet |
| App Store / Play distribution | **beta tracks live** | TestFlight and Play open testing |

**Push was the one to be careful about, and no longer is.** A beta tester
called the Play listing **off-brand** for selling it as *"the point of carrying
this in a pocket at all"* while every internal document said it had never
reached a phone. They were right at the time, and the listing was hedged.

On 3 Sep 2026 it was confirmed on both an iPhone and an Android phone, so the
listing says the confident thing again — because now it is true, which was
always the condition rather than the wording.

Worth keeping the shape of that: the claim was withdrawn when it was unproven
and restored when it was proven, rather than argued about. The evidence is
somebody with the devices saying it worked, which is the only evidence this
row could ever have had — no test in this repository can produce it.

### Three places, the same on both phones

The gap this section used to record (a machine's page on iOS, its controls split
across a card, a dialog and a second list on Android) is closed, and so is the
larger one under it: one settings form doing three jobs. Both phones now have
the same three places, in the same order, with the same things in them.

| Place | Its one job | What is in it |
|---|---|---|
| **Sessions** | what is running, and answering what is asking | the reassurance line (it opens the machine it names), the session cards (answer, stop, resume, open), New, Bin, Recent activity. A session's page holds Files, Output and Forget. |
| **Machines** | is each machine well, and doing something about one | one list, facts only, reporting and silent machines alike; each card opens the machine's page: what is wrong, software, logs, identity (Claude sign-in, Key, Approve for your credentials), releases, image, labels, house rules, reboot, revoke, replace key. Add a machine is one row after the list. For an admin, one Hypervisors row: every pool and cluster, one status each (Ready, Can't reach, Waiting for a machine, Needs Proxmox VE 9, Checking, Unknown), and the one Add a hypervisor; a hypervisor's page leads with one sentence, then its machines and details; each pool this phone holds opens its page, what is on it and what can be done there, phone-direct (`manage.md`). |
| **You** | who you are here, what your sessions may use, and setup | first run (fleet address, sign-in, demo) in that order; account and devices; GitHub on this phone; Credentials (the vault first, links made on a box as facts, and Your managers for somebody who has any); Temporary machines; Linked repositories; Organization (the members, the tree, a member's page); Tasks (the ones that came back first, a task's page, New task); notifications; Siri; This fleet. |

**Admin-only rows are drawn for admins.** People, revoking a machine and
revoking a device come from `GET /api/me`, which answers with the flag the
coordinator's own guard reads. A member sees none of them rather than a control
that refuses after the tap; not knowing (an older coordinator) draws nothing.

**Not yet true of a machine's own controls.** Releases, image, labels, the
software update and reboot are the admin's on every machine, and a member's
only on a machine that acts for them alone; on any other the coordinator
answers a member's with `not_admin` (`place`, `scheduler.js`). Each host in
`GET /api/hosts` says which with `administers`: true where these controls do
something for the person asking, false where the coordinator would refuse
them, and absent from a coordinator too old to send it, which is cannot-tell.
It comes from the same rule placement refuses with (`administers`,
`hosts.js`), so the two cannot disagree. Both phones draw those controls only
where `administers` is true, and say once, at the top of the section, why they
are absent otherwise (`HostView.swift` `mayActOnBox`, `MachinesScreen.kt`
`actsOnBox`); "Check for updates" stays on every machine because `updates` is
a read. A coordinator too old to send `administers` is cannot-tell and keeps
the controls, with the box's own refusal to explain a tap.

**An admin can view the fleet as a member** (You, This fleet, View as a member).
Every request then carries `x-fleetwright-view: member` and the coordinator
answers it as a member's, so the lists are the member's lists and the refusals
are real ones, not this view with rows hidden. The session list says so, with
Switch back beside it; signing out leaves it.

**One way to get a temporary machine.** New session, Where, a new machine. The
standalone request that started an empty machine is gone from both phones.

The words are held equal by the tests that were already doing it
(`runners-from-phone-in-apps`, `runner-repo-in-apps`, `grants-in-apps`,
`house-rules-shown`, `session-screen`); the structure has no test of its own,
which is why this table exists.

**And the row is narrower than "push works", which is worth saying while the
correction is fresh.** Delivery is confirmed. A cold-start wake, a locked
screen, a notification acted on four minutes late, and Android's Doze are
separate facts — none of them has a row here, and none of them should be
claimed until one does. The discipline that made the withdrawal worth having
applies to the confirmation too.

**The history is kept rather than deleted**, because the row being wrong is not
what this table is for — it is for the row being *checked*. The delivery path
was built and unit-tested end to end here for months while never having been
confirmed on a real device, and the Play listing sold it as *"the point of
carrying this in a pocket at all"* until a tester — who had praised this
project's documentary honesty at length — called that **off-brand** and said as
a reviewer they would call the listing overdrawn. They were right. The listing
was corrected to what was true then, and it is a different sentence now for the
same reason: it says what is true.

**The claim is still narrower than it sounds**, and the discipline that made
the correction worth having applies to the confirmation too: one delivery, to
one phone, on one platform pair. It is no longer *unproven*. It is not yet
*proven at every stage* — a cold-start wake, a locked screen, a notification
acted on four minutes late, and Android's Doze are separate facts, and none of
them has its own row here yet.

**This table is the source; everything else defers to it.** The README, the
ROADMAP and both store listings point here rather than restating it, because
four sources of truth is none — and the way that failure showed up was not one
document being wrong, it was four being checked against each other while none
was checked against a phone.

So the rule, which is the actual finding rather than any single row: **a claim
about what the apps can do changes here first, with its evidence, and the
places that link here do not paraphrase it.** A row that cannot name how it was
established does not belong in the table.
