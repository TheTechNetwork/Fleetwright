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
| Invite flow: admin lets a friend/client use the fleet on their own Claude account | **designed** | falls out of the three `accounts.md` steps above |
| Google RISC / Cross-Account Protection receiver | wanted | needs Google console setup first |

## 2. Secrets, and what a session may touch

| feature | status | where |
|---|---|---|
| Credential-terminating proxy: sessions hold creds issued by us, proxy substitutes real ones on egress; default-deny egress | **designed** | `docs/trust.md` — the build order is written there (proxy + netns + substitution table first) |
| 1Password as custody for the proxy's real credentials | **designed** | `docs/trust.md` — explicitly not a vault-MCP in sessions |
| `gh` in every session (GitHub App, installation tokens, PATH shim) | **designed** | `docs/trust.md`, worked example |
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
| Show workspace dir; session length / context window; Claude plan limits in settings | wanted | additive fields on existing verbs — no protocol bump |
| Host version info: is it behind, does it need an update | wanted | pairs with scheduled update checks below |
| Session detail screen; notification actions | designed | `docs/plan.md` |
| TG settings setup / removal from the app | wanted | config, not protocol |
| Filesystem: browse / copy / edit / delete in the workspace | wanted — **deliberately last** | largest new attack surface in the product; own design pass; may change the IARC content rating |

## 4. Voice and the hub surfaces

The app, Siri/Assistant, and the CLI are the hub for most users. Telegram stays
as an option and no longer sets the ceiling. (`docs/app-parity.md`)

| feature | status | where |
|---|---|---|
| Speakable replies, ordinal answers, parameters nameable out loud | **partial** | principles applied in naming/intents; `answer` verb still to ship |
| **Coordinator-level Telegram bot** — one bot for the whole fleet, `/list` spans hosts | wanted | today's bot is per-box by Telegram's one-poller rule; per-box bot keeps `/enroll` |
| Browser control surface / PWA | wanted | after the app surfaces stabilise; console groundwork exists (`docs/console-design.md`) |

## 5. Protocol v2-era verbs

`PROTOCOL_VERSION` is exact-match, so these ship together, once. (`docs/plan.md` §4–5, `docs/app-parity.md`)

- `answer` — ordinal into a host-published list (never free text; `send-keys` reaches a root shell)
- `logs`, `update`, `upgrade`, `reboot` — with a host parameter, making the app a strict superset of per-box TG
- `login` / `code` — the Claude account flow from the app, the one step that still wants SSH today

## 6. Hosts and the dev-environment goal

A Windows box, a Linux box and a Mac in one fleet — a session can build and run
anything. (`docs/wanted.md` has the full table.)

| feature | status | where |
|---|---|---|
| Linux host | **done** | everything today |
| macOS host: installer runs, launchd daemons, Homebrew, clone detection | **partial** | works to the wizard; unsandboxed sessions; StateDirectory/RuntimeDirectory equivalents still to do; not yet proven on real hardware end-to-end |
| Windows host = WSL2 | wanted | a Linux host that lives on a Windows machine |
| Xcode on a Mac host (simulator, signing, `xcodebuild`) | wanted | the reason Mac hosts matter; no Linux sandbox for it exists legally |
| Sandbox: browser in-session | wanted | `docs/wanted.md` |
| Sandbox: full computer-use | wanted | `docs/wanted.md` |
| Sandbox: Android Studio + emulator (`/dev/kvm`) | wanted | `docs/wanted.md` |
| Telnyx module (Inkbox-style) — own repo, published to npm, consumed here | wanted | `docs/wanted.md` |
| Session config from app/TG | wanted | `docs/wanted.md` |
| Prompt-efficiency helpers injected at session start (rules, helpers, our own tools) | **designed** | `docs/wanted.md` — host-side named profiles, then measure interruptions before arguing about contents |

## 7. Operations

| feature | status | where |
|---|---|---|
| `/update --restart` restarts every service, no SSH | **done** | #127 |
| Sandbox image refresh on update | **done** | `/update` now pulls and reports whether the digest moved; `ensureSandboxImage` returned on its first line for the life of a box |
| Installer detects clones, offers clean vs update, uninstaller | **done** | #121 |
| Scheduled system/app update checks, so the answer is ready when asked | wanted | pairs with host-version-in-app |
| CI runs the Worker in workerd; tail workflow; frame logging | **done** | born in the Aug-28 outage |
| Node-coordinator socket-leg parity tests (the ws analogue of the executed OpenAPI spec) | wanted | the one interface without an executable cross-implementation contract |

---

## The order I'd build it

1. **App polish that tonight paid for**: surface refusals; forget in both UIs; host picker end-to-end. Small, independent, all asked for.
2. **Accounts**: link → seed → visibility. The design is done and attribution is merged; this unlocks the invite flow.
3. **Additive reporting**: workspace dir, context usage, plan limits, host versions. No protocol bump.
4. **Protocol v2 verbs, together**: `answer`, `logs`, `update`, `reboot`, `login`. One flag day.
5. **Coordinator-level TG bot** — needs the accounts identity-linking from (2).
6. **The proxy** (`trust.md`) — its own project, highest long-term value.
7. **Mac host completion, then Windows-as-WSL2** — the dev-environment goal.
8. **Filesystem in the apps** — last, deliberately, with its own security pass.
