#!/usr/bin/env bash
# The coordinator container, built and driven — the proof behind the paragraph.
#
# WHY THIS EXISTS. worker/Containerfile says what has been proven of it: built,
# started, driven through /healthz, /api/hosts and pin minting, state surviving
# a restart. That sentence was true the evening it was written, on one person's
# machine, and nothing kept it true. The image is a Dockerfile plus a workerd
# config plus a bundle, and each of those changes for reasons that have nothing
# to do with the container — a new `env.FLEETWRIGHT_*` the capnp does not map
# is the one failure workerd.capnp names as "the one this file can have", and
# it is silent: the variable is simply never seen.
#
# So this is the paragraph, as a script, run by worker.yml on every change to
# the bundle. It does what an operator following coordinator-deploy.md does,
# and then what a host does:
#
#   1. build the image from the repository root
#   2. start it with a volume, an admin token, and a public origin
#   3. /healthz answers; /api/hosts answers the admin token
#   4. mint a pin — the reply carries the one-line install command, with the
#      pin as an environment variable and not in the URL
#   5. enrol a REAL host with it — bin/fleetwright-sidecar, the code a box
#      ships, not a curl that imitates it — and ask the coordinator, the way
#      `doctor` does, whether it knows the host
#   6. restart the container: the host is still known, and a pin minted BEFORE
#      the restart still spends AFTER it, so the Durable Object's SQLite is on
#      the volume and not in the container's own filesystem
#   7. the spent pin refuses a second host — single-use survives the restart too
#   8. the sidecar's own transport holds a socket open: Node's WebSocket with
#      the proof headers, and its heartbeat answered by the runtime's
#      auto-response — the frame every host sends for weeks, proven against
#      real workerd rather than the Node harness
#
# ENGINE-AGNOSTIC. CI has docker; the box this was first proven on has podman;
# the two take the same verbs for everything used here. CONTAINER_ENGINE names
# one, otherwise whichever is installed is used, docker first.
#
# Run it from the repository root, with the root dependencies installed (the
# sidecar imports `jose` from node_modules):
#
#   npm ci && scripts/container-smoke.sh
#
# CONTAINER_BUILD_ARGS is appended to the build, for a box whose outbound TLS
# is intercepted and needs its CA bundle mounted into the build stage; CI needs
# nothing there. SMOKE_BIND and SMOKE_PORT pick where the container is
# published (127.0.0.1:18787 by default) for a machine where loopback publishing
# is not reachable from the host side.
set -euo pipefail

ENGINE="${CONTAINER_ENGINE:-}"
if [ -z "$ENGINE" ]; then
  if command -v docker >/dev/null 2>&1; then ENGINE=docker
  elif command -v podman >/dev/null 2>&1; then ENGINE=podman
  else echo "neither docker nor podman is on PATH — nothing to build the container with" >&2; exit 2
  fi
fi
command -v node >/dev/null 2>&1 || { echo "node is not on PATH — the sidecar needs it to enrol" >&2; exit 2; }
[ -f worker/Containerfile ] || { echo "run this from the repository root: worker/Containerfile is not here" >&2; exit 2; }
[ -d node_modules/jose ] || { echo "node_modules/jose is missing — run npm ci first; the sidecar imports it" >&2; exit 2; }

BIND="${SMOKE_BIND:-127.0.0.1}"
PORT="${SMOKE_PORT:-18787}"
URL="http://$BIND:$PORT"
TAG="${SMOKE_IMAGE:-fleetwright-coordinator:smoke}"
# Unique per run, so two runs on one machine — or a run that died before its
# cleanup — never share state and never fight over a name.
RUN_ID="$$-$(date +%s)"
NAME="fleetwright-smoke-$RUN_ID"
VOLUME="fleetwright-smoke-state-$RUN_ID"
TOKEN="smoke-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
WORK="$(mktemp -d)"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
die()  { printf '\n  FAIL %s\n\n' "$*" >&2; "$ENGINE" logs "$NAME" 2>&1 | tail -n 40 | sed 's/^/  | /' >&2 || true; exit 1; }

