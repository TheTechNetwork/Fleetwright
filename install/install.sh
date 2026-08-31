#!/usr/bin/env bash
# agent-fleet installer — the whole thing, in one script.
#
#   curl -fsSL https://fleet.thetech.network/install | sudo sh
#
# ...which is install/bootstrap.sh fetching the repository and then running
# this. By hand, which is the same thing:
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

# A RELEASE, OR A CHECKOUT. The two differ in exactly one way that matters here:
# a release carries its dependencies already bundled into lib/, so there is no
# npm step, no lockfile, and no git remote to pull from. Everything else — the
# units, the sandbox image, the wizard — is identical, which is why this is a
# flag and not a second installer.
#
# Detected from the layout rather than from a flag somebody has to pass,
# because the person running it got here by unpacking a tarball and has no
# reason to know there are two shapes.
PACKAGED=0
if [ -f "$DIR/lib/agent-hub.mjs" ]; then PACKAGED=1; fi

# Set only when the new agent-hub has been SEEN to start. Section 8 will not
# remove the install it replaced without it.
SERVICES_STARTED=0
OLD_UNIT_BACKUP_DIR=""
ENV_FILE=/etc/agent-hub.env
SIDECAR_ENV=/etc/agent-fleet-sidecar.env
COORD_ENV=/etc/agent-fleet-coordinator.env
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  warn %s\n' "$*"; }
die()  { printf '\n  FAIL %s\n\n' "$*" >&2; exit 1; }

# --- what this script is installing onto -----------------------------------
#
# Checked FIRST, because the first thing a Mac used to hit was `getent:
# command not found` on the line that looks up a home directory — a tool
# nobody has heard of, failing under `set -e`, naming nothing about the cause.
#
# NOT a refusal. A Mac as a fleet host is intended, so this installs what it
# can and says exactly where it stops, rather than putting up a wall that has
# to be taken down again later. What it cannot do yet is listed at the end of
# the run, not hidden in a comment here.
PLATFORM=linux
case "$(uname -s 2>/dev/null || echo unknown)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  *) PLATFORM=unknown ;;
esac
# Collected as they are skipped, and printed together at the end. One warning
# in the middle of two hundred lines of output is a warning nobody read.
MISSING=()

RUN_USER="${AGENT_HUB_USER:-${SUDO_USER:-$(id -un)}}"

# Resolved once, up here, because finding node depends on it — sudo hides
# anything a version manager put in this directory.
#
# Not plain getent: it is glibc's, so it is absent on macOS and on musl images
# such as Alpine, where this used to abort on line 28 under `set -e` naming a
# command rather than a cause. The tilde form is what bash consults the
# password database with, and works wherever bash does.
user_home() {
  local u="$1" home=""
  if command -v getent >/dev/null 2>&1; then
    home="$(getent passwd "$u" 2>/dev/null | cut -d: -f6 || true)"
  fi
  if [ -z "$home" ] && [ -r /etc/passwd ]; then
    home="$(awk -F: -v u="$u" '$1 == u { print $6; exit }' /etc/passwd || true)"
  fi
  # macOS keeps real accounts in Directory Services, not /etc/passwd — that
  # file exists there but lists only system users, so the lookup above finds
  # nothing for a person and finds it silently.
  if [ -z "$home" ] && command -v dscl >/dev/null 2>&1; then
    home="$(dscl . -read "/Users/$u" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
  fi
  printf '%s' "$home"
}
USER_HOME="$(user_home "$RUN_USER")"
USER_HOME="${USER_HOME:-$HOME}"

# --check verifies the prerequisites and changes nothing. Worth having as a
# first step on a box you are not sure about, rather than finding out halfway
# through that node is invisible to sudo.
CHECK_ONLY=0
# ask = report what is here and do nothing; yes = offer to remove it.
CLEAN=ask
# The wizard asks the handful of questions that otherwise become a checklist at
# the end. It runs when there is a terminal to ask on, and never otherwise — a
# piped or scripted install must behave exactly as it always has.
WIZARD=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --check|-n) CHECK_ONLY=1 ;;
    --clean|--reinstall) CLEAN=yes ;;
    --wizard) WIZARD=yes ;;
    --no-wizard|--yes|-y) WIZARD=no ;;
    -h|--help)
      printf 'usage: install.sh [--check] [--clean] [--wizard|--no-wizard]\n\n'
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
  # Homebrew REFUSES to run as root, which is the opposite of every package
  # manager below it — so this branch comes before the root check, and runs as
  # the invoking user rather than the one this script became.
  if [ "$PLATFORM" = macos ]; then
    command -v brew >/dev/null || return 1
    as_user "brew install $*" >/dev/null 2>&1
    return $?
  fi
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
  elif [ "$PLATFORM" = macos ]; then printf 'Homebrew is not installed — see https://brew.sh'
  elif [ "$(id -u)" != "0" ]; then printf 'not running as root — re-run with sudo'
  else printf 'no supported package manager found (apt, dnf, pacman, zypper, apk)'
  fi
}

say "agent-fleet installer${CHECK_ONLY:+}"
printf '  source : %s\n  user   : %s\n' "$DIR" "$RUN_USER"
[ "$CHECK_ONLY" = 1 ] && printf '  mode   : --check (nothing will be changed)\n'

