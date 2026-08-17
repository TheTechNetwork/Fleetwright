#!/usr/bin/env bash
# agent-fleet installer — the whole thing, in one script.
#
#   git clone https://github.com/TheTechNetwork/agent-fleet /opt/agent-fleet
#   sudo /opt/agent-fleet/install/install.sh
#
# Sets up both halves: the session manager (systemd service, SessionStart hook,
# CLI) and the fleet sidecar (config, CLI). There is nothing else to run and
# nothing to hand-copy between files.
#
# Idempotent: re-run it after `git pull` to pick up changes. It never overwrites
# /etc/agent-hub.env or /etc/agent-fleet-sidecar.env once those exist, so your
# tokens and allowlist survive every upgrade.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/agent-hub.env
SIDECAR_ENV=/etc/agent-fleet-sidecar.env
UNIT=/etc/systemd/system/agent-hub.service
RUN_USER="${AGENT_HUB_USER:-${SUDO_USER:-$(id -un)}}"
# Resolved once, up here, because finding node depends on it — sudo hides
# anything a version manager put in this directory.
USER_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
USER_HOME="${USER_HOME:-$HOME}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  warn %s\n' "$*"; }
die()  { printf '\n  FAIL %s\n\n' "$*" >&2; exit 1; }

# --check verifies the prerequisites and changes nothing. Worth having as a
# first step on a box you are not sure about, rather than finding out halfway
# through that node is invisible to sudo.
CHECK_ONLY=0
case "${1:-}" in
  --check|-n) CHECK_ONLY=1 ;;
  '') ;;
  *) die "unknown argument: $1 (only --check is accepted)" ;;
esac

say "agent-fleet installer${CHECK_ONLY:+}"
printf '  source : %s\n  user   : %s\n' "$DIR" "$RUN_USER"
[ "$CHECK_ONLY" = 1 ] && printf '  mode   : --check (nothing will be changed)\n'

# --- 1. prerequisites -------------------------------------------------------
say "Checking prerequisites"

