#!/usr/bin/env node
// Boot an OPNsense nano image under QEMU and bring it up to date with the Xen
// guest agent installed, over its serial console, the way a person at a
// terminal would — because that is the only way in. The image has no SSH,
// no cloud-init and no shared folder, and this is what .github/workflows/
// edge-image.yml runs; the why is in that file's header.
//
//   node scripts/edge-image/drive.mjs --image edge.img --accel kvm \
//     --log console.log --facts facts/
//
// Everything the guest prints and everything typed at it goes to --log. What
// the guest is asked about itself (its version, its packages, where its
// default configuration file is) goes to --facts, one file per fact and all
// of them in facts.json, for scripts/edge-image/measure.mjs.
//
// WHAT THIS ASSUMES ABOUT THE CONSOLE, each a constant below so a release
// that changes one is a one-line change here and not an archaeology:
//
//   - the nano image's primary console is serial (docs.opnsense.org/manual/
//     install.html: "running in serial console (115200) mode with secondary
//     VGA support"), so getty's `login:` arrives on QEMU's serial port;
//   - root's password is the image's published default, `opnsense` (the same
//     page: "we can log into the shell using the user root with the password
//     opnsense"). It is typed into a throwaway VM and the image is cleaned
//     before it is published; the host then writes a configuration whose
//     root password is `*`, so nothing ever ships with it;
//   - logging in as root runs opnsense-shell, whose menu ends with
//     `Enter an option: ` and whose option 8 is "Shell", which is a hardcoded
//     /bin/csh (src/sbin/opnsense-shell in opnsense/core stable/26.7:
//     `CMD_SHELL="/bin/csh"`). csh's `$?` is not an exit status, so the first
//     thing typed into it is `exec /bin/sh`, and every command after that is
//     POSIX sh with a sentinel (console.mjs);
//   - the stock configuration names interfaces `mismatch0` and `mismatch1`
//     (test/fixtures/opnsense-26.7-config.xml), so first boot runs the
//     automatic assignment: "Press any key to start the manual interface
//     assignment", seven seconds, nobody presses, and LAN is the first
//     interface and WAN the second (src/etc/inc/console.inc: "put LAN as
//     first one", "put WAN as second one"). QEMU's two virtio NICs are
//     vtnet0 and vtnet1 in command-line order, so the second gets the
//     user-mode network with a DHCP server and a way out, and the first is
//     user-mode with `restrict=on`, which is a wire nobody is on.
//
// Nothing is typed until a prompt asks for it. The boot loader's countdown
// takes any key as "stop and give me a prompt", so typing early would hang
// the boot with no error, which is why `login:` is waited for and not a
// delay.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { Console } from './console.mjs';

/** What the console says, and when. */
export const PROMPTS = Object.freeze({
  /** getty on the serial line. */
  login: /login: $/,
  password: /Password: ?$/,
  /** opnsense-shell: `read -p "Enter an option: " OPCODE`. */
  menu: /Enter an option: $/,
  /** /bin/csh after option 8, `root@OPNsense:~ # `. */
  csh: /# $/,
  /** FreeBSD when ACPI power-off did not take: the VM is finished either way. */
  halted: /The operating system has halted|Please press any key to reboot/,
});

/** The published defaults, see the header. */
export const LOGIN = Object.freeze({ user: 'root', password: 'opnsense', shellOption: '8' });

const MINUTE = 60_000;
/** How long each thing may take. Generous for TCG; a KVM run uses a fraction. */
export const WAITS = Object.freeze({
  /** Power on, or reboot, to `login:`. First boot converts the configuration and assigns interfaces. */
  boot: 25 * MINUTE,
  prompt: 3 * MINUTE,
  command: 10 * MINUTE,
  /** The whole package set from pkg.opnsense.org through user-mode networking. */
  update: 45 * MINUTE,
  poweroff: 5 * MINUTE,
});

