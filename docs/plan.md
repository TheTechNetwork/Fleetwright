# The plan, after identity

This is the output of a design review — eight critics over the product, the two
apps, the web UI, the surfaces, the domain model and the sequence, then an
adversarial pass over every proposal, then a synthesis. It is written down
because this project writes its decisions down, and because the most valuable
thing in it is an argument that **the obvious next step is wrong**.

## What I got wrong, first

Going in, my diagnosis was: the loop dead-ends because there is no verb to
answer a session, and the fix is a narrow `reply` verb that bends design.md §5
as little as possible.

That was wrong twice.

**There is nothing to reply to.** `watcher.js` reads the whole pane, tests it
against four English regexes, sets a boolean, and discards the text one line
later. `firstPrompt()` then returns `session.detail` — the registry's last
lifecycle string. So the notification at 3am says `resumed (summary)`, never the
question. A `reply` verb would have had nothing to bind to, and an Approve
tapped from a twenty-minute-old notification would approve whatever happened to
be on screen when the packet landed.

**And the "narrow" version was the dangerous one.** `send-keys` into a Claude
Code pane reaches `!` bash mode, slash commands, and a bare root shell after one
Ctrl-C. A `reply { text }` verb is therefore strictly *worse* than the shell
string §5 forbids — it looks bounded and is not. The rule was right and I was
about to bend it in the one direction that empties it.

The correct shape is the reverse: mint the **prompt** as a first-class object on
the host, and let the answer be an **ordinal into a list the host published**. A
compromised coordinator can then select an option the session already offered
and can never originate one. §5 does not bend at all.

## What I verified myself

Not everything below is checked — it is a plan, and it is allowed to be wrong.
These are the load-bearing facts I confirmed in the code before publishing it:

- `firstPrompt()` returns `session.detail || 'is waiting for input'`
  (`src/fleet/host/watcher.js:148`) — the push body cannot carry the question.
- `place()` fans `list` out over `registry.schedulable()`, which requires
  `state === 'healthy'` (`scheduler.js:45`, `registry.js:155`). **A box whose
  Claude is logged out drops every one of its sessions off your phone**, with no
  indication that anything is missing.
- `skipPermissions` defaults to `true` (`config.js:88`), which is what makes the
  free-text argument decisive rather than theoretical.
- There is no path from the command registry to `sendKeys`; only `login.js`
  calls it, to type an auth code.

## 1. THE THESIS

This is **the decision surface for agents you own**. Its job is to answer three questions nothing else answers: *which of my sessions, across all my machines, needs me right now*; *what is it asking*; and *who said yes*. It is not a chat client and not a terminal. Anthropic's Remote Control already drives one session you already knew about, with structured messages, diffs and real permission UI — it will always beat a pane-scraper at conversation, and we should stop trying. What it structurally cannot do is span four boxes, survive their reboots, tell you which of eleven sessions is stuck, say what happened while you slept, or record who approved the force-push. That gap is the product. The disagreeable claim: **we should deliberately never build free-text input**, and accept permanently that the escape hatch for "this needs a real conversation" is a link that leaves the app. Everything we build is inventory, interruption, decision, and memory — and the one write we own is answering a question the session already asked, from a list the session already offered.

## 2. WHAT IS BROKEN NOW

### 2.1 There is no *prompt*. Nothing in the system represents "a session asked a question, and these are its answers."

This, not the missing verb, is why the loop dead-ends. `watcher.js` holds the full pane in a local variable, tests it against four English regexes, and then calls `firstPrompt(session)` — which returns `session.detail || 'is waiting for input'`. `detail` is the registry's last lifecycle string. So the 3am push body is literally `"waiting for resume choice"` or `"/new (safe)"`. The pane is discarded one line after it was read.

Everything downstream inherits that emptiness. The notification has nothing to say → the phone has nothing to offer → the only honest button leaves the app. A `send` verb bolted on now would have nothing to bind to: an Approve tapped from a twenty-minute-old notification would approve whatever happens to be on screen when the packet lands.

### 2.2 The apps cannot render the one state the product exists for.

