# The workspace

Browse, read, write, copy and delete files in a session's workspace, from the
apps and from the MCP server.

`ROADMAP.md` has had this as **"wanted — deliberately last"** for as long as it
has existed, with the reason attached: *largest new attack surface in the
product; own design pass.* This is that pass.

## What a workspace actually is

Not a directory on the host. A session gets two **named podman volumes**:

| volume | mounted at | holds |
|---|---|---|
| `work-<session>` | `/work` | the session's files — this feature |
| `claude-<session>` | `~/.claude` | **the Claude credential the session runs as** |

There is no path on the box to `readdir`. So every operation runs a short-lived
container over one volume — the same shape `podman.js` already uses to seed
credentials. That cost buys the confinement: a container mounting exactly one
volume cannot read anything else on the machine.

**The conversation volume is never mounted.** It is a sibling in
`sandboxNames()`, one word away in any edit, and mounting it would hand a file
browser the account. Nothing here takes a volume name as a parameter for that
reason — a caller names a *session* and the code derives the rest.

## Three bounds, deliberately redundant

The interesting failures are the ones where one check was assumed to cover
another, so none of these is load-bearing alone:

1. **The path is validated in JS** before a container starts. Absolute paths,
   `..` segments, null bytes and anything over 512 characters are refused, and
   the refusal says which.
2. **The container re-derives it** with `realpath -m` and refuses anything not
   under `/work`. This is the layer that catches a **symlink** — a link inside
   the workspace pointing at `/etc` has no `..` in it and is not absolute, so
   textual validation cannot see it and does not have to.
3. **Reads mount `:ro`.** A read path that somehow found a way to write would be
   writing to a read-only mount.

Plus two more that are not about paths:

- **`--network none`.** A file browser has no reason to dial out, and one that
  cannot dial out cannot send anywhere what it has just read.
- **The path is an argument, never interpolated.** A filename containing `;` or
  `$(...)` is a filename. The only way to keep it one is never to build a
  command string out of it — so the script takes `"$1"` and the content arrives
  on **stdin**.

## Bounds a phone depends on

| | limit | why |
|---|---|---|
| read | 256KB | "read a file" must not mean the 8GB core dump a crashed session left |
| write | 256KB | same number, same reason |
| listing | 500 entries | a phone asking "what is in here" must not be handed `node_modules` |
| any operation | 10s | a stuck podman must not hold a request open to the coordinator's own timeout |

Binary files are refused rather than returned: a caller asking for a JPEG asked
the wrong question, and answering with bytes that reprogram their terminal is
not a better answer.

## Five verbs, not one with an `op`

`files`, `readfile`, `writefile`, `copyfile`, `deletefile`. A single verb taking
`op=list|read|write|delete` would be a remote procedure call in an intent's
clothes: the scheduler could not tell a read from a delete, `mutating` would
have to be wrong on one side or the other, and the MCP server could not withhold
the destructive half — which it does, by default.

**`content` is `raw`, not `text`.** Every other prose parameter goes through
`cleanText`, which collapses runs of whitespace and strips control characters.
Right for a title; catastrophic for a file, which would come back reindented and
with its blank lines joined, reported as written.

**Adding these cost no version bump.** They are new verbs, and an old host
answers `unknown_verb` — a named refusal that strands nothing. It is adding a
*parameter* to an existing verb that is a flag day.

## What is deliberately absent

- **`deletefile .`** — refused. That empties a session's work with one tap and
  no undo. `forget` does that, keeps it for seven days, and can be undone.
- **A recursive listing.** Depth is the caller's to spend, one tap at a time.
- **Any path into the host.** `start` still takes no workdir, which is what the
  original "no verb accepts a path" rule was about; that rule is narrowed here,
  not dropped. See `test/intents.test.js`.

## Content rating

ROADMAP notes this "may change the IARC content rating". Nothing here adds
user-generated content that other users can see: a workspace is one person's
files on their own machine, reachable only by someone the fleet has already
authenticated and only for sessions they can see. The questionnaire should be
re-run before the next store submission all the same, because the honest answer
to "can users share content" changed shape even if the answer did not.

## Tested against a real container, which is the point

`test/files.test.js` checks the half that decides whether a container starts.
`test/files-container.test.js` runs the other half — the one where the
confinement actually lives — and **it found two real bugs on its first run that
reading the source did not**:

- **`sort -t'\t'`** reached the shell as two characters, not a tab. `sort`
  refuses that outright: *"multi-character tab"*. Every listing was empty.
- **`podman run -v name:/work` CREATES the volume when it is absent.** So
  reading a session that did not exist did not fail — it silently made a volume,
  under a name the caller chose. A loop over invented session names is unbounded
  volume creation on somebody's disk, from a *read*. Every operation now checks
  the workspace exists first.

## Podman or Docker

**The fleet runs rootless podman, and that is not a preference.**
`docs/hardening.md` is built on it: `NoNewPrivileges` against setuid
`newuidmap`, `ProtectHome` against `~/.local/share/containers`, and a refusal
list including `--userns=host`. Docker's default is a root daemon, where
"escaped the container" and "root on the box" are the same sentence. The sandbox
is the isolation boundary for sessions; trading it for CI convenience would be a
poor bargain.

**But CI has Docker and no Podman**, which is why the container half went
untested. `AGENT_HUB_PODMAN_BIN` was always configurable; what stood in the way
was three podman-only subcommands — `volume exists`, `image exists`,
`container exists`. Docker has none of them. They are `inspect` now, which both
engines have and both answer by exit status, so the same code path runs under
either. That is a portability fix in the CLI calls, not a change of engine.

## Status

Shipped everywhere in one round; what is proven per surface is
[`app-parity.md`](./app-parity.md)'s to say, not this page's.

The apps show a **Files** button on every session, running or stopped — the
workspace volume survives a stop, which is what makes a session resumable, so
"collect what it produced" is mostly a thing you do after the work has
finished.

Two choices worth knowing. **Save is offered only when the text differs from
what was read**, so a file opened and closed is never rewritten: that would move
its mtime and show up in a repository as a modification nobody made. And a **new
file is created empty, then opened** — the failure that matters is a name the
host refuses, and it should happen before somebody has typed a page into it.

A copy's destination is relative to the **workspace root**, not to the directory
being browsed, and both dialogs say so. Guessing wrong puts somebody's file one
directory off and the host cannot know which they meant.

Neither app validates a path, deliberately, and both say so where somebody
editing them will read it. The host confines it three times and is the only
thing that can — a symlink is invisible from a phone.
