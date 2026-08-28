# Hosts that are expected to vanish

A CI runner is a host with a job and a clock: it enrols, works, and is
destroyed. Every default the registry has is built for a real box that might
come back — and each of them is wrong for a runner in a way that *accumulates*,
one corpse per build.

**This does not replace permanent hosts, and is not meant to.** Self-hosted
boxes on Linux, macOS and Windows stay the backbone: they hold conversations
across days, they can reach internal resources, and they are where the long
sessions this product exists for actually live. An ephemeral host is for work
that needs **no internal access and no persistence** — build this, test that,
verify it compiles on a platform nobody owns. Deciding which is which is the
whole point of keeping them distinct rather than making all hosts temporary.

## What the framework changes

**Ephemeral is decided when the pin is minted**, not claimed by the host. A host
that could declare itself permanent is a host that never gets cleaned up, and
the pin is already the thing that authorises admission — so it is the right
place to say what is being admitted.

**Placement is opt-in.** An ephemeral host is never chosen for you. It has
plenty of free capacity, being empty, which is exactly why capacity must not be
what selects it — ordinary work placed there is lost when the job ends. It stays
reachable for reads, listable, and addressable **by name** through the placement
preference. A fleet whose only matching hosts are temporary refuses and says so,
rather than quietly starting work that will disappear.

**A disconnect retires it.** For a real box, `disconnect` keeps the entry: it may
come back, and its last known sessions are the best guess about where a `resume`
would land. A runner will not come back — the job ended and the machine was
destroyed — so the entry is deleted and its key revoked. Retired at the moment
of disconnect rather than swept later, because the disconnect *is* the event;
there is nothing to wait for.

**The key goes with it.** Otherwise the registry stays clean and the enrolled
list fills up instead: one dead key per job, for ever, each of them a credential
that would still be accepted if the private half ever leaked out of a build log.

## What still has to be true for the Actions case

- **A unique host id per run.** Two jobs sharing one identity is the clone bug
  in a new costume, and we have paid for that lesson once already. `run_id` and
  `run_attempt` are both needed — a re-run reuses the id.
- **A pin minted per job**, by something CI holds. Pins are already short-lived,
  single-use and host-bindable, so the mechanism fits unchanged; what needs
  deciding is which credential CI holds to mint one, because it is a credential
  that can admit a machine.
- **The session cannot outlive the host.** `resume` is pinned to the box holding
  the volume, so when a runner goes, its sessions are gone. That is correct and
  needs saying out loud rather than being discovered.

## What it is not for

A runner is capped (six hours, no persistence, and Apple's licence still governs
what may run on their hardware). It is right for a build and wrong for the
long-lived session this product is otherwise about. If a piece of work needs to
reach something inside your network, it wants a permanent host — that is not a
limitation of this feature, it is the line that makes the feature safe.
