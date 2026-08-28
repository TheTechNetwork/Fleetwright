# Naming a session

The smallest feature in this product and the one most likely to be abandoned
halfway. Worth its own document, because every wrong answer here is a wrong
answer about how people think rather than about how software works.

## The problem, stated as a person experiences it

You want to start a session. The system wants a name. You do not have one,
because you have not done the work yet — **the name is a summary of something
that has not happened.** So you either type something you will not recognise
later (`test2`, `asdf`, `new-thing`) or you stall, and stalling at a text field
is where people close the app.

Then a week later you open a list of eleven sessions and none of the names mean
anything. The cost was not paid at the moment it was incurred, which is the
worst shape a cost can have.

## Four rules, and what each one refuses

**1. Never ask a person to name a thing before they describe it.**

The blank field is the abandonment point, and it is blank because it is asking
for the *hardest* form of the information — a compressed label — as the *first*
input. Asking "what is this about?" is easy: it is recall, not composition. So
the description is the input and **the name is a suggestion you accept**.

This is why the generated-name feature is not a novelty. It is the thing that
makes the field answerable at all.

**2. The name is an identity. The title is a label. They are different fields.**

`name` is what the protocol routes on: stable, `[A-Za-z0-9_-]`, never changes.
`title` is prose for people and can be changed at any time without breaking
anything.

That separation is not tidiness — **it is what makes the first title cheap**. A
label you can change is a label you will guess at; a name you cannot is one you
will sit and think about. Half the hesitation at that field is fear of getting
it wrong permanently, and the fix for that fear is to make it true that you
cannot.

**3. Recognition, not recall.**

In a week, the list is scanned, not read. Nobody remembers `cc-brave-otter`;
everybody recognises *"refactor auth — split the token check out of the
middleware"*. The `brief` exists for exactly the moment of re-entry, and it is
the reason it is stored rather than being a throwaway prompt.

**4. Local, or it does not happen.**

Generation runs **on the device** — Apple's Foundation Models framework, Gemini
Nano through ML Kit on Android. Three reasons, in order of how much they matter:

- The description is about work in progress. Sending it somewhere to get a
  three-word label back is a poor trade nobody consciously agreed to.
- It works on a plane, on hotel wifi, and with the coordinator unreachable.
- It is instant and free, and a suggestion that arrives after a beat is a
  suggestion you have already typed past.

**On-device models are not on every device.** So generation is never on the
critical path: no model means the field is still answerable, with the first few
words of the brief offered as the title. A feature that only works on an iPhone
15 Pro cannot be the only way to name a session.

## Saying it out loud

Asked for directly: a word the user sets, so *"start a new dev session"* or
*"start an orgi"* works from Siri or Google Assistant.

### The app name is the wrong thing to make somebody say

Worth stating before the mechanics, because it changes what "good" looks like.

*"Start a session in Fleetwright"* asks a person to hold four things in one
sentence: the machine, Claude, the project — and our product name. **Ours is the
only one of the four they do not care about.** They think *"another remote
session"*, or they think of the agent by a name they gave it. Making them
translate that into our brand every time is a tax we charge for our own benefit.

So the target is a phrase with **no name to learn**, and there are two routes,
because Apple's rule bites and Android's does not.

**Route one, no setup: other names for the app.** `INAlternativeAppNames` in
Info.plist is the escape hatch. Apple requires `\(.applicationName)` in an
`AppShortcut` phrase, but that token matches any of the alternatives — so
shipping *my fleet*, *my agents*, *remote sessions* means

> "start a dev session on my fleet"

satisfies the rule while containing nothing anybody had to be taught. This costs
one plist key and is the single highest-value line in the whole feature.

**Route two: a phrase they choose, set up from inside the app.** A shortcut the
*user* creates carries no app-name requirement at all, so it can be called
"Debbie", or anything else they already call this.

The honest boundary, because a pretend version of this screen would be worse
than none: **an app cannot register a Siri phrase programmatically.**
`AppShortcut` phrases are compiled in, and the old
`INUIAddVoiceShortcutViewController` — which really did let an app add one in
place — belongs to the SiriKit intents that App Intents replaced. There is no
supported call ending in "and now Siri knows *Debbie*".

So `ShortcutSetupView` does everything up to that last tap rather than claiming
it: takes the phrase, keeps it, puts it on the clipboard, opens Shortcuts. One
paste and one Done. Three seconds instead of a paragraph, which is the
difference between a feature and a support article.

It also does **not** say "set up" afterwards. It says the phrase is saved and
works once the steps are finished, because we cannot observe whether they were —
and claiming success for something unobserved is the exact habit this codebase
keeps finding in its own output.

**Android does not have this problem.** A dynamic shortcut's `shortLabel` *is*
the phrase, so the same screen finishes the job with no handoff. Same design,
one platform needing a step the other does not.

**Android has no equivalent constraint**, which is worth noticing rather than
envying: a dynamic shortcut's `shortLabel` is the phrase. The design goal is the
same on both, and only iOS needs the two routes.