# Finding node is not as simple as `command -v`, and the reason has bitten every
# operator who installs it the normal way. `sudo` replaces PATH with sudoers'
# secure_path — typically /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# — so a node installed by nvm, fnm, volta, asdf or into ~/.local/bin is
# invisible to this script even though `node -v` works perfectly in the shell
# the operator just ran `sudo` from. The old check reported "node is not
# installed" at somebody with a working Node 24.
#
# This is the same trap already documented below for `claude`, so it gets the
# same treatment: ask the run user's own login shell, then look where the
# common installers actually put things.
NODE_BIN="$(
  command -v node 2>/dev/null && exit 0
  # The login shell of whoever invoked sudo — this is what picks up nvm's and
  # asdf's shell functions and shims.
  sudo -u "$RUN_USER" -H bash -lc 'command -v node' 2>/dev/null && exit 0
  for candidate in \
      /usr/local/bin/node /usr/bin/node /snap/bin/node \
      "$USER_HOME/.local/bin/node" "$USER_HOME/.volta/bin/node" "$USER_HOME/.asdf/shims/node" \
      /home/linuxbrew/.linuxbrew/bin/node; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; exit 0; }
  done
  # nvm and fnm keep one directory per version; take the newest.
  for root in "$USER_HOME/.nvm/versions/node" "$USER_HOME/.local/share/fnm/node-versions" "$USER_HOME/.fnm/node-versions"; do
    [ -d "$root" ] || continue
    newest="$(ls -1d "$root"/*/bin/node "$root"/*/installation/bin/node 2>/dev/null | sort -V | tail -1)"
    [ -n "$newest" ] && [ -x "$newest" ] && { printf '%s\n' "$newest"; exit 0; }
  done
  exit 1
)" || die "node was not found — not on this PATH, not in $RUN_USER's login shell, and not in the usual
       install locations (nvm, fnm, volta, asdf, ~/.local/bin, /usr/local/bin).

       If \`node -v\` works for you but this failed, that is sudo's secure_path
       hiding it. Either install node system-wide, or re-run telling the script
       where it is:
           sudo AGENT_HUB_NODE_BIN=\$(command -v node) $0"

# An explicit override always wins, for the case none of the above finds it.
NODE_BIN="${AGENT_HUB_NODE_BIN:-$NODE_BIN}"
[ -x "$NODE_BIN" ] || die "AGENT_HUB_NODE_BIN=$NODE_BIN is not an executable file."

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "could not read a version from $NODE_BIN — is it really node?" ;;
esac
[ "$NODE_MAJOR" -ge 18 ] || die "node $NODE_MAJOR at $NODE_BIN is too old — this needs 18 or newer (it uses global fetch)."
ok "node $("$NODE_BIN" -v) at $NODE_BIN"

# The systemd unit hardcodes this path. A node inside the operator's home is
# usually nvm's, and `nvm install` / `nvm uninstall` moves or removes it —
# which takes the service down at the next restart, long after the change that
# caused it. Worth saying out loud rather than discovering months later.
case "$NODE_BIN" in
  "$USER_HOME"/*)
    warn "$NODE_BIN is inside $RUN_USER's home — the systemd unit will point at it."
    warn "  A version-manager upgrade will move it and the service will fail to start."
    warn "  Consider a system-wide node: apt install nodejs, or n/nodesource."
    ;;
esac

command -v tmux >/dev/null || die "tmux is not installed. Try: apt install -y tmux"
ok "tmux $(tmux -V | awk '{print $2}')"

# claude may legitimately be missing at this point — agent-hub can install
# nothing for you, but it CAN log you in once it is running, so this is a
# warning rather than a hard stop.
CLAUDE_HOME="$USER_HOME"

# Look where the official installer actually puts it, not only on PATH. A login
# shell does NOT necessarily see ~/.local/bin: Debian's stock ~/.bashrc returns
# early for non-interactive shells, so the PATH line the Claude installer adds
# there never runs for the `bash -lc` that launches sessions. agent-hub resolves
# an absolute path at startup (src/core/which.js) so this cannot bite it — but
# report accurately here either way.
CLAUDE_BIN=""
for candidate in "$CLAUDE_HOME/.local/bin/claude" /usr/local/bin/claude /usr/bin/claude "$CLAUDE_HOME/.claude/local/claude"; do
  [ -x "$candidate" ] && { CLAUDE_BIN="$candidate"; break; }
done
[ -z "$CLAUDE_BIN" ] && CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"

if [ -n "$CLAUDE_BIN" ]; then
  ok "claude $("$CLAUDE_BIN" --version 2>/dev/null | head -1) at $CLAUDE_BIN"
  if "$CLAUDE_BIN" auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then
    ok "claude is logged in"
  else
    warn "claude is NOT logged in — once the service is up, run 'agent-hub login' or send /login in Telegram"
  fi
  # Put it on the login-shell PATH too, so an operator who SSHes in and types
  # `claude` gets the same binary agent-hub uses.
  if ! sudo -u "$RUN_USER" -H bash -lc 'command -v claude' >/dev/null 2>&1; then
    BIN_DIR="$(dirname "$CLAUDE_BIN")"
    PROFILE="$CLAUDE_HOME/.profile"
    if ! grep -qF "$BIN_DIR" "$PROFILE" 2>/dev/null; then
      printf '\n# added by agent-hub install.sh\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$PROFILE"
      ok "added $BIN_DIR to $PROFILE (it was missing from the login-shell PATH)"
    fi
  fi
else
  warn "claude was not found. Install it before starting sessions:"
  warn "  curl -fsSL https://claude.ai/install.sh | bash"
fi

# The sandbox is optional, so a missing podman is a note rather than a failure.
if command -v podman >/dev/null; then
  ok "podman $(podman --version | awk '{print $3}') — the sandbox is available"
  HAVE_PODMAN=1
else
  warn "podman is not installed — sessions will run directly on this box, not sandboxed"
  warn "  apt install -y podman   (then re-run to build the sandbox image)"
  HAVE_PODMAN=0
fi

if [ "$CHECK_ONLY" = 1 ]; then
  say "Prerequisites look fine. Nothing was changed — re-run without --check to install."
  exit 0
fi

# --- 2. state directory -----------------------------------------------------
say "Creating state directory"
STATE_DIR="${AGENT_HUB_STATE_DIR:-/var/lib/agent-hub}"
install -d -o "$RUN_USER" -m 0750 "$STATE_DIR"
ok "$STATE_DIR"

# --- 3. environment file ----------------------------------------------------
say "Configuration"
if [ -f "$ENV_FILE" ]; then
  ok "$ENV_FILE already exists — left untouched"
else
  install -m 0600 "$DIR/install/agent-hub.env.example" "$ENV_FILE"
  ok "wrote $ENV_FILE from the template"
  warn "EDIT IT before starting: set AGENT_HUB_TELEGRAM_TOKEN and AGENT_HUB_TELEGRAM_ALLOWED_USERS"
fi

# --- 3b. sidecar configuration ----------------------------------------------
# Pre-filled from the session manager's own config, because the hub URL and
# token MUST agree between the two and hand-copying a secret between files is
# exactly the step people get wrong.
say "Configuring the fleet sidecar"
if [ -f "$SIDECAR_ENV" ]; then
  ok "$SIDECAR_ENV already exists — left untouched"
else
  SIDECAR_ENV="$SIDECAR_ENV" HUB_ENV="$ENV_FILE" \
  TEMPLATE="$DIR/install/agent-fleet-sidecar.env.example" "$NODE_BIN" <<'NODE'
const fs = require('fs');

// Read the hub's env the way systemd does: KEY=value, one per line, one layer
// of surrounding quotes stripped. Done in node rather than sed so a token
// containing & or | cannot corrupt the substitution.
const hub = {};
try {
  for (const raw of fs.readFileSync(process.env.HUB_ENV, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    hub[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* no hub env yet — defaults below are right anyway */ }

// 0.0.0.0 and :: are bind addresses, not addresses to dial.
let bind = hub.AGENT_HUB_BIND || '127.0.0.1';
if (bind === '0.0.0.0' || bind === '::' || bind === '') bind = '127.0.0.1';
const port = hub.AGENT_HUB_PORT || '8790';

const filled = {
  AGENT_FLEET_HUB_URL: `http://${bind}:${port}`,
  AGENT_FLEET_HUB_TOKEN: hub.AGENT_HUB_TOKEN || '',
  // stdio is the only transport implemented, and this is a local placeholder
  // rather than a real remote origin — but the sidecar still refuses to start
  // without one, so filling it in keeps a fresh box working out of the box.
  AGENT_FLEET_COORDINATOR_URL: 'stdio:local',
};

