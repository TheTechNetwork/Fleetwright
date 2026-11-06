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
it wrong. The prerequisite line is separate on purpose: the installer installs
the distribution's own node when there is none, but a node that is there and
too old is one it will not replace for you — adding a third-party repository
is not a thing an installer does on your behalf — and it refuses *before*
changing anything, naming the prerequisite script at the coordinator you gave
it.

## Join it to a coordinator

The coordinator is a Cloudflare Worker, and a box is never one. No coordinator
yet? Deploy it to your own Cloudflare account first —
[coordinator-deploy.md](./coordinator-deploy.md) is five commands on a free
account — and give the installer that URL when it asks (or curl the
coordinator's own `/install`, which carries it).

Then a pin. From the app — Machines › Add a machine — which shows, beside the
six digits, the one line that installs a fresh box and joins it:

```sh
curl -fsSL https://your-coordinator/install | sudo FLEETWRIGHT_ENROL_PIN=123456 sh
```

A box already installed takes the pin by hand, as the sidecar's account:

```sh
sudo -u fleetwright-sidecar fleetwright-sidecar enrol <pin>
```

No phone signed in yet? The break-glass admin token mints one over curl — see
the Hosts section of [coordinator-deploy.md](./coordinator-deploy.md).

The pin is single-use and lasts ten minutes. Mint it when the box is ready for
it; one that ran out is replaced from the same screen.

**Joined is not ready.** The installer stops at "enrolled", and that is the
box's half: until the next step is done the coordinator knows the machine and
will still place no work on it, and both the machine's page in the app and
`fleetwright-sidecar doctor` say so.

## Keep your Claude login, and approve this machine — **this is the step people miss**

A machine has no Claude account of its own. A session runs on the account of
whoever starts it, and that account comes from their vault and nowhere else
([vault.md](./vault.md)), so **until somebody's vault gives this machine their
Claude login, the coordinator will refuse to place any work here** and say so.

In the app, under You › Credentials, keep your Claude login: *Make it on
<machine>* signs you in on one of your machines, the kind of login Remote
Control needs, and the phone keeps it. Then approve this machine from its page
under Machines, comparing the fingerprint with what
`fleetwright-sidecar identity` prints here.

`fleetwright login for <email>` still links an account on the box, for the
box's own command line; sessions somebody starts through the fleet do not use
it.

## Check it

```sh
fleetwright doctor                # the box can run itself: every line should say ok
sudo -u fleetwright-sidecar fleetwright-sidecar doctor   # the fleet can use it: every line should say ok
fleetwright new hello             # start a session on this box
fleetwright list                  # it should be running
```

The sidecar's doctor is the one that answers the question above: its line
"a Claude login for sessions" is ok once somebody's vault has approved this
machine, and FAIL — naming the step — until then. The box's own Claude login
is printed as a note and never judged; it is normal for a box to have none.

From the fleet, through a coordinator:

```sh
curl -sX POST https://your-coordinator/api/intent \
  -H "authorization: Bearer $FLEETWRIGHT_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"verb":"list","params":{}}'
```

## If it refuses

Every refusal here names its reason. The three you are most likely to meet:

| It says | It means |
|---|---|
| `nobody’s vault gives this host a Claude login` | You skipped the step above. Keep your Claude login under You › Credentials, then approve this machine from its page. |
| `No host has ever connected to this coordinator` | The sidecar has not enrolled, or cannot reach the coordinator. Check `journalctl -u fleetwright-sidecar`. |
| `<host> does not know that command — it is running older code` | The box is behind the coordinator. `fleetwright update --restart` on that box. |

## Running the tests, if you are working on it

```sh
npm install
npm install --prefix worker    # the tests import the Worker; skipping this fails four files
npm test                       # the Node suite
./scripts/verify.sh            # the rest of CI: coverage, typecheck, the Worker bundles, the contract
```

## The essays

- [deployment.md](./deployment.md) — what the installer does and why
- [accounts.md](./accounts.md) — why a machine has no account of its own
- [intents.md](./intents.md) — the verb set, and why it is fixed
- [mcp.md](./mcp.md) — driving the fleet from Claude
