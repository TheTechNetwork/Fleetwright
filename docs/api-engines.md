# Paid API models, and machines from a sandbox provider or a box of your own

> API-key engines as vault items, and a sandbox host type: a provider's
> cloud, or a container on a box you already have. The provider half is
> built and tested with stand-ins only.

Before this a member ran on subscriptions: a Claude sign-in, a Codex sign-in,
a Copilot token ([engines.md](./engines.md)). A machine was one you
enrolled, a GitHub runner, or a VM on your own hypervisor
([hypervisors.md](./hypervisors.md)).

Now a member's engine may run on **a metered API key** kept in its vault,
and a person may make a machine **on a sandbox provider's cloud** with a key
of their own. Both spend money by the minute or the token, so both are
behind switches that are off, and a guard that is on. A person may also make
a machine **on a box of their own**, out of one of that box's containers,
which spends nothing and involves nobody else (part three).

This is step 7 of the organization work ([ROADMAP.md](../ROADMAP.md)).

**What has and has not been run.** Nothing here has called OpenRouter,
Vercel or E2B. The provider ids and the key file are from OpenCode's own
documentation and the sandbox calls from E2B's API reference, as read on
24 November 2026; the tests run against servers that stand in for both. No
key was used, no machine was made and nothing was billed. The first real
run is for somebody with a key and a reason.

## Part one: an engine on an API key

### The providers

| provider | what it is | the member's vault item | OpenCode's name for it |
|---|---|---|---|
| `openrouter` | OpenRouter | `apikey:openrouter` | `openrouter` |
| `ai-gateway` | Vercel AI Gateway | `apikey:ai-gateway` | `vercel` |

A member's `opencode` engine may now name a model from either:

```yaml
engines:
  - engine: claude-code
  - engine: opencode
    model: openrouter/anthropic/claude-sonnet-5.5
```

The model is `<OpenCode's name>/<the provider's own model id>`, which may
itself contain a slash. `github-copilot/…` is as it was. Any other prefix is
refused by name. Adding a provider is a row in `API_PROVIDERS`
(`src/fleet/protocol/engines.js`) and nothing else.

### The key

`apikey:<provider>` is kept as the other engine items are: pasted by a
custodian into a member's Credentials, sealed, listed by name and never read
back. It is checked only to be one unbroken run of printable characters of a
sane length. Nothing tries it against the provider, so Test answers that it
is not tried from the vault.

**Only a box that asks for keys is given them.** A box says so in its signed
vault request (`accepts` names `apikeys`), and it says so only when its
operator turned API engines on. A box from step 4 that takes `engines` and
not `apikeys` is handed a Codex sign-in and never a key.

**On the box**, a key is kept with the member's other items and handed to a
session over its own socket, only for an engine that session's member names
on that provider ([engines.md](./engines.md), "Credentials"). The runner
writes it where OpenCode reads its keys, inside the container, and for
OpenRouter also sets the variable OpenCode's documentation names.

**A key is never said back.** How a turn ended is the engine's own words,
and a provider that quotes a key in its refusal would otherwise put it in a
notification. The runner takes any value it was handed out of everything it
reports or prints: the turn's ending, the agent's own words in the pane,
and the engine's error output, which is where a handoff note is cut from.
The sandbox driver does the same with a provider's answer.

### Off until an operator says so, per provider