# --- 0. what is already here -------------------------------------------------
#
# A separate uninstall script is no use to somebody who does not know it exists,
# and no use at all on a box where the checkout is the thing that is wrong. The
# installer already has to look at every one of these paths, so it can say what
# it found and offer to clear it.
#
# NOT offered on an ordinary re-run. Re-running this to upgrade is the
# documented path and must stay non-destructive — a prompt every time is a
# prompt somebody eventually answers wrong, and the answer costs them the host
# identity. So it asks only when there is a reason: --clean was passed, or the
# key belongs to different hardware.
previous_install() {
  FOUND=()
  for f in /etc/agent-hub.env /etc/agent-fleet-sidecar.env /etc/agent-fleet-coordinator.env; do
    [ -f "$f" ] && FOUND+=("config    $f")
  done
  if [ -f /var/lib/agent-fleet/host-key.json ]; then
    local fp=""
    fp="$(sudo -u "$RUN_USER" "$DIR/bin/agent-fleet-sidecar" identity 2>/dev/null | awk '/fingerprint/ {print $2}' || true)"
    FOUND+=("IDENTITY  /var/lib/agent-fleet/host-key.json${fp:+  fingerprint $fp}")
  fi
  for d in /var/lib/agent-hub /var/lib/agent-fleet-coordinator; do
    [ -d "$d" ] && FOUND+=("state     $d")
  done
  for u in agent-hub agent-fleet-sidecar agent-fleet-coordinator; do
    if [ "$PLATFORM" = macos ]; then
      [ -f "/Library/LaunchDaemons/network.thetech.$u.plist" ] && FOUND+=("service   $u")
    else
      [ -f "/etc/systemd/system/$u.service" ] && FOUND+=("service   $u")
    fi
  done
  for f in /etc/sudoers.d/agent-hub-upgrade /etc/sudoers.d/agent-hub-reboot; do
    [ -f "$f" ] && FOUND+=("sudoers   $f")
  done
}

# A key that belongs to different hardware is the one case where continuing
# quietly is actively wrong: two boxes proving the same identity disconnect each
# other for ever. So a clone escalates from "reporting" to "asking", without
# --clean having to be passed by somebody who does not yet know anything is
# wrong. Read-only here; the rotation itself happens with the rest of the
# identity work further down.
CLONE=0
if [ -f /var/lib/agent-fleet/host-key.json ] && [ -f /var/lib/agent-fleet/machine-id ]; then
  NOW_ID=""
  if [ -r /etc/machine-id ]; then NOW_ID="$(cat /etc/machine-id)"
  elif [ -r /var/lib/dbus/machine-id ]; then NOW_ID="$(cat /var/lib/dbus/machine-id)"
  elif command -v ioreg >/dev/null 2>&1; then
    NOW_ID="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/ {print $4}')"
  fi
  if [ -n "$NOW_ID" ] && [ "$(cat /var/lib/agent-fleet/machine-id 2>/dev/null)" != "$NOW_ID" ]; then
    CLONE=1
    [ "$CLEAN" = ask ] && CLEAN=yes
  fi
fi

previous_install
if [ ${#FOUND[@]} -gt 0 ] && [ "$CHECK_ONLY" = 0 ]; then
  say "A previous install is already here"
  for f in "${FOUND[@]}"; do printf '  %s\n' "$f"; done

  # The identity is called out separately because it is the one thing here that
  # cannot be recreated: removing it means this box is no longer the host the
  # coordinator knows, and has to be enrolled again.
  if [ -f /var/lib/agent-fleet/host-key.json ]; then
    printf '\n  The IDENTITY line is this box'"'"'s place in the fleet. Clearing it means\n'
    printf '  enrolling again, and removing the old entry from the coordinator.\n'
  fi

  if [ "$CLONE" = 1 ]; then
    printf '\n  THIS BOX IS A CLONE. That identity was made on different hardware,\n'
    printf '  so the machine it came from still holds the same private key. The\n'
    printf '  coordinator cannot tell the two apart: they will take turns\n'
    printf '  connecting and disconnecting each other, for ever, and neither box\n'
    printf '  will log anything that explains it.\n'
  fi

  # A choice, not a yes/no. "Do you want to clean up?" is ambiguous about what
  # happens if you say no, and this is the one prompt in the script where the
  # wrong answer costs something that cannot be recovered.
  #
  # 1 is the default and is what re-running this has always done. 2 is only the
  # default when the identity provably belongs to another machine, because
  # there "keep it" is not a conservative choice — it is the broken one.
  printf '\n  1) Update      keep the config, the identity and running sessions\n'
  printf '  2) Clean       remove everything above, then install fresh\n'
  if [ "$CLONE" = 1 ]; then
    printf '\n     2 is recommended here: this identity is not this machine'"'"'s.\n'
    CHOICE_DEFAULT=2
  else
    CHOICE_DEFAULT=1
  fi

  # --clean is the same thing without a terminal, and no terminal means 1 —
  # a piped install must never destroy an identity nobody was asked about.
  if [ "$CLEAN" = yes ]; then
    CHOICE=2
  elif [ "$WIZARD" = no ] || ! [ -t 0 ]; then
    CHOICE=1
    printf '\n  No terminal to ask on — updating. Pass --clean to remove instead.\n'
  else
    ask CHOICE "Choose" "$CHOICE_DEFAULT"
  fi

  case "$CHOICE" in
    2)
      # Said BEFORE the gate, as what WOULD happen — "Removing." printed while
      # still asking whether to remove is the script claiming an action it has
      # not taken and might not take.
      printf '\n  This would remove everything listed above. ~%s/agent-runs,\n' "$RUN_USER"
      printf '  running sessions and node/tmux/claude are left alone.\n'

      # A second gate, and deliberately not [y/N]. A single keystroke is the
      # wrong weight for the one action in this script that destroys something
      # unrecoverable — the identity is a private key, and there is no copy.
      # Typing a word cannot be done by leaning on the return key.
      if [ -t 0 ]; then
        if [ -f /var/lib/agent-fleet/host-key.json ]; then
          printf '\n  This deletes the host key. There is no copy, and the coordinator\n'
          printf '  will not recognise this box again until it is enrolled afresh.\n'
        fi
        ask SURE "Are you sure you want to delete? Type YES"
        if [ "$SURE" != YES ]; then
          ok "not deleting — updating instead, nothing above was changed"
          CHOICE=1
        fi
      fi

      if [ "$CHOICE" = 2 ]; then
        say "Removing the previous install"
        # One implementation, called rather than copied: the uninstaller is the
        # thing that knows how to take a box apart, and a second copy of that
        # knowledge here is the copy that goes stale.
        "$DIR/install/uninstall.sh" --yes || die "cleanup failed — nothing further was changed"
        ok "cleaned — installing fresh"
      fi
      ;;
    *)
      ok "updating — nothing above was changed"
      [ "$CLONE" = 1 ] && warn "the cloned identity is still in place; this box and its original will fight over it"
      ;;
  esac
