# Proxmox VE

**Status: built on the boxes and both phones; not yet run on a real cluster.**
A box that holds a Proxmox token looks at the cluster, sweeps what is done,
and makes, hands the login to, restarts, extends, resizes and ends machines
on it, behind the same seam as Xen Orchestra (`src/fleet/host/pools.js`), so
the protocol did not change. Machines may be in a group or alone in an open
or closed lab ("Labs and groups"). The cluster is set up by one script run
as root on a node (`install/fleetwright-pve-setup`): a person runs it from
the command both phones show under Hypervisors › Add a hypervisor › Proxmox VE and pastes the line it
prints ("By hand"), or presses Set it up ("One way in"): the phone runs it
itself over SSH ("From the phone"), or, for a node the phone cannot reach,
one of the person's machines that can runs it for the phone ("Through a
machine"). **Not built:** the
direct path's steps on the Lock Screen, and the pool page's own actions. **Run on a real node** through a machine as far as
building the image; a run seen to its end, and a machine made on a real cluster, are not yet. The tests run the driver against a stand-in
Proxmox over real TLS (`test/pve-pools.test.js`).

## What XCP-ng taught

XCP-ng through Xen Orchestra is built and works, and the work of building it
is the reason this one is shaped differently. Read back across
`docs/hypervisors.md`, its 9,000 lines of host code and the 2,565-line
`AddHypervisorView.swift`, these are the costs that came from the shape, not
from any one bug:

| What it cost | Where it came from | What Proxmox does instead |
|---|---|---|
| **The admin password crossed the fleet, again and again.** Add a pool, change its policy, reconnect its servers, remake its machine: each one is probe every box, pick one, compare a key fingerprint, seal the admin sign-in, wait. Four modes on one screen. | Xen Orchestra cannot make a limited user or change a resource set without an admin, so every change needed one | **No admin credential leaves the node.** A root shell on the node makes everything once, and the fleet only ever holds a token born limited |
| **The bound leaked.** The limited user was measured to see every object, copy its snapshots to templates outside the quota, read other VMs' `xenStoreData`, and export disks (`hypervisors.md`, "What Xen Orchestra lets whom do"). Each leak became code: `fleetSetOf`, the `fleetwright-edge-keys` user, list checks beside every tag | A resource set is a quota with permissions bolted on, and some methods do not check it | **Proxmox's ACLs are the bound, and the box reads them back.** Every look asks `/access/permissions` and reports any privilege wider than the fleet needs, by path (`wide`). A leak is something the app can show you |
| **Policy was a form in the app** that mirrored the hypervisor: storage, networks, the way out, groups, labs, grants, limits, one Apply at the bottom, a ten-minute window, and the admin password to open it | The fleet kept its own idea of what it may use, which had to be kept in step with Xen Orchestra's | **What the fleet may use is what Proxmox lets the token use.** Storage it may allocate on, bridges it has `SDN.Use` on, templates in its pool. Change it in Proxmox, or run the script again; the next look says so. No form |
| **A pin to one certificate**, which broke the day it was renewed, and could not reach a second host | Xen Orchestra's certificate is one leaf, often self-signed | **A pin to the cluster's own CA** (`/etc/pve/pve-root-ca.pem`), which signs every node's certificate and survives `pvecm updatecerts`. A certificate another CA signed is refused before the token is written (`pve-api.js`) |
| **The fence lived inside the guest** (nftables in `fleetwright-net`), which root on the machine can undo, so a whole OPNsense edge router had to sit in front | XCP-ng has no per-VM firewall the limited user could set | **The fence is Proxmox's firewall, on the bridge.** A cluster security group the script makes, applied to each machine by the box. Nothing inside the VM reaches it |
| **An intermediary to install and keep alive.** Installing Xen Orchestra, its updater plugin, the reconnect watchdog, "when a pool goes missing" | XCP-ng's own API is not what the fleet talks to | **Proxmox's API is on the node.** Nothing to install, nothing to reconnect |
| **A dozen tag prefixes as a database** (`until:`, `made:`, `for:`, `busy:`, `on:`, `from:`, …) | Tags were the one field the limited user could write | **One JSON line in the machine's notes** (`MARK`), and one tag so a person can find the fleet's machines in Proxmox's own tree |
| **Gigabytes through the fleet** to build images: qcow2 read out and uploaded by a box | Xen Orchestra would not import compressed images | **The node builds the image itself**, from Debian's published image checked against its SHA-512, in the setup script |

