# WhatsApp, and what it is allowed to be

WhatsApp is rolling out **chats with third-party agents**: a person adds an
agent in the app's own settings, gives it a name and a picture, and WhatsApp
mints an API key they paste into whatever hosts that agent. Five per account,
one-to-one chats only, no groups, and — stated plainly in the announcement —
**not end-to-end encrypted**, because one end is a service rather than a
device. Android beta 2.26.35.3, a small number of users, a handful of
countries.

This document is written **before** it can be built, which is the reason to
write it: the shape of the thing is already decided by arguments this
repository has had twice, and the version somebody would reach for first is the
version both of those arguments refused.

## The fact that decides everything

Not the chat. **The key is minted by the person, in their own settings, and
carried by hand to a service they chose.**

That is the same movement as every credential in
[`connectors.md`](./connectors.md) — *"the person creates the credential, on
their account, under their own eyes, and pastes it back once"* — and it is why
this is not the Business API. There is no business verification, no message
templates, no 24-hour window, no review of what the agent is for. It is bring
your own bot, scoped to one person, capped at five.

## The claim: another MCP client, not another adapter

**Nothing in this repository changes.** A WhatsApp bridge is the thing
[`mcp.md`](./mcp.md) already describes and already tests:

> A member of the fleet holding one device credential, with exactly that
> person's visibility. Not an admin channel, not a second authority.

Every coordinator already serves that server over HTTP at `/mcp`, and
`routes.js` hands the bearer token straight through as the credential — so a
headless bridge needs no browser and no OAuth dance at all. It holds an `fwk_…`
minted in the app, exactly like a phone, listed beside every phone, revoked
from the same screen.

```
WhatsApp ──▶ bridge ──▶ Messages API ──/mcp──▶ coordinator ──ws──▶ host
             (one fwk_…, one person's visibility)
```

The bridge writes no tool loop and no protocol code. The Messages API attaches
a remote MCP server directly, and it needs **both halves** or it is refused as
a validation error:

```js
mcp_servers: [{ type: 'url', url: 'https://fleet.example/mcp', name: 'fleetwright' }],
tools:       [{ type: 'mcp_toolset', mcp_server_name: 'fleetwright' }],
betas:       ['mcp-client-2025-11-20'],
```

The bearer goes on the server entry; check the field name against the current
Messages API documentation rather than against this paragraph, because that is
exactly the kind of thing that moves.

## Identity: the question Telegram could not answer, and why this one can

[`telegram.md`](./telegram.md) is archived on one sentence:

> `telegram:12345` is a number in a chat app, and no amount of allowlisting
> turns it into an account.

[`wanted.md`](./wanted.md) refuses the Telnyx-shaped version harder, and
correctly: *"a phone number is public by construction — anyone who learns it
can send to it — and caller ID and SMS sender IDs are both spoofable, so
neither is an authentication."* [`plan.md`](./plan.md) §4 closes it as *"an
inbound channel authenticated by spoofable caller ID pointed at a system that
just spent a rework making identity real."*

All of that is still true, and **a WhatsApp bridge does not contradict any of
it, because it never authenticates the WhatsApp user at all.**

The binding happens once, out of band, and it is the same binding the stdio MCP
server has: the person who pastes the agent key into the bridge is the person
who signed in and minted the `fwk_…`. One agent slot, one device credential,
one member's visibility. A phone number never becomes an actor; there is no
`whatsapp:<number>` and there must never be one. The five-slot cap reinforces
the right shape rather than fighting it — this is personal, and a shared one
would be the shared-credential failure the whole project is written against.

**The rest of the Telegram objection has gone stale, and that is worth
recording too.** The other half of §4's refusal was that a chat client *"would
multiply reach over a loop that still dead-ends"*. It does not dead-end any
more: `answer` ships, taking an ordinal into a host-published list with a
`promptId` closing the temporal hole, and `fleet_await` returns on a session
coming back to its prompt. The reach argument was contingent on a gap that has
since been filled. The identity argument was not, which is why it is the one
this document had to answer.

## Not end-to-end encrypted, which bounds what it may render

This is the sharpest cost and it is not a detail. Everything the bridge says
travels through, and rests on, a third party's servers.

[`plan.md`](./plan.md) 5.4 already makes pane text in a push body opt-in per
fleet and off by default. The same gate has to apply here and harder, because
push at least lands on a device the person holds:

| | through WhatsApp |
|---|---|
| session names, titles, states, counts | the case this exists for |
| the fleet's own refusal strings | yes — they are written to be read by a person |
| pane text, prompt bodies | only under the same switch that governs push, never by default |
| **a Remote Control URL** | **never** |

