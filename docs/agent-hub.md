# agent-hub — the session manager

> **This is the upstream agent-hub README, kept as the session manager's manual.**
> Commands, permission modes, resume behaviour and the web UI below are all
> current.
>
> **What is NOT current, and is upstream's rather than ours:** the *Install*
> section (it clones the upstream repo — use [`deployment.md`](./deployment.md)
> or the ten-step [`first-session.md`](./first-session.md)), and any version or
> dependency claim on this page. A beta tester found node "18+" here against
> `>= 24` in two other files and could not tell which to believe.
>
> The rule for this file: **if a statement is about how to install or what to
> install, it is upstream's and this repository's own docs win.** Provenance and
> divergences: [`upstream-agent-hub.md`](./upstream-agent-hub.md).

Start, resume and stop **Claude Code** sessions on a box you own — from Telegram
or a browser, without SSH.

Each session is a `claude` process in its own tmux window with permission
checks bypassed and Remote Control on, so you can pick it up from
claude.ai/code. Sessions survive a hub restart and come back after a reboot,
resuming *the same conversation* rather than starting over.

It also logs the box into your Claude account for you, so a freshly built
machine never needs a terminal.

```
  Telegram ──long poll──▶ ┌──────────────────────┐
  Browser  ──── HTTP ───▶ │      agent-hub       │──▶ tmux ──▶ claude --resume
  CLI      ──────────────▶└──────────────────────┘
                             state: one JSON file
```

**Dependencies: `node` (>= 24 — see below), `tmux`, `claude`.**

> **Upstream said 18+.** `package.json` in this repository requires `>= 24` and
> that is the number to believe; the installer installs it. A beta tester found
> three different answers across three files and could not tell which was real.
 No database, no build step, no
npm install, no cloud account. Clone it and run it.

---

## Why Telegram

`getUpdates` long polling is **outbound only**. The box needs no public
hostname, no inbound firewall rule, no TLS certificate and no tunnel — it works
the same on a datacentre VM, a laptop behind NAT, or a Pi on home wifi. That is
what makes this shareable: a coworker can stand up their own instance in about
five minutes with nothing but a bot token.

The web UI is there when you want to *see* everything at once. Expose it with a
Cloudflare Tunnel (below) or leave it on loopback and use Telegram.

---

## Install

```sh
git clone https://github.com/ambersecurityinc/agent-hub /opt/agent-hub
sudo /opt/agent-hub/install/install.sh
```

The installer checks prerequisites, creates `/etc/agent-hub.env`, installs the
systemd unit, registers the Claude Code **SessionStart hook**, and links the
`agent-hub` CLI. It is idempotent — re-run it after `git pull`, and it will
never overwrite your config.

Then:

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the token
   into `AGENT_HUB_TELEGRAM_TOKEN` in `/etc/agent-hub.env`.
2. `systemctl enable --now agent-hub`
3. Message your bot **`/whoami`** — it answers with your Telegram id even before
   you are allowed. Put that id in `AGENT_HUB_TELEGRAM_ALLOWED_USERS`, then
   `systemctl restart agent-hub`.
4. `agent-hub doctor` to confirm the box can actually run sessions.

Not logged into Claude yet? Send the bot **`/login`** and follow the link.

---

## Commands

Identical in Telegram, the web UI and the CLI — they all go through one
dispatcher, so nothing can work in one surface and be missing from another.

| Command | What it does |
|---|---|
| `/new [name] [path] [--safe] [--profile=<name>]` | Start a session. Name optional, path defaults to the workdir. **Without a profile it comes up idle** — waiting for a person, not working. |
| `/profiles` | The task profiles on this box. Each is a `<name>.md` file under `AGENT_HUB_PROFILE_DIR`; its content becomes a new session's first message. Adding one needs a shell here, which is what stops a coordinator from writing a session's instructions. |
| `/resume <name> [summary\|full]` | Bring a stopped session back **with its conversation**. |
| `/stop <name>` | Stop it. The conversation is kept so `/resume` still works. |
| `/list` | Everything — running and resumable. |
| `/status [name]` | Hub health, or one session's detail. |
| `/forget <name>` | Stop it *and* erase the record. No longer resumable. |
| `/update [--restart]` | Pull the latest code onto this box. `--restart` applies it; sessions keep running. |
| `/login` | Log this box into a Claude account. `/login console`, `/login status`, `/login logout`, `/login cancel`. |
| `/code <value>` | Send back the authorization code from the login page. |
| `/whoami` | The id this hub sees you as — what goes in the allowlist. |

