# Hosts that are expected to vanish

A CI runner is a host with a job and a clock: it enrols, works, and is
destroyed. Every default the registry has is built for a real box that might
come back — and each of them is wrong for a runner in a way that *accumulates*,
one corpse per build.

**This does not replace permanent hosts, and is not meant to.** Self-hosted
boxes on Linux, macOS and Windows stay the backbone: they hold conversations
across days, they can reach internal resources, and they are where the long
sessions this product exists for actually live. An ephemeral host is for work
that needs **no internal access and no persistence** — build this, test that,
verify it compiles on a platform nobody owns. Deciding which is which is the
whole point of keeping them distinct rather than making all hosts temporary.

## What the framework changes

**Ephemeral is decided when the pin is minted**, not claimed by the host. A host
that could declare itself permanent is a host that never gets cleaned up, and
the pin is already the thing that authorises admission — so it is the right
place to say what is being admitted.

**Placement is opt-in.** An ephemeral host is never chosen for you. It has
plenty of free capacity, being empty, which is exactly why capacity must not be
what selects it — ordinary work placed there is lost when the job ends. It stays
reachable for reads, listable, and addressable **by name** through the placement
preference. A fleet whose only matching hosts are temporary refuses and says so,
rather than quietly starting work that will disappear.

**A disconnect retires it.** For a real box, `disconnect` keeps the entry: it may
come back, and its last known sessions are the best guess about where a `resume`
would land. A runner will not come back — the job ended and the machine was
destroyed — so the entry is deleted and its key revoked. Retired at the moment
of disconnect rather than swept later, because the disconnect *is* the event;
there is nothing to wait for.

**The key goes with it.** Otherwise the registry stays clean and the enrolled
list fills up instead: one dead key per job, for ever, each of them a credential
that would still be accepted if the private half ever leaked out of a build log.

## Running one: `.github/workflows/ephemeral-mac.yml`

`workflow_dispatch`. Set the `FLEETWRIGHT_RUNNER_TOKEN` repository (or
organisation) secret once, dispatch the workflow, and a macOS runner joins the
fleet for as long as you asked for — `enrol-actions` presents GitHub's own
OIDC token to prove which repository the run belongs to, and the stored token
only *names the owner*; it cannot admit a machine on its own.

**A pin is the fallback, not the path.** The optional pin input exists for a
coordinator with no Actions repositories configured (`AGENT_FLEET_ACTIONS_REPOS`
unset): mint one in the app (Fleet → Add a host, marked ephemeral) and type it
into the dispatch. It lasts ten minutes, is single-use, and is minted by a
person looking at what they are doing. There is still no credential in this
repository that can admit a machine — that property moved from "the pin is
typed" to "the OIDC token does the admitting", and held.

### The credential, and why it is an API key

The first version of this said the host arrives with no Claude account and
somebody connects one from the app. That is true of a permanent box and useless
here:

> the concept of runners is MCP hands something off to the runner, watches it,
> and gets output — so user input doesn't work

**A host that needs a human to become useful is not a runner.** There is nobody
at the other end to open a login page and paste a code back, and a design that
requires one has quietly turned an automation surface into a second interactive
box that happens to expire.

So an ephemeral host authenticates with `ANTHROPIC_API_KEY`, from a repository
secret. That is the credential designed for this shape: no browser, revocable on
its own, billed separately, and scoped to one thing rather than being an account
login.

**It does not break the no-shared-credentials rule**, and the distinction is
worth being precise about rather than waving at. That rule is about somebody's
Claude *account* travelling to a machine or a person who should not have it.
An API key is not an account login: it can be turned off without touching the
account it belongs to, its usage is visible separately, and it admits nobody to
anything except the API. What would break the rule is copying
`accounts/<email>.json` to a runner, and nothing here does that.

**Usage bills to the API account, not to a subscription.** Worth knowing before
running many of these.

It works because credential seeding lives inside `if (cfg.sandbox)` — an
unsandboxed session inherits the environment of the process that started it, so
a key in the job's environment is a key in front of the CLI. No linked account
is involved at any point.

**No sandbox.** Rootless podman on a macOS runner is a Linux VM inside a VM,
slow where it works at all — and the sandbox protects a machine that persists.
This one is destroyed in an hour by something more thorough than a container.

**The job ending is the disconnect.** The sidecar runs for the requested time
and is then asked to stop, so it closes its socket and the coordinator retires
the entry and revokes the key. There is no cleanup step to remember, because
exiting normally IS the cleanup.

## Enrolling with no pin: the job proves what it is

`agent-fleet-sidecar enrol-actions`, and the workflow needs one line:

```yaml
permissions:
  id-token: write
```

GitHub mints a short-lived token for that job naming the repository, the
workflow file and the run. The coordinator verifies it with the same machinery
it uses for a sign-in — different issuer, and an allowlist of **repositories**
rather than people, because the subject is a job and not a person.

**This beats a stored secret on every axis that matters.** A credential in CI
that can enrol a host is readable by every workflow in the repository, survives
the job, and cannot say which job used it. A token from this issuer expires in
minutes, names the run, and cannot be exported from the job that asked for it.

