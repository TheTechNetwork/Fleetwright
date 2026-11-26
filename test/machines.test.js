// Machines a box makes out of its own containers: the hub's half
// (src/core/machines.js; docs/api-engines.md, "A machine on a box of your
// own"), against a `podman` that stands in for the real one and remembers
// what it was told (test/helpers/stub-machine-podman.js).
//
// NO CONTAINER IS RUN HERE. What is checked is what Podman would have been
// given and what the hub then says and keeps. The image is built and a
// machine started with a real Podman in CI (scripts/machine-smoke.mjs).
//
//   node --test test/machines.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Machines, machineImage, machineNames, releaseTag, stageMachineContext, MACHINE_MAX_MINUTES } from '../src/core/machines.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { setLogStream } from '../src/log.js';
import { stubMachinePodman } from './helpers/stub-machine-podman.js';

const ELI = 'eli@example.com';
const SAM = 'sam@example.com';
const ticket = (/** @type {string} */ id = 'a1b2c3d4e5f6') => `fwt_${id}_${'0'.repeat(48)}`;
const VM = 'vm-a1b2c3d4e5f6';
const FLEET = 'https://fleet.example';

/** A hub's machines with a clock the test moves, and its image already built unless said. */
async function box(/** @type {import('node:test').TestContext} */ t, /** @type {Record<string, unknown>} */ patch = {}, { built = true } = {}) {
  const podman = stubMachinePodman(t);
  const cfg = podman.cfg(patch);
  const clock = { now: 1_800_000_000_000 };
  const machines = new Machines(cfg, { now: () => clock.now });
  t.after(() => machines.unwatch());
  if (built) assert.equal((await machines.ensureImage()).ok, true);
  return { podman, cfg, clock, machines };
}