cleanup() {
  "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
  "$ENGINE" volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- the admin's side: curl with the token ------------------------------------
api() { # api METHOD PATH [JSON]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' --data "$body" "$URL$path"
  else
    curl -sS -X "$method" -H "authorization: Bearer $TOKEN" "$URL$path"
  fi
}
# One JSON field out of a reply, without jq — node is already required.
field() { node -e 'const b=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],b);process.stdout.write(v==null?"":String(v))' "$1"; }

wait_healthy() {
  local i
  for i in $(seq 1 60); do
    if curl -fsS "$URL/healthz" >"$WORK/healthz.json" 2>/dev/null; then return 0; fi
    sleep 0.5
  done
  return 1
}

# --- the host's side: the sidecar itself ---------------------------------------
# No /etc file, a key in the work directory, a name we choose. The coordinator
# URL is the one the container is published on.
sidecar() { # sidecar HOST_ID VERB [ARGS]
  local host="$1"; shift
  FLEETWRIGHT_SIDECAR_ENV_FILE=/dev/null \
  FLEETWRIGHT_COORDINATOR_URL="$URL" \
  FLEETWRIGHT_HOST_ID="$host" \
  FLEETWRIGHT_HOST_KEY="$WORK/$host/host-key.json" \
    node bin/fleetwright-sidecar "$@"
}
# What `fleetwright-sidecar doctor` asks the coordinator, and nothing else: it
# asks the hub too, and there is no hub here. Same function, same signature.
known() { # known HOST_ID → prints ok|<reason>
  FLEETWRIGHT_COORDINATOR_URL="$URL" node --input-type=module -e '
    import { loadOrCreateKey, checkEnrolled } from "./src/fleet/host/identity.js";
    const [hostId, keyFile] = process.argv.slice(1);
    const key = await loadOrCreateKey(keyFile);
    const r = await checkEnrolled({ origin: process.env.FLEETWRIGHT_COORDINATOR_URL, hostId, privateJwk: key.privateJwk });
    process.stdout.write(r.ok ? "ok" : String(r.reason));
  ' "$1" "$WORK/$1/host-key.json"
}

step "Building worker/Containerfile with $ENGINE"
# shellcheck disable=SC2086 — CONTAINER_BUILD_ARGS is a list by design
"$ENGINE" build -f worker/Containerfile -t "$TAG" ${CONTAINER_BUILD_ARGS:-} . >"$WORK/build.log" 2>&1 \
  || { tail -n 40 "$WORK/build.log" >&2; echo "the image did not build" >&2; exit 1; }
ok "$TAG"

step "Starting it with a volume on /data"
"$ENGINE" volume create "$VOLUME" >/dev/null
"$ENGINE" run -d --name "$NAME" -p "$BIND:$PORT:8787" -v "$VOLUME:/data" \
  -e "FLEETWRIGHT_API_TOKEN=$TOKEN" \
  -e "FLEETWRIGHT_PUBLIC_ORIGIN=$URL" \
  -e "FLEETWRIGHT_INSTALL_URL=https://example.invalid/install/bootstrap.sh" \
  "$TAG" >/dev/null
wait_healthy || die "/healthz did not answer within 30s"
ok "/healthz: $(cat "$WORK/healthz.json")"

step "The admin token is honoured"
api GET /api/hosts >"$WORK/hosts.json" || die "GET /api/hosts failed"
[ "$(field ok <"$WORK/hosts.json")" = true ] || die "GET /api/hosts did not say ok: $(cat "$WORK/hosts.json")"
ok "/api/hosts answers the token"
# And refuses without it — a coordinator that answers everyone is the failure
# the 503-without-credentials rule exists to prevent.
status="$(curl -sS -o /dev/null -w '%{http_code}' "$URL/api/hosts")"
[ "$status" = 401 ] || die "GET /api/hosts without a token answered $status, not 401"
ok "and refuses without it (401)"

step "Minting a pin"
api POST /api/enroll '{"label":"smoke"}' >"$WORK/pin1.json" || die "POST /api/enroll failed"
CODE1="$(field code <"$WORK/pin1.json")"
INSTALL="$(field install <"$WORK/pin1.json")"
[[ "$CODE1" =~ ^[0-9]{6}$ ]] || die "no six-digit code in $(cat "$WORK/pin1.json")"
case "$INSTALL" in
  *"FLEETWRIGHT_ENROL_PIN=$CODE1 sh"*) ;;
  *) die "the install line does not carry the pin as an environment variable: $INSTALL" ;;
esac
case "$INSTALL" in
  *"pin="*|*"$CODE1/"*) die "the pin is in the URL: $INSTALL" ;;
esac
ok "$INSTALL"

