#!/usr/bin/env bash
# agent-fleet installer — the whole thing, in one script.
#
#   git clone https://github.com/TheTechNetwork/Fleetwright /opt/agent-fleet
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
COORD_ENV=/etc/agent-fleet-coordinator.env
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
# The wizard asks the handful of questions that otherwise become a checklist at
# the end. It runs when there is a terminal to ask on, and never otherwise — a
# piped or scripted install must behave exactly as it always has.
WIZARD=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --check|-n) CHECK_ONLY=1 ;;
    --wizard) WIZARD=yes ;;
    --no-wizard|--yes|-y) WIZARD=no ;;
    -h|--help)
      printf 'usage: install.sh [--check] [--wizard|--no-wizard]\n\n'
      printf '  --check       verify prerequisites and change nothing\n'
      printf '  --wizard      force the interactive setup even without a terminal\n'
      printf '  --no-wizard   never ask; write templates and print the next steps\n'
      exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[ "${AGENT_HUB_NONINTERACTIVE:-0}" = "1" ] && WIZARD=no
if [ "$WIZARD" = auto ]; then
  # A terminal on stdin AND stdout. `curl | bash` has neither, and asking
  # questions nobody can answer is worse than not asking.
  if [ -t 0 ] && [ -t 1 ]; then WIZARD=yes; else WIZARD=no; fi
fi
[ "$CHECK_ONLY" = 1 ] && WIZARD=no

# Installing missing OS packages rather than printing a command for someone to
# copy is the difference between "one installer" and "an installer plus a
# checklist". It is only ever used for packages from the distro's own
# repositories — nothing here pipes a remote script into a shell.
#
# AGENT_HUB_NO_INSTALL_DEPS=1 turns it off for a box where package management is
# somebody else's job.
# --- asking things ----------------------------------------------------------

ask() { # ask VAR "prompt" [default]
  __var="$1"; __prompt="$2"; __default="${3:-}"
  if [ -n "$__default" ]; then printf '  %s [%s]: ' "$__prompt" "$__default"
  else printf '  %s: ' "$__prompt"; fi
  IFS= read -r __reply || __reply=""
  [ -z "$__reply" ] && __reply="$__default"
  printf -v "$__var" '%s' "$__reply"
}

confirm() { # confirm "prompt" [Y|N]  → 0 for yes
  __default="${2:-Y}"
  case "$__default" in
    Y|y) __hint="[Y/n]" ;;
    *)   __hint="[y/N]" ;;
  esac
  printf '  %s %s: ' "$1" "$__hint"
  IFS= read -r __reply || __reply=""
  [ -z "$__reply" ] && __reply="$__default"
  case "$__reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# A secret nobody has to think about. Every one of these is a value with no
# decision content — leaving them blank for an operator to generate and paste
# is pure friction, and the reason people end up running with none at all.
gen_secret() {
  if command -v openssl >/dev/null; then openssl rand -hex 24
  else "$NODE_BIN" -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
  fi
}

# Set KEY=VALUE in an env file, but ONLY if it is currently empty. An operator
# who has already put something there keeps it on every re-run — the same
# promise the whole installer makes about /etc files.
#
# Done in node rather than sed because these values are secrets and may contain
# any character at all.
set_env() { # set_env FILE KEY VALUE
  ENVFILE="$1" ENVKEY="$2" ENVVAL="$3" "$NODE_BIN" -e '
    const fs = require("fs");
    const { ENVFILE, ENVKEY, ENVVAL } = process.env;
    const lines = fs.readFileSync(ENVFILE, "utf8").split("\n");
    let done = false;
    const out = lines.map((line) => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m || m[1] !== ENVKEY) return line;
      done = true;
      // Already set by hand — leave it exactly as it is.
      if (m[2].trim() !== "") return line;
      return `${ENVKEY}=${ENVVAL}`;
    });
    if (!done) out.push(`${ENVKEY}=${ENVVAL}`);
    fs.writeFileSync(ENVFILE, out.join("\n"));
  '
}

# Read a value back out of an env file.
get_env() { # get_env FILE KEY
  sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -1
}

# Run something as the target user. `sudo` is not guaranteed to exist — a
# minimal Debian image has none, and neither does a container you are already
# root in — so fall back to running it directly when we are already that user.
as_user() {
  if [ "$(id -un)" = "$RUN_USER" ]; then
    bash -lc "$1"
  elif command -v sudo >/dev/null; then
    sudo -u "$RUN_USER" -H bash -lc "$1"
  elif command -v runuser >/dev/null; then
    runuser -l "$RUN_USER" -c "$1"
  else
    return 1
  fi
}

PKG_UPDATED=0
pkg_install() {
  [ "${AGENT_HUB_NO_INSTALL_DEPS:-0}" = "1" ] && return 1
  [ "$(id -u)" = "0" ] || return 1
  if command -v apt-get >/dev/null; then
    if [ "$PKG_UPDATED" = 0 ]; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
      PKG_UPDATED=1
    fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null 2>&1
  elif command -v dnf >/dev/null; then dnf install -y -q "$@" >/dev/null 2>&1
  elif command -v pacman >/dev/null; then pacman -Sy --noconfirm --quiet "$@" >/dev/null 2>&1
  elif command -v zypper >/dev/null; then zypper -nq install "$@" >/dev/null 2>&1
  elif command -v apk >/dev/null; then apk add --quiet "$@" >/dev/null 2>&1
  else return 1
  fi
}

