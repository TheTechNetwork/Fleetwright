# A machine from your own hypervisor

**Status: built.** A pool that already has Xen Orchestra is added through a
machine already in the fleet ("What ships first", below), and one that has
none gets one first ("A pool without Xen Orchestra"); the policy job
builds its edge router and its **machine image**; and a session starts on a
**new machine from that image** from New session › Where on either phone
("Machines from your pool", next). The policy job also makes the pool **a
machine of its own** that holds it ("A machine of its own"), and **labs**: networks of their
own on the edge router, open or closed, a session's machine alone on one
("Labs"). **Not yet run:** a real XCP-ng pool behind Xen Orchestra, and the
install on one. Seeing inside a lab is designed and not built ("Seeing what
crossed a lab"). XCP-ng first, through Xen Orchestra; Proxmox second, behind
the same interface.

A session today runs in a container on a box, or on a GitHub Actions runner
that is gone in six hours. Neither is a real machine on a network you own:
a container shares the box's kernel and has no interfaces of its own to route
or sniff, and a runner is somebody else's computer on somebody else's network.
Some work needs a whole VM: a router in front of it, a network with nothing
else on it, a kernel it may break, traffic somebody can inspect. The shape
that gets there is the one runners already proved: a machine is cloned,
**joins by itself**, does the job, and is destroyed. The difference is whose
hardware it is, and where the credential that clones it lives.

## Machines from your pool

> Still can't run sessions on it.

What happens, from the phone to a session on a VM:

1. **The pool's token is kept in your vault.** Setup seals the limited user's
   token to your phone (the hand-off, below). The phone now also puts that
   record in your vault as `hypervisor:<address>`, after setup and from the
   hypervisor's page (Machines › the pool › Keep its token in the fleet) for
   a pool set up before. The minter checks the record names that address.
2. **The boxes you approved hold it, in memory only.** Each sidecar pass
   (every ten minutes) hands an approved box everything you keep, and the box
   takes the pool records out before its hub sees the answer, so nothing
   writes them to disk (`src/fleet/host/xo-pools.js`). Sessions never see
   them: a pool's token is its own kind, not a named secret.
3. **The box looks at the pool.** Signed in with the limited token, it finds
   the Fleetwright machine images there (templates tagged
   `fleetwright-image`) and reports them in its health, never the token. The
   coordinator offers each person the images on their own pools as
   `vmImages`, and both phones list them under New session › Where as "New
   machine from Fleetwright Debian 13 on rack".
4. **You start a session there.** `provision { platform: "vm", template,
   minutes }`, with the session beside it as a runner's is. The coordinator
   mints a single-use ticket bound to you, holds the session, and asks a box
   that holds your pool with that image; one that cannot reach the pool hands
   on to the next, and a refusal from the pool itself (no room in its limits)
   is the answer.
5. **The box clones the image** onto the uplink, behind the edge router, or
   onto a network of the pool you chose (protocol 9, below), counted against
   the resource set, tagged `fleetwright-session`, with the time it must be
   gone by, when it was made, the image, the network and whose it is, and
   booted with a cloud-init drive holding one file: the coordinator, the
   ticket, whose machine it is, your Claude login from your vault, and a
   backstop for its end. Your SSH public keys go on the same drive, when you
   keep some. Xen Orchestra is asked to destroy the drive once the machine
   has booted.
6. **The machine joins by itself.** `install/fleetwright-vm-join` wipes the
   drive first, moves the file beside the sidecar's key and starts the
   services, which the image left off. The sidecar enrols itself once at
   `/api/enroll/vm` with the ticket, under the name the coordinator derives
   from it (`vm-<ticket id>`), hands your Claude login to its hub as a
   runner's is handed, and deletes the file. It is then a temporary host in
   every way: yours, placed only by name, retired with its key on disconnect.
7. **The session starts on it**, from the first health frame that says it
   can take one; a frame from before its login has arrived holds the start
   for the next.
8. **It ends on time.** The box holding the pool looks every two minutes,
   and removes, disks and all, every machine tagged `fleetwright-session`
   that has stopped, and any still running a minute past the end in its tag.
   The end is the box's to keep because a person can move it (Give it
   longer, below); the machine's own power-off is a backstop thirty minutes
   past the longest a machine can live, for a pool no box reaches any more.
   Nothing else on the pool is touched.

**What a session there runs on** is your own Claude login from your vault. A
setup-token cannot open Remote Control, so, as on a runner, the
notification that matters is the one when its task is done.

**The machine image** is built by the policy job, which already holds the
admin sign-in: switch on "Make the machine image for sessions" under Way out.
It is Debian 13's own cloud image, pinned by its published SHA-512, with
Fleetwright installed from this fleet's `/install` and not enrolled, built
behind the edge router on the storage picked, and turned into a template in
the resource set. Its build is on the Lock Screen and in Android's ongoing
notification, like the router's. Details under "Templates, built by the
policy job".

Machines on the uplink cannot reach each other unless they are put in a
group ("Machines that work together").

**Not yet:** a pool has to be added and approved boxes have to reach it; the
first clone has not been run on a real XCP-ng pool.

## Machines kept ready

> Standby VMs to speed up session starts.

A session on a new machine waits for a clone, a boot and an enrolment: a
minute or two. **Kept ready**, it does not. Under Machines › Keep machines
ready a person keeps up to three machines from one image booted and joined,
on a network of the pool or behind the edge router (`PUT /api/vm-standby
{ template, count, network }`).

- **Taking one.** A session asking for that image on that network starts on
  a ready machine at once, as its owner, by name, and the coordinator makes
  another behind it. A machine is taken only while it is connected and
  healthy and has the time the session asked for still left on it, by the
  pool's last look; otherwise a fresh one is made as before.
- **Never given back.** A machine a session has used is that session's. The
  next session gets one nobody has used, so no session inherits another's
  files, processes or history.
- **Made like any other.** A ticket bound to the person, a box holding their
  pool, the image, its whole 350 minutes and no session. It is replaced when
  its life runs out, and swept by the box like every machine.
- **Topped up** from a holding box's health frame, at most once a minute and
  one machine per person at a time, so a burst cannot ask for a pool's worth.
  Asking for fewer, or none, ends the ones no longer wanted, as End it now
  would.
- **What it costs** is said on the setting before it is asked for: each kept
  machine is a machine's worth of the pool, all the time, inside the resource
  set's limits like any other.

The phones show how many are ready and being made, mark the image with one
ready in New session › Where as "ready now", and name a kept machine in the
list as kept ready. The coordinator keeps the wish and the machines made for
it as `vmStandby` (`src/fleet/coordinator/vm-standby.js`): a refusal past 32
people, at most six machines each, and a machine that never enrolled
forgotten after fifteen minutes.

## Machines that work together

> Allow fleet pool tests, so think testing HA for something, which means the
> 3 VMs need to reach each other. Allow requesting VMs to be connected on
> their own network, with a default of isolate from each other and only
> allow outbound.

**By default a machine reaches the internet and nothing else, and nothing
reaches it.** The edge router already keeps every machine off your LAN, the
pool's API and the rest of private address space. But the machines behind it
share one network, the uplink, so without more they could reach each other
directly, without passing the router. Now each one, at every boot, drops any
connection opened to it from the uplink except by the router itself
(`install/fleetwright-net`, an nftables table `inet fleetwright`); replies to
what it opened still come back in, and inbound IPv6 is dropped. If the filter
cannot be put in place the machine powers off rather than sit open beside
everyone else's, and the box that made it removes it.

