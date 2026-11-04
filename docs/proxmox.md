# Proxmox VE

**Status: the host half is built; the phones are next, and nothing has run
against a real cluster.** A box that holds a Proxmox token looks at the
cluster, sweeps what is done, and makes, hands the login to, restarts,
extends, resizes and ends machines on it, behind the same seam as Xen
Orchestra (`src/fleet/host/pools.js`), so the coordinator and the protocol
did not change. The cluster is set up by one script run as root on a node
(`install/fleetwright-pve-setup`), which the phone is to run itself over
SSH ("From the phone"; the phone half is not built) or a person runs by
hand. **Not built:**
the phone screens below, labs, machines that work together, and the pool
page's own actions. **Not yet run:** the script on a real node, and a
machine made on a real cluster. The tests run the driver against a stand-in
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
  `fleetwright-isolate` cannot reach your network, and nothing records what
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

Measured against a running Proxmox VE 8 and 9 estate by another integration
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
- **Proxmox VE 8 and 9 name some privileges differently** (`VM.Monitor` is
  gone in 9). The roles here use only names both have.
- **A Cloudflare Worker cannot reach a node's private address or accept its
  self-signed certificate**, which is why that integration goes through a
  tunnel. A Fleetwright box is on the network and runs Node, so it reaches
  the node directly and trusts its CA; a cluster reached through a tunnel
  with a public certificate is the `public` trust, and works the same.

## Setting it up

### From the phone

**This is how it is meant to be done, and the phone half is not built yet.**
Machines › Add a hypervisor › Proxmox asks for the node's address and its
root password (or uses an SSH key the phone keeps), and does the rest itself.
No machine of the fleet is involved, so the password goes from the phone to
the node and nowhere else:

1. **The phone connects over SSH.** The first time, it shows the node's host
   key fingerprint, to compare with `ssh-keygen -lf
   /etc/ssh/ssh_host_ed25519_key.pub` on the node's console, and remembers it
   for that address; a different key later is refused and said.
2. **It writes the script from its own bundle**, the copy that shipped with
   the app, to `/root/fleetwright-pve-setup`, so nothing is downloaded from
   GitHub to run as root.
3. **It starts it detached**: `systemd-run --unit=fleetwright-pve-setup
   --collect /root/fleetwright-pve-setup --line-file
   /root/.fleetwright-pve-line`. The image takes a few minutes to build and
   a phone locks, so the job must not die with the SSH session.
4. **It follows the job** with `journalctl -fu fleetwright-pve-setup -o cat`:
   the `fleetwright-step:` lines move the Live Activity on iOS and the ongoing
   notification on Android, and `fleetwright-error:` is the sentence shown if
   it stops. Opened again, it reconnects and carries on reading.
5. **It reads the line from the file and removes it.** The line is the token,
   so it is never printed where the journal would keep it. The phone keeps it
   in the vault as `hypervisor:<address>`, then checks it: one look over HTTPS
   with the token, trusting the CA the line carries, before it calls the
   cluster added.

The root password is used for that session and dropped, or kept behind Face
ID or a fingerprint when the person asks, as Xen Orchestra's sign-in is.

### By hand

The same script in a root shell on any node (Datacenter › the node › Shell
in Proxmox's own web interface):

```
bash fleetwright-pve-setup
```

prints the line at the end, to paste into Add a hypervisor › Proxmox.

### What it makes

Finding each first, so it is safe to run again:

1. the pool `fleetwright`;
2. the user `fleetwright@pve` with no password, and four roles: `Fleetwright`
   on the pool (`PVE_ROLE_PRIVS`), `FleetwrightStorage` on one storage,
   `FleetwrightNet` on one bridge (Proxmox 8 and later), and
   `FleetwrightAudit` (`Sys.Audit`) on `/` alone, not propagated, to read
   whether the firewall is on;
3. a token, which lasts a year by default; running the script again makes a
   new one and the old one stops working;
4. the firewall group `fleetwright-isolate`: SSH in, DHCP and DNS out, then
   nothing private out (RFC 1918, CGNAT, link-local, IPv6 ULA);
5. the machine image: Debian 13's cloud image, pinned and checked, booted once
   to install Fleetwright from apt, left unjoined and turned into a template;
6. one line, `fleetwright-pve:1:…`: the address, the token, the pool and the
   cluster's CA. A web interface given a certificate of somebody's own is
   trusted as a browser would trust it when a public CA signed it (ACME), or
   by that certificate's file when the file holds its own root; any other is
   refused at setup, because reaching it would mean turning the chain check
   off.

Its options: `--address`, `--storage`, `--bridge`, `--enable-firewall`,
`--channel stable|rolling`, `--no-image`, `--rebuild-image`,
`--expire-days`, `--line-file`.

The snippets the image boots with, the privileges and the image pin are
written in the script, which has no Fleetwright to import them from, and in
`pve-pools.js`; `test/pve-pools.test.js` holds the two equal.

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
4. On the default network, the machine goes behind `fleetwright-isolate`:
   inbound dropped but SSH, outbound to the internet and nothing private.
5. It starts. The template's vendor snippet copies the serial, as root, where
   `fleetwright-vm-join` takes it from, and the join is the one Xen
   Orchestra's machines run.
6. Anything that fails after the clone removes the clone.

## The phones: one screen per thing, no wizard

Not built; this is the shape the next layer takes, written down so it is
built to it and not to `AddHypervisorView`.

**Add a hypervisor › Proxmox** is one screen: the node's address and its
root password, and Set up. Then the host key, once, and the steps as they
happen, the same on the Lock Screen. No probe of every box, no machine to
pick, no key fingerprint of a fleet machine to compare, and nothing to copy
between devices. Pasting a line made by hand is the other way in, on the
same screen.

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

- The phone screens above, on both apps, and the SSH client each needs for
  "From the phone": neither app has one yet.
- Labs and group networks (SDN VNets are the natural fit); `make` refuses
  both by name rather than make something else.
- The pool page's actions on the cluster (`xolook`, `xoact` are Xen
  Orchestra's).
- Machines kept ready (`vmStandby`), which have not been tried against a
  cluster.
- A machine's address on its page: Proxmox has it from the guest agent,
  which needs `VM.GuestAgent.Audit` (Proxmox 9) or `VM.Monitor` (8).
