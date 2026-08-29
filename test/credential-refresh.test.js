// A resumed session gets today's credential, for the account it already had.
//
//   node --test test/
//
// THE BUG THIS FILE IS ABOUT, from a phone: "I tried restarting an old session
// it wouldn't work, only creating a new one from scratch." Both sessions were
// on the same box, on the same account, and the only difference between them
// was WHEN the credential was copied into the volume.
//
// The comment that caused it read "a resume never re-seeds, which is what
// keeps a session on the account it began with", and it was half right in the
// way this repo keeps producing: the ACCOUNT had to be kept, and the bytes
// were never the account. An OAuth access token has hours on it and its
// refresh token gets rotated when the host renews, so a copy taken on Tuesday
// is not a credential by Thursday — it is a receipt for one.
//
// So the account is pinned and the credential is not, and the tests below are
// mostly about the pinning: every way the account could be silently changed by
// a refresh is a way somebody's session quietly starts running on somebody
// else's Claude subscription.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureSandboxVolumes, refreshSeededCredentials, credentialSourceForAccount } from '../src/core/podman.js';

const HOUR = 3_600_000;

/**
 * A podman whose volumes already exist — the resume case, which the older stub
 * could not express because it answered `volume exists` with "no" always.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ volumes?: string[], oauthAccount?: object|null }} [opts]
 */
function stubPodman(t, { volumes = [], oauthAccount = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reseed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const log = path.join(dir, 'calls.log');
  const bin = path.join(dir, 'podman');
  // `run` is the interesting one: seeding and reading the volume's identity
  // both go through a throwaway container, and which of the two it is shows in
  // the arguments. The stub prints the oauthAccount so volumeAccount() has
  // something to parse.
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> ${log}
case "$1 $2" in
  "image exists") exit 0 ;;
  "volume exists")
    for known in ${volumes.map((v) => `'${v}'`).join(' ') || "''"}; do
      [ "$3" = "$known" ] && exit 0
    done
    exit 1 ;;
esac
case "$1" in
  run)
    case "$*" in
      *oauth-account.json*cat*|*cat*oauth-account.json*)
        ${oauthAccount ? `printf '%s' '${JSON.stringify(oauthAccount)}'` : 'true'}
        exit 0 ;;
    esac
    exit 0 ;;
  --version) echo "podman version 5.4.2"; exit 0 ;;
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
  const credential = (file, expiresAt) => {
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt } }));
    return file;
  };
  const shared = credential(path.join(home, '.credentials.json'), Date.now() + 5 * HOUR);

  return {
    dir,
    state,
    shared,
    credential,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    /** Seeding invocations only — `run` calls that copy rather than read. */
    seeds: () =>
      (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []).filter(
        (c) => c.startsWith('run ') && c.includes('/seed/.credentials.json'),
      ),
    /** Link a Claude account for `email` and return its credential path. */
    /** @param {string} email @param {number} [expiresAt] */
    link: (email, expiresAt = Date.now() + 5 * HOUR) => {
      const accounts = path.join(state, 'accounts');
      mkdirSync(accounts, { recursive: true });
      return credential(path.join(accounts, `${email}.json`), expiresAt);
    },
    /** @param {Partial<any>} patch @returns {any} */
    cfg: (patch = {}) => ({
      podmanBin: bin,
      sandboxImage: 'localhost/agent-session:latest',
      sandboxAutoBuild: false,
      sandboxContainerfile: path.join(dir, 'Containerfile'),
      sandboxCredentialsFile: shared,
      stateDir: state,
      ...patch,
    }),
  };
}

// --- the fix ----------------------------------------------------------------

test('resuming a session re-seeds the credential it already had', (t) => {
  const s = stubPodman(t, { volumes: ['claude-old', 'work-old'] });

  const r = ensureSandboxVolumes(s.cfg(), 'old', 'fleet:someone@example.com', { account: 'shared' });

  assert.equal(r.ok, true);
  assert.equal(r.account, 'shared');
  const seeds = s.seeds();
  assert.equal(seeds.length, 1, 'exactly one seeding pass, on the volume that already existed');
  assert.match(seeds[0], /claude-old:\/dest/);
  assert.ok(!s.calls().some((c) => c.startsWith('volume create')), 'nothing is recreated');
});

