// ADDING THE RECONNECT WATCHDOG TO A XEN ORCHESTRA THAT PREDATES IT, from the
// pool master. docs/hypervisors.md, "When Xen Orchestra loses a pool".
//
// Asked for, about one installed before the watchdog, with no shell on it:
// "There has to be a way to install the watchdog via the app." Xen
// Orchestra's API can load a plugin and cannot install one, and a Xen
// Orchestra Fleetwright installs has no login by design. What does reach
// inside it is the pool master that runs its VM, with the root password the
// phone already seals for an install. So:
//
//   find   the VM, by the address Xen Orchestra answers on (what the guest
//          agent reports), or by the name an install gives it; its system
//          disk; and that the pool master can open that disk at all;
//   stop   a clean shutdown, never a forced one: a filesystem stopped
//          mid-write is the one thing worse than no watchdog;
//   add    the disk plugged into the pool master's own domain, its root
//          filesystem mounted, and xo-plugin/add-reconnect-watchdog.sh run
//          inside it with chroot and --no-restart: the same script, so what
//          it does is what the tests run, and nothing is written that the
//          script would not write from a shell. Unmounted and unplugged
//          whatever happens, by a trap;
//   start  started again if it was running before, and Xen Orchestra waited
//          for until it answers.
//
// A VM LEFT STOPPED IS THE FAILURE THAT MATTERS, so every way out of a job
// that stopped it starts it again (`restore`, which xo-setup.js runs from its
// `finally`), and the job's words say so if even that fails.
//
// Every value comes back as `fw-<key>=<base64>`, as readPool's do, so a name
// with anything in it is read as a name.

import { readFileSync } from 'node:fs';
import net from 'node:net';

import { resource } from '../../core/resources.js';
import { RECONNECT_PLUGIN, XO_VM_NAME } from './xo-deploy.js';

/** The files the add step puts inside the VM, from the install's own xo-plugin/. */
export const WATCHDOG_FILES = Object.freeze([
  'add-reconnect-watchdog.sh',
  `${RECONNECT_PLUGIN}/package.json`,
  `${RECONNECT_PLUGIN}/index.js`,
  `${RECONNECT_PLUGIN}/README.md`,
]);

/** How long a clean shutdown may take before the job gives up on it and leaves the VM running. */
const SHUTDOWN_MS = 5 * 60_000;
/** How long Xen Orchestra may take to answer once its VM is started again. */
const START_MS = 5 * 60_000;

/** @param {string} s */
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** @param {string} text */
function printable(text) {
  return String(text).replace(/\u001b\[[0-9;]*m/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim();
}

/** @param {string} out */
function said(out) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of String(out).split('\n')) {
    const m = /^fw-([a-z]+)=([A-Za-z0-9+/=]*)$/.exec(line.trim());
    if (m) values[m[1]] = Buffer.from(m[2], 'base64').toString('utf8');
  }
  return values;
}

/** @param {{ code: number|null, stdout: string, stderr: string }} r @param {string} what */
function answer(r, what) {
  const v = said(r.stdout);
  if (v.error) throw new Error(printable(v.error).slice(0, 400));
  if (r.code !== 0) throw new Error(`${what}: ${printable(String(r.stderr || r.stdout).trim().split('\n').at(-1) || 'no answer').slice(0, 200)}`);
  return v;
}

const HEAD = String.raw`
say() { printf 'fw-%s=%s\n' "$1" "$(printf %s "$2" | base64 | tr -d '\n')"; }
fail() { say error "$1"; exit 0; }
command -v xe >/dev/null 2>&1 || fail "this is not an XCP-ng or XenServer host: it has no xe command."
pool=$(xe pool-list --minimal 2>&1) || fail "$pool"
master=$(xe pool-param-get uuid="$pool" param-name=master 2>&1) || fail "$master"
# THE POOL MASTER ITSELF: Xen Orchestra's disk is opened in this host's own
# domain, and a member would be plugging it into another host's.
if [ -r /etc/xensource-inventory ]; then
  self=$(sed -n "s/^INSTALLATION_UUID='\(.*\)'$/\1/p" /etc/xensource-inventory)
  if [ -n "$self" ] && [ "$self" != "$master" ]; then
    fail "this host is a member of its pool, not the master: give the pool master's address, $(xe host-param-get uuid="$master" param-name=address 2>/dev/null). Nothing was changed."
  fi
fi
`;

