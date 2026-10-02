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

## 0.4.4 — 2026-10-02

**Temporary machines come from your own GitHub repository, and your phone can
start one with no permanent box. Your GitHub, Cloudflare and Claude sign-ins
and your secrets are kept once, in a vault, for every box you approve.**

- **Start machines from your phone.** Under Settings, Runners from this phone,
  save the minter key whoever runs your fleet gave you and sign in to GitHub.
  The phone then asks GitHub for machines itself, so no permanent box has to
  be online. `fleetwright-mcp` on a computer does the same when it can find a
  GitHub token.
- **Your vault.** In the same place, keep GitHub and Cloudflare by signing in,
  add named secrets, and approve your boxes. Approve a box only when the
  fingerprint the phone shows matches what `fleetwright-sidecar identity`
  prints on it. An approved box gets what is kept within ten minutes, and
  loses it within ten minutes of being removed. Anything linked on a box
  itself still wins.
- **Runners on your Claude subscription.** Paste a token from
  `claude setup-token` on the phone, or deposit one with
  `fleetwright-claude-login`, and the runners you start use your subscription
  instead of the runner repository's API key.

- **Your own runner repository.** Under Add a machine, enter a public
  repository with the runner workflows in it and press **Check and save**. The
  check shows what it found (public, GitHub app installed, Actions write, which
  machines) and saves only when everything passes. The machines you ask for
  then run on that repository's free Actions minutes, and no operator step is
  needed.
- **A session on a new machine.** New session's Where row offers a new Linux,
  macOS or Android machine. The fleet asks GitHub for it and starts the
  session once it has joined, which takes a few minutes.
- **Private code on a runner.** With the GitHub App key set up on the fleet
  (see `docs/github-app.md`), a runner's git gets a token for the one
  repository it is fetching, for one hour. Without it, runners reach public
  code as before.
- **Context and account usage.** Each session shows how full its context
  window is. Each linked Claude account shows what it has left in its current
  windows, as one figure per account however many boxes it is linked on.
- **The sidecar has its own hub token**, limited to the commands it sends.
  The next `--upgrade` moves it off the operator's token.
- **Fixes.** A checkout box restarts on new code after an update instead of
  running the old code until someone restarts it. `/identity` and `/enroll` say
  which account to run them as rather than suggesting a reinstall. A runner
  started with an API key no longer stops at the CLI's question about using
  it, nor at the Bypass Permissions warning. A Claude account linked to a
  runner is used instead of the repository's API key. The macOS installer no
  longer fails to reload a daemon it has just stopped. The macOS host is now
  installed for real on a GitHub runner in CI.

Hosts speak protocol 6. An older box keeps working, but cannot check a runner
repository or dispatch to one, and says so rather than failing. It gets
nothing from the vault until it is upgraded.

For whoever runs the fleet: phone sign-in, the vault and Claude logins on
runners need the minting Worker's secrets. Run the Worker workflow by hand on
`main` with **sync_app_key** ticked (`docs/vault.md`).

## 0.4.3 — 2026-09-29

**One fix: a grant now changes the recorded answer.**

- **`sudo fleetwright grant reboot on` takes effect.** On 0.4.2 it wrote the
  sudoers rule and restarted the hub, but left `FLEETWRIGHT_SYSTEM_REBOOT=0`
  in `/etc/fleetwright.env`, so the hub came back refusing the reboot the rule
  allowed. The installer recorded the answer with the writer that only fills
  an empty value, which is right for a pasted token and wrong for a decision
  being changed. A grant now overwrites the recorded answer, on and off, and a
  box that recorded 1 can have it withdrawn the same way.

## 0.4.2 — 2026-09-29

**Two fixes from the first real run of 0.4.1 on a Pi.**

- **Check for updates asks apt now, not as of this morning.** On a box apt
  owns, Check read apt's answer before refreshing the package lists, and only
  refreshed them at all when they were more than six hours old — a limit meant
  for the sidecar's own poll, not for a thumb on a button. A box on 0.4.0 went
  on saying 0.4.0 was the newest in apt for hours after 0.4.1 was published.
  Check now fetches the lists first, every time it is pressed, with a minute
  between fetches so a double tap does not run apt twice. The sidecar's
  fifteen-minute poll keeps its rate limit.
- **`sudo fleetwright grant reboot on` works.** On 0.4.1 it stopped at
  "NODE_BIN: unbound variable" and changed nothing: the grant runs before the
  installer finds its node, and recording the answer needs one. It finds it
  first now.

## 0.4.1 — 2026-09-29

**The sidecar runs as its own account, a box tells the app what it allows, and
updating Fleetwright no longer means upgrading the operating system.**

- **Apply update and Apply system upgrade are two doors.** Apply update now
  installs the `fleetwright` package alone; Apply system upgrade takes
  everything else and holds `fleetwright` while it runs, so neither can move
  the other by accident. The OS count leaves the package out, so one release is
  reported once and "Nothing to upgrade" is true when only Fleetwright is
  waiting. A box still on the old grant is refused once and told the two ways
  out; this release's install repairs the grant, so that happens at most once.
