# Managing what the fleet can reach

**Status: the first slice is built on both phones: Xen Orchestra,
phone-direct, for a pool added through Add a hypervisor, under Machines →
Hypervisors → the pool.** Not yet run against a real Xen Orchestra from a
phone, and the iOS half not yet built outside CI; "How it is held to the
design" says what ran where. Cloudflare and GitHub follow on the same model.

Fleetwright already holds, or can reach, more than sessions: the machines, the
runners, each person's Claude account, their GitHub and Cloudflare, and now
Xen Orchestra pools (`hypervisors.md`). Today each of those has a corner of the
app, and most have only "link it" and "Test". The goal is one place to see all
of them and act on them, phone first. Managing a hypervisor is one case of
that, not the point of it.

The owner's comparison was [Orbit for Xen Orchestra](https://apps.apple.com/us/app/orbit-for-xen-orchestra/id6761207949):
consoles, the whole VM lifecycle, resource tuning, migration, host operations,
users and roles, widgets and Live Activities. That is the depth for one
component. This page is about having that depth for every component without
building a separate app for each.

## A component has the same three parts

| | What it answers | Example, for a VM |
|---|---|---|
| **What it is** | name, kind, where it lives, what it belongs to | `build-01`, a VM on host `xcp1` in pool Home |
| **How it is** | one state from a fixed set, and the numbers behind it | running; 2 of 4 vCPUs busy, 6 of 8 GiB |
| **What it can do** | the actions that exist for it now, and how much each costs to undo | start, stop, reboot, snapshot, resize, delete |

Every screen is built from those three, so a VM, a Worker and a runner look
like the same kind of row. That is the design system's RHYTHM 1: a row that
looks different should mean something is different (`design-system.md`).

**An action appears only when it exists**, which is C-2 in `CLAUDE.md`. Xen
Orchestra lists its own methods (`system.getMethodsInfo`), so an action whose
method this server does not offer is not drawn, rather than drawn and refused.
The same check is what keeps a guess about a method name from becoming a
broken button: it was the guard in `xo-setup.js` and it is the rule here.

**What an action costs to undo decides how it is confirmed:**

- **Reversible** (start, snapshot, maintenance mode): one tap.
- **Interrupting** (stop, reboot, migrate): a confirmation naming what it
  interrupts, as reboot already does for a machine with sessions on it.
- **Destructive** (forcing a VM off or to restart, deleting one, and
  disconnecting storage when that comes): the name typed back, never a lone
  button.

**Something that takes minutes reports like onboarding does**: a Live Activity
on iOS and an ongoing notification on Android, from the same building blocks
`hypervisors.md` added. A migration is the first such action, and nothing in
the first slice takes minutes, so none is built yet.

## Where a component's credential lives

**Phone-direct, first.** Where a provider has an API the phone can call itself,
the phone calls it with a credential kept in its own Keychain (Android:
EncryptedSharedPreferences behind the Keystore, as the app keeps its device
credential). It never goes to the coordinator, never to a machine, never into
the vault. This is Orbit's trust model, and it is the narrowest one available:
the credential is on the device in somebody's hand and nowhere else.

What it costs, said plainly:

- **It works only where the phone can reach the provider.** Cloudflare and
  GitHub, anywhere. Xen Orchestra, on its network or a VPN to it.
- **Nothing watches while the app is closed.** A phone-direct component has no
  server to push from, so an alert for a failed backup or a host going down
  needs the fleet path below. The app does not pretend otherwise: a
  phone-direct component says when it was last looked at.

**Through the fleet, later and per component, opted into.** The credential is a
vault item granted to one machine that can reach the provider, and the phone
reaches it through the coordinator the way it reaches sessions today. That is
what makes it work away from home and what makes alerts possible, and the cost
is the one `security.md` already writes down for every vault item: that
machine holds it.

## The first slice: Xen Orchestra, phone-direct

**Built on both phones, for a pool added through Add a hypervisor.** What
follows is what shipped; what the design asked for and this slice does not do
is at the end of the section, under "Left from the first slice".

