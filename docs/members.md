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

Members are kept by the coordinator (`src/fleet/coordinator/org-members.js`),
one Durable Object value a member under `members:<id>`, because a value holds
128 KiB and one member's instructions alone are 4 KiB. A fleet holds at most
200. Everybody in the fleet reads the list; it is how a person learns who does
what.

"Member" already meant somebody who may sign in (`clients.js`, `invites.js`,
`member-page.js`). That list decides who is in the fleet. This one says what
the fleet is made of. A person member names somebody on the other list by
their address, and an agent member names nobody.

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
- start a session as that member, and see and stop the sessions started as
  it, whoever started them;
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

- **The minter keeps its own copy of the tree** (`orgm:<id>`, one row a
  member, in `src/fleet/minter/org.js`): each member's id, kind, address,
  `reportsTo` and `managers`, and each agent member's custodians. It reaches the minter only as a vault request, sealed
  on a phone or the signing page with that person's own GitHub sign-in inside
  (`orgmember`), and the minter takes a change only from somebody who already
  holds the right to make it there: an org admin, or a manager above both the
  member's old place and its new one.
- **Org admins are the minter's own list** (`org:admins`), because the minter
  has no other way to know one. The first person to file the tree becomes its first admin,
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

**Custodians of a person member.** A person's vault holds their own
sign-ins, and who else holds custody of it depends on who was there first.

- **Whoever adds a person manages their credentials.** Asked for in so many
  words, after the first build made this the person's to turn on: *"if a
  manager created the member they should be able to manage it."* The admin
  or manager who files a person member is that person's custodian, as the
  one who files an agent is its first. They need no switch from the person,
  and they hold it from the person's first sign-in, which is when there is a
  vault to hold.
- **Only for a person the vault had not met.** That holds when no GitHub
  account had ever filed a signing key under the address when it was filed.
  Somebody who already keeps their own sign-ins there was not created by the
  record that names them, and making one must not be a way to reach what
  they kept: any team lead can file a member under their own team, and
  without this line could take the sign-ins of anybody in the fleet who had
  no record yet. For them the switch below still decides, and the filing's
  answer says so. Three ways round it are closed at the minter, each with a
  test (`test/vault.test.js`):
  - *Taking a record out and filing it again*, or filing one for somebody
    whose keys were all removed after a lost phone. The address was met, so
    it gives nothing.
  - *Filing a record at an address somebody has not used yet.* When a
    GitHub account that already has a vault files its first key under that
    address, the vault had met them after all, and the custody is dropped at
    that moment.
  - *Pointing an existing record at another address.* That names another
    person, so the old one's custodian does not follow it. Whoever made the
    change added the new one, on the same terms.
- **The person sees it before they keep anything.** Their own Credentials
  names who added them and what that person can do, and their `list` carries
  it. The vault is still theirs: they forget what they keep and remove a
  machine whenever they like, which no custodian can undo.
- **It ends with the one who holds it, or an org admin.** The custodian can
  give it up, and an org admin can remove them (`custodian`). Both phones
  and the signing page ask first, because it is not given back: the person's
  own switch does not end it, and nobody is added to a person this way after
  the first. The next manager, and the one who gave it up, are let in by the
  person.
- **Every other manager, by the person's own switch.** A manager by the tree
  who did not add the person holds custody only after that person turns it
  on from their own device (`custody`, under You › Credentials). Until then
  their request is refused with a sentence saying who can allow it.

Either way the person's own `list` names their custodians and managers, and
every deposit, change or removal somebody else makes is written beside the
vault (`clog:`, the last twenty) where the person reads it, and told to
their phone. The log is the minter's; the push is the coordinator's and can
be dropped by a dishonest one, which is why the log exists.

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
person, the person, whoever added them, and their other managers once they
allowed custody. A box runs
a member start only when it is **signed or delegated by somebody on that
list**, whatever the box's signature mode: an unsigned actor here would be the
coordinator naming a custodian. Otherwise it refuses, `not_custodian`, saying
who the minter lists.

**Credentials come from the member's principal and nowhere else.** A box
files everything a session runs on by the address of whose it is, and every
reader there, the credential broker included, finds a session's sign-ins by
that address. An agent member has no address, so a box files its vault under
one nobody can hold: `<id>@members.invalid` (`accountOfMember`). The session's
account is then the member's, and `pickCredentialSource` and everything after
it read the member's sign-ins exactly as they read a person's, with the same
rule: no fallback to the asker's account or to anything on the box. A member
with no sign-in on that box is a refusal that names the member. A box refuses
any request that names an address at that domain as the one asking, so the
only way onto a member's sign-ins is a member start the box has checked.

**A member's session is not pushed to the starter's archive.** That push is
made with the starter's own GitHub sign-in on the box, and a box holding the
member's vault need not hold theirs. A branch for the work is step 3's.

**Where.** With no host and no tag given, the member's `hosts.tag` places it.
A member start is not sent to a temporary runner: a runner holds its owner's
sign-in only.

**The first message** is the member's instructions, a line of dashes, then
the task. The box composes it and refuses past the 8000 bytes a first message
already may be. The instructions travel as `memberBrief`, a parameter the
coordinator writes (`setBy: 'fleet'`), because the person signs the task and
the member, and the instructions are the coordinator's record.

**The session records** the member's id, name and role, and who started it.
Its creator is the member's account, so `startedBy` is what lets the person
who asked see it, stop it and open its ports, and the member's id is what
lets its managers.

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
  could then file agent members and hold their empty vaults. It reaches the
  vault of nobody who was already there, which needs that person's own
  switch; somebody it adds itself is the last case here but one. The real
  admin sees somebody else listed as the org's admin.
- **A member's instructions are the coordinator's word.** A compromised
  coordinator can change what a member's session is told at its start. It
  cannot start one, or change the task, without a custodian's signature.
- **A custodian can use what they keep.** Approving a box for a member's
  vault hands that box the member's tokens. Custody is that power; who added
  the member, the tree and the person's switch decide who has it.
- **Whoever adds a person holds what that person later keeps.** A person
  added by somebody they do not know, on a fleet whose first admin was
  vouched for by a dishonest coordinator, would be keeping sign-ins under a
  stranger's custody. Their own Credentials names that custodian before they
  keep anything, which is the only defence and is why it is shown first.
- **Anybody in the fleet reads the org chart**, instructions included.

## Tests

`test/members.test.js` (records, cycles, managing, the file),
`test/members-coordinator.test.js` (who may write, routes, the Durable Object
round trip, start-as, the protocol 18 refusal), the "Members' vaults" section
of `test/vault.test.js`, which uses that file's real minter (the tree and its
admins, custody following the tree, deposits, one renewal lock, box approval a
vault, the check's alerts, and a signed member start from a phone through the
coordinator to a box and what it hands the session manager),
`test/members-in-apps.test.js`, and the two member tools in `test/mcp.test.js`.
