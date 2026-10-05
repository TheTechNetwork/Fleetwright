# A machine from your own hypervisor

**Status: onboarding a pool that already has Xen Orchestra is built, through
a machine already in the fleet** ("What ships first", below). Templates,
labs, the dedicated machine and deploying Xen Orchestra are designed and not
built. XCP-ng first, through Xen Orchestra; Proxmox second, behind the same
interface.

A session today runs in a container on a box, or on a GitHub Actions runner
that is gone in six hours. Neither is a real machine on a network you own:
a container shares the box's kernel and has no interfaces of its own to route
or sniff, and a runner is somebody else's computer on somebody else's network.
Some work needs a whole VM: a router in front of it, a network with nothing
else on it, a kernel it may break, traffic somebody can inspect. The shape
that gets there is the one runners already proved: a machine is cloned,
**joins by itself**, does the job, and is destroyed. The difference is whose
hardware it is, and where the credential that clones it lives.

## The credential, which is the whole design again

A Xen Orchestra user that can create and delete VMs is root on the pool in
every way that matters. `docs/wanted.md` already says where it may not live:
the coordinator is the party this system treats as compromised, so a token
there is every VM behind it. `runner-central.md` landed on the shape for
GitHub and this is the same one.

**One permanent fleetwright host on the pool holds the Xen Orchestra token,
and nothing else holds it.** A small VM of its own, not a box that does other
work, so what can reach the token is exactly what runs on that VM. The
coordinator asks it to act; it cannot read the token and cannot exceed what
the token may do.

**And what the token may do is bounded in Xen Orchestra, not here.** The
fleetwright user gets a **resource set**: the templates it may create from,
the storage and networks it may use, and limits on vCPUs, memory, disk and VM
count. Where the XO version has the newer ACLs, its rules are scoped by
selector to VMs tagged `fleetwright`, so it cannot see or touch anything it
did not make. A compromised hypervisor host is then a quota's worth of VMs
from a known list of templates, and nothing on the pool that predates it.
This is the bound to write down for the operator, because it is the one that
holds when everything on our side has failed.

## What `provision` may express

```
provision { template: <name>, minutes?: 5..1440, task? }
provision { lab: <name>,      minutes?: 5..1440, task? }
```

**A template is a file on the hypervisor host**, chosen by name, exactly as a
task profile is. It says which XO template to clone, vCPUs, memory, disk,
which networks, and the most minutes it may live:

```json
// /var/lib/fleetwright/templates/debian.json
{
  "xoTemplate": "fleetwright-debian-13",
  "cpus": 2, "memoryGiB": 4, "diskGiB": 32,
  "networks": ["fleetwright-uplink"],
  "maxMinutes": 480
}
```

`templates` lists what a hypervisor host has, fanned out like `profiles`, so a
picker shows only names some host can honour. **The coordinator names a
template and never carries one**: no XO template id, no network, no size and
no cloud-init crosses the protocol. A compromised coordinator can ask for a
Debian VM for eight hours, attributed to a real person; it cannot ask for a
VM on the management network or one built from an image of its choosing.

`template` and `lab` are new parameters on an existing verb, so they are
`since: 8` and an older host is never handed them. They and `platform` are
mutually exclusive: one says "a GitHub runner", the others "a VM, or a lab,
from this pool". A `task` rides along
the way it does on a held runner start (protocol 7).

## How a clone joins

A fresh VM has nobody at a shell, so it joins the way a runner does, with
the delivery changed:

1. The coordinator mints a **ticket**: single-use, short-lived, ephemeral,
   bound to the person who asked. The rules `runner-tickets.js` already
   argues; what a leaked one costs is a machine attributed to the wrong
   member, once.
2. The hypervisor host creates the VM through Xen Orchestra's JSON-RPC API
   (the one its Terraform and Pulumi providers drive): the template, a unique
   name (`fw-<template>-<short id>`, which is also its host id, because two
   clones under one identity is the clone bug again), the `fleetwright` tag,
   an expiry, and **cloud-init user data** carrying the ticket and the
   one-line install.
