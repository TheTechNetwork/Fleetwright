#!/bin/sh
# Runs before claude, inside the container, every start.
#
# The per-session /root/.claude volume is empty on first run, so anything the
# image ships for it has to be copied in here rather than baked at that path —
# a volume mount shadows whatever the image had there.
set -e

mkdir -p /root/.claude

# settings.json: only if the session has not got its own. An operator who edits
# it inside a session keeps their edit across every later resume, because the
# volume survives stop.
if [ ! -f /root/.claude/settings.json ] && [ -f /etc/agent-session/settings.json ]; then
  cp /etc/agent-session/settings.json /root/.claude/settings.json
fi

# The seeded account identity, merged into the container's state file on EVERY
# start — /root/.claude.json is part of the ephemeral container filesystem and
# is rebuilt from the image each time, so a one-off merge would survive exactly
# one run. The newer CLI decides logged-in-ness from the PAIR of
# .credentials.json and the oauthAccount block here; seeding one without the
# other produced sessions that answered "not logged in" while holding a
# perfectly valid token.
if [ -f /root/.claude/.oauth-account.json ]; then
  node <<'MERGE'
const fs = require('fs');
try {
  const state = JSON.parse(fs.readFileSync('/root/.claude.json', 'utf8'));
  state.oauthAccount = JSON.parse(fs.readFileSync('/root/.claude/.oauth-account.json', 'utf8'));
  state.hasCompletedOnboarding = true;
  fs.writeFileSync('/root/.claude.json', JSON.stringify(state, null, 2) + '\n');
} catch (e) {
  // A malformed fragment must not stop the session from starting at all —
  // without the merge it is exactly as logged-out as it would have been.
  console.error('could not merge the seeded account identity: ' + e.message);
}
MERGE
fi

# The other credentials — GitHub, Cloudflare, whatever else was connected.
#
# THEY ARE NO LONGER HERE. This used to seed /root/.claude/.secrets.env into the
# volume and `set -a` it into the environment, which was already the careful
# version: not `-e` flags on the podman command line, because that line is the
# tmux pane's process and readable from `ps` by anyone on the box.
#
# It still meant every process in this container held GH_TOKEN for the life of
# the session — in /proc, inherited by every child, present in anything that
# dumps an environment — and, worse in practice, held whatever was current when
# the session STARTED. Rotating a token reached the next session and could not
# reach into a running one, so "my token expired" was fixed by stopping work.
#
# Now the session asks, over the same per-session socket the SessionStart hook
# uses, and gets what is current at the moment it asks. See
# docs/credential-broker.md.
#
# git needs no shim: it has a credential helper protocol, and this is a helper.
# `--global` rather than a repository setting, because the session clones
# repositories this script has never heard of.
if command -v git-credential-fleet >/dev/null 2>&1; then
  git config --global --replace-all credential.https://github.com.helper fleet
  git config --global --replace-all credential.https://gist.github.com.helper fleet
  # Scoped to github.com rather than set as a bare `credential.helper`. A global
  # helper is consulted for EVERY host a session ever clones from, which would
  # hand our helper the hostname of anything the session was told to fetch. It
  # refuses those on its own, and not being asked is better than refusing.
fi

# A file left over from before the broker. Removed rather than ignored: a
# resumed session's volume still holds one, and a stale token that nothing
# refreshes is worse than no token — it fails in a way that looks like the
# broker is broken.
rm -f /root/.claude/.secrets.env

# The SessionStart hook, registered the same way install.sh does it on a host,
# but pointed at the unix socket. Merged with node rather than rewritten, so a
# session that adds its own hooks keeps them across resumes.
if [ -S /run/hub.sock ]; then
  node <<'NODE'
const fs = require('fs');
const file = '/root/.claude/settings.json';
const cmd = 'agent-session-hook';
let settings = {};
try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
settings.hooks ||= {};
settings.hooks.SessionStart ||= [];
if (!JSON.stringify(settings.hooks.SessionStart).includes(cmd)) {
  settings.hooks.SessionStart.push({ hooks: [{ type: 'command', command: cmd }] });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}
NODE
fi

# CAN THIS BROWSER KEEP ITS OWN SANDBOX? Asked here, on the box, because here
# is the only place the answer is true.
#
# Chromium's sandbox needs a user namespace. Whether a container can make one
# depends on the runtime, its seccomp profile, and the kernel's
# unprivileged_userns_clone — so it is a property of the machine the session is
# running on, and it is not knowable when the image is built.
#
# CI measures it too, and CI measures DOCKER while a session runs under rootless
# podman. That answer is about a different container: it is worth having, and it
# is not this one. The probe below is the one that decides what the session gets.
#
# Debian's /usr/bin/chromium is a wrapper that reads CHROMIUM_FLAGS, so this
# reaches every tool that shells out to `chromium` without any of them knowing.
# --no-sandbox is set ONLY when the sandbox cannot be entered: a browser that
# keeps its own confinement should keep it, and the flag is not a default
# somebody once pasted.
if command -v chromium >/dev/null 2>&1; then
  # NOT ANSWERABLE IS NOT THE SAME AS NO. Without `unshare` this cannot tell,
  # and it degrades the browser rather than guessing it will be fine — but it
  # says which of the two happened, because "no user namespace" and "no way to
  # ask" send somebody to different places.
  if ! command -v unshare >/dev/null 2>&1; then
    echo "sandbox: no unshare here, so chromium's sandbox cannot be checked — running with --no-sandbox" >&2
    export CHROMIUM_FLAGS="${CHROMIUM_FLAGS:+$CHROMIUM_FLAGS }--no-sandbox"
  elif unshare --user --map-root-user true >/dev/null 2>&1; then
    echo "sandbox: chromium keeps its own sandbox (user namespaces available)" >&2
  else
    # SAID OUT LOUD, to the session's log, because it is a real reduction and
    # the person reading a transcript later should not have to guess. A page
    # this browser renders is as confined as the session is, and no more.
    echo "sandbox: chromium has no user namespace here, so it runs with --no-sandbox" >&2
    echo "sandbox: a page it renders is as confined as this session is, and no more" >&2
    export CHROMIUM_FLAGS="${CHROMIUM_FLAGS:+$CHROMIUM_FLAGS }--no-sandbox"
  fi
fi

# exec so claude is PID 1's direct child and signals reach it — and so the
# container's lifetime IS the session's lifetime, which is what lets a dead
# container end the tmux session and reconcile see "ended".
exec "$@"
