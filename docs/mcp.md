# The fleet as an MCP server

```
Claude  ──stdio──▶  agent-fleet-mcp  ──https──▶  coordinator  ──ws──▶  host
                    (one device credential)
```

`ROADMAP` said this would be *"a thin adapter over `/api/intent`, not new
architecture"*, and that turned out to be true. The intent protocol was designed
as a fixed set of typed verbs with structured replies and refusals that name a
reason — which is the shape MCP asks for.

## The tools are generated, never written

`src/mcp/tools.js` builds them from `VERBS` in
[`intents.js`](../src/fleet/protocol/intents.js): parameter names, types,
required flags, enum values, length bounds and summaries are all already there.

Writing them by hand would create a second list to keep in step, and it would go
wrong in the worst direction — a tool offering a parameter the host will refuse,
or omitting one the verb needs, found by an agent mid-task rather than by anybody
reading either file. Adding a verb is already free (an old host answers
`unknown_verb`); this makes adding a **tool** free too, and a test asserts the
two lists cannot diverge.

One summary had to change: `start`'s said *"No path — see the note above"*,
which is a reference to a comment in a file no agent will ever open. A string
that is now read out of context has to be self-contained.

## What it is, precisely

**A member of the fleet holding one device credential, with exactly that
person's visibility.** Not an admin channel, not a second authority. The
coordinator decides what a caller may do and has not changed: if the credential
belongs to somebody who can see three sessions, so does the agent using it.

Revoking that credential in the app stops the MCP server, the same as any phone.

## What is not exposed, and why that is a policy rather than a lock

```
reboot, upgrade, update   restart a machine somebody else is working on
purge, forget, restore    destroy a conversation that cannot be recovered
connect, link, unlink     move somebody's credentials around
answer                    ← the interesting one
```

**Not a security boundary.** Whoever runs this holds a credential and can call
`/api/intent` directly with `curl`. This is about what an agent *reaches for
unasked*, which is a different question from what a person may do.

`answer` is the one worth arguing about. A subagent answering another agent's
prompt is not a permission question — the prompt exists because a session
stopped to ask a **person** something, and an agent that answers it has decided
on that person's behalf that it knew what they wanted. Sometimes true. Never
true by default.

Allow one explicitly when you mean it:

```sh
AGENT_FLEET_MCP_ALLOW=answer
```

Allowing one does not open the rest, and a withheld verb says it was **withheld**
rather than that it does not exist — two different situations, and an agent told
only "no" tries again differently instead of stopping.

## Running it

```json
{
  "mcpServers": {
    "fleetwright": {
      "command": "agent-fleet-mcp",
      "env": {
        "AGENT_FLEET_COORDINATOR_URL": "https://fleet.example",
        "AGENT_FLEET_CREDENTIAL": "fwk_…"
      }
    }
  }
}
```

The credential is a device token from the app — shown once, like every other
secret this fleet issues.

**stdout is the protocol.** Every diagnostic goes to stderr; a stray line on
stdout desynchronises the client, and the symptom is a server that "does not
work" with nothing to read. Even the refusal to start writes nothing there, and
a test asserts it.

**No SDK.** MCP over stdio is JSON-RPC 2.0 with three methods that matter. A
dependency is worth adding when it does something hard — framing
`{"jsonrpc":"2.0"}` is not hard, and js-yaml went in the moment hand-rolling
would have meant *missing* things rather than merely writing more.

## Reaching a temporary host

Every tool takes a `host`. It is not a protocol parameter — placement travels
beside the intent — and it is offered on all of them because **naming a box is
the only way to reach an ephemeral one**: the scheduler will not choose a runner
for you, and it belongs to whoever started it
([ephemeral-hosts.md](./ephemeral-hosts.md)).

That is the case this server exists for: hand a job to a Mac that did not exist
five minutes ago, watch it, collect the output.

## Completion: told, not signalled

Nothing in the fleet reports "done". A finished session looks exactly like an
idle one — `peek` reads a pane and `status` says what a host believes; neither
is *"tell me when this is done"*.

The first version of this document called that a missing fleet-side signal. It
is not:

