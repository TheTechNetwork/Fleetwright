// Moving a checkout onto packaged releases, from the app.
//
// The last thing about updating that needed a shell. Everything else is
// unprivileged — fetch, verify, unpack, swap a symlink — and this one step is
// not, because it rewrites systemd units.
//
// So the tests here are mostly about the REFUSALS: when the answer is no, it
// has to say which no it is, because each one has a different fix and only one
// of them is something the person holding the phone can do.

import test from 'node:test';
import assert from 'node:assert/strict';

import { migrationState, migrationReply, migrate, healAfterRelease, ranInstaller, MIGRATE_BIN } from '../src/core/migrate.js';

const cfg = /** @type {any} */ ({ releaseManifest: 'https://github.com/o/r/releases/latest/download/manifest.json' });
const READY = { available: 'v0.2.3', configured: true };

test('a packaged box is already where it is going', () => {
  const m = migrationState(cfg, { packaged: true }, READY);
  assert.equal(m.can, false);
  assert.equal(m.reason, 'packaged');
});

test('a box that does not know where its releases come from says so', () => {
  const m = migrationState(cfg, { packaged: false }, { available: null, configured: false });
  assert.equal(m.can, false);
  assert.equal(m.reason, 'unconfigured');
  // Names the variable and the remedy. "Cannot migrate" on its own is a
  // sentence nobody can act on.
  assert.match(m.message, /AGENT_HUB_RELEASE_MANIFEST/);
  assert.match(m.message, /--upgrade/);
});

const HERE = { exists: () => true };
const ABSENT = { exists: () => false };

test('a missing helper is reported BEFORE somebody taps, not after', () => {
  // The grant is checked up front because the failure it prevents — `sudo: a
  // password is required` — is useless on a phone, and the fix is one command
  // on the box. Somebody reading this can pass it on; somebody reading a sudo
  // error cannot.
  //
  // This test relies on the helper NOT being installed here, which is true of
  // any machine that is not a Fleetwright host, including CI.
  const m = migrationState(cfg, { packaged: false }, READY, ABSENT);
  assert.equal(m.can, false);
  assert.equal(m.reason, 'no_helper');
  assert.match(m.message, /fleetwright-migrate/);
  assert.match(m.message, /--upgrade/);
});

test('the helper path is outside anything the service user can write', () => {
  // THE SECURITY PROPERTY, pinned here as well as in install-upgrade.test.js
  // because it is a property of the pair and either file could be edited alone.
  //
  // install.sh does `chown -R "$RUN_USER" "$DIR"`, and it must: applyRelease
  // unpacks releases and swaps `current` as the service user. A sudoers rule
  // naming a script in that tree would let the service rewrite what it runs as
  // root.
  assert.equal(MIGRATE_BIN, '/usr/local/sbin/fleetwright-migrate');
  assert.doesNotMatch(MIGRATE_BIN, /agent-fleet|fleetwright\/(current|releases)/);
});

test('a failed migration says nothing was switched over', () => {
  // WHAT SOMEBODY NEEDS TO KNOW FIRST after a failure is whether the box is
  // still running. The helper lays a release out and only then re-runs the
  // installer, so a failure anywhere leaves the units pointing at the checkout
  // — and saying so is the difference between "try again later" and "get to a
  // terminal now".
  const r = migrate({
    run: /** @type {any} */ (() => ({ status: 1, stdout: '', stderr: 'could not fetch the release manifest' })),
  });
  assert.equal(r.ok, false);
  assert.match(r.text, /could not fetch the release manifest/);
  assert.match(r.text, /Nothing was switched over/);
  assert.match(r.text, /running exactly what it was running before/);
});

test('sudo is never allowed to prompt', () => {
  // There is no terminal here. A sudo waiting for a password would hang until
  // the timeout and report nothing — the worst available failure, because it
  // looks like the migration is working.
  let argv = /** @type {any} */ (null);
  migrate({ run: /** @type {any} */ ((cmd, args) => { argv = [cmd, ...args]; return { status: 0, stdout: 'ok' }; }) });
  assert.deepEqual(argv, ['sudo', '-n', MIGRATE_BIN]);
});

test('a success reports how it ended, not the whole installer', () => {
  const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  const r = migrate({ run: /** @type {any} */ (() => ({ status: 0, stdout: long, stderr: '' })) });
  assert.equal(r.ok, true);
  assert.match(r.text, /Moved onto packaged releases/);
  assert.match(r.text, /line 59/);
  assert.doesNotMatch(r.text, /line 0\b/, 'the whole installer log was quoted at a phone');
});


// --- the reply /update actually returns -------------------------------------

test('a packaged box gets no migration answer at all', () => {
  // Null means "git, or the packaged path, has the better answer" — this
  // function declining is how the rest of /update keeps working unchanged.
  assert.equal(migrationReply(cfg, { packaged: true }, READY, HERE), null);
});

