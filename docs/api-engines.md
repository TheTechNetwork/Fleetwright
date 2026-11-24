# Paid API models, and machines from a sandbox provider

> API-key engines as vault items, and a sandbox host type. Built and tested
> with stand-ins only.

Before this a member ran on subscriptions: a Claude sign-in, a Codex sign-in,
a Copilot token ([engines.md](./engines.md)). A machine was one you
enrolled, a GitHub runner, or a VM on your own hypervisor
([hypervisors.md](./hypervisors.md)).

Now a member's engine may run on **a metered API key** kept in its vault,
and a person may make a machine **on a sandbox provider's cloud** with a key
of their own. Both spend money by the minute or the token, so both are
behind switches that are off, and a guard that is on.

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

It is a temporary machine like any other, so the rules for one hold with no
new code: **it holds its owner's sign-in only**, a member is never started
there, it is never chosen for work that did not name it, and nobody but its
owner starts a session on it ([members.md](./members.md), "Where").

### The image is built on the box, from the box's own release

The hub builds the image the first time a machine is asked for, from
`sandbox/machine/Containerfile` and the release that box is running, and
again when the box's release changes. So a machine runs the version its box
runs, and nothing of the fleet's is pulled from a registry. What the build
does fetch is Debian's and Node's own packages, as the session image's
build does. A box whose operator has an image already names it in
`FLEETWRIGHT_MACHINE_IMAGE`, and the hub builds nothing.

The first machine on a box therefore takes as long as the build does, and
the phone is told the image is being built rather than left to guess.

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

- **Report**: for each person the box makes these for, one place named for
  the box, its one image, and the machines it made for that person, each
  with its state, when it was made and when it ends. The coordinator passes
  it on as a `sandbox` place marked `own`, which is how a phone knows not to
  call it rented.
- **Make**: the hub is asked to start a container named for the machine
  (`vm-<12 hex>`, from the ticket), for 5 to 350 minutes and 60 unless
  said. The ticket and the coordinator's address reach it in a file the hub
  hands Podman on its standard input, never on a command line, where every
  user of the box could read it.
- **Extend** adds minutes to its end, as on a hypervisor. **End** stops it
  and removes it with its volume.
- **Its timer is the box's.** The hub ends a machine whose time has run
  out at its next look, and a machine that outlived a restart of the hub is
  found again by its labels and ended on the same clock.
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
  one. It is on the box's network, as that box's sessions are, behind the
  box's egress list where the box has one on;
- restart and resize;
- a console.

And two things it is not:

- **Not a second kernel.** It shares the box's, as a sandboxed session
  does. It keeps one person's work off another's and off the box, and it is
  not the boundary a virtual machine is against somebody who breaks out of
  a container.
- **Not kept.** Its disk is a volume that goes when it ends.

### What has and has not been run

Podman has not been run for this in any test here: the hub's side is tested
against a stand-in `podman`, as the session container's is, and the
sidecar's against a stand-in hub. The image is built and started in CI
(`sandbox.yml`), where it is checked to refuse a start with no ticket and
to try to enrol with one. No machine has been made on a real box.

## Where it shows

- **MCP**: `fleet_member`'s `engines` takes the new models; `fleet_health`
  prints a machine's API providers; `fleet_status` lists sandbox templates
  among the machine images, marked as a sandbox provider's;
  `fleet_budgets` says whether a paid engine needs approval.
- **Both phones**: API keys under a member's Credentials, offered for the
  providers its engines name; the OpenCode model field accepts the new
  prefixes and says what each bills to; Approvals' settings gain the
  switch; Hypervisors, under Machines, offers "Add a sandbox provider" with
  its key and templates; a sandbox template is among the images, marked as
  a rented machine that ends on a timer; and a rented machine's page offers
  more time and end, and nothing a sandbox does not have.
- **The signing page**: the same two items.

## What it does not stop

- **A key is a spending limit set somewhere else.** The fleet does not know
  what a key may spend. Set that at the provider.
- **A budget does not see an API key's spending**, as above. The approval
  is the guard, and an approval is one start.
- **The provider of a sandbox can read what runs in it**, as above.
- **A sandbox template is trusted to enrol itself and nothing else.** The
  driver cannot look inside one.
- **A key in a vault is a copy.** Whoever pasted it still has it.

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