**A group is how machines that need each other are let through.** In a
pool's policy, under *Machines that work together*, a person asks for up to
four **group networks**, `fleetwright-group-1` to `-4`: private networks in
the way out's pool with no interface of their own, so nothing reaches them
but the machines on them. The policy job makes them with the admin sign-in
(the fleet's limited user cannot make networks) and puts them in the resource
set. It never removes one, because a machine may be on it, and applying a
policy keeps them in the set whatever the phone sent.

Then, in New session › Where, *Work with others on* puts the new machine on
one as well as its own network (`provision { group }`, protocol 10). Start
three machines with the same group and they reach each other on it:

- **An address each**, in 10.200.0.0/16, taken from the machine's ticket id
  and moved past any other machine in that group has. There is no DHCP on a
  group network; the address is set at every boot, on the interface whose MAC
  (also from the ticket id) the box gave it.
- **A name each**: `vm-xxxxxxxxxxxx.local`, over mDNS (avahi), so a test can
  name its peers rather than carry addresses.
- **Everything is let in on the group network**, and the uplink stays
  fenced: in a group, a machine is still closed to every machine that is not.
- **A group is the pool's, not a person's.** Two people who keep tokens for
  the same pool share its group networks: their machines in group 1 reach
  each other. A pool shared that way wants a group each.
- **The page says it.** A machine's page names its group, its address there
  and its `.local` name. The box tags it `fleetwright-grp:` and
  `fleetwright-gip:` in Xen Orchestra, so the next machine in the group, made
  by any box, avoids the address.

**A network of your own choosing is left as it is.** A machine put on one of
the pool's networks instead of behind the router gets no fence: that network
is yours, with whatever is on it already.

**What this is, and is not.** The fence is inside each machine, so it holds
against every other machine on the uplink, and not against the machine's own
root: a session that removes it exposes itself and nothing else. It does not
stop a machine with root sending forged frames on the uplink (ARP or spoofed
sources); the router's own rules are the boundary no session can touch, and
a lab (below), a network of its own on the router, is the shape for work that
must not share a segment at all. A group network, like the uplink, is local to one host of a
pool without Xen Orchestra's SDN controller, so the machines of a group must
land on one host to reach each other. The script and its unit travel on the
cloud-init drive, so machines from images built before them are fenced too;
images built now carry nftables and avahi, and an older clone installs them
when it can.

## Working a machine

> Vm console, settings, reboot, ssh os selection not just Debian.

**Each machine on your pools has a page**, under Machines › On your
hypervisor on both phones, and from a `vm-` host's own page. It says what the
box holding the pool last saw: the state, the image it was made from, the
Xen Orchestra it is on, its network, its size and when it ends. Each is
*cannot tell* when Xen Orchestra had not said, never a blank or a zero. The
box reports them in its health (`xo[].machines`), and the coordinator hands
each person their own as `vmMachines`.

**What you can do with it**, through the `vmctl` verb (protocol 9). The
coordinator asks the boxes holding your pools in turn, the one that last saw
the machine first, and the box signs in with your pool's token and works only
a machine tagged as made for you (`fleetwright-for:`), since two people can
hold the same Xen Orchestra.

| Action | What the box does |
|---|---|
| **Restart** | `vm.restart`: clean where the machine reports its guest agent, hard where it does not or refuses the clean one (Xen Orchestra's clean reboot needs the guest tools, which the image installs only where the distribution has them). A session running on it ends; the machine is back in the fleet in a minute or so. |
| **Give it longer** | Moves the end in its tag, never past 350 minutes from when it was made, so asking again and again does not keep a machine alive for ever. |
| **Restart with this size** | Marks it busy so the sweep does not take the stop for done, stops it (clean or hard, as Restart), sets vCPUs and memory, and starts it again whatever the pool said. Xen Orchestra holds the size to the resource set; a refusal restarts it at its old size and says why. |
| **End it now** | Force-stops it and removes it with its disk. |

Each that interrupts a session asks first. None is held on the phone to be
sent later: a restart replayed hours after it was asked for is not what
anybody asked for.

**The console is Xen Orchestra's own**, opened in the browser at
`https://<address>/#/vms/<id>/console`, where you sign in to Xen Orchestra.
The phone never holds the pool's token, and a console streamed through the
fleet would make it hold one.

**SSH.** Keep your public keys under You › Credentials › SSH keys. They are
one secret in your vault, `SSH_AUTHORIZED_KEYS`, one key a line, checked on
the phone and again on the box to be public keys and nothing else. A machine
made after that takes them on its `fleetwright` account, which may then use
sudo: the machine is yours alone and exists for one job (Inside the VM). Its
page gives the command, `ssh fleetwright@<address>`, once its guest agent has
said the address. A machine on the uplink is reachable only from behind the
edge router; for SSH from your own network, start it on one of yours.

**The network.** New session › Where offers the pool's networks the fleet may
use besides the default, *Behind the edge router*. A network of yours puts the
machine beside your own machines, which is what SSH from your laptop needs and
exactly what the uplink exists to prevent, so it is a choice and never the
default. The box takes only a network it saw on that pool
(`provision.network`, protocol 9).

**The operating system.** The policy offers one switch per image the machine
can build: Debian 13, Ubuntu 24.04 LTS and Ubuntu 26.04 LTS, each from its
publisher's own cloud image, pinned by its published checksum (Ubuntu's by
SHA-256 from its release's `SHA256SUMS`). Every image is downloaded as the
qcow2 its publisher ships, and the box reads the raw disk out of it into Xen
Orchestra's disk import as it uploads (`src/fleet/host/qcow2.js`, Node's own
zlib, nothing to install). The pool cannot take the qcow2 itself: XCP-ng's
`qcow-stream-tool` refuses compressed clusters (`Compressed_unsupported`),
and every distribution compresses them. Each image is its own
template, tagged `fleetwright-image:<key>`, and New session lists every image
on your pools. A machine older than the choice is offered Debian alone.

### A machine of its own

**The policy screen offers to make the pool a Fleetwright machine of its
own**, under Way out, from a machine whose setup offers it (`holder` in
`can`). Until then, the boxes that hold a pool's token are whichever machines
its owner approved, and that is often the laptop that set the pool up. When
the laptop sleeps, nothing can start a machine on the pool. The pool's own
machine stays up.

**What Apply does**, last, after the router and the images:

1. It reuses the one on the pool if there is one, and starts it if it is off.
2. Otherwise it clones one from the pool's machine image (Debian's, where
   there is one) with the admin sign-in.
3. The clone goes on the way out, because it has to reach Xen Orchestra and
   the coordinator, and the uplink behind the router reaches neither by
   design.
4. The clone is made outside the fleet's resource set. It does not count
   against the fleet's limits, and the limited user the fleet works with can
   neither see it nor remove it.
5. It is tagged `fleetwright-holder` and `fleetwright-holder-for:<address>`,
   and carries none of the tags the sweep removes machines by.

Asking for one where the pool has no image also asks for Debian's image, and
for the router the image is built behind.