/** What runs inside, in order, with why; the values are shell. */
export const INSIDE = Object.freeze({
  /**
   * Packages first, then base and kernel, which is the order OPNsense's own
   * update takes (src/opnsense/scripts/firmware/update.sh in opnsense/core
   * stable/26.7: `opnsense-update ${FORCE} -pt "opnsense${SUFFIX}"`, then
   * `if opnsense-update ${FORCE} -bk -c; then ... opnsense-update ${FORCE}
   * -bk; output_reboot`). `-t opnsense` is the release type a stock image
   * has (system.firmware.type is empty, so the suffix is empty), `-c` asks
   * without installing, and the man page (opnsense-update.8) says of `-bkp`
   * only that it "is used to update all currently installed components at
   * once" — the GUI's two steps are kept here so the log says which half did
   * what.
   */
  packages: 'opnsense-update -pt opnsense',
  baseKernelCheck: 'opnsense-update -bk -c',
  baseKernel: 'opnsense-update -bk',
  /**
   * The agent, installed the way OPNsense installs a plugin from its own UI
   * (src/opnsense/scripts/firmware/install.sh, stable/26.7):
   *
   *   output_cmd ${PKG} install -y "${PACKAGE}"
   *   output_cmd ${BASEDIR}/register.php install "${PACKAGE}"
   *   output_cmd ${PKG} autoremove -y
   *
   * and the way the daily update would have (sync.subr.sh, the same two
   * lines for each plugin named in system.firmware.plugins and not yet
   * installed). Not `pluginctl -s`: that sets a configuration value and
   * installs nothing. register.php records the plugin in /conf/config.xml,
   * which this build removes at the end; the package stays, and the host's
   * configuration names os-xen in system.firmware.plugins (EDGE_UPDATES), so
   * the router's first sync finds it installed and leaves it.
   */
  agent: ['pkg install -y os-xen', '/usr/local/opnsense/scripts/firmware/register.php install os-xen', 'pkg autoremove -y'],
  /**
   * What identifies this boot, gone. Each is a thing the image either
   * regenerates (SSH host keys, the host id, entropy) or should not carry
   * from a build VM into a fleet (package caches, logs, leases, history).
   * `rm -f` throughout: an absent path is the state wanted, not an error.
   *
   * /var/log is a tmpfs here (use_mfs_var in the stock configuration mounts
   * one on /var/log, src/etc/rc.subr.d/var), so the on-disk directory under
   * it holds only what the image shipped with; the unmount is tried so the
   * rm reaches the disk, and is allowed to fail busy.
   */
  cleanup: [
    'pkg clean -ay',
    'rm -rf /var/cache/pkg/* /var/cache/opnsense-update/*',
    'rm -f /var/db/pkg/repo-*.sqlite',
    'rm -f /root/.history /root/.sh_history /root/.csh_history /root/.lesshst',
    'rm -f /usr/local/etc/ssh/ssh_host_* /conf/sshd/ssh_host_*',
    'rm -f /var/db/dhclient.leases.* /var/dhcpd/var/db/dhcpd.leases*',
    'rm -f /etc/hostid /entropy /boot/entropy /var/db/entropy/*',
    'rm -rf /var/crash/* /var/tmp/*',
    'umount /var/log 2>/dev/null; rm -rf /var/log/*; true',
  ],
  /**
   * THE LAST THING BEFORE POWER-OFF, and the one that makes the image an
   * image again. The host writes its configuration into /usr/local/etc/
   * config.xml and relies on the importer copying it to /conf/config.xml on
   * a boot that has none (src/sbin/opnsense-importer: `if [ ! -f /conf/
   * config.xml ]; then cp /usr/local/etc/config.xml /conf/config.xml`).
   * This VM has booted, so it has one, and if it shipped the host's
   * configuration would be ignored in favour of the build VM's. The upstream
   * image has no /conf/config.xml; neither does this one.
   */
  forget: 'rm -f /conf/config.xml /.probe.for.readonly; rm -rf /conf/backup/*; sync; sync',
  poweroff: 'shutdown -p now',
});

/**
 * The facts asked of the guest, each a command whose first line of output is
 * the answer. `sha256 -q` and `stat -f` are FreeBSD's spellings.
 */