### Where it is

**Machines → Hypervisors → the pool.** That row was already the pool's way in:
it opened the change to what the fleet may use there. A pool is a machine of a
kind, and what is on it is what somebody opens Machines to look at, so its
page is one more page under the row that names it rather than a tab or an app
of its own. The row now says when this phone last looked at the pool, or that
it never has, because the page cannot be current about a pool nobody was
watching.

On that page, in the Machines tab's own card shape: how current it is first,
then **Pools**, **Hosts**, **VMs** and **Storage**, each a heading only when
there is something under it, each row a card that opens the component's page.
**Change what the fleet may use** is a row at the foot of the pool's page, for
an admin, beside what it governs; it opens the same policy flow as before.
The Hypervisors section keeps its gate: it is drawn for a known admin, since
the pools in it are the ones an admin set up from this phone.

A component's page has the three parts in order: **What it is** (kind, where,
address), **How it is** (the state, the numbers, a VM's disks, and how current
that is), **What it can do**. Both phones, the same headings, facts and
sentences; `test/manage-in-apps.test.js` holds the structure equal and the
shared table holds the words (below).

### Connecting

**For a pool added through Add a hypervisor, connecting is reading the
Keychain** (Android: the Keystore-encrypted record): setup sealed the record
back to this phone (`hypervisors.md`, "Where the token lives"), and it carries
the token and the certificate the person accepted, as its pin. Nothing else is
read for it. Never `XOSaved` or `XoSaved`, which keep the admin sign-in for
setup when a person asks them to: no password is used or kept by any of this,
and the source test fails a Manage file that reaches for one.

**The pin is checked in the TLS challenge, before a byte is sent.** On iOS the
`URLSession` server-trust challenge compares the leaf certificate's SHA-256
with the pin and cancels anything else, during the handshake and before the
upgrade request is written. On Android a trust manager that accepts that one
certificate and no other runs inside `startHandshake`, and the upgrade is
written only after it returns. Either way a server answering with another
certificate never hears the token, and the screen says that the certificate
changed and what to do, rather than that the connection failed.

**A pool set up over plain HTTP is not connected to.** There is nothing to
pin, and the token would cross the network on every connection; the page says
so in a sentence instead of offering a button that would do it. A token that
has run out is said as that, with the date, before anything is sent.

**What the token reaches is what its user may see.** Setup's token is the
limited `fleetwright` user's, and Xen Orchestra gives every token its user's
rights, which for that user are its resource set's. The page says so ("Signed
in as fleetwright, the limited user setup made, so only what its resource set
allows is listed"), and a VM on a host the token cannot see says "on a host
this token cannot see" rather than naming none. In practice this lists the
storage and the VMs in the set, and probably not the hosts, which is the
decision recorded under "Left from the first slice".

### Talking

