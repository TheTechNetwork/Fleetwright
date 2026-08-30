// The sandbox's podman calls, against a stub podman that records what it was
// asked to do.
//
//   node --test test/
//
// A real build takes minutes and a real registry, so what is worth testing here
// is the DECISIONS: build or pull, when to do neither, and whether a session is
// refused over something we could have fixed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureSandboxImage, ensureSandboxVolumes, sandboxNames, removeSandboxVolumes } from '../src/core/podman.js';

/**
 * A podman that answers however the test wants and logs every invocation.
 * @param {import('node:test').TestContext} t
 * @param {{ has?: string[], failBuild?: boolean, failPull?: boolean }} [opts]
 */
function stubPodman(t, { has = [], failBuild = false, failPull = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'podman-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'podman');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> ${log}
case "$1 $2" in
  "image exists")
    for known in ${has.map((h) => `'${h}'`).join(' ') || "''"}; do
      [ "$3" = "$known" ] && exit 0
    done
    exit 1 ;;
  "volume exists") exit 1 ;;
  "container exists") exit 1 ;;
esac
case "$1" in
  build) ${failBuild ? 'echo "Error: apt-get update failed" >&2; exit 1' : 'exit 0'} ;;
  pull)  ${failPull ? 'echo "Error: manifest unknown" >&2; exit 1' : 'exit 0'} ;;
  --version) echo "podman version 5.4.2"; exit 0 ;;
