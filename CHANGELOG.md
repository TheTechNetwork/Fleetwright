# Changelog

**Written for the people who install this, not generated from commit
subjects.** A tester reads "What to Test" on a phone; a `feat(mcp): add profile
param` list tells them nothing they can act on. The commit bodies in `git log`
are where the reasoning lives and they are far too long for a release note —
these are the two or three sentences somebody needs before opening the app.

The top section is the version the apps are built at, and
`test/version.test.js` refuses a release where those disagree.
`scripts/release-notes.mjs` reads this file, so what is written here is what
reaches TestFlight, Play and the GitHub release.

## 0.3.1 — 2026-09-29

**What the first apt-installed boxes found, fixed.**

- **A session runs as the person who started it, on every box.** A host
  without sandboxing used the box's own Claude login, and a fresh apt box has
  none — so the account you linked from the app was ignored and the session
  opened on Claude's first-run wizard with nobody at the terminal. A direct
  session now gets the linked account the way a sandboxed one always has.
  `fleetwright doctor` asks whether anybody has linked an account, not whether
  the box is logged in.
- **Sessions on an apt box no longer start with a hook error.** The
  SessionStart hook could not find node, because the package keeps its Node
  out of the shell's path on purpose. The hook now names that node, and an
  installed hook is rewritten on upgrade.
- **The coordinator address can be typed without `https://`**, in the
  package's install questions as well as in `fleetwright join`.
- **`join` with a pin enrols on a box without systemd**, such as a container,
  instead of writing the address and dropping the pin.
- **Re-running the installer no longer tries to rebuild a sandbox image it
  already has.**

## 0.3.0 — 2026-09-29

**The product is Fleetwright now, everywhere, and a box installs from apt.**

This project started as a spin-off of agent-hub and kept the name in its
services, its directories and its command. Everything is named Fleetwright:
the command is `fleetwright` (`fw` for short), the units are
`fleetwright.service` and `fleetwright-sidecar.service`, the directories are
`/opt/fleetwright` and the env files `/etc/fleetwright.env` and
`/etc/fleetwright-sidecar.env`. **A box on the old names moves
itself over on its next install or update**, keeping its host key, its
enrolment and its sessions — the coordinator sees the same host it always
did. The old commands and unit names keep working as aliases, so a script or a
habit that says `agent-hub` is not broken by this.

**Installing a host is three lines.** Deploy the coordinator, then on the box:

    sudo apt install fleetwright
    sudo fleetwright join fleet.example.com

The package carries its own Node, kept current by the same dependency updates
as everything else, so a bare Debian or Ubuntu machine needs nothing first.
`join` checks the address answers as a coordinator before it writes anything,
defaults to https, and hands over to the same wizard the one-liner runs, so
the pin is asked for on the terminal you typed into. A box installed from apt
is updated by apt: `/update` says so and offers `apt upgrade` instead of
fetching a release itself, and the channel is pinned to stable. The repository
is `fleet-apt.thetech.network`, signed, and the README has the two lines to
add it. The one-liner still works and is unchanged for a box that has it.

**Also**

- **A packaged update reverts itself if the new release does not come up.** A
  watchdog outside the process waits for the updated host to confirm it is
  running; if it never does, the previous release is switched back to and the
  failed one is quarantined rather than deleted, so an update can no longer
  strand a machine nobody can reach.
- **A release-installed box refreshes its session image on `/update` too.**
  The image is published separately from the release and used to be pulled
  only on checkouts, so a packaged box could report "up to date" while running
  session bytes from weeks earlier.
- **A protocol bump no longer deadlocks a fleet.** A host held back by protocol
  is offered the newest release it can run, and a fleet stranded on the rolling
  channel has a button to bring it back.
- **The credentials screen says what the host found.** After connecting a
  provider it reads the refreshed answer: connected says so, and a connect that
  stored nothing says that, instead of "Checked with GitHub" above a row
  reading "not connected".
- **Anonymous enrolment is confined to the coordinator's own loopback**, and
  nine hardening recommendations from a review were checked against the code
  and applied.
- **Both phones record a masked session replay, only when something broke**,
  so a crash report shows what led to it without showing what was on screen.

## 0.2.3 — 2026-09-05

**For operators, and it matters if you have a box on v0.2.2.**

v0.2.2's installer could not run from inside a release. The lay-out block read
`$CHECK_ONLY` before the argument loop assigned it, which is fatal under
`set -u` — and it only ever evaluated on a packaged box, so no install from a
checkout could reach it. The first machine to convert itself found it in four
seconds:

    running the installer from the release
    install.sh: line 62: CHECK_ONLY: unbound variable

Nothing was damaged by it: the release is laid out beside what is running and
the units are only re-pointed at the very end, so a box that hit this stayed on
the code it was already running. **Converting a box needs this release** — the
installer that runs during a migration is the one inside the release, so the fix
had to ship in one.

**Also**

- **Moving a box onto packaged releases is offered by the installer**, rather
  than being a capability nothing called. Re-run the one-liner and it asks — yes
  by default on a fresh box, **no** on one that is already running, because it
  restarts the services. `--from-source` keeps the checkout for a machine you
  edit.
- **A half-finished migration resumes.** It used to see the release directory a
  failed attempt left behind and answer "already on the packaged layout —
  nothing to do", which is indistinguishable from success and left the box
  exactly as it was.
- **A release is checked before it is switched to.** Its installer has to start,
  or the migration refuses and says so without moving anything — the sha256
  proves the tarball is the right one, not that what is in it runs.
- **A session that fails to start says what it printed.** It used to end with
  `tmux attach -t <name>`, which is a remedy only a shell can apply. The last
  lines of the session's own output are in the message now, with buttons for the
  rest.

