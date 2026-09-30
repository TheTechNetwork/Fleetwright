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
`coordinator/oauth.js` says so in its header: the callback exchanges a code and
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

A runner token belongs to a person, so it is minted with a device credential
rather than the admin token — the MCP server's, or a phone's. Both phones have
a screen for it, Runner tokens beside the pin for a permanent host: mint one
for a repository, read it once, see whose each is and whether it has ever been
used, revoke. From a terminal it is one curl:

```sh
curl -sX POST https://your-coordinator/api/runner-tokens \
  -H "authorization: Bearer $CREDENTIAL" \
  -H 'content-type: application/json' -d '{"name":"owner/repo"}'
# → { ok, id, token, email }  — the token is shown once; it becomes the
#   repository's FLEETWRIGHT_RUNNER_TOKEN secret
curl -s https://your-coordinator/api/runner-tokens -H "authorization: Bearer $CREDENTIAL"
curl -sX DELETE https://your-coordinator/api/runner-tokens/<id> -H "authorization: Bearer $CREDENTIAL"
```

A member sees and revokes their own; an admin, everybody's.

### Why not match the run afterwards instead

The obvious alternative is to dispatch and then find the run. GitHub's dispatch
endpoint answers `204` with **no body** — no run id — so finding it means
polling `GET /actions/runs` and guessing which one is yours from timestamps. A
correlation value passed through the workflow is what every project doing this
ends up with; the ticket is that value doing a second job.

## From a phone

Both apps offer it beside the pin for a permanent host — a platform, the
minutes, one button — and only when `/api/hosts` says `runners` is set. A
fleet with no runner repository refuses `provision` with a sentence naming
where to set one, which is the right answer for an agent that asked and a dead
button on every fleet that has not; so the snapshot carries the repository and
the control is drawn from that. The reply lands on the same screen, and it says
what this page says: a dispatch is not a machine.

