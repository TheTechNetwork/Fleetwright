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

# exec so claude is PID 1's direct child and signals reach it — and so the
# container's lifetime IS the session's lifetime, which is what lets a dead
# container end the tmux session and reconcile see "ended".
exec "$@"