test('a fresh start still seeds exactly once and does not then refresh it', (t) => {
  // The refresh is for volumes that already existed. Running it after a create
  // would copy the same file twice and add a container run to every start.
  const s = stubPodman(t, { volumes: [] });

  const r = ensureSandboxVolumes(s.cfg(), 'brandnew', null);

  assert.equal(r.ok, true);
  assert.equal(s.seeds().length, 1);
});

// --- the pinning, which is the part that must not go wrong ------------------

test('a resume keeps the account it began with, not the account resuming it', (t) => {
  // Somebody else pressing resume must not move a session onto their Claude
  // subscription. The account comes off the record; the actor is only used for
  // the provider tokens, which key on the person by design.
  const s = stubPodman(t, { volumes: ['claude-alices', 'work-alices'] });
  const alice = s.link('alice@example.com');
  s.link('bob@example.com');

  const r = ensureSandboxVolumes(s.cfg(), 'alices', 'fleet:bob@example.com', { account: 'alice@example.com' });

  assert.equal(r.account, 'alice@example.com');
  assert.match(s.seeds()[0], new RegExp(alice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.ok(!s.seeds()[0].includes('bob@example.com'), "bob's credential went nowhere near it");
});

test('a session whose account is not on the record asks the volume', (t) => {
  // Every session anybody has running when this ships predates the refresh, so
  // the record is the wrong place to require an answer. The volume can
  // identify itself: .oauth-account.json is seeded beside the credential.
  const s = stubPodman(t, {
    volumes: ['claude-older', 'work-older'],
    oauthAccount: { emailAddress: 'alice@example.com' },
  });
  s.link('alice@example.com');

  const r = ensureSandboxVolumes(s.cfg(), 'older', null, { account: null });

  assert.equal(r.account, 'alice@example.com');
});

test('a volume that cannot say whose it is keeps the credential it has', (t) => {
  // Cannot-tell is not shared. Guessing here would silently move a session
  // onto a different account, which is worse than the staleness being fixed.
  const s = stubPodman(t, { volumes: ['claude-mystery', 'work-mystery'], oauthAccount: null });

  const r = ensureSandboxVolumes(s.cfg(), 'mystery', null, { account: null });

  assert.equal(r.ok, true);
  assert.equal(s.seeds().length, 0, 'nothing was seeded');
});

test('an account unlinked since the session started is reported, not substituted', (t) => {
  const s = stubPodman(t, { volumes: ['claude-orphan', 'work-orphan'] });

  const r = refreshSeededCredentials(s.cfg(), 'orphan', { account: 'gone@example.com' });

  assert.equal(r.refreshed, false);
  assert.equal(r.account, 'gone@example.com');
  assert.match(String(r.why), /no credential/);
  assert.equal(s.seeds().length, 0, 'the shared credential was not quietly used instead');
});

test('a host credential that is itself expired is not copied over a live one', (t) => {
  // The session's copy might still hold a working refresh token. Overwriting
  // it with a dead one would turn a session that could have recovered into one
  // that cannot — a refresh has to be able to decline.
  const s = stubPodman(t, { volumes: ['claude-stale', 'work-stale'] });
  s.credential(s.shared, Date.now() - HOUR);

  const r = refreshSeededCredentials(s.cfg(), 'stale', { account: 'shared' });

  assert.equal(r.refreshed, false);
  assert.match(String(r.why), /expired/);
  assert.equal(s.seeds().length, 0);
});

test('a refresh that fails is not fatal to the resume', (t) => {
  // Resuming with the credential it had is exactly the old behaviour. Refusing
  // to resume because a refresh could not happen would be a worse bug than the
  // one this fixes — it would lose work rather than delay it.
  const s = stubPodman(t, { volumes: ['claude-x', 'work-x'] });

  const r = ensureSandboxVolumes(s.cfg({ sandboxCredentialsFile: '/nowhere/.credentials.json' }), 'x', null, {
    account: 'shared',
  });

  assert.equal(r.ok, true);
});

// --- resolving an account to a file -----------------------------------------

test('an account resolves to its own file, or to nothing at all', (t) => {
  const s = stubPodman(t);
  const alice = s.link('alice@example.com');

  assert.equal(credentialSourceForAccount(s.cfg(), 'alice@example.com')?.source, alice);
  assert.equal(credentialSourceForAccount(s.cfg(), 'shared')?.source, s.shared);
  // Not "fall back to shared": a linked account that has gone away is a
  // different situation from never having had one, and the caller has to be
  // able to tell them apart to say something true about it.
  assert.equal(credentialSourceForAccount(s.cfg(), 'nobody@example.com'), null);
});