# Why it could not be installed, phrased for whoever has to fix it.
pkg_why() {
  if [ "${AGENT_HUB_NO_INSTALL_DEPS:-0}" = "1" ]; then printf 'AGENT_HUB_NO_INSTALL_DEPS=1 is set'
  elif [ "$(id -u)" != "0" ]; then printf 'not running as root — re-run with sudo'
  else printf 'no supported package manager found (apt, dnf, pacman, zypper, apk)'
  fi
}

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
# the operator just ran `sudo` from. An earlier version of this script reported
# "node is not installed" at somebody with a working Node 24.
#
# So: ask the run user's own login shell, then look where the common installers
# actually put things. Same treatment `claude` already gets below.
find_node() {
  command -v node 2>/dev/null && return 0
  # The login shell of whoever invoked sudo — this is what picks up nvm's and
  # asdf's shell functions and shims.
  as_user 'command -v node' 2>/dev/null && return 0
  for candidate in \
      /usr/local/bin/node /usr/bin/node /snap/bin/node \
      "$USER_HOME/.local/bin/node" "$USER_HOME/.volta/bin/node" "$USER_HOME/.asdf/shims/node" \
      /home/linuxbrew/.linuxbrew/bin/node; do
    [ -x "$candidate" ] && { printf '%s\n' "$candidate"; return 0; }
  done
  # nvm and fnm keep one directory per version; take the newest. sort -V, not
  # sort — otherwise v9.9.9 beats v24.10.0.
  for root in "$USER_HOME/.nvm/versions/node" "$USER_HOME/.local/share/fnm/node-versions" "$USER_HOME/.fnm/node-versions"; do
    [ -d "$root" ] || continue
    newest="$(ls -1d "$root"/*/bin/node "$root"/*/installation/bin/node 2>/dev/null | sort -V | tail -1)"
    [ -n "$newest" ] && [ -x "$newest" ] && { printf '%s\n' "$newest"; return 0; }
  done
  return 1
}

# Major version, or empty if that is not a working node.
node_major() {
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$major"
}

NODE_BIN="$(find_node || true)"