fi

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
# Rootless podman on macOS is not rootless podman. There is no user namespace
# to be root in, so podman runs a Linux VM (`podman machine`) and every step
# the sandbox setup takes below — newuidmap, /etc/subuid, usermod — is
# meaningless there. Skipping is the honest outcome: allocating nothing and
# then starting sessions that report themselves sandboxed would be worse.
if [ "$PLATFORM" = macos ]; then
  warn "sandboxing is off — podman on macOS needs a Linux VM, which this does not set up"
  MISSING+=("sandboxed sessions: run 'podman machine init && podman machine start', then re-run this")
elif ! command -v podman >/dev/null && [ "$CHECK_ONLY" = 0 ]; then
  say "Installing podman (for sandboxed sessions)"
  if pkg_install podman && command -v podman >/dev/null; then
    ok "installed podman"
  else
    warn "could not install podman ($(pkg_why)) — sessions will run directly on this box"
    warn "  install it yourself and re-run to build the sandbox image"
  fi
fi
if [ "$PLATFORM" = macos ]; then
  : # already reported above; HAVE_PODMAN stays 0 so nothing downstream runs
elif command -v podman >/dev/null; then
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

# --- 4. service units -------------------------------------------------------
say "Installing the $([ "$PLATFORM" = macos ] && echo "launchd daemons" || echo "systemd units")"

# All three, not just agent-hub. Installing only the hub was a real bug with a
# quiet symptom: the installer went on to call `systemctl enable --now
# agent-fleet-sidecar` on a unit that did not exist, warned once, and finished
# looking successful — so the box never joined a fleet, and the coordinator it
# was meant to join reported that no host had ever connected.
# The same substitution either way; only the template and the destination
# differ. Kept as one function so a service can never be installed on one
# platform and forgotten on the other — which is exactly the bug described
# above, in a different coat.
install_unit() { # install_unit NAME
  local src dest
  if [ "$PLATFORM" = macos ]; then
    src="$DIR/install/$1.plist"
    dest="/Library/LaunchDaemons/network.thetech.$1.plist"
  else
    src="$DIR/install/$1.service"
    dest="/etc/systemd/system/$1.service"
  fi
  sed -e "s|__USER__|$RUN_USER|g" \
      -e "s|__DIR__|$DIR|g" \
      -e "s|__NODE__|$NODE_BIN|g" \
      "$src" > "$dest"
  # root-owned, because launchd REFUSES to load a daemon that is writable by
  # anyone else, and does so with a message about permissions rather than
  # about the file it means.
  chown root:wheel "$dest" 2>/dev/null || true
  chmod 0644 "$dest"
  ok "$dest"
}

# KEPT BEFORE THEY ARE OVERWRITTEN, because the old ExecStart is the only
# record of where the previous install lived — and install_unit is about to
# replace it. Section 8 reads these to know what it is replacing.
OLD_UNIT_BACKUP_DIR="$(mktemp -d)"
for u in agent-hub agent-fleet-sidecar agent-fleet-coordinator; do
  if [ "$PLATFORM" = macos ]; then
    [ -f "/Library/LaunchDaemons/network.thetech.$u.plist" ] \
      && cp "/Library/LaunchDaemons/network.thetech.$u.plist" "$OLD_UNIT_BACKUP_DIR/$u.service" || true
  else
    [ -f "/etc/systemd/system/$u.service" ] \
      && cp "/etc/systemd/system/$u.service" "$OLD_UNIT_BACKUP_DIR/$u.service" || true
  fi
done

install_unit agent-hub
install_unit agent-fleet-sidecar
install_unit agent-fleet-coordinator