const out = fs
  .readFileSync(process.env.TEMPLATE, 'utf8')
  .split('\n')
  .map((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    return m && m[1] in filled ? `${m[1]}=${filled[m[1]]}` : line;
  })
  .join('\n');

fs.writeFileSync(process.env.SIDECAR_ENV, out, { mode: 0o600 });
console.log(`  ok   wrote ${process.env.SIDECAR_ENV} (hub URL and token copied from ${process.env.HUB_ENV})`);
NODE
  chmod 0600 "$SIDECAR_ENV"
fi

# --- 4. systemd unit --------------------------------------------------------
say "Installing the systemd unit"
sed -e "s|__USER__|$RUN_USER|g" \
    -e "s|__DIR__|$DIR|g" \
    -e "s|__NODE__|$NODE_BIN|g" \
    "$DIR/install/agent-hub.service" > "$UNIT"
chmod 0644 "$UNIT"
ok "$UNIT"

# The tmux server must outlive the login session that spawned it, or every
# session dies when the operator logs out.
if command -v loginctl >/dev/null; then
  loginctl enable-linger "$RUN_USER" 2>/dev/null && ok "lingering enabled for $RUN_USER" \
    || warn "could not enable lingering for $RUN_USER — sessions may not survive logout"
fi

systemctl daemon-reload
ok "systemd reloaded"

# --- 5. the SessionStart hook ----------------------------------------------
# This is what makes resume reliable: Claude hands the hook its own session id
# and transcript path, so the conversation uuid agent-hub records is
# authoritative rather than guessed.
say "Installing the Claude Code SessionStart hook"
SETTINGS="${CLAUDE_HOME:-$HOME}/.claude/settings.json"
install -d -o "$RUN_USER" -m 0755 "$(dirname "$SETTINGS")"
HOOK_CMD="$DIR/bin/agent-hub hook"

# Merged with node rather than sed: settings.json holds the operator's own
# hooks, theme and permissions, and a text-level edit would eventually eat one.
SETTINGS="$SETTINGS" HOOK_CMD="$HOOK_CMD" "$NODE_BIN" <<'NODE'
const fs = require('fs');
const file = process.env.SETTINGS;
const cmd = process.env.HOOK_CMD;

let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (e) {
  if (e.code !== 'ENOENT') {
    console.error(`  FAIL ${file} is not valid JSON — fix it and re-run. Nothing was changed.`);
    process.exit(1);
  }
}

settings.hooks ||= {};
settings.hooks.SessionStart ||= [];

let dirty = false;

const already = JSON.stringify(settings.hooks.SessionStart).includes(cmd);
if (already) {
  console.log('  ok   SessionStart hook already installed');
} else {
  // Append as its own matcher group. Any hook already there is someone else's
  // and keeps working — Claude runs every group.
  settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: cmd }] });
  console.log(`  ok   added SessionStart hook to ${file}`);
  dirty = true;
}