test('the image is built from whichever shape of release the box has, and from nothing else in it', async (t) => {
  const podman = stubMachinePodman(t);
  const out = mkdtempSync(path.join(os.tmpdir(), 'fw-stage-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  // A PACKAGED BOX has lib/ with everything bundled in and no src/ but the web pages.
  assert.equal(stageMachineContext({ installDir: podman.release('packaged') }, out).ok, true);
  assert.deepEqual(readdirSync(path.join(out, 'release')).sort(), ['bin', 'lib', 'package.json', 'src']);
  assert.equal(existsSync(path.join(out, 'entrypoint')), true);
  // A CHECKOUT has src/ and node_modules, and its apps and its .git stay out of the build.
  assert.equal(stageMachineContext({ installDir: podman.release('checkout') }, out).ok, true);
  assert.deepEqual(readdirSync(path.join(out, 'release')).sort(), ['bin', 'node_modules', 'package.json', 'src']);
  // A RELEASE FROM BEFORE THIS has no machine image to build, and says so with what to do.
  const old = stageMachineContext({ installDir: podman.release('old') }, out);
  assert.equal(old.ok, false);
  assert.match(String(old.text), /has no machine image to build .* Update fleetwright here\.$/);
});

test('a release that changed is another image, so a machine runs what its box runs', (t) => {
  const podman = stubMachinePodman(t);
  const root = podman.release('packaged');
  // EVERY FILE OF A RELEASE CARRIES ONE TIME: the packager stamps them all
  // 2020, so that two builds of one commit are the same bytes.
  const bundle = path.join(root, 'lib', 'fleetwright.mjs');
  const packed = new Date('2020-01-01T00:00:00Z');
  utimesSync(bundle, packed, packed);
  const before = machineImage({ installDir: root });
  assert.match(before, /^localhost\/fleetwright-machine:[0-9a-f]{12}$/);
  assert.equal(machineImage({ installDir: root }), before, 'the same release is the same image');
  // THE SAME BYTES UNPACKED AGAIN, somewhere else and with other times on
  // them, are the same image: a box that reinstalled its release builds nothing.
  assert.equal(machineImage({ installDir: podman.release('packaged') }), before);
  // A FIX THAT KEEPS A FILE'S LENGTH. The next release's copy of this file
  // has the size and the time the last one had, and the tag was made of
  // those two: the machines of a box that had updated went on running the
  // host from before.
  const was = statSync(bundle);
  writeFileSync(bundle, 'y\n');
  utimesSync(bundle, packed, packed);
  assert.deepEqual([statSync(bundle).size, statSync(bundle).mtimeMs], [was.size, was.mtimeMs]);
  assert.notEqual(releaseTag(root), before.split(':')[1]);
  // The operator's own image is used as named, whatever the release is.
  assert.equal(machineImage({ installDir: root, machineImage: 'registry.example/ours:1' }), 'registry.example/ours:1');
});

test('making a machine puts its ticket in the machine’s own volume from standard input, and in no command line or environment', async (t) => {
  const { podman, cfg, clock, machines } = await box(t);
  const r = await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET, minutes: 90 });
  assert.deepEqual([r.ok, r.name, r.minutes, r.until, r.text], [true, VM, 90, clock.now + 90 * 60_000, `Made ${VM} on this machine, for 90 minutes.`]);
  const [made] = podman.state().containers;
  assert.equal(made.name, machineNames(VM).container);
  assert.equal(made.image, machineImage(cfg));
  // WHO IT IS FOR AND WHEN IT ENDS travel with the container, so a hub that
  // lost its own notes still ends it on time.
  assert.deepEqual(made.labels, { 'fleetwright.machine': VM, 'fleetwright.owner': ELI, 'fleetwright.made': String(clock.now), 'fleetwright.until': String(clock.now + 90 * 60_000) });
  // THE JOIN FILE A VM HAS, written into this machine's volume before it
  // starts by a container that read it from standard input and is gone.
  const [seed] = podman.state().seeds;
  assert.equal(seed.volume, machineNames(VM).volume);
  assert.deepEqual(JSON.parse(seed.stdin), { v: 1, coordinator: FLEET, ticket: ticket(), owner: ELI, minutes: 90 });
  assert.equal(seed.wrote, 'umask 077 && cat > /var/lib/fleetwright-sidecar/vm-join.json');
  const run = /** @type {string[]} */ (podman.calls().find((a) => a[0] === 'run' && a.includes('-d')));
  // THE TICKET IS A SECRET FOR FIFTEEN MINUTES. An argument is readable by
  // every user of the box, and an environment is kept in Podman's record of
  // the container: it is in no call this made, and the machine itself is
  // started with nothing on its standard input and only the fleet's address.
  assert.equal(JSON.stringify(podman.calls()).includes(ticket()), false);
  assert.equal(made.stdin, '');
  assert.deepEqual(run.filter((a, i) => run[i - 1] === '-e'), [`FLEETWRIGHT_COORDINATOR=${FLEET}`]);
  assert.equal(run.includes('--env-file'), false, 'Podman cannot open the standard input the hub gives it by path');
  // As a session's container on this box: its user namespace and its limits.
  for (const flag of ['--userns=nomap', '--memory=8g', '--cpus=2', '--pids-limit=512', '-d']) assert.ok(run.includes(flag), flag);
  assert.deepEqual(run.slice(run.indexOf('-v'), run.indexOf('-v') + 2), ['-v', `${machineNames(VM).volume}:/var/lib/fleetwright-sidecar`]);

  // THE SAME TICKET IS THE SAME MACHINE: asked twice, made once.
  assert.equal((await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET })).ok, true);
  assert.equal(podman.state().containers.length, 1);
  // AND NO MORE THAN THE BOX MAY RUN, said with the setting that decides
  // it, even when two more are asked for in the same moment: each would
  // otherwise count the machines before the other's had started.
  const [second, third] = await Promise.all([
    machines.make({ owner: SAM, ticket: ticket('b'.repeat(12)), coordinator: FLEET }),
    machines.make({ owner: ELI, ticket: ticket('c'.repeat(12)), coordinator: FLEET }),
  ]);
  assert.deepEqual([second.ok, third.ok], [true, false]);
  assert.match(third.text, /already runs 2 of the 2 machines it may \(FLEETWRIGHT_MACHINE_MAX\)/);
  assert.equal(podman.state().containers.length, 2);
});