What stays exactly the same, because it was right: the token in the person's
vault and in memory only on the boxes they approved; the image and network
checked against what the box itself saw; the ticket single use and said when
spent twice; the Claude login never on the machine's disk or drive, handed
sealed once it has joined; the clock on the machine, swept by any box.

### Where Proxmox is weaker, said plainly

- **No quota.** A Proxmox pool has no limits on vCPUs, memory or disk. The
  token can make as many machines as the storage holds. The fleet caps each
  machine's life at 350 minutes and the sweep removes them, but nothing on
  Proxmox's side holds it to a number. Xen Orchestra's resource set did.
- **The fence needs the datacenter's firewall on.** It is off by default in
  Proxmox. While it is off the group holds nothing back, the look reports
  `fenced: false`, and **a machine is not made on the default network**: only
  on a network the person chose for it (`make`). The script turns it on only
  when asked (`--enable-firewall`), because it is the person's datacenter.
- **The firewall isolates; it does not show anything.** A machine behind
  `fleetwright-fence` cannot reach your network, and nothing records what
  it did reach. Inspecting traffic needs it to pass through something that
  looks: a router VM in front of it, which is what XCP-ng's edge router is,
  or a mirror of its interface on the node (Open vSwitch's port mirroring,
  or `tc mirred` on a Linux bridge) into a capture. Neither is built here,
  and Xen Orchestra's "Seeing what crossed a lab" is not built either.
- **The ticket is readable** by anybody holding the token, in the machine's
  `smbios1`, for the machine's life; Xen Orchestra's cloud-init drive was
  destroyed five minutes after boot. The ticket is single use, lives fifteen
  minutes, and a second spend is refused and takes the machine out
  (`hypervisors.md`, "How a clone joins").

### What a live cluster taught

Measured against a running Proxmox VE estate by another integration
of ours, before any of this was written, and built in rather than found again:

- **200 is "a task was queued", not "it worked".** Start, stop, shutdown,
  clone and delete answer with a UPID even for a VM that does not exist; the
  outcome is only in the task's `exitstatus`. Every one of those here waits
  for it (`PveApi.waitTask`).
- **`POST …/config` is a task too; `PUT …/config` answers when it is done.**
  The first version here wrote a clone's join with POST and did not wait, so
  a refused write would have started a machine that could never enrol. Every
  config write is a PUT now, and the stand-in serves no other.
- **A config change on a running VM goes to `pending`**, not live. A resize
  here stops the machine first, changes it, and starts it again, so the size
  it reports is the size it runs at.
- **`+` in a form body is a space.** Every body is URL-encoded
  (`formOf`), so a key or a size with a `+` arrives as written.

- **A Cloudflare Worker cannot reach a node's private address or accept its
  self-signed certificate**, which is why that integration goes through a
  tunnel. A Fleetwright box is on the network and runs Node, so it reaches
  the node directly and trusts its CA; a cluster reached through a tunnel
  with a public certificate is the `public` trust, and works the same.

## Which Proxmox

**Proxmox VE 9 and newer, and nothing older.** One API and one set of
privilege names to be right about, rather than three, each with its own
fallbacks that nothing here can test. The setup script refuses a node older
than 9 before it changes anything, and the box reports a cluster's version
on every look (`supported`) and makes no machine on one older than 9,
saying which version it found. A cluster on an older one is upgraded first.

## Setting it up

### One way in

**Built in both apps**: Machines › Hypervisors › Add a hypervisor › Proxmox VE, the node's address and
its root password, and **Set it up**. Asked for: *"the route through a
machine and main direct route can be combined"*, and when both can reach
the node, **the phone goes first**, so the password goes to the node and
nowhere else:

1. The phone asks the node for its host key, which is also whether it
   reaches the node at all.
2. **It reaches it**: the direct route below, with the host key checked once.
3. **It does not**: the machine route below opens with the address and
   password already in it, asks the machines at once and chooses the first
   that reached the node; any other is one tap away. The host key that
   machine saw is checked there, and the password is sealed to it alone.

