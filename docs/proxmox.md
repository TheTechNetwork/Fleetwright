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
  `fleetwright-fence` alone cannot reach your network, and nothing records
  what it did reach. **The edge router** (below) is what looks: the same
  OPNsense router a Xen Orchestra pool has, filtering names and watching or
  dropping threat traffic. A lab on Proxmox is still behind the firewall
  alone, and Xen Orchestra's "Seeing what crossed a lab" is not built either.
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

**Storage and bridge are picked, not typed.** Asked for: *"Why not list
networks and storage instead of asking blindly"*. Under the options, **List
the node's storage and bridges** checks the node's key as Set it up does,
signs in, and runs one read-only command (`pve-setup.js`, `CHOICES_FIND`):
the storages on that node that hold disks and are enabled, with what is free
and whether each is shared, and its bridges, with the node's address and
comment on each. The two fields become lists, still starting at **Found by
itself** and **vmbr0**, which is what leaving them empty always meant. A
node that lists nothing, or cannot be read, keeps the fields to type in,
and so does the route through a machine, where the phone never signs in.

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

### The cluster's page

A cluster's page on the phones is a Xen Orchestra pool's page in shape, card
for card, because the two side by side were *"Two completely dif UIs"*:

1. **How it is**: the one sentence (Ready, and which machines make machines
   on it, or what is wrong), with the facts the machines could tell under
   it: its Proxmox VE version, its pool, whether the datacenter firewall is on.
2. **Edge routers**: the very card a pool's page has
   (`EdgeRoutersCard` on iOS, `EdgeCard` on Android), one word per router and
   its DNS, opening the routers' page. A cluster adds one line of its own,
   running and whether they drop or log, and says so before any machine has
   read them. Where it has none, the card says that.
3. **Machines**: the machines that reached it, a card each, as a pool's hosts.
4. **Its own machine**: its name and whether it runs.
5. At the foot, what can be done, each with what it costs: **Make the edge
   router again**, **Make its own machine again**, **Turn on the datacenter
   firewall** where it is off, and **Set it up again**.

`test/pve-holder-in-apps.test.js` holds both pages to the one card, in the
same place.

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
6. when asked for, a machine of its own (below): a fleet host cloned from
   the Debian image outside the pool, which joins by itself;
7. one line, `fleetwright-pve:1:…`: the address, the token, the pool and the
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

### The edge router