test('a machine is refused in words where one cannot be made, and nothing is started', async (t) => {
  for (const [patch, ask, said] of /** @type {Array<[Record<string, unknown>, Record<string, unknown>, RegExp]>} */ ([
    [{}, { ticket: 'fwt_no' }, /came without the ticket it enrols with/],
    [{}, { owner: '' }, /made for a signed-in person/],
    // One line each in the file Podman reads: an address that carried a
    // second line would be a second variable in the machine.
    [{}, { owner: 'eli@example.com\nFLEETWRIGHT_COORDINATOR=https://evil.example' }, /made for a signed-in person/],
    [{}, { coordinator: 'http://fleet.example' }, /was not told the fleet’s address/],
    [{}, { coordinator: 'https://fleet.example\nX=1' }, /was not told the fleet’s address/],
    // A BOX THAT KEEPS ITS SESSIONS BEHIND AN ALLOWLIST makes none: a machine
    // would be a container that is not behind it.
    [{ sandboxEgress: 'allowlist' }, {}, /behind an egress allowlist, and a machine made on it would not be/],
    [{ podmanBin: '/nonexistent/podman' }, {}, /Podman is not installed on this machine/],
    [{ machineMax: 0 }, {}, /already runs 0 of the 0 machines it may/],
  ])) {
    const { podman, machines } = await box(t, patch, { built: false });
    const r = await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET, .../** @type {any} */ (ask) });
    assert.equal(r.ok, false, JSON.stringify(ask));
    assert.match(r.text, said);
    assert.equal(podman.calls().some((a) => a[0] === 'run' || a[0] === 'build'), false, JSON.stringify(ask));
  }
  // PODMAN REFUSING THE START is said in Podman's words, and what the failed
  // start left behind is removed.
  const { podman, machines } = await box(t);
  podman.set({ failRun: true });
  const r = await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET });
  assert.equal(r.text, `Podman did not start ${VM}: Error: crun: cannot set memory limit`);
  assert.deepEqual(podman.calls().filter((a) => a[0] === 'rm' || (a[0] === 'volume' && a[1] === 'rm')).map((a) => a.join(' ')), [`rm -f fwm-${VM}`, `volume rm -f fwm-${VM}-state`]);
  assert.deepEqual(podman.state().volumes, [], 'the volume that held its ticket went with it');
  // AND REFUSING TO PREPARE IT, before any machine is started.
  podman.set({ failRun: false, failSeed: true });
  const unprepared = await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET });
  assert.equal(unprepared.text, `Podman did not prepare ${VM}: Error: creating volume: no space left on device`);
  assert.deepEqual([podman.state().containers, podman.state().volumes], [[], []]);
});

test('the image is built in the background, from this release and the Node the hub runs on, and a machine never waits for it', async (t) => {
  const { podman, cfg, machines } = await box(t, {}, { built: false });
  podman.set({ buildMs: 1500 });
  // Nothing was built by merely looking.
  const before = await machines.list();
  assert.deepEqual(before.ok && before.image, { name: 'Linux, with the fleet', ready: false, building: false, problem: null });
  assert.equal(podman.calls().some((a) => a[0] === 'build'), false);
  // ASKED FOR A MACHINE WITH NO IMAGE: the build is started and the person is told, at once.
  const first = await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET });
  assert.equal(first.ok, false);
  assert.match(first.text, /is building its machine image, which takes a few minutes/);
  // THE ANSWER CAME WHILE THE BUILD WAS STILL GOING: nothing was built yet.
  assert.notEqual(machines.building, null);
  assert.deepEqual(podman.state().images, []);
  const during = await machines.list({ prepare: true });
  assert.equal(during.ok && during.image.building, true);
  await machines.building;
  assert.equal(podman.calls().filter((a) => a[0] === 'build').length, 1, 'two asks are one build');
  const build = /** @type {string[]} */ (podman.calls().find((a) => a[0] === 'build'));
  assert.deepEqual(build.slice(1, 3), ['-t', machineImage(cfg)]);
  assert.ok(build.includes(`NODE_MAJOR=${process.versions.node.split('.')[0]}`));
  assert.deepEqual(build.slice(build.indexOf('-f'), build.indexOf('-f') + 2), ['-f', path.join(cfg.installDir, 'sandbox', 'machine', 'Containerfile')]);
  // WHAT IT WAS BUILT FROM is the hub's own copy of the release, laid out as the Containerfile copies it.
  assert.deepEqual(podman.state().contexts, [{ has: true, release: ['bin', 'lib', 'package.json', 'src'] }]);
  assert.equal(existsSync(path.join(cfg.stateDir, 'machine-build')), false, 'and the copy is removed');
  assert.equal((await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET })).ok, true);
});

test('a build that failed is said in Podman’s words and not tried again every minute', async (t) => {
  const { podman, clock, machines } = await box(t, {}, { built: false });
  podman.set({ failBuild: true });
  await machines.prepare();
  await machines.building;
  const failed = await machines.list({ prepare: true });
  assert.equal(failed.ok && failed.image.ready, false);
  assert.equal(failed.ok && failed.image.problem, 'The machine image could not be built on this machine: STEP 4/9: RUN curl ... / Error: could not resolve deb.nodesource.com');
  await machines.list({ prepare: true });
  assert.equal(podman.calls().filter((a) => a[0] === 'build').length, 1);
  // Half an hour on it is tried again, and this time the packages are there.
  podman.set({ failBuild: false });
  clock.now += 31 * 60_000;
  await machines.prepare();
  await machines.building;
  const ok = await machines.list();
  assert.deepEqual(ok.ok && [ok.image.ready, ok.image.problem], [true, null]);
});