`awaiting-input` is not a registry status — `sessions.js` writes only running/stopped/error. It exists solely as a transient push event that nothing persists (`events` is in RAM, absent from `#writeState` and from the DO's stored keys, and the DO hibernates by design). Dismiss the notification and the information is gone forever.

Meanwhile `Fleet.swift` has working `peek()` and `forget()` with **zero callers**; there is no `userNotificationCenter(_:didReceive:)` on iOS and no data-handler on Android, so the payload's `name`/`hostId`/`url` are never read on either platform; and `place()` fans `list` out over `schedulable()`, which requires `state === 'healthy'` — so **a box whose Claude is merely logged out drops every one of its sessions off your phone**, silently.

### 2.3 Identity was built as a gate, not an entity — and it has a live security consequence.

Every route past the auth block accepts any device credential. Any colleague the domain allowlist admits can `DELETE /api/hosts/{id}` every machine in the fleet, `DELETE /api/clients/{id}` every other person's phone, and `POST /api/enroll` to mint pins. Nothing durable records that they did, because `dispatch()` records nothing at all — the verified actor is forwarded to a host and vanishes; `#onHostEvent` and `record()` produce `{hostId, event, name, text, url, at}` with no actor and no verb.

And the asymmetry: the roster of *machines* is runtime data with provenance, fingerprints and revocation. The roster of *people* is an environment variable that needs a redeploy to change and cannot express "this person, no longer."

**2.3 is not really a design problem and should not wait for this plan.** Ship the admin-gate this week (§3, Phase 0).

## 3. THE SEQUENCE

### Phase 0 — Truth-telling and the security gate. No protocol change, no app store. ~1 week.

Everything here is cheap, independent, and makes every later phase legible.

| # | Change | Unlocks | Cost |
|---|---|---|---|
| 0.1 | **Admin capability on the destructive routes.** One boolean on the client record, checked at `DELETE /api/hosts/*`, `DELETE /api/clients/*`, `POST /api/enroll`. First person on a fresh fleet is admin; the API token is break-glass. | Closes 2.3's hole. | Must be labelled in `identity.md` as *a guardrail against colleagues and mistakes, not a security control* — it is enforced inside the coordinator, the component `trust.md` assumes compromised. Write that sentence or the next design leans on it. |
| 0.2 | **Fan reads over `connected`, not `schedulable`.** Schedulability is a write-path question. | A logged-out box stops swallowing its sessions. | One word. Genuinely. |
| 0.3 | **`place()` refuses an ambiguous pin**, naming both host ids in the reason, instead of taking the first Map hit. | Stops `stop bigjob` silently killing the wrong box. | Zero protocol cost — no new field crosses the wire. Do *not* add the `host` param yet (see Phase 3). |
| 0.4 | **`Device` gains a required `clientId`**; unauthenticated push registration is refused; `ClientRegistry.revoke` drops the registration. | Revoking a stolen phone stops the fleet *telling* it — today it keeps receiving session names and prompt text forever. | Breaks the token-keyed reinstall dedupe. Decide it here: prune by age, don't defer. |
| 0.5 | **One line in `dispatch()`** records `{verb, params.name, actor, hostId, at}` into the ring. | The single highest-value line in this review. Makes 0.6, Phase 4's stale-tap message, and the console's event stream possible. | Nothing. The actor is already verified and in hand. |
| 0.6 | **Persist the event ring** — *separate* DO key and *separate* file, capped ~500, never carrying pane or status text. | "a phone that was asleep can catch up" stops being false. | `loadState()` deliberately throws on anything but ENOENT, so a truncated event append must never be able to take the host list with it. That is why it is a separate file. |
| 0.7 | **The honesty PR.** `ok: results.some(r => r.ok)` → report partial fan-out failure instead of claiming success; check status before `JSONDecoder`; make iOS's `let status: String` tolerant so one malformed session stops emptying the whole list; surface `modeSuffix()` (an app that can't tell you permissions are bypassed is unacceptable at any default); move Android's `POST_NOTIFICATIONS` ask out of `onCreate` to after sign-in; monochrome notification icon; `BackHandler` on settings; delete the dead `ended` badge case and the unreachable client methods. | The first screen a real human ever sees stops lying. | Hours. Do it as one PR so it isn't argued item by item. |

### Phase 1 — Mint the prompt on the host. ~1–2 weeks. **This is the foundation.**

A per-session prompt registry **in the sidecar**, fed from the pane read that `#enrich` is *already paying for* on every `list`.

```
{ id, name, question, options: [{index,label}], openedAt, source: 'pane', paneHash }
```

`id` and `paneHash` are host-minted. Open prompts fold into the `list` and `health` replies — no new channel, no new route, no coordinator state. `session.awaiting-input` grows the question and the option labels.

