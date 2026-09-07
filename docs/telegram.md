# Telegram, and why it is archived

The Telegram adapter is no longer started. The code is kept, unwired, at
`archive/telegram/telegram.js`; this document is the part that has to
outlive it.

It is here because **the reasons it was built are not the reasons it was
retired**, and one of them is still the best argument in the repository
for a design decision that survives it.

## What it was

A long-polling bot. `getUpdates` with a 30-second timeout, in a loop, and
a reply posted back with `sendMessage`. Roughly 320 lines, one file, no
dependencies.

It reached the same command registry as the web UI and the CLI —
`src/adapters/commands.js` — so a command typed into a chat could not
behave differently from the same command typed into a terminal. That
seam is the thing worth keeping, and it is still load-bearing: the fleet
sidecar goes through it too, which is why `docs/intents.md` can say a
fleet verb cannot do something the chat command cannot.

## Why long polling, which is the part still worth reading

`getUpdates` is an **outbound** long poll. The box needs no public
hostname, no inbound firewall rule, no TLS certificate and no tunnel. It
worked identically on a datacentre VM, a laptop behind NAT, and a
Raspberry Pi on somebody's home wifi.

That property is why Telegram was the recommended surface for a year,
and it is the same property the fleet sidecar has now: a host dials out
to the coordinator and holds the connection open. The adapter is gone;
the shape it proved is what the whole fleet runs on.

## The decisions in it, and which ones moved

**One poller per bot token.** Telegram answers a second concurrent
`getUpdates` with HTTP 409, so two hubs sharing a token fight. The
adapter detected 409 specifically, said so in one sentence naming the
cause, and slept thirty seconds rather than hammering. *A different
failure from "the network is down" gets a different message* — the same
rule the coordinator's refusals follow now.

**The offset advances BEFORE the handler runs.** A command that crashed
the handler must not be redelivered on every poll for ever; that turns
one bad message into a permanent loop. This is the same argument as the
sidecar's replay window, arrived at independently.

**There was no "open to everyone" mode.** A session on this box is
unsupervised shell access, so an empty allowlist meant the bot answered
`/whoami` and refused everything else. `/whoami` was answerable by
anybody on purpose — it is how a new operator finds the id to add, and a
bot that refuses to tell you your own id is a bot you cannot configure.

**Buttons were a reply field, never parsed out of prose.** A reply
carried `buttons: [{ label, command }]` and the adapter rendered them as
an inline keyboard, dropping any whose command exceeded Telegram's
64-byte callback limit rather than truncating it into a different
command. Both apps take the same field today, for the same reason.

**Backoff only on failure.** A successful long poll returns and goes
straight back in, so a command is picked up the moment it is sent.

## What did NOT move, and is the reason it is archived

**Identity.** A Telegram user id is not a person this fleet knows. The
actor string was `telegram:<numeric id>`, and `src/core/accounts.js`
treats that — along with `web` and `cli` — as *somebody operating the
box* rather than as a fleet identity. It falls back to the box's own
credential row.

That was fine when one person ran one hub. It is the wrong shape for
what this became: guests bring their own GitHub, Cloudflare and Claude
credentials, and `docs/accounts.md` turns on being able to say *which
verified person* is asking. A `fleet:<email>` actor comes from an ID
token the coordinator checked. `telegram:12345` is a number in a chat
app, and no amount of allowlisting turns it into an account.

So the adapter could not have been given per-person credentials without
inventing a mapping from Telegram ids to emails that nobody could
verify — which is exactly the shared-credential shape the whole project
is written against.

**The actor namespace stays.** `telegram:<id>` still parses, still reads
as "no fleet identity", and sessions recorded with `createdBy:
"telegram:12345"` still render. Removing the adapter must not rewrite
history that is on disk on real boxes.

## What replaced it

The two apps and the MCP server, over `/api/intent` — see
`openapi.json`, which is the contract, and `test/spec-clients.test.js`,
which asserts every route in it is reachable by one of them.

## Turning it back on

It is not wired. `AGENT_HUB_TELEGRAM_TOKEN` is still read, only so that
setting it produces a warning saying this rather than silently doing
nothing — a feature that is configured and absent is worse than one that
is plainly gone.

Restoring it means moving `archive/telegram/telegram.js` back to
`src/adapters/`, re-adding the four lines in `src/index.js`, and
answering the identity question above. The first two are typing. The
third is the reason it is here.