test('an operator’s own image is used as named and never built over', async (t) => {
  const pulled = await box(t, { machineImage: 'registry.example/ours:1' }, { built: false });
  assert.equal((await pulled.machines.ensureImage()).ok, true);
  assert.deepEqual(pulled.podman.calls().filter((a) => a[0] === 'pull' || a[0] === 'build').map((a) => a.join(' ')), ['pull registry.example/ours:1']);
  const local = await box(t, { machineImage: 'localhost/ours:1' }, { built: false });
  const r = await local.machines.ensureImage();
  assert.equal(r.text, 'FLEETWRIGHT_MACHINE_IMAGE names localhost/ours:1, and this machine has no such image. Build it here, or unset it to have the fleet build its own.');
  assert.equal(local.podman.calls().some((a) => a[0] === 'build' || a[0] === 'pull'), false);
});

test('a machine ends when its time is up, by the box’s own clock, and more time moves that', async (t) => {
  const { podman, cfg, clock, machines } = await box(t);
  const made = clock.now;
  await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET, minutes: 10 });
  const listed = async (/** @type {Machines} */ m = machines) => {
    const r = await m.list();
    return r.ok ? r.machines.map((x) => [x.name, x.owner, x.state, x.until]) : r.text;
  };
  assert.deepEqual(await listed(), [[VM, ELI, 'Running', clock.now + 10 * 60_000]]);
  // MORE TIME is added to when it would have ended, and is kept where a
  // restarted hub reads it: the container's own label still says the old end.
  const more = await machines.control({ owner: ELI, name: VM, action: 'extend', minutes: 30 });
  assert.deepEqual([more.ok, more.minutes, more.until, more.text], [true, 30, clock.now + 40 * 60_000, `${VM} now ends 40 minutes from now.`]);
  clock.now += 20 * 60_000;
  const restarted = new Machines(cfg, { now: () => clock.now });
  assert.deepEqual(await listed(restarted), [[VM, ELI, 'Running', clock.now + 20 * 60_000]], 'past its label, and still running');
  // NEVER PAST THE LONGEST A MACHINE LIVES, COUNTED FROM WHEN IT WAS MADE,
  // as on a hypervisor. Counted from now, asking again every few hours kept
  // one for ever, and its place on the box with it.
  const far = await machines.control({ owner: ELI, name: VM, action: 'extend', minutes: 9999 });
  assert.equal(far.until, made + MACHINE_MAX_MINUTES * 60_000);
  clock.now += 5 * 60 * 60_000;
  const again = await machines.control({ owner: ELI, name: VM, action: 'extend', minutes: 9999 });
  assert.equal(again.ok, false);
  assert.match(again.text, new RegExp(`already runs to the longest a machine can, ${MACHINE_MAX_MINUTES} minutes from when it was made`));
  // ITS TIME UP: the next look removes the container and its disk.
  clock.now = made + MACHINE_MAX_MINUTES * 60_000 + 1;
  assert.deepEqual(await listed(), []);
  assert.deepEqual([podman.state().containers, podman.state().volumes], [[], []]);
});

test('more time given while another machine is being cleared away is kept, and the machine does not go at its old end', async (t) => {
  const { podman, clock, machines } = await box(t);
  await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET, minutes: 5 });
  await machines.make({ owner: SAM, ticket: ticket('b'.repeat(12)), coordinator: FLEET, minutes: 10 });
  const B = 'vm-bbbbbbbbbbbb';
  // Eli's is over. The minute's look starts clearing it away, and that
  // takes a while; Sam asks for two more hours in the middle of it.
  clock.now += 6 * 60_000;
  podman.set({ slowRmOnceMs: 400 });
  const look = machines.list();
  await new Promise((r) => setTimeout(r, 100));
  const more = await machines.control({ owner: SAM, name: B, action: 'extend', minutes: 120 });
  assert.equal(more.ok, true, more.text);
  await look;
  // The look wrote the end times back as it had read them, before the two
  // hours: Sam was told 124 minutes and the machine went in four, with its disk.
  clock.now += 5 * 60_000;
  const after = await machines.list();
  assert.deepEqual(after.ok && after.machines.map((m) => [m.name, m.until]), [[B, more.until]]);
});

