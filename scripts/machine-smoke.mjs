#!/usr/bin/env node
// The fleet's machine image, built and started with a real Podman, through
// the code a box's hub runs. docs/api-engines.md, "A machine on a box of
// your own".
//
// WHY THIS EXISTS. Everything else about a machine on a box is tested
// against a Podman that stands in for the real one (test/machines.test.js),
// which proves what Podman is asked and nothing about what it then does. An
// image that builds is not an image that runs, and these can only be found
// out by running them: that the Containerfile builds from the context the hub
// lays out, that a machine's ticket reaches its volume from standard input,
// that `podman ps` prints labels in the shape the hub reads back, that the
// host inside the image starts and tries to enrol with the ticket it was
// given, that Podman keeps a volume a container has unless it is forced, and
// that it hands back a stopped container's log with a time on each line.
// Its first run found the second of those wrong: Podman would not read an
// environment file from the standard input the hub gives it.
//
// FROM A CHECKOUT, AND FROM A PACKAGED RELEASE. A box runs one or the other,
// and they are not the same files: a release is `lib/` with everything in
// one bundle, a checkout is `src/` and `node_modules`. This only ever built
// the image from a checkout, which is why a path that was right in `src/`
// and wrong in the bundle reached a release unseen (the SessionStart hook,
// src/core/direct-config.js). `--release D` builds it from a release
// unpacked in D instead. What drives Podman is this checkout's code either
// way: a release's bundle has nothing to import.
//
// WHAT IT DOES, as a box does it (src/core/machines.js, no second copy):
//
//   1. builds the image from this checkout or that release, as the hub
//      would on its box
//   2. checks the image has what a host needs, in the shape it was built
//      from, and refuses a start with no ticket, saying so
//   3. makes a machine with a ticket and a fleet that does not exist, and
//      reads in its log that the hub started and the sidecar tried to enrol
//   4. lists it, gives it more time, and ends it; nothing is left behind
//   5. makes another and stops its container, as a machine whose sidecar
//      ended: the hub removes it and says how its log ended, and removes a
//      volume that no machine has
//
// AND TWO THINGS THAT WERE ONLY EVER SAID, each seen here now:
//
//   The three limits a box gives a machine (memory, processors, processes),
//   applied by a real Podman and read back out of the machine's own cgroup,
//   with the hub inside asked how many sessions it would take: fewer than
//   the box has memory for, because it counts against its own limit
//   (src/core/cgroup-memory.js). A user with no cgroup controllers of its
//   own cannot be given a limit, and Podman says so. `--limits-if-granted`
//   asks Podman first and, where it refuses, runs without them and SAYS SO
//   where nobody can miss it: a warning on the run and a heading in the
//   job's summary. Never silently, which is what `--no-limits` alone was.
//
//   One session started in the machine (step 3b). The hub inside writes the
//   session's settings with a SessionStart hook in them, and that hook's
//   path was right in a checkout and one directory too high in a release,
//   so no session in a machine made from a release could be resumed. Both
//   legs built the image and neither ever started a session, so the leg
//   added for that fault did not look at it. A plain program stands where
//   Claude Code would be: no engine runs and nothing is signed in. It does
//   what Claude Code does as a session starts, which is run the hook its
//   settings name, and the hub is then asked whether it heard.
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
//   node scripts/machine-smoke.mjs --limits-if-granted
//                                               with the limits where Podman will set
//                                               them for this user, and without them,
//                                               said loudly, where it will not
//   node scripts/machine-smoke.mjs --release D  build the image from the packaged
//                                               release unpacked in D (the tarball of
//                                               tools/build-host-package.mjs)
//   node scripts/machine-smoke.mjs --stage D    only lay the build's context out in D
//
// Run it from a checkout with its runtime dependencies installed
// (`npm ci --omit=dev`), which is what a box running from a checkout has.
// NOT RUN ANYWHERE BUT CI: no machine these were written on has Podman.

import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { Machines, machineImage, machineNames, stageMachineContext } from '../src/core/machines.js';
import { podmanAsync, podmanAvailable } from '../src/core/podman.js';
import { usernsArgs } from '../src/core/sandbox-userns.js';

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

