# A machine from your own hypervisor

**Status: design. Nothing here is built.** XCP-ng first, through Xen
Orchestra; Proxmox second, behind the same interface.

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

`fleetwright-uplink` is a network the operator makes once, and **it must not
be the management network**, the one Xen Orchestra, the pool masters or
anything else you care about sit on. A VLAN with a route to the internet and
nothing else. Everything a lab does leaves through it, so it is the boundary;
the router inside the lab is the instrument, not the wall.

## Templates, built once

Neither exists yet, so building them is part of the work:

- **Linux.** Start from a cloud-init-ready Debian or Ubuntu image (Xen
  Orchestra's Hub has them), install the Xen guest tools and the fleetwright
  package without enrolling, give the service user sudo, convert to a
  template. A script in `install/` makes this repeatable, so a template is
  rebuilt rather than patched.
- **OPNsense.** Installed once from its image with the Xen guest tools plugin,
  WAN on DHCP, LAN static, the API enabled with the bootstrap key, converted
  to a template.

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
   ticket.
2. **Host:** the Xen Orchestra driver, template and lab files, the expiry
   reaper. Tested against a stand-in JSON-RPC server, because the real one is
   on hardware this repository cannot reach.
3. **Phones:** templates and labs in the new-machine picker.
4. **Docs.**

Labs (step 2 again, with the router bootstrap) come after a single VM works
on the real pool.

## What the operator does once, by hand

- Make the hypervisor host VM and enrol it as a permanent host.
- Make the `fleetwright` Xen Orchestra user, its resource set, and a token
  for it; give the token to the hypervisor host only.
- Make the uplink network, off the management network.
- Build the two templates.

## What this does not do

- **It does not make a VM a long-lived session host.** It is a temporary
  host with a clock, like a runner. A permanent box stays the place for work
  that lasts days.
- **It does not trust the guest.** A session is root in its VM and can do
  anything the VM's networks allow; the bound is the uplink and the resource
  set, not anything inside the guest.
- **It does not inspect traffic for you.** It gives a session a router to
  inspect traffic with. What it looks for is the task.
