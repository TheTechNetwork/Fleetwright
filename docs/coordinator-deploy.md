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

## A demo fleet, on its own Worker

**`fleetdemo.thetech.network`**, a separate script:

```
cd worker && npx wrangler deploy --config wrangler.demo.toml
```

It serves two things — the invented fleet in `worker/src/demo.js`, and the
product page at `/docs`. Nothing else.

**It used to be the same Worker on a second domain**, and the argument for that
was real: `worker.js` matched `AGENT_FLEET_DEMO_HOST` above the host routes, so
a request there never reached enrolment, a websocket, sign-in, or the Durable
Object. It was tested, and the test asserted the *position* of the check.

That is the problem with it. It was an argument about the **order of branches**
inside a bundle that also holds the Durable Object binding, the GitHub App
client secret and the APNs key — and order is a property of code that gets
edited. The coordinator is the thing holding the fleet; it should not also be
the unauthenticated, cacheable surface a stranger loads HTML from.

Now there is no argument to make. `wrangler.demo.toml` has **no
`durable_objects` binding, no `send_email`, no KV and no secrets**, and
`demo-worker.js` imports exactly two files. A bug in it cannot reach a session
because nothing that could is in scope. The config is short enough to read in
one sitting, and reading it is the whole audit.

Two smaller things fell out of it:

- **The demo token now authorises nothing.** It is not checked, because on a
  Worker with no fleet there is nothing to separate a curious person from —
  and a check that can only ever pass is a check nobody maintains. Both apps
  still send it, because a client with no credential is not signed in.
- **The release cadences are separate.** The page describing the product
  changes when the words are wrong; the coordinator changes when the fleet
  does. Shipping the second to fix the first means a deploy that evicts every
  live Durable Object, for a typo.

### `/docs` on the coordinator is a redirect

`AGENT_FLEET_DOCS_URL` in `wrangler.toml` points `/docs` at the demo Worker
with a 302. **Unset means 404**, which is the right answer for a self-hosted
fleet: somebody else's private coordinator on their own domain has no product
page to point at. Ours is set; every fork gets nothing.

302 rather than 301 — a permanent redirect is cached by browsers in a way that
outlives the deploy that set it, and this value is one line of configuration
away from changing.

Both apps have a **"Look around the demo fleet"** button that points at it.
There is no longer a paste-a-credential field in either app: asking somebody to
find a token in this document and paste it into a field labelled "credential"
is a fair description of no demo at all. The constants are pinned to this file
by `test/demo-button.test.js`, so changing the host or the token without
shipping both apps fails CI rather than silently leaving installed builds
pointed at a domain that answers nothing.

Getting back in when sign-in itself is broken is now curl with
`AGENT_FLEET_API_TOKEN`, not a field on every user's settings screen.

## The demo token, which no longer authorises anything

App Store review needs credentials that work, and no reviewer's address is on
anybody's allowlist — so signing in cannot be the answer, and
`AGENT_FLEET_API_TOKEN` can stop every session in the fleet. That is why a
third token exists, in `wrangler.demo.toml`, committed rather than kept secret:

```toml
AGENT_FLEET_DEMO_TOKEN = "demo-3a2ec7773eabcd4e38a9a880296a4e4b"
```

**`demo-worker.js` does not check it.** When the demo lived in the coordinator,
this string was what separated a curious person from the real routes. On a
Worker with no fleet binding there is nothing to separate — and a check that
can only ever pass is a check nobody maintains, and the maintenance is where
the bug would be. Both apps keep sending it: a client with no credential is not
signed in, and a string obviously prefixed `demo-` is worth more in a log than
in a comparison.

The demo Worker is rate limited to **60 requests a minute per client address** —
far more than a person tapping around an app, far less than anything worth
doing with a free tier. Keyed on the address rather than the credential, so one
abuser cannot lock out an App Store reviewer by exhausting a shared budget.

Everything it answers comes from `worker/src/demo.js` — two invented hosts,
three invented sessions, one of them waiting on a person. Verbs like `start`
and `stop` reply plausibly and change nothing. Every reply carries
`"demo": true`, so a support question is never ambiguous about which fleet
somebody was looking at.

Presented to the real coordinator it is now an **ordinary bad credential**,
which is the answer it should always have had once the demo had a Worker of its
own.

## What a fork needs, and what it does not

Two questions everybody asks, and one of the answers is the opposite of what
people assume.

**Sign-in needs nothing of yours.** The apps mint ID tokens against our Google
and Apple client IDs; a coordinator only verifies the signature against the
provider's public keys and then checks issuer, audience and allowlist. All
three are public identifiers, already committed in `wrangler.toml`. Copy
`AGENT_FLEET_AUTH_ISSUERS` and `AGENT_FLEET_AUTH_AUDIENCES`, set your own
`AGENT_FLEET_AUTH_ALLOW`, and people sign in to your fleet with the App Store
and Play builds. **No Firebase project. No Apple Developer account.**

**Push cannot be self-hosted, and that is structural.** A device token is
issued for a *specific app*. `src/fleet/push.js` sends to
`apns-topic: network.thetech.fleetwright` with an APNs key from our Apple team,
and to FCM with a service account for our Firebase project. Your coordinator
has neither, so it cannot wake our app on anybody's phone. Unset those secrets
and push is logged instead of sent, and says so — the apps still work by
pulling.

The alternative is building your own apps: your own bundle id, Firebase
project, Apple team and store listings. That is a real cost and it is
out of proportion to changing one hostname, which is why a **push relay** is on
the roadmap ([#348](https://github.com/TheTechNetwork/Fleetwright/issues/348)):
your coordinator posts "wake this device", we forward it, and the relay never
sees what the notification is about.

**The GitHub App callback is the third case, and it is only a convenience.**
`authorizeUrl()` sends `redirect_uri` explicitly and GitHub matches it against
the App's registered list — on purpose, so one deployment cannot send its users
to another's coordinator. Your origin is not on ours, so that flow refuses.
Register your own GitHub App (free) and set `AGENT_FLEET_GITHUB_CLIENT_ID` plus
the secret. Nothing else depends on it: `connect github` with a pasted token
and `connect cloudflare` need no callback and work on any coordinator anywhere.

**There is no shared coordinator and there is not going to be one.**
[`trust.md`](./trust.md) has coordinator → host as *trusted absolutely*: a
coordinator can start a dangerous-mode session on any host in its fleet and
read the credential file out of it. That is a fine thing to hold over your own
machines and not something to hold over a stranger's.

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
