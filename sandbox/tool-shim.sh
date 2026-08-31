#!/bin/sh
# A PATH shim, installed as /usr/local/bin/<tool> by the sandbox image.
#
# `gh` and `wrangler` read their token from the environment and speak no
# credential-helper protocol, so the only way to keep the token OUT of the
# session's environment and still have them work is to put it into one process's
# environment at the moment it runs. See docs/credential-broker.md.
#
# @TOOL@ and @PROVIDER@ are substituted when the image is built.

# The real binary: the first @TOOL@ on PATH that is not this shim. Resolved
# rather than hardcoded, because the image ships neither tool — a session
# installs what it needs, and apt, npm and a downloaded tarball all choose
# different directories.
#
# THE DIRECTORY TO SKIP COMES FROM $0, not from a constant. Writing
# /usr/local/bin here works right up until the shim is somewhere else, and the
# failure it produces is a shim that finds itself, execs itself, and spins
# forever — a hang with no error, which is the worst way for this to break. The
# kernel passes the resolved path to a #! script, so $0 is where this actually
# lives.
self="$0"
case "$self" in
  */*) self_dir=$(cd "$(dirname "$self")" && pwd) ;;
  *) self_dir=/usr/local/bin ;;
esac

real=""
IFS=:
for dir in $PATH; do
  [ -n "$dir" ] || continue
  [ "$dir" = "$self_dir" ] && continue
  if [ -x "$dir/@TOOL@" ]; then
    real="$dir/@TOOL@"
    break
  fi
done
unset IFS

# The belt to that braces. Two directories can be the same file by another name
# — a symlink, a bind mount — and one more layer of "surely not" is cheaper than
# a session that hangs.
if [ "$real" = "$self" ]; then
  echo "@TOOL@ shim resolved to itself; refusing to loop" >&2
  exit 127
fi

# IT REFUSES TO PRETEND. Without this, `command -v @TOOL@` succeeds on a box
# where @TOOL@ is not installed, and somebody spends an afternoon looking for a
# bug in @TOOL@ rather than installing it.
if [ -z "$real" ]; then
  echo "@TOOL@ is not installed in this session (try: apt-get install -y @TOOL@)" >&2
  exit 127
fi

# Best effort, and quiet about it. A missing credential is not a reason to
# refuse to run @TOOL@ — plenty of its commands need no token, and the ones that
# do will say so themselves, in @TOOL@'s own words rather than ours.
if creds="$(fleet-cred @PROVIDER@ 2>/dev/null)"; then
  eval "$creds"
fi

exec "$real" "$@"