// WHAT THE IMAGE IS BUILT FROM: this checkout, or a release somebody unpacked.
const releaseAt = process.argv.indexOf('--release');
const RELEASE = releaseAt > 0 ? path.resolve(process.argv[releaseAt + 1] || '') : null;
if (RELEASE && !existsSync(path.join(RELEASE, 'lib', 'fleetwright.mjs'))) {
  console.error(`${RELEASE} is not an unpacked release (it has no lib/fleetwright.mjs). Build one with tools/build-host-package.mjs and unpack its tarball there.`);
  process.exit(1);
}
const INSTALL = RELEASE ?? ROOT;

const state = mkdtempSync(path.join(os.tmpdir(), 'fw-machine-smoke-'));
// The hub's own config, pointed at what the image is built from and a state
// of its own, so the limits and the user namespace are what a box would use.
process.env.FLEETWRIGHT_STATE_DIR = state;
process.env.FLEETWRIGHT_INSTALL_DIR = INSTALL;
// A copy, because the limits are taken off it below where Podman will not set them.
const cfg = { ...loadConfig() };
/** Why this run has no limits on its machine, or null for one that has them. @type {string|null} */
let unlimited = null;
const noLimits = (/** @type {string} */ why) => {
  unlimited = why;
  Object.assign(cfg, { sandboxMemory: '', sandboxCpus: '', sandboxPidsLimit: '' });
};
if (process.argv.includes('--no-limits')) noLimits('it was run with --no-limits');
const machines = new Machines(cfg);
const TICKET = `fwt_${'5a'.repeat(6)}_${'c3'.repeat(24)}`;
const NAME = `vm-${'5a'.repeat(6)}`;
const { container, volume } = machineNames(NAME);
// The one that is stopped under the hub, and a volume no machine ever had.
const TICKET2 = `fwt_${'6b'.repeat(6)}_${'d4'.repeat(24)}`;
const NAME2 = `vm-${'6b'.repeat(6)}`;
const second = machineNames(NAME2);
const stray = machineNames(`vm-${'7c'.repeat(6)}`).volume;

/** @param {string[]} args @param {{ timeout?: number, input?: string }} [o] */
const podman = (args, o = {}) => podmanAsync(cfg, args, { timeout: 120_000, ...o });

/**
 * Said where a person reading the run will see it: the log, and the job's
 * summary where there is one (GitHub's `GITHUB_STEP_SUMMARY`).
 *
 * @param {string} heading @param {string} body
 */
function summary(heading, body) {
  console.log(`\n${heading}\n${body}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${heading}\n\n${body}\n\n`);
}

/** `8g`, `512m` or a number of bytes, as Podman reads a memory limit, in bytes. @param {string} said */
function bytesOf(said) {
  const m = /^(\d+(?:\.\d+)?)([bkmg]?)$/i.exec(String(said).trim());
  return m ? Math.round(Number(m[1]) * 1024 ** ['b', 'k', 'm', 'g'].indexOf(m[2].toLowerCase() || 'b')) : NaN;
}

/** The conversation id the stand-in tells the hook, and the hub is then asked for. */
const UUID = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';

/**
 * What is run inside a machine, by its own Node, to ask the hub in it two
 * things over the loopback it listens on, with the token its sidecar shows
 * it: how many sessions it would take, and (asked to `start`) to start one.
 *
 * NO ENGINE AND NO SIGN-IN. Before the start, the `claude` on the machine's
 * path is replaced by a few lines that stand where Claude Code would be.
 * They run the SessionStart hook the session's settings name, as Claude Code
 * does when a session starts, write down how that went, and wait to be
 * stopped. The hub is handed a made-up Claude login for the smoke's owner,
 * because it starts no session for somebody with none; the value never
 * leaves the machine and nothing reads it.
 *
 * It prints one line of JSON and never throws: what went wrong is in the line.
 *
 * RUN BEFORE CI, unlike the rest of this file: against the hub of a packed
 * release started by the machine's own entrypoint, on loopback with no
 * network, as it is and again with the hook's file taken away (which is
 * reported: status 1, no file, nothing heard). Not inside a container.
 */