- **A grant is one line on the box.** `sudo fleetwright grant reboot on` (or
  `reboot off`, `upgrades on`, `upgrades off`) replaces the four-step recipe
  the refusal used to print; `sudo fleetwright grant` alone says what this box
  allows. A deb install asks the same two questions through debconf, and
  `sudo dpkg-reconfigure fleetwright` asks them again. Both apps now show
  "Allowed from the app" per box and draw Reboot and Apply system upgrade only
  where the box would not refuse them; where it would, the line to type is
  there instead, copyable. A box too old to say keeps its buttons.
- **The sidecar runs as its own account.** The installer creates
  `fleetwright-sidecar`, a system account with no login, and the sidecar's
  service runs as it; sessions keep running as the user they always did. The
  process holding the coordinator connection can no longer read anybody's
  Claude or provider credentials, and the process running sessions can no
  longer read the box's fleet identity. On a packaged box this happens on the
  next update, once: the key directory and `/etc/fleetwright-sidecar.env`
  change owner. A box installed from a checkout keeps the old shape until
  somebody runs `sudo install/install.sh` again. `enrol`, `identity` and
  `doctor` now run as that account: `sudo -u fleetwright-sidecar fleetwright-sidecar doctor`.
  Still true, and written down: the sidecar holds the hub token, so this stops
  it *reading* credentials, not writing one.
- **A host behind a NAT that dies is noticed.** The sidecar sends a heartbeat
  every twenty seconds and drops a connection that stays silent, then
  reconnects; on Cloudflare the coordinator answers without waking anything.
  Before this a host whose connection had gone dead behind a router looked
  online until somebody tried it. The sidecar also dials with Node's own
  WebSocket now; nothing changes on the wire.
- **Under the hood.** The per-session hook sockets live under
  `/run/fleetwright`, the hub's own runtime directory, rather than the
  sidecar's; a box that set `FLEETWRIGHT_SANDBOX_HOOK_SOCKET_DIR` keeps its
  path. The two beta reports are kept in `docs/` rather than on branches nobody
  merged, and contributors get a test-audit skill beside the review one.

## 0.4.0 — 2026-09-29

**A pin comes with the one line that installs the box, and no box runs its own
coordinator any more.**

- **Install and join in one line.** Every pin the app mints now comes with the
  command that spends it: `curl -fsSL https://<your fleet>/install | sudo FLEETWRIGHT_ENROL_PIN=123456 sh`.
  Paste it on a fresh box and it installs, enrols and starts with nobody at the
  keyboard; the pin rides as an environment variable, never in the URL, so it
  is in no request log. Both apps show the line beside the code, with a copy
  button.
- **The coordinator runs on Cloudflare, and nowhere else.** The installer no
  longer asks whether to run one on this box, and the command that did is
  gone. A box that ran its own finds that unit retired on its next update and
  is told, in the installer's output, where the fleet meets now. For whoever
  will not have a Cloudflare account, `worker/Containerfile` runs the same
  Worker under `workerd` on a box you own; CI builds and drives it on every
  change, but it has not carried real hosts for a week yet, so the install
  guide still says Cloudflare.
- **Joining works where nobody is watching.** `fleetwright join` from cron,
  Ansible or a container used to print a `/dev/tty` error at every question;
  it is silent now and takes the defaults. A box that enrolled as one name and
  woke up as another (cloud images rename on first boot) is no longer refused
  with its own key: the name the coordinator accepted is recorded beside the
  key. The closing summary names the host.
- **Five things the fleet forgot, kept.** A runner enrolled with a temporary
  pin is now actually retired when its job ends; the person who minted a pin is
  recorded as the owner; the founding admin's record is never swept, so a
  fleet whose phones were all revoked does not get re-founded by a stranger; a
  revoked machine leaves the list at once rather than at the next restart; and
  a GitHub Actions runner dials under the name it enrolled with.
- **apt on a Raspberry Pi is quiet.** The source line names the box's
  architecture, so `apt update` stops saying this repository has no armhf, and
  the index carries a date, so an unchanged repository is not re-downloaded on
  every run. A box with the old line: `sudo sed -i 's/^deb \[/deb [arch=arm64 /' /etc/apt/sources.list.d/fleetwright.list`.
- **Under the hood.** Sign-in to GitHub and Cloudflare from the app, and the
  discovery of any OpenID provider, go through `oauth4webapi` rather than
  code of our own. The MCP server's authorization flow was driven cold by the
  official MCP client and needed no change.

## 0.3.2 — 2026-09-29

**A machine that has gone quiet can be re-keyed from the app, and an update
says what is in it.**

- **Every enrolled machine is listed, reporting or not.** Reinstalling a box
  under its existing name asks for a pin minted for that name, and the app
  could not mint one because a machine that was not reporting was not on
  screen. It is now: the fleet list shows every enrolled machine, marked "not
  reporting" or "revoked", with when it was last heard from, and its page
  offers Replace key the same as a reporting one. Android says when each
  machine was last seen too.
- **Check for updates says what is waiting, not only how much.** The reply
  names the operating-system packages apt has waiting, and for a Fleetwright
  release prints the changelog for every version between the one the box
  runs and the one waiting. Notes that could not be fetched say so rather
  than showing nothing; the row itself still shows the count.

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