/**
 * Which VM is Xen Orchestra, and its disk. `ips` are the addresses its name
 * resolves to; a VM matches when its guest agent reports one of them.
 *
 * @param {string[]} ips
 */
export function findScript(ips) {
  return `${HEAD}
ips=${q(ips.join(' '))}
found=""
for vm in $(xe vm-list is-control-domain=false is-a-template=false is-a-snapshot=false --minimal 2>/dev/null | tr ',' ' '); do
  nets="; $(xe vm-param-get uuid="$vm" param-name=networks 2>/dev/null);"
  for ip in $ips; do
    case "$nets" in *": $ip;"*) case " $found " in *" $vm "*) ;; *) found="$found $vm" ;; esac ;; esac
  done
done
found=$(echo $found)
how=address
if [ -z "$found" ]; then
  # A STOPPED VM reports no address: the name an install gives it, and only
  # if exactly one VM has it.
  named=$(xe vm-list name-label=${XO_VM_NAME} is-control-domain=false --minimal 2>/dev/null)
  case "$named" in
    "") fail "no VM on this pool reports the address Xen Orchestra answers on, and none is named ${XO_VM_NAME}. A VM reports its address only while its guest agent runs: if Xen Orchestra runs on this pool, start it, then try again. Nothing was changed." ;;
    *,*) fail "more than one VM on this pool is named ${XO_VM_NAME}, so which one is Xen Orchestra is not certain. Nothing was changed." ;;
  esac
  found=$named
  how=name
fi
case "$found" in *" "*) fail "more than one VM on this pool reports the address Xen Orchestra answers on, so which one is Xen Orchestra is not certain. Nothing was changed." ;; esac
vm=$found
state=$(xe vm-param-get uuid="$vm" param-name=power-state 2>&1) || fail "$state"
case "$state" in
  running|halted) ;;
  *) fail "Xen Orchestra's VM is $state, not running or halted. Nothing was changed." ;;
esac
vdi=$(xe vbd-list vm-uuid="$vm" type=Disk userdevice=0 params=vdi-uuid --minimal 2>/dev/null)
if [ -z "$vdi" ]; then
  vdi=$(xe vbd-list vm-uuid="$vm" type=Disk params=vdi-uuid --minimal 2>/dev/null)
  case "$vdi" in
    "") fail "Xen Orchestra's VM has no disk. Nothing was changed." ;;
    *,*) fail "Xen Orchestra's VM has more than one disk and none is its first, so which holds its system is not certain. Nothing was changed." ;;
  esac
fi
sr=$(xe vdi-param-get uuid="$vdi" param-name=sr-uuid 2>&1) || fail "$sr"
[ -n "$(xe pbd-list sr-uuid="$sr" host-uuid="$master" currently-attached=true --minimal 2>/dev/null)" ] || fail "Xen Orchestra's disk is on storage the pool master does not reach (local to another host), so it cannot be opened from here. Nothing was changed."
say vm "$vm"
say name "$(xe vm-param-get uuid="$vm" param-name=name-label 2>/dev/null)"
say state "$state"
say vdi "$vdi"
say how "$how"
`;
}

/** @param {string} vm */
export function stopScript(vm) {
  return `${HEAD}
vm=${q(vm)}
out=$(xe vm-shutdown uuid="$vm" 2>&1) || fail "Xen Orchestra's VM did not shut down cleanly ($out), so its disk was not touched. It is as it was."
state=$(xe vm-param-get uuid="$vm" param-name=power-state 2>&1)
[ "$state" = halted ] || fail "Xen Orchestra's VM says $state after shutting down, so its disk was not touched."
say state halted
`;
}