The last row is not a preference. [`mcp.md`](./mcp.md) records that
`fleet_list` once returned *"a live Remote Control URL into anything running"*
to any member, and that it took the coordinator writing the listing itself to
fix. A live RC URL is credential-shaped; posting one into a third party's
message store is handing it to whoever holds that store, for as long as they
keep it.

## Three lines it may not cross

**1. No free text into a pane.** [`plan.md`](./plan.md) §4: *"arbitrary bytes
may never reach a terminal, and may not reach a model's context either while
`dangerous` is the default mode."* The good property here is that the rule is
**structural rather than disciplinary** — there is no verb that carries
arbitrary text, so a model driving `fleet_*` tools cannot express the thing
even if it tries. The bridge inherits the bound instead of promising to respect
it, which is the only kind of promise worth having.

**2. `answer` stays in `DEFAULT_DENY`.** The comment in `src/mcp/tools.js` is
the whole argument: *"the prompt exists because a session stopped to ask a
person something, and an agent that answers it has decided on that person's
behalf that it knew what they wanted. Sometimes true. Never true by default."*
A chat window makes this tempting in a way the stdio server never did, because
the person is **right there** — and that is precisely the case where the model
must not be the one choosing. If the bridge relays a prompt and its options,
the person types the digit and the **bridge** calls `answer` with it. The model
renders the question; it does not select the answer.

**3. It is a pull surface, not a second notification channel.**
[`psychology.md`](./psychology.md) §1: an event fires on a transition, never on
a state, and *"the interruption budget belongs to the sessions"*. Push is built
and confirmed on both platforms. A second channel buzzing the same fact spends
the budget twice for no information, and the thing it costs is the notification
that mattered.

## Where it lives

**Its own repository, consumed as an MCP client — not a layer in this one.**

[`plan.md`](./plan.md) §4 closed Telnyx/Inkbox on scope as *"a different
product in a different repository"*, and that reasoning survives the identity
answer above intact. Three things follow:

- The coordinator does not grow a Claude API key or a Meta credential. It is
  internet-facing by design and [`trust.md`](./trust.md) spends its whole
  argument keeping secrets out of it.
- The bridge is replaceable. A channel that is an MCP client can be rewritten,
  abandoned or forked without a protocol version, an App Store queue or a line
  in `src/`.
- It is the [`wanted.md`](./wanted.md) Inkbox-shaped thing arriving for a
  fraction of its cost — one channel, the one whose identity story happens to
  work, rather than the telephony third that does not.

## What it actually buys, ranked honestly

1. **A guest with no app.** [`accounts.md`](./accounts.md) turns on a guest
   bringing their own accounts and having no shell on any box; today they also
   need a TestFlight build or a Play install. One browser sign-in and a pasted
   key is less than that.
2. **Dictation, and a keyboard somebody already has at 3am.**
3. **The fleet-spanning question in words.** *Which of my eleven sessions needs
   me* is a sentence before it is a list, and
   [`app-parity.md`](./app-parity.md) already noticed the ordinal form of
   `answer` is *"the right design for voice, by accident"*. It is right for
   chat for the same reason.

And what it does not buy, so nobody expects it: conversation with a session.
[`plan.md`](./plan.md) §1 settles that — *"Remote Control already drives one
session you already knew about, with structured messages, diffs and real
permission UI — it will always beat a pane-scraper at conversation, and we
should stop trying."* The escape hatch is a link that leaves the chat, the same
as it is a link that leaves the app.

## What is not decided

- **Whether the key is a bearer, a webhook secret, or both.** The announcement
  says a key is minted and pasted; it does not say what authenticates the
  requests *to* the bridge. If inbound deliveries are not signed, the bridge is
  an unauthenticated endpoint that reaches a fleet, and the answer is the one
  `design.md` already reached for Telegram webhooks: a secret the platform
  returns on every request is what authenticates it, and the user id in the
  payload is data rather than a signal.
- **What happens with five agents and one fleet.** Five slots per WhatsApp
  account, one device credential each, is five credentials for one person. That
  is fine and possibly useful — a slot per fleet — but nothing has been built
  that would make it coherent.
- **Availability.** It is Android beta in a few countries. Nothing here should
  be built against it until the key-minting flow can be read from the real
  settings screen rather than from a screenshot in a news post.

If the setup flow turns out to be different from the description above — in
particular if the key is issued to a *developer* rather than minted by the
*person* — then the identity section of this document is wrong and the whole
thing collapses back into the Telegram refusal. That is the single fact to
check first.
