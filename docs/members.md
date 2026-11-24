# Members: the fleet as an organization

> A user must be able to be a team lead or manager who manages several people
> and agents, including their credentials.

Before this, a fleet was a list of people and a list of machines. Every
session ran as the person who started it, on that person's own sign-ins, and
nothing said what anybody was for.

Now a fleet has **members**. A member has a role, a place in a tree, standing
instructions and a vault of its own. Whether a member is a person or an AI
agent is the owner's choice, and Fleetwright treats both the same. A session
can be started **as** a member: it runs on that member's sign-ins, opens with
that member's instructions, and goes where that member runs.

This is step 2 of the organization work. Tasks above sessions, delegation,
engines other than Claude Code, routing and budgets are later steps
([ROADMAP.md](../ROADMAP.md)); `budgetUsdMonth` is stored here and enforced by
nothing yet.

## A member

| field | what it holds | bound |
|---|---|---|
| `id` | a slug, the member's name in every command and file | `a-z`, `0-9`, `-`, at most 40 |
| `name` | what a screen shows | at most 80 characters |
| `kind` | `person` or `agent` | |
| `email` | a person member's fleet address | person members only, and one member an address |
| `role` | a label: "software engineer", "designer" | at most 60 |
| `title` | a longer label | at most 80 |
| `reportsTo` | another member's id, or nobody | no cycles |
| `managers` | fleet addresses that manage this member beside the tree | at most 4, set by an admin |
| `description` | what this member is for | at most 300 characters |
| `workTypes` | the kinds of work it takes | at most 12, each a short slug |
| `instructions` | markdown the member's sessions open with | at most 4 KiB |
| `engines` | what runs it, in order | exactly one this step: `{ engine: "claude-code", model? }` |
| `hosts` | where it runs: `{ tag? }` | a host tag |
| `budgetUsdMonth` | a monthly budget | stored, not enforced |
| `createdBy`, `createdAt`, `updatedAt` | who made it, and when | set by the coordinator |

**No credential is ever in a record or a file.** A member's sign-ins are in
its vault, in the minter, and the record does not point at them.

Members are kept by the coordinator (`src/fleet/coordinator/members.js`), one
Durable Object value a member under `members:<id>`, because a value holds 128
KiB and one member's instructions alone are 4 KiB. A fleet holds at most 200.
The Node coordinator keeps the same rows in its state file. Everybody in the
fleet reads the list; it is how a person learns who does what.

## The tree, and who manages whom

`role` is a label and gives nothing. Managing comes from the tree:

- **A member's team** is every member whose `reportsTo` chain leads to it.
- **A person manages a member** when their own person member is above it in
  the chain, or when their address is in `managers` on that member or on any
  member above it. An admin names extra managers; the tree makes the rest.
- **A fleet admin** (`hosts.js administers`) manages everybody.

A manager can, for each member of their team:

- read and edit the record, and move the member anywhere inside their own
  team. They cannot move a member out of it, change `managers`, or touch a
  member they do not manage;
- start a session as that member, and see its sessions;
- hold custody of its vault (below).

`manages` in `src/fleet/protocol/members.js` is the one function that answers
this. The coordinator, the minter and the box all call it, on the tree each
of them holds.

## The file

A member is one markdown file with YAML front matter: the fields above, and
the instructions as the body.

```markdown
---
id: debbie
name: Debbie
kind: agent
role: software engineer
reportsTo: eli
workTypes: [backend, review]
engines:
  - engine: claude-code
hosts:
  tag: linux
---
You write small pull requests and say what you did not test.
```

`GET /api/members/export` gives every member as such a file, and
`POST /api/members/import` takes one and makes or changes that member, under
the same rules as any other write. The front matter is the small subset this
needs (scalars, inline and block lists, one level of maps), parsed by
`members.js` itself; anything else in a file is refused by name.

## A member's vault

**One vault, expanded.** The minter keeps one vault per person today
([vault.md](./vault.md)). A vault's owner is now a **principal**: a person, as
before, or an agent member, as `member:<id>`. A person member keeps the vault
they already have. An agent member gets one of its own, with the same rows
under its principal (`v:member:<id>`, `gh:member:<id>`), sealed, renewed under
one lock, tested and checked exactly as a person's is.

**Custody is the minter's, never the coordinator's.** The coordinator is the
party this fleet is built to distrust ([signed-intents.md](./signed-intents.md)),
so who may act for a member's vault is held and checked in the minter:

- **The minter keeps its own copy of the tree** (`org`, one row): each
  member's id, kind, address, `reportsTo` and `managers`, and each agent
  member's custodians. It reaches the minter only as a vault request, sealed
  on a phone or the signing page with that person's own GitHub sign-in inside
  (`orgmember`), and the minter takes a change only from somebody who already
  holds the right to make it there: an org admin, or a manager above both the
  member's old place and its new one.
- **Org admins are the minter's own list**, because the minter has no other
  way to know one. The first person to file the tree becomes its first admin,
  and only while the coordinator also says they administer the fleet. After
  that an admin is added or removed by an admin, the last one stays, and the
  coordinator's word can only take away. This is first use, as a fleet
  address is ([signed-intents.md](./signed-intents.md), "Who may do what"),
  and it is stated under "What it does not stop".
- **Every identity is a fleet address the minter has bound to a GitHub
  account** (`dk:<address>`). An address nobody has filed a signing key under
  manages nothing there, so a manager signs in on a phone or the signing page
  before any of this works for them.

