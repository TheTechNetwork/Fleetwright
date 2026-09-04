# Deploying the coordinator to Cloudflare

§4's reasoning, which has not changed: you own no port, no VM, no cert and no
tunnel daemon. Hosts open an outbound WebSocket, a Durable Object pins it, and
the phone speaks HTTPS to the same origin. This is **not a tunnel** — nothing is
aimed at your boxes; they are ordinary clients.

Ours answers on **https://fleet.thetech.network**, configured as a custom
domain in `wrangler.production.toml` — the file that is ours and says so.
Yours answers on the **workers.dev** URL the deploy prints, until you add a
domain of your own to `worker/wrangler.toml` (a commented example is in the
file; `custom_domain = true` makes Cloudflare create and manage the DNS record
and the certificate, so there is nothing to point anywhere by hand).

Whichever hostname you end up on is load-bearing in one specific way: §5 has
each host PIN the coordinator origin it will talk to, so changing it means
editing every host's `/etc/agent-fleet-sidecar.env`. Pick one you intend to
keep — which is the argument for putting a domain on it before enrolling a
fleet, not after.

## Deploy

From nothing, with a free Cloudflare account and Node on any machine — this
does not have to be, and usually is not, a fleet box:

```sh
git clone https://github.com/TheTechNetwork/Fleetwright
cd Fleetwright/worker
npm install
npx wrangler deploy                                # opens a browser login the first time
npx wrangler secret put AGENT_FLEET_API_TOKEN      # openssl rand -hex 24
```

That deploys `worker/wrangler.toml`, which is **the fork-safe default on
purpose**: no routes, so it answers on the workers.dev URL the deploy prints;
an empty `[vars]`, so it admits nobody and reaches nothing of ours. What each
absence means, and what to set, is a comment in that file — the rest of this
page walks the ones that matter.

The Worker **refuses every request** until that secret is set, and the refusal
names the command. A coordinator with no credential is remote control of every
box in the fleet for anyone who finds the URL, and a Worker URL is not a
secret.

That token is **break-glass, not the everyday credential**. It can stop every
session and revoke every host. Phones sign in and are issued their own; hosts
never have it at all.

### The Deploy to Cloudflare button

The product page carries one. It clones this repository into your own GitHub
account and wires the copy to Workers Builds, so pushes to your copy deploy
your coordinator — which is a fine arrangement if you want one.

**Check the deploy command in the dialog: it must be `npm run deploy`.** The
Worker lives in `worker/` of a repository that also holds the host software,
and it imports fleet code from outside that directory — so Cloudflare's
automatic project configuration, which looks at the repository root, finds no
Wrangler config and would configure the wrong thing, and pointing the button
at the subdirectory would break the imports. The root `package.json`'s
`deploy` script exists precisely so the dialog has a correct command to
pre-fill: it installs the Worker's dependencies and deploys from `worker/`,
with the whole repository present.

Everything after the button is the same as the terminal path: the secret, the
sign-in values, and a host pointed at the URL.

### Sign-in

Three more values. Until they are set, sign-in answers 503 and says so, which
leaves the admin token as the only way in.

**Two are `[vars]`, not secrets.** `AGENT_FLEET_AUTH_ISSUERS` and
`AGENT_FLEET_AUTH_AUDIENCES` are public identifiers — who may vouch for a
person, and which app the ID token must be for. Copy these two lines into
`[vars]` in `worker/wrangler.toml` **verbatim** and run `npx wrangler deploy`;
they are ours, and using them is what lets people sign in to *your* coordinator
with the App Store and Play builds, with no Apple or Google setup of your own
(the fork section below explains why that works):

```toml
AGENT_FLEET_AUTH_ISSUERS = "https://accounts.google.com,https://appleid.apple.com"
AGENT_FLEET_AUTH_AUDIENCES = "network.thetech.fleetwright,654943059314-kosvngt4ggmdguksogppoiglo48nvm2i.apps.googleusercontent.com"
```

Vars rather than secrets, deliberately: they deploy with the code, so what a
coordinator will accept is **a reviewable diff**, not a value somebody typed
into a prompt at midnight and cannot later account for. This page used to say
`secret put` for all three, which was wrong twice over — it hid the values in
a place nobody reviews, and Cloudflare keeps vars and secrets in one
namespace, so a secret whose name is already a `[vars]` key collides at deploy
time.

**The third is a secret.** `AGENT_FLEET_AUTH_ALLOW` decides who is allowed in,
and a list of the addresses that can reach your fleet does not belong in a
repository — the fork-safe section below records how it briefly was one, and
what that cost:

```sh
npx wrangler secret put AGENT_FLEET_AUTH_ALLOW    # e.g. you@gmail.com,@your-domain.example
```

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
curl -sX POST https://your-coordinator/api/enroll \
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

`AGENT_FLEET_DOCS_URL` in `wrangler.production.toml` points `/docs` at the
demo Worker with a 302. **Unset means 404**, which is the right answer for a self-hosted
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
provider's public keys and then checks issuer, audience and allowlist. The
identifiers are public — the sign-in section above has them, and they are
committed in `wrangler.production.toml`. Copy
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
your coordinator posts a notification and we deliver it with our credentials.