export const FACTS = Object.freeze({
  'opnsense-version': 'opnsense-version -v',
  'core-package': 'opnsense-version -n',
  'freebsd-version': 'freebsd-version -kru | tr "\\n" " "',
  uname: 'uname -a',
  'os-xen': 'pkg query %v os-xen',
  'config-inode': 'stat -f %i /usr/local/etc/config.xml',
  'config-length': 'stat -f %z /usr/local/etc/config.xml',
  'config-sha256': 'sha256 -q /usr/local/etc/config.xml',
  'config-owner': 'pkg which -q /usr/local/etc/config.xml 2>/dev/null || echo none',
  'conf-dir': 'ls -la /conf | tr "\\n" ";"',
});

/** @param {string[]} argv */
export function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      image: { type: 'string' },
      accel: { type: 'string', default: 'tcg' },
      log: { type: 'string', default: 'console.log' },
      facts: { type: 'string', default: 'facts' },
      cpus: { type: 'string', default: '2' },
      memory: { type: 'string', default: '2048' },
      qemu: { type: 'string', default: 'qemu-system-x86_64' },
    },
  });
  if (!values.image) throw new Error('usage: drive.mjs --image <raw disk> [--accel kvm|tcg] [--log file] [--facts dir] [--cpus n] [--memory MiB] [--qemu binary]');
  if (values.accel !== 'kvm' && values.accel !== 'tcg') throw new Error(`--accel is kvm or tcg, not ${values.accel}`);
  return /** @type {{ image: string, accel: 'kvm'|'tcg', log: string, facts: string, cpus: string, memory: string, qemu: string }} */ (values);
}

/**
 * QEMU's command line. The raw disk on virtio-blk as the host attaches it
 * (a VBD on Xen is a different bus, but the file system does not know), two
 * virtio NICs in the order that makes the second the WAN, serial on stdio
 * so the driver has it as pipes, no display and no monitor to multiplex in.
 * The clock is UTC and real: TLS to the package mirror needs the date.
 *
 * @param {ReturnType<typeof options>} o
 */
export function qemuArgs(o) {
  return [
    '-accel', o.accel,
    '-cpu', o.accel === 'kvm' ? 'host' : 'max',
    '-smp', o.cpus,
    '-m', o.memory,
    '-rtc', 'base=utc,clock=host',
    '-display', 'none',
    '-monitor', 'none',
    '-serial', 'stdio',
    '-drive', `file=${o.image},format=raw,if=virtio,cache=writeback`,
    '-netdev', 'user,id=lan,restrict=on',
    '-device', 'virtio-net-pci,netdev=lan',
    '-netdev', 'user,id=wan',
    '-device', 'virtio-net-pci,netdev=wan',
    '-boot', 'c',
  ];
}

/**
 * The console menu to a POSIX shell, from a `login:` prompt.
 *
 * @param {Console} c
 */
async function login(c) {
  await c.waitFor(PROMPTS.login, { timeout: WAITS.boot, label: 'the login prompt' });
  c.type(LOGIN.user);
  await c.waitFor(PROMPTS.password, { timeout: WAITS.prompt, label: 'the password prompt' });
  c.type(LOGIN.password);
  await c.waitFor(PROMPTS.menu, { timeout: WAITS.prompt, label: 'the console menu' });
  c.type(LOGIN.shellOption);
  await c.waitFor(PROMPTS.csh, { timeout: WAITS.prompt, label: 'csh’s prompt' });
  c.type('exec /bin/sh');
  // The first sentinel proves a POSIX shell is the one answering.
  await c.must('true', { timeout: WAITS.prompt, label: 'a POSIX shell answering' });
}

/**
 * Reboot and come back to a shell. `shutdown -r` prints and goes; nothing
 * is waited for but the next login prompt.
 *
 * @param {Console} c
 */
async function reboot(c) {
  c.type('shutdown -r now');
  await login(c);
}

/**
 * @param {Console} c @param {Record<string, string>} facts
 */