test('a box with no manifest URL is not offered a migration', () => {
  // There is nowhere to migrate TO. The unconfigured message belongs to the
  // release check, which says it in its own words.
  assert.equal(migrationReply(/** @type {any} */ ({}), { packaged: false }, READY, HERE), null);
});

test('a bare /update says what would happen and does not do it', () => {
  const r = migrationReply(cfg, { packaged: false }, READY, HERE);
  assert.ok(r);
  assert.equal(r.ok, true);
  assert.match(r.text, /git checkout/);
  assert.match(r.text, /v0\.2\.3 is waiting/);
  assert.match(r.text, /--apply to do it/);
  // A LAYOUT CHANGE IS NOT A THING TO DISCOVER HAVING HAPPENED. The same
  // check/apply split as every other button on that screen.
  assert.deepEqual(r.buttons, [{ label: 'Move to packaged releases', command: '/update --apply' }]);
});

test('an explicit apply runs it', () => {
  let ran = false;
  const r = migrationReply(cfg, { packaged: false }, READY, {
    ...HERE,
    apply: true,
    run: /** @type {any} */ (() => { ran = true; return { status: 0, stdout: 'done' }; }),
  });
  assert.equal(ran, true);
  assert.equal(r?.ok, true);
  assert.match(r.text, /Moved onto packaged releases/);
});

test('a check on a box missing the helper says so; a bare update does not', () => {
  // `--check` is somebody asking why. A bare /update on the same box has a
  // working git path and should take it rather than complain about a feature
  // that box has not been given.
  const asked = migrationReply(cfg, { packaged: false }, READY, { ...ABSENT, check: true });
  assert.match(asked?.text ?? '', /fleetwright-migrate/);
  assert.equal(migrationReply(cfg, { packaged: false }, READY, ABSENT), null);
});

test('nothing waiting falls through to git rather than saying no', () => {
  // Not news. A checkout with no release to move to is a checkout, and git has
  // the real answer about whether it is behind.
  const r = migrationReply(cfg, { packaged: false }, { available: null, configured: true }, { ...HERE, check: true });
  assert.equal(r, null);
});