const INSIDE = String.raw`
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const STATE = process.env.FLEETWRIGHT_STATE_DIR || '/var/lib/fleetwright';
const PORT = process.env.FLEETWRIGHT_PORT || '8790';
const NOTE = require('node:os').tmpdir() + '/fleetwright-smoke-claude.json';
const OWNER = 'smoke@example.com';
const STAND_IN = [
  '#!/usr/bin/env node',
  '// Where Claude Code would be, for the machine smoke (scripts/machine-smoke.mjs).',
  "const fs = require('node:fs');",
  "const { spawnSync } = require('node:child_process');",
  "if (process.argv.includes('--version')) { console.log('0.0.0 (machine smoke stand-in)'); process.exit(0); }",
  "if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }",
  "const dir = process.env.CLAUDE_CONFIG_DIR || '';",
  'const note = (o) => fs.writeFileSync(' + JSON.stringify(NOTE) + ', JSON.stringify({ dir, tmux: Boolean(process.env.TMUX), ...o }));',
  'try {',
  "  const command = JSON.parse(fs.readFileSync(dir + '/settings.json', 'utf8')).hooks.SessionStart[0].hooks[0].command;",
  "  const ran = spawnSync('/bin/sh', ['-c', command], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: " + JSON.stringify('${UUID}') + ", cwd: process.cwd() }), encoding: 'utf8' });",
  "  note({ command, status: ran.status, said: String(ran.stderr || '').slice(0, 400) });",
  '} catch (e) { note({ failed: String((e && e.message) || e) }); }',
  'setInterval(() => {}, 60000);',
].join('\n') + '\n';
(async () => {
  const token = fs.readFileSync(STATE + '/sidecar-token', 'utf8').trim();
  const ask = async (method, path, body) => {
    const r = await fetch('http://127.0.0.1:' + PORT + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const state = async () => (await ask('GET', '/api/state')).body || {};
  const first = await state();
  const out = { maxSessions: first.maxSessions, free: first.free, capacity: first.capacity || null };
  if (!process.argv.includes('start')) return out;
  const where = execSync('command -v claude', { shell: '/bin/sh', encoding: 'utf8' }).trim();
  fs.rmSync(where, { force: true });
  fs.writeFileSync(where, STAND_IN, { mode: 0o755 });
  fs.rmSync(NOTE, { force: true });
  out.login = (await ask('POST', '/api/runner-login', { email: OWNER, login: null, token: 'sk-ant-oat01-not-a-login-the-machine-smoke-made-this-up' })).body;
  out.started = (await ask('POST', '/api/command', { command: '/start smoke', actor: 'fleet:' + OWNER, task: 'Nothing is asked of anything: this is the machine smoke.' })).body;
  for (let i = 0; i < 120; i += 1) {
    const session = ((await state()).sessions || []).find((s) => s && s.name === 'smoke');
    out.session = session ? { status: session.status, uuid: session.uuid || null, detail: session.detail || null } : null;
    if (session && session.uuid) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  try { out.hook = JSON.parse(fs.readFileSync(NOTE, 'utf8')); } catch { out.hook = null; }
  const cli = out.hook && typeof out.hook.command === 'string' ? out.hook.command.split(' ').slice(-2)[0] : null;
  out.cli = cli;
  out.cliIsThere = Boolean(cli && fs.existsSync(cli));
  await ask('POST', '/api/command', { command: '/stop smoke', actor: 'fleet:' + OWNER });
  return out;
})().then((out) => console.log(JSON.stringify(out)), (e) => console.log(JSON.stringify({ failed: String((e && e.message) || e) })));
`;

/**
 * Run INSIDE in a machine and read its one line back.
 *
 * @param {string} name  the machine's container
 * @param {'capacity'|'start'} what
 * @returns {Promise<any>}
 */
async function inside(name, what) {
  const r = await podman(['exec', '-i', name, 'node', '-', what], { input: INSIDE, timeout: 180_000 });
  try {
    return JSON.parse(String(r.stdout).trim().split('\n').pop() || '');
  } catch {
    return { failed: `nothing readable came back (status ${r.status}): ${(r.stdout + r.stderr).slice(-600)}` };
  }
}

/** @param {string} what @param {string} [detail] @returns {never} */
function die(what, detail = '') {
  console.error(`\n  FAIL ${what}\n${detail ? detail.split('\n').map((l) => `  | ${l}`).join('\n') : ''}`);
  process.exitCode = 1;
  throw new Error(what);
}

async function cleanup() {
  await podman(['rm', '-f', container, second.container]);
  await podman(['volume', 'rm', '-f', volume, second.volume, stray]);
  rmSync(state, { recursive: true, force: true });
}

