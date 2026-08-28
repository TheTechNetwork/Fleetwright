# Deploying the coordinator to Cloudflare

§4's reasoning, which has not changed: you own no port, no VM, no cert and no
tunnel daemon. Hosts open an outbound WebSocket, a Durable Object pins it, and
the phone speaks HTTPS to the same origin. This is **not a tunnel** — nothing is
aimed at your boxes; they are ordinary clients.

It answers on **https://fleet.thetech.network**, configured as a custom domain
in `wrangler.toml`, so Cloudflare creates and manages the DNS record and the
certificate. There is nothing to point anywhere by hand.

That hostname is load-bearing in one specific way: §5 has each host PIN the
coordinator origin it will talk to, so changing it means editing every host's
`/etc/agent-fleet-sidecar.env`. It is not a value to churn.

## Deploy

```sh
cd worker
npx wrangler secret put AGENT_FLEET_API_TOKEN      # openssl rand -hex 24
npx wrangler deploy
```

The Worker **refuses every request** until that is set. A coordinator with no
credential is remote control of every box in the fleet for anyone who finds the
URL, and a Worker URL is not a secret.

That token is **break-glass, not the everyday credential**. It can stop every
session and revoke every host. Phones sign in and are issued their own; hosts
never have it at all.

### Sign-in

Three more — and unlike the token above, **none of them is a secret and none of
them is `secret put`**. They live in `[vars]` in `worker/wrangler.toml` and
deploy with the code. This page used to say `secret put` for all three, which
was wrong twice over: it hides who can reach the fleet in a place nobody
reviews, and setting a secret whose name is already a `[vars]` key collides at
deploy time.

They are already filled in there. Changing them means editing that file and
running `npx wrangler deploy`:

```toml
AGENT_FLEET_AUTH_ISSUERS = "https://accounts.google.com,https://appleid.apple.com"
AGENT_FLEET_AUTH_AUDIENCES = "network.thetech.fleetwright,654943059314-kosvngt4ggmdguksogppoiglo48nvm2i.apps.googleusercontent.com"
AGENT_FLEET_AUTH_ALLOW = "@thetech.network,elibrody2@gmail.com"
```

Which is the point of keeping them there: **who can reach a fleet is a
reviewable diff**, not a value somebody typed into a prompt at midnight and
cannot later account for.

**The audience is two values, and they are not symmetrical.** Apple issues its
ID tokens for the **iOS bundle id**. Google issues them for the OAuth **web**
client id — `client_type: 3` in `google-services.json` — which the Android app
names as its server client. It is *not* either of the Android client ids in
that same file; those are what the request is authorised by, while the web
client is what the token is issued *for*, and `aud` is what gets verified.

**The allowlist is matched against the verified email in the ID token**, so it
has to be the address actually signed in with rather than the one that ought to
work. A bare `@domain` matches the whole domain; anything else must match in
full, case-insensitively. `@thetech.network` on its own would refuse the person
who owns this fleet, whose Google account is a gmail one — and the refusal reads
"… is not on this fleet's list", which is accurate and sounds like a bug.

Sign in with Apple will present whatever address that Apple ID uses, which may
be a third address again. Add it once it is known.

`AGENT_FLEET_AUTH_ALLOW` empty allows **nobody**. That is deliberate: a
coordinator that has not been told who is allowed should refuse everyone rather
than everyone.

### Hosts

There is nothing to set. A host generates its own keypair, presents the public
half once with a six-digit pin, and signs a fresh nonce on every connection —
see [`trust.md`](./trust.md). Mint the first pin with the admin token:

```sh
curl -sX POST https://fleet.thetech.network/api/enroll \
     -H "authorization: Bearer $AGENT_FLEET_API_TOKEN" \
     -H 'content-type: application/json' -d '{"kind":"host"}'
```

then on the box, as the service user:

```sh
agent-fleet-sidecar enrol 123456
```

or send `/enroll 123456` to that box's Telegram bot, which does the same thing
without an SSH session.

Optionally, for push:

```sh
npx wrangler secret put AGENT_FLEET_FCM_SERVICE_ACCOUNT < service-account.json
```

Base64 of that file is accepted too, and is what you want if this coordinator
ever moves to a box — see [`push.md`](./push.md).

## A demo fleet, on its own domain

**`fleetdemo.thetech.network`**, same Worker, same deploy. `custom_domain =
true` in `routes` means wrangler creates the DNS record and the domain binding
itself — adding it was one line and nothing manual.

The domain is the boundary, and that is a stronger claim than the token ever
supported. `worker.js` matches `AGENT_FLEET_DEMO_HOST` **above the host
routes**, so a request there never reaches enrolment, a websocket, sign-in, or
the Durable Object. Not "the demo branch runs first" — the routes are not
reached at all, and no credential presented on that hostname can change the
answer.