test('a machine made and given more time while another is being cleared away keeps that time too', async (t) => {
  const { podman, cfg, clock, machines } = await box(t);
  await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET, minutes: 5 });
  // Eli's is over, and the minute's look is held in the middle of removing
  // it. That look listed the containers before Sam's machine existed.
  clock.now += 6 * 60_000;
  podman.set({ holdRm: 'next' });
  const look = machines.list();
  for (let i = 0; i < 500 && podman.state().holdRm !== 'held'; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(podman.state().holdRm, 'held', 'the look is removing Eli’s machine');
  const B = 'vm-bbbbbbbbbbbb';
  assert.equal((await machines.make({ owner: SAM, ticket: ticket('b'.repeat(12)), coordinator: FLEET, minutes: 10 })).ok, true);
  const more = await machines.control({ owner: SAM, name: B, action: 'extend', minutes: 120 });
  assert.equal(more.ok, true, more.text);
  podman.set({ holdRm: '' });
  await look;
  // The look took a machine it had not listed for one that was gone, and
  // wrote the file without it: Sam was told two hours and it went at the
  // ten minutes its label said, with its disk.
  assert.deepEqual(JSON.parse(readFileSync(path.join(cfg.stateDir, 'machines.json'), 'utf8')), { [B]: { until: more.until } });
  clock.now += 11 * 60_000;
  const after = await machines.list();
  assert.deepEqual(after.ok && after.machines.map((m) => [m.name, m.until]), [[B, more.until]]);
  assert.deepEqual(podman.state().volumes, [machineNames(B).volume]);
});

test('a box behind an egress allowlist neither builds the machine image nor offers it', async (t) => {
  // It refuses every machine (above), so an image there is a button for
  // something that does not exist: built, offered, and then refused.
  const { podman, machines } = await box(t, { sandboxEgress: 'allowlist' }, { built: false });
  const seen = await machines.list({ prepare: true });
  assert.equal(seen.ok, true);
  assert.deepEqual(seen.ok && [seen.image.ready, seen.image.building], [false, false]);
  assert.match(String(seen.ok && seen.image.problem), /behind an egress allowlist/);
  assert.equal(podman.calls().some((a) => a[0] === 'build' || a[0] === 'pull'), false);
});

test('a machine the hub has no note of ends by its label, and one that stopped by itself is cleared away', async (t) => {
  const { podman, cfg, clock, machines } = await box(t);
  await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET, minutes: 10 });
  await machines.make({ owner: SAM, ticket: ticket('b'.repeat(12)), coordinator: FLEET, minutes: 60 });
  rmSync(path.join(cfg.stateDir, 'machines.json'));
  const fresh = new Machines(cfg, { now: () => clock.now });
  // Running, said the other way Podman has printed it.
  const up = podman.state();
  up.containers[1].state = 'Up 2 minutes';
  podman.set({ containers: up.containers });
  const seen = await fresh.list();
  assert.deepEqual(seen.ok && seen.machines.map((m) => m.state), ['Running', 'Running']);
  assert.deepEqual(seen.ok && seen.machines.map((m) => [m.name, m.until]), [[VM, clock.now + 10 * 60_000], ['vm-bbbbbbbbbbbb', clock.now + 60 * 60_000]]);
  clock.now += 11 * 60_000;
  const later = await fresh.list();
  assert.deepEqual(later.ok && later.machines.map((m) => m.name), ['vm-bbbbbbbbbbbb']);
  // ITS SIDECAR ENDED, so its container has: it is over, and not kept as a
  // machine nobody can reach. Said as a sentence here, which is one of the
  // two ways Podman has printed this column.
  const s = podman.state();
  s.containers[0].state = 'Exited (0) 3 seconds ago';
  podman.set({ containers: s.containers });
  const after = await fresh.list();
  assert.deepEqual(after.ok && after.machines, []);
  assert.deepEqual(podman.state().volumes, []);
  // A CONTAINER OF SOMEBODY ELSE'S THAT CARRIES THE LABEL but not the name a
  // machine's container has is not one, and is left alone.
  podman.set({ containers: [{ name: 'my-own-thing', state: 'running', labels: { 'fleetwright.machine': VM, 'fleetwright.owner': ELI, 'fleetwright.until': '1' } }] });
  assert.deepEqual((await fresh.list()).ok && podman.state().containers.length, 1);
});

