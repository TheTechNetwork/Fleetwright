#!/usr/bin/env bash
# agent-hub installer.
#
#   git clone https://github.com/ambersecurityinc/agent-hub /opt/agent-hub
#   sudo /opt/agent-hub/install/install.sh
#
# Idempotent: re-run it after `git pull` to pick up changes. It never
# overwrites /etc/agent-hub.env once that exists, so your token and allowlist
# survive every upgrade.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/agent-hub.env
UNIT=/etc/systemd/system/agent-hub.service
RUN_USER="${AGENT_HUB_USER:-${SUDO_USER:-$(id -un)}}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  warn %s\n' "$*"; }
die()  { printf '\n  FAIL %s\n\n' "$*" >&2; exit 1; }

say "agent-hub installer"
printf '  source : %s\n  user   : %s\n' "$DIR" "$RUN_USER"

# --- 1. prerequisites -------------------------------------------------------
say "Checking prerequisites"

command -v node >/dev/null || die "node is not installed. Install Node 18 or newer, then re-run."
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node $NODE_MAJOR is too old — agent-hub needs 18 or newer (it uses global fetch)."
ok "node $(node -v) at $NODE_BIN"

command -v tmux >/dev/null || die "tmux is not installed. Try: apt install -y tmux"
ok "tmux $(tmux -V | awk '{print $2}')"

# claude may legitimately be missing at this point — agent-hub can install
# nothing for you, but it CAN log you in once it is running, so this is a
# warning rather than a hard stop.
CLAUDE_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME}"

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
SETTINGS="$SETTINGS" HOOK_CMD="$HOOK_CMD" node <<'NODE'
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

# --- 6. CLI on PATH ---------------------------------------------------------
say "Linking the CLI"
ln -sf "$DIR/bin/agent-hub" /usr/local/bin/agent-hub
chmod +x "$DIR/bin/agent-hub"
ok "/usr/local/bin/agent-hub -> $DIR/bin/agent-hub"

# --- done -------------------------------------------------------------------
say "Installed."
cat <<EOF

Next:

  1. Create a Telegram bot — message @BotFather, /newbot — and put the token in:
       $ENV_FILE

  2. Start it:
       systemctl enable --now agent-hub
       journalctl -u agent-hub -f

  3. Message your bot /whoami, put the id it replies with into
     AGENT_HUB_TELEGRAM_ALLOWED_USERS in $ENV_FILE, then:
       systemctl restart agent-hub

  4. Check the box is ready:
       agent-hub doctor

  If claude is not logged in yet, send your bot /login and follow the link.

EOF