Asked for: *"no firewall logs blocking or DPI that's all things we worked
hard on in xen"*. The setup's step `edge` (`--edge`, or `--edge-block` to
drop what the threat rules match) makes **the same router a Xen Orchestra
pool has** (`hypervisors.md`, "The edge router" and "What the edge
filters"): OPNsense with no login, Unbound refusing names on abuse.ch
ThreatFox and Hagezi's threat feeds, no other resolver reachable, nothing
private reachable, and Suricata with the four Emerging Threats Open rule
files, logging, or dropping inline.

- **The same image and the same configuration.** The fleet's own OPNsense
  build (`EDGE_IMAGE`), downloaded by the node and checked against its
  pinned SHA-256, and a configuration the boxes' own `edgeConfig` builds:
  the setup has no Fleetwright to build one with, so the two it can be given
  (filtering, and dropping) are built by `scripts/build-pve-edge.mjs`, kept
  beside the script and pinned in it. The script writes the configuration
  into the image with the same edits the boxes make on Xen Orchestra, each
  byte checked against what must be there before it is replaced.
- **For virtio**: its WAN `vtnet0` on the setup's bridge, its LAN `vtnet1` on
  `fwedge`, a network of its own with no address of the node's on it, and
  QEMU's guest agent as the plugin its daily update keeps, so Proxmox shows
  its addresses.
- **Outside the pool**, as the cluster's own machine is, so the token can
  neither change nor remove it, and seen by it with `VM.Audit` on it alone.
- **Machines go behind it.** While it is up, a machine made on the default
  network goes on `fwedge`, still behind the cluster's firewall too, so it is
  made even where the datacenter's firewall is off: the router's own rules
  hold it to the internet. A router that is off is no way out, and nothing
  is put behind it.
- **Running the setup again keeps it**, and starts it if it is off. Changing
  whether it drops, or **Make the edge router again**, builds a new one and removes the old
  once the new image is ready, so machines lose their way out only while
  the new one starts.
- It needs about 4 GB free in `/var/tmp` on the node while it is built. An
  edge that cannot be built says why and costs the cluster its edge, not its
  setup: the token's line still comes at the end.

**On the phones** it is an option of the setup, **An edge router**, on unless
turned off, with **Drop what the threat rules match** under it, and a section
of the cluster's page: the **Edge routers** card, saying running and whether
it drops or logs, or off, and at the foot of the page **Make the edge router
again**, or **Make the edge router** where a box looked and saw none.

#### Watching it

Asked for: *"Keep going, build the edge logs"*. The router is **watched the
way a Xen Orchestra pool's are** (`hypervisors.md`, "Watching the edge
routers"): a box reads its CARP, Unbound, gateway and lease status over its
API every half minute, and hears its syslog (CARP, Unbound, dnsmasq, the
gateway monitor, Suricata's alerts and drops) as it happens. The phone shows
the same card on the cluster's page and the same page behind it.

- **The key and the certificate are made on the node**, with OpenSSL, the
  first time a router is built (`watch_keep`): a user `fleetwright-watch`
  with one API key and the status pages alone, refused every change to the
  configuration, and a P-256 certificate for the web interface whose SHA-256
  the box holds the connection to before the key is sent. They are kept in
  `/etc/pve/priv/fleetwright-edge-watch.json`, which only root reads, so a
  router made again has the same key and the app's record stays right.
- **Written in where the configuration's marks are.** The published
  configurations carry four marks where the watch goes
  (`edge-router.js`, `PVE_WATCH_MARKS`), still pinned by SHA-256; the node
  fills them in (`edge_fill`) and pads to the block the image takes.
  `test/pve-edge.test.js` runs the script's filler and its key-maker and holds
  what they write to the boxes' own `edgeConfig`, byte for byte, the
  password hash from `openssl passwd -6` included.
- **The key travels in the line**, beside the token (`edge`: key, secret and
  pin), which the app keeps as it always has, and hands to the boxes you
  approve for the cluster. A key that is not one costs the router its watch,
  never the cluster.
- **Where it is** comes from its guest agent: the setup gives the token
  `VM.Audit` and `VM.GuestAgent.Audit` on the router alone (role
  `FleetwrightEdge`), and a box asks for the address on its WAN, the
  interface on the bridge. Its API takes HTTPS on that address from private
  addresses only; nothing behind it reaches it.
- **Its logs go to the cluster's own machine**, at the address its guest
  agent reports, which is why the setup now makes that machine before the
  router and waits up to three minutes for one just made to say. With no
  machine of its own running, the router is built sending its logs nowhere,
  and its state is still read. Where the logs go is not a reason to build it
  again: **Make the edge router again** sends them to the machine there now.
- **A router from before this** has no key, and the next setup run makes it
  again once to give it one, as a Xen Orchestra pool's is.
- **Which box reads it**: one that reached the cluster's Proxmox VE, and no
  other, since the router answers on the same network. A box that cannot is
  shown as cannot tell, never as down, in Proxmox VE's words.

**On the phones**, the cluster's page has the **Edge routers** card a pool's
page has, the same card in the same place, second, under the card that says
how the cluster is (asked for on seeing the two pages side by side: *"Two
completely dif UIs"*). It names each router with the one word a pool's card gives it (Internet up or down,
Primary or Standby where there are two, Unknown when no machine could read
it), opening the same page a pool's routers have: the numbers, the names it
refused most and the log lines lately, Suricata's among them. Before any
machine has read it the page says so, and never that it is fine. The setup's
own machine now comes before the edge router in its steps on both phones.

#### Two of them

Asked for: *"Keep going, build two edge routers next"*. With **Two of them**
(`--edge-pair`) the setup makes **the same pair a Xen Orchestra pool can
have** (`edge-router.js`, `ha` and EDGE_HA): `fleetwright-edge` at
10.254.0.2 and `fleetwright-edge-b` at 10.254.0.3, sharing the gateway
address 10.254.0.1 by CARP. The one that is master answers it; when it
restarts or updates, the other takes it over and the machines behind them
keep their way out. Each hands out its own half of the DHCP range, naming the
shared address as gateway and resolver, so a lease outlives the router that
gave it, and the second updates itself an hour after the first.

- **Four more configurations**, either of a pair, filtering or dropping,
  built by `scripts/build-pve-edge.mjs` and pinned like the other two. The
  pair's CARP password is a mark in them, filled in on the node from
  `/etc/pve/priv/fleetwright-edge-watch.json`, where it is made once
  (`carp_keep`, 256 bits) beside the key: a pair made again shares it, and
  it is never in a published file. A configuration with the mark and no
  password kept is refused.
- **One image, two disks.** The image is unpacked once; the first router's
  configuration is written in and imported, then the second's takes the
  same block (`edge_write` again, each edit checked as already made) and is
  imported too.
- **Tagged by which it is** (`fleetwright-edge-node-0`, `-node-1`), so a run
  that finds one alone when two are asked, or two when one is, makes them
  again as asked, and keeps them otherwise.
- **Both watched** with the one key and certificate, both send their logs to
  the cluster's own machine, and a box reads each where its guest agent
  says. A CARP change of master is in the log as it happens.
- **On one node.** Both are made on the node the setup runs on, so the pair
  outlasts a router restarting or updating, not that node going down.

**On the phones** it is **Two edge routers**, under the edge router's
options. The cluster's page says "Two running" and lists each by name with
its own word (Primary, Standby, or what is wrong), opening the routers' page;
**Make the edge router again** makes two again.

#### Labs behind it

With the edge router on, **the cluster's labs are behind it**, as a Xen
Orchestra pool's are (`edge-router.js`, `labs`). Each lab network is one more
interface on the router (`vtnet2` up, and on both of a pair), which is the
lab's gateway at 10.250.<n>.1, hands out its addresses, and filters it the
way it filters the uplink: Unbound refusing names on the threat lists, and
Suricata watching (or dropping) what its machines do. A closed lab reaches
the fleet and Claude over HTTPS and nothing else, and asks names only of
them.

- **The node steps back.** Its subnet on each lab (the gateway and NAT it
  had there) is removed, its own lab dnsmasq turned off, and its firewall
  rules for labs taken away. Without the router they are as before.
- **Every layout, pinned through one list.** Open and closed labs, four at
  most together, alone or as either of a pair, filtering or dropping: 84
  configurations under `install/pve-edge/`, each listed by SHA-256 in
  `SHA256SUMS`, which the script pins (`EDGE_LABS_SUMS_SHA`). The six beside
  the script are unchanged, for the setups the apps carry.
- **The fleet's hosts are filled in on the node** (`edge_fill`), from the
  coordinator the setup was given and Claude's hosts, the same list the
  boxes make (`fleetHosts`); a closed lab with no fleet known is refused.
- **Tagged** `fleetwright-edge-labs-o<open>c<closed>`, so a run asking for
  other labs makes the router again with them, and a box sees that the labs'
  gateway is the router's.

**Not yet run** on a real node: labs behind the router, as above. **Not yet run** on a
real node: the image under KVM's virtio, which it was checked under QEMU
with, `import-from` with the storage the setup chose, and the router's
guest agent reporting its WAN address to the token.

## Not built

- The direct path's steps on the Lock Screen and in Android's ongoing
  notification. Through a machine has them; from the phone itself does not.
- The cluster's page described above: its fence, its token's width and its
  machines are in the health entry, and no screen draws them yet.
- The pool page's actions on the cluster (`xolook`, `xoact` are Xen
  Orchestra's).
- Machines kept ready (`vmStandby`), which have not been tried against a
  cluster.
