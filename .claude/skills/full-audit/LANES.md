# Lanes

One reviewer to a lane. The parent picks the lanes the target touches,
replaces the paths below with the real ones from stage 1's map, and adds
what the batch claims. Each brief opens the same way:

```
Read <run directory>/COMMON.md in full first and follow it exactly.
Your lane is `<name>`. Your scratch directory is <scratch root>/<name>/.

Scope: <files you own, with the diff command that shows what changed>.

Background: <what was never run for real; what an earlier review found>.

What this batch claims, each of which you should try to break:
1. ...

Questions I most want answered, with evidence:
1. ...

Report as COMMON.md says.
```

Every lane also answers three questions, whatever else it is asked:

- **Two at once, and stopped half way.** For each thing in scope that
  changes state: two calls at once, a restart in the middle, a write that
  fails half way, a clock a minute wrong, a lock nobody releases.
- **Older and newer.** What an older box, an older phone and an older
  coordinator each do with what this sends, and the reverse. Which merge
  order of the open pull requests is safe.
- **The tests.** Does each new test prove what its name says
  (`test-audit`'s junk patterns)? Does the stand-in accept what the real
  thing would refuse? For the three most important regression tests: do
  they fail on the code before the fix?

---

## custody

**Scope.** `src/fleet/minter/` (`vault.js`, `org.js`, `sign-page.js`),
`worker/src/minter.js`, `src/fleet/protocol/` where it carries vault
answers, the box's side in `src/fleet/host/` (`intent-keys.js`, where
`sidecar.js` asks the vault and checks the answer), and their tests.

**Questions.**
1. For each kind of item: who may read it, and is that checked where the
   item leaves, against the org record as it is at that moment?
2. Removal and return: remove then add the same address again, two
   removals racing, an approval made in the same millisecond as the
   emptying, an approval stamped by a phone whose clock is behind, a row
   that fails to write half way. Does custody ever come back?
3. Signed answers: are the signed bytes the same on both sides, byte for
   byte? Replay of an old answer to a new request, an answer signed for
   another box, rotation of the signing key, and where the box learns
   the public key. Could the coordinator have written it?
4. A box on the new code against a minter on the old, and the reverse.
   Does the refusal say what to do?
5. Every refusal: a code, a sentence with a way out, and no secret.

**Found before.** An emptied vault accepted an approval stamped later
than the removal, because the emptying time was one phone's clock. A
removed address got custody back under a new id until a row was written
first. The unsigned-answer sentence carried the reason a key failed to
load, which belongs in the Worker's log.

## coordinator

**Scope.** `src/fleet/coordinator/` (`core.js` and what it imports),
`worker/src/worker.js`, `worker/src/fleet-do.js`, `src/fleet/protocol/`,
`src/mcp/`, `openapi.json`, `docs/intents.md`, and their tests.

**Questions.**
1. Authorisation. For every verb, endpoint and MCP tool: who may call
   it, and is that checked where the action happens? Can somebody act on
   a task that is not theirs, approve their own start, raise their own
   budget, or read another team's tasks, spend or approvals? What if the
   manager was removed in between?
2. An approval end to end. Is the held start the same start when it goes
   through: same parameters, same requester, same words? Can it be used
   twice, by another person, for another member, or after it expired?
3. State. Where is each collection kept, does it survive a restart, is
   it bounded (a Durable Object value holds 128 KiB), and is anything
   read, awaited and written without a guard? Compare each `serialise`
   with its `restore`. Reproduce a lost update with two concurrent calls
   against an in-memory `CoordinatorCore`.
4. Locks. For each lock: what frees it on every path, including the one
   where the message was never sent and the one where the box went away.
5. Money. Where a number of dollars comes from, who can report one, and
   whether any answer says "$0" where the truth is "not known".
6. Off by default. With no org record and no settings, does any
   existing flow behave differently than before the batch?
7. API truth. Pick three new endpoints and compare `openapi.json` with
   what the code returns, field by field. Does any MCP tool description
   promise what the code does not do?

**Found before.** A task's words could change between approval and
start. A lock stayed held when the message was never sent, and was
dropped while its box was only away. A kept-ready tally leaked. Two
people at the limit of labs each got one.

## box

**Scope.** `src/core/` (sessions, `engine-signin.js`, `engine-home.js`,
`hook-socket.js`, `vault-store.js`, `machines.js`),
`src/fleet/host/sidecar.js` and its neighbours, `sandbox/engine.mjs`,
`sandbox/Containerfile`, `src/adapters/`, and their tests and stand-ins
under `test/helpers/`.

**Questions.**
1. The life of an attempt or a session: start, a second start while one
   is going, status, cancel, expiry, a hub restart in the middle, the
   container dying, the first line never arriving, two members at once.
   Where does state go wrong, leak, or say what it does not know?
2. Processes. A child that is missing, exits at once, hangs, prints
   megabytes or is killed. Are children reaped, timeouts real, output
   bounded? Does a failure reach the person as a sentence?
