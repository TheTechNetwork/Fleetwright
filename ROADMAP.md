# Roadmap

Every feature asked for, in one place, with an honest status. The detailed
designs live in `docs/`; this is the index that stops them getting lost.

Statuses: **done** (merged to main) · **partial** (some of it shipped, the rest
named) · **designed** (written down, not built) · **wanted** (asked for, not
yet designed).

---

## Beta findings, round one

Two outside testers, told nothing about the design and asked not to be
reasonable about effort. **[beta-findings.md](docs/beta-findings.md) is the
list** — 18 items with owners, severity and evidence, plus the order I would
take them in.

The one sentence to carry:

> "I got my output by ignoring what the screens said and interrogating a
> verification tool."

Four of them are mine, from this round's own MCP work, and three of those are
wrong *text* rather than wrong behaviour — which is the kind a test suite does
not catch. The worst is a **false "NOT LOGGED IN" banner** that tells a
returning user their one recovery path is closed while the credential is
perfectly valid.

The theme across the rest: nearly every missing fact **already exists in the
system** and is absent from the screen where the decision gets made. Session
dates, who started one, the credential countdown — all present somewhere, none
of them where somebody is choosing.

**Round two — the first-run tester — found something neither of us predicted
and it outranked the lot: `install.sh` was dead on `main`.** A fresh box exited
1 after five header lines, before any prerequisite check, with no message. A
trailing `[ -f … ] && …` was the last command in `previous_install()`, so on a
box that had never had this installed the function returned 1 and
`set -euo pipefail` killed the script. Verified from a clean `git archive`,
not taken on trust — and **fixed**: the function now ends with an explicit
`return 0` and a comment naming this finding.

Both rounds independently hit the **same false "NOT LOGGED IN"**, which makes
it an unfinished one-account-per-person migration rather than a wrong string:
`fleet_status`, `fleet_health`, `agent-hub accounts` and `doctor` all still
describe the healthy state as fatal, while `fleet_verify` has the correct
sentence.

And the two the first-run tester ranked daily, both arguing "I understand why,
and I still want it": **task-at-start** (a `brief` that is stored and never
delivered, so the documented MCP loop ends at an idle REPL) and **a done /
needs-me / idle state** that does not have to be divined. They found our own
compromise for the first on our own roadmap — §6's host-side prompt profiles —
and that is what shipped, as **protocol v3**: `start { profile }` names a file
on the host and its content becomes the session's first message. See
[`docs/task-at-start.md`](docs/task-at-start.md).

Their disagreement with the order below, kept because it is the sharpest thing
either report said:

> "All defensible, but they extend reach while the core loop still dead-ends at
> an idle REPL."

Every finding is filed as an issue and tagged `beta`.

## 1. Identity, trust, and accounts

| feature | status | where |
|---|---|---|
| Hosts and phones each have their own identity; per-device credentials; pins; OIDC sign-in | **done** | `docs/identity.md`, #104 |
| Admin follows the verified person, not a credential row | **done** | #139 |
| Sign in with Apple server-to-server revocation notifications | **done** | `docs/identity.md` |
| Session attribution — every record says who asked | **done** | `docs/accounts.md`, #132 |
| **Per-user Claude accounts**: shared org account at the coordinator, members link their own; admin sees all sessions, members see theirs | **done** | `docs/accounts.md`. Visibility, ownership, `/login for <email>` linking (isolated, never touches the box login), per-person seeding with the account identity, `/accounts` list/unlink. The invite-a-client flow is real end to end |
| Invite flow: admin lets a friend/client use the fleet on their own Claude account | **done** | `invites.js`, `invite-email.js`, the People screen on both phones. The email grants nothing — it names WHICH ADDRESS to sign in with, which is the failure it actually prevents — and carries both store links, labelled per phone |
| Google RISC / Cross-Account Protection receiver | wanted | needs Google console setup first |

## 2. Secrets, and what a session may touch