`job_workflow_ref` is the claim people skip. `repository` alone means *any*
workflow there can admit a host, including one added by a pull request — so
`AGENT_FLEET_ACTIONS_WORKFLOW` pins the file that is allowed to.

**The host id is derived, never accepted.** A job that could choose its own name
could choose a permanent host's, and re-enrolment replaces a key.

```
AGENT_FLEET_ACTIONS_REPOS     owner/repo,owner/other   (empty means nobody)
AGENT_FLEET_ACTIONS_WORKFLOW  owner/repo/.github/workflows/ephemeral-mac.yml@
```

Both are **operator** decisions — which repositories may admit machines at all —
and change about as often as the fleet gains a repository. There is deliberately
no per-person configuration here: a fleet where each new user needs a coordinator
deploy before they can have a runner is not the thing being built.

## Whose runner it is

> Since they are ephemeral they belong to the user whose token started em

Several people may want a runner at once, and they are **not interchangeable**:
each exists because somebody asked for it, for their job, and costs them money
while it lives. Somebody else's runner is not spare capacity — it is a machine
that vanishes when a job you cannot see finishes.

So an ephemeral host records an owner, derived from whatever admitted it and
never claimed by the host:

**Two different questions, answered by two different things:**

| | what proves it | what it costs if it leaks |
|---|---|---|
| is this a real job in a repository we allow? | the OIDC token GitHub mints for the job | nothing — it expires in minutes and cannot leave the job |
| whose runner is it? | a **claim**: an ordinary enrolment code, minted in the app | somebody can give a fleet member a free Mac. Not: put a machine in the fleet |

That split is the point. The code stops being what admits a machine — GitHub's
token does that, cryptographically, before the claim is looked at — so it is no
longer an admission credential at all. It is a name tag.

**A claim is required.** An unowned temporary host is one everybody sees and
nobody is responsible for, and "I cannot tell whose this is" is not the same fact
as "it belongs to nobody".

**The claim is a stored secret now, `FLEETWRIGHT_RUNNER_TOKEN`** — safe to
store precisely because it names an owner rather than admitting a machine;
GitHub's OIDC token is what does the admitting. What nothing does yet is
dispatch the workflow on the person's behalf: the coordinator holds a GitHub
App installation, and when it dispatches the run itself it will know who asked
before the job exists. That is the step that makes this genuinely self-service
rather than one-field-shorter.

Placement then skips other people's runners entirely, and a fleet whose only
match is one of them refuses with that reason — not `at_capacity`, which is what
it said before about an entirely empty machine.

Ownership does **not** make your own runner a default target. It is empty, so
capacity would choose it every time. Name it.

Permanent hosts have no owner and should not: a box is the fleet's, and one
person owning it would mean nobody else could work.

## What still has to be true for the Actions case

- **A unique host id per run.** Two jobs sharing one identity is the clone bug
  in a new costume, and we have paid for that lesson once already. `run_id` and
  `run_attempt` are both needed — a re-run reuses the id. **Done:**
  `AGENT_FLEET_HOST_ID: gha-mac-<run_id>-<run_attempt>`.
- **A credential that admits, or one that only names.** The question was which
  credential CI holds, because admitting a machine is not something a workflow
  edit should be able to do. **Answered by OIDC:** GitHub's own job token
  proves which repository the run belongs to, and the stored
  `FLEETWRIGHT_RUNNER_TOKEN` only claims an owner. Nothing in this repository
  can admit a host; the fallback pin, when used, is still typed by a person.
- **The session cannot outlive the host.** `resume` is pinned to the box holding
  the volume, so when a runner goes, its sessions are gone. That is correct and
  needs saying out loud rather than being discovered.

## What it is not for

A runner is capped (six hours, no persistence, and Apple's licence still governs
what may run on their hardware). It is right for a build and wrong for the
long-lived session this product is otherwise about. If a piece of work needs to
reach something inside your network, it wants a permanent host — that is not a
limitation of this feature, it is the line that makes the feature safe.

## What this still does not do

The credential was the blocker. The interaction model is the remaining half, and
it is worth writing down before it is built rather than discovered:

**A session here is still an interactive one.** `start` opens `claude` in a tmux
pane and the fleet reads that pane. For hand-off-and-watch, the shape wanted is
closer to `claude -p`: give it the work, let it run, collect the output, know
when it is finished. `peek` reads a pane and `answer` types into one; neither is
"tell me when this is done".

**Nothing reports completion.** A runner session that has finished its work looks
exactly like one sitting idle, which is the same ambiguity the watcher already
cannot resolve on a permanent host — and on a runner it matters more, because
the machine is being paid for by the minute.

**MCP is where this landed** — see [`mcp.md`](./mcp.md). The intent protocol
was already the right shape for it (fixed verbs, typed parameters, structured
replies), and the MCP server is a thin adapter over `/api/intent` rather than
new architecture. `fleet_start` on a named ephemeral host exists, and
`fleet_await`/`fleet_read_log` cover watching and collecting; the completion
signal is the piece that still does not — a finished session still looks like
an idle one.
