# The runner repository

**This directory is not run from here.** It is the contents of a *separate*
repository — the one a fleet dispatches into when somebody asks for a temporary
machine. Copy it there; keep it here so there is one place it is written and
one place it is checked.

The design and the reasoning are in [`docs/runner-central.md`](../../docs/runner-central.md).
This file is the setup, in order.

```
.github/workflows/runner-macos.yml      macos-26
.github/workflows/runner-linux.yml      ubuntu-26.04
.github/workflows/runner-windows.yml    windows-2025 — NOT PROVEN, see below
.github/workflows/runner-android.yml    ubuntu-26.04 + SDK + KVM
.github/actions/fleet-host/action.yml   everything the first, second and fourth share
```

The file names are load-bearing: `src/core/runners.js` maps a platform to one of
them, so `runner-macos.yml` is what `provision { platform: 'macos' }` dispatches.
Renaming one means editing that map.

## 1. Make the repository, and make it public

Public is not a detail here — it is most of why runners are worth having.
Actions minutes on standard runners are free for public repositories and
metered for private ones, so a private runner repository turns "ask for a Linux
box" into a line item.

**What being public costs, precisely.** Run logs are world-readable, which
includes the workflow inputs: the dispatch `ticket`, masked, and the coordinator
URL, which is not secret — it is in every install one-liner. It does **not**
include the secrets below, which GitHub does not expose to a run it cannot
attribute, and it does not include anything a session does, because a session
runs on the machine and reports to the fleet rather than to the run log.

**What being public does not cost.** It is not a way in. A fork's jobs carry
their own `repository` claim in the OIDC token and are not on the fleet's
allowlist, so a fork cannot enrol a machine into your fleet however it edits
these files.

## 2. Two secrets, in Settings → Secrets and variables → Actions

| secret | needed | what it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | **yes**, unless everybody deposits a login | what sessions on a runner authenticate with. There is nobody on a runner to complete a login, so this is the credential the design settled on — revocable on its own, billed separately, and not somebody's Claude account. A person who [deposited their own Claude login](../../docs/runner-central.md#your-claude-login-on-a-runner) gets their sessions on runners they started run on that instead. Without either, a runner joins the fleet and cannot start a single session |
| `FLEETWRIGHT_RUNNER_TOKEN` | only for runs you start by hand | says whose runner a manually started run is. Mint it in the app under Hosts → Runner tokens. A run the fleet dispatches carries its own single-use ticket and ignores this |

Neither of them admits a machine to a fleet. That is GitHub's own job token,
which cannot be stored and cannot leave the job that asked for it.

## What a runner can reach

**Public code, and private code one repository at a time — when the fleet holds
a GitHub App key to mint with.** A runner's own credential store is empty: connections are per
person and live on the box they were made on, and the job's `GITHUB_TOKEN` reads
this repository and nothing else. So when a session's git fetches a private
repository, the runner asks the fleet, and the fleet's minting Worker — a
separate Worker holding the Fleetwright GitHub App key — mints a token for
**that repository**, for **an hour**, for **whoever started this runner**, no
wider than GitHub says their account reaches. The workflows here already point
git at it; nothing in this repository changes.

What it takes is on the fleet's side, not this one: the App key as the
`FLEETWRIGHT_GITHUB_APP_KEY` secret of the Fleetwright repository's
`github-app-key` environment, synced to the minting Worker by a run somebody
approves, and `FLEETWRIGHT_GITHUB_MINT_OWNERS` as a repository variable, which
the deploy hands to it. No permanent box is needed. See
[`docs/runner-central.md`](../../docs/runner-central.md#private-code-on-a-runner)
for what bounds the token and why the coordinator cannot read it.

Without a minting key anywhere a session here reaches public code, as runners
always did. `runner-windows.yml` gets no repository tokens yet, and no runner carries
anybody's Claude login or Cloudflare connection — sessions bill to
`ANTHROPIC_API_KEY` above.

## 3. Three settings on the coordinator

```
FLEETWRIGHT_RUNNER_REPO       you/your-runners
FLEETWRIGHT_ACTIONS_REPOS     you/your-runners
FLEETWRIGHT_ACTIONS_WORKFLOW  you/your-runners/.github/workflows/runner-macos.yml@,
                              you/your-runners/.github/workflows/runner-linux.yml@,
                              you/your-runners/.github/workflows/runner-windows.yml@,
                              you/your-runners/.github/workflows/runner-android.yml@
```

- **`FLEETWRIGHT_RUNNER_REPO`** is where `provision` dispatches. Hosts learn it
  on the config frame when they connect, so no box is configured.
- **`FLEETWRIGHT_ACTIONS_REPOS`** is which repositories may enrol a host at all.
  Empty means nobody, deliberately.
- **`FLEETWRIGHT_ACTIONS_WORKFLOW`** pins *which files* in that repository may.
  Without it, any workflow there can admit a machine — including one a pull
  request adds. With one entry only that file can, which is why this is a list:
  four operating systems, four files.

The trailing `@` matters: the claim GitHub puts in the token is
`owner/repo/.github/workflows/x.yml@refs/heads/main`, and the check is a prefix
match, so ending at the `@` pins the file and allows any ref.

## 4. The GitHub App needs one more permission

A dispatch is made with the **asking person's own GitHub connection**, so the
Fleetwright App needs **Actions: Read & write** (it had Read), and each person
who wants runners has to have the runner repository selected in their
installation. Both are screens on github.com; neither is code.

A person whose installation does not include it gets a 404 naming the
repository, which is GitHub declining to admit the repository exists to a token
that cannot see it.

## Or: your own runner repository, with no operator step

Everything above is the FLEET's runner repository, set once by an operator. Any
member can instead point their own runners at a repository of their own, so the
machines they ask for spend their own free minutes:

1. Make a **public** repository and copy this directory into it (step 1).
2. Add the `ANTHROPIC_API_KEY` secret (step 2). `FLEETWRIGHT_RUNNER_TOKEN` is
   only for runs you start by hand, as before.
3. Install the Fleetwright GitHub App on its owner and select the repository,
   with Actions: Read & write (step 4).
4. In the app, under Add a machine, enter it as your runner repository and
   press **Check and save**.

**Nothing on the coordinator changes** — no `FLEETWRIGHT_ACTIONS_REPOS` entry,
no workflow pin. The check runs with your own GitHub connection and names what
is missing if anything is; once it passes, a runner from that repository is
admitted only with the dispatch ticket the fleet minted for you, naming that
repository, for that platform's runner workflow. See
[runner-central.md](../../docs/runner-central.md#your-own-runner-repository).

## 5. Try it

```
fleet_provision { platform: "linux", minutes: 30 }
```

Then `fleet_status` — the runner appears as `gha-<repo>-<run>-<attempt>`, owned
by you, a few minutes later. It is not there immediately and nothing is wrong
when it is not: GitHub has to find hardware, boot it, and install tmux and the
CLI before the host exists.

## Windows is not proven

`runner-windows.yml` is written and has not been shown to work. A session is a
tmux pane, tmux is a POSIX program, and Windows has no tmux — so that workflow
runs the host under MSYS2 and converts paths with `cygpath` for a `node` that
thinks in `C:\`. Every join there is somewhere the two worlds can disagree.

It is written to fail *before* enrolling rather than after, because a runner
that joins a fleet and then cannot start a session is worse than one that never
joined: it gets placed on, accepts work, and loses it. If it fails, the failure
is in the run log and `docs/runner-central.md` records what was tried.
