# A repository that is a machine shop

> a git repo essentially act as an ephemeral runner central … to on the fly
> test a macOS app build or ui/ux using an emulator or windows apps or heck even
> Linux where we either want multiple OSs to test something or just don't want
> to run hosts

[`ephemeral-hosts.md`](./ephemeral-hosts.md) built the machine: a GitHub Actions
job that enrols itself into a fleet, works, and is retired when the job ends.
Everything in it still holds. What it ended on was the gap:

> What nothing does yet is dispatch the workflow on the person's behalf: the
> coordinator holds a GitHub App installation, and when it dispatches the run
> itself it will know who asked before the job exists. That is the step that
> makes this genuinely self-service rather than one-field-shorter.

This is that step, and one more that came with it: **there was one runner and
one operating system.** A person who wanted a Windows box, or an Android
emulator to look at their own app on, had a document explaining that a runner
was possible.

## What it looks like now

```
session ──MCP──▶ fleet_provision {platform: "macos", minutes: 60}
                     │
                 coordinator      mints a single-use TICKET naming who asked
                     │            (it cannot dispatch: it holds no credential)
                     ▼
                 a permanent host — the one with that person's GitHub connection
                     │
                     │  POST /repos/<runner repo>/actions/workflows/runner-macos.yml/dispatches
                     ▼
                 GitHub Actions ──▶ a Mac, which enrols itself with
                                    GitHub's OIDC token + the ticket
                     │
                 fleet_status ──▶ gha-… , owned by the person who asked
```

Two repositories, deliberately. This one holds the fleet. The **runner
repository** holds four workflow files and nothing else —
[`install/runner-central/`](../install/runner-central/) is its contents, and its
README is the setup.

## The credential question, which is the whole design

A dispatch needs a GitHub credential with Actions write. There were three
candidates.

| | verdict |
|---|---|
| the App's **private key**, minting an installation token | **no.** It mints for *every* installation of a publicly installable App. [`github-app.md`](./github-app.md) and [`trust.md`](./trust.md) refuse it a home on a host (N copies) and in the coordinator (treated as compromised). It waits for the broker, and the broker does not exist |
| a **stored dispatch token** in the coordinator | **no.** One credential able to start runners for anybody, at rest in the party this design treats as compromised — and it still could not say who asked |
| the **asking person's own** user-to-server token | **yes**, and it needs nothing new to exist |

The third is the one already in the system: the GitHub App token
[`connectors.md`](./connectors.md) stores per person, host-side, renewed
host-side, revocable by them from a screen they already know.

**It cannot exceed the person, so nothing has to be careful on their behalf.** A
dispatch made with somebody's token is one they could have made themselves, from
a repository their own installation reaches. There is no privilege here to
contain — which is a different and better property than a narrow credential,
because a narrow credential is narrow until somebody widens it.

**And it answers ownership for free.** The whole reason
`FLEETWRIGHT_RUNNER_TOKEN` exists is that nothing knew who a runner belonged to
until the job said so. When the fleet dispatches, it knew before the job existed.

What it costs, stated plainly: **you need one permanent host with GitHub
connected before you can have a temporary one.** A fleet of nothing but runners
cannot start a runner. That is the correct shape rather than a limitation to fix
— the permanent box is where the credentials, the conversations and the internal
access live, and runners are the thing you reach for *from* it.

### Why the coordinator does not do this itself

It is the publicly addressable part and it holds no per-person credential —
`github-oauth.js` says so in its header: the callback exchanges a code and
relays the result down the socket, and *"nothing is stored at the coordinator"*.
Making it the dispatcher would mean giving it one, which is the second row of
the table above.

So the coordinator does the two things only it can: it knows **who is asking**
(it verified them) and it mints the **ticket**. The host does the one thing only
it can: it holds the token.

## The ticket

A dispatch mints one, it travels as a workflow input, and the job hands it back
when it enrols. Single-use, forty-five minutes, bound to the verified person.
[`runner-tickets.js`](../src/fleet/coordinator/runner-tickets.js) carries the
argument; the short version is what a leaked one costs:

**Somebody who can already start a job in an allowlisted repository could have
that job's runner attributed to the person who asked for a different one.** They
cannot admit a machine — GitHub's OIDC token does that, cryptographically,
before a ticket is looked at — cannot call the API as anybody, and cannot use the
runner, because placement gives an ephemeral host to its owner. It is worth "a
fleet member is given a machine they did not ask for", once, inside the window.

That is the same bound the reusable claim already had, held for minutes instead
of for ever. Which is what makes it safe to put in a workflow input that anybody
who can read the run can read — and a public runner repository means everybody
can read the run.

**A run started by hand still uses the reusable runner token.** Both are
first-class: dispatching needs a permanent host with GitHub connected, and
pressing Run workflow needs neither. The enrolment route asks the prefix which
store to consult, so one can never be accepted in place of the other.

### Why not match the run afterwards instead

The obvious alternative is to dispatch and then find the run. GitHub's dispatch
endpoint answers `204` with **no body** — no run id — so finding it means
polling `GET /actions/runs` and guessing which one is yours from timestamps. A
correlation value passed through the workflow is what every project doing this
ends up with; the ticket is that value doing a second job.

## What `provision` may express, and what it may not

```
provision { platform: macos|windows|linux|android, minutes?: 5..350 }
```