| feature | status | where |
|---|---|---|
| Credential-terminating proxy: sessions hold creds issued by us, proxy substitutes real ones on egress; default-deny egress | **designed** | `docs/trust.md` — the build order is written there (proxy + netns + substitution table first) |
| 1Password as custody for the proxy's real credentials | **designed** | `docs/trust.md` — explicitly not a vault-MCP in sessions |
| Cloudflare Secrets Store as an alternative custody backend | **designed** | `docs/trust.md` — asked directly, and the answer is where rather than whether: behind the BROKER, never read at session startup. A vault the coordinator can read makes the coordinator the highest-value target in the system, which is the trade the fixed verb set exists to refuse |
| Device-authorization flow for Claude | **considered and rejected** | `docs/connectors.md`. Device-code phishing is an active attack class: the attacker starts the flow, the victim approves a genuine page showing a genuine code, and every signal anybody is taught to check passes. RFC 8628 exists for devices that cannot show a browser; ours is a phone. A pasted token binds consent to an action the person started, which beats a shorter lifetime |
| **GitHub App instead of a pasted PAT** — no copy, no paste, per-repo scope, real revocation | **designed** | `docs/connectors.md`. It DELETES the paste flow rather than improving it: pick repositories, Install, done — the person never sees a credential, GitHub prompts for permission changes itself, and uninstalling is a revocation we are told about. The catch is the same as everywhere else: an App's private key mints for EVERY installation, so replicating it per host would be worse than today's per-person tokens. Before the broker exists, user-to-server OAuth is the shape that works — an 8-hour access token with a per-person refresh token stored where the PAT is now. **Correction:** Cloudflare DOES publish OAuth clients — Authorization Code, scopes that map to API token permission names, and no device flow. Private clients work for the operator immediately; a guest using their own Cloudflare account needs a public client, which requires domain verification and is IRREVERSIBLE. So the same flow serves both providers, and Cloudflare is a "not yet" rather than a "never" |
| **A credential socket, serving the token we already have** — no `GH_TOKEN` in the environment | **done** | `docs/credential-broker.md`. A route on the per-session hook socket, so the socket is still the only thing that says which session is asking. `git` uses a credential helper, `gh`/`wrangler` a PATH shim, anything else `fleet-cred`. The immediate win is the one that was predicted: a rotated token reaches a RUNNING session, because the file is read at the moment of the request |
| **Repository scoping** | **already in force, and free** | A user-to-server token cannot exceed the installation, so a person who installed on *Only select repositories* already has per-repo scope. Checking that setting is worth more than anything below it and costs no code |
| **A push relay for other people's coordinators** — they post a notification, we deliver it with our APNs key and FCM service account | **wanted** ([#348](https://github.com/TheTechNetwork/Fleetwright/issues/348)) | The one thing that CANNOT be self-hosted. A device token is issued for a specific app, so `push.js` sends to `apns-topic: network.thetech.fleetwright` with a key from our Apple team — somebody else's coordinator cannot wake our app on their phone, and their only alternative is shipping their own apps to change one hostname. **IT CARRIES THE REAL PAYLOAD.** A contentless wake was the first design and it was rejected: *"contentless and non-actionable notifications are useless"*, which `psychology.md` already implies — the whole point is deciding from a lock screen, and `answer` exists so a waiting prompt is answered FROM the notification with the options the host published. A wake cannot carry options, so a wake cannot be answered. **So the promise is retention, not visibility:** nothing about any notification is written down — no bodies, no payload in error reports, no delivery history, and the device token is used and dropped. The only state is a rate-limit counter per fleet. Written out as a specification in [`docs/relay-terms.md`](docs/relay-terms.md) BEFORE the code exists, because these are promises broken by adding one log line. The structural version — payload encrypted to the device, relay forwards ciphertext — is named there too, so "we do not log it" is understood as the weaker guarantee |
| **An OAuth callback relay** — one registered `redirect_uri`, forwarded to whichever coordinator the `state` names | **wanted** ([#348](https://github.com/TheTechNetwork/Fleetwright/issues/348)) | `authorizeUrl()` sends `redirect_uri` explicitly and GitHub matches it against the App's registered list — deliberately, so one deployment cannot send its users to another's coordinator. A self-hoster's origin is not on our list. They can register their own GitHub App, so this is convenience rather than a wall. **The hard part is the token, not the redirect:** exchanging the code needs our client secret. Forwarding the token in the clear makes us custodian of strangers' GitHub tokens, which is what "no shared coordinator" decided against; handing out the secret means it is not a secret. The only version that keeps the promise forwards it ENCRYPTED to a key the coordinator registered. Build that or do not build it — the easy version is what gets written by accident. Terms in [`docs/relay-terms.md`](docs/relay-terms.md) |
| ~~A shared coordinator we run for other people~~ | **decided against** | *"No shared coordinator — a shared callback endpoint and push for use by other coordinators."* `trust.md` says coordinator → host is trusted absolutely: a coordinator can start a dangerous-mode session on any host in its fleet and read the credential file out of it. Running one for strangers means holding that over their machines, and the proxy that would bound it is designed and not built. The two relays above have none of that authority — one wakes a phone, one hands over a sealed envelope |
| **Cloudflare OAuth app instead of a pasted API token** — Authorization Code + PKCE, scopes chosen on Cloudflare's own consent screen | **wanted** ([#347](https://github.com/TheTechNetwork/Fleetwright/issues/347)) | The Cloudflare half of the row above, pulled out because it is a different decision with a different blocker. Today `connect cloudflare` deep-links the dashboard with a custom-token template pre-filled and the person pastes the result back — which works, and still means a long-lived token with no expiry sitting in an `.env`. OAuth would make it revocable from Cloudflare's side, scoped by their consent screen rather than by our query string, and refreshable. **The blocker is not the flow, it is the client.** A PRIVATE client works for the operator immediately and needs nothing from anybody. A PUBLIC client — which is what a guest bringing their own Cloudflare account needs, since there is no shared secret to give them — requires domain verification and is IRREVERSIBLE once done. There is also **no device flow**, so a box with no browser cannot complete it and the `connect`/`link` pane trick does not transfer. **What it does not change:** the token still lands on the host as a real credential. This is a better way to MINT one, not the credential-terminating proxy in `docs/trust.md`, and it must not be allowed to look like progress on that |
| **`gh` in every session via a GitHub App** — installation tokens, PATH shim | **designed, and promoted** | `docs/trust.md`. Not an improvement on pasting a PAT: a replacement for it. Installation tokens expire in ONE HOUR, are scoped to chosen repositories, and are minted per session — and GitHub's minting authority is WEAKER than an account credential, which is the property Cloudflare's equivalent does not have. Wants the broker first: a one-hour token is a liability in an environment variable and unremarkable behind a socket |
| **Connect GitHub / Cloudflare / Claude from the app** — provider's own page, scopes pre-filled, token verified before storing | **done** | `docs/connectors.md`. Deliberately NOT the proxy and does not delay it: the token is a real token on the box, minted and revocable by the person. What it buys is that a guest never holds anybody else's credential and never needs a shell. A provider is a row in `src/core/connectors.js` — adding one costs no verb, no version and no app release |
| A member gets their OWN tokens or none — no shared fallback for GitHub/Cloudflare | **done** | `docs/connectors.md`. Different from the Claude rule on purpose: a shared org plan is a licence somebody chose to share; a GitHub token is one person's access to their own repositories |
| The authorization code stops appearing in the journal | **done** | `src/core/redact.js`. It had been logged by three surfaces since login shipped — `login.js` was careful and three files above it were not. Matters more since `logs` made a journal readable from a phone |
| SigV4 re-signing for AWS | designed, deferred until something needs AWS | `docs/trust.md` |

## 3. The apps (iOS / Android)

| feature | status | where |
|---|---|---|
| Sign in, hosts list, pins, revocation, sessions, push | **done** | shipped |
| Session naming: brief-first start sheet, on-device title suggestion, title/brief on the wire | **done** (iOS suggestion via Apple Intelligence; Android deterministic — Gemini Nano slot-in deferred until one Play build proves the base) | `docs/naming.md`, #123–#125 |
| Siri/Assistant session kinds — "start a dev session", user-defined words | **done** | #125. Android one-tap; iOS via alternative app names ("my fleet", "my agents", "remote sessions") + in-app "Say it your way" flow |
| Start-and-open as a spoken variant (auto-open cannot be a setting — compiler-enforced) | **done** | `docs/naming.md` |
| **Choose which host a session lands on** | **done** | #142/#143 — a preference beside the intent, refused by name; kinds can carry a host |
| **Forget session from the app** | **done** | #143, confirmed because it deletes the conversation and workspace |
| **Surface refusals** | **done** | #143 — the `_ = try?` that swallowed the 403 |
| Show workspace dir, session age, and the account each session runs on | **done** | additive fields on health — no protocol bump; an old client ignores them |
| Sign-in status per host in the app: signed in as, plan, org, or NOT signed in | **done** | the first half of "sign-in status and logs on the app"; logs need the v2 `logs` verb |
| Host version info: what it runs, how far behind, reboot required | **done** | the Fleet section in settings, both apps |
| Context-window usage per session | wanted | the one fact of this group the host does not yet know — it lives in the transcript, not in any status the CLI exposes |
| Answer a waiting prompt from the app | **done** | both apps render the host's options as buttons and send an ordinal with the `promptId` |
| Read logs, update / upgrade / reboot a box from the app | **done** | both apps; reboot keeps the pin-plus-typed-hostname guard |
| Session detail screen; notification actions | **partial** | answering works in-app; the notification *action* (answer without opening the app) is still to build |
| Forget moves to a 7-day recycle bin, restorable | **done** | `/forget` bins, `/restore` brings it back, `/purge` is the old behaviour kept as its own word. The volumes stay, which is the feature and the cost — swept from every path that touches the bin and hourly besides. `AGENT_HUB_BIN_DAYS=0` restores the old behaviour for a box tight on disk |
| TG settings setup / removal from the app | wanted | config, not protocol |
| Filesystem: browse / copy / edit / delete in the workspace | **done** on coordinator, Worker, host and MCP; apps next | `docs/filesystem.md` is the design pass it was waiting for. A workspace is a podman volume, not a host directory, so every operation runs a container over that ONE volume — never the sibling holding the Claude credential. Three redundant bounds on the path (JS, then `realpath` inside the container which is what catches a symlink, then a `:ro` mount), no network, content on stdin so it is never parsed as shell. Five verbs rather than one with an `op`, so `mutating` can be true of the destructive three and the MCP server can withhold them by default. Re-run the IARC questionnaire before the next submission |

## 4. Voice and the hub surfaces

The app, Siri/Assistant, and the CLI are the hub for most users. Telegram stays
as an option and no longer sets the ceiling. (`docs/app-parity.md`)

| feature | status | where |
|---|---|---|
| Speakable replies, ordinal answers, parameters nameable out loud | **partial** | `answer` ships and takes an ordinal, which is the speakable form; the spoken *phrase* for it is not wired to Siri/Assistant yet |
| **Coordinator-level Telegram bot** — one bot for the whole fleet, `/list` spans hosts | wanted | today's bot is per-box by Telegram's one-poller rule; per-box bot keeps `/enroll` |
| Browser control surface / PWA | wanted | after the app surfaces stabilise; console groundwork exists (`docs/console-design.md`) |
| **An MCP server, so the Claude app can drive the fleet** | **done** | `docs/mcp.md`. It was what the roadmap predicted: a thin adapter over `/api/intent`, with the tools GENERATED from the verb registry so the two lists cannot diverge. Holds one device credential and has exactly that person's visibility. `answer` and the destructive verbs are withheld by default — a policy about what an agent reaches for unasked, not a lock. What is still missing is a completion signal: a finished session looks exactly like an idle one, which is an annoyance on a permanent host and the whole problem on a runner |

## 5. Protocol v2-era verbs

**They do NOT have to ship together, and that correction is worth more than the verbs.** An older host answers an unknown verb with `unknown_verb` — a named refusal that strands nothing. It is adding a PARAMETER to an existing verb that forces a bump, because `bad_params` arrives *after* the version check has already agreed. So verbs ship one at a time; only parameter changes are a flag day. (`docs/plan.md` §4–5, `docs/intents.md`)

- `answer` — **done**. Ordinal into a host-published list, `promptId` closing the temporal hole
- `logs` — **done**. Service journals by enum, plus a session's own output (container stderr, which outlives the pane)
- `status` — **done**. One session in detail, or the fleet
- `update`, `upgrade`, `reboot` — **done**. Each takes a host, which is what makes the app a strict superset of per-box Telegram rather than a copy of it
- `login` / `code` — **done**, and not as `login`/`code`. It shipped as `connect`/`link`/`unlink`, three generic verbs over a table of providers, because the ask was never only Claude: *"Cloudflare api can be generated via a custom url so created in app, same with GitHub, same with many others."* Adding a provider is now a row in `src/core/connectors.js` — no verb, no version, no App Store or Play release, since both apps render their picker from the catalogue the HOST publishes. See `docs/connectors.md`

**Shipped 2026-08-28**, all five on coordinator, Worker, host, iOS and Android in one stacked round. `PROTOCOL_VERSION` was `2` at that point; it is `3` today (§6's task-at-start bump). The note above is still the rule going forward: verbs are cheap, parameters are the flag day.

## 6. Hosts and the dev-environment goal

A Windows box, a Linux box and a Mac in one fleet — a session can build and run
anything. (`docs/wanted.md` has the full table.)

| feature | status | where |
|---|---|---|
| Linux host | **done** | everything today |
| macOS host: installer runs, launchd daemons, Homebrew, clone detection | **partial** | works to the wizard; unsandboxed sessions; StateDirectory/RuntimeDirectory equivalents still to do; not yet proven on real hardware end-to-end |
| Windows host = WSL2 | wanted | a Linux host that lives on a Windows machine |
| Xcode on a Mac host (simulator, signing, `xcodebuild`) | wanted | the reason Mac hosts matter; no Linux sandbox for it exists legally |
| **Ephemeral hosts on GitHub Actions runners** — a temporary session on a free macOS or Windows runner | **done for macOS and Linux; Android written; Windows written and UNPROVEN** — `install/runner-central/`, [`docs/runner-central.md`](./docs/runner-central.md) | A runner IS an ephemeral host: the installer already runs on macOS (#119/#120), a runner has a public network path out, and the sidecar dials OUT so it needs no inbound route. It enrols with a pin, works, and is gone when the job ends. **What has to be true:** a pin minted per job (they are already short-lived, single-use and host-bound — the design fits without changes); the host id must be unique per run or two jobs collide on one identity, which is the clone bug in a new costume; the session must be `forget`-able by the coordinator when the runner vanishes, because a host that never disconnects cleanly is a host the registry keeps offering. **What it does not solve:** a runner is limited (6h, no persistence, Apple's licence still governs what may run), so it is right for a build or a test and wrong for the long-lived session this product is otherwise about. **What makes it appealing anyway:** free macOS and Windows, no hardware, and a clean answer to "can this session build an iOS app" that does not require buying a Mac. Pairs with the MCP item above — Claude asking for a temporary Windows box is exactly the case that makes both worth having |
| **A repository that is an ephemeral runner central, dispatched by the fleet** | **done** | [`docs/runner-central.md`](./docs/runner-central.md). The gap `ephemeral-hosts.md` ended on: nothing dispatched the workflow on the person's behalf, so a runner was a browser tab somebody had to open and the MCP loop this exists for stopped one step short. `provision` is the verb (`fleet_provision` for free, since the tools are generated from the registry), and the credential question is the design: **not** the App's private key, which mints for every installation and has nowhere to live until the broker exists, and **not** a stored dispatch token in the coordinator, which is a credential at rest in the party this system treats as compromised — but **the asking person's own user-to-server token**, already on a host and already renewed there. It cannot exceed them, so there is no privilege to contain, and it answers ownership before the job exists: a dispatched run carries a **single-use ticket** instead of the reusable `FLEETWRIGHT_RUNNER_TOKEN`, which stays for runs started by hand. **What it costs:** one permanent host with GitHub connected before you can have a temporary one, which is the right shape rather than a limitation. **What it still does not do:** report completion — a finished runner session looks exactly like an idle one, and here the machine is being paid for by the minute |
| **Linked repositories — three roles, one linking flow** | **wanted** ([#346](https://github.com/TheTechNetwork/Fleetwright/issues/346)) | Not one feature. **(1) A PRIVATE repo a session dumps into before it dies** — the container's output is gone on stop ([#314](https://github.com/TheTechNetwork/Fleetwright/issues/314)) and a runner takes its whole workspace with it, so `git push` on a branch per session is the exit that does not need somebody watching. **(2) A PUBLIC repo, because that is what makes runners free** — Actions is free on standard runners for public repositories and metered on private ones, and `ephemeral-mac.yml` already turns a job into a fleet host. Linux and Windows are the clear case; **check macOS billing before promising it**, it has been the exception before. That repo is a launcher and nothing else: it is world-readable, Actions logs included. **(3) Repos for templates, skills, configs and workflows** — which the v3 bootstrap profiles already CREATE; linking is the other half. The security question there is real: profiles from a repo move the bound from 'somebody with a shell on the box' to 'somebody with write access to that repo', which is different rather than obviously worse, and has to be argued rather than assumed. **What is shared:** one linking flow with a ROLE on each link, because a single 'linked repo' field meaning all three is how somebody bootstraps a private thing onto a public repo |
| Sandbox: browser in-session | wanted | `docs/wanted.md` |
| Sandbox: full computer-use | wanted | `docs/wanted.md` |
| Sandbox: Android Studio + emulator (`/dev/kvm`) | wanted | `docs/wanted.md` |
| Telnyx module (Inkbox-style) — own repo, published to npm, consumed here | wanted | `docs/wanted.md` |
| Session config from app/TG | wanted | `docs/wanted.md` |
| Prompt-efficiency helpers injected at session start / **task at start** | **done, protocol v3** | [`docs/task-at-start.md`](docs/task-at-start.md). Ranked #1 in both beta reports. `start { profile }` names a file on the host and its content becomes the session's first message; `profiles` lists what a host has. The security half was already settled and is unchanged — the coordinator NAMES a profile and never carries one, so there is still no way to send text into a session. It cost a **flag day**: a parameter on an existing verb means an old host answers `bad_params` after the handshake agreed, so hosts upgrade before the coordinator |

## 6b. The install should ask nothing

Stated as the goal rather than a task, because it is the thing several other
decisions are already serving: **spin up a box, install, register, go.** Every
question the installer asks is a thing somebody has to know, get right, and
repeat on the next machine — and a fleet is by definition the next machine.

| what it asks today | what would remove it |
|---|---|
| coordinator URL | baked into the one-line install command, which already carries it |
| enrolment pin | the pin *is* the answer; the command could carry it and enrol unattended |
| Claude login | the last step that genuinely needs a human — and now reachable from the app, so it does not have to be answered during the install |
| anything the deployment configures | **the config frame** — see `docs/github-app.md`. A value the coordinator can send down an authenticated socket is a value the installer never has to ask for, and a file nobody has to place |

The last row is why the GitHub client secret is delivered over the socket
rather than written to `/etc` on each host: *"needing to put files manually on
the host is the part I don't want."* Every credential or setting that arrives
this way is one fewer question, on every machine, for ever.

Not today. But it decides the shape of anything new that needs configuring:
**if a host needs a value, the coordinator should be able to send it.**

## 7. Operations

| feature | status | where |
|---|---|---|
| `/update --restart` restarts every service, no SSH | **done** | #127 |
| Sandbox image refresh | **done** | `/update` pulls and reports whether the digest moved; a session start also checks, stamped to six hours, bounded, never fatal, only when creating a volume |
| Installer detects clones, offers clean vs update, uninstaller | **done** | #121 |
| Scheduled system/app update checks, so the answer is ready when asked | **done** | The check ran INSIDE the health frame — a `git fetch` and an apt refresh on the path the coordinator ranks hosts by, every fifteen seconds. Most frames were instant and the one after a cache expiry was not, which reads as a host going quiet rather than as a slow check. A timer computes it now and health reads the last answer; a failed check keeps the previous one rather than erasing it to null, because null means CANNOT TELL and a fleet that forgets what it knew is worse than one that is slightly stale |
| **Package the host** — versioned tarball + manifest instead of a monorepo checkout | **partial** | `docs/packaging.md`. Path-scoped "behind" **done**; `host-release.yml` publishes the tarball and manifest on release, and `/update` consumes the manifest with a git fallback — both **done**. Next: the installer's *first* install fetching a release instead of a clone (step 4 there) |
| CI runs the Worker in workerd; tail workflow; frame logging | **done** | born in the Aug-28 outage |
| **A resumed session gets a current credential** | **done** | `docs/accounts.md`. The old rule — "a resume never re-seeds, which is what keeps a session on the account it began with" — kept the bytes in order to keep the account, and the bytes were never the account. A week-old session came back logged out on a box where a new one worked. The account is pinned now and the credential is not |
| **A host that would hand out a dead credential is degraded** | **done** | `claude auth status` reports on the box's home directory; a sandboxed session runs on a copy of a file. Both are published; the coordinator degrades only on expired-with-nothing-to-renew, because expired-but-refreshable is the ordinary state of an idle box |
| **Auto-restart a session whose pane stopped moving** | **done** | `docs/sidecar.md`, `AGENT_FLEET_IDLE_RESTART_MINUTES` (60, 0 to disable). Never a session at a prompt; two attempts and then it says it has stopped |
| Scheduled credential refresh on the host itself, so a box is never signed out at the moment somebody starts a session | wanted | today the fix is a person tapping sign-in. `claude auth status` renews as a side effect; nothing runs it on a timer |
| Node-coordinator socket-leg parity tests (the ws analogue of the executed OpenAPI spec) | wanted | the one interface without an executable cross-implementation contract |

---

## The order I'd build it

1. **App polish that tonight paid for**: surface refusals; forget in both UIs; host picker end-to-end. Small, independent, all asked for.
2. **Accounts**: link → seed → visibility. The design is done and attribution is merged; this unlocks the invite flow.
3. **Additive reporting**: workspace dir, context usage, plan limits, host versions. No protocol bump.
4. ~~**Protocol v2 verbs, together**~~ — **done**, `login` included. It got the design pass it earned and came out as `connect`/`link`/`unlink` over a provider table, which is why GitHub and Cloudflare arrived in the same round rather than as three more.
4b. **Guest onboarding** — now unblocked. Every piece it needed exists: sign-in, per-person credentials, per-person visibility, and a credential flow that never asks anybody for a shell.
5. **Coordinator-level TG bot** — needs the accounts identity-linking from (2).
6. **The proxy** (`trust.md`) — its own project, highest long-term value.
7. **Mac host completion, then Windows-as-WSL2** — the dev-environment goal.
8. **Filesystem in the apps** — last, deliberately, with its own security pass.