Xen Orchestra's JSON-RPC over a WebSocket at `/api/`, the same calls
`src/fleet/host/xo-ws.js` makes: `session.signIn` with the token,
`system.getMethodsInfo`, and `xo.getAllObjects` filtered by type for `pool`,
`host`, `VM`, `SR`, `VBD` and `VDI` (the last two are a VM's disks). After
that the page stays current from the `all` notifications Xen Orchestra pushes
on the same socket, an `enter` for an object that arrived or changed and an
`exit` for one that went, applied in the order they arrived: through the main
queue on iOS and one channel read on the composition's scope on Android,
because an object that arrived and then went must not go and then arrive.

iOS uses `URLSessionWebSocketTask`, with the message bound raised to the
16 MiB `xo-ws.js` keeps. **Android does not use OkHttp**, which this page
named: the app's network layer is `HttpURLConnection` on purpose (`Fleet.kt`),
and the protocol is the RFC 6455 client and JSON-RPC that `xo-ws.js` already
proved against a real Xen Orchestra, so `XoLink.kt` is that client again, on
an `SSLSocket`, with no dependency added.

**The socket is open while the page is.** It opens with the pool's page,
closes when the page goes, and closes when the app leaves the foreground,
said as that rather than reported later as a lost connection. Coming back
reconnects; so does Look again, which is drawn only where looking again could
change the answer.

### What it shows

| | What it is | How it is |
|---|---|---|
| **Pool** | how many hosts | how many of its VMs are running |
| **Host** | its pool, and "XCP-ng 8.3.0" | running, in maintenance mode, stopped or cannot tell; cores, memory in use of its total, VMs running on it |
| **VM** | the host it runs on in which pool, or "not on a host" | running, stopped, suspended, paused or cannot tell; vCPUs, memory, its address; on its page, each disk with its size and storage |
| **Storage** | its type, and the host it is on or "shared by pool" | free of its size |

**Missing is cannot tell, never zero.** A field Xen Orchestra did not send is
said in its place ("cores: cannot tell", "space: cannot tell"), a VM or a host
with no state is "cannot tell" and is offered nothing, and a host's memory
with no figure for use is "32 GiB, use cannot tell" (C-5). Colour only agrees
with the word: running is `ok`, maintenance mode `attention`, cannot tell
`unsure`, and stopped, suspended and paused `inkDim`, not `idle`, which as
text on a card is 3.78:1 dark and 2.57:1 light and does not clear AA
(`contrast-check.py`).

**Live usage from Xen Orchestra's stats is not read yet**: the numbers are the
objects' own, which for a host includes its memory in use and for a VM its
size, not how busy it is.

### What it can do

Each is drawn only when the server lists its method, and only in a state
where it applies; a method list that could not be read draws none and says
so. What it costs to undo decides how it asks.

| | Method | Offered when | Asks |
|---|---|---|---|
| Start | `vm.start` | stopped | one tap |
| Resume | `vm.resume` | suspended | one tap |
| Unpause | `vm.unpause` | paused | one tap |
| Take a snapshot | `vm.snapshot` (named with the time, UTC) | its state is known | one tap |
| Clone | `vm.clone`, a fast clone | stopped | one tap |
| Shut down | `vm.stop`, clean | running, and its guest tools not said to be missing | names what it interrupts |
| Reboot | `vm.restart`, clean | the same | names what it interrupts |
| Pause | `vm.pause` | running | names what it interrupts |
| Suspend | `vm.suspend` | running | names what it interrupts |
| Force a restart | `vm.restart`, forced | running or paused | the name typed back |
| Force off | `vm.stop`, forced | running, paused or suspended | the name typed back |
| Delete, with its disks | `vm.delete` | stopped | the name typed back |
| vCPUs and memory | `vm.set` | **stopped only**; a running VM says "vCPUs and memory change only while it is stopped" | one tap |
| Grow a disk | `disk.resize`, else `vdi.set`, the host's order (`RESIZE_METHODS`) | **running or not**, never smaller | asks: nothing is lost, and it cannot be undone |
| Enter, leave maintenance mode | `host.setMaintenanceMode`, else `host.disable` and `host.enable` | running; in maintenance mode | one tap |
| Reboot a host | `host.restart` | running or in maintenance mode | names how many VMs this phone can see running on it |

**A clean shutdown needs the guest's tools.** Xen Orchestra asks the guest to
shut itself down, and a guest with no agent cannot hear it, so when Xen
Orchestra says the tools are missing only the forced ones are drawn; when it
says nothing, that is cannot tell, and the clean ones stay.

**Typing the name, not Face ID, for the destructive ones, on both phones.** In
a list of many VMs the wrong one is the mistake worth preventing, which is
what typing its name makes impossible. A machine's reboot on iOS asks for
Face ID instead, because on that machine's own page the wrong one is already
impossible (`HostView.swift`).

### When it was last looked at

Nothing watches a phone-direct pool while the app is closed, so the page
opens on "Last looked at 10:42, 3 hours ago. Nothing watches while the app is
closed." and changes to "Watching now. Changes arrive as Xen Orchestra makes
them." once it is connected. The time is kept per address, and is the only
thing these screens write.

### How it is held to the design

- **One table, both phones.** `test/fixtures/parity/manage.json` holds the
  objects, the row each becomes, which actions each method list offers, every
  action's method, params, cost, question and result, the size rules, the
  notifications, the record setup writes and every sentence.
  `ManageParityTests.swift` and `ManageParityTest.kt` run it; a sentence or a
  rule changed on one phone fails the other.
- **The table against the host.** `test/manage-in-apps.test.js` checks the
  table's pin against `certSha256` in `xo-ws.js` and its resize order against
  `RESIZE_METHODS`, and reads both apps for what a table cannot hold: the pin
  checked in the handshake before anything is written, no password reached
  for, buttons only from the model, the typed name gating the destructive
  button, 44pt and 48dp targets, notifications in order, and the same
  sections in the same order.
- **What ran where.** The Node suite and `./scripts/verify.sh` ran with every
  layer. The Android app compiled and its unit tests (`ManageParityTest`,
  `XoLinkTest`, which holds the frame lengths and the RFC 6455 accept key) and
  `lintDebug` ran in the environment that built it. **The Swift compiles only
  in CI**, so iOS is reviewed and not yet built. **Neither phone has talked to
  a real Xen Orchestra yet**: in particular, whether iOS's App Transport
  Security accepts the pinned self-signed certificate once the challenge has
  accepted it is not proven until a phone does it.

### Left from the first slice

- **Connecting a pool by address alone.** The phone doing what `xoprobe` does
  (one handshake, the certificate's SHA-256 shown to accept), then a token or
  an email and password used once for `token.create` and dropped. Not built:
  every pool on the phone today came through setup, so connecting is reading
  its record. It is also the answer to the next point.
- **A token that reaches the hosts.** Setup's token is the limited user's
  (above), so host maintenance and host reboot are drawn only where that user
  can see a host. Managing the whole pool needs a token of the person's own,
  which is the address path; whether that is the next step or the limited
  user should see more is the owner's to decide.
- **Watching the token's expiry and replacing it before it runs out.** Today
  the page says when it ran out and to run setup again.
- **Live usage** from `vm.stats` and `host.stats`.
- **A pool on plain HTTP**, which is refused in words.
- **A Live Activity or an ongoing notification** for an action that takes
  minutes; nothing in this slice does, and a migration, the first that would,
  is next.

**Next in this component:** migration and storage, with a Live Activity per
migration; users, groups and roles; patching hosts; consoles last, because a
VNC client is the largest single piece and is one per platform.

## Then the rest, on the same model

- **GitHub**, phone-direct with the sign-in the phone already has
  (`PhoneGitHub.swift`): repositories, Actions runs and the runner workflows
  `provision` dispatches, with re-run and cancel.
- **Cloudflare**, phone-direct with a token kept on the phone: Workers, DNS
  records and tunnels for the account it reaches.
- **The fleet's own parts** (machines, sessions, runners, Claude accounts,
  vault items) are already reached through the coordinator; they move into the
  same component rows so the whole thing reads as one list.

## Order of work

As `CONTRIBUTING.md` lays it out, after the hypervisor onboarding stack had
merged, because both edit the Machines screens:

1. **iOS**: the component model, Xen Orchestra phone-direct, the first slice
   of actions. No coordinator or host change: phone-direct needs neither.
   Built.
2. **Android**: the same, held to the iOS screens by the shared table and
   `app-parity.md`. Built.
3. **Docs**: this page, from design to what shipped, with the rows in
   `app-parity.md` and `ROADMAP.md`.

## What this does not do

- **It does not manage anything the person could not.** A component acts with
  the credential the person gave it, so it can never do more than they can in
  that provider's own console.
- **It does not add a theme.** One palette, on purpose, with a test that fails
  a colour written outside it.
- **It does not reach a component from away from home, yet.** That is the
  fleet path, which comes after.