There is no separate row for the machine route any more. **Either way the
screen may be closed** while it runs, and the line is kept in the vault
when the app is next in front or launched:

- **Through a machine**, the key the line comes back sealed to is kept on
  the phone (`ProxmoxThroughHandoff`, below).
- **From the phone**, the run on the node goes on by itself, and what
  needed the screen was reaching the node again to read the line, which
  takes the root password. **So while a run is going, the password is kept
  on the phone**: in the Keychain on iOS (this device only), in the app's
  encrypted store on Android, beside the checked host key and the node's
  clock (`ProxmoxDirectHandoff` in both apps). It is wiped when the line is
  in the vault, when the run fails, or after six hours, and it still goes
  nowhere but the node. A line read and not yet kept is held the same way,
  because reading it removes it from the node.

Opening the screen again follows a run it left.

### From the phone

When the phone reaches the node, it does the rest itself, with no machine
of the fleet in the path (`ProxmoxSSH.swift`, `ProxmoxSsh.kt`):

1. **The host key** is read and nothing is sent. The phone shows
   its fingerprint, as `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`
   prints it on the node's console, and the person says it matches. It is
   kept for that address; a later run goes straight through, and a node
   answering with another key is refused and said, with nothing sent.
2. **Set it up** signs in as root, reads the node's clock, and starts the
   same command the by-hand path shows, with `--line-file`, as
   `systemd-run --unit=fleetwright-pve-setup`, so a locked phone does not
   kill the image build. A run already going is stopped first.
3. **It follows the job** every three seconds while the screen is open: the
   `fleetwright-step:` lines since that clock, read from the journal, the
   last `fleetwright-part:` line of the step it is on (below), and
   `fleetwright-error:` as the sentence when it stops. A poll that fails is
   said and tried again; the job does not depend on the phone.
4. **The line**, which is the token, is read from the file only root reads,
   removed, checked as the boxes check it, and kept in the vault as
   `hypervisor:<address>`.

Both apps send the same commands, which `test/pve-pools.test.js` holds
equal, along with the options and lines the script must have for them.

**Two departures from the first plan**, said plainly. The phone runs the
same `curl … main` the by-hand path does, rather than writing a copy of the
script from its own bundle: one source for both, and no second copy in two
app bundles to keep in step. And **the steps are on the screen only**, not
yet on the Lock Screen or in Android's ongoing notification as Xen
Orchestra's setup is: a person who leaves the screen sees the end by
opening it again, or finds the cluster in their vault.

**On iOS it is Apple's own swift-nio-ssh**, and not a client built on it:
the usual one (Citadel) now takes its SSH layer from a personal fork, and
what this sends is a root password. On Android it is sshj on the full
BouncyCastle.

### Through a machine

**Built in both apps**, as where Set it up goes for a node the phone cannot
reach itself, which is the usual case away from home.
Asked for in those words: *"If phone can not ssh directly why not ssh
through one of the nodes that it can reach? Same as all the other things we
did?"* So it is the same as the others (adding the reconnect watchdog is the
one it is modelled on, `docs/hypervisors.md`), with nothing new in how a
secret crosses the fleet:

1. **`xoprobe`** asks every permanent machine whether it reaches the node,
   and its `ssh` says which answered SSH and with which host key. Machines
   that can work there are offered; one is chosen.
2. **The host key** that machine saw is shown with the command that prints
   it in the node's own Shell, and the person says it matches. That is the
   pin; a node answering with any other key is never sent the password.
3. **`xosetup pve`**: the machine makes a key for this job alone and signs
   it under `pvesetup-key`, over the node's address, the job and the pin.
   The phone checks it before anything is sealed, and compares the machine's
   fingerprint when its vault has not vouched for it, as an install does.
4. **`run`**: the root password and a key of the phone's for the line to come
   back to, sealed under `pvesetupAad`, so the coordinator relays what it
   cannot read. The machine opens the SSH connection an install opens
   (`openPool` in `xo-deploy.js`: the host key held to the pin, the password
   answered once through its askpass and wiped) and runs on the node exactly
   what the phone runs from "From the phone", which `test/pve-pools.test.js`
   holds equal across the host and both apps (`src/fleet/host/pve-setup.js`).
5. **Progress** is `PVESETUP_STEPS`: `node` (the connection and the start),
   then the script's own steps as it says them in the journal, with how far
   into the step it is (below). It reaches the screen, the Lock Screen on
   iOS and the ongoing notification on Android, under its own titles.
