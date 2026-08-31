# Roadmap

Every feature asked for, in one place, with an honest status. The detailed
designs live in `docs/`; this is the index that stops them getting lost.

Statuses: **done** (merged to main) · **partial** (some of it shipped, the rest
named) · **designed** (written down, not built) · **wanted** (asked for, not
yet designed).

---

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
| **A credential socket, serving the token we already have** — no `GH_TOKEN` in the environment | **designed, next** | `docs/github-app.md`. The half of the broker that needs no decision about the private key, and the order trust.md argues for: "minting without the broker is a shorter fuse on the same bomb; the broker without minting is already an improvement." It also fixes something immediate — renewal reaches the next session and cannot reach into a running one, which a socket makes disappear |
| **Repository scoping** | **already in force, and free** | A user-to-server token cannot exceed the installation, so a person who installed on *Only select repositories* already has per-repo scope. Checking that setting is worth more than anything below it and costs no code |
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
| Filesystem: browse / copy / edit / delete in the workspace | wanted — **deliberately last** | largest new attack surface in the product; own design pass; may change the IARC content rating |

## 4. Voice and the hub surfaces

The app, Siri/Assistant, and the CLI are the hub for most users. Telegram stays
as an option and no longer sets the ceiling. (`docs/app-parity.md`)

| feature | status | where |
|---|---|---|
| Speakable replies, ordinal answers, parameters nameable out loud | **partial** | `answer` ships and takes an ordinal, which is the speakable form; the spoken *phrase* for it is not wired to Siri/Assistant yet |
| **Coordinator-level Telegram bot** — one bot for the whole fleet, `/list` spans hosts | wanted | today's bot is per-box by Telegram's one-poller rule; per-box bot keeps `/enroll` |
| Browser control surface / PWA | wanted | after the app surfaces stabilise; console groundwork exists (`docs/console-design.md`) |
| **An MCP server, so the Claude app can drive the fleet** — launch a session on a Mac (later Windows) as effectively a subagent | wanted | Smaller than it sounds: the intent protocol is *already* MCP-shaped — fixed verbs, typed parameters, structured replies, refusals that name a reason. An MCP server is a thin adapter over `/api/intent`, not new architecture. The real questions are auth (the server holds a device credential, so it is a member with that person's visibility — which the accounts work already makes meaningful) and which verbs to expose: `list`/`status`/`peek`/`start` read naturally as tools; `answer` is the interesting one, because a subagent answering another agent's prompt wants a policy, not just a permission. Depends on Mac hosts (item 7) for the case that motivates it |

## 5. Protocol v2-era verbs

**They do NOT have to ship together, and that correction is worth more than the verbs.** An older host answers an unknown verb with `unknown_verb` — a named refusal that strands nothing. It is adding a PARAMETER to an existing verb that forces a bump, because `bad_params` arrives *after* the version check has already agreed. So verbs ship one at a time; only parameter changes are a flag day. (`docs/plan.md` §4–5, `docs/intents.md`)

- `answer` — **done**. Ordinal into a host-published list, `promptId` closing the temporal hole
- `logs` — **done**. Service journals by enum, plus a session's own output (container stderr, which outlives the pane)
- `status` — **done**. One session in detail, or the fleet
- `update`, `upgrade`, `reboot` — **done**. Each takes a host, which is what makes the app a strict superset of per-box Telegram rather than a copy of it
- `login` / `code` — **done**, and not as `login`/`code`. It shipped as `connect`/`link`/`unlink`, three generic verbs over a table of providers, because the ask was never only Claude: *"Cloudflare api can be generated via a custom url so created in app, same with GitHub, same with many others."* Adding a provider is now a row in `src/core/connectors.js` — no verb, no version, no App Store or Play release, since both apps render their picker from the catalogue the HOST publishes. See `docs/connectors.md`

**Shipped 2026-08-28**, all five on coordinator, Worker, host, iOS and Android in one stacked round. `PROTOCOL_VERSION` is `2`. The note above is still the rule going forward: verbs are cheap, parameters are the flag day.

## 6. Hosts and the dev-environment goal

A Windows box, a Linux box and a Mac in one fleet — a session can build and run
anything. (`docs/wanted.md` has the full table.)

| feature | status | where |
|---|---|---|
| Linux host | **done** | everything today |
| macOS host: installer runs, launchd daemons, Homebrew, clone detection | **partial** | works to the wizard; unsandboxed sessions; StateDirectory/RuntimeDirectory equivalents still to do; not yet proven on real hardware end-to-end |
| Windows host = WSL2 | wanted | a Linux host that lives on a Windows machine |
| Xcode on a Mac host (simulator, signing, `xcodebuild`) | wanted | the reason Mac hosts matter; no Linux sandbox for it exists legally |
| **Ephemeral hosts on GitHub Actions runners** — a temporary session on a free macOS or Windows runner | wanted, and it may beat owning a Mac | A runner IS an ephemeral host: the installer already runs on macOS (#119/#120), a runner has a public network path out, and the sidecar dials OUT so it needs no inbound route. It enrols with a pin, works, and is gone when the job ends. **What has to be true:** a pin minted per job (they are already short-lived, single-use and host-bound — the design fits without changes); the host id must be unique per run or two jobs collide on one identity, which is the clone bug in a new costume; the session must be `forget`-able by the coordinator when the runner vanishes, because a host that never disconnects cleanly is a host the registry keeps offering. **What it does not solve:** a runner is limited (6h, no persistence, Apple's licence still governs what may run), so it is right for a build or a test and wrong for the long-lived session this product is otherwise about. **What makes it appealing anyway:** free macOS and Windows, no hardware, and a clean answer to "can this session build an iOS app" that does not require buying a Mac. Pairs with the MCP item above — Claude asking for a temporary Windows box is exactly the case that makes both worth having |
| Sandbox: browser in-session | wanted | `docs/wanted.md` |
| Sandbox: full computer-use | wanted | `docs/wanted.md` |
| Sandbox: Android Studio + emulator (`/dev/kvm`) | wanted | `docs/wanted.md` |
| Telnyx module (Inkbox-style) — own repo, published to npm, consumed here | wanted | `docs/wanted.md` |
| Session config from app/TG | wanted | `docs/wanted.md` |
| Prompt-efficiency helpers injected at session start (rules, helpers, our own tools) | **designed** | `docs/wanted.md` — host-side named profiles, then measure interruptions before arguing about contents |

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
| Scheduled system/app update checks, so the answer is ready when asked | wanted | pairs with host-version-in-app |
| **Package the host** — versioned tarball + manifest instead of a monorepo checkout | **partial** | `docs/packaging.md`. Path-scoped "behind" **done** (a docs commit no longer makes a host say it is behind, or restart). Next: publish the tarball in CI, then teach `/update` the manifest with a git fallback |
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