try {
  if (!podmanAvailable(cfg)) die('podman is not on PATH, and a machine here is a Podman container');

  step(`1. the image builds from ${RELEASE ? `the packaged release in ${RELEASE}` : 'this checkout'}, as the hub lays it out`);
  const built = await machines.ensureImage();
  if (!built.ok) die('the image did not build', built.text);
  const image = machineImage(cfg);
  ok(`${image} (Node ${process.versions.node.split('.')[0]} inside, as outside)`);

  // THE THREE LIMITS A BOX GIVES A MACHINE, asked of Podman before anything
  // leans on them: the same flags `machines.js` passes, on a container that
  // does nothing. A user whose cgroup controllers were not handed to it
  // cannot be given one, and Podman refuses in its own words.
  if (!unlimited) {
    const flags = [`--memory=${cfg.sandboxMemory}`, `--cpus=${cfg.sandboxCpus}`, `--pids-limit=${cfg.sandboxPidsLimit}`];
    const tried = await podman(['run', '--rm', ...usernsArgs(cfg), ...flags, '--entrypoint', 'true', image]);
    // A Podman that cannot set a limit does not always refuse: under the
    // older cgroups it starts the container and says the limits are ignored.
    const ignored = /not supported|ignored/i.test(tried.stderr);
    if (tried.status === 0 && !ignored) ok(`Podman sets a machine's limits for this user (${flags.join(' ')})`);
    else if (process.argv.includes('--limits-if-granted')) noLimits(`Podman would not set them for this user: ${(tried.stderr || tried.stdout).trim().split('\n').pop()?.slice(0, 300) || 'it said nothing'}`);
    else die('Podman would not give a machine the limits a box gives one (run with --limits-if-granted, or --no-limits, where this user has no cgroup controllers of its own)', tried.stdout + tried.stderr);
  }
  // SAID EITHER WAY, AND LOUDEST WHEN THEY WERE NOT. A run with no limits
  // proves nothing about them, and used to look the same as one with them.
  if (unlimited) {
    console.log(`::warning title=Machine image::The three limits a box gives a machine were NOT applied on this run (${unlimited.replace(/\s+/g, ' ').slice(0, 200)}). Nothing here says Podman honours them, or that the hub inside counts against one.`);
    summary(
      'The three limits a box gives a machine were NOT applied on this run',
      `Memory, processors and processes: ${unlimited}.\n\nSo this run does **not** show that Podman honours them, that the machine's memory limit is in its own cgroup, or that the hub inside counts its sessions against it (\`src/core/cgroup-memory.js\`). Everything else below was run.`,
    );
  }

  step('2. the image has what a host needs, and refuses a start with nothing to join');
  const has = await podman(['run', '--rm', '--entrypoint', 'sh', image, '-euc', 'node --version; claude --version; tmux -V; git --version; test -f /opt/fleetwright/current/bin/fleetwright-sidecar; test -x /usr/local/bin/fleetwright-machine; test "$IS_SANDBOX" = 1']);
  if (has.status !== 0) die('the image is missing something a host runs', has.stdout + has.stderr);
  if (!has.stdout.includes(`v${process.versions.node.split('.')[0]}.`)) die('the Node inside is not the major the builder runs', has.stdout);
  ok(has.stdout.trim().split('\n').join(' · '));
  // IN THE SHAPE IT WAS BUILT FROM. A release is one bundle and no
  // dependencies beside it; a checkout is its sources and what npm installed.
  // An image that came out as the other shape was built from the wrong place.
  const shape = RELEASE
    ? 'test -f lib/fleetwright.mjs && test -f lib/fleetwright-sidecar.mjs && test ! -e node_modules && test ! -e src/index.js'
    : 'test -f src/index.js && test -d node_modules/jose && test ! -e lib/fleetwright.mjs';
  const shaped = await podman(['run', '--rm', '--entrypoint', 'sh', image, '-euc', `cd /opt/fleetwright/current && ls && ${shape}`]);
  if (shaped.status !== 0) die(`the host in the image is not ${RELEASE ? 'a packaged release' : 'a checkout'}`, shaped.stdout + shaped.stderr);
  ok(RELEASE ? 'the host inside is the release: its bundle, and nothing installed beside it' : 'the host inside is the checkout: its sources, and what npm installed');
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
  // WHERE THE HUB INSIDE LOOKS FOR WHAT IT MAY TAKE (src/core/cgroup-memory.js),
  // when the machine was given its limits: each is in the machine's own
  // cgroup, as the number that was asked for.
  if (!unlimited) {
    const limit = await podman(['exec', container, 'sh', '-c', 'cat /proc/self/cgroup; echo "memory.max $(cat /sys/fs/cgroup/memory.max)"; echo "pids.max $(cat /sys/fs/cgroup/pids.max)"; echo "cpu.max $(cat /sys/fs/cgroup/cpu.max)"']);
    const read = (/** @type {string} */ file) => new RegExp(`^${file.replace('.', '\\.')} (.+)$`, 'm').exec(limit.stdout)?.[1] ?? '';
    if (limit.status !== 0 || !/^0::\/$/m.test(limit.stdout)) die('the machine’s limits are not where the hub inside reads them', limit.stdout + limit.stderr);
    if (Number(read('memory.max')) !== bytesOf(cfg.sandboxMemory)) die(`the machine’s memory limit is not the ${cfg.sandboxMemory} it was made with`, limit.stdout);
    if (Number(read('pids.max')) !== Number(cfg.sandboxPidsLimit)) die(`the machine’s limit on processes is not the ${cfg.sandboxPidsLimit} it was made with`, limit.stdout);
    // `cpu.max` is "<quota> <period>", and processors are the one over the other.
    const [quota, period] = read('cpu.max').split(' ').map(Number);
    if (!(quota > 0 && period > 0) || Math.abs(quota / period - Number(cfg.sandboxCpus)) > 0.01) die(`the machine’s limit on processors is not the ${cfg.sandboxCpus} it was made with`, limit.stdout);
    ok(`its limits are in its own cgroup: memory ${read('memory.max')}, processes ${read('pids.max')}, processors ${read('cpu.max')}`);
    // AND THE HUB INSIDE COUNTS AGAINST THE MEMORY ONE. What it would take is
    // what its limit leaves after what the machine holds, less the floor it
    // keeps, a session at a time (capacity.js); never what the box has free.
    const hub = await inside(container, 'capacity');
    const most = Math.floor((bytesOf(cfg.sandboxMemory) / 2 ** 20 - cfg.memoryFloorMb) / cfg.sessionMemoryMb);
    if (hub.failed || !Number.isInteger(hub.maxSessions)) die('the hub inside did not say how many sessions it would take', JSON.stringify(hub));
    // AT LEAST ONE, or the bound below is passed by a hub that would take
    // none: what it would take is what is running plus what is free, and a
    // loaded runner leaves nothing free. "0, within the 3" read as a pass.
    if (hub.maxSessions < 1) die(`the hub inside would take no session at all, of the ${most} its machine’s ${cfg.sandboxMemory} leaves room for: this runner is too loaded to say anything about the limit`, JSON.stringify(hub));
    if (hub.maxSessions > most) die(`the hub inside would take ${hub.maxSessions} sessions, and its machine’s ${cfg.sandboxMemory} leaves room for ${most} at most: it is counting against the box and not its own limit`, JSON.stringify(hub));
    ok(`the hub inside would take ${hub.maxSessions} session${hub.maxSessions === 1 ? '' : 's'}, within the ${most} its ${cfg.sandboxMemory} leaves room for`);
    summary('The three limits a box gives a machine were applied', `Memory \`${cfg.sandboxMemory}\`, processors \`${cfg.sandboxCpus}\`, processes \`${cfg.sandboxPidsLimit}\`, each read back out of the machine's own cgroup. The hub inside would take ${hub.maxSessions} session(s); its limit leaves room for ${most} at most.`);
  }

  step('3b. a session is started in the machine, and the hub hears the hook its settings name');
  const began = await inside(container, 'start');
  if (began.failed) die('the session could not be asked for', JSON.stringify(began));
  if (began.started?.ok !== true) die('the hub inside did not start a session', JSON.stringify(began));
  if (!began.hook?.command) die('the session’s settings name no SessionStart hook, or what stood where Claude Code would be never ran', JSON.stringify(began));
  // THE FAULT THE RELEASE LEG WAS ADDED FOR: a path one directory too high
  // names a file that is not there, and the hook fails before it says anything.
  if (!began.cliIsThere || !/\/opt\/fleetwright\/current\/bin\/fleetwright hook$/.test(began.hook.command)) die('the SessionStart hook names a file that is not in the machine', JSON.stringify(began));
  if (began.hook.status !== 0) die('the SessionStart hook did not run', JSON.stringify(began));
  if (began.session?.uuid !== UUID) die('the hub inside never heard the hook, so this session could not be resumed', JSON.stringify(began));
  ok(`${began.hook.command.split(' ').slice(1).join(' ')} ran in the session and the hub recorded what it said`);

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
  // PODMAN KEEPS A VOLUME A CONTAINER HAS, unless forced. The hub's look for
  // volumes left behind asks without forcing and leans on exactly this, so
  // that a machine started in the same moment keeps its disk.
  const held = await podman(['volume', 'rm', volume]);
  if (held.status === 0) die('Podman removed the volume of a running machine without being forced to');
  ok('Podman would not remove its volume while it runs');
  const ended = await machines.control({ owner: 'smoke@example.com', name: NAME, action: 'stop' });
  if (!ended.ok) die('it was not ended', ended.text);
  const left = await podman(['ps', '-a', '--filter', 'label=fleetwright.machine', '--format', '{{.Names}}']);
  const vols = await podman(['volume', 'ls', '--format', '{{.Name}}']);
  if (left.stdout.includes(container) || vols.stdout.includes(volume)) die('ending it left its container or its disk behind', left.stdout + vols.stdout);
  ok(ended.text);

  step('5. one that stopped by itself is removed with how its log ended, and so is a volume no machine has');
  const again = await machines.make({ owner: 'smoke@example.com', ticket: TICKET2, coordinator: 'https://fleet.invalid', minutes: 10 });
  if (!again.ok) die('the second machine was not made', again.text);
  for (let i = 0; i < 60; i += 1) {
    const r = await podman(['logs', second.container]);
    if (/joining https:\/\/fleet\.invalid/.test(r.stdout + r.stderr)) break;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  // STOPPED UNDER THE HUB, which is what its sidecar ending looks like from
  // outside: a container that is there and no longer running.
  const stopped = await podman(['stop', '-t', '2', second.container]);
  if (stopped.status !== 0) die('the second machine could not be stopped', stopped.stderr);
  const made2 = await podman(['volume', 'create', stray]);
  if (made2.status !== 0) die('a volume could not be made to leave behind', made2.stderr);
  const after = await machines.list();
  if (!after.ok) die('the box could not list its machines', after.text);
  if (after.machines.some((m) => m.name === NAME2)) die('a machine whose container had stopped is still listed', JSON.stringify(after.machines));
  const why = after.ended.find((e) => e.name === NAME2);
  // ITS LOG'S LAST LINE, READ FROM A REAL PODMAN: with the time Podman puts
  // on each line taken off again, and something after it.
  const said = /^This machine found \S+ stopped (?:just now|a minute ago) and removed it with its disk\. Its log ends: (.+)$/.exec(why?.text ?? '');
  if (!why || why.owner !== 'smoke@example.com' || !said) die('the hub did not say how the stopped machine’s log ended', JSON.stringify(after.ended));
  if (/^\d{4}-\d\d-\d\dT/.test(said[1])) die('the time Podman puts on a log line was not taken off', why.text);
  if (JSON.stringify(after.ended).includes(TICKET2)) die('the ticket is in what the hub kept of the machine’s log');
  ok(why.text);
  const left2 = await podman(['ps', '-a', '--filter', 'label=fleetwright.machine', '--format', '{{.Names}}']);
  const vols2 = await podman(['volume', 'ls', '--format', '{{.Name}}']);
  if (left2.stdout.includes(second.container) || vols2.stdout.includes(second.volume)) die('the stopped machine’s container or its disk was left behind', left2.stdout + vols2.stdout);
  if (vols2.stdout.includes(stray)) die('a volume no machine has was left behind', vols2.stdout);
  ok('its container and its disk are gone, and so is the volume no machine had');
  console.log(`\nThe machine image builds from ${RELEASE ? 'a packaged release' : 'a checkout'}, starts, tries to join, starts a session whose hook is heard, and goes when it is ended or stops.${unlimited ? ' NO LIMITS WERE ON IT: see above.' : ' Its limits were on it and read back.'}\n`);
} catch (e) {
  if (!process.exitCode) {
    console.error(e);
    process.exitCode = 1;
  }
} finally {
  machines.unwatch();
  await cleanup();
}