async function update(c, facts) {
  facts['version-before'] = (await c.must('opnsense-version -v', { timeout: WAITS.prompt })).output.trim();
  const pkgs = await c.must(INSIDE.packages, { timeout: WAITS.update, label: 'the package update' });
  facts['update-packages'] = pkgs.output;
  const check = await c.run(INSIDE.baseKernelCheck, { timeout: WAITS.command, label: 'asking about base and kernel' });
  facts['update-base-kernel-check'] = `exit ${check.status}\n${check.output}`;
  if (check.status === 0) {
    const bk = await c.must(INSIDE.baseKernel, { timeout: WAITS.update, label: 'the base and kernel update' });
    facts['update-base-kernel'] = bk.output;
  } else {
    facts['update-base-kernel'] = 'none offered';
  }
  // Always one reboot, whether or not the kernel moved: it is the one thing
  // a build cannot otherwise show about the image it just changed, that it
  // comes back to a login prompt, and it is the state a router boots into.
  await reboot(c);
  // And nothing left to do, which is what "current patch level" means. The
  // second package run is required to succeed; the second check is required
  // to find nothing, else the first did not take.
  const again = await c.must(INSIDE.packages, { timeout: WAITS.update, label: 'the package update, the second time' });
  facts['update-packages-again'] = again.output;
  const still = await c.run(INSIDE.baseKernelCheck, { timeout: WAITS.command, label: 'asking about base and kernel again' });
  facts['update-base-kernel-check-again'] = `exit ${still.status}\n${still.output}`;
  if (still.status === 0) throw new Error(`after the update and a reboot, \`${INSIDE.baseKernelCheck}\` still offers one:\n${still.output}`);
}

/** @param {Console} c @param {Record<string, string>} facts */
async function installAgent(c, facts) {
  for (const cmd of INSIDE.agent) facts[`agent: ${cmd}`] = (await c.must(cmd, { timeout: WAITS.command })).output;
  // Installed is a claim; the package database answering is the evidence,
  // and the files the agent's package put down are recorded for the person
  // reading the manifest.
  await c.must('pkg info os-xen >/dev/null', { timeout: WAITS.prompt, label: 'os-xen in the package database' });
  facts['agent-files'] = (await c.run('pkg info -ql xe-guest-utilities 2>/dev/null || pkg info -ql os-xen', { timeout: WAITS.prompt })).output;
}

/** @param {Console} c @param {Record<string, string>} facts */
async function cleanup(c, facts) {
  for (const cmd of INSIDE.cleanup) facts[`cleanup: ${cmd}`] = (await c.must(cmd, { timeout: WAITS.command })).output;
}

/**
 * What the guest says about itself, read after the update and the agent so
 * it describes the image that ships. Also written inside as
 * /tmp/manifest-in-vm.txt and read back over the console, so the log holds
 * the same facts in the guest's own words.
 *
 * @param {Console} c @param {Record<string, string>} facts
 */
async function gather(c, facts) {
  for (const [name, cmd] of Object.entries(FACTS)) {
    const r = await c.run(cmd, { timeout: WAITS.prompt, label: name });
    facts[name] = r.output.trim();
    if (r.status !== 0) throw new Error(`${name} (\`${cmd}\`) exited ${r.status}: ${r.output.trim()}`);
  }
  const pkgs = await c.must("pkg query '%n-%v' | sort", { timeout: WAITS.command, label: 'the package list' });
  facts.packages = pkgs.output.trim();
  // One short line per fact rather than one long one: a tty in canonical
  // mode has a line limit, and FreeBSD's is not generous.
  await c.must(': > /tmp/manifest-in-vm.txt', { timeout: WAITS.prompt, label: 'starting the manifest inside' });
  for (const [n, cmd] of Object.entries(FACTS)) {
    await c.must(`{ printf '%s: ' '${n}'; ${cmd}; } >> /tmp/manifest-in-vm.txt 2>&1`, { timeout: WAITS.prompt, label: `${n}, inside` });
  }
  await c.must("pkg query '%n-%v' | sort >> /tmp/manifest-in-vm.txt", { timeout: WAITS.command, label: 'the package list, inside' });
  facts['manifest-in-vm'] = (await c.must('cat /tmp/manifest-in-vm.txt', { timeout: WAITS.command, label: 'reading the manifest back' })).output;
}