> you can have the MCP endpoint and documentation handed to the LLM telling it
> to kill, telling it has a 15 minute timeout unless or whatever else

**The thing driving the fleet is a model, and it can be told what it owns.** A
deadline in prose that an agent can act on beats a callback that has to be
built, and it is honest about who is deciding — because deciding a session is
finished is a judgement, and the fleet was never going to be the one making it.

So `initialize` returns `instructions`, which is the field MCP has for exactly
this:

```
WORK YOU START IS WORK YOU OWN.
Sessions are expected to finish within about 15 minutes. Nothing in the fleet
reports "done" — a finished session looks exactly like an idle one — so deciding
it is over is your job, not something you will be told.

  1. fleet_start, naming a host if you want a particular machine
  2. fleet_peek to read what it is doing, as often as you need
  3. fleet_stop WHEN YOU HAVE WHAT YOU CAME FOR, or when the time above has passed

TEMPORARY HOSTS COST MONEY WHILE THEY LIVE. …
```

`AGENT_FLEET_MCP_BUDGET_MINUTES` sets the number, and it is **stated rather than
enforced**. A timer the agent cannot see produces a session that dies mid-answer
with no explanation; a number it was given produces one that stops on purpose.

The tools carry the reminder too, not only the preamble — a model that read the
instructions twenty tool calls ago is not reliably still holding them.

### Being told, rather than polling

> should mcp be able to notify llm a task needs help or a task is complete?

**A server can send notifications; it cannot reliably wake a model.** A
notification arrives on the transport, and whether it reaches the model is up to
the client — one that is not currently in a turn is not listening. Building on
that gives a feature that works in one client and silently does nothing in the
next.

**A tool that blocks needs no waking.** `fleet_await` returns the moment the
session needs an answer, ends, or errors — and the return value *is* the
notification. It works everywhere, because it is just a tool call that takes a
while.

Both signals already existed and already wake a **person**: the host watcher
detects a session blocked on a dialog, and `session.awaiting-input` and
`session.ended` are in `NOTIFIABLE` (core.js). This carries the same two facts
to the other kind of caller.

It polls, deliberately and slowly. The alternative is a streaming endpoint on
the coordinator — a real thing to build and to keep alive through a Worker.
Asking every few seconds is unglamorous and cannot silently stop working.

**Still running at the deadline is not a failure.** Reporting it as one pushes an
agent into stopping work that is going fine.

### `fleet_read_log`, not `peek`

> fleet_readLog to read console output rather than peek

`peek` is the live pane: what is on screen now, and gone when the session is. The
`logs` verb has always also read a session's own console output — which survives
the session ending — but it was summarised as *"the last lines of a service log
on one host"*, so nobody looking for what a job printed had any reason to open
it.

`fleet_read_log` is that verb with the service half dropped and the name saying
what it does. On a runner it is the difference between collecting a result and
losing it, because the machine goes away.

### Tags pick a kind of machine

> Tag Linux or tag macOS — no ephemeral, route if available, or offer ephemeral

`tag: "macos"` finds a permanent host carrying that label. If the only match is
temporary, the refusal **names it** rather than sending work there — offered,
never chosen, because a runner has the most free capacity in the fleet precisely
because it is empty and about to disappear.

A tag travels **beside** the intent, like `host`. It cannot be a verb parameter:
adding one to an existing verb is a flag day, and an old host would answer
`bad_params` after the version handshake had already agreed. The scheduler had
this filter already — reading `intent.params.labels`, which no verb declares, so
`validateIntent` refused every call that tried to use it. Correct, tested, and
unreachable.

### Which is why `stop` is exposed

It was withheld, on the reasoning that ending work is not something an agent
should reach for unasked. That is true of somebody else's work and **false of
its own**: an agent told to clean up after itself and given no way to do it
leaves a paid-for runner idling, and the instruction becomes a lie the moment it
is read.

So the verb is exposed and **scoped in the server**: it refuses to stop a
session it did not start in this conversation, remembers only successful starts,
and forgets one as soon as it is stopped. A refused start does not make its name
stoppable — on a fleet where people choose names, that name is probably
somebody's.