/** @param {string} vm */
export function startScript(vm) {
  return `${HEAD}
vm=${q(vm)}
out=$(xe vm-start uuid="$vm" 2>&1) || fail "Xen Orchestra's VM did not start again: $out. Start it from the pool."
say state "$(xe vm-param-get uuid="$vm" param-name=power-state 2>/dev/null)"
`;
}

/**
 * Open the disk on the pool master, put the watchdog in with the add script,
 * close it. `files` are written into the VM's /root, run from there, and
 * removed.
 *
 * @param {string} vdi
 * @param {Record<string, Buffer>} files  WATCHDOG_FILES, by path
 */
export function addScript(vdi, files) {
  const writes = Object.entries(files)
    .map(([rel, body]) => `mkdir -p "$stage/$(dirname ${q(rel)})" && printf %s ${q(body.toString('base64'))} | base64 -d >"$stage/"${q(rel)} || fail "the watchdog's files could not be written into the VM."`)
    .join('\n');
  return `${HEAD}
vdi=${q(vdi)}
dom0=$(xe vm-list is-control-domain=true resident-on="$master" --minimal 2>&1) || fail "$dom0"
[ -n "$dom0" ] || fail "the pool master did not say which domain is its own."
work=$(mktemp -d /tmp/fleetwright-watchdog.XXXXXX) || fail "the pool master could not make a temporary directory."
mnt="$work/root"
mkdir "$mnt"
vbd=""
binds=""
cleanup() {
  for b in $binds; do umount "$b" >/dev/null 2>&1; done
  mountpoint -q "$mnt" && { umount "$mnt" >/dev/null 2>&1 || umount -l "$mnt" >/dev/null 2>&1; }
  if [ -n "$vbd" ]; then
    xe vbd-unplug uuid="$vbd" >/dev/null 2>&1
    xe vbd-destroy uuid="$vbd" >/dev/null 2>&1 || say leftover "$vbd"
  fi
  rm -rf "$work"
}
trap cleanup EXIT
vbd=$(xe vbd-create vm-uuid="$dom0" vdi-uuid="$vdi" device=autodetect mode=RW type=Disk 2>&1) || { v=$vbd; vbd=""; fail "Xen Orchestra's disk could not be attached to the pool master: $v"; }
out=$(xe vbd-plug uuid="$vbd" 2>&1) || fail "Xen Orchestra's disk could not be opened on the pool master: $out"
dev="/dev/$(xe vbd-param-get uuid="$vbd" param-name=device 2>/dev/null)"
for i in $(seq 1 40); do lsblk "$dev" >/dev/null 2>&1 && break; sleep 0.25; done
lsblk "$dev" >/dev/null 2>&1 || fail "Xen Orchestra's disk was attached and never appeared on the pool master."
# THE FILESYSTEM HOLDING XEN ORCHESTRA, looked for read-only first, so a
# partition that is not it is never mounted for writing.
root=""
for p in $(lsblk -lnpo NAME "$dev" 2>/dev/null); do
  case "$(blkid -o value -s TYPE "$p" 2>/dev/null)" in ext2|ext3|ext4|xfs|btrfs) ;; *) continue ;; esac
  mount -o ro "$p" "$mnt" >/dev/null 2>&1 || continue
  if [ -e "$mnt/opt/xo/xo-server" ] || [ -d "$mnt/opt/xo-installer" ]; then root=$p; fi
  umount "$mnt" >/dev/null 2>&1
  [ -n "$root" ] && break
done
[ -n "$root" ] || fail "no filesystem on Xen Orchestra's disk holds a Xen Orchestra built from source (/opt/xo or /opt/xo-installer). The watchdog goes into one installed with XenOrchestraInstallerUpdater, as Fleetwright installs it. Its disk was not changed."
out=$(mount "$root" "$mnt" 2>&1) || fail "Xen Orchestra's filesystem could not be opened for writing on the pool master ($out). Its disk was not changed."
# ITS OWN /dev AND /proc, so the script's redirections reach a device rather
# than leave a file named /dev/null in the VM's filesystem.
for b in dev proc; do
  if [ -d "$mnt/$b" ] && mount --bind "/$b" "$mnt/$b" >/dev/null 2>&1; then binds="$mnt/$b $binds"; fi
done
stage="$mnt/root/fleetwright-watchdog"
rm -rf "$stage"
${writes}
chroot "$mnt" /bin/bash /root/fleetwright-watchdog/add-reconnect-watchdog.sh --no-restart >"$work/out" 2>&1
code=$?
rm -rf "$stage"
sync
say output "$(tail -c 2000 "$work/out")"
say code "$code"
`;
}

