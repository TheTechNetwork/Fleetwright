# Wanted, not built

A list, not a plan. Each entry says what it is, why it is worth having, and the
thing that actually makes it hard — because for most of these the hard part is
not the feature, and finding that out twice is a waste.

Nothing here is scheduled. Items move out of this file by being built, or by
being decided against with the reason written down.

## In the sandbox

The session container is deliberately minimal: `debian:13-slim`, real root
inside, and everything outside the two volumes discarded on stop
(`docs/deployment.md` §3). That is the right default and it is what makes each
of these a decision rather than an `apt install` line.

The shape that probably fits all four: a **second image**, not a fatter default.
`AGENT_HUB_SANDBOX_IMAGE` already selects it per box, and a session that needs a
browser should not make every session pay for one.

### A browser

So a session can read a page, fill a form, or check the thing it just deployed.

The work is not installing Chromium; it is that the container filesystem is
thrown away on every stop, so a per-session install is minutes of every start.
That is the argument for baking it into an image variant. Headless plus
Playwright is the small version of this and is worth doing first — it needs no
display server and no protocol beyond stdio.

### Full computer-use style control

A real desktop the model can see and drive, rather than a headless browser.

Needs an X or Wayland server inside the container, a screenshot path out, and an
input path in — plus a way to watch it, which in practice means VNC over the
existing tunnel. Anthropic publish a reference container for this; the useful
question is how much of it can be borrowed rather than rebuilt.

The security story needs stating before this ships, not after: a session that
can see and click is a session that can click on anything it can reach.

### Android Studio and an emulator

So an Android build can be driven end to end from a session, instead of the
current split where CI builds the APK and a human installs it.

**The constraint is `/dev/kvm`.** The emulator wants hardware acceleration; in a
container that means passing the device through and the host supporting nested
virtualisation. Without it the emulator falls back to software rendering and is
slow enough not to be worth having. Check `ls -l /dev/kvm` on the intended host
before designing anything.

Android Studio itself is only needed for the GUI; `sdkmanager`, `avdmanager`,
`emulator` and `gradle` are the parts a session would actually use.

### Xcode, and hosts that are not Linux

The honest answer first: **Xcode does not run on Linux and cannot be made to.**
There is no port, and macOS on non-Apple hardware is against Apple's licence, so
"sandbox it on Linux" is not a thing to find a way to do.

But the wider goal — a Windows box, a Linux box and a Mac in one fleet, so a
session can build and run anything — is not blocked by that, because **a host is
just a box that dials in.** The scheduler already filters on labels before it
ranks by capacity, so `macos` or `windows` is most of the routing. What differs
is how much of a host each platform can be:

| | agent-hub | sidecar | sandbox | what it is for |
|---|---|---|---|---|
| **Linux** | works | works | podman, works | everything today |
| **macOS** | needs checking — tmux is fine, the systemd units are not | should work: Node, tmux and HTTP, nothing Linux-specific | no. podman on a Mac is a Linux VM, which gets you Linux containers on Apple hardware and still no Xcode | Xcode, `xcodebuild`, signing, the iOS simulator |
| **Windows** | tmux does not exist there | same problem | no | Visual Studio, MSVC, Windows-only runtimes |

Two real pieces of work fall out of that table:

- **launchd units and a macOS install path.** STARTED. The installer no longer
  refuses a Mac — it detects the platform, installs what works, and prints what
  it skipped. There are launchd plists for all three services in `install/`,
  Homebrew is used for dependencies (as the invoking user, since brew refuses to
  run as root), and the podman/subuid path is skipped with a reason.

  What made this possible was unrelated: **launchd has no `EnvironmentFile`**,
  so a service under it only works if the binary reads its own config file —
  which the CLIs started doing when the enrol bug forced it. Without that, the
  plists would load and every service would come up with an empty environment.

  Still open: `StateDirectory` and `RuntimeDirectory` have no launchd
  equivalent, so the state and hook-socket directories need creating and
  chown-ing by the installer instead of by the service manager. Untested on real
  hardware. Sessions on a Mac run unsandboxed, which should be said in the UI
  rather than assumed.
- **Windows is really WSL2.** agent-hub drives sessions through tmux
  `capture-pane` and `send-keys`; there is no tmux on Windows and no obvious
  substitute that keeps resume-dialog detection and `peek` working. A WSL2 host
  is a Linux host that happens to live on a Windows machine, and reaching
  Windows tooling from it means interop rather than a native port. That is
  probably the right answer, and it is worth deciding deliberately instead of
  discovering it after writing a Windows pane driver.

The cheapest first step for the Mac is not the installer: it is running the
sidecar on one by hand against the deployed coordinator and seeing what breaks.
Nothing in `src/fleet/host/` imports anything platform-specific, so the answer
may be "nothing", and that is worth knowing before designing launchd units.

## Elsewhere

### Reachability: an Inkbox-shaped thing, on Telnyx

