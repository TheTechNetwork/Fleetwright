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
([tasks.md](./tasks.md), [engines.md](./engines.md),
[routing.md](./routing.md), [budgets.md](./budgets.md),
[ROADMAP.md](../ROADMAP.md)).

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
| `engines` | what runs it, in the order to try | up to three, each once: `claude-code`, `codex`, `opencode`, each with a `model?` ([engines.md](./engines.md)) |
| `hosts` | where it runs: `{ tag? }` | a host tag |
| `budgetUsdMonth` | a monthly budget, in dollars at API prices | counted against, and enforced when an admin turns that on ([budgets.md](./budgets.md)) |
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

**Whose an address is.** An address belongs to the first GitHub account that
lists a signing key under it, **for good**: another account is refused
(`address_taken`) whether or not a key is still listed. It used to be free
again once its keys were all removed, which is the moment a person who has
lost their phone is least able to notice: a coordinator that lies about who
is signing in could vouch a custodian's address for another GitHub account,
which was then that custodian to every vault the tree gives them and to
every box they had approved.

An address changes hands in one way: **an org admin releases it**
(`releaseaddress`, with the address). That is for a person who signs in to
GitHub as a different account now, or an address handed on to somebody new.

- The address is nobody's again: no account, no signing keys, and so nothing
  a box takes a signature with. Whoever signs in under it next holds it,
  with whatever the tree gives that address, so a release is the same
  exposure as the first case under "What it does not stop" until they do.
- Every machine the old account approved under that address stops being
  approved, and is given nothing from its next ask. A box files what it is
  handed by the address, so otherwise the next person under it would start
  sessions on the last one's sign-ins. What the old account keeps stays in
  its own vault.
- It is written in the log of every vault the address may open, and of the
  old account's own, as `release` with the address and the admin who did it.
- An org admin's own address is not released while it is one (`is_admin`):
  whoever signed in under it next would administer the organization. A
  request the old account sealed before the release does not take the
  address back (`stale`).

Releasing is done from **the signing page**, on the admin's own vault, under
*Release an address*, which asks once more with what goes. Neither phone has
a screen for it yet. The phones show the log entry as the bare word
`release` until they have words for it.

**Custodians of an agent member.** The admin who files an agent member is its
first custodian. A custodian adds or removes another (`custodian`), and the
last one cannot be removed. Every manager of the member is a custodian too,
for as long as the tree says so: move the member out of their team and their
custody ends with that change, at the minter, at once.

**Removing an agent empties its vault.** Everything it kept and every machine
approved for it is forgotten in the same change, and the answer says how
much. It used to stay "until a custodian forgets it", which could not
happen: nobody is the custodian of a member that is not in the tree, so the
sign-ins were kept, renewed, and handed to whoever filed the same id next. A
new agent filed under an id something was left under starts empty too. A
person's vault is their own and a removal does not touch it.

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
    it gives nothing. Nor does it give back custody an org admin took away
    from somebody nobody had met yet: the removal remembers whose address
    the record was.
  - *Filing a record at an address somebody has not used yet.* When a
    GitHub account that already has a vault files its first key under that
    address, the vault had met them after all, and the custody is dropped at
    that moment. A Claude login kept for runners counts as a vault here: it
    is filed by the GitHub account alone, before any key.
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
vault (`clog:`, the last hundred) where the person reads it, and told to
their phone. Each line names what was changed as the vault itself read it,
never a name the request carried beside it: a sign-in is logged as its
provider, a machine as its fingerprint. A machine a custodian approved says
so for as long as it is approved (`by`, on that machine in `list`), since a
log line can scroll away and the approval does not. The log is the minter's; the push is the coordinator's and can
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

**Later kinds.** A vault item's name still decides its kind (`itemKind`).
`codex` and `copilot`, the sign-ins the engines beside Claude Code run on,
are kept since step 4 ([engines.md](./engines.md), "Credentials"), and
`apikey:<provider>`, the key an engine on a metered API runs on, since
step 7 ([api-engines.md](./api-engines.md), "The key"). Nothing is reserved
ahead of its engine any more, so the list of names held for later and its
"not kept yet" refusal are gone: a name no vault keeps is refused as
unknown.

## Starting as a member

`start` takes `member`. Three places check it, each against what it holds.

