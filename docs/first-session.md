# Fresh box to first session

Ten steps. No reasoning — the reasoning is in the essays linked at the bottom,
and this page exists because a beta tester could not find the current truth
about "what must I do after install so the fleet will schedule work" in any
single place, and their first run ended there.

If a step here stops being true, this page is the bug.

## On the box

```sh
curl -fsSL https://fleet.thetech.network/install | sudo sh -s -- --check   # changes nothing; prints what it would do
curl -fsSL https://fleet.thetech.network/prereq  | sudo sh                # only if --check said node is too old
curl -fsSL https://fleet.thetech.network/install | sudo sh                # installs tmux, podman, the CLI, the services
```

The URL is the fleet the box will join; yours goes in its place if you run
your own coordinator. The one-liner fetches the current release, checks it
against its manifest, and runs the installer inside it, so a fresh box needs no
git and is packaged from its first minute. From a checkout instead, for a box
you mean to edit:

```sh
git clone https://github.com/TheTechNetwork/Fleetwright && cd Fleetwright
sudo bash install/install.sh --check
sudo bash install/install.sh
```

**Use `bash`, not `sh`, for the installer run by hand.** It says so if you get
it wrong. The prerequisite line is separate on purpose — node is the one thing
the installer refuses to install for you, and it refuses *before* changing
anything, naming this command.

## Join it to a coordinator

Skip if this box *is* the coordinator — the installer asks whether to run one
here, sets it up on a `Y`, and prints where it listens. That is the whole
single-box setup.

No coordinator anywhere yet, and you want one a phone on mobile data can
reach? Deploy it to your own Cloudflare account first —
[coordinator-deploy.md](./coordinator-deploy.md) is five commands — and give
the installer that URL when it asks.

```sh
# On the coordinator, with the admin token:
curl -sX POST https://your-coordinator/api/enroll \
  -H "authorization: Bearer $AGENT_FLEET_API_TOKEN" \
  -H 'content-type: application/json' -d '{"kind":"host"}'

# Back on the box, as the service user:
sudo -u agent-hub agent-fleet-sidecar enrol <pin>
```

The pin is single-use and short-lived. Mint it when the box is ready for it.

## Link a Claude account — **this is the step people miss**

A machine has no Claude account of its own. A session runs on the account of
whoever starts it, so **until somebody links one, the coordinator will refuse
to place any work here** and say so.

```sh
agent-hub login for you@example.com     # opens a device flow; paste the code back
agent-hub accounts                      # should now list you
```

The app and Telegram do the same thing. Any one of the three is enough.

## Check it

```sh
agent-hub doctor        # every line should say ok
agent-hub new hello     # start a session on this box
agent-hub list          # it should be running
```

From the fleet, through a coordinator:

```sh
curl -sX POST https://your-coordinator/api/intent \
  -H "authorization: Bearer $AGENT_FLEET_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"verb":"list","params":{}}'
```

## If it refuses

Every refusal here names its reason. The three you are most likely to meet:

| It says | It means |
|---|---|
| `nobody has linked a Claude account on this host` | You skipped the linking step above. The message names all three ways to do it. |
| `No host has ever connected to this coordinator` | The sidecar has not enrolled, or cannot reach the coordinator. Check `journalctl -u agent-fleet-sidecar`. |
| `<host> does not know that command — it is running older code` | The box is behind the coordinator. `agent-hub update --restart` on that box. |

## Running the tests, if you are working on it

```sh
npm install
npm install --prefix worker    # the tests import the Worker; skipping this fails four files
npm test
```

## The essays

- [deployment.md](./deployment.md) — what the installer does and why
- [accounts.md](./accounts.md) — why a machine has no account of its own
- [intents.md](./intents.md) — the verb set, and why it is fixed
- [mcp.md](./mcp.md) — driving the fleet from Claude
