#!/usr/bin/env node
// The fleet's machine image, built and started with a real Podman, through
// the code a box's hub runs. docs/api-engines.md, "A machine on a box of
// your own".
//
// WHY THIS EXISTS. Everything else about a machine on a box is tested
// against a Podman that stands in for the real one (test/machines.test.js),
// which proves what Podman is asked and nothing about what it then does. An
// image that builds is not an image that runs, and four things here can only
// be found out by running them: that the Containerfile builds from the
// context the hub lays out, that a machine's ticket reaches its volume from
// standard input, that `podman ps` prints labels in the shape the hub reads
// back, and that the host inside the image starts and tries to enrol with
// the ticket it was given. Its first run found the second of those wrong:
// Podman would not read an environment file from the standard input the hub
// gives it.
//
// WHAT IT DOES, as a box does it (src/core/machines.js, no second copy):
//
//   1. builds the image from this checkout, as the hub would on its box
//   2. checks the image has what a host needs and refuses a start with no
//      ticket, saying so
//   3. makes a machine with a ticket and a fleet that does not exist, and
//      reads in its log that the hub started and the sidecar tried to enrol
//   4. lists it, gives it more time, and ends it; nothing is left behind
//
// NO FLEET IS DIALLED. The coordinator is `https://fleet.invalid`, a name
// that resolves nowhere by design (RFC 6761), so "tried to enrol" is the
// sidecar's own sentence about a fleet it could not reach.
//
//   node scripts/machine-smoke.mjs              run it (needs podman)
//   node scripts/machine-smoke.mjs --no-limits  the same, with no memory, processor
//                                               or process limit on the machine, for a
//                                               user with no cgroup controllers of its
//                                               own (a CI job's shell)
//   node scripts/machine-smoke.mjs --stage D    only lay the build's context out in D
//
// Run it from a checkout with its runtime dependencies installed
// (`npm ci --omit=dev`), which is what a box running from a checkout has.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { Machines, machineImage, machineNames, stageMachineContext } from '../src/core/machines.js';
import { podmanAsync, podmanAvailable } from '../src/core/podman.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const step = (/** @type {string} */ s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const ok = (/** @type {string} */ s) => console.log(`  ok   ${s}`);

const stageAt = process.argv.indexOf('--stage');
if (stageAt > 0) {
  const dir = path.resolve(process.argv[stageAt + 1] || '');
  const r = stageMachineContext({ installDir: ROOT }, dir);
  if (!r.ok) {
    console.error(r.text);
    process.exit(1);
  }
  console.log(`laid out in ${dir}; build it with:\n  podman build -t fleetwright-machine:latest -f sandbox/machine/Containerfile --build-arg NODE_MAJOR=${process.versions.node.split('.')[0]} ${dir}`);
  process.exit(0);
}

const state = mkdtempSync(path.join(os.tmpdir(), 'fw-machine-smoke-'));
// The hub's own config, pointed at this checkout and a state of its own, so
// the limits and the user namespace are what a box would use.
process.env.FLEETWRIGHT_STATE_DIR = state;
process.env.FLEETWRIGHT_INSTALL_DIR = ROOT;
const cfg = process.argv.includes('--no-limits') ? { ...loadConfig(), sandboxMemory: '', sandboxCpus: '', sandboxPidsLimit: '' } : loadConfig();
const machines = new Machines(cfg);
const TICKET = `fwt_${'5a'.repeat(6)}_${'c3'.repeat(24)}`;
const NAME = `vm-${'5a'.repeat(6)}`;
const { container, volume } = machineNames(NAME);

/** @param {string[]} args @param {{ timeout?: number, input?: string }} [o] */
const podman = (args, o = {}) => podmanAsync(cfg, args, { timeout: 120_000, ...o });

/** @param {string} what @param {string} [detail] @returns {never} */
function die(what, detail = '') {
  console.error(`\n  FAIL ${what}\n${detail ? detail.split('\n').map((l) => `  | ${l}`).join('\n') : ''}`);
  process.exitCode = 1;
  throw new Error(what);
}

async function cleanup() {
  await podman(['rm', '-f', container]);
  await podman(['volume', 'rm', '-f', volume]);
  rmSync(state, { recursive: true, force: true });
}