**It joins with a pin, not a ticket.** Just before it clones, the box running
the job asks the coordinator for one (a `holder-pin` frame). The coordinator
gives a pin only to the box running that person's policy job, at most three
times a job. The pin is bound to a name the coordinator chooses: `holder-`
and six hex, never a name a host already has, because re-enrolling a name
replaces its key. It is the ordinary enrolment pin otherwise: single use, ten
minutes, and it enrols a permanent host of nobody's. The machine boots with
the pin, the name and the pool it holds on its cloud-init drive. The join
script wipes the drive, schedules no end, and writes `FLEETWRIGHT_HOLDER_FOR`.
The sidecar enrols at `/api/enroll/host` and spends the pin either way.

**It holds nothing until you approve it.** It joins the fleet like any box,
and the pool's token reaches it only as the `hypervisor:` vault item, once
you approve its key on its page under Machines. The job's last line says so.
Nothing the box or the coordinator does can approve it.

**Once approved, it is asked first.** Its health marks that pool's entry
`holder`. The coordinator then asks it before the other boxes holding your
token, both to make your machines and to work them, after the box that last
saw the machine. The other boxes are the fallback.

### What a machine did on the network

**Its page has a section, On the network**, on both phones. It shows the last
half hour of what the machine sent and received, drawn as two lines on one
scale: received solid, sent dashed, so they do not depend on colour alone.
Beside the chart are the rate now and the total over that half hour.

**The counts are the hypervisor's, not the machine's.** On every look at a
pool, the box asks Xen Orchestra for `vm.stats` on each running machine it
made. That is the pool's own count at the machine's network interfaces. The
box adds the interfaces together and reports the last 30 one-minute samples
as `net`: bytes a second in and out, oldest first. A session is root inside
its machine and could make anything it reports itself say anything, but it
cannot reach these counters. The coordinator passes on at most 60 points and
drops a series that is uneven or has no end.

**A sample nobody counted is a gap, never a zero.** It breaks the line, and
the total says how many minutes were not counted. When the page has no
report, it says why in the machine's own terms:

- a stopped machine has nothing to count;
- for a running one, the pool has not said;
- with no state at all, it cannot tell.

**It is how much, not where.** A destination, a DNS name, or an alert from the
edge router's intrusion detection would need the fleet to read the edge
router, which it cannot. Those are not here; "Seeing what crossed a lab",
under Labs, is the design for reading them.

## The credential, which is the whole design again

A Xen Orchestra user that can create and delete VMs is root on the pool in
every way that matters. `docs/wanted.md` already says where it may not live:
the coordinator is the party this system treats as compromised, so a token
there is every VM behind it.

**The fleet keeps it in your vault, and the boxes you approved hold it in
memory.** The vault is the minting Worker's (docs/vault.md): sealed at rest
under its own key, changed only by you from your phone, and handed only to a
box whose key you approved, which checked the fingerprint. The coordinator
relays it sealed and cannot read it. A box holds it in its sidecar process
and writes it nowhere, and stops being given it on the next pass after you
remove the box or forget the pool. So no single machine is the only thing
that can reach the pool, and none keeps the key on disk.

**And what the token may do is bounded in Xen Orchestra, not here.** The
fleetwright user gets a **resource set**: the templates it may create from,
the storage and networks it may use, and limits on vCPUs, memory and disk.
A compromised box is then a quota's worth of VMs from the images in that
set, and nothing on the pool that predates it. This is the bound to write
down for the operator, because it is the one that holds when everything on
our side has failed.

## What `provision` may express

```
provision { platform: "vm", template: <Xen Orchestra template id>, minutes?: 5..350, network?: <Xen Orchestra network id>, group?: <Xen Orchestra network id> }
provision { platform: "lab", template: <Xen Orchestra template id>, network: <a lab's network id>, minutes?: 5..350 }
vmctl     { name: vm-<12 hex>, action: reboot|extend|resize|stop, minutes?: 5..350, cpus?: 1..64, memory?: 1..512 GiB }
```

`template` is new on an existing verb, so it is `since: 8`, `network`
and `vmctl` are `since: 9`, and `group` is `since: 10`, and only a box
that reports a pool (and so speaks 8) is ever asked; the coordinator refuses
rather than let it be dropped. **`lab` is a new value, not a new version**:
a box from before labs validates the enum and refuses it by name, the way
`xosetup`'s `policy` phase was added, and only a box that reported a lab is
asked. The lab rides in `network`, which the box checks is a lab it saw on
that pool and saw empty. **The id must be an image the box itself saw
on your pool**, tagged `fleetwright-image`: the box checks its own report,
not the coordinator's word, and so must a network: one the box saw on that
pool, which the resource set already bounds to the networks the fleet may use.
No disk, address or cloud-init crosses the protocol. A compromised coordinator
can ask for one of your images for a few hours, attributed to you, on a
network the policy allows; it cannot ask for a VM on a network the policy
does not name, or one built from an image of its choosing. With `vmctl` it can
restart, resize within the resource set, extend to 350 minutes or end a
machine of yours, which is what you could do yourself; it cannot reach a
machine the box did not make for you. A task rides along the way it does
on a held runner start (protocol 7).

## How a clone joins

See "Machines from your pool", steps 4 to 7. What a leaked ticket costs is
more than a runner's, because there is no GitHub token beside it: somebody
holding it before the machine spends it could enrol a machine of their own as
your temporary host and be started the session you asked for with it. It is
single use, forty-five minutes at most, travels only on the machine's
cloud-init drive, which the machine wipes as its first act and Xen
Orchestra destroys after boot, and the machine spends it within a minute or
two of being made. A runner's ticket cannot be spent at `/api/enroll/vm`,
and a VM's cannot be spent at `/api/enroll/actions`.

## Ending

See "Machines from your pool", step 8. **The clock is on the VM**, in its
`fleetwright-until` tag, which any box holding the pool reads, so a box that
was down cannot leave a machine running past its end for long: the next one
to look sweeps it. The power-off the machine scheduled for itself is the
backstop when none does.

## Inside the VM

**The VM is the sandbox.** The session runs without a container: it gets the
VM's own kernel, interfaces and `/dev`, which is what packet capture, routing
and kernel work need. The machine exists for one job and is destroyed after
it. That makes the uplink the decision that matters most, which is the next
section.

## Labs

> VMs from your own hypervisor ... a private network per lab with an OPNsense
> VM in front of the session VM, so every packet crosses a router the session
> can inspect. The VM is the sandbox: no container, real kernel and
> interfaces.

