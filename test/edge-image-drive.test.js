// The edge image driver's whole conversation with a guest, without QEMU: a
// fake OPNsense on stdio that prompts the way the real console does and
// answers each command, so the order the driver does things in — log in,
// update, reboot, log in again, the agent, cleanup, facts, forget, power
// off — is checked here and not for the first time on a 90-minute CI run.
//
//   node --test test/edge-image-drive.test.js
//
// What the fake is NOT evidence of: that the real console prints these
// prompts, or that the commands do what they say on FreeBSD. Those are the
// assumptions listed in scripts/edge-image/drive.mjs's header, and CI is
// where they are confirmed. What it IS evidence of: that the driver types
// nothing before a prompt asks, treats the sentinel's status as the answer,
// re-logs-in after the reboot it asks for, writes every fact, and finishes
// when the guest powers off rather than when a timer runs out.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { main, INSIDE, FORGET_HOOK } from '../scripts/edge-image/drive.mjs';

// The guest: a node script, because `--qemu` is spawned as an executable.
// Each typed line ends in \r as a terminal's would. Commands carry the
// sentinel; a reboot or power-off does not.
const GUEST = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const typed = process.env.TYPED;
let rebooted = false;
let booting = true;
let echoOff = false;
let quieting = false;
const out = (s) => process.stdout.write(s);
const boot = () => { booting = true; out('Booting...\\r\\nPress any key to start the manual interface assignment: \\r\\nFreeBSD/amd64 (OPNsense.internal) (ttyu0)\\r\\n\\r\\nlogin: '); booting = false; };
boot();
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\r')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    appendFileSync(typed, line + '\\n');
    if (booting) { out('TYPED DURING BOOT: ' + line); process.exit(3); }
    if (quieting) { out('TYPED BEFORE THE QUIET PROMPT: ' + line); process.exit(5); }
    if (line === 'root') { out('root\\r\\nPassword: '); continue; }
    if (line === 'opnsense') { out('\\r\\n*** OPNsense.internal: OPNsense 26.7 ***\\r\\n 0) Logout   8) Shell\\r\\n\\r\\nEnter an option: '); continue; }
    if (line === '8') { out('8\\r\\nroot@OPNsense:~ # '); continue; }
    if (line === 'exec /bin/sh') { out('exec /bin/sh\\r\\n# '); continue; }
    // The quiet line's prompt comes late, as a shell's does while it runs
    // three commands; a line typed before it is the race the second CI run
    // lost, and ends the guest.
    if (line.startsWith('set +o emacs')) { echoOff = true; quieting = true; out(line + '\\r\\n'); setTimeout(() => { quieting = false; out('# '); }, 30); continue; }
    if (line === 'shutdown -r now') { out('shutdown -r now\\r\\nRebooting...\\r\\n'); rebooted = true; setTimeout(boot, 5); continue; }
    if (line === 'shutdown -p now') { out('shutdown -p now\\r\\nThe operating system has halted.\\r\\n'); setTimeout(() => process.exit(0), 5); continue; }
    const m = /^(.*); echo "__FW_""DONE_(\\d+)_\\$\\?__"$/.exec(line);
    if (!m) { out('UNKNOWN LINE: ' + line); process.exit(4); }
    const [, cmd, id] = m;
    let status = 0; let text = '';
    if (cmd === 'opnsense-version -v') text = '26.7.5';
    else if (cmd === 'opnsense-version -n') text = 'opnsense';
    else if (cmd.startsWith('opnsense-update -pt')) text = rebooted ? 'Nothing to do.' : 'Updating OPNsense repository catalogue...\\r\\nUpgrading opnsense from 26.7 to 26.7.5';
    else if (cmd === 'opnsense-update -bk -c') { status = rebooted ? 1 : 0; text = rebooted ? '' : 'Base and kernel 26.7.5 available'; }
    else if (cmd === 'opnsense-update -bk') text = 'Fetching base-26.7.5-amd64.txz... done\\r\\nPlease reboot.';
    else if (cmd === 'stat -f %i /usr/local/etc/config.xml') text = '6523';
    else if (cmd === 'stat -f %z /usr/local/etc/config.xml') text = '5234';
    else if (cmd === 'sha256 -q /usr/local/etc/config.xml') text = '1e81cde6bebe59e0aa769bd6b187f2247bd1155cddb52253ca1f2a17c51fe2e5';
    else if (cmd === 'pkg query %v os-xen') text = '1.5_1';
    else if (cmd === "pkg query '%n-%v' | sort") text = 'opnsense-26.7.5\\r\\nos-xen-1.5_1\\r\\nxe-guest-utilities-6.2.0';
    else if (cmd.startsWith('cat /tmp/manifest-in-vm.txt')) text = 'opnsense-version: 26.7.5';
    else if (cmd.startsWith('freebsd-version')) text = '15.0-RELEASE-p3 15.0-RELEASE-p3 15.0-RELEASE-p3';
    else if (cmd === 'uname -a') text = 'FreeBSD OPNsense.internal 15.0-RELEASE-p3 FreeBSD 15.0-RELEASE-p3 stable/26.7-n123 SMP amd64';
    else if (cmd.startsWith('pkg which')) text = 'none';
    else if (cmd.startsWith('ls -la /conf')) text = 'total 1;';
    else if (cmd.startsWith('pkg info -ql')) text = '/usr/local/sbin/xe-daemon';
    out((echoOff ? '' : line + '\\r\\n') + (text ? text + '\\r\\n' : '') + '__FW_DONE_' + id + '_' + status + '__\\r\\n# ');
  }
});
`;

test('the driver logs in, updates, reboots and logs in again, installs the agent, cleans, gathers, forgets this boot, and powers off — in that order', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edge-drive-'));
  const guest = path.join(dir, 'qemu-fake');
  writeFileSync(guest, GUEST);
  chmodSync(guest, 0o755);
  const typedFile = path.join(dir, 'typed.txt');
  writeFileSync(typedFile, '');
  process.env.TYPED = typedFile;
  // `#!/usr/bin/env node` has to find the node running this test.
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`;
  const image = path.join(dir, 'disk.img');
  writeFileSync(image, '');
  const log = path.join(dir, 'console.log');
  const facts = path.join(dir, 'facts');

  /** @type {string[]} */
  const said = [];
  await main(['--image', image, '--accel', 'tcg', '--log', log, '--facts', facts, '--qemu', guest], { out: { write: (s) => said.push(s) } });
  assert.match(said.at(-1) ?? '', /^done: OPNsense 26\.7\.5, os-xen 1\.5_1, configuration inode 6523 \(5234 bytes/);

  // Each line as typed, less the sentinel, so a command is matched whole:
  // `opnsense-update -bk` is not `opnsense-update -bk -c`.
  const typed = readFileSync(typedFile, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/; echo "__FW_""DONE_\d+_\$\?__"$/, ''));
  const at = (/** @type {string} */ s) => {
    const i = typed.indexOf(s);
    assert.ok(i >= 0, `never typed: ${s}\n${typed.join('\n')}`);
    return i;
  };
  // Two logins, each menu option 8 then a POSIX shell.
  assert.deepEqual(typed.filter((l) => ['root', 'opnsense', '8', 'exec /bin/sh'].includes(l)), ['root', 'opnsense', '8', 'exec /bin/sh', 'root', 'opnsense', '8', 'exec /bin/sh']);
  // Packages before base and kernel; the check before the install; a reboot
  // between the first update and the second; the second check after it.
  const order = [INSIDE.packages, INSIDE.baseKernelCheck, INSIDE.baseKernel, 'shutdown -r now'];
  assert.ok(order.every((s, i) => i === 0 || at(s) > at(order[i - 1])), `out of order:\n${typed.join('\n')}`);
  const secondUpdate = typed.findIndex((l, i) => i > at('shutdown -r now') && l === INSIDE.packages);
  assert.ok(secondUpdate > 0, 'the update is not asked again after the reboot');
  // The agent as OPNsense installs one, after the system is current.
  const agent = INSIDE.agent.map((c) => at(c));
  assert.ok(agent[0] > secondUpdate && agent[1] > agent[0] && agent[2] > agent[1]);
  // Cleanup after the agent, facts after cleanup, and forgetting the boot is
  // the last thing before power-off.
  const lastCleanup = Math.max(...INSIDE.cleanup.map((c) => at(c)));
  assert.ok(lastCleanup > agent[2]);
  assert.ok(at('stat -f %i /usr/local/etc/config.xml') > lastCleanup, 'facts are read before cleanup is done');
  assert.equal(typed.at(-1), 'shutdown -p now');
  assert.deepEqual(typed.slice(-1 - INSIDE.forget.length, -1), INSIDE.forget, 'the last commands before power-off are not forgetting this boot');
  // Forgotten by a stop hook that runs AFTER OPNsense's 99-config, which puts
  // the factory configuration back when it finds none (see FORGET_HOOK).
  assert.ok(path.basename(FORGET_HOOK) > '99-config', `${FORGET_HOOK} does not sort after 99-config`);
  const hook = INSIDE.forget.join('\n');
  assert.equal(INSIDE.forget[0], `h=${FORGET_HOOK}`, 'the hook is not written where rc.syshook stop looks');
  assert.match(hook, /rm -f \/conf\/config\.xml/);
  assert.match(hook, /rm -f "\$0"/, 'the hook does not remove itself');
  assert.match(hook, /chmod 755 "\$h" && sh -n "\$h"/, 'the hook is not made runnable and read back');
  // Every line went through the real Console, which refuses one over
  // LINE_MAX before sending it; the fake answers them all, so reaching here
  // is the proof that each fits (the long hook line of the third run did not).
  // The shell is made quiet before the first sentinel, and never before.
  assert.ok(at('exec /bin/sh') < typed.findIndex((l) => l.startsWith('set +o emacs')) && typed.findIndex((l) => l.startsWith('set +o emacs')) < at('true'));

  // What the guest said, written for measure.mjs.
  const got = JSON.parse(readFileSync(path.join(facts, 'facts.json'), 'utf8'));
  assert.equal(got['opnsense-version'], '26.7.5');
  assert.equal(got['version-before'], '26.7.5');
  assert.equal(got['config-inode'], '6523');
  assert.equal(got['config-length'], '5234');
  assert.equal(got['os-xen'], '1.5_1');
  assert.deepEqual(got.packages.split('\n'), ['opnsense-26.7.5', 'os-xen-1.5_1', 'xe-guest-utilities-6.2.0']);
  assert.match(got['update-base-kernel-check'], /^exit 0/);
  assert.match(got['update-base-kernel-check-again'], /^exit 1/);
  assert.equal(got['qemu-exit'], '0');
  assert.equal(readFileSync(path.join(facts, 'opnsense-version.txt'), 'utf8'), '26.7.5\n');
  // The log is the whole conversation, both directions.
  const text = readFileSync(log, 'utf8');
  assert.match(text, /qemu-fake -accel tcg/);
  assert.match(text, />>> root\n/);
  // The password is typed and never written: the log is uploaded from every run.
  assert.match(text, />>> \[the root password\]\n/);
  assert.doesNotMatch(text, />>> opnsense\n/);
  assert.match(text, /Upgrading opnsense from 26\.7 to 26\.7\.5/);
  assert.match(text, /The operating system has halted/);
});

test('a guest that still offers a base update after the reboot fails the build and says so', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'edge-drive-'));
  const guest = path.join(dir, 'qemu-fake');
  // The same guest, but `-bk -c` keeps answering 0.
  writeFileSync(guest, GUEST.replace("status = rebooted ? 1 : 0;", 'status = 0;'));
  chmodSync(guest, 0o755);
  process.env.TYPED = path.join(dir, 'typed.txt');
  process.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`;
  const image = path.join(dir, 'disk.img');
  writeFileSync(image, '');
  await assert.rejects(
    main(['--image', image, '--log', path.join(dir, 'console.log'), '--facts', path.join(dir, 'facts'), '--qemu', guest], { out: { write: () => {} } }),
    /after the update and a reboot, `opnsense-update -bk -c` still offers one/,
  );
  // And what was learned up to then is still written.
  const got = JSON.parse(readFileSync(path.join(dir, 'facts', 'facts.json'), 'utf8'));
  assert.equal(got['version-before'], '26.7.5');
  assert.match(got['update-base-kernel-check-again'], /^exit 0/);
});