From the shell: `agent-hub list`, `agent-hub new mysession`, and so on.

**In Telegram you rarely type any of this.** The bot registers its command list
with Telegram at startup, so typing `/` autocompletes every command with a
description, and the chat's menu button lists them. Commands that need a
session name offer the matching sessions as buttons when you leave it off —
`/stop` on its own asks *which*, `/list` puts Stop and Resume next to each
session, and a resume that needs a decision offers both options as taps.

### Permission mode

Sessions launch with `--dangerously-skip-permissions` by default
(`AGENT_HUB_SKIP_PERMISSIONS`), because an unattended session that stops for a
permission prompt is a hung session. Override it for one session without
touching the global default:

```
/new scratch --safe        # permission prompts stay ON for this session
/new deploy --dangerous    # bypass them, even if the global default is safe
```

The choice is **recorded against the session**, so every later `/resume` and
every boot restore runs it the same way. A session you deliberately started in
safe mode never gets quietly promoted.

### Choosing how to resume

On a large or stale conversation, `claude --resume` wants to know whether to
resume from a summary or in full — the second can consume a serious share of a
usage limit. By default agent-hub **shows you the dialog and waits**:

```
> /resume bigjob

"bigjob" is waiting for you to choose how to resume.

This session is 6d 12h old and 347.8k tokens.

  1. Resume from summary (recommended)
  2. Resume full session as-is

/resume bigjob summary   — resume from a summary (recommended, cheapest)
/resume bigjob full      — resume the full conversation as-is
```

Answer with a tap, or by naming the mode up front (`/resume bigjob full`). Set
`AGENT_HUB_RESUME_CHOICE=summary|full` to stop being asked. A session left
waiting takes the summary option after
`AGENT_HUB_RESUME_ASK_TIMEOUT_MS` (10 minutes) rather than hanging forever.

Boot restore never asks — nobody is present at 3am — and uses
`AGENT_HUB_RESUME_CHOICE_UNATTENDED`, which defaults to `summary`.

---

## The three things that make resume actually work

Each of these cost a real outage on the fleet this was extracted from, and none
are obvious from the CLI's help text.

**1. `--resume` does not always resume.** On a large or stale conversation,
`claude` shows a blocking dialog *first* — "Resume from summary (recommended) /
Resume full session as-is" — and waits forever for a keypress nobody sends. An
unattended restore therefore fails silently for exactly the long-running
sessions it exists to protect; one sat at that dialog for two days, alive in
tmux and doing nothing. agent-hub watches the pane and answers **only when the
dialog is actually on screen**, so a session that resumed cleanly never receives
a stray Enter into a live conversation.

**2. Never `--continue`.** In a shared working directory, `--continue` resumes
*that directory's* most recent conversation. Restoring several sessions that way
makes every one of them attach to the same conversation. agent-hub resumes by
uuid or refuses — a session with no recorded uuid is reported as unresumable
rather than quietly collided.

**3. Remote Control fails silently.** The tmux pane is alive, but shows a plain
prompt with no RC status line, so whoever asked for the session can never reach
it. agent-hub polls for the status line and re-issues `/remote-control` once
before giving up.

The uuid itself comes from the **SessionStart hook**: Claude hands it the real
`session_id` and transcript path, so what gets recorded is authoritative rather
than scraped off a command line. If the hub happens to be restarting, the hook
spools to disk and the hub drains it on the next pass — a restart window costs
latency, never a lost conversation.

---

## Exposing the web UI

Keep the port on loopback and put a tunnel in front, so it never listens on a
routable interface:

```sh
cloudflared tunnel create agent-hub
cloudflared tunnel route dns agent-hub hub.example.com
# ingress: hostname hub.example.com -> service http://127.0.0.1:8790
```