That was the design, and it is not what was built. Asked instead: *"why
per-lab OPNsense when we can do one with proper routing and rules"*. The edge
router already exists, already stands between every machine and everything
private, and is already configured unattended from the source. A router per
lab would cost each lab a second VM (2 GiB, and minutes of FreeBSD booting
before the session's machine had a network at all), a template of its own,
and a bootstrap API key that some machine on the lab's network has to be
trusted with. One router with an interface per lab gives the same isolation
for nothing.

**A lab is a network of its own on the edge router, with one machine on it.**

- **The networks are the policy's.** Under Labs, a person asks for up to four,
  each **open** or **closed**. The policy job makes them with the admin
  sign-in (`fleetwright-lab-1` on, private networks with no interface off the
  pool, like group networks), tags each with its kind
  (`fleetwright-lab:open` or `:closed`) and puts them in the resource set. The
  fleet's limited user cannot make or tag a network, which is the reason the
  box does not make one per session. Four because Xen gives an HVM guest
  seven interfaces, and the edge has two of its own.
- **Each is an interface on the edge** (`xn2` for the first), with the edge at
  `10.250.<n>.1/24` and its DHCP handing out `.100` to `.250`. The rules are
  written into the edge's configuration with the uplink's, so nothing in the
  fleet can change them, and changing the labs rebuilds the edge the way
  blocking mode does: stopped, a new one built beside it, the old one removed
  only once the new one is up, and how it filters kept as it was. The phone
  says that before Apply.
- **What every lab gets**, the same three rules as the uplink: names only
  from the edge, never another resolver, so the threat blocklists apply; and nothing
  private, so not the uplink and its machines, not your LAN, not the pool's
  API, not another lab. Suricata watches each lab's interface as it watches
  the uplink, and drops as it does when the edge blocks.
- **An open lab** then reaches the internet, out through the edge's NAT like
  any machine behind it.
- **A closed lab** reaches the fleet and Claude and nothing else: HTTPS to
  the coordinator's host and to the hosts Claude cannot work without
  (`api.anthropic.com`, `platform.claude.com`, `claude.ai`, `claude.com`, the
  sandbox egress allowlist's required list in `src/core/egress.js`, reused
  rather than written again). Without them the machine could not enrol, its
  sidecar could not stay connected and the session could not run. Everything
  else it sends is blocked and logged on the edge. The hosts are an OPNsense
  host alias, which the edge resolves with its own Unbound and keeps
  resolved.
- **A closed lab resolves only the fleet's own hosts**: the same list, and
  the names under each (`api.claude.ai` under `claude.ai`), and every other
  name, of any type, is refused. Before, the edge's Unbound answered a closed
  lab any name by asking for it anywhere on the internet, so a session could
  carry data out in the names it looked up. OPNsense 26.7's Unbound cannot
  answer one network differently from another from `config.xml` (its access
  lists allow or refuse all of a network's questions, and its blocklists match
  only addresses and never the whole tree, so a TXT question would still
  leave), so a closed lab's port 53 goes, by an `rdr pass` ahead of every
  rule, to the dnsmasq the edge already runs for DHCP. That dnsmasq has no
  resolver of its own (`no_resolv`) and one domain override per name, each
  asking the edge's Unbound, which still filters the answer. The uplink and
  open labs ask Unbound as before.

**A session in a lab.** New session › Where offers *In a lab* under a
machine image whose pool has labs: *Open: reaches the internet* or *Closed:
only the fleet and Claude*, each only while one of that kind is free. The
phone takes the first free one of that kind and sends `provision { platform:
"lab", template, network: <the lab's id> }`. The coordinator holds that lab
for this machine from the ask until the box sees the machine on it, so two
asks cannot land on one network, and asks only a box that saw the lab. The
box takes only a lab it saw empty, clones the image onto that network alone
(no uplink, so nothing reaches it but the edge; no fence, since nothing else
is on it; no group) and, because another box may have done the same in the
same moment, looks again and removes its machine if it was the second. The
machine joins, and the session starts on it, exactly as on the uplink.

**What a lab costs**: no machine of its own. The session's machine is
counted against the pool's resource set like any other. **How many labs one
person may hold at once is the admin's**, set in the policy as *Labs per
person*: no limit unless one is set, and then a whole number from 1 to the
labs the pool has. The policy job keeps it as a tag on each lab network
(`fleetwright-lab-each:2`), where the box reads it with the fleet's own token
and reports it; the coordinator refuses a lab past it, saying the number. A
pool whose policy predates the setting has no tag, which is no limit and
never 0. The coordinator counts a person's labs on that Xen Orchestra: their
machines seen in a lab there and the ones asked for and not yet seen.

**A lab ends when its machine does**, the way every machine from the pool
ends: at the end in its tag, which *Give it longer* moves to the same 350
minutes from when it was made as any other, or when its owner taps *End it
now* (`vmctl`). The box's sweep removes it, and a lab is free the moment no
machine of the fleet's has an interface on it, so a machine swept, ended or
removed by hand frees it alike. Nothing ends a lab when its session ends: the
first version ended the machine five minutes after its session, which the
owner took out.

**What the phones show.** The policy screen asks how many of each, four in
all, starting from what the edge has, and says what a lab is and that it
costs no extra machine. Under them, *Labs per person* is a stepper whose
lowest step is *No limit*, offered only by a machine that keeps it (`labs-each`
in `can`) and starting from what the pool has; No limit is sent as null.
New session says what the chosen kind reaches. A machine's page names its lab
and what it reaches. A pool whose labs are all taken says so instead of
offering one, and that one is free again when its machine ends.

**Booted in QEMU**, from the pinned 26.7 image patched this way with four
labs, two of them closed, and blocking on: the whole configuration was read
(the file is 8,192 bytes, below), each lab's interface came up at its
address, dnsmasq had a range on each, Suricata's home network was the uplink
and the four labs, and `pfctl -sr` showed, per interface and in this order,
DNS to the edge, no other resolver, nothing private, the way out (the uplink
and the open labs, diverted to Suricata), the closed labs' HTTPS to the fleet
alias, also diverted, and the closed labs' logged block of everything else.
The fleet alias was there and empty, because this sandbox has no outbound DNS
to resolve it. **Not run here:** a machine on a lab network, a real pool, and
the alias resolving.

**A closed lab's names were not booted.** They came after, and the 3 GiB image
no longer fit on this sandbox's disk. What was run: dnsmasq's configuration
rendered from the edge's `config.xml` with OPNsense 26.7's own template and
its own config reader, then run in dnsmasq 2.91 on Linux in front of a
stand-in resolver. The coordinator's host, `api.anthropic.com`,
`platform.claude.com`, `api.claude.ai` and `claude.com` were asked of the
resolver and answered; a made-up exfiltration name (as A and as TXT),
`api.anthropic.com.attacker.example`, `evilclaude.ai` and `github.com` were
REFUSED and never reached it. **Not yet seen:** the `rdr` rule in `pfctl -sn`
on a booted edge, and OPNsense's own dnsmasq build answering.

**An edge built before this change keeps answering a closed lab any name**
until it is rebuilt, because nothing rebuilds an edge whose labs did not
change. Changing its labs, or how it filters, rebuilds it with the new
rules.

**It did not fit, so the file grew.** The edge's configuration with labs is
up to 8,021 bytes (four closed labs, blocking, a short coordinator name), and
the file it replaces is 5,234. The image's file
system has 4 KiB fragments, so `config.xml` already owns 8,192 bytes on the
disk (its inode counts 16 sectors) and the 2,958 after its end are zeros. The
build changes one more field: the file's size in its inode, from 5,234 to
8,192. Nothing is allocated, moved or freed, and the file system keeps no
check-hashes (its superblock's `fs_metackhash` is 0). It is pinned and
checked like the configuration: the field must read 5,234 and the slack must
be zeros, or nothing is written. An edge without labs is byte for byte what
was booted before, and so is one with only open labs. The bound that matters
now is the coordinator's name, which a closed lab's configuration carries
twice (the alias and the names it may resolve): with four closed labs and
blocking, a name of up to 106 characters fits, and a longer one is refused
before anything is downloaded.

### Seeing what crossed a lab: designed, not built

What a lab adds over a group network was meant to be inspection as well as
rules: the edge's firewall log and Suricata's alerts for that lab's interface,
handed to its session. **That needs a way into the edge, and there is none.**
The edge has no API and no login on purpose (root's password is `*`), its
WAN takes an address from DHCP on your network that Xen Orchestra cannot see
(OPNsense's nano image has no Xen guest agent), and no box is behind it. A
key to the edge would control every lab and the edge itself, so the session
must never hold one; that is the line not to cross.

The shape that holds that line:

1. **A network for the edge's management alone**, `fleetwright-edge-admin`,
   made by the policy job, with no interface off the pool and **not** in the
   resource set, so no fleet machine can be attached to it. The edge gets an
   interface on it, and its web interface and API listen there and nowhere
   else.
2. **The pool's own machine** (A machine of its own) gets a second interface
   on it. It is the one Fleetwright box that the same admin job makes and
   that sits outside the resource set.
3. **An API key for the edge**, made by the policy job and written into the
   edge's configuration (OPNsense keeps a key as its secret's SHA-512 crypt),
   and handed to the pool's own machine on its cloud-init drive. A rebuilt
   edge must be given the same key, so the job keeps it where only the admin
   sign-in can read it (on the edge VM in Xen Orchestra), or makes the pool's
   own machine again.
4. **The pool's own machine reads** the filter log and Suricata's alerts,
   keeps the lines whose interface is a lab's, and the coordinator relays
   each lab's lines to that lab's machine, where the session reads them as a
   file. No key leaves the pool's own machine.

**What it costs:** seeing inside a lab needs a pool's own machine; the edge
gains an API it does not have today; an edge rebuilt for any reason has to
keep its key; and the coordinator gains a relay of log lines. Until that is
decided, what a session can see of its lab is what any machine's page shows:
the hypervisor's own count of what it sent and received ("What a machine did
on the network"), which nothing inside it can change.

**So a lab is, as built, a group network with rules and its own way out**,
on the router that was already there, rather than a parallel mechanism.

## The edge router

The uplink, the router on it, and what it filters: the boundary every
machine and every lab is behind.

### The uplink

**`fleetwright-uplink` must not be the management network**, the one Xen
Orchestra, the pool masters and everything else on your LAN sit on. Everything
a machine behind the edge does leaves through it, so it is the boundary.

**Which network the edge router's WAN goes on is the person's choice**, made
on the phone when they change the pool's policy (below, "The policy"), and
recorded in Xen Orchestra as the `fleetwright-egress` tag on that
network, so it can be seen and changed there too. It can be any network
the pool lists, and one the fleet's VMs may not use is the better choice:
the router is built with the admin sign-in, not as a fleet VM, and a lab
attached straight to the WAN network would leave without passing through
it. A machine that predates this (its `begin` does not say `egress-any`)
still takes only the fleet's networks, and the phone offers it no others.
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
   - no DNS or DNS over TLS to anywhere else, so the filtering below cannot
     be stepped around by naming another resolver;
   - nothing to 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 or 224/4,
     so no lab reaches your LAN, the pool's API or another lab;
   - anything else, out through automatic NAT.
   It also filters what the machines behind it do ("What the edge filters",
   below).
   It hands out 10.254.0.100–250 and answers DNS with Unbound. It has **no
   login** (root's password is `*`) and no anti-lockout rule, because the only
   thing that could reach it is a lab, and it is not tagged `fleetwright`, so
   the fleet's token cannot touch the fleet's own way out.
3. When it is already there, moves its WAN if the way out changed and starts
   it if it was stopped. Nothing is rebuilt.

### What the edge filters

> Network filtering/dns filtering to prevent malware and other security
> issues. Deep packet inspection.

Every machine behind the edge gets two filters, written into the edge's
configuration like its rules (`EDGE_FILTER` in `src/fleet/host/edge-router.js`),
so nothing in the fleet can switch them off.

- **Names.** Unbound answers 0.0.0.0 for any name on two of OPNsense's
  built-in blocklists: abuse.ch ThreatFox (malware and command-and-control
  indicators) and Hagezi's threat intelligence feeds (malware, phishing,
  scams). They are threat lists only, not ads or trackers, so ordinary work
  does not trip them. A machine cannot step around the filter by naming
  another resolver: DNS (53) and DNS over TLS (853) to anywhere but the edge
  are blocked. DNS over HTTPS to a resolver by its address is not.
- **Traffic.** Suricata watches the LAN side with four Emerging Threats Open
  rule files: malware traffic, known botnet controllers, known-compromised
  hosts and Cobalt Strike servers. By default it **detects and logs**, by
  each machine's own address on the uplink, and drops nothing. **It can
  drop instead**, chosen on the policy screen (below).
- **Kept fresh.** OPNsense fetches neither the lists nor the rules at boot,
  only when a person applies a change in its web interface, which nobody
  does here, or from cron. The edge keeps `/var` in memory, so both are gone
  after a restart. So the configuration carries two cron jobs, every half
  hour: the lists are cached for 20 hours, and rules are downloaded only when
  their version changes. After an edge restart, filtering is back within
  half an hour.

#### Dropping what the rules match

> Blocking mode for the edge's intrusion detection.

The policy screen has a switch under the edge router, **Drop what the threat
rules match**, offered only by a machine whose `can` says `edge-block`. On,
Suricata runs **inline**: the rule that lets machines out hands their traffic
to Suricata's divert socket before it leaves, and one Suricata policy turns
every alert in the four rule files into a drop. The DNS rule and the
private-ranges rule are not diverted, because they decide before Suricata
would see the packet.

- **Divert, not netmap.** OPNsense 26.7 has two inline modes. Netmap sits on
  the network driver, and whether it works on Xen's netfront (`xn`) is the
  thing nobody could promise. Divert hands packets over through pf and needs
  nothing of the driver, which is the reason blocking was deferred until now.
- **It fails closed.** A divert socket nobody is reading passes nothing, so an
  edge that blocks and whose Suricata has stopped lets nothing out, rather
  than everything. That is the trade the switch asks for, and the screen says
  so: *"while it cannot inspect, nothing leaves."*
- **Changing it rebuilds the edge.** The edge has no login, so its
  configuration cannot be changed in place. An edge built the other way is
  stopped, a new one is built beside it, and only then is the old one removed.
  If the new one fails or is cancelled, it is removed and the old one is
  started again, so the pool is never left with neither. The machines behind
  it have no way out while that runs, and the screen says that before Apply.
  The edge is tagged `fleetwright-edge-blocks` when it drops, which is how the
  next policy knows which kind it has.
- **A phone that predates the switch sends nothing**, and its edge is left as
  it is, whichever kind it is.

**Booted in QEMU** with the blocking configuration: Suricata ran with
`-d 8000` on the divert socket, `pfctl -sr` showed the rule that lets machines
out ending `divert-to 8000`, the policy was in Suricata's own
`rule-policies.config` as enabled, alert to drop, over the four files, and a
sample ET-style rule put where a download lands was installed by OPNsense's own
`installRules.py` as `drop`. The first boot found the policy written but
**disabled**, because a model default is not written into an item that came
from the file; it now says `enabled` in so many words, and a test holds it to
that. **Not run here:** a packet actually dropped, since QEMU's network here has
no machine on the LAN side, and the netfront driver on a real pool, which divert
does not depend on.

It all but filled the 5,234 bytes the configuration has to fit in, so what
OPNsense does anyway was cut to make room: the web interface's theme, pf's
default optimization, sticky load balancing (which needs source tracking,
which is off), and the policy's priority and description. The comment on
`edgeConfig` lists each one and why it changes nothing.

**Booted in QEMU** from the pinned 26.7 image patched this way. The two cron
jobs were in the crontab, Unbound was listening with its blocklist module
loaded, and Suricata was running on the LAN interface with the four rule
files and the uplink as its home network. `pfctl` showed the DNS rule before
the private-ranges one, and a reload of every template was clean. The first
version of this booted with Unbound's templates failing and no cron jobs,
because a hand-written section stamped at the model's current version is
never saved with its defaults (the comment on `edgeConfig` says how that was
fixed). **Not run here:** the downloads themselves. This sandbox intercepts
TLS and has no outbound DNS, so the first edge on a real pool is the first
place the lists and rules arrive.

**Its disk goes where the person says.** With the switch on, the phone asks
*Its disk goes on*: any storage in the way out's pool with room for the
3 GiB raw disk, the fleet's own first. It need not be storage the fleet may
use, for the same reason as the WAN: the router is not one of the fleet's
VMs. A machine that predates the question (no `edge-disk` in `can`) is not
asked, and puts it on the fleet's storage there with the most room. Every
line while it builds names the storage, the summary does, and a router that
is there says on the phone which storage its disk is on.

**The bar is the build's own.** The build is three parts: the download,
writing the disk, and making and starting the VM. The machine reports how
far through the whole build it is in thousandths, weighted by the bytes the
first two move (the last is the final fiftieth). On the screen, on the Lock
Screen and in Android's notification the bar is that, with the part and the
percentage under it; before, it was the step, which sat at four fifths for
the minutes the build takes. Events go when the part changes or the bar
moves a twentieth, so a Lock Screen is not pushed to for every 16 MB.

**It says what is being built.** Asked for, about a Lock Screen that sat at
5% while the app called a machine image's disk the edge router: *"Why no
actual updates in the live activity?"* Two things were wrong. The words were
one sentence for every build, written when the router was the only thing
built in parts; the host now says which build it is (`edge`, `image` or
`holder`) beside the part, and both phones name it from that key, on the
screen and on the Lock Screen or the ongoing notification alike: "building
the machine image, part 2 of 4". And the activity stopped moving because
every update went at APNs priority 10, which Apple budgets and then quietly
throttles. Now news (a new step, part, build or state, and the end) goes at
once at 10, and the bar moving goes at 5, no more than every thirty seconds,
which is what priority 5 is for.

**Cancel stops it where it is.** The download, the unpack and the upload are
torn down, and what was made is removed: the VM with its disk, the disk on
its own, or a partial disk an upload left (attached to nothing, named for
the router, on the storage it was going to; nothing else of that name is
touched). The policy itself was already applied by then, and the job says
so rather than that nothing changed.

A failure part-way deletes what it made. A pool with more than one host keeps
labs on the edge's host, because a network with no interface is host-local
without Xen Orchestra's SDN controller. A pool that already has a suitable
VLAN can be pointed at it instead; nothing requires the uplink.

## Templates, built by the policy job

Nobody builds them by hand. Both are built by the policy job, which holds the
admin sign-in for as long as it runs:

- **Linux, built** (`src/fleet/host/vm-image.js`). Debian 13's official cloud
  image, the `genericcloud` build of 1 October 2026 as its qcow2, pinned by
  the SHA-512 Debian publishes for it, is downloaded once (a third of a
  gigabyte) and checked every time it is used. Its raw disk is read out of it
  straight into Xen Orchestra's disk import, the same bytes as the `.raw`
  Debian publishes beside it, grown to 20 GiB, and booted on
  the uplink with cloud-init that installs Fleetwright from this fleet's own
  `/install` with no pin, leaves its services off, and wipes what would make
  two clones one machine (the machine id, SSH host keys, any host key) before
  `cloud-init clean`. **It powers off when everything worked and reboots when
  anything did not**: cloud-init does not run its script twice, so a reboot is
  a VM that stays up, and its start time moving is read as the failure at
  once. The steps run in a subshell of their own, so the first one that fails
  stops the rest; they used to run where bash ignores `set -e`, and a broken
  install could power off and become the template.

  **It says where it has got to.** The box running the job asks the
  coordinator for a report token for it, and the script posts each step to
  `/api/xosetup/report` with it: started, packages, installer (Fleetwright and
  the session image, most of the time), cleaning, done. The coordinator passes
  each step to the box, and the phone shows it in place of a guess against
  time. A VM that has said nothing after five minutes is named as the likely
  problem: no network behind the edge router, or a start-up script that did
  not run. A failure sends the end of the install log with it, which is the
  only way to read it, because the VM has no password. A failed build's VM is
  kept, stopped, as `fleetwright-image-build (install failed)`, and one that
  runs past 25 minutes as `fleetwright-image-build (install timed out)`;
  applying again removes it. A good one is named Fleetwright Debian 13,
  tagged `fleetwright-image`, converted to a template and put in the resource
  set.
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
  DHCP, and `pfctl` showed the LAN rules above in order, with automatic
  NAT. Labs are interfaces on this same router, written into the same
  configuration, which with them outgrows the file and is grown into its
  own blocks ("Labs").

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

Following `CONTRIBUTING.md`, coordinator first. **Done:** protocol 8
(`template` on `provision`), the VM ticket and `/api/enroll/vm`, placement
onto a box that holds the pool, the vault's `hypervisor:` kind; on the host,
the pool holder, the clone, the sweep, the join and the machine image; both
phones; these docs; the pool's own machine (A machine of its own). **Next:** a network per machine and a group network for
tests that need several machines to reach each other; machines kept booted
and waiting so a session starts in seconds; DNS filtering and intrusion
detection on the edge router. What each machine did on the network is built
(What a machine did on the network). Labs are built ("Labs"); seeing what crossed one is designed and not built.

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
if none did. When none did, the phone itself may reach it, and carries the
connection for one machine (Through the phone).

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

### A pool without Xen Orchestra

> Deploying Xen Orchestra with the installer's `xo-remote-deploy.sh`.

**Built, and not yet run on a real pool.** When every machine that answered
the probe found no Xen Orchestra at the address, Add a hypervisor offers *This
pool has no Xen Orchestra yet*. A machine of the fleet then installs Xen
Orchestra on the pool with XenOrchestraInstallerUpdater's own script and adds
the pool to the fleet through it, in one job, so the phone can close at the
first step and collects the token at the end as from any setup.

What the person gives: the pool master's address, its root password, and a
new password for Xen Orchestra's admin. In order:

1. **The probe looks over SSH too.** Beside its HTTPS look, every permanent
   machine runs `ssh-keyscan` at the address on port 22, and where no Xen
   Orchestra answered it says which host keys did (each as OpenSSH prints its
   fingerprint, and as the hex of the same digest) and whether it has what
   installing needs (`bash`, `ssh`, `ssh-keyscan`, `python3`, GNU `getopt`,
   `sed`, `mktemp`). So the probe Add a hypervisor already ran is what the
   install starts from. The phone offers only a machine that reached the SSH
   server and can install. One too old to look is named as that, and one with
   no `ssh-keyscan` as cannot tell; neither is said to have found nothing.
2. **The host key, compared.** Nobody vouches for an SSH host key, so the
   phone always asks: it shows the key and the command that prints the pool
   master's own (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`, from Local
   Command Shell on its console), and Install waits until the person says they
   match.
3. **`xosetup deploy`**, a `begin` whose `pin` is the hex of the host key's
   SHA-256. The machine makes the job's key and signs it with its enrolment
   key under its own context, `xodeploy-key`, over the address, the job, the
   key and that pin. The phone checks that before anything is sealed, as for
   a setup, so a setup's signature or one over another pool master's key does
   not pass. A new phase rather than a new parameter, the way `policy` came,
   so it needs no protocol version: a machine older than it refuses the
   value, and the coordinator says it is too old to install.
4. **`run`**: both passwords and the key the token comes back to, sealed to the
   job's key under `fleetwright-xodeploy/v1:<job>:<address>`, a binding of its
   own, so a sealed root password is never opened as a setup's sign-in. The
   admin password must be 12 to 256 characters, on the phone and on the
   machine.
5. **Reaching the pool master** (`reach`). The machine scans the host key again
   and writes only a key with the accepted fingerprint to a `known_hosts` file
   of the job's own, with `StrictHostKeyChecking=yes`; a server answering with
   any other key is refused before the password is offered. It opens one
   OpenSSH master connection as root, answering the password prompt through
   `SSH_ASKPASS` from a unix socket in the job's 0700 directory, and wipes the
   password as soon as the master is up. The password is never in an argument,
   an environment or a file. It then reads the pool: that this is its master,
   its default storage, the network of the master's management interface, and
   whether an earlier install's VM (`fleetwright-xo`) is already there, which
   stops the job with what to do.
6. **The installer** (`installer`), pinned: commit `f9b299f` of
   [00o-sh/XenOrchestraInstallerUpdater](https://github.com/00o-sh/XenOrchestraInstallerUpdater),
   the fork the update plugin above comes from (ronivay's upstream does not
   have the script). `xo-remote-deploy.sh`, `xo-install.sh` and the update
   plugin's files are downloaded from that commit and each is checked against
   its SHA-256 in `INSTALLER` (`src/fleet/host/xo-deploy.js`) before anything
   runs. Moving the pin is reading the new script and changing the commit and
   the hashes, as for OPNsense's image.
7. **The installer's six stages** (`network` to `build`), as the script prints
   them: the network, Debian 13's cloud image (checked by the script against
   the SHA512SUMS Debian publishes and cached on the storage), the VM, its
   boot and cloud-init, packages, and building Xen Orchestra. The machine runs
   the script with an `SSH_OPTS` whose `ControlPath`, `ControlMaster=no` and
   `BatchMode=yes` come first, and OpenSSH takes the first value it is given
   for each option, so every `ssh` the script makes rides the master and none
   can ask for a password. The download's percentage is the bar. The VM is
   `fleetwright-xo`, 2 vCPUs, 4 GiB and 20 GiB, on the pool's default storage,
   on the management network with an address from DHCP: the network the
   machine reached the pool master on.
8. **The default admin password replaced** (`admin`). The installer leaves
   `admin@admin.net` / `admin`, and anybody on that network can sign in with it
   until it changes. The moment the script says Xen Orchestra is up, the
   machine signs in with the default and sets the person's password. If the
   default no longer works, somebody signed in first, and the job stops saying
   so rather than going on. The admin stays `admin@admin.net`.
9. **Onboarding's own steps**, against the new Xen Orchestra, signing in with
   the new password, which is the proof it took. The hand-off record names the
   Xen Orchestra's address, with `poolMaster` beside it; the phone opens it
   under the pool master it began with and keeps it under the Xen
   Orchestra's address, like any other pool.

**Xen Orchestra's certificate is one the machine made**, a self-signed P-256
certificate written before the VM existed, so the pin is known in advance and
nobody is asked to trust a certificate minted a minute ago inside a VM they
cannot see. The script copies everything under its `plugins/` directory into
the VM through cloud-init, so the certificate and key go there, and the
configuration the machine writes points `PATH_TO_HTTPS_CERT` and
`PATH_TO_HTTPS_KEY` at them with `AUTOCERT="false"` and HTTPS on 443
(`xo-install.sh` checks the pair matches). cloud-init writes those files 0644,
so the key is readable by every account in that VM; it has none but root and
`xo`, which has sudo. The record says `certificate.made`, and a later policy
change still asks about the certificate, since it is self-signed.

**The VM has no login anybody holds.** The script puts a public key on the VM's
`xo` account; the machine gives it one whose private half is never kept, so the
password stays locked. Xen Orchestra is how the VM is managed.

**Cancel** stops the script where it is. Before the installer ran, nothing was
made. While it ran, the script removes what it made if it is stopped before its
VM starts and keeps the VM after, and the job says what to look for on the pool
rather than claiming either. A failed install keeps its VM, as the script does,
and the job names it.

**What it needs.** The machine needs the tools above, so a Mac needs GNU
`getopt` (`brew install gnu-getopt`, first on PATH). The pool master downloads
Debian's image and the VM downloads Xen Orchestra's sources and node.js, so both
need the internet. Xen Orchestra is built from `vatesfr/xen-orchestra`'s
`master`, as the installer does by default, and keeps itself current through the
update plugin; it is not pinned.

**What has run, and what has not.** Run here: the pinned script itself, through
all six of its stages, against a stand-in `ssh` that runs its remote half
locally with stand-in `xe`, `xenstore-read` and `curl`, with the password
answered through the askpass socket, every client riding the master, and the
cloud-init seed read back to check it carried the certificate, the key and the
configuration. The suite (`test/xo-deploy.test.js`) drives a stand-in script
with the same command line and output, because the installer is GPL and is not
vendored, and then the whole job through onboarding against the suite's stand-in
Xen Orchestra serving the machine's certificate. **Not run:** a real XCP-ng pool
master, a real SSH server, Debian's download, `xo-install.sh` building Xen
Orchestra, and the apps on a device. Whether XCP-ng's own page at the pool
master's address reads as "not Xen Orchestra" to the probe, which is what
offers the install, has not been seen on a real host.

### The policy: what the fleet may use

Setup finishes in one go, with defaults: the resource set it makes holds
each pool's default storage repository and no network, with half the pool's
vCPUs and memory and half the default storage's free space. **It applies
those only when it makes the set.** A set that is already there was made by
an earlier run, or changed since, and running setup again for a new token
leaves it as it is.

Changing it is its own flow, from the app: Machines → Hypervisors → the pool
→ Change what the fleet may use, a row on the pool's page (`manage.md`). The Hypervisors list is the pools this phone keeps
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
3. **The person chooses**: which storage and which networks, which of the
   pool's networks is the way out, and the limits. Sealed to the job's key under
   `fleetwright-xosetup-policy/v1:<job>:<address>`, phase `policy`.
4. **The machine checks the choice against what it showed**, because the
   phone's screen is not the bound: every id must be one the inventory
   listed, at least one storage repository, the way out a network it
   listed (one of the chosen networks, on a machine that predates
   `egress-any`), at least one vCPU, a GiB of memory and ten of disk, and at most
   what the hosts have and the chosen storage holds. A choice that fails is
   refused and the job goes on waiting. One that passes becomes the resource
   set (`resourceSet.set`, its storage, networks and limits), and the egress
   tag moves to the chosen network.

The key the inventory comes back to lives in the screen's memory and
nowhere else, so a screen that is rebuilt while the machine waits (an
Android phone turned, an app closed) can no longer open it, says so, and
offers Cancel. Cancelled, or left for ten minutes, it changes nothing.

**A policy job reports from Apply on.** Until then it is driven from a
screen that is open and waiting on the person, and it sends nothing. From
the apply step it may be building the edge router, minutes of download, so
it sends its progress as onboarding does, with `purpose: policy` beside it.
The coordinator holds those steps to `XOPOLICY_STEPS` and titles them as a
change to what the fleet may use ("What the fleet may use is changed"), not
a hypervisor added. The iPhone starts a Live Activity when the choice is
sent, marked as a policy change so it ends in those words; Android's ongoing
notification draws the same. A coordinator that predates `purpose` refuses
the policy steps and draws nothing, which is how it was.

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

**Face ID is the tap.** Once Face ID or a fingerprint has opened a kept
sign-in, the phone begins by itself as soon as a machine is chosen: at once
for the one that got through last time, or when the person taps one of
several. Asked for: *"After FaceID it should auto connect."* Begin still
sends only what was accepted, so a certificate that needs somebody's word
stops there and asks; a sign-in that was typed never starts anything by
itself.

The fleet never sees any of it. What leaves the phone is what always did:
the sign-in sealed to one job's key on one machine.

**The way out is where the edge router goes.** The policy's way out is the
network the edge OPNsense VM puts its WAN on, recorded as the
`fleetwright-egress` tag on that network. With *Build the edge router on it*
on, Apply builds the router there (["The uplink"](#the-uplink)); the phone
shows the machine's progress under "Applying what you chose", from the
download to the disk. The machine running the job needs `bzip2`, and says
which package to install when it has none.

### Through the phone

**No machine in the fleet can reach the pool: the phone's own network
carries the first minute.** A homelab's Xen Orchestra is often on a Wi-Fi or
a VPN the phone is on and no fleet machine is. When the probe reaches
nothing, the coordinator names a machine that can work through a phone (a
permanent one that speaks protocol 12), and only then does Add a hypervisor
offer **Try through this phone**.

```
machine ──relay frames──▶ coordinator ──WebSocket──▶ phone ──TCP──▶ Xen Orchestra
        └──────────────── TLS, opened by the machine, pinned ──────────────┘
```

1. **The phone looks first.** It reads the certificate at the address
   itself, over its own network, and stops if nothing answers over TLS. It
   says it cannot tell, rather than take a machine's word for a certificate.
2. **It opens a relay** (`GET /api/xosetup/relay`, a WebSocket). The relay is
   for one address, the one the person typed, and one machine. No frame
   names an address: for each connection the machine asks for, the phone
   opens plain TCP to that one address and pumps bytes both ways.
3. **The machine probes through it** (`xoprobe` with `relay`): one TLS
   handshake and one GET of `/signin`, over the relay, HTTPS only, and no
   `ssh-keyscan` beside it. The probe's look over SSH (["A pool without Xen
   Orchestra"](#a-pool-without-xen-orchestra)) would be the machine's own
   network answering, and that is the network that cannot reach the pool.
   The phone offers the machine only when it saw the certificate the phone
   saw. Over a relay the coordinator is on the probe's path, and could
   otherwise answer the handshake with a certificate of its own for the
   person to accept.
4. **The setup runs through it** (`xosetup begin` with `relay`). Every
   connection the job makes goes through the relay. The machine opens TLS
   over it and holds it to the pin (`src/fleet/host/xo-relay.js`, `connectXo`
   with `via`). The phone and the coordinator carry TLS records, with the
   sign-in and the token inside them. Neither can read them. Everything
   after that is the setup as it always was: the key check, the sealed
   sign-in, the steps, the token sealed back to the phone.

**The screen has to stay open.** A relay is the phone's socket. iOS suspends
an app's sockets in the background, and Android's screen closes the relay
when it goes, a rotation included. The screen says so while the setup runs.

**What bounds a relay** (`src/fleet/coordinator/relays.js`):

- **One person and one phone.** Only an admin's own device credential can
  open one; the break-glass token has no phone. Only that device may name
  the relay in an intent.
- **One machine, chosen when it is opened.** Frames from any other machine
  are refused.
- **One probe, then one job.** The machine may open connections only while
  its probe is in flight or its job is bound to the relay, eight at most.
- **Fifteen minutes and 64 MiB**, then it is closed. It is also closed when
  the job ends (progress, a `status` that says so, or the machine's own
  `done`), when the phone or the machine leaves, and on any frame that is
  not the relay's.
- **HTTPS only.** Plain HTTP is refused through a phone by the coordinator
  and the machine. Over plain HTTP the phone and the coordinator could read
  the sign-in.
- **No install.** Installing Xen Orchestra (`deploy`) is SSH to the pool
  master and the installer's own downloads, which a relay does not carry.
  The machine refuses a `deploy` that names a relay before it makes
  anything, in words: installing Xen Orchestra needs a machine that reaches
  the pool. Neither phone offers it after an answer through the phone.
- **No gigabytes.** Building the edge router or a machine image uploads its
  disk to Xen Orchestra over HTTP connections a relay does not carry, and
  labs are interfaces on the edge router, which is built again with them.
  So a policy job through a phone refuses all three and goes on waiting for
  a choice without them. A policy job that makes the pool its own machine (A
  machine of its own) fits, where the pool already has a machine image. That
  machine then reaches Xen Orchestra itself, and holds the pool with the app
  closed.

**What has run, and what has not.** `test/relay-end-to-end.test.js` runs the
Node coordinator, a real sidecar and the suite's stand-in Xen Orchestra over
TLS with a pinned self-signed certificate, at a `.invalid` name only the
phone (played by the test) can resolve:

- the machine's own probe finds nothing;
- the probe through the phone sees the certificate the phone sees;
- the setup finishes and the token comes back sealed;
- the stand-in received the admin password, and every connection began with
  a TLS record;
- none of the password, the admin email, `session.signIn` or the token
  appears in the bytes the phone carried;
- an install through the phone is refused, the phone is asked to connect
  nowhere, and the relay closes.

`test/xo-deploy.test.js` holds the probe through a phone to one connection
and no `ssh-keyscan`, against the fake pool master's.

The Android relay compiles and its unit tests run. **Not run:** the Worker's
relay socket in workerd, the iPhone's relay (Swift compiles only in CI), and
either phone against a real Xen Orchestra.

### Next: a pool's first machine image

- **A pool without Xen Orchestra** is built ("A pool without Xen Orchestra").
  The same image cache on the storage repository could build the templates
  and the pool's own machine, which today download their own images.
- **A pool's first machine image through the phone.** A pool that has none
  cannot be given its own machine through a relay, because the image is a
  disk of gigabytes. Xen Orchestra fetching the cloud image itself, or the
  pool master doing it over SSH as `xo-remote-deploy.sh` does, would let
  that first minute make the pool's own machine there too.

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

1. **Xen Orchestra**, if there is none: deploy it (built, "A pool without Xen
   Orchestra").
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
  inspect traffic with. What it looks for is the task. A machine's page shows
  how much it sent and received, as the hypervisor counted it, and not what
  or where.