**The coordinator refuses first**, in the person's words: the member does not
exist, or the person is neither that person member nor anybody who manages or
holds custody of it. It reads custody from the last key list the minter
signed, which it relays to boxes and can read but not write. It keeps that
list across a restart. A fleet whose minter has never been asked has none,
and the coordinator then cannot tell: it refuses a start as a member by
anybody but an admin, `custody_unknown`, in words that say when to try again,
and passes an admin's on for the box to decide. What a member is seen to
spend is counted from a start the coordinator let through
([budgets.md](./budgets.md)), so it lets through nobody it cannot place.

**The box decides.** The minter's signed key list (`/vault/keys`) now carries
each member and who may start as it: for an agent, its custodians; for a
person, the person, whoever added them, and their other managers once they
allowed custody. A box runs
a member start only when it is **signed or delegated by somebody on that
list**, whatever the box's signature mode: an unsigned actor here would be the
coordinator naming a custodian. Otherwise it refuses, `not_custodian`, saying
who the minter lists.

**A delegation covers a member only by naming it.** A delegation is a standing
permission the coordinator carries ([signed-intents.md](./signed-intents.md),
"Delegations"), and one that named no member used to carry a start as any
member its signer could act for: a grant made to hold one start, or an MCP
client's for a week, let the coordinator alone start a session on an agent's
sign-ins with a task of its own. So a delegation may carry `members`, a list
of member ids signed with the rest of it, and a delegated start that names
`member` is covered only when that list has the id. No list means no member.
The coordinator does not carry a delegation that lacks the member, and a box
handed one anyway refuses, `member_not_delegated`, saying which members the
grant does name and that it is made again from the phone, under You →
Delegations, with the member among them. The task and the session's name are
held to the grant's `match` as before. A request the person signs on their own
phone needs none of this: the member is in what they signed.

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

**Nobody is filed at that domain.** A box runs a person member's session as
their address, so a person record at `debbie@members.invalid` was a session
on Debbie's sign-ins for whoever filed it, with no custody of Debbie at all.
The minter refuses the domain for every address it takes (a person's, a
manager's, a custodian's, an org admin's), and a box drops such a record
from a list a minter older than that rule signs.

**A member's session is not pushed to the starter's archive.** That push is
made with the starter's own GitHub sign-in on the box, and a box holding the
member's vault need not hold theirs. A branch for the work is a task's
([tasks.md](./tasks.md)).

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

- **An address nobody has signed in under is whoever's the coordinator says
  first.** The tree names people by address, and it may name one before that
  person has ever signed in: a manager above an agent, an extra manager an
  admin wrote in, a person member somebody added. The vault binds an address
  to a GitHub account when that account lists its first signing key, and
  until then all it knows of who is signing in is the address the
  coordinator vouches for. So a coordinator that lies about who is signing
  in can claim an address nobody has signed in under yet, for a GitHub
  account of its own, and hold whatever custody the tree gives that address:
  an agent's vault it is above, a box approved for it, a session started as
  it. The same holds for an address an org admin has released, until its new
  person signs in. What it cannot do is claim an address somebody has
  already signed in under: that one is its first account's for good, keys
  listed or not. Nor can it make itself a custodian by name, since adding a
  custodian or an org admin is refused until that address is bound. What
  would close it is an org admin confirming a person's first sign-in while
  being shown which GitHub account it is, which needs a screen on both
  phones and is not built. Until then: have people sign in before the tree
  gives their address anything, and read a member's custodians as addresses
  that are only as good as their first sign-in.
- **The first org admin is first use.** A coordinator compromised before any
  admin filed the tree could vouch for an account of its own. That account
  could then file agent members and hold their empty vaults. It reaches the
  vault of nobody who was already there, which needs that person's own
  switch; somebody it adds itself is the last case here but one. The real
  admin sees somebody else listed as the org's admin.
- **A member's instructions are the coordinator's word.** A compromised
  coordinator can change what a member's session is told at its start. It
  cannot start one, or change the task, without a custodian's signature, or
  a delegation of theirs that names that member.
- **A delegation that names a member is a standing start as it.** While it
  lasts, the coordinator can start that member as often as it likes, with
  any task the grant's `match` leaves open. An MCP client's grant matches
  nothing, so it leaves the task open: that is what lets an agent hand work
  to a member, and it is why the grant lists members one by one and runs out
  in a day or a week.
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
