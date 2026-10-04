# Managing what the fleet can reach

**Status: design. Nothing here is built.** The first slice is Xen Orchestra,
phone-direct; Cloudflare and GitHub follow on the same model.

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
- **Destructive** (force shutdown, delete, disconnect storage): the name typed
  back, or Face ID, never a lone button.

**Something that takes minutes reports like onboarding does**: a Live Activity
on iOS and an ongoing notification on Android, from the same building blocks
`hypervisors.md` added. A migration is the first such action.

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

**Connecting.** The person enters an address; the phone does what `xoprobe`
does from a machine (one TLS handshake, the certificate's SHA-256 shown for
them to accept) and pins that certificate for every connection after. Then
either a Xen Orchestra token, or an email and password used once to make one
(`token.create`) and then dropped, so a password is never kept. The token's
expiry is watched and it is replaced before it runs out, on the phone.

**Talking.** Xen Orchestra's JSON-RPC over a WebSocket at `/api/`, the same
calls `src/fleet/host/xo-ws.js` makes: `URLSessionWebSocketTask` on iOS and
OkHttp's WebSocket on Android, each with the pin checked in the TLS challenge
before a byte is sent. Read with `xo.getAllObjects` filtered by type; stay
current from the `all` notifications Xen Orchestra pushes on the same socket,
rather than polling.

**What it shows.** Pools, hosts, VMs and storage repositories, each as a
component. Hosts and VMs with live usage from Xen Orchestra's stats.

**What it can do, in the first slice:** the VM lifecycle (start, clean and
forced shutdown, reboot, pause, suspend, snapshot, clone, delete), resource
tuning (vCPUs and memory, and growing a disk, with the ones that need the VM
off saying so), and host maintenance mode and reboot. Each drawn only when
the server lists its method.

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

Following `CONTRIBUTING.md`, and starting after the hypervisor onboarding
stack has merged, because both edit the Machines screens:

1. **iOS**: the component model, Xen Orchestra phone-direct, the first slice
   of actions. No coordinator or host change: phone-direct needs neither.
2. **Android**: the same, held to the iOS screens by `app-parity.md`.
3. **Docs**: this page to what shipped.

## What this does not do

- **It does not manage anything the person could not.** A component acts with
  the credential the person gave it, so it can never do more than they can in
  that provider's own console.
- **It does not add a theme.** One palette, on purpose, with a test that fails
  a colour written outside it.
- **It does not reach a component from away from home, yet.** That is the
  fleet path, which comes after.
