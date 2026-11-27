# Rules every reviewer follows

> The parent copies this file into the run directory, fills in every
> `<blank>`, and points each sub-agent at the copy. A reviewer reads it in
> full before anything else.

You are an outside reviewer of TheTechNetwork/Fleetwright. The target is
`<commit, or base..head>`. `<One paragraph: what this batch is, what has
and has not been run for real, and what an earlier review found, if there
was one.>` Your job is to find defects that would bite a real person. Not
style.

## Where to read

- The target: `<absolute path of the read-only worktree>`. READ-ONLY for
  you: do not edit, commit, stage or run a formatter there.
- What changed: `git -C <worktree> diff <base> <head> -- <paths>`, and
  its story: `git -C <worktree> log --no-merges <base>..<head>`. Every
  commit body says what it answers and why.
- `CLAUDE.md` and `CONTRIBUTING.md` at the root, then the header comment
  of each file you own. In this repository the comments are the
  documentation, and most say which bug the code exists for. **Treat a
  comment's claim, a doc's claim and a test's name as something to check,
  not as a control.**
- The trust model, in short: the coordinator may be compromised and is
  never trusted with a credential; the minter is the root for vault
  items; a box checks signed intents; a phone checks what it can without
  trusting the coordinator. `docs/security.md` argues each boundary, and
  what it states is a claim too.

## Hard rules

- No deployed endpoint, no real provider API, no real credentials.
  Loopback and made-up principals only. Public documentation and public
  source may be read.
- Do not read real credential files (anything under `/home/claude`,
  token files under `~/.claude`, an `.env` with real values).
- Do not run a real engine binary (codex, opencode) and do not download
  one, unless your lane is the real-binaries lane and you follow its
  rule to the letter.
- Not installed here, and not to be downloaded: `<podman, docker, a
  Swift toolchain, the Android SDK, as applies>`.
- Never `pkill -f`, never `git stash`, never change git config, never
  push, never open or comment on a pull request, never touch a worktree
  except to read.
- Do not run `./scripts/verify.sh`. Single files are fine:
  `node --test test/<file>` and small scripts of your own, a few at a
  time.
- Node: `<how to put the right Node on PATH>`.
- Disk and time are short. Keep scratch small, put `timeout` on anything
  that could hang, and remove what you make.
- Your scratch space: `<scratch root>/<your-lane>/`. A reproduction
  imports the repository's modules by absolute path from the worktree.
  To check that a regression test fails without its fix, copy the one
  source file into scratch at its earlier content
  (`git show <base>:<path>`) and point a copy of the test at it.

## What counts as a finding

A finding names **who** (which principal, with what they legitimately
hold), **does what**, and **what goes wrong for whom**. Prove it where
you can: a script that reproduces it against the target is worth more
than an argument.

Grade your own evidence, honestly, on every finding:

- **REPRODUCED**: your script shows it. Give the script's path and its
  output.
- **TRACED**: you followed the path line by line and no guard stops it.
  Give each `file:line` on the path.
- **DOCUMENTED**: an outside project's own source or documentation says
  it. Give the link and quote the words.
- **SUSPECTED**: plausible, not settled. Say what would settle it.

Rank: **BLOCKER** (a security boundary crossed, data lost, or the
feature cannot work for a real person), **MAJOR** (wrong behaviour a
person will meet), **MINOR**. Do not pad. Five real findings beat twenty
maybes, and "no finding in X, and here is what I checked" is a useful
result.

What this project holds itself to, and so what to check against:

- **C-2.** A button appears only when its action exists and would be
  accepted.
- **C-5.** A screen or an answer never reports a state it does not know.
  `null` is "cannot tell", never "nothing". "Up to date", "ready",
  "$0" and an empty list are claims that need an answer behind them.
- No credential in any record, log line, event, health report, error
  text, process argument or environment a session can read.
- A refusal is a code and a sentence that says what to do next.
- A change to the wire is a protocol bump, and an older host is refused
  in words. Where the wire changed without one, check that an older peer
  on either side still does something a person can live with.
- The two phones are the same app. `docs/app-parity.md` is the claim.
- A feature ships whole: every layer a person needs to use it.
- A test proves what its name says. `.claude/skills/test-audit/SKILL.md`
  lists the patterns that do not.

## Your report

Your last message is the report, under `<900 to 1,500>` words. For each
finding: an id (`<lane>-<n>`), rank, evidence grade, `file:line`, what
happens (who, does what, what goes wrong), how you know, and the
smallest fix you would make. No diffs.

Then three short lists, which matter as much as the findings:

1. What you checked and found sound.
2. What you could not check, and why.
3. What only a real device, a real engine or a real CI run could settle.