3. Files a session can write that something later reads: a shared home,
   a config, a plugin, a note handed from one engine to the next. Can a
   session steer a later sign-in or another member's session?
4. Secrets. Can a token, a code or a page address reach a log line, the
   state file, an event, an error text, a process argument or an
   environment? Plant a marked token and search for it.
5. What is inside the seal and what rides beside it. Anything outside
   the seal is something the coordinator can write.
6. What the hub believes from a session over its socket, and what it
   does with a malformed, oversized or repeated event.

**Found before.** A hub restarted in the middle of a sign-in left a
state nobody could tell. A session could plant config in the shared
engine home that chose the page a later sign-in opened. The answer
carried its state outside the seal. A machine sweep removed machines
that were not done, and a login was handed twice. Setup jobs left old
tokens alive and did not honour cancel.

## outside

**Scope.** Everything the code assumes about software it does not own:
Codex, OpenCode, the Agent Client Protocol, Podman, tmux, Claude Code's
own dialogs, Xen Orchestra, Proxmox VE, OPNsense, Node. The pins in
`sandbox/Containerfile`, the lockfiles and the image pins say which
version. Read that project's public source at that tag, cloned into
scratch.

**Questions.** For each assumption, state what the code assumes, what
the source says, and whether they agree:
1. Does the command exist, and is the protocol the code speaks to it
   (methods, field names, order of messages, how an end, a limit and an
   error are reported) what the real one speaks?
2. Where does the tool keep its sign-in, in what shape, and does the
   code's check of that file match? Is a file copied from another
   machine usable, and what happens to the original when the copy
   refreshes?
3. What does it need to run headless, as root, in a container?
4. The error words the code looks for: are they the real tool's words?
5. Every stand-in under `test/helpers/`: where does it accept, answer or
   keep open what the real tool would refuse, answer differently or
   close? This is the heart of the lane.
6. Then walk the whole path a person takes to a working result, step by
   step, and name the first step that cannot be done.

**Found before.** Pairing Codex needed a sign-in file pasted into a
phone field, which is why an engine is now signed in on its box with a
device code. Node's keep-alive agent closed the connection OpenCode's
sign-in holds open, so that sign-in always died after four seconds. A
Codex home could not be signed in a second time.

## real-binaries

**Scope.** The runner against the real tools it was only ever tested
against stand-ins for. Only in the deep profile, and only on a machine
where `unshare -n true` works.

**The rule, which is absolute.** Install exactly the pinned versions
into scratch. After that, every run of the binary, direct or through
the runner, `--version` included, is inside `unshare -n` with
`env -i PATH=... HOME=...` and every home (`HOME`, `CODEX_HOME`, the
four `XDG_*`) pointed at a fresh directory in scratch. Bring loopback up
inside the namespace when a test needs it; the server and its client
run in the same namespace. `timeout` on everything. Never a real
credential, never a prompt for a model to answer, never a provider. If
`unshare -n` is refused, stop and report; do not look for another way.

**Questions.** Record the exact bytes exchanged.
1. Start the tool and speak to it exactly as the runner does. Does the
   first exchange succeed with the fields the runner sends?
2. With no sign-in, and with a planted, plainly fake one in the shape
   the source writes: what does the tool say, and does the runner's own
   check agree with it about what counts as signed in?
3. With no network, what does the first step that needs it do: which
   error, in which shape, after how long? Does the runner turn that into
   the line it promises, or hang?
4. The handshake before a turn, and no further.
5. Anything the stand-ins do not do: a banner before the JSON, noise on
   stderr, a first-run prompt, a refusal to run as root, files written
   outside the homes, a slow start.

**Found before.** Both blockers of the second round were differences
between a stand-in and the real tool. The offline checks are now CI
steps that start the pinned engines in the built image with the network
cut.

## phones-wire

**Scope.** `apps/ios/Fleetwright/` and
`apps/android/app/src/main/java/network/thetech/fleetwright/` where they
send, parse, verify and keep state; `openapi.json` and
`src/fleet/protocol/` as the contract. Reviewed by reading: say so.

**Questions.**
1. For each request a phone sends and each answer it parses: path,
   method, field name, type and whether it may be absent. Build the
   server's real JSON with a script driving `CoordinatorCore` in memory
   and lay it beside each app's declaration. On iOS one field of the
   wrong type fails the whole decode; on Android a wrong key is a silent
   null.
2. What is checked before something is shown. Is there a path where a
   code, an address or "signed in as" is drawn from something that did
   not pass every check? Compare, byte for byte, how each phone builds
   the bytes it verifies.
3. Where the two phones differ in what they accept: a missing field, an
   empty string against null, a number's format.
4. The state machine and its life: polling, leaving the screen, coming
   back, somebody else's attempt already going, cancel while a request
   is in the air, an answer for a request the screen has moved past.
5. Where a secret lives on the phone and for how long: Keychain or
   Keystore, a field that is not secure, the clipboard, a log.

**Found before.** A member was removed without the vault being told. A
phone forgot a pool on a refusal on one platform and on a timeout on
the other. An expired code stayed on screen.