**Three calls I am making here, against the review:**

**(a) Prompts live on the host, derived on demand — not in a coordinator `outstanding` map.** A coordinator-side map is built on the least durable object in the system: `events` is unpersisted and the DO hibernates on schedule, so the feature whose entire justification is "push drops, so the list is the state" would evaporate on routine eviction. It also makes the coordinator authoritative about session state, which is the one rule stated twice. Folding into `health`/`list` gives the same list for free and self-corrects when someone answers in Remote Control.

**(b) Pane-sourced first; the `PreToolUse` hook is a later, narrower thing.** The hook proposal borrows unforgeability it does not have: the socket-is-the-authority inversion is a property of the *podman bind-mount*, and `install.sh:598` registers one global `settings.json` for every session on the box — so on any unsandboxed host (which is what `install.sh` produces) any local process can POST a fabricated prompt and harvest a real human's Approve. And `skipPermissions` defaults **true**, so a 900s blocking hook on every tool call turns "sessions run unattended" into "sessions crawl". The hook path is worth building **only for sandboxed safe-mode sessions**, where `entrypoint.sh` can register it per-session — and only after Phase 3 proves the loop. Scope it that way now rather than discovering it during the build.

**(c) Pane text leaving the fleet is a posture change and gets a per-FLEET switch, default off — not a per-person one.** The two resume patterns leak nothing; `Do you trust the files` and `Do you want to proceed` leak paths and command lines, onto a lock screen, through Google's and Apple's servers. Default is fleet-authored strings only. The sentence goes in `trust.md`, not behind a toggle in an app, because the fleet may not belong to the person holding the phone.

**Cost:** the detection layer becomes correctness-critical — see §5.1. No new component in the container, no new dependency, no protocol change.

### Phase 2 — The session screen, iOS first. ~1 week.

**2a. The state vocabulary, owned in exactly one place** — `working / waiting for you / stopped / finished / broken`. This is a product decision, not a UI cleanup, and "waiting for you" currently exists nowhere: the registry has three storage states, the watcher has a boolean, `describeEvent` returns prose, and nothing reconciles them. Once it exists in one place, the notification body, the badge, the list sort, the detail header and the console all agree by construction. Left as a bullet, five surfaces will each invent their own.

**2b. The screen.** State sentence at `.title3` ("Waiting for you · 4m"), the question, identity block, then the pane: **60 lines is a hard ceiling** (`/api/peek` is hardcoded at 60; `lines` can only narrow), monospaced, `softWrap = false` inside a horizontal scroll — box-drawing borders at 70–100 columns must never reflow. Poll `peek` at 3s for the first 30 seconds *while you are deciding*, then 10s, then **stop** with "tap to refresh". A screen left open on a desk must not poll a production host forever — `peek` is PINNED, so every tick is a routed round trip down one host's single outbound socket and a `tmux capture-pane` fork on the box running the session.

**2c. Remote Control stays prominent whenever there is no published prompt.** Demoting it to a footer is wrong: until we have `answer` it is the only way to reply to anything, and after we have `answer` it is still the only way to reply to anything the option list can't express. Buttons when there's a prompt; RC front and centre when there isn't.

iOS first because it has no Peek at all while Android has one; the platforms start from different places.

### Phase 3 — Protocol v2. One bump, everything at once. ~2 weeks + review queues.

`validateIntent` refuses on `env.v !== PROTOCOL_VERSION` with no negotiation, and the clients will be App Store / Play Store binaries. **A protocol bump is now a release train through two review queues, during which a lagging host rejects *every* intent, not just the new one.** So we bump exactly once and put everything in it:

1. **`answer { name, prompt, option: int 1..9 }`** — no `text` parameter, now or ever, and that goes into `intents.md`'s "deliberate exclusions" as a third entry.
2. **`host`** on the pinned verbs, so 0.3's refusal becomes resolvable.
3. **`labels`** on `start` — `place()` already filters on it and `VERBS.start` has no such param, so today it either refuses correctly or throws inside `send()` and gets reported as `host_timeout`, blaming the host for a coordinator failure.
4. **A bounded opaque-string param type** for the prompt id. `ParamSpec.type` is `name|enum|int` and a prompt id is none of the three; `labels` needs it too, and so does any future reboot ceremony. Cross that line once.
5. **`verbs`/param-shape advertisement in `health`**, so surfaces grey out rather than offering buttons that will fail. A names-only list is not enough — unknown params are *rejected*, so the advertisement must carry shape.

