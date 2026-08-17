// The sandbox launch line.
//
//   node --test test/
//
// Pure string assembly, so it is testable without podman. The container itself
// was validated on hardware (design.md §10); what is worth pinning here is the
// exact argv, because every property §2 relies on is a consequence of it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommand } from '../src/core/claude.js';
import { sandboxNames } from '../src/core/podman.js';

/** @param {Partial<any>} patch @returns {any} */
const cfg = (patch = {}) => ({
  claudeBin: '/usr/local/bin/claude',
  remoteControl: true,
  skipPermissions: true,
  sandbox: false,
  podmanBin: 'podman',
  sandboxImage: 'agent-session:latest',
  sandboxMemory: '8g',
  sandboxCpus: '2',
  sandboxPidsLimit: '512',
  sandboxExtraArgs: [],
  sandboxHookSocket: true,
  sandboxHookSocketDir: '/run/agent-fleet',
  sandboxCredentialsFile: '/root/.claude/.credentials.json',
  ...patch,
});

test('with the sandbox off, the command is unchanged', () => {
  // A box without podman must keep working exactly as before.
  const line = buildCommand(cfg(), { name: 'api' });
  assert.equal(line, "IS_SANDBOX=1 exec '/usr/local/bin/claude' '--remote-control' 'api' '--dangerously-skip-permissions'");
  assert.ok(!line.includes('podman'));
});

test('with the sandbox on, the pane process becomes podman run', () => {
  const line = buildCommand(cfg({ sandbox: true }), { name: 'api' });

  // `exec` + `--rm` + pane-process-is-podman is what makes a dead container end
  // the tmux session, which reconcile already handles as "ended". Losing any of
  // the three silently breaks restore.
  assert.match(line, /^IS_SANDBOX=1 exec 'podman' 'run' '--rm' '-it'/);
  // -it is what gives the container the pane's TTY. Without it claude renders
  // nothing and the resume dialog can never be detected.
  assert.match(line, /'-it'/);
});

test('the two volumes are per session, and the workdir is the fixed mount', () => {
  const line = buildCommand(cfg({ sandbox: true }), { name: 'bigjob' });
  const { claude, work, container } = sandboxNames('bigjob');

  assert.equal(claude, 'claude-bigjob');
  assert.equal(work, 'work-bigjob');
  assert.equal(container, 'agent-bigjob');
  assert.match(line, /'-v' 'claude-bigjob:\/root\/\.claude'/);
  assert.match(line, /'-v' 'work-bigjob:\/work'/);
  // A fixed /work is also what makes Claude's per-directory transcript slug
  // stable across runs (design.md §2).
  assert.match(line, /'-w' '\/work'/);
});

test('the hook socket is mounted per session, at a fixed path inside', () => {
  const line = buildCommand(cfg({ sandbox: true }), { name: 'bigjob' });
  // Per-session outside, always the same inside — which is what lets the
  // container report without knowing its own name.
  assert.match(line, /'-v' '\/run\/agent-fleet\/bigjob\.sock:\/run\/hub\.sock'/);
});

test('the hook socket mount can be turned off', () => {
  const line = buildCommand(cfg({ sandbox: true, sandboxHookSocket: false }), { name: 'bigjob' });
  assert.ok(!line.includes('hub.sock'));
});

test('resource limits become podman flags', () => {
  const line = buildCommand(cfg({ sandbox: true }), { name: 'api' });
  assert.match(line, /'--memory=8g'/);
  assert.match(line, /'--cpus=2'/);
  assert.match(line, /'--pids-limit=512'/);
});

test('an empty resource limit omits the flag rather than sending an empty one', () => {
  const line = buildCommand(cfg({ sandbox: true, sandboxMemory: '', sandboxCpus: '' }), { name: 'api' });
  assert.ok(!line.includes('--memory'));
  assert.ok(!line.includes('--cpus'));
  assert.match(line, /'--pids-limit=512'/);
});

test('the claude arguments follow the image, not podman', () => {
  const line = buildCommand(cfg({ sandbox: true }), {
    name: 'bigjob',
    resumeUuid: '11111111-2222-3333-4444-555555555555',
  });
  const image = line.indexOf("'agent-session:latest'");
  assert.ok(image > 0);
  // Everything claude-facing must land after the image name, or podman eats it.
  assert.ok(line.indexOf("'--remote-control'") > image);
  assert.ok(line.indexOf("'--resume'") > image);
  assert.ok(line.indexOf("'--dangerously-skip-permissions'") > image);
  // And the host's claude path is irrelevant inside the container.
  assert.ok(!line.includes('/usr/local/bin/claude'));
  assert.match(line, /'agent-session:latest' 'claude'/);
});

test('per-session permission and resume settings survive the sandbox path', () => {
  const safe = buildCommand(cfg({ sandbox: true }), { name: 'api', skipPermissions: false });
  assert.ok(!safe.includes('--dangerously-skip-permissions'), 'a deliberate safe-mode session stays safe');

  const noRc = buildCommand(cfg({ sandbox: true }), { name: 'api', remoteControl: false });
  assert.ok(!noRc.includes('--remote-control'));
});

test('extra podman arguments are passed through before the image', () => {
  const line = buildCommand(cfg({ sandbox: true, sandboxExtraArgs: ['--network=none', '--userns=keep-id'] }), {
    name: 'api',
  });
  assert.ok(line.indexOf("'--network=none'") < line.indexOf("'agent-session:latest'"));
  assert.match(line, /'--userns=keep-id'/);
});

test('a session name cannot escape the quoting', () => {
  // Names are charset-validated long before this, but the quoting is the second
  // layer and must hold on its own.
  const line = buildCommand(cfg({ sandbox: true }), { name: "ev'il" });
  assert.match(line, /'agent-ev'\\''il'/);
});
