// House rules reach a session, and only ever as data.
//
//   node --test test/
//
// WHAT THIS IS FOR. Claude Code reads `~/.claude/CLAUDE.md`, and a sandboxed
// session's `~/.claude` is the fresh `claude-<name>` volume — seeded with a
// credential and nothing else, on purpose. So a box whose owner had written
// house rules for their own shell ran sessions that never saw a line of them,
// and there was no way to fix it short of baking a file into the image.
//
// TWO PROPERTIES ARE WORTH A TEST HERE and they pull in opposite directions.
//
//   1. The rules must actually arrive, or this is a setting that does nothing.
//   2. The rules are PROSE SOMEBODY WROTE, and prose that reaches a command
//      line is the failure this repository is most careful about. It goes on
//      stdin. The test below asserts the content is absent from the argument
//      list, not merely present on stdin — "it works" and "it cannot be made
//      to do something else" are different claims and only the second one is
//      the security one.
//
// And one that is about honesty rather than function: a rules file that cannot
// be used must SAY SO. Silently treating an oversized or empty file as an
// absent one is how somebody spends an evening wondering why their rules do
// nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readHouseRules, describeHouseRules, RULES_MAX } from '../src/core/rules.js';
import { ensureSandboxVolumes } from '../src/core/podman.js';

const HOUR = 3_600_000;

/**
 * A box with a podman that records what it was asked to do — arguments in one
 * file, whatever arrived on stdin in another.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ rules?: string|null, volumes?: string[] }} [opts]
 */
function box(t, { rules = null, volumes = [] } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'house-rules-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const calls = path.join(dir, 'calls.log');
  const stdin = path.join(dir, 'stdin.txt');
  const bin = path.join(dir, 'podman');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> ${calls}
case "$1 $2" in
  "image inspect") exit 0 ;;
  "volume inspect")
    for known in ${volumes.map((v) => `'${v}'`).join(' ') || "''"}; do
      [ "$3" = "$known" ] && exit 0
    done
    exit 1 ;;
esac
case "$*" in
  # The seeding container consumes its stdin, so this stub has to as well —
  # otherwise the write succeeds against a pipe nobody drained.
  *CLAUDE.md*) cat > ${stdin} ; exit 0 ;;
esac
case "$1" in
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

  const credentials = path.join(home, '.credentials.json');
  writeFileSync(
    credentials,
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 5 * HOUR } }),
  );

  // A LINKED ACCOUNT, because without one ensureSandboxVolumes refuses before
  // it ever gets as far as the rules — a session with no Claude account comes
  // up at a login prompt, which is a different and much louder failure.
  const accounts = path.join(state, 'accounts');
  mkdirSync(accounts, { recursive: true });
  writeFileSync(
    path.join(accounts, 'operator@example.com.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 5 * HOUR } }),
  );

  const rulesFile = path.join(state, 'CLAUDE.md');
  if (rules !== null) writeFileSync(rulesFile, rules);

  return {
    dir,
    rulesFile,
    /** Every podman invocation, one per line. */
    calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []),
    /** The invocations that write the rules file into a volume. */
    writes: () => (existsSync(calls) ? readFileSync(calls, 'utf8').split('\n') : []).filter((c) => c.includes('CLAUDE.md')),
    /** What was handed to the container on stdin, if anything ever was. */
    stdin: () => (existsSync(stdin) ? readFileSync(stdin, 'utf8') : null),
    /** @param {Partial<any>} patch @returns {any} */
    cfg: (patch = {}) => ({
      podmanBin: bin,
      sandboxImage: 'localhost/agent-session:latest',
      sandboxAutoBuild: false,
      sandboxContainerfile: path.join(dir, 'Containerfile'),
      sandboxCredentialsFile: credentials,
      stateDir: state,
      rulesFile,
      ...patch,
    }),
  };
}

// --- reading them -----------------------------------------------------------

test('a box with no rules file has none, which is not a fault', (t) => {
  const s = box(t, { rules: null });
  assert.equal(readHouseRules(s.cfg()), null);
  assert.equal(describeHouseRules(null), null, 'and nothing is said about it');
});

