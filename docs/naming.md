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

**iOS.** Fully free-form Siri phrases are not something an app can register —
`AppShortcut` phrases are compiled in and must contain `\(.applicationName)`.
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

**Android.** The same shape through dynamic shortcuts: each kind is pushed as a
`ShortcutInfoCompat` with a `shortLabel` the user chose, and Assistant matches
on it. Capabilities in `shortcuts.xml` bind the built-in intent.

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

## Not built yet, and why

**Free text cannot ride in a command line.** The sidecar translates intents into
chat command strings for `POST /api/command {command}` — so `start` becomes
`/new name --safe`. A title with spaces in it cannot go there without
re-introducing exactly the parsing problem that `answer`-as-an-ordinal exists to
avoid.

So the host bridge needs `title` and `brief` as **fields alongside** the command,
never inside it. That is a change to agent-hub's HTTP surface and it deserves
its own pass rather than being smuggled in with a protocol bump.

Also outstanding: the app UI, the kind editor, and the on-device generation
calls themselves.