Set `AGENT_HUB_TOKEN` (`openssl rand -hex 24`) whenever the UI is reachable by
anyone but you. Visit `https://hub.example.com/?token=…` once and the browser
remembers it. Cloudflare Access in front of that is worth the ten minutes.

Binding to anything other than loopback **without** a token is refused at
startup — that combination is remote shell access for anyone who can route to
the port.

---

## Security

Read this before you add the second name to the allowlist.

- A session is **unsupervised shell access on this box**, running as the hub's
  user with `--dangerously-skip-permissions`. Everyone on
  `AGENT_HUB_TELEGRAM_ALLOWED_USERS` has that. Treat the allowlist as a root
  allowlist, because that is what it is.
- `/login` can point the box at a Claude account, and the authorization URL is
  visible to whoever asked. It is not a lesser permission than starting a
  session — set `AGENT_HUB_LOGIN=0` if you want authentication to require SSH.
- The hook endpoint (`/internal/session-start`) is loopback-only and never
  token-gated: it runs as a child of a `claude` process on this same box, and
  requiring the operator token would mean writing that token into a
  world-readable hook script.
- Session names are charset-restricted (`[A-Za-z0-9_-]{1,40}`) and every tmux
  call is an argv array — a name can never become a command.
- `/etc/agent-hub.env` is `0600` and holds your bot token. The state file holds
  conversation uuids, not conversations.

---

## Adding another chat platform

The portability seam is `src/adapters/`. An adapter does exactly two things:
turn an incoming message into a command line, and render the reply. It does not
implement commands — `src/adapters/commands.js` owns those, and every surface
shares it.

```js
import { dispatch } from './commands.js';

const reply = await dispatch(
  { sessions, login, cfg, actor: 'slack:U123' },
  '/resume mysession',
);
await postToSlack(channel, reply.text);
```

`src/adapters/telegram.js` is ~200 lines and is the model to copy. Slack and
WhatsApp are each one file; nothing in `src/core/` needs to change.

Commands are equally cheap to add — one entry in `COMMANDS`. The pane is
already readable via `sessions.peek(name)`, so a two-way `/send` and `/read`
pair is a small addition when launcher-only stops being enough.

---

## Layout

```
bin/agent-hub          CLI: serve · doctor · hook · any command
src/index.js           wiring: config → core → adapters → restore
src/config.js          every environment variable, in one place
src/core/
  sessions.js          the session manager — start/resume/stop/reconcile/restore
  claude.js            RC verification, the resume dialog, why never --continue
  login.js             `claude auth login` driven from chat
  registry.js          the JSON state file (atomic writes; records outlive tmux)
  tmux.js              the only place that shells out to tmux
  trust.js             pre-trusting the workdir so sessions skip the trust prompt
  names.js             session-name charset
src/adapters/
  commands.js          the shared command registry — add commands here
  telegram.js          long-poll adapter
  http.js              web UI + JSON API + the SessionStart hook endpoint
src/web/index.html     the UI (one file, no framework)
install/               install.sh, the systemd unit, the annotated env template
```

---

## Operating it

```sh
systemctl status agent-hub
journalctl -u agent-hub -f
agent-hub doctor
agent-hub list
```

**Restarting the hub does not touch your sessions.** The unit sets
`KillMode=process` specifically for that: the tmux server lives in the unit's
cgroup, and with systemd's default a plain `systemctl restart` reaps the whole
cgroup and kills every live session at once. Do not remove that line.

To upgrade: `git -C /opt/agent-hub pull && sudo /opt/agent-hub/install/install.sh
&& systemctl restart agent-hub`. Sessions keep running throughout.

---

## Prior art

Extracted from the Chavivim agent fleet, where the same job was done by a
Cloudflare Worker holding a request queue in D1 plus a polling daemon on the
box. That split needed a heartbeat protocol, a stale-row reaper and a webhook
nudge to stay cheap — all of which exist only because two planes can disagree
about what is running.

Here the process that decides and the process that acts are the same process,
so tmux is simply asked, every time. What survived the port is the hard-won
part: the resume dialog, the `--continue` collision, the silent Remote Control
failure, `KillMode=process`, and counting *every* session against the cap rather
than only the ones the tool started.

---

MIT.
