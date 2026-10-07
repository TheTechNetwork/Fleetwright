# Linked repositories: three roles, one linking flow

> "I think there are multiple parts"

[#346](https://github.com/TheTechNetwork/Fleetwright/issues/346) started as one
feature, "link a repo", and was rewritten when it became clear there were at
least three, wanting different visibility, different credentials and different
warnings. A single "linked repo" field meaning all three is the design that
lets somebody bootstrap a private thing onto a public scratch repository
because the word "scratch" sounded temporary. So every link carries a **role**,
and the role decides what is checked, what is refused and what is said at the
moment of linking.

| role | visibility | what it is for | what a link does |
|---|---|---|---|
| **archive** | **private**, refused otherwise | where a session goes before its container or its machine does | every session you start is pushed there, on a branch of its own, before it stops and every ten minutes while it runs |
| **runners** | **public**, refused otherwise | where your temporary machines start: Actions minutes are free only for a public repository | the runner repository [runner-central.md](./runner-central.md#your-own-runner-repository) already describes, reached from the same list |
| **templates** | either | skills, presets, configs and workflows | stored, checked and shown; a session reads it when asked. Nothing in it runs or is typed into a session by itself ([below](#templates-and-the-bound-that-did-not-move)) |

## Linking one

Both phones have one screen for it, **You › Linked repositories**, with the
three roles in that order and what each one means said above its field. It is
drawn only once the fleet has answered for the person signed in.

```
GET    /api/linked-repos          { links: [{ role, repo, setAt }], fleet: { runners } }
PUT    /api/linked-repos/{role}   { repo: "owner/repo" }  → linked only if the check passes
DELETE /api/linked-repos/{role}
```

**Per person, never per session.** The issue is exact about it: a repository
named per session is a text field on every New session sheet and the
coordinator choosing where somebody's work is written. One link per role per
person, made from a settings screen after a check passes, is a decision the
person made once.

**The check, by role**, asked the way the runner check already was: by the
**minting Worker** as the Fleetwright GitHub App first (`/linked-repo`), and
otherwise by a **permanent box** with the person's own GitHub connection (the
`linkrepo` verb, protocol 11). The answer is data, and null is "cannot tell",
never "no".

| | archive | templates | runners |
|---|---|---|---|
| visibility | private, or refused | either; said which | public, or refused |
| the App reaches it | installed, and the repository given to it | the same | the same, with Actions write |
| its files | Contents **write** | Contents read | — |
| the person | can push (a box can tell; the App cannot, and says so) | — | — |
| also says | — | which of `.claude`, `.github` and a Renovate `default.json` are at its top level | which runner workflows it carries |

**The App answers for a private role only inside
`FLEETWRIGHT_GITHUB_MINT_OWNERS`.** A runner repository is public, so the App
reading it tells nobody anything. An archive is private by definition. "Does
this private repository exist, and does the App reach it" asked of any account
would make the App's key an oracle over every installation of an App anybody
may install. Inside the owners list it is the fleet's own accounts, which the
key already mints into, and outside it a runner could never be minted a token
to push there anyway. So the minter answers "not mine to say" and the
coordinator asks a box, whose answer is bounded by what the person can see.

`runners` is stored where it always was, in the runner repository store that
admission reads. Moving a value the enrolment route trusts into a new shape to
make a list tidier would be a migration with a security property on the other
end of it, so the list shows it and the old store keeps it.

## The archive

The problem it solves was already filed: a stopped session's console goes with
its container ([#314](https://github.com/TheTechNetwork/Fleetwright/issues/314)),
a runner takes its whole workspace with it when the job ends, and the only way
work left either was a person reading `peek` before the clock ran out. A
returning beta tester recovered their output by luck. The archive is the exit
that does not need anybody watching.

### Where it is decided

`start` gained `archive` (protocol 11, `since: 11`): the starter's own archive
link, **set by the coordinator** and removed from anything a caller sent,
exactly as `provision.repo` is. The host keeps it on the session's record, so a
resume keeps the archive it started with, and unlinking changes the sessions
started afterwards and not the ones running.

A host older than 11 is not handed it. Losing it costs a copy of the session,
not the session, so unlike a `task` the start is not refused; its reply says
the session **will not be archived**, as data (`archived: false`) and in a
sentence, so nobody assumes a push that will not happen.

### What a push holds

One commit, on `fleetwright/<host>/<session>-<when it started>`:

| file | what | when it is missing |
|---|---|---|
| `README.md` | what this is, what is in it and what is not, and why | never |
| `session.json` | name, title, brief, host, who started it, when, and why this push | never |
| `pane.txt` | the console's scrollback, the part #314 is about | the session was not running |
| `transcript.jsonl` | the conversation | on a sandboxed box: it is in the session's own volume beside its Claude credential, which nothing here mounts, and `resume` reads it there anyway. A runner's is archived |
| `workspace.patch` | what changed in the workspace, as a binary patch: against `HEAD` for a checkout, every file for a directory that is not one | over 6MB: left out and said to be, never cut, because half a patch does not apply |

`git apply workspace.patch` in a checkout of the same commit puts the
workspace back. The patch is made **without writing into the session's
repository**: untracked files are diffed against `/dev/null` with
`--no-index`, and the tracked diff runs against a copy of the index, because a
diff refreshes the index it reads. On a sandboxed box it runs in a container
over the work volume, read-only, with no network, the way the file browser
does.

### When

| | why |
|---|---|
| before `stop`, `forget` and `purge` | the container is about to go. The stop waits up to 150 seconds for the push and goes ahead whatever it says; the reply carries both |
| every ten minutes while it runs | a runner is killed when its job ends and nothing gets to run first; a checkpoint ten minutes old is the bound on what it can take with it. A checkpoint that would commit the tree the branch already holds commits nothing |
| when a runner's hub is told to stop | best effort, for twenty seconds, before the job takes the machine. A permanent box's sessions outlive a hub restart, so it pushes nothing then |
| `/archive <name>` on the box | now |

Each session's page on both phones says where it is archived and how the last
push went, in the host's sentence, and before the first push says that nothing
has been pushed yet.

### As whom, and only where

**Pushed as the person who started the session**, with their own credential and
nothing wider: on a permanent box their GitHub connection there; on a runner a
one-repository, one-hour token minted for its owner through the runner's
broker ([runner-central.md, "Private code on a runner"](./runner-central.md#private-code-on-a-runner)),
with contents write only if GitHub says they can push. Never the box's own
row. So an archive lands only where its owner could already push.

**Only somewhere private, asked at the moment of the push.** The repository
name reached the host from the coordinator, which this project treats as
compromised. So the first thing a push does is ask GitHub, with the owner's own
credential, whether the repository is private, and refuse a public one
whatever the link said when it was made. A repository made public after it was
linked stops being written to.

**Through GitHub's API, not `git push`**: a blob per file, a tree, a commit
whose parent is the branch's last one, and the branch moved to it, never
forced. Four kinds of request a box can make with nothing installed but the
hub, no clone of a repository that only grows, and no credential on a command
line. An empty repository refuses blobs, so it is given one commit first, a
README on its default branch saying what the branches are.

### What it cannot do

- **A runner on an owner outside `FLEETWRIGHT_GITHUB_MINT_OWNERS`** has no token
  to push with, for the same reason it cannot clone private code there. The
  push says so on the session's page; on a permanent box with the person's
  connection it works.
- **A runner killed hard** loses what happened since its last checkpoint, at
  most ten minutes. GitHub gives a cancelled job's steps a few seconds and a
  job that ran out of time none.
- **A workspace over 6MB of changes** is not in the archive. The console and
  the record still are.
- **What is in the workspace goes into the archive**, a `.env` included. It is
  the person's own private repository, which is why private is the one thing
  the role refuses to compromise on.
- **Windows runners**, which have no repository tokens yet
  ([runner-central.md](./runner-central.md#what-this-does-not-solve)).

## Templates, and the bound that did not move

The three bootstrap profiles shipped in v3 (`renovate-config`, `.github`,
`.claude`) *create* exactly these repositories, and linking one is the other
half: a session that can read it can adopt a preset, install a skill or reuse
a workflow without anybody pasting anything.

The issue names the security question, and it has to be argued rather than
assumed: profiles taken from a linked repository would move the bound on what a
session is told to do from "somebody with a shell on the box" to "somebody with
write access to that repository".

**This round does not move it.** A templates link is stored, checked for
readability and shown, and the files in it are **never** turned into task
profiles, typed into a session, or run. Two things make that the right place to
stop:

- Since protocol 7 the coordinator can already carry a session's first message
  in words (`start.task`). So "start a session that adopts the preset in my
  templates repository" is already expressible, by the person asking, with no
  new bound: what the session reads is what it was asked to read.
- Turning a repository's files into profiles would make every push to it a
  change to what every session started with that profile does. That is a
  reviewed commit rather than an scp'd file, which is not obviously worse, but
  it is a different bound, reaching every box at once, and it deserves its own
  round with its own argument rather than arriving inside a linking screen.

Reading it needs nothing new: on a permanent box a session's git already asks
the credential broker, which answers with the person's own token; on a runner,
the broker mints a one-repository token for it.

## Runners, from the same list

Unchanged, and described in [runner-central.md](./runner-central.md). Its line
on the linking screen says the issue's one warning for it at the point of
linking: **it is world-readable, Actions logs included**, so it is a launcher
and nothing else, and nothing a session makes belongs in it. That is what the
archive is for.

**macOS billing is still unchecked.** The issue asks for somebody to read the
current billing page and put a date on it; nobody has, and nothing here
promises unlimited macOS.