test('a machine that stopped by itself is removed with how its log ended kept for its owner, and no ticket or token in it', async (t) => {
  const { podman, cfg, clock, machines } = await box(t);
  await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET, minutes: 60 });
  await machines.make({ owner: SAM, ticket: ticket('b'.repeat(12)), coordinator: FLEET, minutes: 5 });
  const TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';
  // What this hub writes to its own log, which a phone can read.
  let journal = '';
  setLogStream(/** @type {any} */ ({ write: (/** @type {string} */ l) => { journal += l; return true; } }));
  t.after(() => setLogStream(null));
  // ELI'S SIDECAR ENDED, and its container with it. Its warning went out as
  // an error and everything else did not, which is how Podman hands the two
  // back: apart. The reason is the last thing it said, by the time on it.
  const s = podman.state();
  s.containers[0].state = 'Exited (1) 3 seconds ago';
  s.containers[0].log = [
    { at: '2026-11-24T10:00:01.000000001Z', line: 'fleetwright-machine: joining https://fleet.example as its owner\'s temporary machine' },
    { at: '2026-11-24T10:00:02.000000001Z', err: true, line: '2026-11-24T10:00:02.000Z WARN  sidecar: could not enrol itself, and will try again' },
    { at: '2026-11-24T10:00:03.000000001Z', line: `2026-11-24T10:00:03.000Z INFO  sidecar: the fleet refused ${ticket()} (Bearer ${TOKEN}), so this is over` },
    { at: '2026-11-24T10:00:04.000000001Z', line: 'fleetwright-machine: the sidecar ended with status 1, so this machine is ending' },
  ];
  podman.set({ containers: s.containers });
  const seen = await machines.list();
  assert.deepEqual(seen.ok && seen.machines.map((m) => m.name), ['vm-bbbbbbbbbbbb']);
  assert.deepEqual(seen.ok && seen.ended, [{
    name: VM, owner: ELI, at: clock.now,
    text: `This machine found ${VM} stopped just now and removed it with its disk. Its log ends: sidecar: the fleet refused [ticket] (Bearer [removed]), so this is over`,
  }]);
  assert.deepEqual([podman.state().containers.length, podman.state().volumes], [1, [machineNames('vm-bbbbbbbbbbbb').volume]]);
  // THE WHOLE END OF IT IS IN THIS HUB'S LOG, and neither there nor in
  // anything this hub keeps is the ticket or the sign-in the machine printed.
  assert.match(journal, new RegExp(`machines: ${VM} \\| fleetwright-machine: joining`));
  const kept = readdirSync(cfg.stateDir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile()).map((f) => readFileSync(path.join(f.parentPath, f.name), 'utf8')).join('\n');
  for (const secret of [ticket(), TOKEN]) assert.equal(`${journal}${kept}${JSON.stringify(seen)}`.includes(secret), false);
  // KEPT WHERE A RESTARTED HUB READS IT, and said for an hour and no longer.
  clock.now += 12 * 60_000;
  const later = await new Machines(cfg, { now: () => clock.now }).list();
  assert.match(String(later.ok && later.ended[0]?.text), new RegExp(`^This machine found ${VM} stopped 12 minutes ago and removed it`));
  // SAM'S TIME IS UP by now. This box ended that one, and its owner knows
  // why: it is not among the ones that stopped by themselves.
  assert.deepEqual(later.ok && [later.machines, later.ended.map((e) => e.name)], [[], [VM]]);
  clock.now += 49 * 60_000;
  const gone = await machines.list();
  assert.deepEqual(gone.ok && gone.ended, []);
});

test('how a stopped machine’s log ended is read by the time on each line, as Podman prints a time', async (t) => {
  const { podman, machines } = await box(t);
  await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET, minutes: 60 });
  // FOUR LINES IN ONE SECOND, with the time as Podman prints it: the fraction
  // with its trailing zeros dropped, and `Z` on a box whose clock is on UTC.
  // The warning is the last thing the machine said before its entrypoint's
  // own last line. Read as text, `.1234Z` sorts before `.12Z` and `.1Z`, so
  // the line said to be how the log ended was the first one printed.
  const s = podman.state();
  s.containers[0].state = 'exited';
  s.containers[0].log = [
    { at: '2026-11-24T10:00:03.1Z', line: 'fleetwright-machine: joining https://fleet.example as its owner\'s temporary machine' },
    { at: '2026-11-24T10:00:03.12Z', line: '2026-11-24T10:00:03.120Z INFO  http: listening' },
    { at: '2026-11-24T10:00:03.1234Z', err: true, line: '2026-11-24T10:00:03.123Z WARN  sidecar: the fleet refused this machine, so this is over' },
    { at: '2026-11-24T10:00:03.5Z', line: 'fleetwright-machine: the sidecar ended with status 1, so this machine is ending' },
  ];
  podman.set({ containers: s.containers });
  const seen = await machines.list();
  assert.equal(seen.ok && seen.ended[0]?.text, `This machine found ${VM} stopped just now and removed it with its disk. Its log ends: sidecar: the fleet refused this machine, so this is over`);
});