try {
  if (!podmanAvailable(cfg)) die('podman is not on PATH, and a machine here is a Podman container');

  step('1. the image builds from this checkout, as the hub lays it out');
  const built = await machines.ensureImage();
  if (!built.ok) die('the image did not build', built.text);
  const image = machineImage(cfg);
  ok(`${image} (Node ${process.versions.node.split('.')[0]} inside, as outside)`);

  step('2. the image has what a host needs, and refuses a start with nothing to join');
  const has = await podman(['run', '--rm', '--entrypoint', 'sh', image, '-euc', 'node --version; claude --version; tmux -V; git --version; test -f /opt/fleetwright/current/bin/fleetwright-sidecar; test -x /usr/local/bin/fleetwright-machine; test "$IS_SANDBOX" = 1']);
  if (has.status !== 0) die('the image is missing something a host runs', has.stdout + has.stderr);
  if (!has.stdout.includes(`v${process.versions.node.split('.')[0]}.`)) die('the Node inside is not the major the builder runs', has.stdout);
  ok(has.stdout.trim().split('\n').join(' · '));
  const bare = await podman(['run', '--rm', image]);
  if (bare.status !== 64 || !/Nothing was started\./.test(bare.stdout)) die('a start with no coordinator was not refused in words', `status ${bare.status}\n${bare.stdout}${bare.stderr}`);
  const ticketless = await podman(['run', '--rm', '-e', 'FLEETWRIGHT_COORDINATOR=https://fleet.invalid', image]);
  if (ticketless.status !== 64 || !/no ticket in FLEETWRIGHT_TICKET/.test(ticketless.stdout)) die('a start with no ticket was not refused in words', `status ${ticketless.status}\n${ticketless.stdout}${ticketless.stderr}`);
  ok('no coordinator, and no ticket: each said, with status 64');

  step('3. a machine is made, and the host inside starts and tries to enrol');
  const made = await machines.make({ owner: 'smoke@example.com', ticket: TICKET, coordinator: 'https://fleet.invalid', minutes: 10 });
  if (!made.ok) die('the machine was not made', made.text);
  let log = '';
  for (let i = 0; i < 60; i += 1) {
    const r = await podman(['logs', container]);
    log = r.stdout + r.stderr;
    if (/could not enrol itself/.test(log) && /http: listening/.test(log)) break;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  if (!/joining https:\/\/fleet\.invalid/.test(log)) die('the entrypoint did not say it was joining', log);
  if (!/http: listening/.test(log)) die('the hub inside did not start', log);
  if (!/could not enrol itself/.test(log)) die('the sidecar inside did not try to enrol with its ticket', log);
  if (log.includes(TICKET)) die('the ticket is in the machine’s log');
  ok('the hub listens, and the sidecar tried the ticket against a fleet that is not there');
  // NOWHERE BUT THE VOLUME: not in a command line, and not in what Podman
  // keeps of the container, its environment included.
  const kept = await podman(['inspect', container]);
  if (kept.status !== 0) die('the machine could not be inspected', kept.stderr);
  if (kept.stdout.includes(TICKET)) die('the ticket is in Podman’s record of the machine');
  const join = await podman(['exec', container, 'sh', '-c', 'stat -c %a /var/lib/fleetwright-sidecar/vm-join.json && cat /var/lib/fleetwright-sidecar/vm-join.json']);
  if (join.status !== 0 || !join.stdout.startsWith('600\n') || !join.stdout.includes('"coordinator":"https://fleet.invalid"')) die('the join file is not in the machine’s volume as a VM’s is', join.stdout + join.stderr);
  ok('the ticket is in the machine’s volume, mode 600, and in nothing Podman keeps');

  step('4. it is listed, given more time, and ended, with nothing left');
  const listed = await machines.list();
  if (!listed.ok) die('the box could not list its machines', listed.text);
  const mine = listed.machines.find((m) => m.name === NAME);
  if (!mine || mine.owner !== 'smoke@example.com' || mine.state !== 'Running' || !mine.until) die('the machine is not listed as made', JSON.stringify(listed.machines));
  ok(`${NAME}, ${mine.state}, for ${mine.owner}, read back from its labels`);
  const more = await machines.control({ owner: 'smoke@example.com', name: NAME, action: 'extend', minutes: 30 });
  if (!more.ok || more.until !== /** @type {number} */ (mine.until) + 30 * 60_000) die('more time did not move its end', JSON.stringify(more));
  ok(more.text);
  const theirs = await machines.control({ owner: 'other@example.com', name: NAME, action: 'stop' });
  if (theirs.ok || !theirs.notHere) die('somebody else could end it', JSON.stringify(theirs));
  const ended = await machines.control({ owner: 'smoke@example.com', name: NAME, action: 'stop' });
  if (!ended.ok) die('it was not ended', ended.text);
  const left = await podman(['ps', '-a', '--filter', 'label=fleetwright.machine', '--format', '{{.Names}}']);
  const vols = await podman(['volume', 'ls', '--format', '{{.Name}}']);
  if (left.stdout.includes(container) || vols.stdout.includes(volume)) die('ending it left its container or its disk behind', left.stdout + vols.stdout);
  ok(ended.text);
  console.log('\nThe machine image builds, starts, tries to join, and goes when it is ended.\n');
} catch (e) {
  if (!process.exitCode) {
    console.error(e);
    process.exitCode = 1;
  }
} finally {
  machines.unwatch();
  await cleanup();
}