No repository. No workflow file. No ref. No inputs. **A compromised coordinator
can ask for a Mac; it cannot ask somebody's GitHub token to run something of its
choosing somewhere of its choosing.** That is `start` naming a profile rather
than carrying one, applied to a second verb.

The repository comes from the **config frame** — one operator setting for the
fleet, delivered to hosts on connect, so no box is configured with it. That is a
capability the coordinator gains and it is bounded twice: GitHub refuses a
dispatch into anything the person cannot already run workflows in, and the token
is spent against `api.github.com` rather than handed to the repository. The
frame is still a fixed list of two named keys, asserted by a test.

**Adding the verb cost no protocol bump.** An old host answers `unknown_verb`,
which strands nothing; it is adding a *parameter to an existing verb* that is a
flag day. See [`intents.md`](./intents.md).

## The four platforms

| platform | runner | for |
|---|---|---|
| `linux` | `ubuntu-latest` | the default. Cheapest, fastest to boot, and most work does not care |
| `macos` | `macos-26` | the one nobody has hardware for — an iOS or macOS build, Xcode |
| `android` | `ubuntu-latest` + SDK + KVM | *looking at* an app rather than only building it |
| `windows` | `windows-2025` | **not proven** — see below |

The Android runner installs a system image and makes `/dev/kvm` writable, and
**starts no emulator**. Which API level and which device is the session's
business; a workflow that booted one would be choosing for it and paying for the
boot on every runner that wanted a different one.

### Windows is written and unproven, and that is said out loud

A session **is** a tmux pane. tmux is a POSIX program. Windows has no tmux.

`runner-windows.yml` runs the host under MSYS2 — which the runner image ships,
and which has a tmux package — and converts paths with `cygpath` for a `node`
that thinks in `C:\`. Every one of those joins is somewhere the two worlds can
disagree, and none of it has been run.

So it is written to **fail before enrolling rather than after**: a preflight
checks pacman, tmux and that `node` is visible from the MSYS2 shell, and the
run aborts if agent-hub does not answer. A runner that joins a fleet and then
cannot start a session is worse than one that never joined — it gets placed on,
accepts work, and loses it.

The alternatives, for whoever picks this up: WSL (not installed on the image,
and installing a distribution wants a reboot), Cygwin (a third-party action this
project would rather not add to a workflow that enrols machines), or accepting
that Windows builds happen on a Windows runner driven from a Linux host, which
is not a fleet host at all.

## What this does not solve

**A runner has no git credential, so it can only reach public code.** This is
the largest of these and it was missing from this document, which is worse than
the gap itself: everything above describes getting a machine and nothing said
what that machine can actually check out.

A runner's `AGENT_HUB_STATE_DIR` is a fresh directory under `runner.temp`, so
its credential store is empty — connections are per person and live on the box
they were made on, and a machine that has existed for ninety seconds has none.
It gets `ANTHROPIC_API_KEY` and that is the whole list. The job's own
`GITHUB_TOKEN` is scoped to the runner repository and read-only, which is right
for checking out four workflow files and useless for anything else.

So "test a macOS app build" works if the app is public and does not if it is
private, which is the wrong way round for most of the reason somebody wants a
Mac. Saying it here rather than letting it be discovered on a machine being paid
for by the minute.

**The fix is not a bigger credential, it is a narrower one.** The obvious
answers are all worse than the problem:

| | why not |
|---|---|
| push the person's user token to the runner with `link` | it is their whole installation for eight hours, on a machine they do not own, inside a job in a public repository. That is somebody's account travelling to a machine, which is the line [ephemeral-hosts.md](./ephemeral-hosts.md) is careful to say the API key does *not* cross |
| a fine-grained PAT in the runner repository's secrets | bounded by an operator rather than by a request: every runner gets the same reach, chosen once, whoever asked. Honest and available today, and not what a session needs |
| the fleet's own Actions token | answers who dispatches. It cannot clone anything |

What a session needs is git auth **scoped to the repository that session asked
for**, lasting about an hour. GitHub has exactly that primitive — an
installation token minted with `repositories` and a `permissions` subset — and
the delivery half is already built: [`credential-broker.js`](../src/core/credential-broker.js)
is one socket per session, and *which socket a request arrives on is what
identifies the session*. What is missing is the minter, which is the private
key's custody question in [github-app.md](./github-app.md), and one seam: that
socket is served only for sandboxed sessions (`cfg.sandbox && cfg.sandboxHookSocket`),
and a runner deliberately runs unsandboxed.

**Nothing reports completion.** A runner session that has finished looks exactly
like an idle one — the ambiguity the watcher already cannot resolve on a
permanent host, and it matters more here because the machine is being paid for
by the minute. `fleet_await` waits for a session to end; it cannot tell you the
work is done.

**A dispatch is not a machine.** The reply comes back long before the runner
does: GitHub has to find hardware, boot it, and install tmux and the CLI. The
reply says so in as many words, because an agent that read "started" as "ready"
would go looking for a host that is still being built. There is no verb that
waits for it; `status` is the answer, a few minutes later.

**The session cannot outlive the host.** `resume` is pinned to the box holding
the volume, so when a runner goes, its sessions go. Collect what you need before
the clock runs out — [`ROADMAP`](../ROADMAP.md)'s linked-repositories item is the
exit that does not need somebody watching.

**Actions minutes are somebody's.** Free on standard runners for a public
repository, metered otherwise, and macOS is the one to check before promising
anything. A session on a runner bills to the API key the runner repository
holds, not to a subscription.