6. **The line** is read from the root-only file once, removed, checked as
   the boxes check it, and sealed back to the phone's key under
   `pvesetupHandoffAad`. The machine keeps no copy, and holds the sealed
   copy six hours, as every finished setup job is held.

**A cancel or a failure stops the unit on the node**, which the script is
written to be run again after: it finds what it made first.

**The screen may be closed while it runs.** Asked for, from a phone held on
"Step 7 of 8" for ten minutes: *"Why no background processing why do I need
to wait there"*. The key the line comes back to is kept on the phone under
the job (the Keychain on iOS, the app's encrypted store on Android), as a
Xen Orchestra setup's is, until the line is in the vault
(`ProxmoxThroughHandoff` in both apps). Whichever comes first collects it:
the screen seeing the job end, the app coming back to the front, or a
launch. A keep the vault refused is tried again at the next of those for as
long as the machine holds the copy; after six hours the key is dropped,
because there is nothing left for it to open.

### How far into a step

Asked for in the same breath: *"Where is step progress?"* The image is most
of the wait, and "Step 7 of 8" said nothing for ten minutes. The script now
prints, beside its step lines,

```
fleetwright-part: FILL TEXT
```

where `FILL` is thousandths, or `-` when nothing was measured, and `TEXT` is
what it is doing. The poll keeps only the last one of the step it is on
(`pollCommand` in `pve-setup.js`, the same text in both apps), and the phone
draws a bar only for a measured `FILL` (C-5):

- **The download**: the image's size asked first, then the file watched
  grow, as "180 of 416 MB". A server that does not say the size is said as
  what has come so far, with no bar.
- **The build**: its cloud-config writes `fleetwright-build: up`,
  `fleetwright` and `off` to the build machine's serial console as it
  reaches each stage, and the script reads the console's socket for them:
  installing packages, installing Fleetwright, powering off, with the
  minutes so far. Until the first marker it says only the minutes, never a
  stage it has not heard. The reader is a process of its own, so nothing
  it meets stops the setup.

**A build that fails says why, and is removed.** The first real run waited
25 minutes on a build VM that never powered off, and said only that. Now
the reader keeps every line the build machine's console prints, the build's
own script writes `fleetwright-build: failed` when any command in it stops,
and the setup stops waiting the moment it hears that. Its error is the
console's last line that reads as one ("E: …", "error", "could not…"), or
its last line, and the build VM is then destroyed, since it can be used for
nothing and holds its number and memory. **Leftovers go too**: the image
step begins by removing any VM in the pool tagged `fleetwright-build` that
is not a template, which only this script makes, so a run that was stopped
or failed before this change is cleaned up by the next. A cancel removes
the build it interrupted.

Through a machine, the words go after the step's ("Building the machine
image: downloading…") and the bar is the job's `fill`, which the Lock Screen
and Android's notification already draw for an install's download.

### By hand

The same script in a root shell on any node (Datacenter › the node › Shell
in Proxmox's own web interface):

```
curl -fsSLo /root/fleetwright-pve-setup https://raw.githubusercontent.com/TheTechNetwork/Fleetwright/main/install/fleetwright-pve-setup && bash /root/fleetwright-pve-setup
```

prints the line at the end. **This is built in both apps**: Machines › Add
Proxmox VE (or "It is Proxmox VE" on the Xen Orchestra setup) shows the command to
run, which fetches the script from this repository's `main`, and takes the
line. It keeps the line in the vault as `hypervisor:<address>`, and the
boxes pick it up on their next vault pass, within ten minutes.

### What it makes

Finding each first, so it is safe to run again:

1. the pool `fleetwright`;
2. the user `fleetwright@pve` with no password, and four roles: `Fleetwright`
   on the pool (`PVE_ROLE_PRIVS`), `FleetwrightStorage` on one storage,
   `FleetwrightNet` on one bridge, and
   `FleetwrightAudit` (`Sys.Audit`) on `/` alone, not propagated, to read
   whether the firewall is on;
3. a token, which lasts a year by default; running the script again makes a
   new one and the old one stops working;
4. the firewall group `fleetwright-fence`: SSH in, DHCP and DNS out, then
   nothing private out (RFC 1918, CGNAT, link-local, IPv6 ULA);
5. the machine images: Debian 13's cloud image unless more are chosen, each
   pinned and checked, booted once to install Fleetwright from apt, left
   unjoined and turned into a template, one for each (below);
6. one line, `fleetwright-pve:1:…`: the address, the token, the pool and the
   cluster's CA. A web interface given a certificate of somebody's own is
   trusted as a browser would trust it when a public CA signed it (ACME), or
   by that certificate's file when the file holds its own root; any other is
   refused at setup, because reaching it would mean turning the chain check
   off.

   A publicly trusted certificate at an IP is checked as the name it was
   issued to. The line gives the address as an IP, and the certificate names
   a host, so a browser's check against the IP refused it on every box. Asked
   for, as *"use the IP or host file resolution or something like that to its
   dns name"*. The script reads the name from the certificate: the node's own
   name when it is covered, else the first name the certificate lists, else
   the node's name under a wildcard for its domain. The line carries it as
   `name`. A box dials the IP and holds the certificate to that name, which
   is what a hosts-file entry does, but for that one connection, with no DNS
   and no system file changed. It is exactly as strict as a browser opening
   `https://name`. A self-signed certificate is never accepted as such: the
   setup trusts the cluster's own CA, or a file that holds its own root,
   and nothing else.

   The line carries the certificate blocks alone, with plain line ends,
   whatever else the file around them held. A box reads any certificate
   field the same way. One that still cannot use a line says which part was
   wrong, in the setup's own words when it was handed the line, and in its
   journal when the vault gave it one, once, while the record stays wrong.
   The first real node's cluster stayed invisible because the box dropped
   its record without saying so.

**Every option is in the app** (asked for: *"Everything should be in
app"*): Add Proxmox VE › Options has the datacenter firewall, the machine
images (keep them, build them again, or none, and which systems), the update channel, the storage,
the bridge, how long the fleet's token lasts, and the group and lab
networks. Each defaults to the script's own default, and only what differs
is passed, on the phone's route and sealed through a machine alike
(`pveOptionsOf`, `optionArgs` in pve-setup.js). A cluster whose datacenter
firewall is off offers **Turn on the datacenter firewall** on its page,
which opens the same setup with that option on. Proxmox VE's own rules keep
the nodes' web interface, SSH and cluster traffic open to the local network
once it is on, and other traffic coming in to the nodes is dropped, which
the option says.

**Which systems.** Asked for: *"Other images Ubuntu Rocky or whatever else
maybe even windows"*. Options › Machine images has a switch for each system
the setup can build: **Debian 13**, **Ubuntu 24.04 LTS** and **Ubuntu 26.04
LTS**, the same catalogue Xen Orchestra pools build from
(`src/fleet/host/vm-image.js`, `IMAGES`). Each chosen becomes its own
template, and New session › Where offers a machine from each, named as Xen
Orchestra names them ("Fleetwright Ubuntu 24.04"). By hand it is `--images
debian-13,ubuntu-24.04`; Debian 13 alone is the default, so a run that names
none builds what every run built before. Each is its publisher's own cloud
image, pinned by its published checksum (SHA-512 for Debian, SHA-256 for
Ubuntu). The script carries the pins in its own table, `pinned`, which
`test/pve-pools.test.js` holds equal to the catalogue, and
`scripts/pin-images.mjs` moves both when Renovate brings a new build. An
image already on the cluster is kept and built again only with **Build them
again**; one not chosen this time is kept too and said so, because machines
may be made from it.

**Not Rocky, not Windows, yet.** Every image installs Fleetwright from the
fleet's apt repository, and a machine updates along it. Rocky (or any
RHEL-like system) needs an RPM repository of the same package, which the
fleet does not publish; Windows needs a Fleetwright host for Windows, which
there is not. Either is a new row in the catalogue once that exists, and
neither is offered before, because a choice that cannot be built is worse
than none (C-2).

Its options: `--address`, `--storage`, `--bridge`, `--enable-firewall`,
`--channel stable|rolling`, `--images LIST`, `--no-image`,
`--rebuild-image`, `--expire-days`, `--line-file`, `--coordinator`,
`--vmids FROM-TO`.

Running it again keeps the images it made, found by their `fleetwright-image`
tag and told apart by `fleetwright-os-<key>` (an image from before there was
a choice carries no such tag and is Debian 13), and keeps one of each: a
second copy is removed and the newest kept. The tags are
read from `/cluster/resources`, by the script and by the boxes alike. A pool's
own listing, `/pools/<pool>`, carries no tags in Proxmox's answer: read there,
the first real node's template was never found, so the next run built another
and no box ever offered it.

The snippets the images boot with, the privileges and the image pins are
written in the script, which has no Fleetwright to import them from, and in
`pve-pools.js`; `test/pve-pools.test.js` holds the two equal.

### Where a cluster shows

Machines › **Hypervisors** lists it beside any Xen Orchestra pools, with what
each machine holding its token saw: reached it, could not and why, or has not
looked yet (`hypervisors.md`, "One page"). Its page lists them machine by
machine, with the version, the fence, the image and the machines on it, and
**Set it up again**. A cluster that no machine reaches shows here with the
reason. Before this page it showed nowhere: the first real node's line sat in
the vault, refused by every box, and nothing said so.

### Machine numbers

Asked for: *"vmid range user deserves a choice"*. Add Proxmox VE takes an
optional **Machine numbers**, such as `9000-9099`, kept for the next time;
by hand it is `--vmids 9000-9099`. The image is built at the first free
number in it, and the line carries it (`vmids: { from, to }`), so every
machine a box clones takes the first number in it the cluster says is free
(`/cluster/nextid?vmid=N`, at most 64 asked per machine). A full range is
said, with nothing made. Left empty, numbers are the cluster's next free
ones, as before. The machine running the setup for a phone checks it is
digits and a dash before it goes into a command (`VMIDS_RE`), and the script
and the boxes hold it to Proxmox's bounds again.

## How a machine is made

1. The coordinator asks a box for `provision { platform: vm, template }`
   exactly as for Xen Orchestra. The template is a UUID this box made for the
   Proxmox template (`pveIdOf`: the address, its number, and when it was
   made, so one made again under the same number is another image).
2. The box clones it into the pool under a free number, retrying if another
   box took the same one, with its mark in the notes.
3. It writes the join (coordinator, ticket, owner, the backstop) into the
   clone's SMBIOS serial, keeping the clone's own UUID; your SSH keys through
   Proxmox's own cloud-init; and the interface on the image's bridge, or the
   one you chose, with the firewall on.
4. On the default network, the machine goes behind `fleetwright-fence`:
   inbound dropped but SSH, outbound to the internet and nothing private.
5. It starts. The template's vendor snippet copies the serial, as root, where
   `fleetwright-vm-join` takes it from, and the join is the one Xen
   Orchestra's machines run.
6. Anything that fails after the clone removes the clone.

## Labs and groups

The same three things Xen Orchestra's pools offer (`hypervisors.md`,
"Machines that work together" and "Labs"), promising the same and no more,
held by the cluster's own firewall instead of an edge router.

**The networks are the setup's**, because only root can make an SDN
network and the fleet's token may use one, never make one: the reason Xen
Orchestra's policy job made them with the admin sign-in. `--groups`,
`--labs-open` and `--labs-closed` (two, one and one by default; four labs at
most) make, in two simple SDN zones:

- **group networks** `fwgrp1` to `fwgrp4` in `fwgrp`: no address of the
  node's on them, so nothing reaches them but their machines;
- **labs** `fwlab1` to `fwlab4` in `fwlab`, each `10.250.<n>.0/24` with the
  node at `.1` doing NAT, its kind in the VNet's alias
  (`fleetwright-lab:open` or `:closed`), and dnsmasq on the node handing out
  addresses from `.100` and answering names: for the open labs from the
  node's own resolver, for the closed ones only the fleet's coordinator and
  the hosts Claude cannot work without (`REQUIRED_HOSTS` in
  `src/core/egress.js`, the list the edge router uses), and the names under
  each. Every other name a closed lab asks is refused. A datacenter rule lets
  the labs ask the node for names and addresses when its firewall is on.

The token is given `SDN.Use` and `SDN.Audit` on each, and the box finds them
by those grants and the VNet's alias; a lab VNet whose alias names no kind is
not offered, since what it reaches could not be promised.

**A machine in a group** gets a second interface on the group network, with
a MAC and an address in `10.200.0.0/16` from its ticket's id, moved past any
other machine in the group has (`groupPlace`, shared with Xen Orchestra), set
by Proxmox's own cloud-init (`ipconfig1`) before anything inside listens.
Its firewall lets everything in and out on that interface and then puts it
behind the fence as usual, so it reaches the others in its group and is
still closed to every other machine. Names over mDNS need avahi, which
images built from this change carry; an image built before has addresses
and no names until it is built again (`--rebuild-image`). A group network in
a simple zone is local to one node, and a cluster's machines are made on the
node their image is on, so a group's machines meet there.

**A machine in a lab** is alone on it: the box takes only a lab it saw
empty, and looks again once the machine is up, removing its own if another
box made one there first. Its firewall, outside its reach:

- **open**: names from the lab's gateway alone, then the fence, so the
  internet and nothing private;
- **closed**: names from the lab's gateway alone (which answers only the
  fleet's and Claude's), DHCP, HTTPS to an address set on the machine
  (`fwallow`) and nothing else in or out. The box fills the set with what
  those names resolve to before it makes the machine, refusing when none
  resolves, and adds to it on every look, never taking away.

