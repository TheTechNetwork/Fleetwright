import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('the browser is a variant, not a bigger default', () => {
  // The Containerfile's own rule is that this is not a place to put a
  // toolchain: a session has real root and can install anything, and all of it
  // is thrown away, so baking a tool in buys a faster start and costs the
  // property that makes the image trustworthy.
  //
  // Chromium is the argued exception rather than the first crack in it — it is
  // a capability rather than a tool, and its install is hundreds of megabytes
  // and minutes, PER SESSION, repeated. So it is a second tag, and the minimal
  // image every box gets stays minimal.
  const containerfile = readFileSync(new URL('../sandbox/Containerfile', import.meta.url), 'utf8');
  assert.match(containerfile, /^ARG WITH_CHROMIUM=0$/m, 'the browser is on by default');
  assert.match(containerfile, /if \[ "\$WITH_CHROMIUM" = "1" \]/);

  // ONE FILE, TWO TAGS. A second Containerfile is a second thing to keep in
  // step, and the half nobody uses is the half that rots.
  const workflow = readFileSync(new URL('../.github/workflows/sandbox.yml', import.meta.url), 'utf8');
  assert.equal((workflow.match(/file: sandbox\/Containerfile/g) || []).length >= 3, true);
  assert.match(workflow, /build-args: WITH_CHROMIUM=1/);
  assert.match(workflow, /type=raw,value=web/);
});

test('the image points the browser drivers at the browser it has', () => {
  // Playwright and Puppeteer download their own copy otherwise — inside a
  // container that is discarded, so it downloads again next session, which is
  // the whole cost this variant exists to remove.
  const containerfile = readFileSync(new URL('../sandbox/Containerfile', import.meta.url), 'utf8');
  for (const v of ['CHROME_BIN', 'PUPPETEER_EXECUTABLE_PATH', 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD']) {
    assert.match(containerfile, new RegExp(`^ENV ${v}=`, 'm'), `${v} is not set`);
  }
  // SET ON BOTH IMAGES on purpose: on the minimal one it names a binary that is
  // not there, and a tool that says "chromium is missing" is better than one
  // that quietly fetches 150MB into a container about to be thrown away.
  const at = containerfile.indexOf('ENV CHROME_BIN');
  const guard = containerfile.indexOf('if [ "$WITH_CHROMIUM" = "1" ]');
  assert.ok(at > guard, 'the driver hints are inside the conditional');
});

test('whether the browser keeps its own sandbox is measured, not assumed', () => {
  // Chromium's sandbox needs user namespaces, which a rootless container may or
  // may not give it, and the usual response is to reach for --no-sandbox and
  // stop thinking. The smoke job tries WITHOUT it first and says which way it
  // went — on the image we actually ship.
  const workflow = readFileSync(new URL('../.github/workflows/sandbox.yml', import.meta.url), 'utf8');
  const job = workflow.slice(workflow.indexOf('The browser variant starts'), workflow.indexOf('THE BUG THIS WHOLE JOB EXISTS FOR'));
  assert.ok(job.indexOf('--dump-dom') < job.indexOf('--no-sandbox'), 'it reaches for --no-sandbox first');
  // And it records the trade rather than hiding it: a page rendered without the
  // browser's sandbox is inside the session container, with the session's
  // credentials, and somebody should know that before pointing a fleet at it.
  assert.match(job, /::warning::chromium needs --no-sandbox/);
  assert.match(job, /as confined as the session is, and no more/);
});

test('the Containerfile is checked by something before a builder sees it', () => {
  // `sandbox ... parses` in verify.sh meant entrypoint.sh and tool-shim.sh —
  // the two shell scripts beside it. Nothing looked at the file that actually
  // builds the image, so three bare `//` left by a converted comment block
  // reached main and failed four minutes into a build matrix:
  //
  //   Containerfile:141
  //   >>> //
  //   ERROR: dockerfile parse error on line 141: unknown instruction: //
  const verify = readFileSync(new URL('../scripts/verify.sh', import.meta.url), 'utf8');
  assert.match(verify, /check-containerfile\.mjs sandbox\/Containerfile/);
  assert.match(verify, /^printf 'container  \.\.\. '$/m);
});