/**
 * The watchdog's files, from this install's xo-plugin/.
 *
 * @returns {Record<string, Buffer>}
 */
export function watchdogFiles() {
  return Object.fromEntries(WATCHDOG_FILES.map((rel) => [rel, readFileSync(resource('xo-plugin', ...rel.split('/')))]));
}

/**
 * @typedef {{ remote: (script: string, opts?: { timeoutMs?: number }) => Promise<{ code: number|null, stdout: string, stderr: string }> }} Remote
 */

/** @param {Remote} pool @param {string[]} ips */
export async function findXoVm(pool, ips) {
  const v = answer(await pool.remote(findScript(ips)), 'the pool master did not say which VM is Xen Orchestra');
  if (!v.vm || !v.vdi) throw new Error('the pool master did not say which VM is Xen Orchestra.');
  return { vm: v.vm, name: printable(v.name || '').slice(0, 80), running: v.state === 'running', vdi: v.vdi, how: v.how === 'name' ? 'name' : 'address' };
}

/** @param {Remote} pool @param {string} vm */
export async function stopXoVm(pool, vm) {
  answer(await pool.remote(stopScript(vm), { timeoutMs: SHUTDOWN_MS }), 'Xen Orchestra’s VM did not shut down');
}

/** @param {Remote} pool @param {string} vm */
export async function startXoVm(pool, vm) {
  answer(await pool.remote(startScript(vm), { timeoutMs: 3 * 60_000 }), 'Xen Orchestra’s VM did not start');
}

/**
 * @param {Remote} pool @param {string} vdi @param {Record<string, Buffer>} [files]
 * @returns {Promise<{ output: string, leftover: string|null }>}
 */
export async function addToDisk(pool, vdi, files = watchdogFiles()) {
  const v = answer(await pool.remote(addScript(vdi, files), { timeoutMs: 5 * 60_000 }), 'the watchdog was not added');
  const output = printable(v.output || '').slice(0, 1200);
  if (v.code !== '0') {
    // THE SCRIPT'S OWN WORDS: it refuses before changing anything, and says why.
    const why = /Not added: (.*)/.exec(v.output || '')?.[1] ?? (output || `the add script ended with ${v.code || 'no code'}`);
    throw new Error(`the watchdog was not added: ${printable(why).slice(0, 300)}`);
  }
  return { output, leftover: v.leftover || null };
}

/**
 * Wait until Xen Orchestra accepts a connection again at `address`, whose
 * port is 443 unless it says otherwise.
 *
 * @param {string} address
 * @param {{ limitMs?: number, everyMs?: number, signal?: AbortSignal, connect?: (host: string, port: number) => Promise<boolean> }} [opts]
 */
export async function waitForXo(address, { limitMs = START_MS, everyMs = 5_000, signal, connect = tcpOpen } = {}) {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(address);
  const host = m?.[1] ?? address;
  const port = m?.[2] ? Number(m[2]) : 443;
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    if (signal?.aborted) return false;
    if (await connect(host, port)) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

/** @param {string} host @param {number} port */
function tcpOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 4_000 });
    const done = (/** @type {boolean} */ ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