**On `answer`'s shape, resolving the three competing versions:** take the **ordinal** (`option: 1..9`), not a named choice. A named `yes` requires the host to *classify* the dialog, which makes every Claude Code TUI change a correctness-critical parser edit in `src/core/claude.js` — an upstream path. An ordinal only requires the host to confirm option *n* is rendered. Take the **prompt id** from the other proposal; it is the best single idea in the review and it closes the temporal hole. And **`always` / "don't ask me again" is excluded from the option list** — `parseResumeDialog` already filters it, and a permanent global permission grant made with the least context anyone will ever have does not belong behind a lock-screen tap.

**Where the rule bends, exactly:** §5 says the coordinator may never express a shell string. `answer` does not relax that — a `reply {text}` verb would be strictly *worse* than a shell string, since `send-keys` into a Claude Code pane reaches `!` bash mode, slash commands, and a bare root shell after one Ctrl-C. `answer` keeps the property that a compromised coordinator can accept work the session already proposed and originate none. **But be honest about two things `trust.md` must now say:**

- A compromised coordinator can start a session, wait for the trust dialog it knows is coming, and answer it. `peek` lets it learn the hash. The bound is not "cannot cause a proposal to exist" — it is "can only ever select an option already rendered, and can never supply the text of a proposal."
- **The pane-sourced path is `sendKeys` with a narrower charset, and the re-read is a TOCTOU window, not a fix.** `answerResumeDialog` already flinches from exactly this — it sends a bare Enter rather than `'1'` because a literal digit typed into a non-dialog is the failure it fears. We narrow the window (re-capture, hash-match, refuse if the option count moved, emit at most one digit and one Enter) and we write down that it is narrowed and not closed.

