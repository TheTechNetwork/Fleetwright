# Version negotiation: a protocol bump that strands no host

**Status: built.** `PROTOCOL_MIN` + range accept in `validateIntent`, `since` on
params with the append-only invariant enforced by
`test/protocol-appendonly.test.js`, `protocolMin` in the health frame, and the
coordinator speaking each host its own highest understood version in
`buildIntent`. The design is below as it was argued on paper first — this changes
the one check that runs before any other, the version gate, which is a change to
the security boundary — and the **As built** section at the end records where the
implementation chose specifics.

## The problem, stated at its real size

`validateIntent` refuses any envelope whose `env.v` is not exactly
`PROTOCOL_VERSION`, and it refuses it *before the verb is read*. That exactness
was a deliberate choice: "we understood each other" is then guaranteed, and a
host on the wrong number fails loudly rather than acting on an envelope it half
understands. The cost is the **flag day** — bump the number and every host on
the old one refuses everything until it is updated.

Two things already soften this, and they are why this is an improvement rather
than a rescue:

- **A verb is free to add.** An old host answers `unknown_verb` and strands
  nothing. Only a *parameter on an existing verb* forces a bump, because
  `bad_params` arrives after the version check has already agreed.
- **`update` survives a mismatch.** `RESCUE_VERB` — `update` carrying at most
  `restart` — bypasses the version check entirely (`isRescue` in `intents.js`),
  and the coordinator re-stamps it to a lagging host's own version. So a host
  that is *behind* is **one-tap-updatable from the app**.

So today's honest picture on a bump is not "the fleet freezes." It is a
**degraded window**: between the bump and each host being updated, that host does
no normal work. This document removes that window.

## The goal

A protocol bump strands no host. A newer coordinator and an older host keep
working together; the older host simply does not get the *new* capability until
it updates, and it is told that per-capability rather than by refusing
everything. Rollout order stops mattering. New features light up per-host as
hosts update, the way `unknown_verb` already lets a new *verb* light up.

## The design

Four changes, and one invariant that makes them safe.

### 1. A host advertises a supported RANGE, not a point

`health` carries `protocol` (a single int) today. It gains `protocolMin`: the
oldest protocol this host's code still accepts. Additive: an old host sends only
`protocol`, and the coordinator reads a missing `protocolMin` as equal to
`protocol` — exact match, exactly as today.

### 2. The host accepts any version in its own range

`validateIntent` changes from `env.v !== PROTOCOL_VERSION` to
`env.v < PROTOCOL_MIN || env.v > PROTOCOL_VERSION`. The refusal is still a real
boundary, now a window instead of a point. The rescue path stays exactly as it
is, for hosts older than `PROTOCOL_MIN`.

### 3. The coordinator speaks each host's version, for every verb

`buildIntent` stamps `min(PROTOCOL_VERSION, hostMax)` (never below the
coordinator's own floor) for every intent to a host — the highest version both
ends understand — instead of always `PROTOCOL_VERSION` and re-stamping down only
for a rescue `update`.

### 4. Parameters carry the version they arrived in, and the coordinator gates on it

Each param in `VERBS` gains a `since` (the protocol version that introduced it;
absent means "from the beginning"). When the coordinator speaks version `N` to a
host, it **omits any param whose `since > N`**. An optional new param leaves the
older host running the verb without the new capability; a required one refuses
*that request* with an actionable sentence rather than a wholesale rejection.

### The invariant that makes a range safe

> **A version bump may only ADD a verb or a param. It may never remove one, nor
> change what an existing one means.**

An old envelope is then a strict subset of a new one, and reading it under new
code is sound by construction. This is enforced, not trusted:
`test/protocol-appendonly.test.js` holds a frozen baseline of the whole wire
surface and fails if a verb or param disappears, if any `since` changes, or if a
new one is added without being recorded.

### PROTOCOL_MIN: the floor, and the only remaining flag day

Routine feature bumps raise `PROTOCOL_VERSION` and leave `PROTOCOL_MIN` alone —
seamless. *Raising* `PROTOCOL_MIN` (dropping support for an old version) is still
a flag day for anything below it, but it is rare, deliberate, and decoupled from
shipping features. A host below the floor is exactly the case the rescue `update`
still covers.

## What it does NOT solve

- **A coordinator older than a host's floor.** If a host has moved its
  `PROTOCOL_MIN` above the coordinator's max, the coordinator cannot speak a
  version that host accepts. That is the deliberate floor-raise, and the remedy
  is deploying the coordinator. Rare and loud.
- **Misuse, as ever.** Negotiation is about reachability, not authorization —
  `trust.md`'s "what this does not solve" still stands.

## As built

Where the implementation chose specifics the design left open:

- **`PROTOCOL_MIN = 2`, not 3.** The design said it "starts at exact match"
  (`MIN == VERSION`). It ships at 2 instead, because it is honest and it makes
  the mechanism live rather than dormant. The protocol has only ever added — v2
  added the credential verbs, v3 added `start.profile` and `profiles` — so a v2
  envelope is a strict subset of a v3 one and this code reads it soundly. Setting
  the floor at 2 means a v2 host is negotiated to v2 and keeps working *today*,
  and it is what exercises the `since`-gating and range paths under test rather
  than leaving them asserted-but-unrun against `intents.js`'s 99% coverage floor.
  v1 is left below the floor: the v1→v2 change is further back than the code will
  vouch for as purely additive, and a v1 box is the rescue `update`'s job.

- **The degraded classification moved with it.** `registry.js` degrades a host
  on version only when its `[protocolMin, protocol]` range does not OVERLAP the
  fleet's `[PROTOCOL_MIN, PROTOCOL_VERSION]`. "Behind" now means below the fleet
  FLOOR (rescue `update` still reaches it); "ahead" means above the ceiling
  (waiting on a coordinator deploy). A host one version back is neither — it is
  negotiated, and healthy.

- **The returned intent keeps the version it was accepted at.** `validateIntent`
  no longer relabels the parsed intent to `PROTOCOL_VERSION`; it preserves
  `env.v`, so a reply can carry the version actually spoken.

- **The apps are unchanged.** They already read `protocol` from health and would
  gain nothing from `protocolMin`; the coordinator builds the envelope.

## Migration

The first deploy of range-aware code is the last exact-match transition, and it
is seamless in the direction that matters: a range-aware coordinator speaks v3 to
the v3 hosts already in the field, which they accept unchanged, and speaks the
new version to hosts once they update. After that deploy, every bump up to
`PROTOCOL_MIN` strands nothing. The `secret`-references v4 bump can be the first
one that rides it: adding `start.secret` with `since: 4` lights it up per-host as
hosts update, with no coordinated round and no degraded window.
