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
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Machines, machineImage, machineNames, releaseTag, stageMachineContext, MACHINE_MAX_MINUTES } from '../src/core/machines.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
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
  const before = machineImage({ installDir: root });
  assert.match(before, /^localhost\/fleetwright-machine:[0-9a-f]{12}$/);
  assert.equal(machineImage({ installDir: root }), before, 'the same release is the same image');
  utimesSync(path.join(root, 'lib', 'fleetwright.mjs'), new Date(1_900_000_000_000), new Date(1_900_000_000_000));
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
  assert.deepEqual(podman.calls().filter((a) => a[0] === 'rm' || a[0] === 'volume').map((a) => a.join(' ')), [`rm -f fwm-${VM}`, `volume rm -f fwm-${VM}-state`]);
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
  // Never further off than the longest a machine is made for.
  const far = await machines.control({ owner: ELI, name: VM, action: 'extend', minutes: 9999 });
  assert.equal(far.until, clock.now + MACHINE_MAX_MINUTES * 60_000);
  // ITS TIME UP: the next look removes the container and its disk.
  clock.now += MACHINE_MAX_MINUTES * 60_000 + 1;
  assert.deepEqual(await listed(), []);
  assert.deepEqual([podman.state().containers, podman.state().volumes], [[], []]);
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
