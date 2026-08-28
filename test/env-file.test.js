// The CLIs are configured by a systemd EnvironmentFile. systemd reads it as
// root before dropping to User=, so the SERVICE always works — and every
// subcommand a person types from a shell got nothing, because a shell has
// never heard of that file.
//
// That is how `agent-fleet-sidecar enrol <pin>` came to report
// "AGENT_FLEET_COORDINATOR_URL is not set" on a box where the URL was in
// /etc/agent-fleet-sidecar.env, written minutes earlier by the installer that
// printed the command. Every in-project caller passed the values explicitly,
// so the only path through the environment was the one a human types.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEnvFile } from '../src/core/env-file.js';

function envFile(body) {
  const f = join(mkdtempSync(join(tmpdir(), 'envfile-')), 'test.env');
  writeFileSync(f, body);
  return f;
}

test('reads a plain systemd env file', () => {
  const env = {};
  const f = envFile('AGENT_FLEET_COORDINATOR_URL=https://fleet.thetech.network\n');
  loadEnvFile(f, env);
  assert.equal(env.AGENT_FLEET_COORDINATOR_URL, 'https://fleet.thetech.network');
});

test('the real environment wins, so systemd is never second-guessed', () => {
  const env = { AGENT_FLEET_COORDINATOR_URL: 'https://from-systemd' };
  const f = envFile('AGENT_FLEET_COORDINATOR_URL=https://from-file\n');
  loadEnvFile(f, env);
  assert.equal(env.AGENT_FLEET_COORDINATOR_URL, 'https://from-systemd');
});

test('an empty value in the real environment still wins over the file', () => {
  // Distinct from undefined: systemd setting a variable to empty is a choice.
  const env = { AGENT_FLEET_HUB_TOKEN: '' };
  loadEnvFile(envFile('AGENT_FLEET_HUB_TOKEN=fromfile\n'), env);
  assert.equal(env.AGENT_FLEET_HUB_TOKEN, '');
});

test('strips one layer of quotes, the way systemd does', () => {
  const env = {};
  loadEnvFile(envFile(`A="double"\nB='single'\nC=bare\nD="mid\\"dle"\n`), env);
  assert.equal(env.A, 'double');
  assert.equal(env.B, 'single');
  assert.equal(env.C, 'bare');
});

test('ignores comments, blanks, and lines that are not assignments', () => {
  const env = {};
  loadEnvFile(envFile('# a comment\n\n   \nNOTANASSIGNMENT\n=novalue\nOK=yes\n'), env);
  assert.deepEqual(Object.keys(env), ['OK']);
});

test('a value containing = keeps everything after the first one', () => {
  const env = {};
  loadEnvFile(envFile('AGENT_FLEET_HUB_TOKEN=abc=def==\n'), env);
  assert.equal(env.AGENT_FLEET_HUB_TOKEN, 'abc=def==');
});

test('a missing file is not an error — a working tree has no /etc file', () => {
  const env = {};
  assert.deepEqual(loadEnvFile('/nonexistent/agent-fleet.env', env), []);
  assert.deepEqual(env, {});
});

test('an unreadable file is not an error either', () => {
  const f = envFile('AGENT_FLEET_HUB_TOKEN=secret\n');
  chmodSync(f, 0o000);
  const env = {};
  // Root can read a 0000 file, so only assert the call is safe and silent.
  assert.doesNotThrow(() => loadEnvFile(f, env));
});

test('returns the names it set, so a caller can say where a value came from', () => {
  const env = { B: 'already' };
  assert.deepEqual(loadEnvFile(envFile('A=1\nB=2\nC=3\n'), env), ['A', 'C']);
});