esac
exit 0
`,
  );
  chmodSync(bin, 0o755);

  const sandboxDir = path.join(dir, 'sandbox');
  mkdirSync(sandboxDir);
  const containerfile = path.join(sandboxDir, 'Containerfile');
  writeFileSync(containerfile, 'FROM debian:13-slim\n');

  return {
    dir,
    containerfile,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    /** @param {Partial<any>} patch @returns {any} */
    cfg: (patch = {}) => ({
      podmanBin: bin,
      sandboxImage: 'localhost/agent-session:latest',
      sandboxAutoBuild: true,
      sandboxContainerfile: containerfile,
      sandboxCredentialsFile: '',
      // Credential selection now consults the account store, which needs a
      // directory to look in — the box's own credential is no longer an answer.
      stateDir: dir,
      ...patch,
    }),
  };
}

// --- getting the image ------------------------------------------------------

test('an image that is already there is not rebuilt', (t) => {
  const s = stubPodman(t, { has: ['localhost/agent-session:latest'] });

  const r = ensureSandboxImage(s.cfg());

  assert.equal(r.ok, true);
  assert.equal(r.built, false);
  assert.ok(!s.calls().some((c) => c.startsWith('build')), 'rebuilding a present image is minutes of nothing');
});

test('a missing local image is BUILT rather than refused', (t) => {
  // Refusing to start a session over something we know exactly how to fix is
  // just making the operator do it by hand.
  const s = stubPodman(t, { has: [] });

  const r = ensureSandboxImage(s.cfg());

  assert.equal(r.ok, true);
  assert.equal(r.built, true);
  const build = s.calls().find((c) => c.startsWith('build'));
  assert.ok(build, 'it must actually build');
  assert.match(build, /-t localhost\/agent-session:latest/);
  assert.match(build, /-f .*Containerfile/);
});

test('a missing REMOTE image is pulled, not built', (t) => {
  // Building our Containerfile and tagging it with somebody else's name would
  // be a lie about what the image contains.
  const s = stubPodman(t, { has: [] });

  const r = ensureSandboxImage(s.cfg({ sandboxImage: 'ghcr.io/someone/agent-session:v2' }));

  assert.equal(r.ok, true);
  assert.ok(s.calls().some((c) => c === 'pull ghcr.io/someone/agent-session:v2'));
  assert.ok(!s.calls().some((c) => c.startsWith('build')));
});

test('auto-build can be turned off, and then it says so', (t) => {
  const s = stubPodman(t, { has: [] });

  const r = ensureSandboxImage(s.cfg({ sandboxAutoBuild: false }));

  assert.equal(r.ok, false);
  assert.match(String(r.message), /auto-build is off/);
  assert.match(String(r.message), /podman build -t/, 'still says how to do it by hand');
  assert.ok(!s.calls().some((c) => c.startsWith('build')));
});

test('a failed build reports the end of the log, not the whole thing', (t) => {
  // The last lines say what failed; everything before is layers succeeding.
  const s = stubPodman(t, { has: [], failBuild: true });

  const r = ensureSandboxImage(s.cfg());

  assert.equal(r.ok, false);
  assert.match(String(r.message), /apt-get update failed/);
  assert.match(String(r.message), /podman build -t/);
});

test('a missing Containerfile is named, rather than failing inside podman', (t) => {
  const s = stubPodman(t, { has: [] });

  const r = ensureSandboxImage(s.cfg({ sandboxContainerfile: '/nowhere/Containerfile' }));

  assert.equal(r.ok, false);
  assert.match(String(r.message), /\/nowhere\/Containerfile does not exist/);
});

// --- preparing a session ----------------------------------------------------

/** A linked Claude account, which a session now requires. @param {string} dir */
function linkAccount(dir, email = 'operator@example.com') {
  const accounts = path.join(dir, 'accounts');
  mkdirSync(accounts, { recursive: true });
  writeFileSync(path.join(accounts, `${email}.json`), JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
  return email;
}

test('a box where nobody has linked an account refuses, and names the remedy', (t) => {
  // THE BOX HAS NO CLAUDE ACCOUNT OF ITS OWN ANY MORE —
  // docs/one-account-per-person.md. Starting anyway would produce a session
  // sitting at a login prompt with nobody there to answer it, which is the
  // exact silent hang this tool exists to prevent.
  const s = stubPodman(t, { has: ['localhost/agent-session:latest'] });

  const r = ensureSandboxVolumes(s.cfg(), 'nobody');

  assert.equal(r.ok, false);
  assert.match(String(r.message), /No Claude account/);
  assert.match(String(r.message), /nobody has linked/);
});

test('starting a session builds the image, then creates its volumes', (t) => {
  const s = stubPodman(t, { has: [] });
  linkAccount(s.dir);

  const r = ensureSandboxVolumes(s.cfg(), 'bigjob');

  assert.equal(r.ok, true);
  const calls = s.calls().join('\n');
  assert.match(calls, /^build /m, 'the image comes first');
  assert.match(calls, /volume create claude-bigjob/);
  assert.match(calls, /volume create work-bigjob/);
});

test('a build failure stops before any volume is created', (t) => {
  // Half-prepared state is worse than none: the next attempt then has volumes
  // it did not make and cannot reason about.
  const s = stubPodman(t, { has: [], failBuild: true });

  linkAccount(s.dir);
  const r = ensureSandboxVolumes(s.cfg(), 'bigjob');

  assert.equal(r.ok, false);
  assert.ok(!s.calls().some((c) => c.startsWith('volume create')));
});

test('podman missing entirely is its own message', (t) => {
  const s = stubPodman(t);
  const r = ensureSandboxVolumes(s.cfg({ podmanBin: '/nonexistent/podman' }), 'bigjob');

  assert.equal(r.ok, false);
  assert.match(String(r.message), /is not installed, but AGENT_HUB_SANDBOX is on/);
});

// --- names and teardown -----------------------------------------------------

test('volumes and the container are named per session', () => {
  assert.deepEqual(sandboxNames('bigjob'), {
    claude: 'claude-bigjob',
    work: 'work-bigjob',
    container: 'agent-bigjob',
  });
});

test('forgetting a session removes both of its volumes', (t) => {
  const s = stubPodman(t, { has: ['localhost/agent-session:latest'] });
  // volumeExists says no in the stub, so nothing is removed — which is itself
  // the right behaviour: never try to delete what is not there.
  const r = removeSandboxVolumes(s.cfg(), 'bigjob');
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.failed, []);
});
