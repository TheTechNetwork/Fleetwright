# Pre-merge checklist: the fork-safe config split

**This one cannot be merged and then fixed.** `worker/wrangler.toml` stops
carrying our routes, our allowlist, our Sentry project, our GitHub App and our
invite sender. If CI deploys before the account is prepared, the coordinator
comes back **with no allowlist and no custom domain** — which is to say nobody
can sign in and the apps cannot reach it.

That outcome is deliberate and it is the point: an unprepared deploy of the
default config should produce a coordinator that admits nobody, rather than one
that admits whoever happened to be committed. What follows is how to be
prepared.

Do these **in order**, before merging
[#349](https://github.com/TheTechNetwork/Fleetwright/pull/349).

---

## 1. Set the two repository settings CI now reads

**Settings → Secrets and variables → Actions → Variables.**

| Name | Value | Why |
|---|---|---|
| `WRANGLER_CONFIG` | `wrangler.production.toml` | Which config the deploy job uses. **Absent means `wrangler.toml`**, the fork-safe one — so a fork running this workflow cannot deploy ours, and so *we* cannot deploy ours by forgetting |
| `AGENT_FLEET_AUTH_ALLOW` | `@thetech.network,elibrody2@gmail.com,reservedjyumi@gmail.com,e6591050@gmail.com` | Synced to Cloudflare as a **secret**. Copy it out of the current `wrangler.toml` before it is gone |

**Check `AGENT_FLEET_AUTH_ALLOW` first.** The sync step has been pushing it for
a while and it has never taken effect: the committed `[vars]` entry clobbered
the secret on every deploy, because Cloudflare keeps vars and secrets in one
namespace. So the variable may exist and be **stale or empty**, and nothing
would have told you. Open it and read it.

If it is empty when this merges, sign-in refuses everybody — including you.

## 2. Confirm the value actually landed

Before merging, from the `worker/` directory:

```sh
npx wrangler secret list
```

`AGENT_FLEET_AUTH_ALLOW` must be listed. `secret list` shows names and not
values, so this confirms it exists and not that it is right — which is why
step 1 says to read the variable.

## 3. Merge, and watch the deploy

Merge order is **[#345](https://github.com/TheTechNetwork/Fleetwright/pull/345)
first, without `--delete-branch`** — #349 is based on that branch and deleting
it closes #349. Then #349.

Watch the `Worker → deploy` job. Two lines to check:

- `npx wrangler deploy --config wrangler.production.toml` — if it says
  `wrangler.toml`, `WRANGLER_CONFIG` is not set and step 1 was missed. **Stop
  and set it**, because that deploy has just removed the custom domain.
- `synced AGENT_FLEET_AUTH_ALLOW`. If it appears under `::warning::Not set as
  repository secrets`, the variable is empty.

## 4. Verify the deployment is intact

```sh
curl -s https://fleet.thetech.network/healthz
```

Expect `{"ok":true,"protocol":3}`. A DNS failure or a Cloudflare error page
means the custom domain was dropped — see *If it breaks* below.

Then sign in on a phone, or:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://fleet.thetech.network/api/session \
  -H 'content-type: application/json' -d '{}'
```

**400 or 401 is the right answer** — it reached the sign-in path and refused a
malformed request. **503 means the issuers or audiences are missing.** A
successful sign-in from a phone is the only thing that proves the allowlist
survived; the curl cannot.

## 5. Check the things that moved

- `https://fleet.thetech.network/docs` → 302 to the demo Worker.
- `https://fleet.thetech.network/install` → 302 to
  `raw.githubusercontent.com/TheTechNetwork/…/bootstrap.sh`. **A 404 here means
  `AGENT_FLEET_INSTALL_URL` is missing**, and the one-liner in the README is
  dead.
- `https://fleet.thetech.network/openapi.json` → `servers[0].url` should be
  `https://fleet.thetech.network`. It is substituted at serve time now, so this
  also confirms the substitution works.
- A notification to a phone, if there is a session to produce one. Push is
  unchanged by this, but it is the thing whose failure is quietest.

---

## If it breaks

**No custom domain** — the most likely failure, and it means a deploy went out
with `wrangler.toml`. Set `WRANGLER_CONFIG` and re-run the workflow; the
production config declares the route with `custom_domain = true`, so wrangler
recreates the DNS record and the certificate itself. Expect a few minutes for
the certificate.

**Nobody can sign in** — the allowlist secret is empty or wrong. Fix the
repository variable and re-run, or set it directly:

```sh
cd worker && printf '%s' '@thetech.network,…' | npx wrangler secret put AGENT_FLEET_AUTH_ALLOW
```

**Everything answers 503** — `AGENT_FLEET_API_TOKEN` is missing, which is
unrelated to this change but is what a 503 always means.

**Full revert:** `git revert` the merge and re-run the Worker workflow. The old
config carried every value inline, so a revert restores the deployment without
touching Cloudflare. The repository variables set in step 1 are harmless to
leave behind.

---

## What this does not fix

The apps are still ours — bundle id, Firebase project, signing certificates,
store listings — so a fork's users install our builds and type their own
coordinator address. That works, and it is the best fork-parity property in the
project; rebuilding the apps is a different exercise.

And `docs/coordinator-deploy.md` has the full table of what a fork must change,
including the three things it genuinely cannot inherit: push to our apps, the
GitHub App callback, and Cloudflare Email Sending.