test('rules are read with their size, because the size is the cost', (t) => {
  const s = box(t, { rules: '# How we work here\n\nSmall commits.\n' });
  const rules = readHouseRules(s.cfg());

  assert.equal(rules?.ok, true);
  assert.match(String(rules?.text), /Small commits/);
  const written = '# How we work here\n\nSmall commits.\n';
  assert.equal(rules?.chars, written.length);
  assert.match(String(describeHouseRules(rules)), new RegExp(`${written.length} characters`));
});

test('an oversized file is refused rather than cut short, and says which it is', (t) => {
  // NOT TRUNCATED, which is the opposite of what a profile does. A profile cut
  // short is a shorter instruction; rules cut short are DIFFERENT RULES, and
  // half of "never force-push, except on a branch you created" is a licence.
  const s = box(t, { rules: 'x'.repeat(RULES_MAX + 1) });
  const rules = readHouseRules(s.cfg());

  assert.equal(rules?.ok, false);
  assert.equal(rules?.text, null, 'a truncated rule is a different rule');
  assert.equal(rules?.chars, RULES_MAX + 1, 'the size is reported even though it is unusable');
  assert.match(String(rules?.why), /limit is 12000/);
  assert.match(String(describeHouseRules(rules)), /NOT IN USE/);
});

test('a file of blank lines is not rules', (t) => {
  // C-5, on this project's own doorstep: reporting whitespace as house rules
  // would be claiming a state the evidence does not support.
  const s = box(t, { rules: '\n\n   \n' });
  const rules = readHouseRules(s.cfg());

  assert.equal(rules?.ok, false);
  assert.match(String(rules?.why), /empty/);
});

test('a directory where the file should be is reported, not ignored', (t) => {
  const s = box(t, { rules: null });
  mkdirSync(s.rulesFile);
  const rules = readHouseRules(s.cfg());

  assert.equal(rules?.ok, false);
  assert.match(String(rules?.why), /not a file/);
});

// --- getting them into a session --------------------------------------------

test('a new session gets the rules, and they never touch the argument list', (t) => {
  // BOTH HALVES MATTER. That the content arrives is the feature; that it
  // arrives ONLY on stdin is the reason this is safe to have at all. Prose
  // somebody wrote, in a shell command, is the failure mode this repository
  // spends most of its care on.
  const secret = '# House rules\n\nAlways `run the tests`; never $(guess).\n';
  const s = box(t, { rules: secret });

  const r = ensureSandboxVolumes(s.cfg(), 'fresh', null);
  assert.equal(r.ok, true);

  assert.equal(s.stdin(), secret, 'the rules did not reach the container');
  assert.equal(s.writes().length, 1, 'written once, on creation');
  for (const call of s.calls()) {
    assert.doesNotMatch(call, /run the tests|guess/, `content in the argument list: ${call}`);
  }
});

test('a resumed session keeps the rules it began with', (t) => {
  // ON CREATION ONLY. A session's standing instructions must not change under
  // it — that is what makes a running session something you can reason about.
  // Edit the file and the NEXT session gets it.
  const s = box(t, { rules: '# rules\n', volumes: ['claude-old', 'work-old'] });

  const r = ensureSandboxVolumes(s.cfg(), 'old', null, { account: 'shared' });

  assert.equal(r.ok, true);
  assert.equal(s.writes().length, 0, 'a resume rewrote the rules under a live session');
});

test('a box with no rules file starts sessions exactly as it did before', (t) => {
  const s = box(t, { rules: null });

  const r = ensureSandboxVolumes(s.cfg(), 'plain', null);

  assert.equal(r.ok, true);
  assert.equal(s.writes().length, 0);
  assert.equal(s.stdin(), null);
});

test('rules that cannot be used do not stop a session starting', (t) => {
  // A session without a credential comes up at a login prompt nobody can
  // answer, so that refuses. A session without house rules does the same work
  // slightly differently, so this must not. The warning is the remedy.
  const s = box(t, { rules: 'x'.repeat(RULES_MAX + 1) });

  const r = ensureSandboxVolumes(s.cfg(), 'fresh', null);

  assert.equal(r.ok, true, 'an unusable rules file refused a start');
  assert.equal(s.writes().length, 0);
});
