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

## Remote: a URL instead of a binary

Stdio works only where somebody has installed a binary and pasted a credential
into a config file. Every coordinator also serves the same server over HTTP:

```
claude mcp add --transport http fleetwright https://fleet.example/mcp
```

There is no token to paste. The first call gets a 401 carrying
`WWW-Authenticate`, the client follows it to the discovery documents, registers
itself, and opens a browser at a page with two buttons on it — **Apple and
Google, the same sign-in as the app**. Nothing new decides who you are: the same
issuers, the same audiences, the same two allowlists (`AGENT_FLEET_AUTH_ALLOW`
and the invite list), checked by the same function `/api/session` calls.

| route | what it is |
| --- | --- |
| `GET /.well-known/oauth-protected-resource` | where the authorization server is (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | what it supports (RFC 8414) |
| `POST /oauth/register` | dynamic client registration (RFC 7591) |
| `GET /oauth/authorize` | the page a person sees |
| `POST /oauth/authorize` | the ID token comes back here |
| `POST /oauth/token` | code + PKCE verifier, form-encoded (RFC 6749) |
| `POST /mcp` | the conversation |

**The access token IS a device credential.** It is an `fwk_…` in the same list
as every phone, named "an MCP client", revoked from the same screen. That is why
there are no refresh tokens: a refresh flow would add a second kind of
credential with a second lifetime to reason about, to solve a problem this fleet
does not have.

**PKCE is required, not offered.** A request without `code_challenge_method=S256`
is refused before the page renders — along with an unregistered `client_id` and
a redirect this fleet will not use. All three are checked *first*, because a
page that collects a sign-in and then discovers it cannot deliver the result has
spent somebody's credentials on a screen that was never going to work.

**Registration survives a restart; codes do not.** A code lives five minutes and
losing one costs a second tap. A registration is what a client wrote into its own
config weeks ago, and forgetting it fails *after* a person has signed in.

### Two origins, and why they are not one setting

The remote endpoint deals with two different addresses, and collapsing them was
a **server-side request forgery**: the coordinator would issue an outbound
request to whatever host an authenticated caller put in the `Host` header, from
wherever the coordinator runs. Guests are semi-trusted here by design
([accounts.md](./accounts.md)), which is exactly the population that has to hold
against.

- **Where the client reached us** — the discovery documents and the
  `WWW-Authenticate` header. Built from the request, and it has to be: a client
  must be pointed back at the address it actually used, and a spoofed `Host`
  only ever poisons the spoofer's own response.
- **Where this coordinator sends intents** — never from a request. The Node
  coordinator uses its own listener address; the Worker uses its public URL.

Set `AGENT_FLEET_PUBLIC_ORIGIN` when the coordinator cannot reach itself on the
address it bound to — TLS terminated elsewhere, a container with a different
internal address. Everywhere else it needs nothing.

The MCP server speaks to the fleet over HTTP even when the coordinator is
serving it in-process, which is what lets the same code run as a stdio binary on
somebody's laptop. That loopback is the request being protected here.

### What the remote transport costs

**`fleet_await` caps a single wait at 25 seconds** and answers "still running,
call again". A Worker request has a ceiling, and an uncapped wait is a dropped
connection — which a client cannot tell apart from a broken server.

**`notifications/message` has nowhere to go.** Streamable HTTP puts them on an
SSE stream and this transport opens none. It costs less than it sounds:
measured against Claude Code 2.1.251, notifications are not surfaced to the
model at all (see the matrix below), so the courtesy that does nothing over
stdio does nothing here either. `fleet_await` is the path that works — and did
not, until the status reply was being read correctly; see above.

### Configuring it

`AGENT_FLEET_AUTH_AUDIENCES` already lists the applications this fleet accepts
tokens for, and the web sign-in uses entries from it rather than a second
variable that could disagree:

- **Google** — the entry ending `.apps.googleusercontent.com`, picked out
  automatically. Nothing to set.
- **Apple** — needs `AGENT_FLEET_AUTH_APPLE_SERVICE`, and it must be a
  **Services ID**, not the iOS bundle ID sitting in the same list. Sign in with
  Apple JS answers `invalid_client` for a bundle ID and explains nothing. The
  Services ID also has to be added to `AGENT_FLEET_AUTH_AUDIENCES`, or the token
  it mints will not verify here. Until it is set the page shows Google alone —
  an Apple button that cannot work is worse than no Apple button.

**The origin has to be registered, and this is the failure everybody hits
first.** Google Identity Services checks the page's origin against the OAuth
client, and a coordinator serving `/oauth/authorize` is an origin that client
has never heard of:

> **Access blocked: Authorization Error** — Error 400: `origin_mismatch`

Google Cloud Console → **APIs & Services → Credentials** → the Web application
client → **Authorized JavaScript origins** → add the fleet's origin, e.g.
`https://fleet.thetech.network`. Origin only: no path, no trailing slash.

It goes in **JavaScript origins, not Authorized redirect URIs.** GIS never
redirects — it hands the ID token to a callback in the page — so a redirect URI
does nothing for this error, which is the wrong turn that costs an afternoon.

The sign-in page prints its own origin in the footer for exactly this moment,
because the error appears inside Google's popup where the page can neither see
nor explain it.

Testing against a Node coordinator on a box needs that origin registered too,
and GIS refuses plain http except on `localhost` — so reach it as
`http://localhost:8791`, not by IP.

## Reaching a temporary host

Every tool takes a `host`. It is not a protocol parameter — placement travels
beside the intent — and it is offered on all of them because **naming a box is
the only way to reach an ephemeral one**: the scheduler will not choose a runner
for you, and it belongs to whoever started it
([ephemeral-hosts.md](./ephemeral-hosts.md)).

That is the case this server exists for: hand a job to a Mac that did not exist
five minutes ago, watch it, collect the output.

### What a status reply looks like, and why it is written down here

`/status <name>` answers `{ ok, text, sessions: [record] }`. It has never
answered `{ session: … }` — and both `fleet_await` and the notification watcher
read the second shape. So an await could not see a session end: it polled to its
own timeout and said "still running" about a finished job, and the watcher
emitted nothing, ever.

It passed because `scripts/check-mcp-client.mjs` **invented the shape it was
testing against**. That is a third way that harness has lied, on top of the two
recorded inside it, and the worst of the three — the other two failed loudly. A
fake that answers in a shape the real thing does not use is a test that
certifies the bug.

Anything reading a reply here goes through `sessionFrom()` now.

**What `fleet_await` detects, precisely:** a session that has **ended or
errored**. It does *not* reliably detect one parked on a prompt — `awaiting` is
a host-watcher signal that raises an event, and is not a field on a status
reply. If one arrives the code uses it; nothing promises it, and the tool
description says ended-or-errored and no more.

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

Yes, and it does — **both ways**, because they answer different halves.

The first version of this section argued that a server cannot reliably wake a
model, so notifications were not worth sending. That was the wrong bar:

> Best effort features are a real thing with documented clients that work better
> or worse or untested — the point is follow a convention.
>
> The bar is implementing the protocols and documenting which clients implement
> them correctly.

A server that stays quiet because support varies has decided on every client's
behalf. Declaring the capability is how a client that *does* support it finds
out there is something to show — and "not guaranteed" is the ordinary shape of
an MCP capability, not a defect.

| | what it is | when it is the right one |
|---|---|---|
| **`fleet_await`** | a tool that blocks until the session needs an answer, ends or errors | always works, in every client. The guaranteed path |
| **`notifications/message`** | the logging capability, emitted when a watched session changes state | reaches a client that is **not** currently in a tool call — an agent that has moved on and would otherwise never look again |

Only sessions started in this conversation are watched — the same scope `stop`
is held to. Watching the fleet would mean narrating somebody else's work to an
agent with no business in it. The watcher stops when the last one ends: a timer
alive after that is a stdio server that will not exit, which a client reads as a
hung process.

`AGENT_FLEET_MCP_WATCH_SECONDS=0` turns it off. For a client that shows
notifications to the **person** rather than the model, a session finishing is a
line they did not ask for.

### Which clients implement what

**Rows say how they were established.** An untested row says untested rather
than guessing, because a support matrix whose entries are assumptions is worse
than none — it is the same manufactured confidence as a checker that silently
passes.

| | `tools/*` | `logging` (`notifications/message`) | how established |
|---|---|---|---|
| this server | ✅ | ✅ declared and emitted | `test/mcp.test.js` and `test/mcp-remote.test.js`, against the reply shape the coordinator actually sends. It emitted **nothing on a real fleet** until 1 Sep 2026: the watcher read a `session` key no layer produces, and the conformance harness invented that key — so the tests certified the bug |
| **Claude Code 2.1.251** | ✅ **verified** | ❌ **sent, and not surfaced to the model** | `scripts/check-mcp-client.mjs`, 1 Sep 2026 — three scenarios, wire captured |
| Claude Desktop | untested here | untested here | GUI: see below |
| any other client | untested here | untested here | — |

**Claude Code, measured rather than assumed:**

```
client             : claude-code 2.1.251
protocol offered   : 2025-11-25   agreed: 2025-11-25
client capabilities: {"roots":{"listChanged":true},"elicitation":{}}
tools called       : fleet_list
reached the fleet  : {"verb":"list","params":{}}
result             : "sunlit-harbor running on deb132"   is_error: false
logging/setLevel   : never sent
```

Its capability object has **no `logging`** — and rather than infer from that,
the harness measured it. The server emitted one `notifications/message`
carrying a marker; the model was asked to report any out-of-band content:

```
notifications sent: 1
tools called      : fleet_start, fleet_peek
answer            : "NONE RECEIVED — Everything that came back was a tool
                     result: `started probe` from fleet_start, and `still
                     compiling, nothing to report` from each of the three
                     fleet_peek calls. No server-initiated notification, log
                     message, or other out-of-band content."
```

**Sent, and not surfaced.** That is a fact about a client, not a fault in
either — and it is exactly why `fleet_await` is the guaranteed path and the
notification is the courtesy. On this client, today, the courtesy does nothing,
and a design that relied on it would have looked fine in every unit test.

**The first attempt at this experiment was confounded**, which is worth
recording because a confounded run that looks like a result is how a matrix
fills with confident nonsense. It let the model call `fleet_await`, whose return
value contains the same "is waiting for an answer" text the notification
carries — the model quoted it, and the run appeared to prove notifications
arrive. It proved a tool result arrives.

The fix separates the channels **by verb**: the watcher polls `status`, nothing
the model can call does, and `peek` keeps the turn alive while saying nothing.
The marker then has exactly one route to the model. Finding that also exposed a
real gap — the notification did not carry the session's `detail` at all, so the
experiment would have returned NONE RECEIVED whatever the client did. It carries
it now, which is better regardless: *"probe is waiting… It says: …"* beats
*"probe is waiting."*

**The first run of that harness found a real bug**, which is the argument for
having it. The server answered every `initialize` with a hardcoded
`2024-11-05`; Claude Code opens with `2025-11-25`, reported

```
Client.listTools() called but server does not advertise tools capability
```

and called nothing. Thirty-two unit tests passed throughout. The server was
correct in isolation and invisible in practice — a hardcoded version is not
following the convention, it is ignoring the half of the handshake that exists
to be answered. It negotiates now, and a test holds it.

## Automating this

```sh
node scripts/check-mcp-client.mjs
```

Three scenarios, each with its own fake fleet on loopback and a tee between
client and server so the **wire is the evidence**:

| scenario | what it establishes |
|---|---|
| round trip | a tool call reaches a fleet and the answer reaches the model |
| refusal keeps its reason | a named refusal survives to the model rather than being flattened into "the tool failed" — the property the whole protocol is built around |
| notifications | whether `notifications/message` is surfaced, measured with a marker that has only one possible route |

Claude Code reported the refusal verbatim — *"deb132: claude is not logged in …
That's the entire message — an error, so no session was created"* — which is the
protocol's central promise arriving intact at the far end. Without the tee a failure is "the
model did not use the tool", which is not something anybody can act on.

**Not part of `verify.sh`.** It needs the `claude` CLI and a working credential,
and a check that fails on a contributor's laptop for want of a login is a check
people learn to ignore. Run it when the server changes or the client updates,
and paste the output into the table above.

### Claude Desktop cannot be driven this way

It is a GUI with no headless mode and no `--mcp-config`. What can be automated is
everything up to it: the config file this document tells you to write is JSON
that either parses or does not, and the command inside it either starts or does
not — both of which `check-mcp-client.mjs` already covers, because Desktop
launches the same binary the same way.

What is left is a person watching what the app does with a notification, which
is why that row says untested rather than a guess.

**A tool that blocks needs no waking.** `fleet_await` returns the moment the
session needs an answer, ends, or errors — and the return value *is* the
notification. It works everywhere, because it is just a tool call that takes a
while. That is why it stays the guaranteed path even now that notifications are
sent as well.

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
