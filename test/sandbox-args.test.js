import test from 'node:test';
import assert from 'node:assert/strict';
import { unsafeSandboxArgs, unsafeSandboxMessage } from '../src/core/sandbox-args.js';

test('the options that end containment are refused', () => {
  const cases = [
    ['--privileged'],
    ['--network', 'host'],
    ['--network=host'],
    ['--net=host'],
    ['--pid=host'],
    ['--ipc=host'],
    ['--uts=host'],
    ['--userns=host'],
    ['--cap-add=ALL'],
    ['--cap-add', 'SYS_ADMIN'],
    ['--security-opt', 'seccomp=unconfined'],
    ['--security-opt=label=disable'],
    ['-v', '/:/host'],
    ['--volume=/:/host:ro'],
    ['--mount', 'type=bind,source=/,target=/host'],
  ];
  for (const argv of cases) {
    assert.equal(unsafeSandboxArgs(argv).length, 1, `should refuse ${argv.join(' ')}`);
  }
});

test('the ordinary uses of the escape hatch still work', () => {
  // This variable exists for a reason and most of what it is asked to do is
  // fine. A check that refused these would be deleted within a week, and the
  // dangerous ones would come back with it.
  const fine = [
    ['-v', '/srv/code:/work'],
    ['--volume=/home/agent/shared:/shared:ro'],
    ['--device=/dev/kvm'],
    ['--network=slirp4netns'],
    ['--cap-add=NET_ADMIN'],
    ['--security-opt', 'no-new-privileges'],
    ['--mount', 'type=bind,source=/srv,target=/srv'],
    ['--dns=1.1.1.1'],
  ];
  for (const argv of fine) {
    assert.deepEqual(unsafeSandboxArgs(argv), [], `should allow ${argv.join(' ')}`);
  }
});

test('the separated form is matched as well as the joined one', () => {
  // `--userns host` and `--userns=host` are the same instruction to podman, and
  // a check that only understood one of them would be a check somebody could
  // pass by pressing the space bar.
  assert.equal(unsafeSandboxArgs(['--userns', 'host']).length, 1);
  assert.equal(unsafeSandboxArgs(['--userns=host']).length, 1);
});

test('a refusal names the option and how to proceed anyway', () => {
  // A refusal somebody cannot act on gets worked around by deleting the check.
  const msg = unsafeSandboxMessage(unsafeSandboxArgs(['--privileged']));
  assert.match(msg, /--privileged/);
  assert.match(msg, /AGENT_HUB_SANDBOX_ALLOW_UNSAFE_ARGS=1/);
});

test('the config refuses to start, and the override downgrades it to a warning', async () => {
  const { loadConfig, validateConfig } = await import('../src/config.js');
  const base = { AGENT_HUB_SANDBOX: '1', AGENT_HUB_SANDBOX_ARGS: '--privileged' };

  const refused = validateConfig(loadConfig({ ...base }));
  assert.equal(refused.errors.some((e) => /--privileged/.test(e)), true);

  const allowed = validateConfig(loadConfig({ ...base, AGENT_HUB_SANDBOX_ALLOW_UNSAFE_ARGS: '1' }));
  assert.equal(allowed.errors.some((e) => /--privileged/.test(e)), false);
  // STILL SAID. Somebody who typed the override knows; somebody who inherited
  // the box does not, and this is the line that tells them.
  assert.equal(allowed.warnings.some((w) => /--privileged/.test(w)), true);
});