// First-run defaults. Only set when the key is ABSENT — an operator who has
// deliberately turned one of these off keeps their choice on every re-run.
const defaults = {
  // Remote Control on by default, so a session is drivable from claude.ai/code
  // the moment it starts. agent-hub also passes --remote-control per session;
  // this makes it the default for sessions started by hand on this box too.
  remoteControlAtStartup: true,
  // agent-hub launches with --dangerously-skip-permissions. Without this, the
  // first such session stops at a one-time confirmation prompt that nobody is
  // there to answer — the exact silent hang this tool exists to prevent.
  skipDangerousModePermissionPrompt: true,
};
for (const [key, value] of Object.entries(defaults)) {
  if (settings[key] === undefined) {
    settings[key] = value;
    console.log(`  ok   set ${key} = ${value} (first-run default)`);
    dirty = true;
  } else {
    console.log(`  ok   ${key} already set to ${JSON.stringify(settings[key])} — left alone`);
  }
}

if (dirty) {
  const tmp = `${file}.tmp-agent-hub`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
NODE
chown "$RUN_USER" "${CLAUDE_HOME:-$HOME}/.claude/settings.json" 2>/dev/null || true

# --- 5b. the sandbox image --------------------------------------------------
# Built here rather than left as a documented step, because a sandbox that is
# switched on with no image is a session that dies the instant it starts.
if [ "$HAVE_PODMAN" = "1" ] && [ "${AGENT_FLEET_BUILD_IMAGE:-1}" != "0" ]; then
  say "Building the sandbox image"
  if podman image exists agent-session:latest && [ "${AGENT_FLEET_REBUILD_IMAGE:-0}" != "1" ]; then
    ok "agent-session:latest already built — AGENT_FLEET_REBUILD_IMAGE=1 to rebuild"
  elif podman build -t agent-session:latest -f "$DIR/sandbox/Containerfile" "$DIR/sandbox" >/tmp/agent-session-build.log 2>&1; then
    ok "agent-session:latest"
  else
    warn "image build failed — see /tmp/agent-session-build.log. The sandbox stays off until it succeeds."
  fi
fi

# --- 5c. coordinator configuration ------------------------------------------
say "Configuring the coordinator"
COORD_ENV=/etc/agent-fleet-coordinator.env
if [ -f "$COORD_ENV" ]; then
  ok "$COORD_ENV already exists — left untouched"
else
  install -m 0600 "$DIR/install/agent-fleet-coordinator.env.example" "$COORD_ENV"
  ok "wrote $COORD_ENV from the template"
fi

# --- 6. CLIs on PATH --------------------------------------------------------
say "Linking the CLIs"
for cli in agent-hub agent-fleet-sidecar agent-fleet-coordinator; do
  [ -f "$DIR/bin/$cli" ] || continue
  ln -sf "$DIR/bin/$cli" "/usr/local/bin/$cli"
  chmod +x "$DIR/bin/$cli"
  ok "/usr/local/bin/$cli -> $DIR/bin/$cli"
done

# --- done -------------------------------------------------------------------
say "Installed."
cat <<EOF

Next:

  1. Create a Telegram bot — message @BotFather, /newbot — and put the token in:
       $ENV_FILE

  2. Start the session manager:
       systemctl enable --now agent-hub
       journalctl -u agent-hub -f

  3. Message your bot /whoami, put the id it replies with into
     AGENT_HUB_TELEGRAM_ALLOWED_USERS in $ENV_FILE, then:
       systemctl restart agent-hub

  4. Check the box is ready:
       agent-hub doctor

  If claude is not logged in yet, send your bot /login and follow the link.

To run the fleet as well (a coordinator plus this box as a host):

  5. Start a coordinator — on this box for a single-machine test, or wherever
     the fleet should meet:
       agent-fleet-coordinator

  6. Point the sidecar at it in $SIDECAR_ENV:
       AGENT_FLEET_COORDINATOR_URL=http://127.0.0.1:8791
       AGENT_FLEET_TRANSPORT=websocket
     then:
       agent-fleet-sidecar doctor
       agent-fleet-sidecar

  7. Drive it:
       curl -s localhost:8791/api/list | node -e 'process.stdin.pipe(process.stdout)'

To sandbox sessions (real root inside, discarded on every stop), set in $ENV_FILE:
       AGENT_HUB_SANDBOX=1
  and restart agent-hub. See docs/deployment.md.

EOF
