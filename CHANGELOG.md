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

## 0.4.11 — 2026-10-18

**A machine installed from apt can move between the stable and rolling
suites from the app, rebooting a machine whose fleet name is not its
hostname works, a pool whose servers stop showing offers one tap to
reconnect them, and a run of fixes from the security audit tightens what
one person's box and sign-in can reach.**

- **Switch a machine installed from apt between stable and rolling.** On
  the machine's page the channel picker now works on an apt machine that
  has the upgrade grant; without it the channel is shown pinned and the
  reply names `sudo fleetwright grant upgrades on`. Moving to rolling takes
  the current build of main on the next Apply update, and moving back to
  stable takes the next release. The machine reads its source back and
  reports the suite it is on, not the one it was asked for.
- **Rebooting a machine whose fleet name differs from its hostname.** A
  machine called RPI-7550-ARM that joined as rpi-7550 refused every reboot
  from the app with "This box is RPI-7550-ARM, not rpi-7550". Either name
  confirms it now, and a refusal names both.
- **Reconnect a pool's servers with one tap.** When Xen Orchestra answers
  but shows no pool for five minutes, the fleet pushes **Reconnect**. The
  tap opens the app, Face ID (the fingerprint or screen lock on Android)
  opens the kept admin sign-in, and one machine reconnects the servers and
  reports what it did. The same is offered on the pool's page. Only a
  machine updated to this release can run it; an older one is refused with
  a sentence saying so.
- **The edge router is rebuilt from its kept disk.** A rebuild writes only
  the configuration, about 10 MB, where every build used to send the whole
  3 GiB disk through Xen Orchestra. Needs a Xen Orchestra the fleet
  installed or updated; one installed another way falls back to the full
  build.
- **About one router build in 256 made a certificate its own web server
  refused.** Fixed.
- **A member can administer only their own machines.** Changing the
  channel, image or labels of a machine, updating, upgrading or rebooting
  it, and reading its logs are refused for a machine that does not act for
  that member alone, and the apps leave those controls out where they would
  be refused. Listing machines reaches only the machines that act for the
  member.
- **Removing a person ends what they set up.** Their hypervisor setups
  stop minting pins, and their machines, including ones offline at the
  time, are asked to hand back the members' sessions and sign-ins when they
  return.
- **A GitHub or Cloudflare sign-in finishes only for the person who started
  it.** A forwarded Connect link no longer links someone else's account
  under the sender's name. Update the app and the fleet together: an app
  from before this against an updated fleet finishes the old way.
- **A runner is handed its owner's repository tokens and Claude login**,
  not whoever's job it is running.
- **A new session cannot take over a stopped one's name**, workspace and
  account included. The reply points to `/resume <name>`.
- **A machine's session events buzz a phone at most once per 30 seconds**
  per session and kind, so one chatty machine cannot spend the fleet's push
  budget.
- **Building a machine image shows the session image's pull in bytes**,
  "131 of 262 MB, 6 min so far", instead of a percentage.
- **A few hidden things**, for the curious, at the CLI and in the apps.

## 0.4.10 — 2026-10-15

**You choose on a pool's policy what the machines made there may do from the
app and whether its images are built from main, the pool's own machine stops
being offered for sessions, and New session offers only machines a session
can start on.**

- **Machines made here, on the pool's policy.** Two switches: *Update their
  system from the app* and *Reboot from the app*. Every machine made on the
  pool from then on starts with those answers, the pool's own machine
  included. One already running keeps what it has; on it, run
  `sudo fleetwright grant upgrades on`, or `reboot on`. The machine image is
  what applies the answers, so rebuild the pool's image after updating to
  this release.
- **A pool's machine images can be built from main.** Under the images on the
  pool's policy, *Built from*: Released versions, as before, or Every merge
  to main. An image built from main installs Fleetwright from apt's new
  rolling suite, and the machines made from it update on every merge, so a
  change reaches a test pool without waiting for a release. It applies to an
  image built or rebuilt then; one that is there keeps what it was built from.
- **The pool's own machine runs no sessions.** It was marked degraded for
  having no Claude account, which nobody links there, and Wherever fits could
  pick it. Now it is never picked, a start named at it is refused with the
  reason, and Machines says what it is instead of a fault.
- **New session › Where lists only machines a session can start on.** It
  listed every enrolled machine, offline ones and the pool's own included, and
  a start sent to any of them was refused.
- **A machine with no Claude account says so once**, in plain words, rather
  than twice and with a placeholder in angle brackets.
- **On Android, letting a pool's own machine in now needs the check itself,
  not just its answer.** The secret that proves the machine is yours opens
  only through the fingerprint, face or screen lock asked for it, so a
  tampered app cannot open it after the phone was unlocked. A pool's own
  machine made from an Android phone before this, and not yet let in, is
  made again from the pool's policy.
