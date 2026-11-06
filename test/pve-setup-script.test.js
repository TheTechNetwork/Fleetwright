// THE SETUP SCRIPT ITSELF, run: install/fleetwright-pve-setup against
// stand-ins for Proxmox's own commands that keep what they are told. The
// other tests hold its text to the code that relies on it; this one runs it.
//
// Written after a real run stopped in the firewall step "without saying why":
// the pvesh wrapper waited on "$!", which bash had not set, and under `set -u`
// that ended the script on its first pvesh call, past the ERR trap, with no
// fleetwright-error line for the phone to show. A text check could not see it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../install/fleetwright-pve-setup', import.meta.url));
const ready = spawnSync('perl', ['-MJSON::PP', '-e', '1']).status === 0;
const skip = !ready && 'needs perl with JSON::PP, as every Proxmox node has';

/**
 * A node: its commands, and the firewall group's state in files. Anything
 * the script asks that these do not know fails, as an unknown call would.
 *
 * @param {{ group?: boolean, rules?: number }} [start]
 */
function node({ group = false, rules = 0 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-pve-script-'));
  const bin = path.join(dir, 'bin');
  const state = path.join(dir, 'state');
  spawnSync('mkdir', ['-p', bin, state]);
  if (group) writeFileSync(path.join(state, 'group'), '');
  writeFileSync(path.join(state, 'rules'), String(rules));
  const tools = {
    pvesh: `S='${state}'
echo "pvesh $*" >> "$S/log"
case "$1 $2" in
  "get /cluster/firewall/groups") [ -f "$S/group" ] && echo '[{"group":"fleetwright-fence"}]' || echo '[]' ;;
  "create /cluster/firewall/groups") [ -f "$S/group" ] && { echo "group 'fleetwright-fence' already exists" >&2; exit 255; }; : > "$S/group" ;;
  "get /cluster/firewall/groups/fleetwright-fence") n=$(cat "$S/rules"); printf '['; i=0; while [ $i -lt $n ]; do [ $i -gt 0 ] && printf ','; printf '{"pos":%d}' $i; i=$((i+1)); done; echo ']' ;;
  "delete /cluster/firewall/groups/fleetwright-fence/0") echo $(( $(cat "$S/rules") - 1 )) > "$S/rules" ;;
  "create /cluster/firewall/groups/fleetwright-fence") echo $(( $(cat "$S/rules") + 1 )) > "$S/rules" ;;
  "get /cluster/firewall/options") echo '{"enable":1}' ;;
  *) echo "the stand-in has no pvesh $*" >&2; exit 255 ;;
esac`,
    pveum: `case "$*" in
  "pool list --output-format json") echo '[]' ;;
  "role list --output-format json") echo '[]' ;;
  "user list --output-format json") echo '[]' ;;
  "user token add"*) echo '{"value":"0b8e6f0e-6a3e-4c55-9f4c-7c5d2b1a9e01"}' ;;
esac`,
    pvesm: 'echo "Name Type Status"; echo "local-lvm lvmthin active"',
    pveversion: 'echo "pve-manager/9.0.3/0000 (running kernel: 6.14.8-2-pve)"',
    hostname: '[ "$1" = -I ] && echo 10.69.10.10 || echo pve1',
    // ROOT, as the script insists on being run: nothing in these steps
    // touches the machine itself, only the stand-ins.
    id: '[ "$1" = -u ] && echo 0 || command id "$@"',
    ip: 'exit 0',
    qm: 'exit 0',
    pct: 'exit 0',
    pvenode: 'exit 0',
    systemctl: 'exit 0',
  };
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  /** @param {string} [script] */
  const run = (script = SCRIPT) => {
    const r = spawnSync('bash', [script, '--coordinator', 'https://fleet.example.com', '--no-image'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return {
    dir,
    run,
    rules: () => Number(readFileSync(path.join(state, 'rules'), 'utf8')),
    asked: () => (existsSync(path.join(state, 'log')) ? readFileSync(path.join(state, 'log'), 'utf8') : ''),
  };
}

/** @param {string} out */
const steps = (out) => out.split('\n').filter((l) => l.startsWith('fleetwright-step: ')).map((l) => l.slice(18));

test('the firewall step makes its group on a new cluster and remakes its rules on one it set up before', { skip }, () => {
  for (const start of [{}, { group: true, rules: 10 }, { group: true, rules: 3 }]) {
    const n = node(start);
    const { out } = n.run();
    assert.ok(!/unbound variable/.test(out), out);
    assert.deepEqual(steps(out).slice(0, 5), ['pool', 'user', 'token', 'fence', 'networks'], `${JSON.stringify(start)}\n${out}`);
    // Ten rules, whatever it found: SSH in, DHCP and DNS out, six private ranges dropped.
    assert.equal(n.rules(), 10, JSON.stringify(start));
    assert.equal(/create \/cluster\/firewall\/groups --group/.test(n.asked()), !start.group, 'the group was made again, or not made');
  }
});

test('every way the script stops says why, even one that skips the ERR trap', { skip }, () => {
  // A call the stand-in does not know (the first in the networks step) is a
  // failure in Proxmox's own words.
  const n = node();
  const failed = n.run();
  assert.equal(failed.code, 1);
  assert.match(failed.out, /^fleetwright-error: the stand-in has no pvesh .* \(line \d+\)$/m);
  // AN UNSET VARIABLE ends bash under `set -u` without the ERR trap: what the
  // first real run hit. The script, with one read of a variable nothing sets
  // put in after the token step, still leaves a reason.
  const broken = path.join(n.dir, 'broken');
  writeFileSync(broken, readFileSync(SCRIPT, 'utf8').replace('\nstep fence\n', '\nstep fence\n: "$NOTHING_SETS_THIS"\n'));
  const silent = node().run(broken);
  assert.notEqual(silent.code, 0);
  assert.match(silent.out, /unbound variable/);
  const said = silent.out.split('\n').filter((l) => l.startsWith('fleetwright-error: '));
  assert.equal(said.length, 1, silent.out);
  assert.match(said[0], /stopped unexpectedly \(exit \d+\)/);
});

// A GREP THAT FINDS NOTHING IS NOT AN ERROR. Every "$(grep ...)" the script
// reads a file with, run as the script runs it (set -Eeuo pipefail, its ERR
// trap) against files with nothing in them yet: the image step's console
// before the build's first marker. Each printed "fleetwright-error: tail -n
// 1 failed" on a real run that then succeeded; the route through a machine
// ends the setup on any error line, so that run would have failed there.
test('the script reading a file that does not say anything yet is not an error', () => {
  const lines = readFileSync(SCRIPT, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l) && l.includes('"$(grep'));
  assert.ok(lines.length >= 5, `found ${lines.length} of the script's greps`);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-pve-grep-'));
  const empty = path.join(dir, 'empty');
  writeFileSync(empty, '');
  for (const line of lines) {
    const from = line.indexOf('"$(grep') + 1;
    const sub = line.slice(from, line.lastIndexOf(')"') + 1);
    const r = spawnSync('bash', ['-c', `set -Eeuo pipefail; trap 'echo "ERR at $BASH_COMMAND"' ERR; console=${empty}; LAST_ERR=${empty}; v="${sub}"; echo "ok[$v]"`], { encoding: 'utf8' });
    assert.equal(r.stdout, 'ok[]\n', `${sub}\n${r.stdout}${r.stderr}`);
  }
});

// THE SCRIPT FINDS ITS IMAGE AND ITS UNFINISHED BUILDS by their tags, read
// where Proxmox gives tags: /cluster/resources. It once read /pools/<pool>,
// whose members Proxmox gives no tags (pve-manager, PVE/API2/Pool.pm), so the
// first real node's template was never found and the next run built another.
// The script's own `tagged`, run against an answer shaped as Proxmox's.
test('the script finds its templates and its builds by tag, in its own pool only', { skip }, () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const fn = /^tagged\(\) \{\n[\s\S]*?\n\}\n/m.exec(text)?.[0];
  assert.ok(fn, 'the script has no tagged()');
  assert.ok(!/\/pools\/\$POOL"? --output-format/.test(text), 'the script reads tags from /pools/<pool> again');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-pve-tagged-'));
  const resources = [
    { type: 'qemu', vmid: 9001, pool: 'fleetwright', template: 1, tags: 'fleetwright-image' },
    { type: 'qemu', vmid: 9000, pool: 'fleetwright', template: 1, tags: 'fleetwright-image;other' },
    { type: 'qemu', vmid: 9002, pool: 'fleetwright', tags: 'fleetwright-build' },
    { type: 'qemu', vmid: 9003, pool: 'fleetwright', template: 1, tags: 'fleetwright-build' },
    { type: 'qemu', vmid: 500, pool: 'elsewhere', template: 1, tags: 'fleetwright-image' },
    { type: 'qemu', vmid: 501, template: 1, tags: 'fleetwright-image' },
    { type: 'lxc', vmid: 502, pool: 'fleetwright', tags: 'fleetwright-build' },
    { type: 'qemu', vmid: 503, pool: 'fleetwright', template: 1, tags: 'not-fleetwright-image' },
  ];
  writeFileSync(path.join(dir, 'pvesh'), `#!/bin/bash\n[ "$*" = "get /cluster/resources --type vm --output-format json" ] || exit 9\necho '${JSON.stringify(resources)}'\n`);
  chmodSync(path.join(dir, 'pvesh'), 0o755);
  const ask = (/** @type {string} */ args) => {
    const r = spawnSync('bash', ['-c', `set -Eeuo pipefail; POOL=fleetwright; ${fn}tagged ${args}`], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter(Boolean);
  };
  assert.deepEqual(ask('1 fleetwright-image'), ['9000', '9001']);
  assert.deepEqual(ask('0 fleetwright-build'), ['9002']);
  assert.deepEqual(ask('1 fleetwright-session'), []);
});

// THE NAME A PUBLIC CERTIFICATE IS CHECKED AS, picked by the script's own
// lines from the certificate the web interface has: the node's own name when
// it is covered, else the first name the certificate was issued to, else the
// node's name under a wildcard for its domain. None when the address already
// is a name, because then the address is what the certificate is held to.
test('the script names the host a public certificate is checked as, from the certificate', { skip }, () => {
  const text = readFileSync(SCRIPT, 'utf8');
  const start = text.indexOf('NAME=""\nhost_part=');
  const end = text.indexOf('\nLINE="$(KIND=proxmox');
  assert.ok(start > 0 && end > start, 'the script has no name block');
  const block = text.slice(start, end);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-pve-name-'));
  const certWith = (/** @type {string} */ san) => {
    const run = (/** @type {string[]} */ args) => assert.equal(spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' }).status, 0);
    run(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'k.pem', '-out', 'c.pem', '-days', '1', '-subj', '/CN=x', '-addext', `subjectAltName=${san}`]);
    return path.join(dir, 'c.pem');
  };
  writeFileSync(path.join(dir, 'hostname'), '#!/bin/bash\n[ "$1" = -f ] && echo "$FQDN"\n');
  chmodSync(path.join(dir, 'hostname'), 0o755);
  const pick = (/** @type {string} */ san, /** @type {string} */ address, fqdn = 'pve01.example.test') => {
    const custom = certWith(san);
    const r = spawnSync('bash', ['-c', `set -Eeuo pipefail; say() { :; }; die() { echo "DIED: $*"; exit 1; }; TRUST=public; CUSTOM='${custom}'; ADDRESS='${address}'\n${block}\necho "NAME=$NAME"`], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FQDN: fqdn },
    });
    return `${r.stdout}${r.stderr}`.trim();
  };
  assert.equal(pick('DNS:other.example.test,DNS:pve01.example.test', '10.69.10.10:8006'), 'NAME=pve01.example.test');
  assert.equal(pick('DNS:*.example.test,DNS:pve.example.test', '10.69.10.10:8006'), 'NAME=pve.example.test');
  assert.equal(pick('DNS:*.example.test', '10.69.10.10:8006'), 'NAME=pve01.example.test');
  assert.match(pick('DNS:*.elsewhere.test', '10.69.10.10:8006'), /^DIED: .*names no host/);
  assert.equal(pick('DNS:pve01.example.test', 'pve01.example.test:8006'), 'NAME=', 'an address that is a name is what the certificate is held to');
  assert.equal(pick('DNS:pve01.example.test', '[fd00::10]:8006'), 'NAME=pve01.example.test');
});