**And from the New session sheet.** Its Where picker offers a new Linux, macOS
or Windows machine, or an Android emulator, wherever the snapshot says one can
be started. Choosing one sends `provision` with the session beside it — title,
brief and mode, as `start` would take them — and the coordinator holds that
session with the dispatch ticket. When the runner enrols on that ticket and
sends its first health frame, the coordinator starts the session there, as the
person who asked, once. The session announces itself the way every session
does, and a start that fails is recorded rather than silent. It carries no
Remote Control link: neither credential a runner is given can open one ([below](#what-it-cannot-narrow)). Task profiles and secrets are not offered for a new machine: it
is minutes old and holds neither.

## Your own runner repository

> Runners on the person's own free minutes, from a repository they control.

A fleet had one runner repository, set by an operator, so a runner was
something an operator arranged before anybody could have one, and everybody's
Actions minutes came out of one account. Each person can now name their own:
a **public** repository (Actions minutes on GitHub's standard runners are free
only there) with the **Fleetwright GitHub App installed** and the runner
workflows from [`install/runner-central/`](../install/runner-central/) in it.
The fleet's repository stays the default for anybody who has not set one.

**It is checked before it is saved.** `PUT /api/runner-repo` asks a permanent
box to run `runnerrepo` with the person's own GitHub connection, and saves the
name only if every answer is one a dispatch can use:

| asked | how | why it matters |
|---|---|---|
| can this person see it, and is it public | `GET /repos/{repo}` | a private one would bill every machine to its owner without anybody deciding that |
| does the Fleetwright App reach it | `GET /user/installations`, then the installation's repositories when it was given a chosen few | it is the App's token that dispatches |
| with Actions write | the installation's `permissions.actions` | without it the dispatch is a 403 |
| which runner workflows it carries | one listing of `.github/workflows` | a platform with no workflow is refused before anybody waits for it |

Each answer comes back as data, and **"cannot tell" is kept apart from "no"**:
a personal access token cannot see installations at all, so for one the check
reports the App as unknown and decides on the person's own push access, which
is what a personal token dispatches with. The name is saved as GitHub spells
it, because that is the spelling a job's OIDC token will carry.

**What a stored name admits: nothing, on its own.** A repository nobody put on
the operator's `FLEETWRIGHT_ACTIONS_REPOS` admits a job only when that job
presents a live dispatch ticket minted **for that person, naming that
repository**, and only for the runner workflow its platform names. The ticket
is looked at before GitHub's token is verified — that is what widens the
allowlist for this one job — and spent only after, so a job whose token fails
does not burn it. A ticket spent by a job from any other repository is
refused. So what a member gains is "my own repository can admit my own
temporary machines when the fleet dispatched them", and a member could already
add a machine with an enrolment pin.

**Which box asks.** The dispatch and the check both need the person's GitHub
connection, which lives on whichever permanent boxes they connected it on. With
several, the coordinator asks each in turn, in host-id order, and moves on only
when the whole answer was "GitHub is not connected for you here" — a reply that
dispatched nothing. A box too old to carry the person's repository (it speaks
protocol 5) is refused rather than sent: its code would drop the parameter and
dispatch into the fleet's repository while saying it worked.

## What `provision` may express, and what it may not

```
provision { platform: macos|windows|linux|android, minutes?: 5..350, repo?: owner/repo }
```

No workflow file. No ref. No inputs. **A compromised coordinator can ask for a
Mac; it cannot ask somebody's GitHub token to run something of its choosing.**
That is `start` naming a profile rather than carrying one, applied to a second
verb.

The repository comes from the coordinator: the person's own when they set one,
carried as `repo` and set by the coordinator whatever a caller sent, and
otherwise the fleet's, off the **config frame** — one operator setting,
delivered to hosts on connect, so no box is configured with it. Either way that
is a capability the coordinator has, bounded twice: GitHub refuses a dispatch
into anything the person cannot already run workflows in, and what runs there
is one of four fixed workflow files on the default branch. `repo` is held to
GitHub's own naming rules by the protocol, so `../x` is refused before it can
become a path segment in an API URL.

**`repo` cost protocol 6, and negotiation absorbs it.** A host on 5 is never
handed it — and, because dropping it would dispatch somewhere the person did
not choose, the coordinator refuses to send such a dispatch to that host at
all. Adding `provision` itself cost nothing: an old host answers
`unknown_verb`. See [`intents.md`](./intents.md).

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
run aborts if fleetwright does not answer. A runner that joins a fleet and then
cannot start a session is worse than one that never joined — it gets placed on,
accepts work, and loses it.

The alternatives, for whoever picks this up: WSL (not installed on the image,
and installing a distribution wants a reboot), Cygwin (a third-party action this
project would rather not add to a workflow that enrols machines), or accepting
that Windows builds happen on a Windows runner driven from a Linux host, which
is not a fleet host at all.

## Private code on a runner

> A runner has no git credential, so it can only reach public code.

That was the largest gap on this page, and for a while this page did not
mention it, which was worse than the gap itself. A runner's credential store is
a fresh directory under `runner.temp`; connections are per person and live on
the box they were made on; the job's own `GITHUB_TOKEN` reads the runner
repository and nothing else. So "test a macOS app build" worked for a public
app and not for a private one, which is the wrong way round for most of the
reason somebody wants a Mac.

**The fix was a narrower credential, not a bigger one.** The obvious answers
were all worse than the problem, and they are still refused:

| | why not |
|---|---|
| push the person's user token to the runner with `link` | it is their whole installation for eight hours, on a machine they do not own, inside a job in a public repository. That is somebody's account travelling to a machine, which is the line [ephemeral-hosts.md](./ephemeral-hosts.md) is careful to say the API key does *not* cross |
| a fine-grained PAT in the runner repository's secrets | bounded by an operator rather than by a request: every runner gets the same reach, chosen once, whoever asked. Honest and available, and not what a session needs |
| the fleet's own Actions token | answers who dispatches. It cannot clone anything |

What a session needed was git auth **scoped to the repository it asked for**,
lasting about an hour — a GitHub App **installation token**, minted with
`repositories` and a `permissions` subset. That is what a runner now gets.

```
session on the runner: git clone https://github.com/acme/app
   │  git-credential helper, with useHttpPath: "acme/app"
   ▼
runner sidecar ── makes a P-256 key for this one request
   │             asks GitHub for its JOB TOKEN, audience = hash(acme/app, key)
   │  `mint` frame: { repo, job token, key }
   ▼
coordinator ─── adds whose runner this is, and relays the ask to
   │            the MINTING WORKER over a service binding
   ▼
the minting Worker — its own script, no public route, holding the App key
   │  checks GitHub's signature on the job token, and that its audience
   │    binds exactly this repo to exactly this key
   │  checks it is a runner workflow, started by a dispatch
   │  checks acme is an account it may mint into
   │  asks GitHub, with a metadata-only probe token for acme/app: what can
   │    the account that started this job do here — by account id
   │  mints one repository, contents (+ pull requests if they can push),
   │    one hour; seals it to the runner's key
   ▼
coordinator relays ciphertext ──▶ runner opens it ──▶ git
```

**It cannot exceed the person, the repository, or the hour.** GitHub is asked
what the account that started the runner can do there, and the token is read
for read and write only for push; the token names one repository, and GitHub
kills it in an hour. The runner holds it in memory until five minutes before it
dies and mints again after that, so a long build does not notice.

**The coordinator carries it and cannot use it.** The answer is sealed to a key
that exists only on the runner, for that one request ([`seal.js`](../src/fleet/seal.js)).
Swapping in its own key, or a different repository, breaks GitHub's signature
over the pair, and the minter refuses. Nothing it could claim about the owner
matters, because the minter never asks it: the account comes from GitHub's
job token and GitHub's answer about that account. This is the one place in the
fleet where something checks an identity the coordinator relayed instead of
trusting it; [security.md §4.1](./security.md) has the whole bound.

### Where the key lives

**In a Worker of its own, and not in the coordinator.** The App's private key
mints for every installation of an App anybody may install, and the
coordinator is the internet-facing part this project treats as compromised, so
[github-app.md](./github-app.md) refuses the key a home there. What it gets
instead is the **minting Worker** ([`minter.js`](../worker/src/minter.js),
[`wrangler.minter.toml`](../worker/wrangler.minter.toml)): a separate script
with no routes, no workers.dev address and no binding but a storage object of
its own (for [Claude logins](#your-claude-login-on-a-runner)), reached only by
the coordinator's `MINTER` service binding, answering one question per route. **No permanent
box is needed to mint** — a fleet of nothing but runners can reach private
code, which is what this was for.

| setting | where | what |
|---|---|---|
| `FLEETWRIGHT_GITHUB_APP_KEY` | a **secret** on the minting Worker, synced from the **environment** secret of the same name in `github-app-key`, by running the Worker workflow by hand with **sync_app_key** ticked and a reviewer approving | the private key, the PEM GitHub downloads — PKCS#1 as it comes. Never synced to the coordinator, and never by the deploy every push runs: it has its own job in `worker.yml`, gated on that environment, for exactly that reason. See [ci.md](./ci.md) |
| `FLEETWRIGHT_GITHUB_CLIENT_ID` | a repository **variable**, passed to the minting Worker at deploy | the App's client id, the issuer of the ten-minute JWT the key signs |
| `FLEETWRIGHT_GITHUB_MINT_OWNERS` | a repository **variable**, passed to the minting Worker at deploy | the accounts whose repositories it may mint into. **Empty mints for nobody.** The App is installable by any account, so "this key never mints into a guest's account" is kept here, by what the fleet does, as github-app.md said it would have to be |

The deploy ships the minting Worker **before** the coordinator, because the
coordinator is bound to it. Both committed configs bind it, so a fork gets the
same boundary; deployed with no key, it mints nothing.

**What it still trusts is Cloudflare.** Anybody who can deploy to the account
can replace the minter's code and capture every token it signs from then on;
secrets cannot be read back, and code can be swapped. So the Cloudflare
account and the API token that deploys to it are now the things standing
between an attacker and every installation, and deserve to be treated that
way. A leaked coordinator, on its own, is not.

**Or on one permanent box**, for a fleet that would rather keep the key off
Cloudflare. Three settings in that box's `/etc/fleetwright-sidecar.env` —
`FLEETWRIGHT_GITHUB_APP_KEY` as a PEM file only the sidecar's account can read,
or better an encrypted systemd credential named `github-app-key`;
`FLEETWRIGHT_GITHUB_APP_CLIENT_ID`; and `FLEETWRIGHT_GITHUB_MINT_OWNERS`. That
box answers "can you reach this" with the person's own GitHub connection
rather than by asking GitHub about them, so it needs that connection too. The
coordinator asks the minting Worker first and a box only when the Worker holds
no key or cannot be reached; a refusal from the Worker is final. With neither,
the refusal names what is missing in the fleet's events and in the runner's
log. git itself only sees no answer.

**The key github-app.md recorded as received should not be the one used.** It
arrived through a chat transcript and was never installed anywhere; generate a
fresh one and delete the old one on github.com.

### What a session on a runner can reach now

| | |
|---|---|
| `git clone`, `fetch`, `push` over https to github.com | a token for that one repository, when the minting Worker holds the key (or a box does) and the person can reach the repository |
| `gh` | `eval "$(fleet-cred github owner/repo)"` first. It is not wired in automatically, because `gh` does not say which repository it is about to act on |
| any other host | nothing — the helper is registered for github.com only, and answers nothing else |
| a fleet with no minting Worker key and no minting box | public code, exactly as before; git gets no answer and falls through |

## Your Claude login on a runner

> Can we have it use a Claude account instead of api

A runner's sessions bill to the runner repository's `ANTHROPIC_API_KEY`
unless the person who asked for the runner has **deposited their own Claude
login**, in which case sessions they start there run on their subscription.

**Every runner has an owner.** It was started because somebody asked, through
the app or MCP, and GitHub's job token names the account that started it. So a
runner can be given its owner's login and never anybody else's, which is the
line that makes this different from a shared token in a repository secret: in
the fleet's runner repository that would put one person's subscription under
everybody's sessions, which is account sharing whoever the people are.

### Depositing one

```sh
claude setup-token                  # on your own computer: a token for your subscription
fleetwright-claude-login            # paste it when asked
fleetwright-claude-login forget     # take it back
```

`fleetwright-claude-login` takes the same `FLEETWRIGHT_COORDINATOR_URL` and
`FLEETWRIGHT_CREDENTIAL` as `fleetwright-mcp`, and one more:
**`FLEETWRIGHT_MINTER_KEY`, the pin** — the minting Worker's public key, which
whoever runs your fleet gives you by a route that is not the fleet. Run it once
without the pin and it prints the key the fleet claims, sends nothing, and
asks you to check that key with them. With the pin set, it refuses any other
key, because a coordinator offering its own is exactly how somebody would read
your login on its way through.

It also needs a GitHub token of yours — `GH_TOKEN`, or whatever `gh auth
token` prints. That is how the minter learns whose login this is without
asking the coordinator: it asks GitHub, once, and does not keep the token.

`claude setup-token` needs a Pro, Max, Team or Enterprise plan, and the token
it prints lasts a year.

```
your computer ── seals { Claude token, GitHub token, now } to the PINNED key
   │  PUT /api/claude-login
   ▼
coordinator ─── relays it unread
   ▼
minting Worker — opens it; asks GitHub whose the GitHub token is
   │  refuses anything older than ten minutes, or older than the one it holds
   │  keeps the Claude token SEALED to its own key, under that account id;
   │    drops the GitHub token
   ⋮
runner joins ── one-request key; job token with audience = hash(key)
   │  `claude-login` frame
   ▼
minting Worker — GitHub's signature on the job token; a runner workflow,
   │  started by a dispatch; in the starter's own repository or one on
   │  FLEETWRIGHT_GITHUB_MINT_OWNERS; the login kept for the STARTER's id
   ▼
coordinator relays ciphertext ──▶ runner opens it ──▶ the owner's sessions
```

### On the runner

The sidecar asks when the runner joins, before its first health frame, and a
session start waits for the answer, so the session a phone asked for with the
machine is not placed on the API key a moment before the login arrives.

| who starts the session | what it runs on |
|---|---|
| the runner's owner, with a login deposited | their login, as `CLAUDE_CODE_OAUTH_TOKEN`, with `ANTHROPIC_API_KEY` **unset** for that session — the CLI ranks an API key above the token and would bill the repository anyway |
| the owner, with none | the repository's `ANTHROPIC_API_KEY` |
| anybody else the fleet places there | the repository's `ANTHROPIC_API_KEY` |

The token is a 0600 file in the job's private state directory, read when the
session starts (`$(cat …)`), so it never appears in a command line, tmux's
arguments or `ps`. The sidecar's log says which of the three a runner got, and
why, and the fleet's events record `runner.claude` or `runner.claude-refused`.

**This also fixed the API key.** Since per-person accounts, a session with no
linked account was refused, on a runner as anywhere — and nobody links an
account to a machine that lives for an hour, so runner sessions were refused
even with the key set. A runner now says it is one (only a GitHub Actions job
has a job token to say it with), and its sessions fall back to the key. A
permanent box never says so, and still refuses a guest who has linked nothing,
whatever is in its environment. And the CLI's "use this API key?" question is
now answered in the session's own config directory, which is the one it reads;
it was being answered in the box's, one directory over.

### What it cannot narrow

**A setup-token is your whole subscription, for a year.** There is no Claude
credential for one session and an hour, so this is limited by *where* it goes,
not by what it can do: only to runners you started, only for your sessions,
and gone when the job ends. For as long as the job lives, the session running
there can read it — the same reach a session on your permanent box has with
your login. Usage counts against your plan's limits like your own Claude Code
does.

**Remote Control does not work on it.** Anthropic's documentation says Remote
Control needs a full-scope login; a setup-token can only make model requests,
and an API key cannot either. So a runner session is driven through the fleet,
not from claude.ai, whichever it runs on.

**Taking it back.** `fleetwright-claude-login forget` makes the minter forget
it, and a runner that joins afterwards uses the API key. A runner that already
has it keeps it until its job ends. Anthropic's documentation does not say
where a setup-token is revoked, so this page does not claim one can be; if it
leaks, assume it lasts its year.

### For whoever runs the fleet

```sh
node scripts/minter-deposit-key.mjs
```

prints a private key and its pin. The private key is
`FLEETWRIGHT_MINTER_DEPOSIT_KEY`, an **environment** secret of `github-app-key`
beside the App key, synced to the minting Worker by the same manual run of the
Worker workflow with **sync_app_key** ticked ([ci.md](./ci.md)). The pin goes
to each person who will deposit, by message or in person. Without the key the
minter keeps no logins and every runner uses its repository's key, as before.
A new key makes every kept login unreadable; people deposit again.

The logins live in a Durable Object of the minting Worker's own
([`wrangler.minter.toml`](../worker/wrangler.minter.toml)), which no other
script is bound to, and each row is still sealed to the deposit key. What
guards them is what guards the App key: the Cloudflare account, and whoever can
deploy to it ([security.md §4.1](./security.md)).

## What this does not solve

**A runner has no Cloudflare connection of its own, and its Claude login is
one the person deposited, never the one on their box.** GitHub is the one
provider with a narrower credential than the account itself:

- **Claude.** Carried only as [a token the person made for it and
  deposited](#your-claude-login-on-a-runner), and only to runners they started.
  The login on their permanent box is not carried: it renews itself by being
  used, and a second copy would break the first. There is still no Claude
  credential for one session and an hour, so what bounds it is where it goes.
- **Cloudflare.** [trust.md](./trust.md) says why: minting a Cloudflare token
  needs a parent with API Tokens: Edit, which is close to account-wide, so the
  minting authority is *stronger* than what it mints. Sealing one to a runner
  would be sending the whole account for an hour.

Cloudflare stays not built until it offers something narrower.

**Windows runners get no repository tokens.** The runner's broker is a unix
socket and Node on Windows listens on a named pipe; that workflow has not yet
been shown to host a session at all, so a second transport waits on the first
proof.

**Completion is reported, as the return to the prompt.** A runner session that
has finished used to look exactly like an idle one, and it mattered more here
because the machine is being paid for by the minute. The watcher now raises
`session.ready` when a session comes back to the CLI's own prompt after it was
seen working, and the coordinator pushes it for every session on a temporary
machine with the sentence that matters: *it keeps running, and costing, until
it is stopped or its time is up*. `fleet_await` still waits for a session to
end; the phone is told the work is done, and `fleet_events` carries the same
event for an agent watching.

**A dispatch is not a machine.** The reply comes back long before the runner
does: GitHub has to find hardware, boot it, and install tmux and the CLI. The
reply says so in as many words, because an agent that read "started" as "ready"
would go looking for a host that is still being built. There is no verb that
waits for it; `status` is the answer, a few minutes later — or, from the New
session sheet, the session's own notification when the coordinator starts it on
the runner's first health frame.

**Sessions on a runner bill to the repository's API key** unless the person
who started it [deposited their Claude login](#your-claude-login-on-a-runner).
Private GitHub code is reachable, one repository at a time
([above](#private-code-on-a-runner)); a Cloudflare connection is not carried,
for the reason at the start of this section.

**The session cannot outlive the host.** `resume` is pinned to the box holding
the volume, so when a runner goes, its sessions go. Collect what you need before
the clock runs out — [`ROADMAP`](../ROADMAP.md)'s linked-repositories item is the
exit that does not need somebody watching.

**Actions minutes are somebody's.** Free on standard runners for a public
repository, metered otherwise, and macOS is the one to check before promising
anything. A session on a runner bills to the API key the runner repository
holds, or to its owner's subscription when they deposited a login.
