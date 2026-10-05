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

**Onboarding makes it, so nobody configures a switch.** It is a private
network inside the pool, and its only way out is a permanent **edge** router:
one more OPNsense VM, `fleetwright-edge`, with its WAN on the management
network and its LAN on `fleetwright-uplink`. Its rules are fixed at
onboarding and never touched by a session: out to the internet, and nothing
to any private, link-local or multicast range, so a lab can reach the world
and cannot reach your LAN, the pool's API or another lab. A pool that already
has a suitable VLAN can be pointed at it instead; nothing requires it.

## Templates, built by onboarding

Neither exists yet, and nobody builds them by hand:

- **Linux.** Debian's official cloud image (the `genericcloud` build, which
  already runs cloud-init) is downloaded, checked against Debian's published
  checksum, converted and imported. A builder VM boots it once with cloud-init
  that installs the Xen guest tools and the fleetwright package without
  enrolling and gives the service user sudo, then powers off and is converted
  to `fleetwright-debian-13`.
- **OPNsense.** Its prebuilt disk image is downloaded and checked the same
  way, and booted beside a small second disk holding a generated
  `config.xml`: interfaces assigned, LAN addressed, the Xen guest tools
  plugin, the API enabled with a bootstrap key only the hypervisor host knows.
  OPNsense's importer reads a configuration from attached media at first
  boot, which is what makes this unattended. **This is the step to prove
  first on real hardware**, because it is the one that rests on an OPNsense
  behaviour rather than on an API.

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
   keeping only the token.
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

**Where the token lives for now** is the machine that ran the setup, 0600 in
its sidecar's state directory. The dedicated machine on the pool, and the
token moving to it, are the next round with the templates.

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
