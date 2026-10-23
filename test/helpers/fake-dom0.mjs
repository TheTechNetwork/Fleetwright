// A pool master's own domain, for test/xo-watchdog.test.js: `xe` and the few
// block-device tools adding the watchdog uses (lsblk, blkid, mount, umount,
// mountpoint, chroot), each a shell wrapper the test writes that runs this
// file with its role first.
//
// WHAT IT HOLDS TO, because xo-watchdog.js depends on these and a fake that
// shrugged at them would prove nothing:
//
//   - a VM's power state moves only on vm-shutdown and vm-start, and a disk
//     is plugged into the pool master's domain only between vbd-create and
//     vbd-destroy;
//   - a VBD may not be plugged while the VM whose disk it is runs, as XAPI
//     refuses a disk attached read-write twice;
//   - a filesystem is mounted at the place it was mounted, and mountpoint
//     says so; mounting for writing is recorded apart from read-only;
//   - chroot sees only what was written under the root it is given.
//
// Every call is appended to the log, so a test can say what was asked, and
// in which order.

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [role, ...argv] = process.argv.slice(2);
const statePath = String(process.env.FAKE_DOM0_STATE);
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
appendFileSync(state.log, `${JSON.stringify({ role, argv })}\n`);

/** @param {string} why */
const refuse = (why, code = 1) => {
  process.stderr.write(`${why}\n`);
  process.exit(code);
};
/** `key=value` arguments, as xe takes them. */
const kv = Object.fromEntries(argv.filter((a) => a.includes('=')).map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
const out = (/** @type {string} */ s) => process.stdout.write(`${s}\n`);

if (role === 'xe') xe(argv[0]);
else if (role === 'lsblk') lsblk();
else if (role === 'blkid') out(argv.at(-1) === state.rootPart ? state.fs : '');
else if (role === 'mount') mount();
else if (role === 'umount') umount();
else if (role === 'mountpoint') process.exit(state.mounts[argv.at(-1)] ? 0 : 1);
else if (role === 'chroot') chroot();

/** @param {string} cmd */
function xe(cmd) {
  const vm = state.vms[kv.uuid];
  switch (cmd) {
    case 'pool-list': return out('pool-1');
    case 'pool-param-get': return out('host-master');
    case 'host-param-get': return out('192.0.2.1');
    case 'vm-list': {
      if (kv['is-control-domain'] === 'true') return out('dom0-uuid');
      const ids = Object.keys(state.vms).filter((id) => !kv['name-label'] || state.vms[id].name === kv['name-label']);
      return out(ids.join(','));
    }
    case 'vm-param-get': {
      if (!vm) refuse(`The uuid you supplied was invalid.`);
      const p = kv['param-name'];
      if (p === 'networks') return out(vm.running ? vm.networks : '');
      if (p === 'power-state') return out(vm.running ? 'running' : 'halted');
      if (p === 'name-label') return out(vm.name);
      return refuse(`no param ${p}`);
    }
    case 'vm-shutdown':
      if (state.shutdownRefuses) refuse('VM_FAILED_SHUTDOWN_ACKNOWLEDGMENT');
      vm.running = false;
      return save();
    case 'vm-start':
      if (state.vbd) refuse('VDI_IN_USE: the disk is attached elsewhere');
      if (state.startRefuses) refuse('HOST_NOT_ENOUGH_FREE_MEMORY');
      vm.running = true;
      return save();
    case 'vbd-list': {
      const v = state.vms[kv['vm-uuid']];
      return out(v ? v.vdi : '');
    }
    case 'vdi-param-get': return out('sr-1');
    case 'pbd-list': return out(state.srUnreachable ? '' : 'pbd-1');
    case 'vbd-create': {
      const owner = Object.values(state.vms).find((/** @type {any} */ v) => v.vdi === kv['vdi-uuid']);
      if (owner?.running) refuse('VDI_IN_USE: the VDI is attached read-write to a running VM');
      state.vbd = 'vbd-9';
      save();
      return out('vbd-9');
    }
    case 'vbd-plug': state.plugged = true; return save();
    case 'vbd-param-get': return out('xvdb');
    case 'vbd-unplug': state.plugged = false; return save();
    case 'vbd-destroy':
      if (state.plugged) refuse('VBD still plugged');
      state.vbd = null;
      return save();
    default: return refuse(`fake xe: nothing for ${cmd}`);
  }
}

function lsblk() {
  if (!state.vbd || !state.plugged) process.exit(32);
  if (argv.includes('-lnpo')) return out(`/dev/xvdb\n${state.rootPart}`);
}

function mount() {
  if (argv[0] === '--bind') {
    state.mounts[argv[2]] = 'bind';
    return save();
  }
  const ro = argv[0] === '-o' && argv[1] === 'ro';
  const [dev, at] = argv.slice(ro ? 2 : 0);
  if (dev !== state.rootPart) refuse(`mount: ${dev}: wrong fs type`, 32);
  if (!ro && state.mountRefuses) refuse('mount: cannot mount read-write: unsupported feature(s)', 32);
  // THE VM'S FILESYSTEM, as it is to be found: Xen Orchestra built from source.
  for (const d of ['opt/xo-installer', 'root', 'dev', 'proc']) mkdirSync(path.join(at, d), { recursive: true });
  state.mounts[at] = ro ? 'ro' : 'rw';
  state.everRw = state.everRw || !ro;
  save();
}

function umount() {
  const at = argv.at(-1);
  if (!state.mounts[at]) refuse(`umount: ${at}: not mounted`, 32);
  if (state.mounts[at] !== 'bind' && Object.keys(state.mounts).some((m) => m !== at && m.startsWith(`${at}/`))) refuse(`umount: ${at}: target is busy`, 32);
  delete state.mounts[at];
  save();
}

function chroot() {
  const [root, ...cmd] = argv;
  if (state.mounts[root] !== 'rw') refuse(`chroot: ${root} is not the filesystem, mounted for writing`, 125);
  const stage = path.join(root, 'root', 'fleetwright-watchdog');
  // WHAT THE SCRIPT WAS HANDED, kept for the test, as the VM would keep it.
  rmSync(state.seen, { recursive: true, force: true });
  if (existsSync(stage)) cpSync(stage, state.seen, { recursive: true });
  state.ran = cmd;
  save();
  process.stdout.write(state.chrootSays);
  process.exit(state.chrootCode);
}