test('a secret too short to be known by its length is kept out of a stopped machine’s last words by where it stands', async (t) => {
  const { podman, cfg, machines } = await box(t);
  await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET, minutes: 60 });
  let journal = '';
  setLogStream(/** @type {any} */ ({ write: (/** @type {string} */ l) => { journal += l; return true; } }));
  t.after(() => setLogStream(null));
  // Each is under the 32 characters that mark a value of no known shape.
  const PASSWORD = 'hunter2-Sup3rSecret';
  const KEY = 'sk-proj-AbCdEfGhIjKlMnOpQrStUv';
  const ASSIGNED = 'Zx9-short';
  const s = podman.state();
  s.containers[0].state = 'exited';
  s.containers[0].log = [
    { at: '2026-11-24T10:00:01Z', line: `archive: fatal: bad key ${KEY} rejected` },
    { at: '2026-11-24T10:00:02Z', line: `archive: tried with {"api_key": "${ASSIGNED}"} and TOKEN=${ASSIGNED}` },
    { at: '2026-11-24T10:00:03Z', err: true, line: `sidecar: the token was refused at https://deploy:${PASSWORD}@git.example.com/fleet.git` },
  ];
  podman.set({ containers: s.containers });
  const seen = await machines.list();
  // WHAT A SENTENCE SAYS IS KEPT: "the token was refused" names no value.
  assert.equal(seen.ok && seen.ended[0]?.text, `This machine found ${VM} stopped just now and removed it with its disk. Its log ends: sidecar: the token was refused at https://[removed]@git.example.com/fleet.git`);
  assert.match(journal, /archive: fatal: bad key \[removed\] rejected/);
  assert.match(journal, /tried with \{"api_key": "\[removed\]"\} and TOKEN=\[removed\]/);
  const kept = readdirSync(cfg.stateDir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile()).map((f) => readFileSync(path.join(f.parentPath, f.name), 'utf8')).join('\n');
  for (const secret of [PASSWORD, KEY, ASSIGNED]) assert.equal(`${journal}${kept}${JSON.stringify(seen)}`.includes(secret), false, secret);
});

test('a stopped machine whose log cannot be read, or is empty, is said as that and not as a reason', async (t) => {
  const { podman, machines } = await box(t);
  await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET });
  await machines.make({ owner: SAM, ticket: ticket('b'.repeat(12)), coordinator: FLEET });
  const s = podman.state();
  s.containers[0].state = 'exited';
  podman.set({ containers: s.containers, failLogs: true });
  const unread = await machines.list();
  assert.equal(unread.ok && unread.ended[0].text, `This machine found ${VM} stopped just now and removed it with its disk. Podman could not read its log.`);
  // And one that printed nothing at all is said as that.
  const again = podman.state();
  again.containers[0].state = 'exited';
  podman.set({ containers: again.containers, failLogs: false });
  const empty = await machines.list();
  assert.equal(empty.ok && empty.ended[1].text, 'This machine found vm-bbbbbbbbbbbb stopped just now and removed it with its disk. Its log was empty.');
});

test('a volume left by a making that never finished is removed at the next look, and no other volume is', async (t) => {
  const { podman, machines } = await box(t);
  await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET });
  const mine = machineNames(VM).volume;
  // A HUB THAT STOPPED BETWEEN THE TWO STEPS OF A MAKING left the first:
  // a volume with the ticket in it and no container. Beside it, a volume of
  // somebody's own, and one whose name only looks like a machine's.
  const left = machineNames('vm-cccccccccccc').volume;
  podman.set({ volumes: [mine, left, 'my-own-data', 'fwm-vm-notamachine-state'] });
  await machines.list();
  assert.deepEqual(podman.state().volumes, [mine, 'my-own-data', 'fwm-vm-notamachine-state']);
  // NEVER FORCED: Podman's own refusal is what keeps a running machine's volume.
  assert.deepEqual(podman.calls().filter((a) => a[0] === 'volume' && a[1] === 'rm').map((a) => a.join(' ')), [`volume rm ${left}`]);
  // AND NOT THE VOLUME OF A MACHINE BEING MADE THIS MOMENT, which has no
  // container yet either: a look that fell between its two steps would
  // have started it with an empty volume and no ticket to join with.
  podman.set({ startMs: 400 });
  const making = machines.make({ owner: SAM, ticket: ticket('b'.repeat(12)), coordinator: FLEET });
  const B = machineNames('vm-bbbbbbbbbbbb').volume;
  for (let i = 0; i < 100 && !podman.state().volumes.includes(B); i += 1) await new Promise((r) => setTimeout(r, 10));
  await machines.list();
  assert.equal((await making).ok, true);
  assert.deepEqual(podman.state().volumes, [mine, 'my-own-data', 'fwm-vm-notamachine-state', B]);
  assert.equal(podman.calls().some((a) => a[0] === 'volume' && a[1] === 'rm' && a.includes(B)), false);
});