## phones-design

The design audit. Load `antislop`, `antislop-ui`, `antislop-copywriting`,
`antislop-human` and `antislop-layoutmobile` in mode "after": audit, do
not edit. `CLAUDE.md` sets the dials (ENERGY 1, RHYTHM 1, MOTION 2) and
records one exception: the em dash is allowed in this product's UI
strings. `docs/design-system.md` is the direction.

**Scope.** Every screen and string the batch added or changed on both
phones and in the console (`console.css` and the page it styles), with
`docs/app-parity.md` and the tests that read the sources as text.

**Questions.**
1. Walk each feature as a person would and fill in a table: feature,
   can it be finished on iOS, on Android, in the console, and where it
   breaks. A path that dead-ends, or needs something the app cannot do,
   is a finding.
2. C-2: every button, and whether the server would accept its request
   in the state where it is drawn.
3. C-5: everywhere a null, an absent field or a failed request is drawn
   as "none", "0", "up to date", "Ready" or an empty list with a
   reassuring sentence.
4. Parity: every sentence and every condition for showing a control, on
   both phones. List each difference. Then what the text-reading tests
   do not cover: a rule that exists on one phone only.
5. The words. Read every new string as a person in a hurry at night
   would. Which are unclear, which claim more than the app knows, which
   read as generated? The answer first, then the reason, then the
   mechanism.
6. A row that looks different should mean something is different. Where
   does the design spend that signal on nothing?
7. People: labels on icon-only controls, a code read out sensibly,
   large text against fixed heights, 44 pt and 48 dp targets, colour as
   the only signal. Run `contrast-check.py` on any new colour pair
   before saying it passes.
8. A new colour, radius or size written outside the palette, or one
   surface disagreeing with the other two.

**Found before.** "Ready", "current" and "finished" were said of jobs
that had only partly worked. A list the fleet had not filled yet was
drawn as a fleet with no machines. A button was offered before there
was anything for it to act on. A failed load looked like an empty page.

## machines

**Scope.** `src/fleet/host/` pools, `xo-*.js`, `edge-*.js`, the Proxmox
VE setup, `src/core/machines.js`, `sandbox/machine/`, the image build
scripts, and `docs/hypervisors.md`.

**Questions.**
1. Lifecycle and races: made but not started, started but not recorded,
   a sweep that misreads a state, a timer, a build running while its
   release is replaced, a failed build retried, a disk filling.
2. Will a machine made this way work as a fleet host once it joins?
   Follow what the hub and sidecar need at start that the image lacks.
3. Authority at each hop, phone to coordinator to sidecar to hub. Who
   can end somebody's machine, or start one in their name? Can one
   person exhaust a box for the others?
4. The edge: rule order, what a lab can reach, escaping of every value
   written into a config, the pair restarting together, where the
   shared password is kept, and how long a rebuild drops the way out.
5. The packaged release: is everything the code needs on a released
   box, with the modes it needs?

**Found before.** A build VM that stopped was taken for the image
before it said done. A router was stopped before its replacement was
built. A released box could not send the pool master its password,
because the helper was written where a release cannot write.

## docs-truth

Not a hunt for bugs in the code. Whether what the project says is true.

**Scope.** `README.md`, `docs/`, the MCP tool descriptions, status
markers ("built", "not yet run"), and the tests of the area.

**Questions.**
1. Each concrete claim (a behaviour, a default, a time, a limit, a
   name, what the phone says) against the code, with `file:line` on
   both sides.
2. What is documented as working and has never been run for real. This
   becomes the report's "never been run" list.
3. The most important behaviours with no test, ranked by risk.
4. Tests whose names promise more than they check.

**Found before.** The hypervisor documentation was rewritten to say
what the code does, and the page on the pool sweep to say what it
removes.

## ci-gate

**Scope.** `.github/workflows/`, `scripts/verify.sh`,
`scripts/check-coverage.mjs` and its neighbours, the Renovate config,
the image build files, `docs/ci.md`.

**Questions.**
1. A step that passes with the thing it checks absent: a grep that
   matches nothing and exits 0, `|| true`, a status dropped in a
   subshell, a test skipped when a binary is missing. For each check,
   is there a negative control?
2. A `needs` and `if` pair that lets something publish when its test
   was skipped or cancelled. A path filter that keeps a job from
   running on the change it guards. A push to main that ships what a
   pull request never tested.
3. Every action pinned to a commit. No secret a fork's pull request can
   reach. Every pin's regex run against the file it is meant to match.
4. "No network" really holding for a step that says so.
5. The gate: does it name the cause when a run fails with no failing
   test, and never hide a real one? Does anything it claims about the
   runtime hold? Run it on one small suite and see.
6. A run that fails with every test passing: which process did it?
   Reproduce it, then fix the cause.

**Found before.** The gate's own fix for a cut-short coverage file
could never work, because Node removes the directory it meant to read,
and the comment said otherwise. That failure, once named, was a test
stand-in killing the runner while it wrote its coverage on the way out.
A smoke script could pass with no sessions allowed at all.
