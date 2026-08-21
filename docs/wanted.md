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

### Xcode

The honest answer first: **Xcode does not run on Linux and cannot be made to.**
There is no port, and macOS on non-Apple hardware is against Apple's licence, so
"sandbox it on Linux" is not a thing to find a way to do.

What *is* available, in rough order of how well it fits what already exists:

1. **A Mac as a fleet host.** The sidecar is Node, tmux and HTTP — nothing in it
   is Linux-specific. A Mac mini running agent-hub and the sidecar would be a
   host like any other, with `xcodebuild` available to sessions placed on it.
   The scheduler already filters on labels, so `macos` is the whole of the
   routing change. This is the one that fits the design rather than fighting it.
2. **Keep signing in CI**, which is where it is today, and accept that a session
   cannot archive.
3. Cross-platform pieces for the parts that are not Xcode — XcodeGen already
   runs anywhere, and the project is generated rather than committed.

The sandbox question is separate and unsolved either way: podman is Linux, so a
Mac host would run sessions unsandboxed unless something else is found.

## Elsewhere

### A Telnyx integration, as its own package

> "Inkbox style implementation ... but with Telnyx, our own repo, publish as an
> NPM module and consume here."

Recorded in those words because I do not know what Inkbox is and guessing at the
shape would put the wrong thing in this file — **worth pinning down before
anyone starts.** What is clear: a Telnyx integration, built in a repository of
its own, published to npm, and consumed here as a dependency rather than living
in this tree.

What that would look like here: adapters are a solved seam — Telegram and the
web UI both parse a line, call `dispatch()` from `src/adapters/commands.js`, and
render the reply. A new surface is that and nothing else, which is what makes it
reasonable to develop somewhere else and depend on.

A dependency is a decision this project takes slowly (`docs/dependencies.md`).
Our own package is an easier one than a stranger's, but "we wrote it" is not an
audit.

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