A box runs API engines only when `FLEETWRIGHT_API_PROVIDERS` names the
provider, on a box that already runs `opencode`
(`FLEETWRIGHT_ENGINES`, containerized sessions, the session's socket). It
reports them as `health.apiProviders`.

**No protocol version changes.** The coordinator already cuts a member's
engines to what a machine runs. An `opencode` engine on an API provider is
kept only for a machine that reports that provider, so a box that does not
(every box from before this) is never sent one: the engine is left out and
said, or the start is refused when it was the member's only one. A box that
were sent one anyway would refuse it, as step 4's check refuses any model
that is not Copilot's.

### What it costs, and who is asked

A session on an API key reports tokens and no price, so the fleet counts it
as a session **whose cost is unknown** ([budgets.md](./budgets.md)): the
member's spend says "at least", and a budget does not see it. That is the
one place a budget is blind, so it has its own guard.

**A start as a member with an engine on an API key needs approval**, by
default, from somebody who manages that member: a new reason, `paid-api`,
beside `over-budget`, `dangerous` and `risky-work`. The setting is
`paidApi`, and unlike the others it starts **on**, because it guards
spending that did not exist before and so changes nothing for a fleet with
no API engine. An admin turns it off. It asks whenever any engine in the
member's list is on an API key, whichever machine the start goes to and
whether or not that machine runs the provider: a limit on the first engine
hands the session to the next with nobody there to ask, and the question is
about the member, which is what a manager approves.

## Part two: a machine from a sandbox provider

### What it is

A third kind of place a machine can be made, behind the same seam the two
hypervisors are (`src/fleet/host/pools.js`): a driver with the same five
verbs. To the coordinator and both phones it is one more source of machine
images, so making one, ending one and extending one are the screens and
routes that already exist.

| | a VM on your hypervisor | a machine from a sandbox provider |
|---|---|---|
| where | your pool or cluster | the provider's cloud |
| the credential | a limited token the setup made | an API key from the provider's dashboard |
| the vault item | `hypervisor:<address>` | `sandbox:<provider>` |
| an image | a template the setup built | a template id you list in the item |
| it enrols | from a ticket in its boot data | from a ticket in its environment |
| its life | minutes, extended or ended | the same, as the provider's timeout |

The first provider is **E2B** (`e2b`). Another is a row in the driver's
table (`SANDBOX_PROVIDERS`, `src/fleet/host/sandbox-pools.js`): its address,
how its key is sent, and four requests.

### The item

`sandbox:e2b` holds a small record: the API key, and the templates the
person wants offered, each an id and a name. The key is the provider's whole
account, which is why the item is handed only to boxes approved for the
vault that ask for it (`accepts` names `sandboxes`), held there in memory
only, and never reported. The templates are listed by the person because
the provider's list is every template on the account and only some are
built to enrol. A deposit is kept whole or refused saying which part is
not right: a template id the provider could not have, more than twelve, a
name past sixty characters, or a key that is not one.

### A template that enrols

A sandbox is a machine only if something in it joins the fleet. The driver
starts the template with two variables, `FLEETWRIGHT_TICKET` and
`FLEETWRIGHT_COORDINATOR`, and expects the template to run the fleet's own
installer and `fleetwright-vm-join` with them at start, as a VM image does
from its boot data. **Building that template is not automated and has not
been done**: this step is the driver, and the doc says what a template must
do. Until one exists the driver makes a sandbox that sits there until its
timeout, which the phone shows as a machine that never joined.

### What the driver does

- **Report**: for each `sandbox:<provider>` item a box holds, whether the
  provider answered, the templates as images, and the sandboxes this fleet
  made there for that person (found by their own metadata), each as a
  hypervisor's machine is reported: its state, when it was made and when it
  ends. The coordinator passes the entry on as a third kind of place,
  `sandbox`, with the provider's name beside it.
- **Make**: one request, with the template, the ticket and the
  coordinator's address in its environment, a timeout of the minutes asked,
  and metadata naming the fleet's machine and its owner. Sent with an
  idempotency key made from the ticket, so a retry does not make two.
- **Extend** and **end**: the provider's timeout and delete. More time
  sets the end to that many minutes from now, which is how the provider
  counts it, where a hypervisor's machine has minutes added; the phones say
  "from now". Restart and resize are refused in words: a sandbox has
  neither. A box that also holds
  a pool of the same person's asks the provider even while that pool is out
  of reach, so a rented machine can always be ended.
- **Gone when the provider says so.** A machine that enrolled and is no
  longer among the provider's sandboxes is retired at the box's next look,
  as a VM its pool no longer has is. A provider that did not answer says
  nothing about any machine.
- **Hand the Claude sign-in**: refused in words. A sandbox is given no
  sign-in after it is made (below).

### Whose sign-in runs there

A machine on somebody else's cloud that runs a session holds whatever that
session runs on. The fleet's rule for a temporary machine already covers
it: **it holds its owner's sign-in only**, and a member is never started
there ([members.md](./members.md), "Where"). An engine is a member's, so no
engine other than its owner's Claude Code runs there and no API key is ever
sent there. What it does hold, the provider can read. That is the nature of
renting a machine, and the page that offers one says so before it is made.

### Off until a person adds a key, and a box is told

A box uses sandbox items only when `FLEETWRIGHT_SANDBOX_PROVIDERS` names the
provider. With it unset the box does not ask the vault for them, holds none
and reports none, and no screen offers one. A box needs no hypervisor to
hold a provider: one that holds only a provider's key looks at it and
reports it.

## Part three: a machine on a box of your own

Asked for, reading part two: *"why sandbox provider and not our sandboxes we
built?"*, and then: *"our own with no third party I mean both are okay but I
feel like allowing to be fully on prem plus third party is the better
route"*. Part two rents a machine. This makes one from what the fleet
already has, and neither replaces the other.

### What it is

A fourth place a machine can be made: **a container on a box that is
already in the fleet**, from the fleet's own machine image. No hypervisor,
no provider and no key. It is behind the same seam as the other three, so
to the coordinator and both phones it is one more source of a machine
image.

| | a VM on your hypervisor | a machine from a sandbox provider | a machine on a box of your own |
|---|---|---|---|
| where | your pool or cluster | the provider's cloud | a box you enrolled |
| what it is | a virtual machine | whatever the provider runs | a rootless Podman container |
| the credential | a limited token the setup made | an API key | none |
| the vault item | `hypervisor:<address>` | `sandbox:<provider>` | none |
| an image | a template the setup built | a template id you list | one, which the box builds from its own release |
| it enrols | from a ticket in its boot data | from a ticket in its environment | from a ticket in its environment |
| its life | minutes, extended or ended | the provider's timeout | minutes, kept by the box |
| who else can read it | nobody | the provider | nobody |

### What a machine there is

The box's hub runs it, as it runs the container a sandboxed session works
in: rootless, in the same user namespace arrangement, under the same limits
on memory, processors and processes that box gives a session. Inside is
Debian, Node and the fleet's own host, which joins the fleet with the
ticket it was started with and then takes sessions like any machine.
Sessions inside it run as plain panes: the container is the sandbox, and
there is not a second one inside the first.

**The hub inside counts its sessions against the machine's own memory
limit.** A hub takes sessions while there is memory for them, and what a
container reads as available is the box's: allowed 8 GB on a box with 60
free, it would have taken sixteen sessions into the eight, and the kernel
ends a container that passes its limit, with every session in it. So what
is available is the less of what the box has and what the hub's cgroup
still allows it (`src/core/cgroup-memory.js`, cgroup version 2), and at the
limit a session is refused for memory in words, as on any full box. This
holds for any hub under a limit, a unit's `MemoryMax` included. The load
it reads is still the box's, and what its sidecar reports as its memory
is too.

**Not on a box that keeps its sessions behind an egress allowlist.** A
machine dials the fleet itself, and its sessions reach what it reaches, so a
container made there would be one that is not behind the list. Such a box
refuses to make one and says why, and it neither builds the machine image
nor offers it: an image there would be a button for something every press of
is refused. Putting a machine behind the list is not built.

It is a temporary machine like any other, so the rules for one hold with no
new code: **it holds its owner's sign-in only**, a member is never started
there, it is never chosen for work that did not name it, and nobody but its
owner starts a session on it ([members.md](./members.md), "Where").

### The image is built on the box, from the box's own release

The hub builds the image when the box's operator turns this on, from
`sandbox/machine/Containerfile` and the release that box is running, and
again when the box's release changes. So a machine runs the version its box
runs, and nothing of the fleet's is pulled from a registry. What the build
does fetch is Debian's and Node's own packages and Claude Code's installer,
as a box's own install does. A box whose operator has an image already
names it in `FLEETWRIGHT_MACHINE_IMAGE`, and the hub builds nothing.

**Nobody waits for the build.** It takes a few minutes, so it is started in
the background at the sidecar's first look and not when a person asks for a
machine. Until it is done the box offers no image, and its place on the
phone says why: it is building, or the build failed and what Podman said. A
build that failed is tried again half an hour later, not every minute.

**A release is not one shape**, so the build's context is not the release
itself. A packaged box has `lib/` with everything bundled in and no `src/`
but the web pages; a checkout has `src/` and `node_modules`, and an `apps/`
and a `.git` that have no business in an image. The hub copies the parts
that exist into a directory of its own and builds from that
(`stageMachineContext`). The image's tag is made from the bytes of the
files a host runs from, so a release that changed is another image, and the
one before it is removed once no machine uses it. It is the bytes and not
each file's size and time, because a release has no times: the packager
stamps every file 2020, and a fix that kept a file's length would have kept
the tag, and the old host in every machine. The same bytes unpacked again
are the same image, and nothing is rebuilt.

Two things that are not bytes are in the tag too, because the image differs
by them: the major of the Node the hub runs on, which is the Node the build
installs, and whether each file may be run. **A checkout's `node_modules`
is not read.** What npm installed is listed in `node_modules/.package-lock.json`,
and that one file stands for the directory, through a link when
`node_modules` is one (a second worktree's). A `node_modules` with no such
file stands for nothing: a dependency changed there, by another installer
or by hand, is the same tag and the image is not built again. A release has
no `node_modules`.

### The same image is the template a provider needs

Part two says a provider's template has to enrol itself and that building
one was not done. This is that image. Its entrypoint reads the two
variables the provider driver sets, `FLEETWRIGHT_TICKET` and
`FLEETWRIGHT_COORDINATOR`, so a template built from the same Containerfile
at a provider joins the fleet the same way. **That has not been tried
against a provider**, and a provider's template build is its own tooling,
not this repository's.

### Off until the box's operator turns it on

The switch is the one part two has: `FLEETWRIGHT_SANDBOX_PROVIDERS` names
`own` (beside `e2b`, or alone). With it unset the box makes no machine,
reports none and builds no image. It also needs Podman on the box, which a
box that runs sandboxed sessions already has.

A box makes these **for the people whose vault it is approved for**, and
nobody else. Those are the people who already said this box may hold their
sign-ins, and a machine on it is handed one.

At most `FLEETWRIGHT_MACHINE_MAX` run on a box at once (two unless set):
they share the box's memory with its sessions, and a box that is asked for
a third says so rather than starving the first two.

### What the driver does

The sidecar never touches Podman, so its driver
(`src/fleet/host/own-pools.js`) asks the hub, which owns the box's
containers (`src/core/machines.js`), over the loopback API it already uses:
`GET /api/machines`, `POST /api/machines`, `POST /api/machines/control`,
behind the hub's token like every route there.

- **Report**: for each person the box makes these for, one place named for
  the box (`own:<box>`), its one image once that is built, and the machines
  it made for that person, each with its state, when it was made and when
  it ends. The coordinator passes it on as a `sandbox` place marked `own`,
  which is how a phone knows not to call it rented. A hub or a Podman that
  could not be asked is reported as not reachable, with why, and never as
  "no machines": the coordinator retires a machine that a reachable place
  no longer lists.
- **Make**: the hub is asked to start a container named for the machine
  (`vm-<12 hex>`, from the ticket), for 5 to 350 minutes and 60 unless
  said. The ticket is written into the machine's own volume first, as the
  join file a VM has, by a container that lives just long enough to read it
  from standard input. So it is in no command line, where every user of
  the box could read it, and in no environment, which Podman keeps a record
  of. The machine then starts with only the coordinator's address. A hub
  that stopped between those two steps leaves a volume with an unspent
  ticket in it and no container, so each look at the machines also lists
  the volumes and removes one that is a machine's by its name and that no
  container has. It asks Podman without forcing, and Podman refuses a
  volume a container has; the volume of a machine being made at that
  moment is left alone.
- **Extend** adds minutes to its end, as on a hypervisor, and never past
  the longest a machine lives counted from when it was made, so asking
  again and again does not keep one, and its place on the box, for ever. At
  that limit more time is refused in words. **End** stops it and removes
  it with its volume. Both are its owner's alone: to anybody else the
  machine is not there.
- **Its timer is the box's.** The hub looks once a minute while it has a
  machine and ends one whose time has run out. Who a machine is for and
  when it was made are labels on its container; when it ends is in the
  hub's state, because more time changes it. A hub that lost that state
  ends a machine by its labels, and a machine whose container stopped by
  itself (its sidecar ended, or the box restarted) is cleared away with
  its volume. A look takes an end out of that state only for a machine it
  removed itself, or one that had no container when the look began. An
  end written while a look is under way, for a machine made or given more
  time in that moment, is left for the next look.
- **Why one stopped is kept, for an hour.** A machine's log goes with its
  container, and it is the one place the machine said why. So before the
  hub removes one that stopped by itself it reads the last twenty lines of
  that log, in the order they were printed (by the time Podman puts on
  each, read as a time and not as text), and writes them to its own
  log. The last line that says something is kept for an hour and shown on
  its owner's place for this box, where that place says why it has no
  image, as *"This machine found vm-… stopped 12 minutes ago and removed
  it with its disk. Its log ends: …"*. Nobody else is shown it. Anything
  in those lines that looks like a ticket or a token is withheld before
  they are logged or kept, and so is any long unbroken run of a token's
  letters, which costs a long path or host name too. A shorter secret is
  withheld by where it stands: whatever is before the `@` of an address,
  and what follows a word that names one (key, token, secret, password),
  whole when it is written as an assignment and otherwise when it has a
  digit in it or is twenty characters or more. A secret of no known shape,
  under thirty-two characters, in neither place, is not caught. A log
  Podman could not read, or an empty one, is said as that. A machine the
  box ended, on its owner's word or when its time was up, is not said: its
  owner knows.
- **Asked first, by name.** For more time, an end or a sign-in, this
  driver is asked before a hypervisor's: the hub is on the box and answers
  at once whether a machine is its own, where a pool that is down would
  have to be waited out first.
- **Gone when the box says so.** A machine that enrolled and is no longer
  among the box's containers is retired at the box's next report, as a
  provider's sandbox is.
- **Hand the Claude sign-in**: as to a VM the box made, since the box holds
  it and the machine is the box's own.

### Only with a hypervisor

Some of what a VM has, a container on a box has not, and that is said
rather than faked: *"its okay to have some features only avail with a
hyprovisor"*. Refused in words, on the machine's page and from an agent:

- a network, a group or a lab of its own, and the edge router in front of
  one. It is on the box's network, as that box's sessions are;
- restart and resize;
- a console.

And two things it is not:

- **Not a second kernel.** It shares the box's, as a sandboxed session
  does. It keeps one person's work off another's and off the box, and it is
  not the boundary a virtual machine is against somebody who breaks out of
  a container.
- **Not kept.** Its disk is a volume that goes when it ends.

### What has and has not been run

In the tests, Podman is a program that stands in for it and remembers what
it was told (`test/helpers/stub-machine-podman.js`), under the real hub
routes with the real client and the real driver above them. That proves
what Podman is asked and what the fleet then says, and nothing about what
Podman does.

So CI runs the real one (`machine-image.yml`, `scripts/machine-smoke.mjs`),
through the hub's own code, twice: it builds the image from a checkout, and
from a packaged release unpacked as a box has one, which are the two shapes
a host comes in. Each time it checks the host in the image is that shape and
that a start with nothing to join is refused in words, makes a machine with
a ticket and a fleet that does not exist (`https://fleet.invalid`), reads in
its log that the hub inside started and the sidecar tried to enrol, then
lists it, gives it more time and ends it, and checks nothing is left. Then
it makes another and stops its container under the hub, and checks the hub
removes it, says how its log ended, and removes a volume no machine has.
It runs when anything the image is built from changes, the host's own code
included. It built from a checkout only, and ran only when the image's own
directory changed, which is how a path that was wrong only in a release
(the SessionStart hook's) was never seen here.

That run has no memory, processor or process limit on the machine, because
a CI job's user has no cgroup controllers of its own; that Podman honours
the limits a box passes is not checked anywhere, and neither is the hub
inside refusing a session at its container's limit, which the tests read
from a stand-in for the cgroup's files (`test/cgroup-memory.test.js`).

**The release leg, the stopped machine and the stray volume in that run
were written without a Podman to run them on, and have not run until CI
runs them.**

**No machine has been made on a real box, and none has joined a fleet.**
What is left unproven is the last step: a machine enrolling with a real
coordinator, being handed its owner's sign-in, and running a session.

**What the first real run found.** The ticket was first handed to Podman
as an environment file on its standard input. Every test passed, against a
stand-in, and a real Podman refused it: the hub gives a child process a
socket for its standard input, and a socket cannot be opened by path. The
ticket now goes into the volume as above, which is also better than what
was meant: it is in nothing Podman keeps of the container. The CI run
checks that with `podman inspect`.

A machine started from the same image somewhere else, with its ticket in
its environment (a provider's template), still has it in the environment
its first process was started with, which root inside can read. It is
spent the moment the machine enrols and is worth nothing after; a VM's
ticket sits in its boot data in the same way.

## Where it shows

- **MCP**: `fleet_member`'s `engines` takes the new models; `fleet_health`
  prints a machine's API providers; `fleet_status` lists sandbox templates
  among the machine images, marked as a sandbox provider's, and a box's own
  image marked as one of the person's own machines; `fleet_budgets` says
  whether a paid engine needs approval.
- **Both phones**: API keys under a member's Credentials, offered for the
  providers its engines name; the OpenCode model field accepts the new
  prefixes and says what each bills to; Approvals' settings gain the
  switch; Hypervisors, under Machines, offers "Add a sandbox provider" with
  its key and templates; a sandbox template is among the images, marked as
  a rented machine that ends on a timer; and a rented machine's page offers
  more time and end, and nothing a sandbox does not have. A box of your
  own is drawn apart from a provider's: *One of your machines* where a
  provider's row says *Sandbox provider*, its machines under *On one of
  your machines*, never called rented and never said to be readable by
  anybody else, with why it offers no image yet while it builds one, and
  with the line that a network, a lab, a restart, a resize and a console
  need a hypervisor. The same line says, for an hour, that a machine of
  yours there stopped by itself and how its log ended; neither phone
  changed for it.
- **The signing page**: the same two items. A box of your own has no item:
  there is nothing to keep.
- **The API**: `GET /api/hosts` marks a place, an image and a machine with
  `own` ([openapi.json](../openapi.json)).

## What it does not stop

- **A key is a spending limit set somewhere else.** The fleet does not know
  what a key may spend. Set that at the provider.
- **A budget does not see an API key's spending**, as above. The approval
  is the guard, and an approval is one start.
- **The provider of a sandbox can read what runs in it**, as above.
- **A sandbox template is trusted to enrol itself and nothing else.** The
  driver cannot look inside one.
- **A key in a vault is a copy.** Whoever pasted it still has it.
- **A machine on a box is a container, not a second computer.** It shares
  the box's kernel. And it is made by whoever the box is approved for, on
  that box's memory: the cap is how many, and the three limits are how much.
- **A box behind an egress allowlist makes none**, as above, and that is
  a refusal and not a guard somebody could turn off.

## Tests

`test/api-engines.test.js` (the providers, the model rule, which credential
an engine runs on, what a machine is sent), the API-key tests in
`test/engines-run.test.js` (the runner staging a key for a stand-in
OpenCode, and no engine started for a member with no key on the machine),
`test/api-engines-coordinator.test.js` (a start cut to a machine's
providers, the box from before this, the `paid-api` approval and its
default), the key and sandbox items in `test/vault.test.js` (kept, never
read back, only to a box that asks for them), `test/sandbox-pools.test.js`
(the driver against a stand-in for E2B's API: report, make with its
idempotency key, extend, end, a provider that is down, what is refused in
words), `test/sandbox-coordinator.test.js` (a template offered as the
provider's, making one, a member never started there, and the machine gone
at the box's next look), the three new lines in `test/mcp.test.js` and
`test/budgets-mcp.test.js`, and `test/api-engines-in-apps.test.js`.

For a machine on a box of your own: `test/machines.test.js` (the hub: the
build from either shape of release, in the background and never waited
for; the ticket into the volume from standard input, in no command line
and no environment; the cap; the box's clock; more time and end; a volume
a making left behind; a machine that stopped by itself and how its log
ended, with no ticket or token in what is kept; what is refused in words;
the API with its token), `test/own-pools.test.js` (the driver over the
real hub routes: off unless named, a place per approved person, the image
offered once built, the sign-in sealed to the machine's key and to no
other, a stopped machine said on its owner's place and nobody else's, a
hub that cannot be asked, and its place behind the one seam), `test/machine-image.test.js`
(the entrypoint run for real against stand-ins for the hub and the
sidecar), the fourth test in `test/sandbox-coordinator.test.js` (marked
`own`, named for the box, why it has no image yet, retired at the box's
next look and not when the box could not look), and the on-box case in
`test/mcp.test.js`. And `test/cgroup-memory.test.js` for the memory a hub
under a limit may still take.
