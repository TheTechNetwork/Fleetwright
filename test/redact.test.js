// A credential must not reach the journal.
//
// This is a fix for a leak that was already shipping. login.js takes care —
// "the code is never logged" — and three surfaces above it logged the whole
// command line before the flow ever saw it. The care was real; it was just in
// the wrong file.
//
// It matters more since `logs` shipped: a service journal is now readable from
// a phone, so "only someone who already has the box can read it" stopped being
// the fallback argument.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { redactCommandLine, carriesSecret } from '../src/core/redact.js';

test('the authorization code never survives', () => {
  const secret = 'ac_01JZZZ-notreal-buttokenshaped';
  for (const line of [`/code ${secret}`, `code ${secret}`, `  /code   ${secret}  `]) {
    const out = redactCommandLine(line);
    assert.equal(out.includes(secret), false, line);
    assert.match(out, /<redacted>/);
  }
});

test('the provider survives, because a log line that says nothing helps nobody', () => {
  const out = redactCommandLine('/link github ghp_notarealtokenatall');
  assert.equal(out, '/link github <redacted>');
});

test('a secret is redacted before truncation, not after', () => {
  // The bug this pins: `line.slice(0, 120)` on a long secret logs a SHORTER
  // secret, which is not a safer one. Redaction has to come first, so the
  // 120-character window can never contain a prefix of the credential.
  const secret = 'x'.repeat(400);
  assert.equal(redactCommandLine(`/code ${secret}`).slice(0, 120).includes('xxx'), false);
});

test('an ordinary command is returned exactly as it was', () => {
  for (const line of ['/list', '/stop bigjob', '/logs hub 50', '/start --safe', '/answer job 2']) {
    assert.equal(redactCommandLine(line), line);
  }
});

test('a command with the secret not yet typed is left alone', () => {
  // `/code` on its own is a usage error the registry should answer for itself.
  // Masking a secret that is not there would turn a helpful error into a
  // confusing one.
  assert.equal(redactCommandLine('/code'), '/code');
  assert.equal(redactCommandLine('/link github'), '/link github');
});

test('every surface that logs a command line redacts it', () => {
  // A tripwire, not a unit test. The knowledge of which argument is a secret
  // lives in redact.js precisely so a fourth log site cannot quietly reopen
  // this — and the way that would happen is somebody adding a `log.info` with
  // a raw line, which is what this reads for.
  //
  // THE ARCHIVED ADAPTER IS STILL IN THE LIST. It is unwired (docs/telegram.md)
  // and it is still in the repository, and that document says restoring it is
  // "typing" — so a guard that stopped covering it would come back off exactly
  // when the code came back on. Following the file to its new path costs
  // nothing; dropping it costs the property.
  for (const file of [
    'src/adapters/http.js',
    'archive/telegram/telegram.js',
    'src/fleet/host/sidecar.js',
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const [, logged] of src.matchAll(/log\.info\(`[^`]*→ \$\{([^}]+)\}/g)) {
      // Only the ones that log a COMMAND. A `→ ${origin}` on a connection
      // message is not what this is guarding, and a tripwire that shouts about
      // it is a tripwire somebody disables.
      if (!/\b(line|text|cmd|command)\b/.test(logged)) continue;
      assert.match(logged, /redactCommandLine/, `${file} logs a command line raw: ${logged}`);
    }
  }
});

test('carriesSecret knows the verbs, with or without the slash', () => {
  assert.equal(carriesSecret('code'), true);
  assert.equal(carriesSecret('/link'), true);
  assert.equal(carriesSecret('peek'), false);
});

// --- the archived adapter ----------------------------------------------------

test('a Telegram token that is set is reported as inert, not ignored', async () => {
  // A SETTING THAT IS PRESENT AND DOES NOTHING IS THE WORST OF THE THREE
  // STATES. A box configured for Telegram would otherwise start clean, log
  // nothing and answer no messages — which reads as a broken bot rather than an
  // absent one, and sends whoever set it looking at Telegram.
  const { validateConfig: validate } = await import('../src/config.js');
  const withToken = /** @type {any} */ ({ telegram: { token: 'x' }, webEnabled: true, token: 'a'.repeat(24) });
  assert.ok(
    validate(withToken).warnings.some((w) => /archived/.test(w)),
    'a box carrying a token is not told the adapter is gone',
  );

  // AND NOTHING IS SAID WHEN IT IS ABSENT. "No AGENT_HUB_TELEGRAM_TOKEN — the
  // Telegram adapter is disabled" told every box in the fleet about a feature
  // that no longer exists, on every start, for ever.
  const without = /** @type {any} */ ({ telegram: { token: '' }, webEnabled: true, token: 'a'.repeat(24) });
  assert.equal(
    without.telegram.token,
    '',
    'fixture',
  );
  assert.ok(!validate(without).warnings.some((w) => /Telegram/i.test(w)));
});
