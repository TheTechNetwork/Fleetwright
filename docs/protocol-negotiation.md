# Version negotiation: a protocol bump that strands no host

**Status: design, not built.** Written before the code, the way `trust.md` and
`plan.md` were, because this changes the one check that runs before any other —
the version gate — and a change there is a change to the security boundary. It
should be argued on paper first.

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
  that is *behind* is **one-tap-updatable from the app**: tap Apply update, it
  pulls the new code, it comes up on the new protocol. The coordinator even
  says so (`explainUnsupportedVersion`).

So today's honest picture on a bump is not "the fleet freezes." It is:

| host state | what happens now | fixable from the app? |
|---|---|---|
| behind the coordinator | degraded; rejects normal intents; **Apply update works** | **yes** |
| ahead (hosts-first window) | degraded until the coordinator is deployed | no — deploy the coordinator (once, not per host) |

The residual cost is the **degraded window**: between the bump and each host
being updated, that host does no normal work. This document removes that window.

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
oldest protocol this host's code still accepts. A host built at v4 that can
still correctly read a v3 envelope advertises `{ protocolMin: 3, protocol: 4 }`.

Additive: an old host sends only `protocol`, and the coordinator reads a missing
`protocolMin` as "equal to `protocol`" — i.e. exact-match, exactly as today. So
existing hosts behave unchanged; the range only widens once a host runs
range-aware code.

### 2. The host accepts any version in its own range

`validateIntent` changes from `env.v !== PROTOCOL_VERSION` to
`env.v < PROTOCOL_MIN || env.v > PROTOCOL_VERSION`. A v4 host with
`PROTOCOL_MIN = 3` accepts a v3 or a v4 envelope and refuses a v2 or a v5 one —
the refusal is still a real boundary, now a window instead of a point. The
rescue path stays exactly as it is, for hosts older than `PROTOCOL_MIN` and for
the belt-and-braces of a box that drifted below the floor.

### 3. The coordinator speaks each host's version, for every verb

Today `buildIntent` stamps `PROTOCOL_VERSION` and only re-stamps *down* for a
rescue `update`. It changes to stamp `min(PROTOCOL_VERSION, hostMax)` for every
intent to that host — the highest version both ends understand. The coordinator
already records each host's `protocol` from health; it now records the max and
uses it. A host newer than the coordinator is spoken to in the coordinator's own
max, which that host accepts because its range reaches down to include it.

### 4. Parameters carry the version they arrived in, and the coordinator gates on it

Each param in `VERBS` gains a `since` (the protocol version that introduced it;
absent means "from the beginning"). When the coordinator speaks version `N` to a
host, it **omits any param whose `since > N`**. Two cases follow:

- **The new param is optional** (the common case — `start.secret`, `start.profile`).
  Omitting it means the older host runs the verb without the new capability, and
  the caller is told the box is too old for that one feature — not that the whole
  command failed. A picker greys the option out for hosts that cannot take it,
  the way it already greys a profile a box does not have.
- **The new param is required** for what was asked. The coordinator refuses
  *that request* with an actionable sentence — "this host speaks v3 and `X`
  needs v4; Apply update on it" — which is the same shape as the profile/secret
  "this host does not have it" refusal, and still not a wholesale rejection.

### The invariant that makes a range safe

A range is only safe if an old envelope means the same thing under new code. So
the rule the protocol already follows becomes a rule it is *held* to:

> **A version bump may only ADD a verb or a param. It may never remove one, nor
> change what an existing one means.**

An old envelope is then a strict subset of a new one, and reading it under new
code is sound by construction. This is enforced, not trusted: a test asserts
that every param's `since` is immutable across versions and that no verb or
param present at version `N` ever disappears — the same shape as the existing
frozen-`RESCUE_PARAMS` test. Break the invariant and the test fails before the
range can carry a wrong meaning.

### PROTOCOL_MIN: the floor, and the only remaining flag day

`PROTOCOL_MIN` is the oldest version the current code accepts. Routine feature
bumps raise `PROTOCOL_VERSION` and leave `PROTOCOL_MIN` alone — seamless.
*Raising* `PROTOCOL_MIN` (dropping support for an ancient version) is still a
flag day for anything below it, but it is rare, deliberate, and decoupled from
shipping features: you do it to delete compatibility code, not to add a
parameter. A host below the floor is exactly the case the rescue `update` still
covers — it can be updated from the app before the floor moves.

## Why this is safe, said plainly

- The version check is still a boundary: a range, not an open door. An envelope
  outside `[PROTOCOL_MIN, PROTOCOL_VERSION]` is refused as loudly as before.
- The coordinator speaking *down* cannot invent a capability a host lacks — it
  can only decline to use a new one. It never sends a param an old host would
  misread, because `since`-gating strips exactly those.
- The append-only invariant is the load-bearing part, and it is tested rather
  than promised. Without it, a range is a way to feed a host an envelope whose
  meaning shifted under it; with it, an old envelope is a subset and nothing
  shifts.
- Nothing here touches the fixed verb set, the signed-intent direction
  (`trust.md`'s third table row), or the rule that the coordinator names rather
  than carries. It is strictly about *which numbers a host will read*.

## What it does NOT solve

- **A coordinator older than a host's floor.** If a host has moved its
  `PROTOCOL_MIN` above the coordinator's max, the coordinator cannot speak a
  version that host accepts. That is the deliberate floor-raise above, and the
  remedy is deploying the coordinator. It is rare and it is loud.
- **Misuse, as ever.** Negotiation is about reachability, not authorization —
  `trust.md`'s "what this does not solve" still stands.

## Migration

The first deploy of range-aware code is the last exact-match transition, and it
is itself seamless in the direction that matters: a range-aware coordinator
speaks v3 to the v3 (exact-match) hosts already in the field, which they accept
unchanged, and speaks the new version to hosts once they update. After that
deploy, every bump up to `PROTOCOL_MIN` strands nothing. The `secret`-references
v4 bump can be the first one that rides it, or the last one that does not —
either way this lands as its own round, coordinator + host, with the apps
unchanged (they already read `protocol` from health and would gain nothing from
`protocolMin`).

## The order to build it

1. **`PROTOCOL_MIN` + range accept in `validateIntent`**, with the rescue path
   untouched. Host-side, and the security-sensitive core — its own tests first.
2. **`since` on params + the append-only test.** The invariant, enforced.
3. **`protocolMin` in health + the coordinator speaking per-host max for every
   verb + `since`-gating on send.** The coordinator half.
4. **Docs**: fold the "flag day" language in `intents.js`, `plan.md` and
   `CONTRIBUTING.md` into "seamless down to `PROTOCOL_MIN`", and record what a
   floor-raise still costs.