# Reading the service journal needs group membership: systemd-journald shows a
# plain user only their own logs. Without this /logs returns "no entries" for a
# service that is logging perfectly well — a silence that reads as a broken
# service rather than a permissions one.
if [ "$PLATFORM" != macos ] && [ "$RUN_USER" != root ] && command -v usermod >/dev/null; then
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

if [ "$PLATFORM" = macos ]; then
  # launchd has no daemon-reload: bootstrapping the plist IS the load, and that
  # happens where the services are started. Nothing to do here.
  ok "launchd daemons written"
  HAVE_SYSTEMD=1
elif systemctl daemon-reload >/dev/null 2>&1; then
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

# --- 5b. runtime dependencies ------------------------------------------------
# There is exactly ONE, and until recently there were none: `jose`, for
# verifying the ID tokens the apps sign in with. node_modules is gitignored, so
# a fresh checkout has no way to get it — and the Node coordinator does not
# start without it. It dies with ERR_MODULE_NOT_FOUND, which names a package
# nobody asked for and no fix at all.
#
# The sidecar and agent-hub are unaffected: neither imports it. That is why this
# was invisible until a box tried to run its own coordinator.
say "Runtime dependencies"
if [ "$PACKAGED" = 1 ]; then
  # NOTHING TO INSTALL, and that is the point of the release rather than a
  # convenience. npm runs lifecycle scripts from every package in the tree, on
  # a box whose whole job is to be trustworthy; a release is unpacked and runs
  # none of them. The one runtime dependency is inside lib/.
  ok "bundled — no npm install on this box"
else
NPM_BIN="$(command -v npm 2>/dev/null || true)"
if [ -z "$NPM_BIN" ]; then
  # Debian ships npm separately from nodejs, so a box that got node from
  # `pkg_install nodejs` above very often has no npm at all.
  pkg_install npm >/dev/null 2>&1 || true
  NPM_BIN="$(command -v npm 2>/dev/null || true)"
fi

if [ "$CHECK_ONLY" = 1 ]; then
  [ -n "$NPM_BIN" ] && ok "npm at $NPM_BIN" || warn "npm is not installed — the installer would install it"
elif [ -z "$NPM_BIN" ]; then
  warn "npm is not installed and could not be installed automatically ($(pkg_why)).
       The sidecar and agent-hub are fine without it. A coordinator on this box is not:
         cd $DIR && npm install --omit=dev"
else
  # ci first: it installs exactly the lockfile and is the reproducible one. It
  # refuses when package.json and the lock disagree, which is a state a fork or
  # a half-finished merge can be in, so `install` is the fallback rather than
  # the failure.
  if (cd "$DIR" && "$NPM_BIN" ci --omit=dev --no-audit --no-fund >/dev/null 2>&1) \
     || (cd "$DIR" && "$NPM_BIN" install --omit=dev --no-audit --no-fund >/dev/null 2>&1); then
    # Owned by the service user, so `/update` can rewrite it after a pull that
    # changes a dependency. Root-owned node_modules is the same class of bug as
    # the root-owned .git objects the block below exists for.
    chown -R "$RUN_USER" "$DIR/node_modules" 2>/dev/null || true
    ok "installed $(cd "$DIR" && "$NPM_BIN" ls --omit=dev --depth=0 2>/dev/null | grep -c '^[├└]' || echo '?') runtime dependencies"
  else
    warn "npm install failed in $DIR — a coordinator on this box will not start.
       Run it by hand and read the error:  cd $DIR && npm install --omit=dev"
  fi
fi
fi

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

# /usr/local/bin is NOT guaranteed to exist. On Apple Silicon it usually does
# not: Homebrew lives in /opt/homebrew there, and nothing else creates the
# directory — so a clean Mac ends this script with
#
#   ln: /usr/local/bin/agent-hub: No such file or directory
#
# after everything else has already been installed. It is on the default PATH
# regardless (/etc/paths ships it), so creating it is the right fix rather than
# picking a different directory that a shell might not search.
BIN_DIR=/usr/local/bin
if [ ! -d "$BIN_DIR" ]; then
  install -d -m 0755 "$BIN_DIR" || die "could not create $BIN_DIR"
  ok "created $BIN_DIR"
fi