It carries the real payload — a contentless wake was the first design and it is
useless, because the whole point is answering from a lock screen and a wake
cannot carry the options to answer with. So the promise is about **retention**:
nothing about a notification is written down, the device token is used and
dropped, and the only stored state is a rate-limit counter per fleet. That is
specified in [`relay-terms.md`](./relay-terms.md), written before the code
exists, because it is the kind of promise one log line breaks.

**The GitHub App callback is the third case, and it is only a convenience.**
`authorizeUrl()` sends `redirect_uri` explicitly and GitHub matches it against
the App's registered list — on purpose, so one deployment cannot send its users
to another's coordinator. Your origin is not on ours, so that flow refuses.
Register your own GitHub App (free) and set `AGENT_FLEET_GITHUB_CLIENT_ID` plus
the secret. Nothing else depends on it: `connect github` with a pasted token
and `connect cloudflare` need no callback and work on any coordinator anywhere.

### What a fork must change, and what happens if it does not

`wrangler.toml` in this repository used to be **our** deployment's config.
Deploying it unchanged was not neutral — these are the values that did
something:

| Setting | Unchanged, a fork gets |
|---|---|
| `AGENT_FLEET_AUTH_ALLOW` | **Four of our addresses admitted to their fleet.** `trust.md` has coordinator → host as *trusted absolutely*, so this is the one to change first |
| `routes` (`custom_domain`) | `wrangler deploy` tries to bind a domain they do not own, and fails |
| `SENTRY_DSN` | Their errors posted to **our** Sentry project |
| `AGENT_FLEET_INSTALL_URL` | Their `/install` hands a root shell a script that installs **our** code. Unset is a 404 that says so; this is why it is a variable rather than a constant |
| `AGENT_FLEET_DOCS_URL` | Their `/docs` redirects to our product page |
| `AGENT_FLEET_GITHUB_*` | The App flow reaches GitHub and is refused there, because their origin is not on our App's redirect list. Confidently broken, where absent would be honest — register your own App, it is free |
| `AGENT_FLEET_INVITE_FROM`, `[[send_email]]` | Invitations fail at send time; Cloudflare Email Sending needs a domain they control |
| `AGENT_FLEET_APP_IOS` / `_ANDROID` | Invitations point at **our** store listings |
| `AGENT_FLEET_PUSH` | Set, with no credentials — the coordinator now says so at startup rather than falling silent, but it cannot send |

**That list WAS the defect, and it is fixed rather than documented.** A
committed config one deploy away from admitting strangers to somebody's fleet is
the wrong default no matter how well it is described.

There are two files now, split by ownership:

| | |
|---|---|
| `worker/wrangler.toml` | **The fork-safe default.** No routes, an empty `[vars]`, and a comment naming every variable you might set with what happens if you do not. Deploying it unchanged gives a coordinator that admits nobody and reaches nobody — which is the right thing for a config that names no owner |
| `worker/wrangler.production.toml` | **Ours**, and it says so in its first line. Deployed by CI when the `WRANGLER_CONFIG` repository variable names it, which our repository sets and a fork does not |

Everything structural — the Durable Object, the migrations, the rate limits — is
identical in both and pinned equal by `test/fork-safe-config.test.js`, because a
fork needs those exactly as much as we do. Duplication is the cost; two copies
that must agree and are never compared is how one of them silently stops
matching, and for `[[migrations]]` that means a deploy that cannot find its
class.

**The allowlist is in neither.** It is a `wrangler secret`, synced by CI from a
repository variable. It decides who can reach a fleet and does not belong in a
public repository — and the secret block at the bottom of `wrangler.toml` has
listed it as a secret all along. The `[vars]` entry was the bug, and because
Cloudflare keeps vars and secrets in one namespace, every deploy was clobbering
the synced secret with the committed list.

Migrating our own deployment across this needs steps taken **before** the merge —
see [`merge-checklist.md`](./merge-checklist.md).

Two more, outside `wrangler.toml`:

- **The sandbox image.** `sandbox.yml` publishes to
  `ghcr.io/<your-org>/fleetwright-session`, and the hub used to pull ours
  regardless — so a fork's CI built an image nothing consumed while its boxes
  rebuilt locally every time. Set `AGENT_HUB_SANDBOX_IMAGE_OWNER` to your own
  org, or `AGENT_HUB_SANDBOX_IMAGE` to a full reference.
- **The apps.** Both are ours: bundle id, Firebase project, signing certificates
  and store listings. A fork's users install our builds and type their own
  coordinator address, which works and is the best fork-parity property here.
  Rebuilding them is a different exercise — a new bundle id breaks the committed
  `google-services.json`, and iOS device builds need an Apple team.

**There is no shared coordinator and there is not going to be one.**
[`trust.md`](./trust.md) has coordinator → host as *trusted absolutely*: a
coordinator can start a dangerous-mode session on any host in its fleet and
read the credential file out of it. That is a fine thing to hold over your own
machines and not something to hold over a stranger's.

## Point a host at it

In `/etc/agent-fleet-sidecar.env` on each box:

```
AGENT_FLEET_COORDINATOR_URL=https://your-coordinator    # the workers.dev URL, or your domain
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