**Custodians of an agent member.** The admin who files an agent member is its
first custodian. A custodian adds or removes another (`custodian`), and the
last one cannot be removed. Every manager of the member is a custodian too,
for as long as the tree says so: move the member out of their team and their
custody ends with that change, at the minter, at once.

**Custodians of a person member.** A person's vault holds their own sign-ins,
so a manager holds custody of it only after that person turns it on from
their own device (`custody`, under You › Credentials). Until then a manager's
request is refused with a sentence saying who can allow it. The person's own
`list` names their custodians, and every deposit, change or removal a
custodian makes is written beside the vault (`custody-log`, the last twenty)
where the person reads it, and told to their phone. The log is the minter's;
the push is the coordinator's and can be dropped by a dishonest one, which is
why the log exists.

**What a custodian does** is what a person does for their own vault, with
`for: <member id>` in the same sealed request: list, Test, keep or forget an
item, sign in to GitHub or Cloudflare, and approve or remove a box. A Claude
sign-in is made the way a person's is: pick the member, pick a box, run the
sign-in there, and the result comes back sealed to the custodian's device and
is deposited into the member's vault and not their own. Nothing is ever read
back: a vault answers with names and states, never values.

**Box approval is per vault.** Approving a box for a member's vault is a
grant in that vault and nowhere else. A box is given a member vault only when
it says it understands one (`accepts: ["members"]`, signed in its request), so
a box from before this is never handed an account it would file under no
name.

**The sign-in check tells every custodian.** The fifteen-minute check
([vault.md](./vault.md), "Whether it still works") asks after member vaults as
it asks after people's, and an ended sign-in is told to each of the member's
custodians.

**Later kinds.** A vault item's name still decides its kind (`itemKind`). The
kinds a later engine needs are reserved by name in `FUTURE_ITEM_KINDS`
(`codex`, `copilot`, `apikey:`): none is kept yet, and each is refused with a
sentence that says it is not kept yet and not that it is unknown.

## Starting as a member

`start` takes `member`. Three places check it, each against what it holds.

**The coordinator refuses first**, in the person's words: the member does not
exist, or the person is neither that person member nor anybody who manages or
holds custody of it. It reads custody from the last key list the minter
signed, which it relays to boxes and can read but not write.

**The box decides.** The minter's signed key list (`/vault/keys`) now carries
each member and who may start as it: for an agent, its custodians; for a
person, the person, and their managers once they allowed custody. A box runs
a member start only when it is **signed or delegated by somebody on that
list**, whatever the box's signature mode: an unsigned actor here would be the
coordinator naming a custodian. Otherwise it refuses, `not_custodian`, saying
who the minter lists.

**Credentials come from the member's principal and nowhere else.**
`pickCredentialSource` takes the principal: `member:<id>` for an agent, the
person's address for a person member. It does not fall back to the requester's
account or to anything on the box. A member with no sign-in on that box is a
refusal that names the member and the box.

**Where.** With no host and no tag given, the member's `hosts.tag` places it.
A member start is not sent to a temporary runner: a runner holds its owner's
sign-in only.

**The first message** is the member's instructions, a line of dashes, then
the task. The box composes it and refuses past the 8000 bytes a first message
already may be. The instructions travel as `memberBrief`, a parameter the
coordinator writes (`setBy: 'fleet'`), because the person signs the task and
the member, and the instructions are the coordinator's record.

**The session records** the member's id, name and role, and who started it.

**Protocol 19.** A host older than 19 is refused a member start. It would
ignore `member` and run the session on the requester's account, which is the
one outcome this must never have.

## Where it shows

```
GET    /api/members            { members, you: { admin, manages, startAs } }
PUT    /api/members/{id}       a record's fields
DELETE /api/members/{id}
GET    /api/members/export     { files: [{ name, text }] }
POST   /api/members/import     { text }
```

- **MCP** (`src/mcp/tools.js`): `fleet_members` lists, `fleet_member` writes
  or removes one, and `fleet_start` takes `member`. An MCP client changes the
  record; custody is filed from a phone or the signing page, which hold the
  person's own sign-in.
- **Both phones**: an **Org** screen, the tree by `reportsTo`; a member's page,
  with Edit for whoever manages it; **My team** for a manager, each member
  with its sign-in's state; a member's **Credentials**, which is the
  Credentials screen pointed at that vault; and **Start as** on New session,
  listing only members the person may start as.
- **The signing page**: the same member Credentials and My team.

Where the minter's tree and the coordinator's differ for a member (a record
written from an MCP client, say), the Org screen says custody has not been
filed for that change and offers to file it. It never shows the coordinator's
tree as the minter's.

## What it does not stop

- **The first org admin is first use.** A coordinator compromised before any
  admin filed the tree could vouch for an account of its own. That account
  could then file agent members and hold their empty vaults. It reaches no
  person's vault, which needs that person's own switch, and the real admin
  sees somebody else listed as the org's admin.
- **A member's instructions are the coordinator's word.** A compromised
  coordinator can change what a member's session is told at its start. It
  cannot start one, or change the task, without a custodian's signature.
- **A custodian can use what they keep.** Approving a box for a member's
  vault hands that box the member's tokens. Custody is that power; the tree
  and the person's switch decide who has it.
- **Anybody in the fleet reads the org chart**, instructions included.

## Tests

`test/members.test.js` (records, cycles, managing, the file),
`test/members-coordinator.test.js` (who may write, routes, the Durable Object
round trip, start-as, the protocol 18 refusal),
`test/members-vault.test.js` (the org row, custody, deposits, one renewal
lock, box approval a vault, the check's alerts),
`test/members-host.test.js` (the box's check, credentials by principal, the
first message) and the phone and MCP rows in the existing suites.
