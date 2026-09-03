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

## 0.2.2 — 2026-09-03

**For operators. Nothing changes in the apps.**

v0.2.1 published the first host package this project has ever released — and
its manifest said `"protocol": 2` for code that speaks v3. The builder read that
number from an environment variable nothing set, falling back to a literal that
was correct the day it was written.

That is the dangerous direction: a v2 host reading it sees its own number,
concludes the release matches, installs v3 code and strands itself from its
coordinator — the exact failure the field exists to prevent, caused by the
field. **The number now comes from the protocol itself**, so it cannot drift
again, and `v0.2.1`'s host package should not be installed.

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
