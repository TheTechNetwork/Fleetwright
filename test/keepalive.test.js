// Keeping a credential alive on a box nobody is using.
//
//   node --test test/
//
// "Something has to ask." An OAuth credential renews when it is USED, and
// nothing on an idle host uses one — no session is running, which is what idle
// means. So it goes stale exactly when it must not.
//
// THE PROPERTY EVERY TEST HERE IS ABOUT: the verdict comes from the credential
// file, never from an exit code. Each of these commands can succeed without
// renewing anything — which is precisely what `auth status` was doing for
// weeks, called every twenty seconds by the watcher, while credentials expired
// underneath it. A keepalive that believes its own exit code is the same bug
// with a timer attached.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renewClaudeCredential, renewAllCredentials } from '../src/core/keepalive.js';

const HOUR = 3_600_000;

/**
 * A stub `claude` that writes whatever credential the test wants, and records
 * which rung called it.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ renewOn?: string|null, expiresIn?: number }} [opts]
 *   `renewOn` — the argv fragment that makes this stub renew. "status" makes
 *   the free rung work; "-p" makes only the paid one work; null renews never.
 */
function stubClaude(t, { renewOn = 'status', expiresIn = 8 * HOUR } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'keepalive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'claude');

  // Writes into CLAUDE_CONFIG_DIR when it is set, and into the shared home
  // otherwise — which is exactly what the real CLI does, and is the difference
  // the linked-account path depends on.
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> ${calls}
target="\${CLAUDE_CONFIG_DIR:-${dir}/home/.claude}"
case "$*" in
${renewOn ? `  *${renewOn}*)` : '  __never__)'}
    mkdir -p "$target"
    printf '{"claudeAiOauth":{"accessToken":"new","refreshToken":"r","expiresAt":%s}}' \\
      "$(( $(date +%s)000 + ${expiresIn} ))" > "$target/.credentials.json" ;;
esac
exit 0
`,
  );
  chmodSync(bin, 0o755);

  const state = path.join(dir, 'state');
  const home = path.join(dir, 'home', '.claude');
  mkdirSync(state, { recursive: true });
  mkdirSync(home, { recursive: true });

  /** @param {string} file @param {number} expiresAt */
  const write = (file, expiresAt) => {
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r', expiresAt } }));
    return file;
  };
  const shared = path.join(home, '.credentials.json');

  return {
    dir,
    shared,
    write,
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []),
    /** @param {string} email @param {number} expiresAt */
    link: (email, expiresAt) => {
      const accounts = path.join(state, 'accounts');
      mkdirSync(accounts, { recursive: true });
      return write(path.join(accounts, `${email}.json`), expiresAt);
    },
    /** @param {string} email */
    readLinked: (email) =>
      JSON.parse(readFileSync(path.join(state, 'accounts', `${email}.json`), 'utf8')),
    /** @returns {any} */
    cfg: () => ({ claudeBin: bin, stateDir: state, sandboxCredentialsFile: shared }),
  };
}

// --- when it spends nothing --------------------------------------------------

test('a credential with hours left is left alone', (t) => {
  // The expensive rung costs real quota, so it must only ever run when there
  // is something to gain. A keepalive that fires on a healthy credential is a
  // bill for nothing.
  const s = stubClaude(t);
  s.write(s.shared, Date.now() + 20 * HOUR);

  const r = renewClaudeCredential(s.cfg());

  assert.equal(r.outcome, 'already-fresh');
  assert.deepEqual(s.calls(), [], 'the CLI was not run at all');
});

test('a credential in a shape we cannot read is not spent on either', (t) => {
  // Unknown is not a licence to spend. Without a readable expiry the
  // measurement that makes this safe is unavailable, so there is no way to
  // tell whether anything was achieved — and an unverifiable renewal is worse
  // than none, because it reports success.
  const s = stubClaude(t);
  writeFileSync(s.shared, JSON.stringify({ somethingEntirelyNew: true }));

  const r = renewClaudeCredential(s.cfg());

  assert.equal(r.outcome, 'unchanged');
  assert.match(String(r.detail), /could not be verified/);
  assert.deepEqual(s.calls(), []);
});

test('no credential at all is its own answer, not a failure', (t) => {
  const s = stubClaude(t);
  assert.equal(renewClaudeCredential(s.cfg()).outcome, 'no-credential');
});

// --- the ladder --------------------------------------------------------------

test('the free step is tried first, and stops the ladder when it works', (t) => {
  const s = stubClaude(t, { renewOn: 'status' });
  s.write(s.shared, Date.now() + HOUR);

  const r = renewClaudeCredential(s.cfg());

  assert.equal(r.outcome, 'renewed');
  assert.equal(r.rung, 'auth status');
  assert.equal(s.calls().length, 1, 'the paid step was never reached');
  assert.ok(/** @type {number} */ (r.after) > /** @type {number} */ (r.before));
});

test('the paid step runs only when the free one did not move the expiry', (t) => {
  // The case this whole module exists for. `auth status` was called every
  // twenty seconds by the watcher for weeks and credentials expired anyway, so
  // "it probably renews" is not something to build on.
  const s = stubClaude(t, { renewOn: '-p' });
  // Inside the URGENT window — see the two-window tests below for why the paid
  // rung will not fire merely because the free one did nothing.
  s.write(s.shared, Date.now() + 10 * 60_000);

  const r = renewClaudeCredential(s.cfg());

  assert.equal(r.outcome, 'renewed');
  assert.equal(r.rung, 'a one-shot prompt');
  const calls = s.calls();
  assert.equal(calls.length, 2);
  assert.match(calls[0], /auth status/, 'cheapest first');
  assert.match(calls[1], /^-p /);
});

test('a CLI that renews nothing is reported as renewing nothing', (t) => {
  // THE POINT OF THE WHOLE DESIGN. Both commands exit 0 here. A keepalive that
  // read the exit code would report success forever while the credential
  // expired underneath it — which is the original bug, with a timer attached.
  const s = stubClaude(t, { renewOn: null });
  s.write(s.shared, Date.now() + 10 * 60_000);

  const r = renewClaudeCredential(s.cfg());

  assert.equal(r.outcome, 'unchanged');
  assert.equal(r.pressing, true);
  assert.match(String(r.detail), /did not move/);
  assert.equal(s.calls().length, 2, 'it tried everything before saying so');
});

// --- two windows, which one window got wrong --------------------------------
//
// Found by testing against a real box: "one of the hosts only has 6 hours left,
// want to see if it gets bumped to 8 — a test doesn't do it from the app."
// Nothing was wrong. WE DO NOT DECIDE WHEN A TOKEN REFRESHES; the CLI does, and
// an OAuth client renews near expiry rather than whenever it is asked. So a
// healthy token cannot be topped up early, by us or by anybody.

test('asking is free and starts early; spending waits for the tight window', (t) => {
  // With one window the paid rung fired every hour from four hours out,
  // bought nothing each time, and billed for the privilege of being early.
  const s = stubClaude(t, { renewOn: null });
  s.write(s.shared, Date.now() + 3 * HOUR);

  const r = renewClaudeCredential(s.cfg());

  assert.equal(s.calls().length, 1, 'only the free rung ran');
  assert.match(s.calls()[0], /auth status/);
  assert.equal(r.outcome, 'unchanged');
  assert.equal(r.pressing, false);
});

test('nothing happening with hours left is the expected answer, not a fault', (t) => {
  // And this is why it is a separate flag rather than a log level chosen at
  // the call site. With one window this logged a warning saying the mechanism
  // had failed — four times per token, on a perfectly healthy box. A warning
  // that fires that often is one nobody reads by the second day, and it would
  // have been the same warning that means something is genuinely wrong.
  const s = stubClaude(t, { renewOn: null });
  s.write(s.shared, Date.now() + 3 * HOUR);

  const r = renewClaudeCredential(s.cfg());

  assert.equal(r.pressing, false, 'a healthy credential must not raise the alarm');
  assert.match(String(r.detail), /renews near expiry, not on request/);
});

test('an expired credential is always pressing, however unreadable the clock', (t) => {
  const s = stubClaude(t, { renewOn: null });
  s.write(s.shared, Date.now() - HOUR);

  const r = renewClaudeCredential(s.cfg());

  assert.equal(r.pressing, true);
  assert.equal(s.calls().length, 2, 'both rungs, because there is nothing left to lose');
});

test('a credential six hours from expiry is left completely alone', (t) => {
  // The exact case that was tested on a real box. Six hours left is a HEALTHY
  // token two hours into an eight-hour life — there is nothing to renew, and
  // no amount of asking will bump it back up.
  const s = stubClaude(t);
  s.write(s.shared, Date.now() + 6 * HOUR);

  const r = renewClaudeCredential(s.cfg());

  assert.equal(r.outcome, 'already-fresh');
  assert.deepEqual(s.calls(), [], 'nothing was asked, because nothing was wrong');
});

test('a rewritten credential with no more life on it does not count as renewed', (t) => {
  // A later expiry, not merely a different file. A CLI that rewrote the same
  // token would change the mtime and grant nothing, and this must not be
  // fooled by activity.
  const s = stubClaude(t, { renewOn: 'status', expiresIn: HOUR });
  s.write(s.shared, Date.now() + 2 * HOUR);
  // Within the default window, so it will try — and the stub writes an expiry
  // EARLIER than the one already there.
  const r = renewClaudeCredential(s.cfg(), { within: 3 * HOUR });

  assert.equal(r.outcome, 'unchanged');
});

// --- linked accounts ---------------------------------------------------------

test("a guest's linked account is renewed too, and never through the box's own login", (t) => {
  // A linked account goes stale WORSE than the shared one: the shared
  // credential is used whenever anybody on the box works, while a linked
  // account belonging to somebody who has not started a session this week is
  // used by nothing at all. Skipping them would fix this for everybody except
  // the person most likely to hit it.
  const s = stubClaude(t, { renewOn: 'status' });
  s.write(s.shared, Date.now() + 20 * HOUR);
  const before = Date.now() + HOUR;
  s.link('guest@example.com', before);

  const results = renewAllCredentials(s.cfg());

  const guest = results.find((r) => r.account === 'guest@example.com');
  assert.equal(guest?.outcome, 'renewed');
  // Written back into the store, or the renewal happened in a temp directory
  // and evaporated.
  assert.ok(s.readLinked('guest@example.com').claudeAiOauth.expiresAt > before);
  // AND THE BOX'S OWN LOGIN IS UNTOUCHED. Running the CLI in the host's home
  // on somebody else's credential overwrites the shared one — a way to lose an
  // org login while trying to preserve a guest's.
  assert.equal(JSON.parse(readFileSync(s.shared, 'utf8')).claudeAiOauth.accessToken, 'old');
});

test('one account failing does not stop the others', (t) => {
  const s = stubClaude(t, { renewOn: 'status' });
  s.write(s.shared, Date.now() + HOUR);
  s.link('guest@example.com', Date.now() + HOUR);

  const results = renewAllCredentials(s.cfg());

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.outcome === 'renewed'));
});

// --- what the app says about it ---------------------------------------------

test('the app can say WHEN, not just what', async () => {
  // The question the screen was actually being asked and could not answer:
  // "one of the hosts only has 6 hours left, want to see if it gets bumped to
  // 8." Nothing was wrong and nothing was going to happen, and a Test button
  // sitting next to an expiry invites exactly the reading that asking harder
  // will help.
  const { dispatch } = await import('../src/adapters/commands.js');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const file = path.join(dir, '.credentials.json');
  // Six hours left: the exact case from the box, and a healthy token two hours
  // into an eight-hour life.
  writeFileSync(file, JSON.stringify({
    claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 6 * HOUR },
  }));
  const ctx = {
    cfg: { credentialKeepaliveMs: 3_600_000, sandbox: true, sandboxCredentialsFile: file, stateDir: dir },
    actor: null,
    login: { status: () => ({ loggedIn: true, email: 'box@example.com' }) },
  };

  const reply = await dispatch(/** @type {any} */ (ctx), '/verify claude');

  assert.equal(reply.ok, true);
  // WHEN, not just what. "Nothing to do yet" plus the hour it changes, because
  // the alternative is a person watching a number that is never going to move.
  assert.match(reply.text, /Nothing to do yet/);
  assert.match(reply.text, /cannot be topped up early/);
  // A SESSION CANNOT RENEW THE BOX'S CREDENTIAL, which is the other half of
  // that report — "starting a new session doesn't renew Claude". It cannot: a
  // sandboxed session works on a copy inside its own volume, so any refresh
  // the CLI does in there updates the copy and never the original. Saying so
  // is the difference between a person testing the right thing and the wrong
  // one.
  assert.match(reply.text, /copy in its volume/);
});