3. Xen Orchestra is asked to **destroy the cloud-config disk after first
   boot** (the Terraform provider's `destroy_cloud_config_vdi_after_boot`), so
   the ticket is not left on a disk inside the guest after it is spent.
4. The guest installs the package, enrols as a temporary host, and from there
   it is a runner in every way the coordinator cares about: placed only by
   name, retired on disconnect, its key revoked with it.

The templates have the package installed and NOT enrolled, so first boot is
an enrolment, not a download.

## Ending

**The clock is on the VM, not in somebody's memory.** Every VM carries its
expiry in Xen Orchestra beside the tag. The hypervisor host destroys, disks
included:

- a VM past its expiry, on a timer and when the host starts, so a hypervisor
  host that was down cannot leave its VMs running for ever;
- a VM whose host has been retired, when the coordinator says so;
- on `stop` from the person who owns it.

A VM tagged `fleetwright` that names no host this fleet knows is destroyed
too. The tag is ours, so anything wearing it is ours to clean up, and the
resource set means nothing else can wear it by accident.

## Inside the VM

**The VM is the sandbox.** The session runs without a container: it gets the
VM's own kernel, interfaces and `/dev`, which is what packet capture, routing
and kernel work need. The template gives the service user passwordless sudo,
because the machine exists for one job and is destroyed after it. Nothing
outside the VM is reachable from inside except through the networks the
template file lists. That makes the uplink the decision that matters most,
which is the next section.

## Labs: a router in front of the machine

The reason for this page. A **lab** is a topology file on the hypervisor host,
named like a template:

```json
// /var/lib/fleetwright/labs/opnsense.json
{
  "network": "private",
  "router": { "template": "opnsense", "wan": "fleetwright-uplink", "lan": "lab" },
  "machines": [{ "template": "debian", "networks": ["lab"] }]
}
```

`provision { lab: "opnsense" }` makes, in order:

1. a private network for this lab alone (Xen Orchestra creates one without a
   VLAN; it exists only inside the pool), named for the lab;
2. the OPNsense VM, its WAN on the uplink and its LAN on the lab network;
3. the session VM, on the lab network only.

So every packet the session machine sends crosses the router, which is the
vantage point packet inspection needs: captures, the firewall log, Suricata's
alerts. The session drives OPNsense through its API.

**The API key is per lab, and only the lab has it.** OPNsense does not take
cloud-init, so the template is built with a bootstrap key that only the
hypervisor host knows. When the router is up, the host uses it once to make
a key for this lab and delete the bootstrap one, then hands the new key to the
session machine in its cloud-init as a **named secret** (`opnsense`). The
session fetches it through the credential broker like any other secret, and
it dies with the lab.

**Teardown is the whole lab**: both VMs, their disks, then the network.

### The uplink

**`fleetwright-uplink` must not be the management network**, the one Xen
Orchestra, the pool masters and everything else on your LAN sit on. Everything
a lab does leaves through it, so it is the boundary; the router inside the lab
is the instrument, not the wall.

**Which network the edge router's WAN goes on is the person's choice**, made
on the phone when they change the pool's policy (below, "The policy"), and
recorded in Xen Orchestra as the `fleetwright-egress` tag on that
network, so it can be seen and changed there too. It has to be one of the
networks the fleet may use, or the fleet could not attach a router to it.
The edge router is OPNsense, for the reasons in "Templates" below.

**The policy screen builds it, so nobody configures a switch.** Under Way
out, a machine that can build it offers *Build the edge router on it*
(or *Keep the edge router on it* when the pool has one). Apply then
(`src/fleet/host/edge-router.js`):

1. Makes `fleetwright-uplink`, a private network in the pool with no
   interface of its own, and adds it to what the fleet may use.
2. Builds `fleetwright-edge`, an OPNsense 26.7 VM: 2 vCPUs, 2 GiB and a
   3 GiB disk on the storage chosen, its WAN (`xn0`) on the way out and its
   LAN (`xn1`) on the uplink at 10.254.0.1/24. Its rules, in order:
   - labs may ask the edge for names (DNS);
   - nothing to 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 or 224/4,
     so no lab reaches your LAN, the pool's API or another lab;
   - anything else, out through automatic NAT.
   It hands out 10.254.0.100–250 and answers DNS with Unbound. It has **no
   login** (root's password is `*`) and no anti-lockout rule, because the only
   thing that could reach it is a lab, and it is not tagged `fleetwright`, so
   the fleet's token cannot touch the fleet's own way out.
3. When it is already there, moves its WAN if the way out changed and starts
   it if it was stopped. Nothing is rebuilt.

A failure part-way deletes what it made. A pool with more than one host keeps
labs on the edge's host, because a network with no interface is host-local
without Xen Orchestra's SDN controller. A pool that already has a suitable
VLAN can be pointed at it instead; nothing requires the uplink.

## Templates, built by onboarding

Nobody builds them by hand. The Debian template does not exist yet; the
OPNsense image is built, for the edge router:

- **Linux.** Debian's official cloud image (the `genericcloud` build, which
  already runs cloud-init) is downloaded, checked against Debian's published
  checksum, converted and imported. A builder VM boots it once with cloud-init
  that installs the Xen guest tools and the fleetwright package without
  enrolling and gives the service user sudo, then powers off and is converted
  to `fleetwright-debian-13`.
- **OPNsense, built and proved for the edge router.** Not from a second disk:
  OPNsense's configuration importer waits for a key press at the console, so
  attached media is not read unattended. What first boot does read is
  `/usr/local/etc/config.xml`: with no `/conf/config.xml` yet, the importer
  times out and copies that file into place. In the 26.7 nano image it is
  5,234 contiguous bytes at a fixed offset of a plain UFS2 file system. So the
  machine downloads the image once, checks it against OPNsense's published
  SHA-256, unpacks it with `bzip2`, and streams it to Xen Orchestra's disk
  import with exactly those bytes replaced by the edge's configuration,
  padded to the same length (inode, size and blocks untouched). The bytes it
  replaces are checked first against their own pinned SHA-256, so a wrong
  offset fails rather than corrupting the disk. **Booted in QEMU** from the
  published image patched this way: no key press, the console banner showed
  `fleetwright-edge.internal` with the LAN at 10.254.0.1/24 and the WAN on
  DHCP, and `pfctl` showed the three LAN rules above in order, with automatic
  NAT. Labs' own routers will use the same technique with their own
  configuration.

Rebuilding is the same script with the newest image, so a template is
replaced rather than patched, and the old one is deleted once nothing was
cloned from it.

## The interface, so Proxmox is a second driver and not a second design

```
create({ name, template, userData, networks, tags, expiresAt }) → { id }
start(id)  destroy(id, { disks: true })  list({ tag })  status(id)
createNetwork(name) → { id }  destroyNetwork(id)
```

**Xen Orchestra** maps onto it directly. **Proxmox** maps onto it as a clone
of a template VM, user data through a cloud-init snippet, a VNet under SDN for
a lab network, and a token whose role is granted on one resource pool. That
is the same bound as the resource set, and the same reason. Template and lab
files do not change between the two.

## Order of work

Following `CONTRIBUTING.md`, coordinator first:

1. **Coordinator, protocol 8:** `template` and `lab` on `provision`, the
   `templates` verb, placement onto a host that publishes the template, the
   ticket, and the onboarding verb that carries a sealed admin credential to
   one chosen host.
2. **Host:** the onboarding script, the Xen Orchestra driver, template and
   lab files, the expiry reaper. Tested against a stand-in JSON-RPC server,
   because the real one is on hardware this repository cannot reach.
3. **Phones:** Add a hypervisor, its progress, and templates and labs in
   the new-machine picker.
4. **Docs.**

Labs (step 2 again, with the router bootstrap) come after a single VM works
on the real pool.

## Onboarding: nothing made by hand

**What a person supplies is an address and a credential, once.** Everything
in the sections above is created by a script from those, and the credential
is used for that run and thrown away.

### From the app

Machines → Add a hypervisor: the pool's address, and one of

- a **Xen Orchestra admin** sign-in, when the pool has Xen Orchestra;
- the pool master's **root password**, when it does not. The script then
  deploys Xen Orchestra too, in a VM of its own: built from source, so it
  needs no account anywhere.

The credential is **sealed on the phone to the host that will run the
script**, the same way a GitHub code is sealed to the box that exchanges it,
so the coordinator relays ciphertext it cannot read. The host that runs it is
one already in the fleet that can reach the pool's address; the app asks them
all (`xoprobe`) and offers the ones that reached it, and says what to check
if none did.

**The app can close.** The machine runs the setup; progress reaches the phone
as a Live Activity on the Lock Screen and in the Dynamic Island on iOS, and as
one ongoing notification on Android.

### What ships first

For a pool that already has Xen Orchestra, which is the common case and the
owner's: `xoprobe`, then `xosetup` on the machine the person picks.

1. **The probe** reports whether the machine reached the address over TLS,
   whether it looks like Xen Orchestra (it reads `/signin`, because `/` is a
   redirect with no page), and the certificate: its SHA-256, who it was
   issued to and by, its dates and names, and everything wrong with it —
   self-signed, signed by an authority the machine does not trust, expired,
   not yet valid, for a different name. The certificate is the **pin** every
   later connection is held to.
   **Without TLS**, which is what the installer gives until `xo-install.cfg`
   names a certificate (its default is `PORT="80"`), the probe says it reached
   Xen Orchestra over plain HTTP, on 80 or the address's own port. The phone
   then says what that means, in those words: the admin password and the token
   the fleet keeps would cross the network unencrypted. It says how to give
   Xen Orchestra HTTPS instead (`PORT="443"`, `PATH_TO_HTTPS_CERT`,
   `PATH_TO_HTTPS_KEY`, `AUTOCERT="true"`, run the installer again), and Begin
   waits for the person to say send it anyway. Only then does `begin` carry
   `plain: accepted` and no pin; the machine signs the job's key over an empty
   pin, runs every step over HTTP, and the kept record says `plain`. Run
   against a real Xen Orchestra on HTTP, all steps.
2. **The person accepts a certificate that does not check out, having seen
   it.** One that checks out is a line and no question. One that does not —
   which is every Xen Orchestra built from sources, since the installer makes
   its own — is shown in full on the phone, each problem in a sentence, and
   Begin waits for the person to say they checked it and trust it. Only then
   does `begin` carry `trust: accepted`, and the machine refuses to connect to
   such a certificate without it, before a byte is sent. The pin is what keeps
   a password from the wrong server; this is what keeps a pool from being set
   up through a certificate nobody looked at.
3. **`begin`**: the machine makes a key for this job and signs it with its
   enrolment key, over the job, the address, the pin and the key. The phone
   checks the signature against the fingerprint it approved for the vault,
   or asks the person to compare it with `fleetwright-sidecar identity`.
4. **`run`**: the admin sign-in, sealed to that key under
   `fleetwright-xosetup/v1:<job>:<address>`. The machine then runs, reporting
   each as it goes (`XOSETUP_STEPS`):
   connect (pinned) → sign in (must be an admin) → inventory (stops, changing
   nothing, if Xen Orchestra lacks a method setup uses) → the `fleetwright`
   user (a password nobody sees) → its resource set (half of the pool's
   vCPUs, memory and default storage) → a token, minted signed in as that
   user for 180 days (under the half a year Xen Orchestra allows out of the
   box; a server capped lower gives its own default) → updates → hand-off,
   sealing the token back to the phone and keeping nothing.
5. **Updates** come from [XenOrchestraInstallerUpdater](https://github.com/00o-sh/XenOrchestraInstallerUpdater)'s
   own `installer-updates` plugin when the pool has it: loaded, kept loaded,
   and set to update itself daily unless a person had switched that off, in
   which case it is left off and the summary says so. Xen Orchestra stays
   current without the fleet holding an admin credential to do it.

**Run against a real Xen Orchestra**, built from sources with the installer's
update plugin added, every step ran: the pin, the WebSocket, sign-in, the
method list, the user and resource set (made, then found again on a second
run), a token the limited user signs in with and admin calls refuse, and the
plugin turned on, then left alone the second time. That run found two faults
the suite's stand-in had hidden — `/` has no title, and a year-long token is
over the server's cap — and both are fixed. What has not run is a real XCP-ng
pool behind it: that Xen Orchestra had none, so the pool, host and storage
fields the limits are worked out from are checked against Xen Orchestra's
source, not a live answer. The inventory step still asks for the method list
first and stops, changing nothing, if one is missing.

**The coordinator keeps each job in storage**, not memory: on Cloudflare it
is a Durable Object evicted between messages as a matter of course, and a
person reading a fingerprint and typing a password is a gap it is evicted
across.

**Where the token lives is the phone that asked for it**, not the machine
that ran the setup. That machine is only the one that could reach Xen
Orchestra when somebody wanted to add it, and the pool must not stop being
manageable because it was retired, rebuilt or switched off. The first
version wrote the token to a file on it, which made it the one thing holding
the pool's key.

- **The phone makes a key** for the token to come back to and puts it inside
  the sealed sign-in, beside the password, so the coordinator relaying it
  cannot swap in a key of its own.
- **The machine seals the token record to it** at hand-off (the address, the
  pin or plain HTTP, the limited user, its resource set and the token) under
  `fleetwright-xosetup-handoff/v1:<job>:<address>`, its own binding, so a
  sealed token and a sealed sign-in can never be taken for each other. It
  writes nothing to disk, and removes the file the first version kept for
  that pool if there is one.
- **`status` carries the sealed copy** to whoever began the job, once it is
  done, until the machine forgets the job six hours later. Progress events,
  which reach a Lock Screen, never carry it.
- **The phone keeps it** in the iOS Keychain (this device only) or encrypted
  under the Android Keystore key the fleet credential uses, and says so on
  the setup screen only once it has. A phone that was closed at the end
  collects it at its next launch; the private half of its key waits in the
  same store until then.

An app older than this sends no key, and the machine refuses its sign-in
before anything is made in Xen Orchestra, saying to update the app. The other
way round is refused too: a machine older than the hand-off would keep the
token itself, so the phone sends a setup only to a machine whose `begin` lists
what it `can` do (the field came in the release after the hand-off), and
otherwise cancels the job and names the machine to update. Seen: a box with
the new release on disk and a sidecar still running the old one, which
`/update --restart` now fixes ([`packaging.md`](./packaging.md)). Losing
the phone loses the token, not the pool: running the setup again finds the
user and its resource set and makes a new token. This is the phone-direct
model [`manage.md`](./manage.md) sets out for managing the pool; holding the
token on a fleet machine as well, so the pool can be acted on with the app
closed, is the opt-in route that page describes, not the default.

Run against a real Xen Orchestra over HTTPS and plain HTTP: the phone's key
opened the token, the token signed in as the limited user and an admin call
was refused, and the machine's state directory was empty afterwards.

### The policy: what the fleet may use

Setup finishes in one go, with defaults: the resource set it makes holds
each pool's default storage repository and no network, with half the pool's
vCPUs and memory and half the default storage's free space. **It applies
those only when it makes the set.** A set that is already there was made by
an earlier run, or changed since, and running setup again for a new token
leaves it as it is.

Changing it is its own flow, from the app: Machines → Hypervisors → the pool
→ Change what it may use. The Hypervisors list is the pools this phone keeps
a token for, written when it collects one, so a pool set up before the list
existed appears there once it is set up again. It is a job like setup, begun on a machine that
reaches the pool, with the admin sign-in sealed to that job's key, and it
needs that admin sign-in each time, because the limited token cannot widen
its own resource set and must not be able to.

1. **The sealed sign-in says `purpose: policy`**, inside the seal, so a
   coordinator cannot turn a policy change into a setup or the other way
   round. The phone sends it only to a machine whose `begin` said it can
   (`can: ["policy"]`); an older machine would take it for a whole setup.
2. **The machine signs in, reads the pool, and hands the phone its
   inventory**: the storage repositories a disk can go on (not an ISO
   library or a removable drive), with size, free space and whether they are
   shared; the networks, with their VLAN and which one is the way out now;
   the hosts' vCPUs and memory; and what the fleet may use today. Sealed to
   the phone's key under `fleetwright-xosetup-inventory/v1:<job>:<address>`,
   because a network map is not the coordinator's to read. The password is
   gone from the machine's memory as soon as it has signed in; the job holds
   the signed-in session, for at most ten minutes.
3. **The person chooses**: which storage and which networks, which of those
   is the way out, and the limits. Sealed to the job's key under
   `fleetwright-xosetup-policy/v1:<job>:<address>`, phase `policy`.
4. **The machine checks the choice against what it showed**, because the
   phone's screen is not the bound: every id must be one the inventory
   listed, at least one storage repository, the way out one of the chosen
   networks, at least one vCPU, a GiB of memory and ten of disk, and at most
   what the hosts have and the chosen storage holds. A choice that fails is
   refused and the job goes on waiting. One that passes becomes the resource
   set (`resourceSet.set`, its storage, networks and limits), and the egress
   tag moves to the chosen network.

The key the inventory comes back to lives in the screen's memory and
nowhere else, so a screen that is rebuilt while the machine waits (an
Android phone turned, an app closed) can no longer open it, says so, and
offers Cancel. Cancelled, or left for ten minutes, it changes nothing. A policy job sends
no progress events: it is driven from a screen that is open, and its steps
are not onboarding's.

Run against a real Xen Orchestra: the inventory opened with the phone's
key, the choice became the resource set's limits, and a setup run again
afterwards left them as they were. That Xen Orchestra has no pool behind it,
so the storage was a stand-in and no network was tagged; `tag.add` and
`tag.remove` are checked against the methods it lists, not a live network.

### The path it used last

A change of policy used to start from nothing every time: "Asking your
machines…", then the machine, then the certificate question, then the
sign-in. The phone now remembers where it worked.

- **The machine that got through**, by address, once a job on it has passed
  `sign-in`. The policy screen opens on that machine and asks nobody else.
  It takes that path only when the certificate needs no one's word (it
  checked out when the pool was set up) or has the person's kept word, below.
  Otherwise every machine is asked as before, and the remembered one is
  chosen from the answers when it is among them. If it refuses `begin`
  (switched off, gone from the fleet), every machine is asked at once and
  the reason stays on screen. If it fails at `connect`, Try again asks
  every machine and shows the certificate in full. The machine still holds
  the sign-in to the pinned certificate, so a server that changed fails
  with nothing sent to it.
- **The sign-in and the person's word for the certificate**, only when they
  turn on *Keep on this phone*:
  - **iOS:** a Keychain item per address that opens to Face ID or Touch ID
    and nothing else (`.biometryCurrentSet`, `WhenPasscodeSetThisDeviceOnly`,
    `XOSaved.swift`).
  - **Android:** encrypted under a Keystore key of its own that needs a
    strong fingerprint or face check for every use and is retired by a new
    enrolment (`XoSaved.kt`). It is not the fleet credential's key, which
    opens on a locked phone so a notification can be answered.
  - It is written only once the machine has signed in with it, so a mistyped
    password is never the one kept. A kept password that then fails at
    `sign-in` is forgotten, and the screen says so.
  - The acceptance is kept as the fingerprint that was accepted, or as
    "plain HTTP", so it stands for that certificate and no other. A server
    that answers with a different one is asked about in full.
  - Turning the switch off forgets it then.

The fleet never sees any of it. What leaves the phone is what always did:
the sign-in sealed to one job's key on one machine.

**The way out is where the edge router goes.** The policy's way out is the
network the edge OPNsense VM puts its WAN on, recorded as the
`fleetwright-egress` tag on that network. With *Build the edge router on it*
on, Apply builds the router there (["The uplink"](#the-uplink)); the phone
shows the machine's progress under "Applying what you chose", from the
download to the disk. The machine running the job needs `bzip2`, and says
which package to install when it has none.

### Next: deploying Xen Orchestra, and the phone's own network

- **A pool without Xen Orchestra** is deployed with the same installer's
  `xo-remote-deploy.sh`, which already does the hard part over SSH to the
  pool master: a checksum-verified cloud image cached on the storage
  repository, a VM made with cloud-init that runs `xo-install.sh`, and
  progress read back through xenstore so nothing needs to reach the VM. The
  same image cache and cloud-init path builds the templates and the dedicated
  machine. It needs the pool master's root password, sealed the same way.
- **No machine in the fleet can reach the pool**: the phone's own network
  carries the first minute. The phone relays bytes between a machine and
  Xen Orchestra over TLS the machine terminates, so neither the phone nor the
  coordinator reads the sign-in; that first minute makes the dedicated machine
  on the pool, which joins the fleet and runs everything after it with the
  app closed.

### Without any host yet

One line on the pool master's console, which shows a pin minted in the app
for it:

```sh
curl -fsSL https://<coordinator>/xcp-ng | bash -s -- <pin>
```

It runs there with `xe`, which needs no credential at all. It is the path for
a fleet whose first machine is the pool.

### What the script does, in order

Each step finds its object by the `fleetwright` tag before making one, so the
script can be run again after a failure, or to repair, and does only what is
missing:

1. **Xen Orchestra**, if there is none: deploy it.
2. **The `fleetwright` user**, a password nobody sees, its **resource set**
   (the templates, networks and storage it may use, and quotas sized from
   what the pool has free), its ACL, and a token for it.
3. **`fleetwright-uplink`**, and the **edge router** in front of it.
4. **The templates**, as above.
5. **The hypervisor host VM**, cloned from the Debian template with
   cloud-init carrying a single-use enrolment pin for a **permanent** host.
   It joins the fleet by itself.
6. **The token goes to that host only**, as a vault item granted to it, so
   it is never on a disk outside that VM and never in cloud-init.
7. **The admin credential is dropped.** From here the fleet holds only the
   limited user's token, on one VM.

Xen Orchestra itself, when the script deployed it, is a separate VM from the
hypervisor host on purpose: its admin account must not sit beside the token
whose whole point is being less than admin.

The app shows each step as it runs and what failed if one did, with "Try
again" re-running the script from where it stopped.

### Removing it

Machines → the pool → Remove: every VM, network and template tagged
`fleetwright`, the user, its resource set and its token, the hypervisor host
retired. It needs the admin credential again, for the same reason onboarding
did, and keeps nothing it did not make.

## What this does not do

- **It does not make a VM a long-lived session host.** It is a temporary
  host with a clock, like a runner. A permanent box stays the place for work
  that lasts days.
- **It does not trust the guest.** A session is root in its VM and can do
  anything the VM's networks allow; the bound is the uplink and the resource
  set, not anything inside the guest.
- **It does not inspect traffic for you.** It gives a session a router to
  inspect traffic with. What it looks for is the task.
