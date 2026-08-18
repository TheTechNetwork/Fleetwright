# Names, and which of them are load-bearing

There are two names in this project, and the split is intentional.

| | Name | Why |
|---|---|---|
| Repository, iOS/Android app | **Fleetwright** | The App Store requires a display name unique across the entire store, and "Agent Fleet" was taken |
| Package, binaries, units, env vars, install path | **agent-fleet** | Already deployed. Renaming costs a reinstall and buys nothing |

## What did NOT change, and why

The rename stopped at the surface on purpose. These are the same as they were:

- `/opt/agent-fleet` — the install path, and the working directory of every
  systemd unit
- `agent-fleet-sidecar` and `agent-fleet-coordinator` — the binaries, and the
  service names that `systemctl` and `/logs` know
- `AGENT_FLEET_HOST_TOKEN`, `AGENT_FLEET_API_TOKEN`,
  `AGENT_FLEET_FCM_SERVICE_ACCOUNT` — set as GitHub Actions secrets, as
  Cloudflare Worker secrets, and in `/etc/agent-fleet/*.env` on each host
- `agent-fleet` — the npm package name
- `agent-hub` — the session manager beneath it, which has its own upstream
  lineage and is due to be contributed back

Every one of those exists in at least two places that a `git push` cannot
reach: a running host, a Cloudflare account, a repository secrets page. A
rename is not a rename there — it is a coordinated migration, where the cost of
getting it half-done is a coordinator that cannot authenticate its own hosts.

## What DID change

Only what a public listing or a URL forced:

- `github.com/TheTechNetwork/agent-fleet` -> `.../Fleetwright`. GitHub redirects
  the old URL, so an existing clone keeps working and `/update` keeps pulling —
  but a redirect only survives until somebody creates a new repository under the
  old name, which is why the clone URLs in `install/` and `docs/` were updated
  rather than left to it.
- The app: `dev.agentfleet.app` -> `network.thetech.fleetwright`, and the
  sources under `apps/`.

## If you want the deeper rename anyway

It is a real option, not a refusal. The order that avoids an outage:

1. Add the new env var names as accepted aliases, keeping the old ones working.
2. Deploy that everywhere — hosts, Worker, CI.
3. Move the secrets to the new names.
4. Only then drop the aliases, and rename the units and the install path in the
   same pass, since those two need the host reinstalled regardless.

Step 1 is the whole trick: nothing else can be safe until reading both names is
already deployed.