**Where it is weaker than the edge router**, said plainly: no Suricata
watches a lab, and nothing records what a machine reached; a closed lab's
HTTPS goes to addresses, so a name of Claude's that moves to an address the
box has not resolved yet is unreachable until the next look. The scoped
ipset name the rule uses (`+guest/fwallow`) and the SDN pieces are written
from Proxmox VE 9's documentation and have not met a real node.

**The phones say which.** `vmImages` carries `kind`, and both phones word a
lab on Proxmox as a network on the cluster, and the default network as
behind the cluster's firewall, not behind an edge router.

## The phones: one screen per thing, no wizard

**Add Proxmox VE is built to this shape on both phones**, and not to
`AddHypervisorView`; the cluster's page below is not built yet.

**Add Proxmox VE** is one screen: the node's address and its root password,
and Set it up. Then the host key, once, and the steps as they happen. When
the phone reaches the node there is no probe of every box, no machine to
pick and no fleet machine's fingerprint to compare. When it does not, the
same press goes to a machine, chosen for the person and changeable, and
that machine's key is the one thing added. Pasting a line made by hand is
the other way in, on the same screen.

**The cluster's page** is the component row from `manage.md`, read from the
health entry, three sections and no form:

- *What it is*: address, Proxmox version, pool, which box last reached it
  and when.