The position matters and is the reason the check is where it is: if it sat
where the token check sits, `/host/connect` on the demo domain would have
returned earlier and joined the real fleet. **Demo must not become a way in**,
and the way to guarantee that is to answer before the door exists rather than
to remember not to open it.

Both apps have a **"Look around the demo fleet"** button that points at it.
There is no longer a paste-a-credential field in either app: asking somebody to
find a token in this document and paste it into a field labelled "credential"
is a fair description of no demo at all. The constants are pinned to this file
by `test/demo-button.test.js`, so changing the host or the token without
shipping both apps fails CI rather than silently leaving installed builds
pointed at a domain that answers nothing.

Getting back in when sign-in itself is broken is now curl with
`AGENT_FLEET_API_TOKEN`, not a field on every user's settings screen.

## A demo token, for App Store review

App Store review needs credentials that work, and no reviewer's address is on
anybody's allowlist — so signing in cannot be the answer, and
`AGENT_FLEET_API_TOKEN` can stop every session in the fleet. So there is a
third, optional token, and the apps have a collapsed "use a credential instead"
field to put it in:

It is a **`[vars]` entry in `wrangler.toml`, not a secret** — committed, and
deployed with the code:

```toml
AGENT_FLEET_DEMO_TOKEN = "demo-3a2ec7773eabcd4e38a9a880296a4e4b"
```

That is deliberate. The string authorises exactly one thing: reading the
fabricated fleet. There is nothing behind it to reach, so publishing it costs
Worker invocations and nothing else — and in exchange there is no secret to
rotate, no manual step before a deploy, and no way for App Store review to be
blocked on somebody being awake to paste a value.

It is rate limited to **60 requests a minute per client address** — far more
than a person tapping around an app, far less than anything worth doing with a
free tier. Keyed on the address rather than the token, so one abuser cannot
lock out an App Store reviewer by exhausting a shared budget.

A request bearing it is answered from `worker/src/demo.js` — two invented
hosts, three invented sessions, one of them waiting on a person. Verbs like
`start` and `stop` reply plausibly and change nothing.

**The safety property is structural.** The match happens in `worker.js` before
`env.FLEET` is touched, so there is no code path from a demo request to a
Durable Object, a host socket or a real session. Not "it checks first" — the
object is never fetched. It is also refused for `/host/connect`, so a host
presenting it is rejected like any other wrong token, and the Worker returns
500 if the demo and real tokens are ever set to the same value rather than
silently turning the whole coordinator into a toy.

Every reply carries `"demo": true`, so a support question is never ambiguous
about which fleet somebody was looking at.

Remove the var and none of this exists — the token stops being recognised
and every request falls through to the real token check.

## Point a host at it

In `/etc/agent-fleet-sidecar.env` on each box:

```
AGENT_FLEET_COORDINATOR_URL=https://fleet.thetech.network
AGENT_FLEET_TRANSPORT=websocket
AGENT_FLEET_HOST_KEY=/var/lib/agent-fleet/host-key.json
```

then `systemctl restart agent-fleet-sidecar`. It dials out, so there is nothing
to open on the host.

## The same code runs in both places

`src/fleet/coordinator/core.js`, `registry.js`, `scheduler.js`,
`protocol/intents.js` and `push.js` import **nothing** from `node:`. That is
enforced by the fact that the Worker build would break otherwise, and it is why
`bin/agent-fleet-coordinator` (plain Node, for testing the whole loop on one
box) and the Worker are not two implementations that drift.

`nodejs_compat` is deliberately not enabled — needing it would mean that
property had quietly stopped being true.

## Hibernation, and why the registry is a cache

A fleet host holds its socket open for weeks and says almost nothing. The DO
uses `acceptWebSocket`, so it is **evicted between messages** and rebuilt on the
next one — otherwise every idle socket would pin it in memory and bill for it.

Which means the host registry cannot be authoritative: it is rebuilt from what
hosts report after every eviction. That is the same rule §3 arrived at from a
completely different direction — *the coordinator's registry is a cache with
provenance, never the authority* — and the two agreeing is a good sign the rule
was right.

## One instance

`idFromName('fleet')`, so there is exactly one place that knows the fleet. That
is also the only way "resume is pinned to the box holding the volume" can be
enforced at all. A fleet is tens of hosts, not thousands; sharding would buy
headroom nobody needs at the cost of a consistency problem.

## What is not done

- **Telegram on the Worker.** §5 covers it: webhook mode with a `secret_token`,
  because validating a user id from the request body is authorization, not
  authentication.