test('a machine is its owner’s to end, and what needs a hypervisor is said', async (t) => {
  const { podman, machines } = await box(t);
  await machines.make({ owner: ELI, ticket: ticket(), coordinator: FLEET });
  // SOMEBODY ELSE'S MACHINE IS NOT THERE to this person, the answer a name nobody has gets.
  const theirs = await machines.control({ owner: SAM, name: VM, action: 'stop' });
  assert.deepEqual([theirs.ok, theirs.notHere, theirs.text], [false, true, `${VM} is not a machine of yours on this machine.`]);
  assert.equal(podman.state().containers.length, 1);
  assert.equal((await machines.control({ owner: ELI, name: 'agent-something', action: 'stop' })).text, 'That is not the name of a machine this fleet made.');
  for (const [action, said] of [['reboot', 'A restart needs a hypervisor.'], ['resize', 'A resize needs a hypervisor.']]) {
    const r = await machines.control({ owner: ELI, name: VM, action });
    assert.equal(r.ok, false);
    assert.equal(r.text, `A machine on a box of your own can be ended or given more time. ${said}`);
  }
  const ended = await machines.control({ owner: ELI, name: VM, action: 'stop' });
  assert.deepEqual([ended.ok, ended.text], [true, `Ended ${VM}. Its container and its disk are removed.`]);
  assert.deepEqual([podman.state().containers, podman.state().volumes], [[], []]);
  // PODMAN NOT ANSWERING is "could not look", which is not "none".
  podman.set({ down: true });
  const down = await machines.list();
  assert.equal(down.ok, false);
  assert.match(String(!down.ok && down.text), /^Podman could not list this machine’s containers: Error: cannot connect to Podman$/);
});

test('the sidecar asks the hub over its API, with its token, and an older hub is said as older', async (t) => {
  const { cfg } = await box(t);
  const hub = { ...cfg, bind: '127.0.0.1', port: 0, token: '', hostname: 'deb132', workdir: path.join(cfg.stateDir, 'work'), maxSessions: 5, loginEnabled: true, sandbox: false, sandboxCredentialsFile: '', sandboxImage: 'ghcr.io/example/fleetwright-session:latest', sandboxImagePinned: false, releaseChannel: '', rulesFile: path.join(cfg.stateDir, 'CLAUDE.md') };
  const token = ensureApiToken(hub);
  const adapter = new HttpAdapter(hub, { sessions: /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] }), login: /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null }), token });
  await adapter.start();
  t.after(() => { adapter.machines.unwatch(); adapter.server?.close(); });
  const baseUrl = `http://127.0.0.1:${/** @type {any} */ (adapter.server).address().port}`;
  assert.equal((await fetch(`${baseUrl}/api/machines`)).status, 401, 'nobody without the token is told what machines a box has');
  const client = new HubClient({ baseUrl, token });
  const made = await client.makeMachine({ owner: ELI, ticket: ticket(), coordinator: FLEET, minutes: 45 });
  assert.deepEqual([made.ok, made.name, made.minutes], [true, VM, 45]);
  const listed = await client.machines();
  assert.deepEqual([listed.ok, listed.max, listed.image?.ready, listed.machines?.map((m) => [m.name, m.owner, m.state])], [true, 2, true, [[VM, ELI, 'Running']]]);
  // A REFUSAL KEEPS ITS SENTENCE across the wire: a status alone would lose it.
  assert.equal((await client.machineControl({ owner: ELI, name: VM, action: 'reboot', minutes: null })).text, 'A machine on a box of your own can be ended or given more time. A restart needs a hypervisor.');
  assert.equal((await client.machineControl({ owner: ELI, name: VM, action: 'stop', minutes: null })).ok, true);

  // A HUB FROM BEFORE THIS has no such route, and that is not "no machines".
  const { createServer } = await import('node:http');
  const old = createServer((_req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); });
  await new Promise((r) => old.listen(0, '127.0.0.1', () => r(null)));
  t.after(() => old.close());
  const older = new HubClient({ baseUrl: `http://127.0.0.1:${/** @type {any} */ (old.address()).port}`, token });
  assert.deepEqual(await older.machines(), { ok: false, older: true, text: 'fleetwright here is older than machines of its own; update it' });
  assert.equal((await older.makeMachine({ owner: ELI, ticket: ticket(), coordinator: FLEET, minutes: null })).text, 'fleetwright here is older than machines of its own; update it');
});
