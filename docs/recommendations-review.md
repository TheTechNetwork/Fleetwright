# The recommendations, checked

Nine hardening recommendations, each checked twice. The first pass held every
claim against the vendor document it rests on; those sources are kept below.
This pass holds each one against this tree at `fd297ff`, with the file and line
that decides it, so the next person can re-run the check rather than trust it.

The shape this repository keeps producing is a claim that was true where it was
written and is quietly false one layer up (`docs/security.md` §9). So each item
below ends with what the code actually does today, not with what the docs say
it does, and the two places where those disagreed are corrected in the same
change as this page.

| # | Recommendation | Against the docs | Against the code |
|---|---|---|---|
| 1 | Separate uids; run sessions in their own user namespace | holds | **holds, with a correction: `nomap`, not `auto`** |
| 2 | Keep the Claude refresh token out of the session | withdrawn | withdrawn; the machinery an experiment needs already exists |
| 3 | Egress allowlist via an internal network and one proxy | holds | holds; already `SEC-INJECT-2`, marked aspirational |
| 4 | Move the OAuth code exchange to the host, with PKCE | holds | holds; no `code_verifier` anywhere in the tree |
| 5 | Narrow the loopback API | holds | holds, **narrower than stated**: it has a token now, and two comments still said it did not |
| 6 | Hooks instead of pane scraping | holds, one gap | holds; only `SessionStart` is registered |
| 7 | Sudoers and `ProtectSystem` | posture gap | posture gap; the one `env_keep` is `DEBIAN_FRONTEND` |
| 8 | Replace `spawnSync` | holds | holds; the image build is the worst case |
| 9 | `IS_SANDBOX` is undocumented | new | confirmed; three sites, one of them a claim item 1 makes false |

---

## 1. Separate uids and run sessions with their own user namespace

**Claim.** The launcher passes no `--userns`, so under rootless podman the
container's root is the service user on the host: the account that owns the
Claude credential, the state directory and the socket directory.

**In the code.** `sandboxArgv` in `src/core/claude.js` builds the whole
`podman run` prefix and the only namespace-related argument in it is
`-e IS_SANDBOX=1`. `src/core/sandbox-args.js` refuses an operator-supplied
`--userns=host`, with the reason "container root IS host root", which is the
right refusal against the wrong baseline: with no flag at all, rootless
podman's default is the same `host` mapping inside the caller's namespace.
Container root is not host root, but it is the service uid, and everything
that uid can read, the session can read if it is mounted.

The installer already allocates the range a real mapping needs
(`install/install.sh`, the `usermod --add-subuids` block near line 1787), and
`RUN_USER` defaults through the unit's `User=` to `SUDO_USER`
(`install/install.sh:243`), so on a box installed by a person the service user
is that person unless `AGENT_HUB_USER` says otherwise.