## 0.2.2 — 2026-09-04

**Two things you can now do from your phone that used to need a terminal on the
machine, and a fix every operator should read.**

**In the apps**

- **Choose which releases a machine installs.** A picker on the host row:
  `stable` takes published releases, `rolling` takes the newest build as it is
  merged. It installs nothing by itself — it decides what the next update is
  allowed to be. A machine whose channel is set in its own configuration shows
  the answer and says it cannot be changed from here.
- **Readmit a revoked host, or replace a host's key, from the host row** —
  swipe on iOS, a button on Android. Both were deliberately refused for an
  unbound pin, and both refusals named a remedy that until now only a shell
  could apply.
- **A packaged machine can see its own updates.** It reported "cannot tell" for
  as long as the packaging existed, because the check counted git commits and a
  release has none. Both apps now show what a machine found waiting for it.

**For operators**

v0.2.1 published the first host package this project has ever released — and
its manifest said `"protocol": 2` for code that speaks v3. The builder read that
number from an environment variable nothing set, falling back to a literal that
was correct the day it was written.

That is the dangerous direction: a v2 host reading it sees its own number,
concludes the release matches, installs v3 code and strands itself from its
coordinator — the exact failure the field exists to prevent, caused by the
field. **The number now comes from the protocol itself**, so it cannot drift
again, and `v0.2.1`'s host package should not be installed.

The installer now records where a machine's releases come from, derived from
the repository it was installed out of — so a fork's boxes take the fork's.
Existing boxes pick this up on `install.sh --upgrade`, without which they keep
reporting that they do not know where to look.

**Also**

- **`install.sh --upgrade`** brings an already-enrolled box onto new code with
  no questions, restarts the services, and tells you whether its protocol still
  matches the coordinator's. An unattended install used to put new code on disk
  and leave the old code running.
- **Nothing is destroyed before the install is known to be possible.** A box
  could be taken apart — services stopped, identity deleted — and then refused
  at the Node version. It refuses first now.
- **`curl .../prereq | sudo sh`** installs a new-enough Node with nvm, into the
  run user's home. Separate on purpose: changing how a machine gets software is
  not a thing an installer does on your behalf. Nothing system-wide, and
  `rm -rf ~/.nvm` undoes it.
- **`curl .../install | sudo sh` carries the fleet's address**, so the installer
  no longer asks which coordinator to join — you said it by typing the URL.
- **The installer no longer refuses a box that already had the right Node.** It
  took the first `node` on `PATH`, which on Debian is the distribution's 20, and
  never looked at the newer one nvm had put in the run user's home. Clean hosts
  worked; the boxes most likely to be upgraded did not.
- **An upgrade that fails now says which package broke.** It reported whatever
  came last, which was usually debconf recovering — the tidying after the
  error, quoted as the error. `install.sh --repair` re-runs the parts of an
  install that are safe to repeat, for a box left half-configured.
- **The admin token is optional.** A coordinator with sign-in configured and no
  `AGENT_FLEET_API_TOKEN` is not an open one; what it still refuses to run
  without is *any* way in at all. Most forks need never set one.
- **A release can go out to a fraction of the fleet.** `RELEASE_ROLLOUT` is a
  repository variable, so widening one is a setting rather than a commit, and
  each host's position is stable across versions in a way that does not put the
  same boxes first every time.
- **The docs were swept against the code**, end to end: what shipped now says
  so, and what did not still says that. Start at `docs/coordinator-deploy.md`
  if you are standing up a coordinator of your own — there is a Deploy to
  Cloudflare button now, and it asks for what it needs up front.

## 0.2.1 — 2026-09-02

**Sessions can be given a task.** Starting a session used to open an empty
prompt: correct, and never what anybody expected from a button labelled Start.
Both apps now offer a **Task** picker on the start sheet, and a session started
with one comes up already working on it. Pick nothing and it starts idle — and
now says so out loud instead of leaving you to find out.

A task is a **profile**: a file on the machine that runs the session. The app
sends its name and never its words, so what a session is told to do is chosen
on the box rather than over the network.

Three profiles ship on every host, ready to run:

- **Bootstrap a `renovate-config` repository** — a shared Renovate preset, with
  the one line other repositories need to extend it.
- **Bootstrap a `.github` repository** — the org-wide issue forms, PR template,
  `CONTRIBUTING` and `SECURITY` that GitHub actually inherits.
- **Bootstrap a `.claude` repository** — shared skills, agents and commands.

Each one asks which account or organisation to create under rather than
guessing, and reports back with the URL.

**Also in this release**

- A **session kind** can carry a task and a host, so "start an orgi session"
  spoken to Siri or Assistant does the whole thing. On Android a kind could not
  name a host at all before this; now it can.
- The **demo fleet and the product page** moved to their own Cloudflare Worker,
  away from the coordinator that holds real sessions.
- **`fleetdemo.thetech.network/docs`** is a page you can send somebody, and the
  README has a Deploy to Cloudflare button.
- **Push notifications are encrypted end to end.** The session name and the
  question in a notification are readable by your phone and by nothing in
  between — not by Apple, not by Google, not by us. Takes effect once the apps
  ship their half; until then nothing changes.

**For operators:** this is **protocol v3**. Update your hosts *before* the
coordinator — a v3 host and a v2 coordinator refuse each other by name, so the
window is loud rather than subtly wrong. `agent-fleet update --restart` from
the app does it without a shell. Profiles live in
`/var/lib/agent-hub/profiles/<name>.md`; adding one needs a shell on that box,
which is the point.

## 0.2.0

The first release with this file. Earlier history is in `git log` and in
`docs/`, which is where the reasoning has always lived.