- **On Android, the edge routers' key is kept after a policy run.** It was
  dropped as soon as Apply was accepted, so the machines that hold the pool
  never got it and the Edge card had nothing to show. Run the policy once more
  to keep it.
- **"It may use 2 storage repositories"**, not "repositorys".

## 0.4.9 — 2026-10-11

**Applying the policy leaves the edge routers alone when nothing changed,
rebuilding a machine image copies the disk already on the pool, and a pool's
own machine asks to join instead of racing a pin.**

- **The edge routers are no longer rebuilt on every policy run.** The key your
  machines read them with and the pair's password were kept where the next run
  never found them, so each run rebuilt both, and machines behind them had no
  way out while the second started. A run that asks nothing new now leaves them
  as they are.
- **Rebuilding a machine image copies its disk on the pool** instead of
  downloading the cloud image and uploading 3 GiB again. The first build after
  updating keeps the disk; every build after copies it, and says so.
- **A Xen Orchestra the fleet deploys has a fix in `disk.importContent`**, which
  rebuilding the edge routers from a kept disk will need. One already running
  keeps its old installer until it is updated with the new one.
- **The edge card names the machine that actually reached the routers**, not
  whichever reported last.
- **A pool's own machine asks to join, and one approval lets it in and lets it
  hold the pool.** It used to join with a pin that lasted ten minutes, and one
  whose first boot took longer ran outside the fleet for good. Now Apply makes
  a secret on your phone, the machine asks with a proof of it, and Machines
  shows it first with **Let it in**. Face ID (or the fingerprint or screen lock
  on Android) checks the proof, lets it into the fleet, and approves it in your
  vault for that pool's record and nothing else. The policy screen also offers
  **Make it again** for one that never joined. A machine made from an image
  built before this release still joins with its pin: rebuild the pool's image
  first, then make it again.
- **A pool's own machine no longer offers buttons that fail.** Its page used
  to offer Shut down and the rest, which Xen Orchestra refused with "not
  enough permissions": it is made with the admin sign-in, outside what the
  fleet's token may change. Its page now says so and points to Make it again
  in the pool's policy.
- **Machines that went away without saying so no longer stay listed as not
  reporting.** A temporary machine whose close the coordinator missed, on a
  deploy or a save that came late, is retired ten minutes after it was first
  seen gone.

## 0.4.8 — 2026-10-10

**The pool's page shows how its edge routers are, opens over mobile data
through one of your machines, and an image build that cannot find names says
which servers it asked.**

- **The edge routers on the pool's page.** Which router holds the gateway,
  whether each answers names and has its way out, how many leases it gave, and
  what they logged lately: a change of master, DNS, DHCP, a gateway alarm,
  Suricata. Apply the policy once after updating: it rebuilds each router once
  to give it a key that reads its status, and machines behind them have no way
  out until they are back. The key can also stop names or the gateway, and
  cannot change the routers' rules; `docs/security.md` says what it can do.
- **A pool's page from away.** When the phone cannot reach Xen Orchestra, on
  mobile data for instance, the page loads through one of your machines that
  holds the pool, and its buttons work the same way. When it can reach neither,
  it says so and what still works.
- **An image build that cannot find names says why.** The build VM asks each
  name server itself and the failure names which answered, instead of one line
  that a download failed.

## 0.4.7 — 2026-10-10

**Machines from your pool start again after a change to what the fleet may
use, and when something goes wrong the phone now says what.**

- **"Not enough permissions" when starting a session is fixed.** Changing what
  the fleet may use took the machine images out of the fleet's own set in Xen
  Orchestra, so the next machine from one was refused. A change now keeps them,
  and puts back any image an earlier change took out.
- **Tapping a setup's notification opens how it ended**: the whole message,
  the end of the install log set apart and selectable, a Copy button, and the
  machine that ran it. It used to open that machine's page and nothing about
  the job. On iPhone; Android already opened the setup.
- **Machines kept ready say what is happening.** The screen updates while it is
  open, says when the one being made was asked for, and says in red why the
  last one did not come, for example that it did not join the fleet within 15
  minutes. One kept ready is now asked for once, not twice.
- **Why a setup stopped is in the machine's own log** as well as on the phone,
  so it can still be read after the phone has let the job go.

## 0.4.6 — 2026-10-10

**Your own XCP-ng pool, from the phone: add it through one of your machines,
start sessions on machines made on it, and put an edge router in front of
them. A new session can also be told what to do.**

- **New session asks what the session should do.** What you type is its first
  message, so it starts working instead of waiting at an empty prompt. A box
  older than this release says it cannot, rather than starting idle.