- *How it is*: one line each, worded, never colour alone. **Fenced** or
  **Not fenced: the datacenter firewall is off** (C-5: `null` is "could not
  tell", never "fenced"). **Token as designed**, or **Token can do more than
  the fleet needs**, with each path and privilege from `wide`. The images, the
  networks, and the machines, each machine row the same shape as a Xen
  Orchestra one.
- *What it can do*: **New machine here** (opens New session › Where with this
  cluster chosen), **Run setup again** (copies the command), **Forget**. Each
  only when it works: no New machine while there is no image, and the
  sentence says why instead.

Changing what the fleet may use is not on the phone, because it is not the
fleet's to change. The page says what Proxmox grants and links to where it
is changed.

## One seam

`src/fleet/host/pools.js` puts `XoPools` and `PvePools` behind the face the
sidecar already called. A record says which it is: Xen Orchestra's carry no
`kind`, and `xo-pools.js` passes over any that does. The health frame's
`xo[]` carries both, a Proxmox entry with `kind: "proxmox"`, `fenced` and
`wide` beside the fields they share. `make` goes to the driver that saw the
image; `handLogin` and `control` to Xen Orchestra's first and Proxmox's when
it answers `notHere`, and an `unreachable` from either is kept.

## Not built

- The direct path's steps on the Lock Screen and in Android's ongoing
  notification. Through a machine has them; from the phone itself does not.
- The cluster's page described above: its fence, its token's width and its
  machines are in the health entry, and no screen draws them yet.
- The pool page's actions on the cluster (`xolook`, `xoact` are Xen
  Orchestra's).
- Machines kept ready (`vmStandby`), which have not been tried against a
  cluster.
- A machine's address on its page: Proxmox has it from the guest agent,
  which needs `VM.GuestAgent.Audit`.
