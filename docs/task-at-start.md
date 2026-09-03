# Task at start

The highest-ranked thing in either beta report, and the one open question that
needs a decision rather than a patch.

## What is wrong

`fleet_start` takes a `brief`. It is stored and never delivered — the session
comes up as an idle REPL. So the loop the MCP server's own instructions teach
(start → await → read_log) produces an empty log, an idle prompt, and **no
error anywhere**, which is the worst shape a failure can have.

The tester's summary, which is sharper than a bug report:

> "The product's own MCP pitch — hand a job to a Mac that did not exist five
> minutes ago, watch it, collect the output — is not achievable through the
> product."

They read `docs/plan.md`'s argument against free-text input and answered it
rather than being talked round:

> The never-build argument is strongest about *mid-session* free text —
> answering a question the model asked twenty minutes ago, blind. A prompt
> supplied **at creation, before the session exists**, has none of the
> staleness problem.

That distinction is real. `answer` refuses free text because a stale reply
reaches a live agent at an unknown moment. A prompt at creation reaches nothing
that exists yet.

## What is already decided

`docs/wanted.md` settled the security half before this came up, and it holds:

> **The coordinator may NAME a profile; it may never CARRY one.**

Injected text is instructions to an agent with root in a container. A
coordinator that chooses the content writes that agent's instructions, which is
a much larger capability than the verb set — the `reply { text }` argument in
different clothes. The content lives on the host; the intent selects among
things the host already has. `start` already takes a bounded `enum` for `mode`,
so the shape has precedent.

**Nothing below revisits that.** It is the delivery that needs deciding.

## The decision, which is not mine to make

`start { profile: 'reviewer' }` needs a **new parameter on an existing verb**,
and this project's rule is explicit: adding a verb is free because an old host
answers `unknown_verb`, while adding a parameter is a **flag day** — an old
host answers `bad_params` *after* the version handshake has already agreed.
`title` and `brief` cost a version bump for exactly this reason.

It is not hypothetical. A beta tester met a host two releases behind that
refused `fleet_files`, on this fleet, this week.

So there are three ways and they are not equivalent:

| | Cost | Objection |
|---|---|---|
| **`PROTOCOL_VERSION = 3`** | A coordinated release of coordinator, Worker, host and both apps | The honest one, and the expensive one. v2 was done this way |
| **A new verb** (`launch`) | Free — an old host answers `unknown_verb` | Two verbs that mean "start a session", diverging forever |
| **Host-side default only** | No protocol change at all | Does not solve it: every session gets the same profile, and the ask is per-session |

The middle one is tempting and probably wrong: `start` and `launch` would
accumulate separate parameters, and the second one exists only to dodge a
version number.

**Recommendation: bump to v3**, and carry `profile` with whatever else is
waiting, because the cost is the coordination rather than the change and doing
it once for two things is half the price of doing it twice.

## What would need to be true

- A host-side profile store: named entries, content never crossing the wire.
- `start { profile }` as a bounded value, refused when the host does not have
  one by that name — with the refusal listing what it does have, which is what
  the tag refusal already does well.
- The prompt delivered at creation, through the CLI's own initial-prompt
  argument, so it is never typed into a live pane.
- `fleet_start`'s reply saying a session came up idle when no profile was
  named, so the current dead end is at least legible while this is undecided.

The last of those is worth doing regardless and does not wait on any of this.

## Status

**Open, deliberately.** Tracked as
[#325](https://github.com/TheTechNetwork/Fleetwright/issues/325). The security
question is answered; the protocol question is a judgement about when to spend
a coordinated release, and that belongs to whoever is going to run it.
