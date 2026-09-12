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

import {
  ensureSandboxImage,
  ensureSandboxVolumes,
  sandboxNames,
  removeSandboxVolumes,
  healRootlessSandbox,
} from '../src/core/podman.js';

/**
 * A podman that answers however the test wants and logs every invocation.
 * @param {import('node:test').TestContext} t
 * @param {{ has?: string[], failBuild?: boolean, failPull?: boolean,
 *   poisoned?: boolean, maskKind?: 'hidepid'|'kmsg', stillMasked?: boolean,
 *   failUnshare?: boolean, failMigrate?: boolean }} [opts]  `poisoned` makes the
 *   rootless /proc not fully visible — via `hidepid` (ProtectProc) or a
 *   /proc/kmsg overmount (ProtectKernelLogs), per `maskKind`. `stillMasked`
 *   keeps it poisoned even after `system migrate`, standing in for a box where
 *   agent-hub itself still masks /proc.
 */
function stubPodman(
  t,
  {
    has = [],
    failBuild = false,
    failPull = false,
    poisoned = false,
    maskKind = 'hidepid',
    stillMasked = false,
    failUnshare = false,
    failMigrate = false,
  } = {},
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'podman-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'podman');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> ${log}
# INSPECT, NOT EXISTS. Podman has "volume exists" and friends; Docker has no
# equivalent, and CI has Docker and no Podman -- so the container half of the
# sandbox could never be exercised there. "inspect" is on both engines and
# answers the same question by exit status, so this fake answers it too.
case "$1 $2" in
  "image inspect")
    for known in ${has.map((h) => `'${h}'`).join(' ') || "''"}; do
      [ "$3" = "$known" ] && exit 0
    done
    exit 1 ;;
  "volume inspect") exit 1 ;;
  "container inspect") exit 1 ;;
  # The rootless pause namespace's mount table, as \`podman unshare\` would show
  # it. A healthy box carries a fully-visible /proc (binfmt_misc is a functional
  # submount, NOT poisoning); a poisoned one masks /proc via hidepid or a
  # /proc/kmsg overmount. \`system migrate\` recreates it clean — unless the box
  # is stillMasked, standing in for agent-hub itself masking /proc.
  "unshare cat")
    ${failUnshare ? 'exit 1' : ''}
    printf '%s\\n' '23 28 0:22 / /sys rw,nosuid,nodev,noexec,relatime shared:2 - sysfs sysfs rw'
    printf '%s\\n' '30 29 0:31 / /proc/sys/fs/binfmt_misc rw,relatime shared:14 - autofs systemd-1 rw'
    if grep -q 'system migrate' ${log} 2>/dev/null ${stillMasked ? '&& false' : ''}; then
      printf '%s\\n' '29 33 0:26 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw'
    else
      ${
        poisoned
          ? maskKind === 'kmsg'
            ? `printf '%s\\n' '29 33 0:26 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw'
    printf '%s\\n' '31 29 0:24 /systemd/inaccessible/reg /proc/kmsg ro,nosuid,nodev,noexec,relatime shared:15 - tmpfs tmpfs rw'`
            : `printf '%s\\n' '29 33 0:26 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw,hidepid=invisible'`
          : `printf '%s\\n' '29 33 0:26 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw'`
      }
    fi
    exit 0 ;;
  "system migrate") ${failMigrate ? 'echo "Error: migrate failed" >&2; exit 1' : 'exit 0'} ;;
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

// --- the /proc self-heal ----------------------------------------------------
//
// A rootless pause namespace whose /proc is not fully visible gives every
// session a proc mount the kernel refuses. TWO systemd directives cause it —
// `ProtectProc=invisible` (hidepid) and `ProtectKernelLogs=yes` (a /proc/kmsg
// overmount) — and dropping only the first is what left the fleet down, so the
// self-heal must catch either. Removing the directive is not enough on an
// already-broken box (the poisoned pause outlives the restart), so startup
// recreates it. These pin that it fires for either mask, verifies the result
// rather than assuming it, and never migrates a healthy box (which would take
// its live sessions down) — including not mistaking binfmt_misc for poisoning.

test('a hidepid-poisoned namespace (ProtectProc) is recreated so sessions can mount /proc again', (t) => {
  const s = stubPodman(t, { poisoned: true, maskKind: 'hidepid' });

  const r = healRootlessSandbox(s.cfg());

  assert.equal(r.healed, true);
  assert.ok(s.calls().some((c) => c === 'system migrate'), 'it recreates the pause namespace');
});

test('a /proc/kmsg-poisoned namespace (ProtectKernelLogs) is recreated too', (t) => {
  // The mask that dropping ProtectProc alone missed — a /proc/kmsg overmount is
  // just as invisible to a container as hidepid.
  const s = stubPodman(t, { poisoned: true, maskKind: 'kmsg' });

  const r = healRootlessSandbox(s.cfg());

  assert.equal(r.healed, true);
  assert.ok(s.calls().some((c) => c === 'system migrate'));
});

test('a healthy namespace is left alone — binfmt_misc is not mistaken for poisoning', (t) => {
  // The stub always carries a /proc/sys/fs/binfmt_misc submount, as a real box
  // does; it is functional, not a mask, and must never trigger a migrate that
  // would take a live session down.
  const s = stubPodman(t, { poisoned: false });

  const r = healRootlessSandbox(s.cfg());

  assert.equal(r.healed, false);
  assert.ok(!s.calls().some((c) => c === 'system migrate'), 'a clean box is never migrated');
});

test('the self-heal without podman is a no-op with a reason, not a crash', (t) => {
  const s = stubPodman(t);

  const r = healRootlessSandbox(s.cfg({ podmanBin: '/nonexistent/podman' }));

  assert.equal(r.healed, false);
  assert.match(String(r.why), /podman/);
});

test('a rootless namespace that cannot be read is a no-op, not a false heal', (t) => {
  const s = stubPodman(t, { failUnshare: true });

  const r = healRootlessSandbox(s.cfg());

  assert.equal(r.healed, false);
  assert.match(String(r.why), /rootless namespace/);
  assert.ok(!s.calls().some((c) => c === 'system migrate'));
});

test('a failed namespace recreate is reported, not hidden behind a healed=true', (t) => {
  const s = stubPodman(t, { poisoned: true, failMigrate: true });

  const r = healRootlessSandbox(s.cfg());

  assert.equal(r.healed, false);
  assert.match(String(r.why), /migrate failed/);
});

test('a migrate that leaves /proc still masked is reported, not falsely called healed', (t) => {
  // The box where agent-hub ITSELF still masks /proc: migrate runs, but the new
  // pause comes back just as poisoned. The self-heal must verify, not assume —
  // this is the failure that made the first version log a reassuring lie.
  const s = stubPodman(t, { poisoned: true, stillMasked: true });

  const r = healRootlessSandbox(s.cfg());

  assert.equal(r.healed, false);
  assert.ok(s.calls().some((c) => c === 'system migrate'), 'it tries');
  assert.match(String(r.why), /still masking/);
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