test('/update on a checkout consults the migration before it consults git', async () => {
  // THE WIRING, which the tests above deliberately do not cover: they exercise
  // migrationReply directly, and a function that is correct and never called is
  // the failure this repository keeps finding. This dispatches the real verb.
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { dispatch } = await import('../src/adapters/commands.js');

  const dir = mkdtempSync(path.join(tmpdir(), 'migrate-'));
  mkdirSync(path.join(dir, '.git'));
  try {
    const r = await dispatch(
      /** @type {any} */ ({
        cfg: {
          installDir: dir,
          stateDir: dir,
          hostname: 'box',
          releaseManifest: 'https://github.com/o/r/releases/latest/download/manifest.json',
        },
      }),
      '/update --check',
    );
    // The helper is not on this machine, so the answer is the one that names
    // the fix — reached only if the update verb asked at all.
    assert.match(r.text, /fleetwright-migrate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after a release applies, root refreshes its half — after the reply has left', () => {
  /** @type {string[]} */
  const calls = [];
  /** @type {(() => void)[]} */
  const deferred = [];
  let restarted = 0;
  const heal = healAfterRelease({
    exists: () => true,
    after: (fn) => { deferred.push(fn); },
    run: (cmd, args) => { calls.push(`${cmd} ${args.join(' ')}`); return { status: 0, stdout: 'running the installer from the verified release, with --repair', stderr: '' }; },
    restart: () => { restarted++; },
    mark: () => true,
    logger: { info() {}, warn() {} },
  });
  assert.equal(heal.scheduled, true);
  assert.match(heal.text, /--repair/);
  assert.deepEqual(calls, [], 'nothing runs before the reply has gone out');
  assert.equal(deferred.length, 1);
  deferred[0]();
  assert.deepEqual(calls, [`sudo -n ${MIGRATE_BIN}`], 'sudo never prompts, and the helper takes no arguments');
  assert.equal(restarted, 1, 'restarts if the installer did not');
});

test('a heal that cannot run still restarts, and says so in the log', () => {
  /** @type {string[]} */
  const warned = [];
  let restarted = 0;
  const heal = healAfterRelease({
    exists: () => true,
    after: (fn) => fn(),
    run: () => ({ status: 1, stdout: '', stderr: 'sudo: a password is required' }),
    restart: () => { restarted++; },
    mark: () => true,
    logger: { info() {}, warn: (/** @type {string} */ m) => warned.push(m) },
  });
  assert.equal(heal.scheduled, true);
  assert.equal(restarted, 1, 'the new code applies either way');
  assert.match(warned.join('\n'), /could not refresh/);
  assert.match(warned.join('\n'), /a password is required/);
});

test('the siblings are told before the helper runs, and told even when it fails', () => {
  // THE BUG THIS PINS. A fleet showed `main-88 · up to date` for a box that
  // answered "already on main-102": the heal failed, the hub restarted itself
  // with a bare exit, and the restart marker — the one thing the sidecar
  // watches — was never written, because only restartSelf wrote it and the
  // scheduled heal skips restartSelf. The sidecar stayed on main-88 and said so
  // on every frame, and nothing compared that to the disk.
  /** @type {string[]} */
  const order = [];
  const heal = healAfterRelease({
    exists: () => true,
    after: (fn) => fn(),
    mark: (o) => { order.push(`mark ${o.head} by ${o.actor} in ${o.stateDir}`); return true; },
    run: () => { order.push('helper'); return { status: 1, stdout: '', stderr: 'sudo: a password is required' }; },
    restart: () => { order.push('exit'); },
    head: 'main-102',
    actor: 'fleet:eli@example.com',
    stateDir: '/var/lib/agent-hub',
    logger: { info() {}, warn() {} },
  });
  assert.equal(heal.scheduled, true);
  assert.deepEqual(order, ['mark main-102 by fleet:eli@example.com in /var/lib/agent-hub', 'helper', 'exit'],
    'the marker goes down first — a sibling the installer restarts starts after it and ignores it; one it fails to restart picks it up');
});

test('a successful heal also leaves the marker, written before the installer restarted anybody', () => {
  // Written after, every sibling the installer had just restarted would read a
  // marker newer than its own start and restart a second time for nothing.
  /** @type {string[]} */
  const order = [];
  healAfterRelease({
    exists: () => true,
    after: (fn) => fn(),
    mark: () => { order.push('mark'); return true; },
    run: () => { order.push('helper'); return { status: 0, stdout: 'running the installer from the verified release, with --repair', stderr: '' }; },
    restart: () => { order.push('exit'); },
    logger: { info() {}, warn() {} },
  });
  assert.deepEqual(order, ['mark', 'helper', 'exit']);
});

test('with no helper installed the update says what was not refreshed, and how to get it', () => {
  const heal = healAfterRelease({ exists: () => false, after: () => { throw new Error('must not schedule'); } });
  assert.equal(heal.scheduled, false);
  assert.match(heal.text, /--upgrade/);
  assert.match(heal.text, /not refreshed/);
});

test('a helper that exits 0 without running the installer is not called a success', () => {
  // THE BOX THIS PINS ran main-103 under `current`, with a hub that had
  // restarted at 04:14 and a sidecar that had not, and the journal said
  //
  //   update: the release’s installer ran with --repair; restarting to apply new code
  //
  // on every heal since the day before. Run by hand, the helper printed
  // "already on the packaged layout, running main-103 — nothing to do" and
  // exited 0: it was the helper from before the heal existed, which exits
  // there, and the hub took its exit code as the installer having run.
  /** @type {string[]} */
  const warned = [];
  /** @type {string[]} */
  const told = [];
  /** @type {string[]} */
  const order = [];
  healAfterRelease({
    exists: () => true,
    after: (fn) => fn(),
    mark: () => { order.push('mark'); return true; },
    run: () => {
      order.push('helper');
      return { status: 0, stdout: 'fetching https://example/rolling/manifest.json\nalready on the packaged layout, running main-103 — nothing to do\n', stderr: '' };
    },
    restart: () => { order.push('exit'); },
    logger: { info: (/** @type {string} */ m) => told.push(m), warn: (/** @type {string} */ m) => warned.push(m) },
  });

  assert.deepEqual(told, [], 'exit 0 was reported as the installer having run');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /without running the release.s installer/);
  // WHAT TO DO, because the helper cannot refresh itself and nothing else on
  // the box will: the one command, naming the release's own copy.
  assert.match(warned[0], /sudo install -m 0755 -o root -g root .*install\/fleetwright-migrate \/usr\/local\/sbin\/fleetwright-migrate/);
  assert.match(warned[0], /nothing to do/, 'the helper’s own last words are in the log');
  // And the box still moves: the marker went down first, so the sidecar
  // restarts on its own, and the hub restarts itself as it always did.
  assert.deepEqual(order, ['mark', 'helper', 'exit']);
});

test('the installer having run is read from the helper’s own words, on both of its routes', () => {
  assert.equal(ranInstaller('sha256 ok\nrunning the installer from the verified release, with --repair\n'), true);
  assert.equal(ranInstaller('sha256 ok\nrunning the installer from the verified release\n'), true, 'the bring-forward route');
  assert.equal(ranInstaller('already on the packaged layout, running main-103 — nothing to do\n'), false);
  assert.equal(ranInstaller(''), false, 'silence is not evidence');
});