step "A real host enrols with it"
mkdir -p "$WORK/smoke-one"
sidecar smoke-one enrol "$CODE1" >"$WORK/enrol1.log" 2>&1 || { cat "$WORK/enrol1.log" >&2; die "fleetwright-sidecar enrol failed"; }
grep -q "^enrolled smoke-one at $URL" "$WORK/enrol1.log" || die "unexpected enrol output: $(cat "$WORK/enrol1.log")"
[ -f "$WORK/smoke-one/host-id.json" ] || die "the sidecar did not record its assigned name beside the key"
[ "$(known smoke-one)" = ok ] || die "the coordinator does not know smoke-one after enrolling: $(known smoke-one)"
ok "enrolled, and the coordinator vouches for the key"

step "A second pin, minted before the restart"
api POST /api/enroll '{"label":"smoke, after restart"}' >"$WORK/pin2.json" || die "second POST /api/enroll failed"
CODE2="$(field code <"$WORK/pin2.json")"
[[ "$CODE2" =~ ^[0-9]{6}$ ]] || die "no six-digit code in $(cat "$WORK/pin2.json")"
ok "pin $CODE2 is pending"

step "Restarting the container"
"$ENGINE" restart "$NAME" >/dev/null
wait_healthy || die "/healthz did not answer within 30s of the restart"
ok "back up"

step "State survived: the host is still known, the pin still spends"
[ "$(known smoke-one)" = ok ] || die "the restart forgot smoke-one — /data is not where the Durable Object writes: $(known smoke-one)"
ok "smoke-one is still enrolled"
mkdir -p "$WORK/smoke-two"
sidecar smoke-two enrol "$CODE2" >"$WORK/enrol2.log" 2>&1 || { cat "$WORK/enrol2.log" >&2; die "the pin minted before the restart did not spend after it"; }
[ "$(known smoke-two)" = ok ] || die "smoke-two enrolled but is not known: $(known smoke-two)"
ok "smoke-two enrolled with the pre-restart pin"
api GET /api/hosts/enrolled >"$WORK/enrolled.json"
grep -q '"smoke-one"' "$WORK/enrolled.json" && grep -q '"smoke-two"' "$WORK/enrolled.json" \
  || die "/api/hosts/enrolled does not list both: $(cat "$WORK/enrolled.json")"
ok "/api/hosts/enrolled lists both"

step "A spent pin is spent"
mkdir -p "$WORK/smoke-three"
if sidecar smoke-three enrol "$CODE1" >"$WORK/enrol3.log" 2>&1; then
  die "the pin smoke-one spent was accepted a second time"
fi
grep -q "enrolment failed" "$WORK/enrol3.log" || die "unexpected refusal: $(cat "$WORK/enrol3.log")"
ok "refused: $(sed -n 's/^enrolment failed: //p' "$WORK/enrol3.log" | head -n 1)"

step "A host holds the socket, and its heartbeats are answered"
# The transport a real sidecar runs, with its heartbeat turned up from every
# twenty seconds to every 300ms, for three seconds: enough to see several pongs
# come back from the runtime's auto-response and the host listed as connected.
FLEETWRIGHT_COORDINATOR_URL="$URL" node --input-type=module -e '
  import { loadOrCreateKey, proveIdentity } from "./src/fleet/host/identity.js";
  import { WebSocketTransport } from "./src/fleet/host/transports/websocket.js";
  const [hostId, keyFile] = process.argv.slice(1);
  const origin = process.env.FLEETWRIGHT_COORDINATOR_URL;
  const key = await loadOrCreateKey(keyFile);
  const warned = [];
  const transport = new WebSocketTransport({
    origin, hostId,
    proof: () => proveIdentity({ origin, hostId, privateJwk: key.privateJwk }),
    logger: { debug() {}, info() {}, warn: (m) => warned.push(m), error: (m) => warned.push(m) },
    pingIntervalMs: 300, pongGraceMs: 250,
  });
  await transport.start();
  await new Promise((r) => setTimeout(r, 3000));
  const up = transport.connected;
  const beats = transport.heartbeats;
  await transport.stop();
  if (!up) { console.error("the socket did not stay up: " + warned.join(" | ")); process.exit(1); }
  if (beats < 3) { console.error("only " + beats + " heartbeats were answered in 3s: " + warned.join(" | ")); process.exit(1); }
  if (warned.length) { console.error("the transport warned: " + warned.join(" | ")); process.exit(1); }
  process.stdout.write(String(beats));
' smoke-one "$WORK/smoke-one/host-key.json" >"$WORK/beats.txt" 2>"$WORK/beats.err" || { cat "$WORK/beats.err" >&2; die "the transport did not hold its socket against the container"; }
ok "smoke-one held the socket for 3s and $(cat "$WORK/beats.txt") heartbeats were answered"

printf '\n\033[1mcontainer smoke passed\033[0m — %s, %s\n\n' "$ENGINE" "$TAG"
