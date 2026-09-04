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

import { migrationState, migrationReply, migrate, MIGRATE_BIN } from '../src/core/migrate.js';

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
