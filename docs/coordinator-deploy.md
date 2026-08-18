# Deploying the coordinator to Cloudflare

§4's reasoning, which has not changed: you own no port, no VM, no cert and no
tunnel daemon. Hosts open an outbound WebSocket, a Durable Object pins it, and
the phone speaks HTTPS to the same origin. This is **not a tunnel** — nothing is
aimed at your boxes; they are ordinary clients.

## Deploy

```sh
cd worker
npx wrangler secret put AGENT_FLEET_HOST_TOKEN     # openssl rand -hex 24
npx wrangler secret put AGENT_FLEET_API_TOKEN      # openssl rand -hex 24
npx wrangler deploy
```

The Worker **refuses every request** until both are set, with a message saying
which. A coordinator with no credentials is remote control of every box in the
fleet for anyone who finds the URL, and a Worker URL is not a secret.

Optionally, for push:

```sh
npx wrangler secret put AGENT_FLEET_FCM_SERVICE_ACCOUNT
```

## Point a host at it

In `/etc/agent-fleet-sidecar.env` on each box:

```
AGENT_FLEET_COORDINATOR_URL=https://agent-fleet-coordinator.<subdomain>.workers.dev
AGENT_FLEET_TRANSPORT=websocket
AGENT_FLEET_HOST_TOKEN=<the same AGENT_FLEET_HOST_TOKEN>
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

- **Enrollment.** One shared host token today. §5 wants a short-lived JWT signed
  per connection so the durable secret never crosses the wire, and a per-host
  key so revoking one host does not mean rotating all of them.
- **Telegram on the Worker.** §5 covers it: webhook mode with a `secret_token`,
  because validating a user id from the request body is authorization, not
  authentication.