for cli in agent-hub agent-fleet-sidecar agent-fleet-coordinator; do
  [ -f "$DIR/bin/$cli" ] || continue
  ln -sf "$DIR/bin/$cli" "$BIN_DIR/$cli"
  # Belt-and-braces: git already records the executable bit, so this only
  # matters for a checkout that lost it. Never fatal — the repo may legitimately
  # be on a read-only mount, or owned by someone else, and the symlink above is
  # the part that matters.
  [ -x "$DIR/bin/$cli" ] || chmod +x "$DIR/bin/$cli" 2>/dev/null || \
    warn "$DIR/bin/$cli is not executable and could not be made so — check the checkout"
  ok "$BIN_DIR/$cli -> $DIR/bin/$cli"
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

  # --- fleet identity ------------------------------------------------------
  # AFTER the coordinator question, because the answer changes what happens.
  #
  # There is no host token to generate or to ask for any more. This box makes a
  # keypair, keeps the private half 0600, and presents the public half once with
  # a six-digit pin. What that removes: a shared secret that had to be typed
  # identically on every machine, could not tell two boxes apart, and could not
  # be revoked for one of them.
  #
  # On the box that RUNS the coordinator, none of that needs a human: this
  # script already holds the admin token, so it mints a pin and spends it. On a
  # box joining somebody else's coordinator the pin comes from a person, so it
  # is asked for — and blank is fine, because `agent-fleet-sidecar enrol` works
  # perfectly well tomorrow.
  if [ "$FLEET_LOCAL" = 1 ]; then
    if [ -z "$(get_env "$COORD_ENV" AGENT_FLEET_API_TOKEN)" ]; then
      set_env "$COORD_ENV" AGENT_FLEET_API_TOKEN "$(gen_secret)"
      ok "generated an admin token for the coordinator"
    fi
  fi

  # The key file, and the directory systemd will also create. Made here as well
  # so `enrol` below can run before the service has ever started.
  # No -g: a matching group usually exists but is not guaranteed, and the mode
  # is 0700 so the group does not decide anything anyway. Same shape as the
  # STATE_DIR line above.
  install -d -m 0700 -o "$RUN_USER" /var/lib/agent-fleet
  KEY_FILE_PATH=/var/lib/agent-fleet/host-key.json
  set_env "$SIDECAR_ENV" AGENT_FLEET_HOST_KEY "$KEY_FILE_PATH"

  # --- is this box a clone of one that was already in the fleet? -----------
  #
  # /var/lib/agent-fleet/host-key.json IS this machine's identity — "whoever
  # can read it can be this machine, and nothing else can". Clone a VM that has
  # been installed and both boxes now hold the same private key, so the
  # coordinator sees ONE host. They take turns proving the same identity and
  # disconnecting each other, for ever, and the symptom is a host that flaps
  # with nothing in either box's logs to explain it.
  #
  # Nothing detected this. The installer found a valid key, assumed this box
  # was that host, and carried on.
  #
  # So the machine is fingerprinted next to the key, and a mismatch means the
  # key travelled to hardware it was not made on.
  machine_id() {
    if [ -r /etc/machine-id ]; then cat /etc/machine-id
    elif [ -r /var/lib/dbus/machine-id ]; then cat /var/lib/dbus/machine-id
    elif command -v ioreg >/dev/null 2>&1; then
      ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null \
        | awk -F'"' '/IOPlatformUUID/ {print $4}'
    fi
  }
  MACHINE_FILE=/var/lib/agent-fleet/machine-id
  THIS_MACHINE="$(machine_id || true)"
  if [ -n "$THIS_MACHINE" ]; then
    if [ -f "$KEY_FILE_PATH" ] && [ -f "$MACHINE_FILE" ] \
       && [ "$(cat "$MACHINE_FILE" 2>/dev/null)" != "$THIS_MACHINE" ]; then
      # Rotating rather than reusing, because the alternative is not "maybe
      # fine" — it is two machines authenticating as one, which is broken for
      # both. Moved aside rather than deleted: if this clone was meant to
      # REPLACE the original, the old key can be put back, and the original
      # must then be destroyed rather than left running.
      STAMP="$(date +%Y%m%d%H%M%S)"
      mv "$KEY_FILE_PATH" "$KEY_FILE_PATH.clone-$STAMP"
      warn "THIS BOX IS A CLONE. It carried another machine's fleet identity."
      warn "  The key has been set aside as host-key.json.clone-$STAMP and a new"
      warn "  one will be made, so this box needs enrolling again."
      warn "  The ORIGINAL still holds that key — remove this box's old entry from"
      warn "  the coordinator, or the two will disconnect each other for ever."
      warn "  Meant to replace the original? Move the file back and destroy the original."
    fi
    printf '%s' "$THIS_MACHINE" > "$MACHINE_FILE"
    chown "$RUN_USER" "$MACHINE_FILE" 2>/dev/null || true
    chmod 0600 "$MACHINE_FILE"
  fi

  # Sweep out the credential this replaced. It does nothing now — no coordinator
  # reads it and no sidecar sends it — but a dead secret sitting in a config
  # file still looks live to whoever finds it next, and the whole point of the
  # change is that there is no shared string to leak.
  for STALE_ENV in "$COORD_ENV" "$SIDECAR_ENV"; do
    if [ -f "$STALE_ENV" ] && grep -q '^AGENT_FLEET_HOST_TOKEN=' "$STALE_ENV"; then
      ENVFILE="$STALE_ENV" "$NODE_BIN" -e '
        const fs = require("fs");
        const f = process.env.ENVFILE;
        fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^AGENT_FLEET_HOST_TOKEN=.*\n?/gm, ""));
      '
      ok "removed the old shared host token from $STALE_ENV — hosts hold a key now"
    fi
  done

  ENROL_URL="$(get_env "$SIDECAR_ENV" AGENT_FLEET_COORDINATOR_URL)"

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

  # Reboot is asked separately, and defaults to no. It is not a bigger version
  # of the same permission: installing packages leaves every session running,
  # and a reboot takes the tmux server with it, so every session dies
  # mid-thought. Folding the two into one question would mean somebody granting
  # the second while thinking about the first.
  if [ -z "$(get_env "$ENV_FILE" AGENT_HUB_SYSTEM_REBOOT)" ] \
     && command -v sudo >/dev/null && command -v visudo >/dev/null && [ -d /etc/sudoers.d ]; then
    printf '  /reboot can restart this machine from chat, behind three confirmations:\n'
    printf '  the command, a one-time token, and the hostname typed out.\n'
    printf '  EVERY RUNNING SESSION DIES — a reboot takes the tmux server with it.\n'
    if confirm "Allow reboot from chat?" N; then
      SUDO_TMP="$(mktemp)"
      printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl reboot\n' "$RUN_USER" > "$SUDO_TMP"
      if visudo -cf "$SUDO_TMP" >/dev/null 2>&1; then
        install -m 0440 "$SUDO_TMP" /etc/sudoers.d/agent-hub-reboot
        set_env "$ENV_FILE" AGENT_HUB_SYSTEM_REBOOT 1
        ok "/etc/sudoers.d/agent-hub-reboot — $RUN_USER may run systemctl reboot"
      else
        warn "the sudoers rule did not validate, so it was NOT installed"
      fi
      rm -f "$SUDO_TMP"
    else
      set_env "$ENV_FILE" AGENT_HUB_SYSTEM_REBOOT 0
      ok "skipping — /reboot will explain how to turn it on if anybody asks"
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

  # --- joining the fleet ---------------------------------------------------
  # A pin, spent once, in exchange for this box's public key being known.
  #
  # On the box that runs its own coordinator this is silent: the admin token is
  # right here, so minting the pin and spending it is bookkeeping, not a
  # decision, and making somebody copy six digits from one terminal into the
  # same terminal would be theatre.
  enrol_host() {
    [ -n "$ENROL_URL" ] || return 0

    # Already enrolled? `doctor` is the one that asks the coordinator, because a
    # key on disk looks identical whether it was ever presented or has since
    # been revoked. Re-running the installer on a working box must not demand a
    # new pin.
    #
    # Two things this line has to get right, and it got both wrong first:
    #
    #   CAPTURED, NOT PIPED. doctor exits non-zero when anything it checks is
    #   unhappy, and on a fresh box something usually is — claude not being
    #   logged in yet, most often. Under `set -o pipefail` that exit code sinks
    #   the pipeline no matter what grep found.
    #
    #   MATCHED ON THE LEADING " ok ". doctor prints the same words on the
    #   FAILING line, so grepping for the sentence reports every unenrolled box
    #   as enrolled and skips the one step this function exists to do.
    DOCTOR_OUT="$(sidecar_cli doctor 2>/dev/null || true)"
    if printf '%s\n' "$DOCTOR_OUT" | grep -q '^ ok .*coordinator knows this host'; then
      ok "this box is already enrolled at $ENROL_URL"
      return 0
    fi

    local pin=""
    if [ "$FLEET_LOCAL" = 1 ]; then
      local admin
      admin="$(get_env "$COORD_ENV" AGENT_FLEET_API_TOKEN)"
      # Wait for the port. The coordinator was started seconds ago and binding
      # is not instant; without this the first install on a slow box asks for a
      # pin it could have minted itself.
      local i=0
      while [ "$i" -lt 20 ]; do
        curl -fsS "$ENROL_URL/healthz" >/dev/null 2>&1 && break
        i=$((i + 1))
        sleep 0.5
      done
      # `|| true`, and it is load-bearing. Under `set -euo pipefail` a failing
      # command substitution ABORTS THE SCRIPT — so when the coordinator did not
      # answer, the installer exited 7 partway through rather than reaching the
      # warning three lines below, which was therefore unreachable. The
      # coordinator not answering is the ordinary case on a box where it failed
      # to start, which is exactly when the operator needs the rest of the
      # install to finish and tell them so.
      pin="$(curl -fsS -X POST "$ENROL_URL/api/enroll" \
               -H "authorization: Bearer $admin" -H 'content-type: application/json' \
               -d '{"kind":"host","label":"installed on this box"}' 2>/dev/null \
             | sed -n 's/.*"code":"\([0-9]*\)".*/\1/p' || true)"
      if [ -z "$pin" ]; then
        warn "could not mint an enrolment pin from the local coordinator — enrol by hand later"
        return 0
      fi
    else
      printf '\n  This box needs a six-digit pin from %s to join it.\n' "$ENROL_URL"
      printf '  Get one from the app (Fleet -> Add a host), or from anyone who has the admin token.\n'
      printf '  Blank is fine — run "agent-fleet-sidecar enrol <pin>" whenever you have one.\n'
      ask pin "Enrolment pin"
      [ -n "$pin" ] || { warn "not enrolled — this host will be refused until it is"; return 0; }
    fi

    # Six digits or nothing. A pin is not free text and never was.
    pin="$(printf '%s' "$pin" | tr -cd '0-9')"
    if [ ${#pin} -ne 6 ]; then
      warn "that is not a six-digit pin — enrol later with: sudo -u $RUN_USER $DIR/bin/agent-fleet-sidecar enrol <pin>"
      return 0
    fi
    if sidecar_cli enrol "$pin" 2>&1 | sed 's/^/  /'; then
      ok "enrolled at $ENROL_URL"
    else
      warn "enrolment failed — run: sudo -u $RUN_USER $DIR/bin/agent-fleet-sidecar enrol <pin>"
    fi
  }

  # Run a sidecar subcommand as the service user, with the environment the unit
  # would have given it. Running it as root would put a root-owned key file
  # where the service expects its own, and the service would refuse to read it.
  # $1 is a SUBCOMMAND, $2 an optional argument, and the argument is quoted
  # before it reaches the shell.
  #
  # It used to be one string interpolated raw into `bash -lc`, and the only
  # thing ever put in it was a pin the operator pasted at a prompt — running as
  # root. `enrol 123 456` silently enrolled with the code "123"; anything with a
  # $( ) in it did rather more than that. The pin is checked to be six digits
  # first, and %q-quoted after, because either alone would be enough and neither
  # costs anything.
  sidecar_cli() {
    local sub="$1" arg="${2:-}" quoted=""
    [ -n "$arg" ] && printf -v quoted ' %q' "$arg"
    as_user "AGENT_FLEET_ENROL_QUIET=1 \
             AGENT_FLEET_COORDINATOR_URL='$ENROL_URL' \
             AGENT_FLEET_HOST_ID='$(get_env "$SIDECAR_ENV" AGENT_FLEET_HOST_ID)' \
             AGENT_FLEET_HOST_KEY='$(get_env "$SIDECAR_ENV" AGENT_FLEET_HOST_KEY)' \
             '$UNIT_NODE_BIN' '$DIR/bin/agent-fleet-sidecar' $sub$quoted"
  }

  # --- start it ------------------------------------------------------------
  if [ "$HAVE_SYSTEMD" = 1 ]; then
    printf '\n'
    if confirm "Enable and start the services now?" Y; then
      # Print the reason rather than where to look for it. "failed to start,
      # go read the journal" is a round trip for information we already have.
      # `enable --now` STARTS a stopped unit and does nothing at all to a
      # running one. So re-running the installer over an existing deployment —
      # which is the documented way to upgrade, and what `/update` tells people
      # to do — left the old code running with the old environment, reported
      # "running", and looked like a successful upgrade.
      #
      # An already-active unit is restarted. It is the same reload systemd would
      # do anyway, and the unit files may have changed underneath it.
      start_service() {
        if [ "$PLATFORM" = macos ]; then
          local label="system/network.thetech.$1" plist="/Library/LaunchDaemons/network.thetech.$1.plist"
          # bootout then bootstrap, because bootstrap on an already-loaded
          # label fails rather than replacing it — the launchd equivalent of
          # the restart-an-active-unit case below, and the same bug it fixes:
          # an upgrade that leaves the old code running while reporting success.
          launchctl bootout "$label" >/dev/null 2>&1 || true
          if launchctl bootstrap system "$plist" >/dev/null 2>&1; then
            ok "$1 running"
            return 0
          fi
          warn "$1 failed to start:"
          tail -n 12 "/var/log/$1.log" 2>/dev/null | sed 's/^/       /' \
            || warn "       /var/log/$1.log"
          return 1
        fi
        systemctl daemon-reload >/dev/null 2>&1 || true
        if systemctl is-active --quiet "$1"; then
          if systemctl restart "$1" >/dev/null 2>&1; then
            ok "$1 restarted, on the new code"
            return 0
          fi
        elif systemctl enable --now "$1" >/dev/null 2>&1; then
          ok "$1 running"
          return 0
        fi
        warn "$1 failed to start:"
        journalctl -u "$1" -n 12 --no-pager 2>/dev/null | sed 's/^/       /' \
          || warn "       journalctl -u $1 -n 50"
        return 1
      }
      # Recorded, because section 8 removes the previous install and must not
      # do that on a box where the replacement never came up. Seen-to-start is
      # the only evidence worth acting on.
      if start_service agent-hub; then SERVICES_STARTED=1; fi
      [ "$FLEET_LOCAL" = 1 ] && { start_service agent-fleet-coordinator || true; }

      # Enrol BEFORE starting the sidecar. Not for correctness — the sidecar
      # retries and would pick it up — but because a box that comes up refused
      # writes "that host is not enrolled" into the journal every few seconds,
      # and the first thing anyone does with that is assume it is broken.
      enrol_host

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


# --- 8. the install this one replaces ---------------------------------------
#
# EVERY INSTALL IS AN UPGRADE. Boxes are already running the checkout layout —
# a git clone with node_modules — so a release cannot behave as though it
# arrived on a clean machine. Two installs side by side is not "harmless
# leftovers": it is a box where the next `/update` picks one of them and nobody
# can tell which is running.
#
# Nothing here touches state. The credentials, the host key, the registry and
# the env files all live OUTSIDE the install directory already
# (/etc/*.env, /var/lib/agent-hub, /var/lib/agent-fleet), which is why this can
# be a directory removal rather than a migration of data. The units were
# rewritten above with __DIR__ pointing at this release, so the switch has
# already happened by the time we get here.
if [ "$PACKAGED" = 1 ] && [ "$CHECK_ONLY" != 1 ]; then
  say "The install this one replaces"

  OLD_DIR=""
  for u in agent-hub agent-fleet-sidecar; do
    [ -f "$OLD_UNIT_BACKUP_DIR/$u.service" ] || continue
    # The path the OLD unit ran from, taken from the backup rather than from
    # the file we just overwrote.
    d="$(sed -n 's|^ExecStart=[^ ]* \(.*\)/bin/[a-z-]*.*$|\1|p' "$OLD_UNIT_BACKUP_DIR/$u.service" | head -1)"
    [ -n "$d" ] && [ "$d" != "$DIR" ] && OLD_DIR="$d" && break
  done

  if [ -z "$OLD_DIR" ]; then
    ok "no earlier install to clean up"
  elif [ ! -d "$OLD_DIR" ]; then
    ok "the earlier install at $OLD_DIR is already gone"
  elif [ "$SERVICES_STARTED" != 1 ]; then
    # THE ORDER IS THE SAFETY. Removing the old tree before the new one has
    # been seen to start would leave a box with neither.
    warn "the new services did not start, so $OLD_DIR was left alone.
       Fix the service, re-run this installer, and it will clean up then."
  elif [ -d "$OLD_DIR/.git" ] && ! (cd "$OLD_DIR" && git diff --quiet HEAD 2>/dev/null); then
    # Somebody's working tree. This is a development box, and deleting
    # uncommitted work to tidy up a directory is not a trade this installer
    # gets to make on anybody's behalf.
    warn "$OLD_DIR has uncommitted changes, so it was NOT removed.
       It is no longer what runs — the services point at $DIR.
       Remove it yourself when you have saved what you want:  rm -rf $OLD_DIR"
  else
    rm -rf "$OLD_DIR"
    ok "removed the earlier install at $OLD_DIR"
  fi
fi

# --- done -------------------------------------------------------------------
# Everything that was skipped, together, at the end. One warning in the middle
# of two hundred lines is a warning nobody read — and on a platform this only
# partly supports, the list IS the useful output.
if [ ${#MISSING[@]} -gt 0 ]; then
  say "Not set up on this platform"
  printf '  This is a %s box, and parts of this are still Linux-only:\n\n' "$PLATFORM"
  for m in "${MISSING[@]}"; do printf '    - %s\n' "$m"; done
  printf '\n  Everything else above is installed and working. Mac host support is\n'
  printf '  being filled in — see docs/wanted.md.\n'
fi

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

  # Enrolment only happens on the path where the services were started, because
  # that is the only path where there is a coordinator up to enrol WITH. Say so
  # on the other two rather than leaving a box that connects and is refused.
  if [ -n "$ENROL_URL" ] && [ "${STARTED:-0}" != 1 ]; then
    printf '\n  This box has not joined %s yet. With a six-digit pin from the app:\n' "$ENROL_URL"
    printf '      sudo -u %s %s/bin/agent-fleet-sidecar enrol <pin>\n' "$RUN_USER" "$DIR"
    printf '  or send /enroll <pin> to your bot. Until then the sidecar is refused on every try.\n'
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
    printf '\n  The coordinator on this box:\n'
    printf '      URL          http://%s:8791   (or your Worker, if you deploy one)\n' "$(hostname -I 2>/dev/null | awk '{print $1}' || echo 127.0.0.1)"
    printf '      Admin token  %s\n' "$(get_env "$COORD_ENV" AGENT_FLEET_API_TOKEN)"
    printf '\n  That token is break-glass, not the everyday credential: it can stop every\n'
    printf '  session and revoke every host. The app signs in instead and gets its own.\n'
    printf '\n  To add another box, mint it a pin:\n'
    printf "      curl -sX POST -H 'authorization: Bearer <admin token>' \\\n"
    printf "           -H 'content-type: application/json' -d '{\"kind\":\"host\"}' \\\n"
    printf '           http://127.0.0.1:8791/api/enroll\n'
    printf '  then on that box:  sudo -u %s agent-fleet-sidecar enrol <pin>\n' "$RUN_USER"
    # The app does not want the admin token. It signs in — which this box can
    # only accept if it has been told who is allowed, so say so here rather than
    # letting somebody discover it from a 503 on a phone.
    if [ -z "$(get_env "$COORD_ENV" AGENT_FLEET_AUTH_ALLOW)" ]; then
      printf '\n  For the app to SIGN IN to this coordinator, add to %s:\n' "$COORD_ENV"
      printf '      AGENT_FLEET_AUTH_ISSUERS=https://appleid.apple.com https://accounts.google.com\n'
      printf '      AGENT_FLEET_AUTH_AUDIENCES=<the iOS bundle id> <the Android web client id>\n'
      printf '      AGENT_FLEET_AUTH_ALLOW=@yourdomain.com\n'
      printf '  Empty ALLOW lets nobody in, on purpose. Until then the app can use the admin\n'
      printf '  token above, under "use a credential instead".\n'
    fi
  fi

  # This box's own identity, printed because it is the thing to compare against
  # /hosts when something does not line up.
  if [ -n "$ENROL_URL" ]; then
    # Same trap as the pin above: this is a summary line, and a summary line
    # must not be able to end the install it is summarising.
    FP="$(sidecar_cli identity 2>/dev/null | sed -n 's/^fingerprint  *//p' || true)"
    [ -n "$FP" ] && printf '\n  This host: %s  fingerprint %s\n' "$(get_env "$SIDECAR_ENV" AGENT_FLEET_HOST_ID)" "$FP"
  fi

  cat <<EOF

  Drive it:
      agent-hub list
      journalctl -u agent-hub -f

  Read the admin token again any time:
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

  For the fleet: put an AGENT_FLEET_API_TOKEN in $COORD_ENV (break-glass
     admin; phones sign in and get their own), then:
       systemctl enable --now agent-fleet-coordinator agent-fleet-sidecar
     Hosts have no token. Mint a pin and spend it on the box:
       agent-fleet-sidecar enrol <pin>

  Or re-run this installer with a terminal and it will ask instead — it
  generates the admin token, enrols this box and starts the services for you.

EOF
fi