- **Add a hypervisor.** XCP-ng through Xen Orchestra 6.5 or newer, added from
  the phone through one of your machines, with its progress on the Lock Screen
  or in a notification. A pool with no Xen Orchestra can have one installed
  first, and a pool none of your machines can reach is added through the phone
  itself. The pool's token is kept encrypted on your phone and in your vault,
  not on the machine that set it up. A Xen Orchestra on plain HTTP, or with a
  certificate that does not check out, is set up only once you accept what the
  phone shows you.
- **Machines from your pool.** Start a session on a machine made for it, from
  Debian 13, Ubuntu 24.04 or Ubuntu 26.04. Each machine has its own page:
  restart it, give it more time or a different size, end it, log in over SSH
  with your own keys, and see what it sent and received. Machines can be kept
  ready so a session starts at once, put on a group network to work together,
  or given a lab of their own. Each image can be kept, rebuilt or removed from
  the policy screen, and is installed from the Fleetwright apt package, which
  brings its own Node.
- **The edge router.** An OPNsense router, built from the policy screen, sits
  between those machines and the way out. It filters names against threat
  lists and can drop what its threat rules match, updates itself daily, and can
  be two routers sharing the gateway so that an update never takes the way out
  away.
- **What a session cost.** How long it has waited on you, how long it worked,
  and what it spent.
- **Linked repositories.** Link a repository for each role: a private archive
  a session is pushed to before it goes, the runners, and the templates.
- **Face ID or a fingerprint begins by itself** once it opens the kept sign-in,
  and the phone tries the machine it reached last first.
- **Fixes.**
  - Running sessions keep their GitHub access across a hub restart.
  - A runner session is never started with Remote Control and says so at once,
    and an idle one says to start it again with a task.
  - `verify claude` tests the login a runner's sessions actually run on.
  - A box without a sandbox keeps its updates, and the hub follows a revert.
  - A machine without the guest agent can still be restarted and resized.
  - The compiler warnings in both apps' builds are gone.

## 0.4.5 — 2026-10-04

**The apps are now three places, Sessions, Machines and You. One of your
machines can make the Claude token for your phone, and a runner says what its
sessions will run on.**

- **Sessions, Machines and You.** Sessions is your sessions and what they are
  waiting on. Machines is the boxes and runners and how they are. You is your
  account, your credentials and the one-time setup. People, Revoke host and
  revoking someone's device are offered to admins only. An admin can switch to
  the member view to see exactly what a member sees, then switch back.
- **Finish setting up.** Once you are signed in and no Claude login is kept for
  you, Sessions shows a card that takes you through signing in to GitHub on
  the phone and keeping a Claude login, so a runner no longer joins and then
  refuses the session it was started for.
- **Make the Claude token on one of your machines.** Claude setup now offers
  to run `claude setup-token` on a machine you pick. The phone opens the
  sign-in page, you paste back the code it shows, and the token comes back
  sealed to your phone. The fleet passes on only the page's address and the
  sealed reply. A box still on 0.4.4 says it cannot, and pasting a token works
  as before.
- **No minter key to paste.** The phone and `fleetwright-claude-login` look the
  key up from the fleet's address, and a key that changes reaches every phone
  with nothing to paste again.
- **Runner repositories come from a template.** Make one from
  github.com/TheTechNetwork/Fleetwright-Runners-Template, install the GitHub
  App on it, and press **Check and save**.
- **A session keeps the tools it installs.** What a session installs with npm,
  pip, pipx, go or cargo now goes under `/work/.tools` and is still there after
  its box restarts. Downloads are cached for each person, so the next session
  does not fetch the same packages again. This needs the new session image,
  which the box offers under Apply update. `FLEETWRIGHT_SANDBOX_CACHE=0` turns
  the cache off.
- **Fixes.**
  - The phone's GitHub sign-in could fail with "The refresh token passed is
    incorrect or expired": two renewals at once spent the same single-use
    token. It now renews once at a time, and a sign-in that has run out asks
    you to sign in again.
  - Linked on machines: a credential's row and its Test now agree when it is
    linked on more than one machine. The Test answer shows under its own row
    and names the machine it ran on, and a fault reads as a plain sentence.
  - A runner no longer says nobody has connected a Claude account when its
    sessions run on its owner's Claude login or the repository's API key. A
    runner still fetching its login is shown as not known yet, and sends no
    notification.
  - A start made just after the fleet restarts waits up to 20 seconds for
    machines that have only just reconnected, instead of refusing.
  - A phone that once saved the minter key by hand seals to the current key.

Hosts still speak protocol 6. A box on 0.4.4 keeps working and lacks only the
token-making and the session tool changes above.

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