/**
 * @param {Console} c @param {import('node:child_process').ChildProcess} qemu
 * @returns {Promise<number|null>} QEMU's exit code
 */
async function poweroff(c, qemu) {
  c.type(INSIDE.poweroff);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      qemu.kill('SIGKILL');
      reject(new Error(`QEMU did not exit within ${WAITS.poweroff / MINUTE} minutes of \`${INSIDE.poweroff}\``));
    }, WAITS.poweroff);
    // Halted without powering off: the disks are synced and the VM is done,
    // so it is stopped from outside, and an exit by that signal is the
    // success it asked for rather than a crash.
    let halted = false;
    c.waitFor(PROMPTS.halted, { timeout: WAITS.poweroff, label: 'the halt' }).then(() => {
      halted = true;
      qemu.kill('SIGTERM');
    }, () => {});
    // `close`, not `exit`: the pipes can still hold the guest's last lines
    // after the process is gone, and the log wants them.
    qemu.once('close', (code) => {
      clearTimeout(timer);
      resolve(halted && code === null ? 0 : code);
    });
  });
}

/**
 * @param {string[]} argv
 * @param {{ out?: { write: (s: string) => unknown } }} [io]  where progress is said, stdout unless a test listens instead
 */
export async function main(argv, { out = process.stdout } = {}) {
  const o = options(argv);
  mkdirSync(o.facts, { recursive: true });
  mkdirSync(path.dirname(path.resolve(o.log)), { recursive: true });
  const logFile = createWriteStream(o.log);
  const log = (/** @type {string} */ t) => {
    if (!logFile.writableEnded) logFile.write(t);
  };
  const say = (/** @type {string} */ s) => {
    out.write(`${s}\n`);
    log(`\n=== ${s} ===\n`);
  };
  const args = qemuArgs(o);
  say(`${o.qemu} ${args.join(' ')}`);
  const qemu = spawn(o.qemu, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const c = new Console({ send: (t) => qemu.stdin.write(t), log });
  qemu.stdout.on('data', (d) => c.feed(d));
  qemu.stderr.on('data', (d) => log(`[qemu] ${d}`));
  qemu.on('close', () => c.close());
  qemu.on('error', (e) => {
    log(`[qemu] ${e.message}\n`);
    c.close();
  });

  /** @type {Record<string, string>} */
  const facts = { accel: o.accel };
  try {
    say('first boot');
    await login(c);
    say('update');
    await update(c, facts);
    say('the agent');
    await installAgent(c, facts);
    say('cleanup');
    await cleanup(c, facts);
    say('facts');
    await gather(c, facts);
    say('forgetting this boot');
    await c.must(INSIDE.forget, { timeout: WAITS.command, label: 'forgetting this boot' });
    say('power off');
    const code = await poweroff(c, qemu);
    facts['qemu-exit'] = String(code);
    if (code !== 0) throw new Error(`QEMU exited ${code}`);
  } finally {
    // Whatever was learned is written even on the way out, so a failed run
    // still says how far it got and what the guest answered.
    for (const [k, v] of Object.entries(facts)) writeFileSync(path.join(o.facts, `${k.replace(/[^A-Za-z0-9._-]+/g, '_')}.txt`), `${v}\n`);
    writeFileSync(path.join(o.facts, 'facts.json'), `${JSON.stringify(facts, null, 2)}\n`);
    if (qemu.exitCode === null) qemu.kill('SIGKILL');
    logFile.end();
  }
  say(`done: OPNsense ${facts['opnsense-version']}, os-xen ${facts['os-xen']}, configuration inode ${facts['config-inode']} (${facts['config-length']} bytes, sha256 ${facts['config-sha256']})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
