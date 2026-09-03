# Task at start

The highest-ranked thing in either beta report. **Decided and shipped in v3** —
the reasoning is kept in full below, because the decision was a judgement about
when to spend a coordinated release and that is worth being able to re-read.

## What was wrong

`fleet_start` took a `brief`. It was stored and never delivered — the session
came up as an idle REPL. So the loop the MCP server's own instructions teach
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

## The decision: v3, taken 2 Sep 2026

> "And screw it we can v3 it"

`start { profile }` needs a **new parameter on an existing verb**, and this
project's rule is explicit: adding a verb is free because an old host answers
`unknown_verb`, while adding a parameter is a **flag day** — an old host answers
`bad_params` *after* the version handshake has already agreed. `title` and
`brief` cost a version bump for exactly this reason.

It is not hypothetical. A beta tester met a host two releases behind that
refused `fleet_files`, on this fleet, this week.

The three ways, and they were not equivalent:

| | Cost | Objection |
|---|---|---|
| **`PROTOCOL_VERSION = 3`** ← taken | A coordinated release of coordinator, Worker and every host | The honest one, and the expensive one. v2 was done this way |
| **A new verb** (`launch`) | Free — an old host answers `unknown_verb` | Two verbs that mean "start a session", diverging forever |
| **Host-side default only** | No protocol change at all | Does not solve it: every session gets the same profile, and the ask is per-session |

The middle one was tempting and wrong: `start` and `launch` would accumulate
separate parameters, and the second one exists only to dodge a version number.

`profiles` shipped in the same version, and it is the free half — an old host
answers `unknown_verb` to it. It is here because a `profile` you can only name
by guessing is not a feature.

**The apps are not part of this flag day.** `PROTOCOL_VERSION` is the
coordinator↔host contract; a phone speaks HTTP to the coordinator and is
unaffected by the number. Hosts first, then the coordinator — a v3 host answers
`unsupported_version` to a v2 coordinator and vice versa, so the window is
loudly broken rather than subtly wrong.

## What shipped

- **A host-side profile store**, `src/core/profiles.js` — `<name>.md` files
  under `AGENT_HUB_PROFILE_DIR` (default `/var/lib/agent-hub/profiles`). Content
  never crosses the wire. The name charset has **no dot**, so `..` cannot be
  spelled, and the resolved path is compared to the directory anyway.
- **`start { profile }`** as a bounded name, **refused** when the host does not
  have one — with the refusal listing what it does have, which is what the tag
  refusal already does well. Starting idle when a profile was asked for would be
  the `brief` failure a second time, deliberately.
- **The prompt delivered at creation**, as the CLI's own final positional
  argument. Never typed into a live pane: `sendKeys` would race the TUI's
  startup and put the text through tmux's key parsing.
- **`profiles`**, a read verb, so the list can be asked for rather than guessed.
- **`fleet_start` says which of the two things happened**, every time. "Started"
  reads as "working" either way and only one of them is.

The last of those did not wait on the decision and shipped a commit earlier.

## What this deliberately did not open

There is still **no way to send text into a session** — at start or later. The
set of things a session can be started with is exactly the set of files on that
host, and enlarging it needs a shell on it. That is the bound, and it is the
same one `docs/wanted.md` set before any of this was built:

> **The coordinator may NAME a profile; it may never CARRY one.**

## Status

**Done.** [#325](https://github.com/TheTechNetwork/Fleetwright/issues/325).