`docs/security.md` records this as **SEC-SESSION-5, unverified**, and gap
**G4** as "asserted, tested only as root". This check sharpens that: the
mapping is not unknown, it is the documented default, and the sentence in
`sandbox/Containerfile` above `ENV IS_SANDBOX=1` ("its root maps to an
unprivileged host user") is true only in the sense that the service user is
not uid 0.

**The correction: `--userns=nomap`, not `--userns=auto`.** Both leave the
caller's uid unmapped, which is the property wanted. They differ in one thing
that matters here. `auto` "automatically create[s] a unique user namespace"
per container, allocating a fresh subordinate range each time. `nomap` "uses
all the subuids and subgids of the user except the user's own ID", the same
range every time. Podman chowns a named volume to the container's user only
when "the volume was not used yet". A session's two volumes,
`claude-<name>` and `work-<name>`, are the state that outlives the container
by design (`SEC-SESSION-2`), so under `auto` a resumed session comes up in a
new range and finds its own workspace and credential owned by the previous
one. The `:U` suffix would repair that on every start by walking the
workspace, which the same page warns "takes a long time" on a volume with
thousands of inodes. `nomap` needs no repair because nothing moves. Podman's
own caveat that `auto` "does not work as long as any containers exist that
were started with `--userns=nomap`" is the same fact from the other side: the
two do not mix, and this fleet should pick `nomap`.

**What it touches, which the recommendation did not enumerate.** The flag has
to go on every container that touches a session volume, or the volume's
ownership diverges between the helper that wrote it and the session that
reads it:

- `src/core/claude.js` `sandboxArgv`: the session itself.
- `src/core/podman.js` credential seeding (the `cp /seed/.credentials.json`
  run near line 810): this one also has to change shape. It bind-mounts the
  host's own `0600` credential file, which a container root mapped to a
  subordinate uid cannot open. The house-rules seeding four functions up
  already shows the fix: pipe the content in over stdin with `-i`.
- `src/core/podman.js` `volumeAccount` and the house-rules write.
- `src/core/files.js`: the file browser's helper container.
- The hook socket: `src/core/hook-socket.js` creates the directory `0700` and
  the socket `0600`, owned by the service user, and a remapped container root
  cannot connect to it. `:U` on that one bind mount chowns one inode and is
  the documented fix; the listening server keeps its descriptor regardless.

**Verdict.** Holds. It is the single change that would turn `SEC-SESSION-5`
from unverified into a property with a test: start a session, read
`/proc/self/uid_map` inside it, and assert that uid 0 maps to something other
than the service uid.

Sources: [podman `--userns`](https://github.com/containers/podman/blob/main/docs/source/markdown/options/userns.container.md),
[podman `--volume`](https://github.com/containers/podman/blob/main/docs/source/markdown/options/volume.md),
[rootless tutorial](https://github.com/containers/podman/blob/main/docs/tutorials/rootless_tutorial.md).

## 2. Keep the Claude refresh token out of the session

**Claim, withdrawn.** Remote Control needs claude.ai subscription auth and
refuses every documented scoped or rotating credential (`apiKeyHelper`,
`ANTHROPIC_AUTH_TOKEN`, `setup-token`). The only remaining shape is an
access-token-only credentials file that the host rewrites in the live volume
before expiry, and whether the CLI re-reads it mid-session is undocumented.

**In the code.** The seed is the whole file: `ensureSandboxVolumes` in
`src/core/podman.js` copies "the host's `.credentials.json` in, and nothing
else", and `src/core/claude-credential.js` reads `refreshToken` off that same
shape to decide whether a credential is `refreshable`. So the refresh token
is in every session volume today, as the review assumed.

What the review did not have in front of it is that two of the three moving
parts for its experiment are built:

- `refreshSeededCredentials` (`src/core/podman.js`, near line 599) already
  rewrites a volume's credential from the host copy, on resume, for the
  account the volume already belongs to.
- `src/core/keepalive.js` already keeps the host copy fresh on an idle box,
  and reads its verdict from whether the expiry in the file **moved** rather
  than from an exit code, which is exactly the measurement the experiment
  needs.

The missing part is the rewrite happening while the container is running and
the CLI noticing. That is one function and one test, and the pass condition
is the same one `keepalive.js` already uses: a session whose seeded file
carried no refresh token keeps making requests after the access token it
started with has expired.

**Verdict.** Withdrawn as a plan; stands as an experiment with a clear pass
condition and most of its parts on the shelf.

Sources: [Authentication](https://code.claude.com/docs/en/iam),
[Remote Control](https://code.claude.com/docs/en/remote-control).

## 3. Egress allowlist via an internal network and one proxy container

**Claim.** `--internal` removes the default route rather than installing a
firewall, so a proxy container on both the internal and default networks is
the only path out, and the allowlist has to live in the proxy.

**In the code.** `sandboxArgv` sets no `--network` at all, which
`docs/security.md` already states as **SEC-SESSION-4**, "egress is open by
design today", and the proxy shape is **SEC-INJECT-2**, marked
**ASPIRATIONAL**. Every helper container that touches a volume already runs
`--network none` (`src/core/files.js`, the house-rules write, the image
probe), so they are unaffected. `src/core/sandbox-args.js` refuses
`--network=host`; an operator adding `--network=<internal>` through
`AGENT_HUB_SANDBOX_ARGS` passes that check, which is correct.

One thing the review's precision implies and the code will need: the session
has to be told about the proxy. Inside the container that is `HTTPS_PROXY`
and a CA bundle, and nothing in `sandbox/Containerfile` or
`sandbox/entrypoint.sh` sets either today.

**Verdict.** Holds, and is already on the books as aspirational. Nothing here
contradicts the spec; this page adds the routing-not-firewall precision and
the proxy-variable gap to it.

Sources: [podman-network-create](https://docs.podman.io/en/latest/markdown/podman-network-create.1.html),
[podman `--network`](https://github.com/containers/podman/blob/main/docs/source/markdown/options/network.md),
[discussion #21451](https://github.com/containers/podman/discussions/21451).

## 4. Move the OAuth code exchange to the host, with PKCE

**Claim.** GitHub's exchange binds nothing to the server that received the
callback; with PKCE, a coordinator that captured the code cannot exchange it
even though it holds the client secret.

**In the code.** The exchange is on the coordinator:
`src/fleet/coordinator/oauth.js` posts `client_id`, `client_secret`, `code`
and an explicit `redirect_uri` to `github.com/login/oauth/access_token` near
line 199, and does the same against Cloudflare near line 271. There is no
`code_challenge` on either authorize URL and no `code_verifier` in the tree.
The host already performs the **refresh** with the client secret it received
on the config frame (`src/core/connectors.js`, near line 310;
`src/fleet/protocol/config-frame.js` field `githubClientSecret`), so the
host holding the secret is settled and the exchange moving there changes
nothing about custody. What it changes is what a compromised coordinator
sees at link time: today the access and refresh tokens, afterwards only a
code it cannot spend.

Cloudflare's endpoint is treated as RFC 6749 form-encoded and was not
re-verified against Cloudflare's own documentation here either.

**Verdict.** Holds. The verifier lives on the host, the challenge rides the
`link` intent's URL, and the code comes back over the socket the coordinator
already relays on.

Sources: [Generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

## 5. Narrow the loopback API

**Claim.** `src/adapters/http.js` runs any line posted to `/api/command`, and
`src/fleet/host/sidecar.js` builds that line in `toCommandLine`.

**In the code.** Both true. What the review did not have is gap **G6** in
`docs/security.md`, marked fixed: the loopback API always has a token now,
generated into `${stateDir}/api-token` and read by the sidecar, and
`#authorised` in `http.js` fails closed when there is none. So "reaching it"
is no longer enough; holding the token is. That narrows the recommendation
without dissolving it: a process with the token can run any line, and the
sidecar's verb allowlist (**SEC-PROTO-2**) is enforced in the sidecar, one
hop before this endpoint. The narrowing that remains is a verb allowlist on
the endpoint itself, matching the shapes `toCommandLine` can emit.

**Two comments were still describing the old API.** The header of
`src/adapters/http.js` said the loopback bind needed no token because
reaching it "already means shell access", and the `--network=host` refusal
in `src/core/sandbox-args.js` called the port "the hub's own unauthenticated
loopback API". Both are corrected in this change; the refusal itself stands,
because handing a session a route to the port is still handing it a target.

**Verdict.** Holds, narrower than stated.

## 6. Hooks instead of pane scraping

**Claim.** `Stop`, `StopFailure`, `SessionEnd`, `PermissionRequest` and
`Notification` all deliver `session_id`, `transcript_path`, `cwd` and
`permission_mode` on stdin, the shape `sandbox/hook.mjs` already consumes.
The resume dialog appears before any hook can fire.

**In the code.** `sandbox/entrypoint.sh` registers exactly one hook,
`SessionStart` (the `settings.hooks.SessionStart` block near line 87), and
`sandbox/hook.mjs` posts `{uuid, cwd, title}` to the per-session socket.
Everything else about a session's state is read off the pane:
`verifyRemoteControl` and `diagnoseRc` in `src/core/claude.js`, the idle and
prompt detection in `src/fleet/host/pane.js` and `src/core/pane.js`, and the
log reader in `src/core/logs.js`. The socket transport, the identity
argument (`docs/hook-socket.md`: the container names nothing, the socket is
the name) and the always-exit-0 discipline all carry over unchanged to a
second and third hook.

The gap is real and is item 2 of `src/core/claude.js`: the resume dialog
blocks before the CLI has a session, so `waitForResumeDialog` stays a pane
read.

**Verdict.** Holds, with the one gap.

Source: [Hooks reference](https://code.claude.com/docs/en/hooks).

## 7. Sudoers and `ProtectSystem`

**Claim, downgraded.** `APT_CONFIG` was the attack, but sudoers' default
`env_reset` never lets it reach apt. What remains is that
`install/agent-hub.service` sets `ProtectSystem=no` because the sudo'd
upgrade inherits the unit's mount namespace.

**In the code.** The unit says so at length: `ProtectSystem=no` at line 91,
the walk through `full`, `+ReadWritePaths=/etc` and `true` each failing on
the next protected path, and the oneshot-unit shape as "the right shape and
it is not built". `write_upgrade_sudoers` in `install/install.sh` (near line
694) adds one `env_keep`, and it is `DEBIAN_FRONTEND` for `/usr/bin/apt-get`
only, which does not reopen the `APT_CONFIG` path. The grant names three
exact `apt-get` lines; the two `-o` options in the third are `Dpkg::Options`
and not an apt configuration file. The sidecar's unit keeps
`ProtectSystem=full`, so the gap is one unit, not the host.

**Verdict.** Posture gap, as downgraded. The oneshot unit is the fix and the
unit's own comment already specifies it.

Sources: [sudoers(5)](https://man7.org/linux/man-pages/man5/sudoers.5.html),
[apt.conf(5)](https://manpages.debian.org/bookworm/apt/apt.conf.5.en.html),
[systemd.exec(5)](https://man7.org/linux/man-pages/man5/systemd.exec.5.html).

## 8. Replace `spawnSync`

**Claim.** Every podman and tmux call is synchronous.

**In the code.** `src/core/tmux.js` wraps `spawnSync` once and every tmux
command goes through it; `src/core/podman.js` does the same for podman, plus
the image build near line 285 with a build-length timeout. `src/core/keepalive.js`
uses it too. `verifyRemoteControl` sleeps asynchronously between polls, but
each `capturePane` inside the loop is a synchronous spawn, and the HTTP
adapter, the sidecar's socket and every other session's watcher share that
event loop.

The image build is the case to lead with. Its comment says it "blocks the
session that asked for it, which is the point". It blocks the process: for
the minutes a build takes, `/api/state` does not answer, the sidecar's health
frame does not go out, and the coordinator reports the host as it would a
dead one. The comment is true of the person waiting and false of the box.

**Verdict.** Holds. The two wrappers are the whole surface, which makes it a
contained change.

Source: [child_process](https://nodejs.org/api/child_process.html).

## 9. `IS_SANDBOX` is undocumented

**Claim, new.** The root refusal is real, the bypass is in no Anthropic
document, and the tracking issue that names both `IS_SANDBOX` and
`CLAUDE_CODE_BUBBLEWRAP` as undocumented was closed as not planned.
`DISABLE_AUTOUPDATER` is not in the settings reference either.

**In the code.** Three sites set `IS_SANDBOX=1`: the outer `exec` in
`buildCommand` (`src/core/claude.js:65`), the `-e` inside `sandboxArgv`
(line 100, "found by running it, not by reading it"), and
`sandbox/Containerfile:180`. `DISABLE_AUTOUPDATER=1` is at
`sandbox/Containerfile:192`, and `diagnoseRc` in `claude.js` still carries
the detector for the failure it prevents, which is the right order: the pin
is unofficial, so the symptom stays recognisable.

The Containerfile's justification for the flag, "under rootless podman its
root maps to an unprivileged host user", is the sentence item 1 is about.

**Verdict.** Confirmed. The whole launch path rests on a flag Anthropic has
not committed to. The mitigation that does not depend on Anthropic is item 1:
once container root is not the service user, the flag stops being asked to
carry a claim and becomes only a bypass.

Source: [anthropics/claude-code#58150](https://github.com/anthropics/claude-code/issues/58150).

---

## What changed with this page

- `src/adapters/http.js` header and `src/core/sandbox-args.js`: the two
  comments that still described the loopback API as untokened (item 5).
- `docs/security.md` gap **G4**: one sentence recording that the default
  mapping is known, not merely unverified (item 1).

Nothing else. Items 1, 3, 4, 6 and 8 are each a host-layer change with its own
test and its own pull request, in the order this page lists them.