# Missing entirely: install it, the same way tmux and podman are installed.
if [ -z "$NODE_BIN" ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    warn "node is not installed — the installer would install it"
  else
    say "Installing node"
    if pkg_install nodejs && NODE_BIN="$(find_node || true)" && [ -n "$NODE_BIN" ]; then
      ok "installed node $("$NODE_BIN" -v)"
    else
      die "node is not installed and could not be installed automatically ($(pkg_why)).
       Install Node 18 or newer and re-run. If \`node -v\` already works for you,
       that is sudo's secure_path hiding it — point at it directly:
           sudo AGENT_HUB_NODE_BIN=\$(command -v node) $0"
    fi
  fi
fi

# An explicit override always wins.
NODE_BIN="${AGENT_HUB_NODE_BIN:-${NODE_BIN:-}}"
if [ -n "$NODE_BIN" ]; then
  [ -x "$NODE_BIN" ] || die "AGENT_HUB_NODE_BIN=$NODE_BIN is not an executable file."
  NODE_MAJOR="$(node_major "$NODE_BIN")" || die "could not read a version from $NODE_BIN — is it really node?"

  # A distro whose nodejs package is older than we need. Say which, rather than
  # leaving someone to work out why a fresh install still fails.
  [ "$NODE_MAJOR" -ge 18 ] || die "node $NODE_MAJOR at $NODE_BIN is too old — this needs 18 or newer (it uses global fetch).
       Your distribution's package is too old; use nodesource or nvm:
           curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  ok "node $("$NODE_BIN" -v) at $NODE_BIN"
fi

# The systemd unit hardcodes a node path, and that path has a different job from
# the one the operator's shell uses. A node inside their home is usually nvm's,
# and `nvm install` / `nvm uninstall` moves or removes it — which takes the
# service down at the next restart, long after the change that caused it.
#
# So the unit prefers a SYSTEM node, installing one if there is none. The two
# are allowed to differ: the service wants a path that does not move, the
# operator wants their toolchain.
UNIT_NODE_BIN="${NODE_BIN:-}"
case "${NODE_BIN:-}" in
  "$USER_HOME"/*)
    for attempt in find install; do
      for candidate in /usr/local/bin/node /usr/bin/node; do
        [ -x "$candidate" ] || continue
        candidate_major="$(node_major "$candidate")" || continue
        [ "$candidate_major" -ge 18 ] || continue
        UNIT_NODE_BIN="$candidate"
        break 3
      done
      [ "$attempt" = find ] || break
      [ "$CHECK_ONLY" = 1 ] && break
      say "Installing a system node for the service"
      warn "$NODE_BIN is inside $RUN_USER's home — a version-manager upgrade would move it"
      pkg_install nodejs || true
    done
    if [ "$UNIT_NODE_BIN" = "$NODE_BIN" ]; then
      warn "no system node available — the systemd unit will point at $NODE_BIN"
      warn "  A version-manager upgrade will move it and the service will fail to start."
    else
      ok "systemd will use $UNIT_NODE_BIN — a path that will not move"
    fi
    ;;
esac

# tmux is not optional — it is what holds every session — so a missing one is
# fixed here rather than reported.
if ! command -v tmux >/dev/null; then
  if [ "$CHECK_ONLY" = 1 ]; then
    warn "tmux is not installed — the installer would install it"
  elif pkg_install tmux && command -v tmux >/dev/null; then
    ok "installed tmux"
  else
    die "tmux is not installed and could not be installed automatically ($(pkg_why)).
       Install it and re-run:  apt install -y tmux"
  fi
fi
command -v tmux >/dev/null && ok "tmux $(tmux -V | awk '{print $2}')"

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
  # as_user, not root: the credentials live in the service user's home, and
  # this script runs under sudo. Checking as root reports a logged-in box as
  # logged out, which is a scary line in the middle of a successful install.
  if as_user "'$CLAUDE_BIN' auth status --json" 2>/dev/null | grep -q '"loggedIn": *true'; then
    ok "claude is logged in"
  else
    warn "claude is NOT logged in — once the service is up, run 'agent-hub login' or send /login in Telegram"
  fi
  # Put it on the login-shell PATH too, so an operator who SSHes in and types
  # `claude` gets the same binary agent-hub uses.
  if ! as_user 'command -v claude' >/dev/null 2>&1; then
    BIN_DIR="$(dirname "$CLAUDE_BIN")"
    PROFILE="$CLAUDE_HOME/.profile"
    if ! grep -qF "$BIN_DIR" "$PROFILE" 2>/dev/null; then
      printf '\n# added by agent-hub install.sh\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$PROFILE"
      ok "added $BIN_DIR to $PROFILE (it was missing from the login-shell PATH)"
    fi
  fi
elif [ "$CHECK_ONLY" = 1 ]; then
  warn "claude is not installed — the installer would install it"
else
  # The one thing here that is not a distro package. This runs Anthropic's own
  # installer, as the RUN USER rather than as root, because it installs into
  # ~/.local/bin and a root-owned binary in someone's home is its own problem.
  #
  # Not fatal if it fails: the hub still comes up, still serves its web UI, and
  # still tells you claude is missing. A box you can log into and fix beats an
  # installer that stopped halfway.
  say "Installing the Claude Code CLI"
  command -v curl >/dev/null || pkg_install curl || true
  if ! command -v curl >/dev/null; then
    warn "curl is not available ($(pkg_why)) — install claude yourself:"
    warn "  curl -fsSL https://claude.ai/install.sh | bash"
  elif as_user 'curl -fsSL https://claude.ai/install.sh | bash' >/tmp/claude-install.log 2>&1; then
    for candidate in "$USER_HOME/.local/bin/claude" "$USER_HOME/.claude/local/claude" /usr/local/bin/claude; do
      [ -x "$candidate" ] && { CLAUDE_BIN="$candidate"; break; }
    done
    if [ -n "$CLAUDE_BIN" ]; then
      ok "installed claude $("$CLAUDE_BIN" --version 2>/dev/null | head -1) at $CLAUDE_BIN"
      warn "claude is NOT logged in yet — run 'agent-hub login' or send /login in Telegram"
    else
      warn "the claude installer finished but no binary was found — see /tmp/claude-install.log"
    fi
  else
    warn "could not install claude — see /tmp/claude-install.log. Install it yourself:"
    warn "  curl -fsSL https://claude.ai/install.sh | bash"
  fi
fi

# podman is optional — sessions run fine without it, just not sandboxed — so a
# failure to install is a warning rather than a stop. It is still attempted,
# because "sandboxed sessions" is not much use as a feature you have to go and
# enable the prerequisites for yourself.
HAVE_PODMAN=0
if ! command -v podman >/dev/null && [ "$CHECK_ONLY" = 0 ]; then
  say "Installing podman (for sandboxed sessions)"
  if pkg_install podman && command -v podman >/dev/null; then
    ok "installed podman"
  else
    warn "could not install podman ($(pkg_why)) — sessions will run directly on this box"
    warn "  install it yourself and re-run to build the sandbox image"
  fi
fi
if command -v podman >/dev/null; then
  ok "podman $(podman --version | awk '{print $3}') — the sandbox is available"
  HAVE_PODMAN=1
elif [ "$CHECK_ONLY" = 1 ]; then
  warn "podman is not installed — the installer would install it (sandboxing is optional)"
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

# The installer knows exactly where claude is; the service should not have to
# work it out again. src/core/which.js searches $HOME/.local/bin and would
# normally find it — but only for the user it runs as, which is why `doctor`
# run under sudo reports "claude on PATH: FAIL" on a box where the service is
# perfectly happy. Recording the path removes the guess for both.
if [ -n "$CLAUDE_BIN" ]; then
  set_env "$ENV_FILE" AGENT_HUB_CLAUDE_BIN "$CLAUDE_BIN"
  ok "recorded claude at $CLAUDE_BIN in $ENV_FILE"
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

# Reconcile the DERIVED values on every run, existing file or not.
#
# AGENT_FLEET_HUB_TOKEN is not an independent secret: it has to equal the hub's
# AGENT_HUB_TOKEN or the sidecar cannot read /api/state, and the host joins the
# fleet reporting "degraded — rejected the token". Copying it once at file
# creation is wrong, because the hub token can be generated afterwards or
# rotated later, and "already exists, left untouched" then freezes a value that
# was only ever a copy.
#
# Config the operator CHOSE is still never overwritten. This is strictly the
# two fields that are computed from somewhere else.
SIDECAR_ENV="$SIDECAR_ENV" HUB_ENV="$ENV_FILE" "$NODE_BIN" <<'NODE'
const fs = require('fs');

const read = (file) => {
  /** @type {Record<string,string>} */
  const out = {};
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
  return out;
};

const { SIDECAR_ENV, HUB_ENV } = process.env;
if (fs.existsSync(SIDECAR_ENV)) {
  const hub = read(HUB_ENV);
  const side = read(SIDECAR_ENV);

  let bind = hub.AGENT_HUB_BIND || '127.0.0.1';
  if (bind === '0.0.0.0' || bind === '::' || bind === '') bind = '127.0.0.1';
  const want = {
    AGENT_FLEET_HUB_URL: `http://${bind}:${hub.AGENT_HUB_PORT || '8790'}`,
    AGENT_FLEET_HUB_TOKEN: hub.AGENT_HUB_TOKEN || '',
  };

  let text = fs.readFileSync(SIDECAR_ENV, 'utf8');
  const fixed = [];
  for (const [key, value] of Object.entries(want)) {
    // An empty hub value is not authority to blank a working one — that would
    // turn a half-written hub env into a broken sidecar.
    if (!value || side[key] === value) continue;
    const line = `${key}=${value}`;
    text = new RegExp(`^${key}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line)
      : `${text.replace(/\n?$/, '\n')}${line}\n`;
    fixed.push(key);
  }

  if (fixed.length) {
    fs.writeFileSync(SIDECAR_ENV, text, { mode: 0o600 });
    console.log(`  ok   re-copied ${fixed.join(', ')} from ${HUB_ENV} — it had drifted`);
  }
}
NODE

# --- 4. systemd units -------------------------------------------------------
say "Installing the systemd units"

# All three, not just agent-hub. Installing only the hub was a real bug with a
# quiet symptom: the installer went on to call `systemctl enable --now
# agent-fleet-sidecar` on a unit that did not exist, warned once, and finished
# looking successful — so the box never joined a fleet, and the coordinator it
# was meant to join reported that no host had ever connected.
install_unit() { # install_unit NAME
  sed -e "s|__USER__|$RUN_USER|g" \
      -e "s|__DIR__|$DIR|g" \
      -e "s|__NODE__|$NODE_BIN|g" \
      "$DIR/install/$1.service" > "/etc/systemd/system/$1.service"
  chmod 0644 "/etc/systemd/system/$1.service"
  ok "/etc/systemd/system/$1.service"
}

install_unit agent-hub
install_unit agent-fleet-sidecar
install_unit agent-fleet-coordinator

# Reading the service journal needs group membership: systemd-journald shows a
# plain user only their own logs. Without this /logs returns "no entries" for a
# service that is logging perfectly well — a silence that reads as a broken
# service rather than a permissions one.
if [ "$RUN_USER" != root ] && command -v usermod >/dev/null; then
  if id -nG "$RUN_USER" 2>/dev/null | tr ' ' '\n' | grep -qx systemd-journal; then
    ok "$RUN_USER can already read the service journal"
  elif getent group systemd-journal >/dev/null && usermod -aG systemd-journal "$RUN_USER" 2>/dev/null; then
    ok "added $RUN_USER to systemd-journal, so /logs can read the journal"
  else
    warn "could not add $RUN_USER to systemd-journal — /logs will see no entries"
  fi
fi

# The tmux server must outlive the login session that spawned it, or every
# session dies when the operator logs out.
if command -v loginctl >/dev/null; then
  loginctl enable-linger "$RUN_USER" >/dev/null 2>&1 && ok "lingering enabled for $RUN_USER" \
    || warn "could not enable lingering for $RUN_USER — sessions may not survive logout"
fi

if systemctl daemon-reload >/dev/null 2>&1; then
  ok "systemd reloaded"
  HAVE_SYSTEMD=1
else
  # A container, WSL, or a chroot. Everything else here still applies — the
  # unit file is written and will work the moment systemd is running — so this
  # is a note, not a failure.
  warn "systemd is not running here, so the units were written but not loaded."
  warn "  Start the hub directly instead:  $UNIT_NODE_BIN $DIR/bin/agent-hub serve"
  HAVE_SYSTEMD=0
fi

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
#
# AS THE SERVICE USER, not as root. Rootless podman gives every user their own
# image store — root's images are invisible to anyone else — so an image built
# here by sudo is one the service can never see. It fails later, at the first
# sandboxed session, with "the sandbox image is not built" pointing at an image
# that very obviously IS built if you go and look as root.
if [ "$HAVE_PODMAN" = "1" ] && [ "${AGENT_FLEET_BUILD_IMAGE:-1}" != "0" ]; then
  say "Preparing rootless podman for $RUN_USER"

  # Rootless containers need a subordinate uid/gid range and the setuid helpers
  # that map it. Debian's useradd normally allocates the range, but a user made
  # some other way (adduser --system, cloud-init, an old account) may have none,
  # and podman then fails with a message about newuidmap that explains nothing.
  if [ "$RUN_USER" != root ]; then
    command -v newuidmap >/dev/null || pkg_install uidmap || true
    command -v newuidmap >/dev/null && ok "uidmap helpers present" \
      || warn "newuidmap is missing ($(pkg_why)) — rootless podman will not work"

    if grep -q "^$RUN_USER:" /etc/subuid 2>/dev/null && grep -q "^$RUN_USER:" /etc/subgid 2>/dev/null; then
      ok "subuid/subgid range allocated for $RUN_USER"
    elif command -v usermod >/dev/null \
         && usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$RUN_USER" 2>/dev/null; then
      ok "allocated a subuid/subgid range for $RUN_USER"
    else
      warn "no subuid/subgid range for $RUN_USER — rootless podman will not work."
      warn "  Add one:  usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $RUN_USER"
    fi
  fi

  # PULLED, not built. CI builds this image once and publishes it, so every
  # host runs the same bytes — a local build meant the image a box got depended
  # on the day it built it, and CLAUDE_VERSION was `latest`, so two hosts on the
  # same commit could disagree about how a session behaves.
  #
  # Building locally is still supported and is the fallback below, for an
  # offline box or a Containerfile somebody is editing.
  IMAGE="${AGENT_HUB_SANDBOX_IMAGE:-ghcr.io/thetechnetwork/fleetwright-session:latest}"
  say "Fetching the sandbox image"
  if as_user "podman image exists '$IMAGE'" 2>/dev/null \
     && [ "${AGENT_FLEET_REBUILD_IMAGE:-0}" != "1" ]; then
    ok "$IMAGE already present for $RUN_USER"
  elif [ "${IMAGE#localhost/}" != "$IMAGE" ]; then
    : # a localhost/ image can only be built, so fall through to the build below
  elif as_user "podman pull '$IMAGE'" >/tmp/agent-session-pull.log 2>&1; then
    ok "pulled $IMAGE"
    set_env "$ENV_FILE" AGENT_HUB_SANDBOX_IMAGE "$IMAGE"
    IMAGE=""
  else
    warn "could not pull $IMAGE — falling back to building it here."
    warn "  $(tail -1 /tmp/agent-session-pull.log 2>/dev/null || echo 'see /tmp/agent-session-pull.log')"
    IMAGE="localhost/agent-session:latest"
  fi

  # The build, for a localhost/ image or a failed pull. Tagged with the
  # localhost/ prefix deliberately: a bare name goes through short-name
  # resolution at run time, which fails on a stock Debian 13 with no
  # unqualified-search-registries configured.
  if [ -n "$IMAGE" ]; then
    if as_user "podman build -t '$IMAGE' -f '$DIR/sandbox/Containerfile' '$DIR/sandbox'" \
       >/tmp/agent-session-build.log 2>&1; then
      ok "$IMAGE (built in $RUN_USER's image store)"
      set_env "$ENV_FILE" AGENT_HUB_SANDBOX_IMAGE "$IMAGE"
    else
      warn "image build failed — see /tmp/agent-session-build.log."
      warn "  Sandboxed sessions will not start until it succeeds; everything else works."
    fi
  fi
fi

# --- 5c. coordinator configuration ------------------------------------------
say "Configuring the coordinator"
if [ -f "$COORD_ENV" ]; then
  ok "$COORD_ENV already exists — left untouched"
else
  install -m 0600 "$DIR/install/agent-fleet-coordinator.env.example" "$COORD_ENV"
  ok "wrote $COORD_ENV from the template"
fi

# The three env files hold tokens, so they stay 0600 — but they are read by the
# CLI as well as by systemd, and the CLI runs as the service user. Root-owned
# 0600 means `agent-hub doctor` silently sees no config at all and reports
# things like "a control surface is configured — web only" on a box with
# Telegram plainly working.
for f in "$ENV_FILE" "$SIDECAR_ENV" "$COORD_ENV"; do
  [ -f "$f" ] || continue
  chown "$RUN_USER" "$f" 2>/dev/null || true
  chmod 0600 "$f"
done
ok "config readable by $RUN_USER"

# The checkout must belong to the user that runs the service, or /update cannot
# pull: git refuses to operate on a repository owned by somebody else ("dubious
# ownership"), and even past that, writing the objects needs the permission.
#
# The alternative — giving the service user passwordless sudo for git — is a far
# larger grant to solve a file-ownership problem, so: the deployment owns its
# own deployment.
if [ -d "$DIR/.git" ] && [ "$(stat -c %U "$DIR/.git" 2>/dev/null)" != "$RUN_USER" ]; then
  if chown -R "$RUN_USER" "$DIR" 2>/dev/null; then
    ok "$DIR now belongs to $RUN_USER, so /update can pull"
  else
    warn "could not chown $DIR to $RUN_USER — /update will fail with a permissions error"
  fi
fi

# --- 6. CLIs on PATH --------------------------------------------------------
say "Linking the CLIs"
for cli in agent-hub agent-fleet-sidecar agent-fleet-coordinator; do
  [ -f "$DIR/bin/$cli" ] || continue
  ln -sf "$DIR/bin/$cli" "/usr/local/bin/$cli"
  # Belt-and-braces: git already records the executable bit, so this only
  # matters for a checkout that lost it. Never fatal — the repo may legitimately
  # be on a read-only mount, or owned by someone else, and the symlink above is
  # the part that matters.
  [ -x "$DIR/bin/$cli" ] || chmod +x "$DIR/bin/$cli" 2>/dev/null || \
    warn "$DIR/bin/$cli is not executable and could not be made so — check the checkout"
  ok "/usr/local/bin/$cli -> $DIR/bin/$cli"
done

# --- 7. the wizard ----------------------------------------------------------
# Everything above wrote files. This turns the checklist that used to be printed
# at the end into questions, because most of that checklist was not decisions —
# it was secrets to generate and services to start.
#
# Skipped entirely without a terminal, in which case the old next-steps text is
# printed instead and nothing changes.

FLEET_LOCAL=0
if [ "$WIZARD" = yes ]; then
  say "Setup"
  printf '  Answers go into the /etc files. Anything you have already edited there is\n'
  printf '  left alone, and you can re-run this at any time.\n\n'

  # --- Telegram ------------------------------------------------------------
  if [ -z "$(get_env "$ENV_FILE" AGENT_HUB_TELEGRAM_TOKEN)" ]; then
    printf '  Telegram is the recommended way to drive this: outbound only, no port to\n'
    printf '  open. Create a bot by messaging @BotFather and sending /newbot.\n'
    ask TG_TOKEN "Telegram bot token (blank to skip Telegram)"
    if [ -n "$TG_TOKEN" ]; then
      set_env "$ENV_FILE" AGENT_HUB_TELEGRAM_TOKEN "$TG_TOKEN"
      ok "Telegram bot configured"
      printf '\n  Every id you allow gets unsupervised shell access on this box. If you do\n'
      printf '  not know yours, leave it blank — message the bot /whoami once it is up\n'
      printf '  and it will tell you, even before you are on the list.\n'
      ask TG_USERS "Telegram user ids allowed to run commands (comma separated)"
      [ -n "$TG_USERS" ] && set_env "$ENV_FILE" AGENT_HUB_TELEGRAM_ALLOWED_USERS "$TG_USERS"
    else
      ok "skipping Telegram — the web UI and CLI still work"
    fi
    printf '\n'
  fi

  # --- is this box the coordinator too? ------------------------------------
  if [ -z "$(get_env "$SIDECAR_ENV" AGENT_FLEET_COORDINATOR_URL)" ] \
     || [ "$(get_env "$SIDECAR_ENV" AGENT_FLEET_COORDINATOR_URL)" = "stdio:local" ]; then
    printf '\n  A fleet needs a coordinator somewhere. For one machine, this box can be\n'
    printf '  both — the coordinator and a host.\n'
    if confirm "Run the coordinator on this box?" Y; then
      set_env "$SIDECAR_ENV" AGENT_FLEET_COORDINATOR_URL "http://127.0.0.1:8791"
      "$NODE_BIN" -e '
        const fs = require("fs");
        const f = process.argv[1];
        fs.writeFileSync(f, fs.readFileSync(f, "utf8")
          .replace(/^AGENT_FLEET_COORDINATOR_URL=.*$/m, "AGENT_FLEET_COORDINATOR_URL=http://127.0.0.1:8791")
          .replace(/^AGENT_FLEET_TRANSPORT=.*$/m, "AGENT_FLEET_TRANSPORT=websocket"));
      ' "$SIDECAR_ENV"
      FLEET_LOCAL=1
      ok "this box will run the coordinator, and join its own fleet"
    else
      ask COORD_URL "Coordinator URL to join (e.g. https://coord.example.com)"
      if [ -n "$COORD_URL" ]; then
        "$NODE_BIN" -e '
          const fs = require("fs");
          const [f, url] = process.argv.slice(1);
          fs.writeFileSync(f, fs.readFileSync(f, "utf8")
            .replace(/^AGENT_FLEET_COORDINATOR_URL=.*$/m, `AGENT_FLEET_COORDINATOR_URL=${url}`)
            .replace(/^AGENT_FLEET_TRANSPORT=.*$/m, "AGENT_FLEET_TRANSPORT=websocket"));
        ' "$SIDECAR_ENV" "$COORD_URL"
        ok "this host will join $COORD_URL"
      fi
    fi
  else
    [ "$(get_env "$SIDECAR_ENV" AGENT_FLEET_COORDINATOR_URL)" = "http://127.0.0.1:8791" ] && FLEET_LOCAL=1
  fi

  # --- fleet secrets -------------------------------------------------------
  # AFTER the coordinator question, because the answer changes what these are.
  #
  # On the box that runs the coordinator they are generated: there is no
  # decision in them, and a blank one is how a coordinator ends up reachable
  # with no credential at all.
  #
  # On a box JOINING someone else's coordinator the host token is not a secret
  # to invent — it has to MATCH what that coordinator was given, and a generated
  # one produces a sidecar that connects, is rejected, and retries forever. So
  # it is asked for. Generating it here and warning the operator to go and fix
  # the file afterwards was the old behaviour, and it is exactly the class of
  # thing this installer is supposed to remove.
  if [ "$FLEET_LOCAL" = 1 ]; then
    if [ -z "$(get_env "$COORD_ENV" AGENT_FLEET_HOST_TOKEN)" ]; then
      FLEET_HOST_TOKEN="$(gen_secret)"
      set_env "$COORD_ENV" AGENT_FLEET_HOST_TOKEN "$FLEET_HOST_TOKEN"
      set_env "$SIDECAR_ENV" AGENT_FLEET_HOST_TOKEN "$FLEET_HOST_TOKEN"
      ok "generated a host token, shared by the coordinator and this host"
    fi
    if [ -z "$(get_env "$COORD_ENV" AGENT_FLEET_API_TOKEN)" ]; then
      set_env "$COORD_ENV" AGENT_FLEET_API_TOKEN "$(gen_secret)"
      ok "generated an API token for phones and Shortcuts"
    fi
  elif [ -n "$(get_env "$SIDECAR_ENV" AGENT_FLEET_COORDINATOR_URL)" ]; then
    JOIN_TOKEN_NOW="$(get_env "$SIDECAR_ENV" AGENT_FLEET_HOST_TOKEN)"
    printf '\n  That coordinator has an AGENT_FLEET_HOST_TOKEN. This host has to present\n'
    printf '  the same one or it will be refused on every reconnect.\n'
    if [ -n "$JOIN_TOKEN_NOW" ]; then
      printf '  One is already set here; blank keeps it.\n'
    fi
    ask JOIN_TOKEN "Host token for that coordinator"
    if [ -n "$JOIN_TOKEN" ]; then
      # Overwrites, unlike set_env: the whole point is to replace a value that
      # is present and wrong.
      ENVFILE="$SIDECAR_ENV" ENVKEY=AGENT_FLEET_HOST_TOKEN ENVVAL="$JOIN_TOKEN" "$NODE_BIN" -e '
        const fs = require("fs");
        const { ENVFILE, ENVKEY, ENVVAL } = process.env;
        const line = `${ENVKEY}=${ENVVAL}`;
        let text = fs.existsSync(ENVFILE) ? fs.readFileSync(ENVFILE, "utf8") : "";
        text = new RegExp(`^${ENVKEY}=.*$`, "m").test(text)
          ? text.replace(new RegExp(`^${ENVKEY}=.*$`, "m"), line)
          : `${text.replace(/\n?$/, "\n")}${line}\n`;
        fs.writeFileSync(ENVFILE, text, { mode: 0o600 });
      '
      ok "host token set for $(get_env "$SIDECAR_ENV" AGENT_FLEET_COORDINATOR_URL)"
    elif [ -z "$JOIN_TOKEN_NOW" ]; then
      warn "no host token — the sidecar will be refused until one is in $SIDECAR_ENV"
    fi
    printf '\n'
  fi

  # --- push notifications --------------------------------------------------
  # Only worth asking on the box that actually runs the coordinator: it is the
  # process that sends, and the credential is useless on a host that does not.
  #
  # A PATH is asked for rather than the JSON itself, and the encoding is done
  # here. That is the whole point of this step. The file is multi-line, and
  # systemd's EnvironmentFile has no multi-line values AND expands C escapes
  # inside quoted ones — so pasting the JSON turns the \n in private_key into
  # real newlines and JSON.parse fails. The result is a coordinator that starts
  # cleanly and silently never notifies anybody. Base64 has nothing in it for
  # either systemd or a shell to touch.
  if [ "$FLEET_LOCAL" = 1 ] && [ -z "$(get_env "$COORD_ENV" AGENT_FLEET_FCM_SERVICE_ACCOUNT)" ]; then
    printf '\n  Push notifications are how a phone finds out a session is waiting for an\n'
    printf '  answer. Without them the fleet works, and nothing tells you.\n'
    printf '  Firebase console -> Project settings -> Service accounts -> Generate new\n'
    printf '  private key. Leave blank to skip; push is logged instead of sent.\n'
    ask FCM_PATH "Path to the Firebase service-account JSON"
    while [ -n "$FCM_PATH" ]; do
      # ~ is not expanded by read, and typing it is the obvious thing to do.
      case "$FCM_PATH" in "~/"*) FCM_PATH="$HOME/${FCM_PATH#\~/}" ;; esac
      if [ ! -r "$FCM_PATH" ]; then
        warn "cannot read $FCM_PATH"
      elif ! FCM_PROJECT="$("$NODE_BIN" -e '
        const fs = require("fs");
        try {
          const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          if (!a.project_id || !a.client_email || !a.private_key) {
            console.error("missing project_id, client_email or private_key");
            process.exit(1);
          }
          process.stdout.write(a.project_id);
        } catch (e) {
          console.error(e.message);
          process.exit(1);
        }
      ' "$FCM_PATH" 2>&1)"; then
        warn "not a usable service account: $FCM_PROJECT"
      else
        set_env "$COORD_ENV" AGENT_FLEET_FCM_SERVICE_ACCOUNT "$(base64 -w0 < "$FCM_PATH")"
        ok "push configured for Firebase project $FCM_PROJECT"
        break
      fi
      # Re-asking rather than giving up: the value is a path somebody just
      # typed, and a typo should not cost a whole re-run of the installer.
      ask FCM_PATH "Path to the Firebase service-account JSON (blank to skip)"
    done
    [ -z "$FCM_PATH" ] && ok "skipping push — it will be logged instead of sent"
    printf '\n'
  fi

  # --- system updates from chat --------------------------------------------
  # A NOPASSWD rule for ONE exact command, which is a much narrower grant than
  # it first sounds: sudoers matches the full argv, so this permits
  # `apt-get -y upgrade` and nothing else — not install, not remove, not a
  # shell, not apt-get with different arguments.
  #
  # Validated with visudo before it is installed. A malformed file in
  # /etc/sudoers.d does not break one rule, it breaks sudo, and that is a bad
  # way to find out.
  if [ -z "$(get_env "$ENV_FILE" AGENT_HUB_SYSTEM_UPGRADE)" ] \
     && command -v sudo >/dev/null && command -v visudo >/dev/null && [ -d /etc/sudoers.d ]; then
    printf '\n  /upgrade can show what the operating system has waiting, and apply it.\n'
    printf '  That needs one sudoers rule permitting exactly two commands:\n'
    printf '      apt-get update       (refresh the package lists)\n'
    printf '      apt-get -y upgrade   (install what is waiting)\n'
    printf '  and nothing else — not install, not remove, not a shell.\n'
    printf '\n  The refresh matters: this box does not update its package lists on its\n'
    printf '  own, so without it "no updates" would mean "nobody has looked since\n'
    printf '  install day".\n'
    if confirm "Allow system updates from chat?" Y; then
      SUDO_TMP="$(mktemp)"
      printf '%s ALL=(root) NOPASSWD: /usr/bin/apt-get update, /usr/bin/apt-get -y upgrade\n' "$RUN_USER" > "$SUDO_TMP"
      if visudo -cf "$SUDO_TMP" >/dev/null 2>&1; then
        install -m 0440 "$SUDO_TMP" /etc/sudoers.d/agent-hub-upgrade
        set_env "$ENV_FILE" AGENT_HUB_SYSTEM_UPGRADE 1
        set_env "$ENV_FILE" AGENT_HUB_USER "$RUN_USER"
        ok "/etc/sudoers.d/agent-hub-upgrade — $RUN_USER may run apt-get update and apt-get -y upgrade"
      else
        warn "the sudoers rule did not validate, so it was NOT installed"
      fi
      rm -f "$SUDO_TMP"
    else
      set_env "$ENV_FILE" AGENT_HUB_SYSTEM_UPGRADE 0
      ok "skipping — /upgrade will report what is waiting but not apply it"
    fi
    printf '\n'
  fi

  # --- sandbox -------------------------------------------------------------
  if [ "$HAVE_PODMAN" = 1 ] && [ -z "$(get_env "$ENV_FILE" AGENT_HUB_SANDBOX)" ]; then
    printf '\n  Sandboxed sessions get real root inside a container whose filesystem is\n'
    printf '  thrown away on every stop. The conversation and the workspace survive.\n'
    if confirm "Sandbox sessions?" Y; then
      set_env "$ENV_FILE" AGENT_HUB_SANDBOX 1
      ok "sandboxing on"
    fi
  fi

  # --- start it ------------------------------------------------------------
  if [ "$HAVE_SYSTEMD" = 1 ]; then
    printf '\n'
    if confirm "Enable and start the services now?" Y; then
      # Print the reason rather than where to look for it. "failed to start,
      # go read the journal" is a round trip for information we already have.
      start_service() {
        if systemctl enable --now "$1" >/dev/null 2>&1; then
          ok "$1 running"
          return 0
        fi
        warn "$1 failed to start:"
        journalctl -u "$1" -n 12 --no-pager 2>/dev/null | sed 's/^/       /' \
          || warn "       journalctl -u $1 -n 50"
        return 1
      }
      start_service agent-hub || true
      [ "$FLEET_LOCAL" = 1 ] && { start_service agent-fleet-coordinator || true; }
      [ -n "$(get_env "$SIDECAR_ENV" AGENT_FLEET_COORDINATOR_URL)" ] && { start_service agent-fleet-sidecar || true; }
      STARTED=1
    fi
  fi

  # --- log claude in -------------------------------------------------------
  # The one remaining step that genuinely needs a human, and the one the hub was
  # built to make possible without SSH. Doing it here means a fresh box is
  # finished when this script is.
  # The login state lives in the RUN_USER's home, and this script runs under
  # sudo — so asking root whether claude is logged in gets the wrong answer on
  # a box that is perfectly well logged in. Same bug as `doctor` had, same fix.
  if [ "${STARTED:-0}" = 1 ] && [ -n "$CLAUDE_BIN" ] \
     && ! as_user "'$CLAUDE_BIN' auth status --json" 2>/dev/null | grep -q '"loggedIn": *true'; then
    printf '\n'
    if confirm "Log this box into a Claude account now?" Y; then
      sleep 2 # let the hub finish binding its port
      if LOGIN_OUT="$("$DIR/bin/agent-hub" login 2>&1)"; then
        printf '%s\n' "$LOGIN_OUT"
        # Only ask for a code if there is a page to get one from. `login` on an
        # already-authenticated box answers "Already logged in", and asking for
        # a code after that is asking the operator to produce something that
        # does not exist.
        #
        # Gated on THAT string rather than on spotting a URL. The first version
        # of this grepped for https://claude.ai/ — and the live authorize URL is
        # https://claude.com/cai/oauth/authorize, which src/core/login.js says
        # in as many words. It would have skipped the prompt on a genuinely
        # logged-out box and announced the opposite. Matching the sentence the
        # hub actually emits (src/adapters/commands.js) cannot fail that way,
        # and a new first-party auth host cannot silently reintroduce it.
        if ! printf '%s' "$LOGIN_OUT" | grep -q 'Already logged in'; then
          ask AUTH_CODE "Paste the code from that page (blank to do it later)"
          if [ -n "$AUTH_CODE" ]; then
            "$DIR/bin/agent-hub" code "$AUTH_CODE" 2>&1 | sed 's/^/  /' || true
          fi
        else
          ok "nothing to do — this box is already logged in"
        fi
      else
        warn "could not start the login: $LOGIN_OUT"
      fi
    fi
  fi
fi

# --- done -------------------------------------------------------------------
say "Installed."

# What is genuinely left, which is not the same as what the checklist used to
# say. Telling someone to create a Telegram bot they just configured, or to
# generate tokens that were generated for them, is worse than saying nothing.
if [ "$WIZARD" = yes ]; then
  if [ "${STARTED:-0}" = 1 ]; then
    printf '\n'
    # As the RUN USER, not as root. doctor resolves paths relative to $HOME, so
    # running it under sudo answers a question nobody asked — it reports on
    # root's box while the service runs as somebody else.
    as_user "'$DIR/bin/agent-hub' doctor" 2>&1 | sed 's/^/  /' || true
  fi

  printf '\n'
  [ -n "$(get_env "$ENV_FILE" AGENT_HUB_TELEGRAM_TOKEN)" ] && printf '  Telegram : configured\n'
  [ -n "$(get_env "$ENV_FILE" AGENT_HUB_TELEGRAM_ALLOWED_USERS)" ] \
    || printf '  Telegram : no allowlist yet — message the bot /whoami, then put the id in\n             AGENT_HUB_TELEGRAM_ALLOWED_USERS in %s\n' "$ENV_FILE"
  [ "$(get_env "$ENV_FILE" AGENT_HUB_SANDBOX)" = "1" ] && printf '  Sandbox  : on\n'
  [ "$FLEET_LOCAL" = 1 ] && printf '  Fleet    : coordinator and host, both on this box\n'

  if [ "$HAVE_SYSTEMD" != 1 ]; then
    printf '\n  systemd is not running here, so nothing was started. Run them directly:\n'
    printf '      %s %s/bin/agent-hub serve\n' "$UNIT_NODE_BIN" "$DIR"
    [ "$FLEET_LOCAL" = 1 ] && printf '      %s %s/bin/agent-fleet-coordinator\n' "$UNIT_NODE_BIN" "$DIR"
    printf '      %s %s/bin/agent-fleet-sidecar\n' "$UNIT_NODE_BIN" "$DIR"
  elif [ "${STARTED:-0}" != 1 ]; then
    printf '\n  Start them when you are ready:\n'
    printf '      systemctl enable --now agent-hub'
    [ "$FLEET_LOCAL" = 1 ] && printf ' agent-fleet-coordinator'
    printf ' agent-fleet-sidecar\n'
  fi

  # As the service user: root's ~/.claude is not where the credentials live, so
  # asking as root reports "not logged in" on a box that plainly is.
  if [ -n "$CLAUDE_BIN" ] && ! as_user "'$CLAUDE_BIN' auth status --json" 2>/dev/null | grep -q '"loggedIn": *true'; then
    printf '\n  claude is not logged in yet:\n'
    printf '      agent-hub login          (then: agent-hub code <value>)\n'
    printf '      or send /login to your bot\n'
  fi

  # The API token is what a phone or a Shortcut presents, and it was generated
  # rather than chosen — so if it is not printed here, the install finishes with
  # the operator having no idea what to type into the app, and goes looking in a
  # 0600 file owned by root to find out.
  if [ "$FLEET_LOCAL" = 1 ] && [ -n "$(get_env "$COORD_ENV" AGENT_FLEET_API_TOKEN)" ]; then
    printf '\n  For the phone app or a Shortcut:\n'
    printf '      URL    http://%s:8791   (or your Worker, if you deploy one)\n' "$(hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1)"
    printf '      Token  %s\n' "$(get_env "$COORD_ENV" AGENT_FLEET_API_TOKEN)"
    printf '\n  Hosts joining this coordinator need its host token:\n'
    printf '      %s\n' "$(get_env "$COORD_ENV" AGENT_FLEET_HOST_TOKEN)"
  fi

  cat <<EOF

  Drive it:
      agent-hub list
      journalctl -u agent-hub -f

  Read a token again any time:
      sudo grep AGENT_FLEET_API_TOKEN $COORD_ENV

  Config: $ENV_FILE
          $SIDECAR_ENV
          $COORD_ENV

EOF
else
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

  For the fleet: put the SAME AGENT_FLEET_HOST_TOKEN in $COORD_ENV and
     $SIDECAR_ENV — a host presenting a different one is refused — and an
     AGENT_FLEET_API_TOKEN in $COORD_ENV for phones. Then:
       systemctl enable --now agent-fleet-coordinator agent-fleet-sidecar

  Or re-run this installer with a terminal and it will ask instead — it
  generates the tokens and starts the services for you.

EOF
fi