### The mechanics

**iOS.** Fully free-form Siri phrases are not something an app can register —
`AppShortcut` phrases are compiled in and must contain `\(.applicationName)`,
subject to the alternative names above.
What *is* supported, and is what this wants, is a **parameterised phrase over an
`AppEntity`**:

```
"Start a \(\.$kind) session in \(.applicationName)"
```

The user defines their kinds — `dev`, `orgi`, whatever — and each becomes
speakable, because `AppShortcutsProvider` expands the phrase across the entity's
`suggestedEntities()`. So the phrase set really is user-defined, within Apple's
rules, and the app already has the `EntityQuery` scaffolding this needs. Anyone
wanting a phrase with no app name in it can still build one in Shortcuts, which
is the sanctioned route and costs us nothing.

**Android.** Each kind is pushed as a `ShortcutInfoCompat` whose `shortLabel`
is the word the user chose, and that label is what Assistant matches on.

**Which means the Android screen finishes the job.** Adding a word there is the
whole setup — no second app, nothing to paste, no last tap held back by the
platform. The `shortLabel` carries the user's word and nothing else: no product
name, no `Fleetwright:` prefix. That prefix is exactly the tax iOS imposes, and
adding it here voluntarily would be carrying a constraint across for no reason.

The two platforms therefore look different, and that is the correct outcome
rather than an inconsistency to iron out. Making Android match the iOS handoff
so the screens resemble each other would be consistency serving us rather than
the person holding the phone.

A shortcut tap opens the start sheet with the kind chosen, rather than starting
silently — a shortcut says what KIND of work, and the brief still says what the
work is. Skipping to a started session would hand back precisely the unnamed
session this feature exists to stop producing.

**A kind is not just a phrase.** It carries defaults — which host, safe or
dangerous, a title template — so *"start a dev session"* is a whole
configuration, not a name. That is the difference between a shortcut and a
macro, and it is why this is worth building rather than aliasing.

### Voice makes the design honest

Anything unsayable in one sentence does not work here, which is a useful
constraint to design against rather than around:

- **Parameters must be nameable out loud.** "on the Mac", not `label=macos,gpu`.
- **A spoken start cannot open a text field.** So the title has to be optional
  with a good default, which is the same requirement rule 1 arrived at from the
  psychology. Two routes, one answer.
- **The reply has to be speakable.** One short sentence the host writes,
  alongside the structured payload. A UI can ignore it; an assistant cannot
  invent it.

## What this changed in the protocol, and the trap in it

`start` now takes `title` and `brief`. That is additive — and it still forced
**`PROTOCOL_VERSION` from 1 to 2**, for a reason worth writing down:

> `validateIntent` refuses any parameter a verb does not declare. So an old host
> receiving `title` answers `bad_params`, *after* the version check has already
> said the two sides agree. A silent field would have been fine; a **rejected**
> one is worse than a version mismatch, because the handshake passes and then
> the work fails.

There is no way to add a parameter cheaply, and that is the design working. See
`app-parity.md` — everything else destined for v2 should land before v2 ships,
because the flag day is paid once.

A new `text` parameter type carries them, validated at the door: whitespace
collapsed, length in **characters and not UTF-16 code units** (or a truncating
client stores half a surrogate pair), control characters refused, and
bidirectional overrides refused outright rather than substituted. The console
already has a `scrub()` — but leaning on it means the rule holds only where
somebody remembered it, and the notification path, the speakable reply and every
future surface each get their own chance to forget.

## How prose reaches the host

The sidecar turns intents into chat command strings — `start` becomes
`/new name --safe` — and everything in that string is split on whitespace. A
title with spaces would arrive as arguments; a title reading
`refactor auth --dangerous` would arrive as a **flag**. That is the same mistake
`answer`-as-an-ordinal exists to avoid: a string that looks bounded and is not.

So prose travels **beside** the command, never inside it:

```
POST /api/command  { command: "/new job", title: "refactor auth", brief: "…" }
```

`toCommandLine()` builds the line and `commandMeta()` picks out the prose, and
they sit next to each other in the file on purpose — split across a module is
how one of them acquires a parameter the other has never heard of. There is a
test asserting the line is **byte-identical** with and without a title.

**Validated on arrival as well as on the way out.** `src/core/text.js` is one
`cleanText()` used by the protocol validator and by the HTTP route, because that
route is reachable by anything holding the hub token and not only by the sidecar
that already checked. Two doors into one store validating separately is the
shape of the `?token=fwk_` bug: two extraction sites disagreed and the
disagreement failed open.

**A supplied title is pinned.** Without `titlePinned`, the transcript hook
replaces it a few seconds later and the field looks like it silently did not
save.

**The title is not logged.** The sidecar logs the command line, which by
construction no longer contains it. A person's sentence about their own work has
no reason to be in a journal the whole box can read.

## Not built yet

The app UI, the kind editor, and the on-device generation calls themselves.