Also: `answer` needs a host-side write path. There is **no way to send keys through the command registry** — no `COMMANDS` entry does it, `login` calls `tmux.sendKeys` directly. So this is a new `/answer` command upstream in agent-hub, and it must meet `upstream-agent-hub.md` rule 2 on its own merits (it does: agent-hub's own Telegram adapter has the identical gap). Do **not** add a second loopback endpoint that types into a pane — that would weaken the sidecar's claim that the verb allowlist *is* the defence.

### Phase 4 — The notification that answers. ~1 week after v2 ships.

Payload: title = the session's `title` (the work, not the animal); body = the question, ~180 chars; `data` = `{hostId, name, prompt, kind, options}` — noting FCM `data` is `map<string,string>`, so options is a JSON string inside a 4KB budget and long option lists get truncated to the first two.

Categories registered at launch: `permission` → [Approve][Deny], `choice` → first two options. Handle in `didReceive` on iOS. **On Android, not a bare `BroadcastReceiver`** — it gets ~10 seconds on the main thread and cannot reliably do a network round trip; use WorkManager. And Android must move off the FCM `notification` payload to data-only to attach actions at all, which is a real reliability trade against app-standby buckets and belongs in `docs/push.md` with the "send a test notification" button as its mitigation.

**Clearing:** on foreground, from the open-prompt list. **Not** a silent `content-available` push — that is the single most throttled class of push there is, and a dropped clear leaves exactly the stale button we were removing. A stale tap fails with `already answered by eli@… at 14:02`, which is 0.5 doing real work and is a better outcome than a silent disappearance. `removeDeliveredNotifications(withIdentifiers:)` is a no-op on a device that never received it, so no per-prompt device list is needed.

**No escalation reminder.** `resumeAskTimeoutMs` is 600_000 — a 10-minute second buzz fires at the same instant `#armChoiceTimeout` answers the dialog and destroys the thing being escalated.

### Phase 5 — The operator console + browser sign-in. ~3 weeks. One project.

They are one project: a console with no browser sign-in has no credential; a browser sign-in with no console has nothing to sign into. Ranking them apart hides the combined size.

Served by the coordinator at its own origin, `default-src 'self'`, no build step (`worker.js:215` already ships HTML as a template string, so the precedent exists). OIDC authorization-code + PKCE; the credential lands in an `HttpOnly; Secure; SameSite=Strict` cookie that JS never sees — which is the answer to the question `wanted.md` names as genuinely hard, and same-origin also deletes CORS, of which there is none anywhere today.

**The one correction that must be in the design, not discovered:** read the cookie *inside* `credentialFrom()`, and have it return `{credential, source}`. The shorthand mutating-GET routes then refuse on `source === 'cookie'` as a check on a value the extractor produced — not as a second opinion in a route handler, which is exactly the failure shape that file's header was written to end. Add an Origin check on state-changing routes; `SameSite` alone is not defence in depth once a cookie exists.

Content: the host rail rendering the `reason` string (`registry.js` goes out of its way to make "we don't know" unrepresentable — "claude is not logged in on this host", "last health report was 71s ago" — and nothing renders it), the session wall, the now-attributed event stream, and `j k p s /` keybindings. **`textContent`, never `innerHTML`** — a session can print markup, and this page is on the origin holding every credential.

**Keep `src/web/index.html`, retitled to name the box.** Not for break-glass — if you have SSH you have the CLI — but for **bootstrap**: `/enroll <pin>` and `/login` must work before the box is in any fleet, and `/login`/`/code` are excluded from the intent protocol for a stated and correct reason. It is upstream's file; do not delete it and do not grow it into the fleet UI.

### Phase 6 — Secrets before workspaces, and the fact that decides it.

Two proposals competed for the day-one slot and **neither stated the fact that settles it**: `sandboxArgv` mounts `work-<name>:/work` — an **empty named volume** — with `-e IS_SANDBOX=1` and no environment passthrough at all.

So for a sandboxed fleet (the recommended posture):
- **`workspace: name → host path` is a no-op.** Making it work means bind-mounting a live repository into a container running as root with permissions off — which retires design.md §2's actual claim ("give a session full root, and delete everything it did afterwards") and quietly redefines `forget` from "delete the volumes" to "delete the volumes but keep whatever the agent did to your repo."
- **A secret cannot "simply be in the env."** A sandboxed session starts in an empty `/work`, so its first act must be a clone, and cloning a private repo needs a credential. `start --secret github-deploy` is the day-one unblocker; `--workspace` is not.

**Therefore: secret references first, workspaces only for unsandboxed hosts and only with the §2 sentence written down.** And state plainly that reference-not-value bounds what the *coordinator* learns and does nothing about what the *session* holds — the version that satisfies `trust.md`'s "the session never holds a durable secret" is a broker on the hook socket, which is materially more than "seed it the way credentials are seeded now."

## 4. WHAT WE ARE NOT DOING

**Free text, in every form — `say`, `reply`, a `text` param on `answer`, and the `ask_human` MCP tool.** The elegant version argues the direction is reversed: the coordinator merely relays text into a tool result a session is already blocked on. That establishes the channel is *authorized*; it does not establish it is *bounded*, and boundedness is what the rule is about. `start` accepts `mode: dangerous`, so printable text into a session **is** arbitrary execution by way of the model — the proposal's own defence ("in safe mode the model has to come back and ask permission") concedes it, and safe mode is neither the default nor shipped. Separately, `send-keys -l` with "no control characters" excludes newline, so `say` is a single-line box — it cannot deliver the property it claims over Remote Control, which already does this well with file context and history. The line, written down: **arbitrary bytes may never reach a terminal, and may not reach a model's context either while `dangerous` is the default mode.**

**Signed intents, now.** The right long-term answer and the wrong next step, because **the bootstrap does not bootstrap**: the enrolment pin is minted by the coordinator (`fleet-do.js` → `core.enrollment.mint`). The human channel is unforgeable; the *content travelling down it* is not — a compromised coordinator returns a pin committing to a key it controls and the operator reads it aloud in good faith. Making it real means the phone mints the secret from its own enclave key and the coordinator never sees it first, and six digits cannot commit to a P-256 key against an adversary who can grind keypairs. That is a trust-root project, not a card. It also must be decided *together with* the passkey direction `trust.md` already commits to, or it is the second credential story. One note to carry forward: if it is ever built, the tier line is **signed = mutating, unsigned = read-only + health** — not "the current eight stay unsigned", because `forget` destroys `work-<name>` and the unsigned tier's worst case is therefore already worse than "started and stopped some sessions."

**Flipping `skipPermissions` to false by default.** It is the acceptance test for Phases 1–4 wearing a feature's clothes; its own cost section concedes "hours to flip the flag, weeks to make flipping it a good idea." Flipping a global default changes what every existing fleet does on its next upgrade, silently, in the direction of hanging. `/new --safe` already exists and costs nothing. Run safe mode deliberately, measure the ask rate, then decide.

**A coordinator-side `outstanding` prompt map** — see Phase 1(a). **Live Activities** — the binding constraint is the 8h/12h ceiling, not "ActivityKit is for bounded things"; the narrow version worth revisiting is a short Activity around `start` → `session.rc-online`, which already has both signals on the wire. Edit *both* `design.md` §7 and `wanted.md`, or the docs start disagreeing. **A widget, a Quick Settings tile and dynamic shortcuts** — the acute surface is inert; a tile saying "2 waiting" is a worse version of the notification that already told you, and three headless entry points sharing a 401 handler that *clears the credential* is a foot-gun, not a UI addition. **A PWA service worker** — caching a console whose entire value is freshness is a mechanism for showing a stale fleet convincingly; if installability requires an SW, it is network-only passthrough. **Telegram as a fleet client** — it would multiply reach over a loop that still dead-ends, and it smuggles in a second identity system (`telegram:12345` behind no Person record); `src/adapters/telegram.js` is an upstream path, so it is a *second* adapter, not a split. **A second sandbox image with Chromium** — the multi-arch build runs arm64 under QEMU deliberately so the Pi story is a deployment; adding Playwright to that is not "a second thing CI builds", and a browser turns rendered pages into a prompt-injection control channel, which is a change of kind and not degree. **Device-purpose enrolment for CI** — real gap, wrong mechanism (a ten-minute speakable pin is hostile to an unattended runner) and it builds the roles system by accident at an enrolment route. **Telnyx / Inkbox** — close it, on scope: a different product in a different repository, and an inbound channel authenticated by spoofable caller ID pointed at a system that just spent a rework making identity real. Do **not** close it on "push plus the app already solves reach-me" — that is exactly the reasoning that gets re-derived in a year. **`PARITY.md` as a table** — write the wire fixtures instead (they catch every divergence found: `resumable` derived two ways, `"null"` mapped on one platform only, strict decode emptying the list) and keep the doc to three rows: credential storage, sign-in provider, notification surface. A required-reason column invites filling cells in to satisfy the table.

## 5. THE HONEST RISKS

**5.1 The prompt is a screen-scrape of somebody else's TUI, and `answer` makes it correctness-critical.** Today a bad match costs a wrong notification. After Phase 3 it costs a wrong keystroke into a live conversation. Four English regexes, a pane hash, and a TOCTOU window between capture and send are all that stand behind it. `answerResumeDialog`'s bare-Enter trick is evidence the codebase already knows this. Mitigation is refusing unknown shapes outright rather than guessing a default, and pinning `CLAUDE_VERSION` — neither of which is a proof. **This is the risk I would most expect to bite.**

**5.2 Nobody has run these apps in anger, and the untested part is exactly the part the plan bets on.** `docs/app-testing.md` records both apps built and Android driven on an emulator, with **notification display never exercised** because the permission alert needs a tap. Every estimate in Phase 4 — background action handlers on a locked device with a cold radio, data-only delivery under Doze, iOS categories firing without foregrounding — is unverified. If one of them doesn't work, Phase 4 degrades to "tap to open the session screen", which is Phase 2 and still useful, but the two-tap answer was the whole pitch.

**5.3 The v2 bump is the first time the version rule bites, and it bites through two app review queues.** Exact-match, no negotiation: a host that lags rejects *every* intent. Per-host intent building is buildable (`registry.js` already records each host's `protocol`) but nobody has designed it, and it isn't in the estimate. If review takes three weeks, the fleet is frozen at v1 for three weeks.

**5.4 The privacy default may make Phase 1 invisible.** Pane text in a push body is opt-in per fleet, default off — which is right, and which means the flagship improvement ships switched off and nobody will know to turn it on. The mitigation is a line in the console's host rail saying prompt text is suppressed, with the switch next to it.

**5.5 The premise that numbered menus are the common park is asserted, not measured.** Everything from Phase 3 onward is sized for a world where most parks are yes/no or numbered choice. The resume dialog is arguably *not* common — it only appears on a resume with a stored uuid and no `choice`, `#armChoiceTimeout` kills it after ten minutes, and `sessions.js` already returns the rendered dialog synchronously to whoever pressed Resume (which the app simply doesn't display — an afternoon's work that covers real value today). If the true distribution is mostly free-text questions, `answer` buys much less than claimed and the honest answer becomes "notify well, then hand off." **The measurement is cheap and should start in Phase 1**: log prompt kind and option count for two weeks on one box, locally, before Phase 3 is committed. That is the one number that could change this plan, and we do not have it.