[Inkbox](https://inkbox.ai) gives an agent **one identity that is reachable on
many channels** — email, phone, SMS, iMessage, an HTTP address and
agent-to-agent — with the conversations across those channels tied together, and
per-channel control over who gets through. Wanted: our own, in its own
repository, published to npm and consumed here as a dependency.

**Telnyx covers the telephony third of that, and only that.** It sells phone
numbers, SMS and MMS, and voice. It does not do email and it does not do
iMessage, so anyone starting from "Inkbox but Telnyx" should know they are
building the phone-shaped part and would need a second provider for mail
(Postmark, SES) and something else again for iMessage, which in practice needs
Apple hardware. Deciding to build only the telephony part is a fine decision;
discovering it halfway through is not.

Three things this repository already has that the package should not reinvent:

- **The adapter seam.** Telegram and the web UI both do the same two things:
  parse a line and call `dispatch()` from `src/adapters/commands.js`. A channel
  is that and nothing more, which is exactly what makes it sane to develop in
  another repository and depend on.
- **An actor.** Every command carries who asked — `telegram:12345` today, a
  verified email address once a device credential is doing the asking. The
  interesting half of Inkbox is that a person is the SAME actor whether they
  text, mail or call, and that is a question about the identity model rather
  than about Telnyx.
- **An allowlist.** `AGENT_HUB_TELEGRAM_ALLOWED_USERS` and
  `AGENT_FLEET_AUTH_ALLOW` are the existing answers to "who gets through".

**The security shape is different from every surface here today, and worse.**
Telegram is allowlisted user ids; the apps sign in and hold a per-device
credential. A phone number is public by construction — anyone who learns it can
send to it — and caller ID and SMS sender IDs are both spoofable, so neither is
an authentication. An inbound channel that can start sessions therefore needs
its own answer to who is allowed, and the honest default is that inbound
messages from unknown numbers do nothing at all.

Worth reading Inkbox's own docs before designing: agent-to-agent and the
cross-channel thread are the parts that are actually hard, and they may have
already made the decisions worth copying.

### Session configuration from the app and Telegram

Today a session is started with a name, a path and a permission flag, and
everything else about how it runs is decided by `/etc/agent-hub.env` on the box
— which means changing it is an SSH session, which is the errand this project
exists to remove.

Wanted: the per-session settings that a person actually changes, exposed on both
surfaces. Sandbox on or off, resource limits, the model, permission mode, the
working directory, and whichever environment a session is allowed to see.

Two things to get right rather than fast:

- **The intent protocol has eight fixed verbs on purpose** (`docs/intents.md`),
  and the whole security argument is that a compromised coordinator cannot
  express a command. Configuration must arrive as named, validated fields — not
  as anything that gets interpolated into a command line.
- **Some of these are privileges, not preferences.** "Turn the sandbox off" and
  "let this session see that credential" are decisions with consequences, and
  the fleet has no roles yet (`docs/identity.md`). Worth knowing which side of
  that line each setting is on before any of them is a button.

### Injecting rules, helpers and tools into a session at start

> "Prompt efficiency helpers in the sessions we start by injecting rules… there
> is sooo much we can inject including rules helpers and tools we already
> use/maintain."

The mechanism is largely already here, which is why this is worth writing down
carefully rather than starting. A session's context comes from `~/.claude` —
`settings.json`, `CLAUDE.md`, skills, hooks, MCP servers. `install.sh` already
writes a merged `settings.json` per box, and a sandboxed session gets a fresh
`claude-<name>` volume that is SEEDED at first launch (`src/core/podman.js`).
That seed is the injection point, and it exists.

**The trap, and it is the same one this project has just spent a rework on.**

Injected rules are instructions to an agent that has root in a container. If the
COORDINATOR chooses what gets injected, then a compromised coordinator writes
that agent's instructions — which is a far larger capability than the eight
verbs, and is precisely the thing design.md §5 exists to forbid. It is the
`reply { text }` argument in different clothes: it looks like configuration and
it is arbitrary text reaching a model that can act.

So the rule that has to hold: **the coordinator may NAME a profile; it may never
CARRY one.** The content lives on the host, or in the repository being worked
on, and `start { profile: 'reviewer' }` selects among things the host already
has — exactly the shape `docs/trust.md` argues for with secrets, for exactly the
same reason. `start` already takes a bounded `enum` for `mode`, so the protocol
precedent is there too.

**On whether it is more efficient, which you are right to say is arguable.**
Nobody in this repository has measured it, so the honest answer is that we do
not know, and the shape of the answer probably differs by kind:

- **Always-on rules** (`CLAUDE.md`, a system-prompt preamble) are the expensive
  kind. They cost their tokens on every single turn of every session, forever,
  whether or not that turn needed them. A 2,000-token house style is a 2,000-token
  tax on a one-line question.
- **On-demand things** (skills, MCP tools, hooks) are the cheap kind. They cost a
  line in a manifest until something actually invokes them.
- **The measurable claim** is not "does injecting help" but "does this specific
  injection change the number of turns to done, or the number of times a person
  is interrupted". Both are countable, and the prompt work in Phase 1 of
  `docs/plan.md` is what makes the second one countable for the first time —
  every `session.awaiting-input` is now a structured record of an interruption.

Which suggests the order: **ship a profile mechanism that is host-side and named,
then measure interruptions per session with and without a profile, and let that
decide what goes in one.** The argument about which rules help is not settled by
argument.

### Serving secrets into a session without the session holding them

Designed in [`trust.md`](./trust.md). Not a GitHub feature and not a per-service
one: every service a session touches has this problem and it does not go away.

**The design landed on a proxy that terminates credentials**, and the reason is
worth carrying into whoever picks this up. An earlier version sorted services by
what the upstream supports — mintable, storable-only, unnecessary — and accepted
that most of them fall in the middle row, where the best available answer is
handing a session a durable secret and bounding only its reach. That table sorts
on the wrong axis. If session egress goes through a proxy, the credential the
session holds is issued by **us**, so it has whatever lifetime and revocation we
choose no matter what the real service supports; the proxy substitutes the real
credential on the way out. Exfiltrated, what the session held is a random string
that authenticates to one listener from one network namespace.

That collapses the table. The upstream's capability becomes an internal detail
of one adapter rather than the thing that bounds the design.

**Build order**, easiest real win first:

1. the proxy, per-session identity by network namespace, a substitution table,
   and **default-deny egress** — which may be worth more than the credential
   handling, and needs nothing from anyone to start
2. 1Password as custody for the real credentials, on a short cache TTL so
   rotation propagates. This is not the vault-MCP idea that got rejected: one
   component the session cannot address reads the vault, and the objection was
   always to putting a vault in the model's context, never to using one
3. SigV4 re-signing, only if something actually needs AWS

**The three things that section insists on**, repeated because they are what
make this worth building rather than theatre:

- **Substitution is trivial for bearer tokens and not for signed requests.**
  SigV4 and other HMAC schemes sign over headers and body client-side, so there
  is no header to swap — verify with the issued key, re-sign with the real one.
  Per-scheme work, and the difference between a substitution table and a project.
- **The CA key becomes the most powerful durable secret in the system.** It can
  impersonate any site to a session, including the coordinator. Concentrating
  custody is the right trade; it is still concentration and not elimination.
- **This bounds theft, not misuse.** A session can use anything policy permits,
  authenticated as us, for as long as it runs. Scoping what gets signed — per
  host, per method, per path — is the half that actually bounds damage, and a
  proxy is what makes it a config file instead of a bespoke operation each time.

Not everything is HTTP: `git` over SSH wants `ssh-agent` forwarding to an agent
outside the container, which is this same design twenty-five years early.

Prerequisite for the interesting version: hosts now have keypairs, which is what
gives a secret something to be encrypted *to*.

### The app, voice and the CLI as the hub — not Telegram

Full plan in [`app-parity.md`](./app-parity.md). The short version, because the
framing is the part worth carrying: **the app, Siri, Google Assistant and the
CLI are what most people use. Telegram stays as an option and stops setting the
ceiling.**

Measured rather than guessed. Chat exposes 16 commands; both apps already carry
clients for most of them. The gap is three different problems:

- **built, not on screen** — `forget` exists in `Fleet.swift` and `Fleet.kt` and
  appears nowhere in either UI. A button.
- **needs a new verb** — `logs`, `update`, `upgrade`, `reboot`, `login`/`code`.
  Telegram reaches these by talking to `agent-hub` on that box; an app talking
  to a coordinator has no such path. `PROTOCOL_VERSION` is exact-match, so this
  is one coordinated v2 designed together, not five verbs added one at a time.
- **needs data nobody collects** — workspace path, context-window usage, plan
  limits, host version and whether it is behind.

Build order: no-protocol-change work first (forget, host picker, workspace path,
Telegram setup from the app), then additive reporting on existing verbs, then
protocol v2 once — with `answer` in the same bump — then the filesystem last,
because an authenticated app that can read and write arbitrary paths on every
host is the largest new attack surface in the product and wants its own design
pass.

Voice gets a vote on the protocol: parameters have to be nameable out loud, and
replies need a short speakable sentence the host writes. Notably `answer` taking
an ordinal — chosen in `plan.md` §4 because `send-keys` reaches a root shell —
is also the only form a voice assistant can offer reliably.

### A browser control surface, and a PWA

Same capability as the apps, from a PC. **Explicitly after identity lands**,
which is what makes it possible to build honestly.

There is already a browser UI — `src/adapters/http.js` serves one — but it is
per-host, it talks to one agent-hub on `127.0.0.1:8790`, and its idea of who is
asking is the string `web`. What is wanted is different: a **fleet-level** UI
against the coordinator, signed in the way the apps sign in, holding a
credential of its own like any other device.

The pieces that already exist make this smaller than it sounds: the coordinator
speaks flat JSON over one origin, `dispatch()` is shared by every surface, and
sign-in issues per-device credentials. What is genuinely new is the sign-in flow
in a browser rather than a native app — a redirect flow instead of a system
sheet — and where the credential lives once issued, which on the web is a
harder question than a keychain.

PWA on top of that is mostly a manifest, a service worker and an icon. Web push
is a third push transport beside APNs and FCM; `src/fleet/push.js` already has
the shape for one.
