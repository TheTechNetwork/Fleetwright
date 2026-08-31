// Only whoever started a login may finish it.
//
// `/code` completes whichever flow is open on the box. That was survivable
// while it could only be reached from surfaces that already HAD the box —
// Telegram, the CLI, the web UI. It stopped being survivable the moment `link`
// made it reachable by any fleet member:
//
//   1. an admin starts a login for the BOX (admin-gated at the coordinator)
//   2. a member sends `link {provider: claude, secret: <their own code>}`,
//      which is NOT gated, because scope is not read for `link`
//   3. the box's shared Claude account is now the member's, and every session
//      on that machine runs through an org they control
//
// `startedBy` was already being recorded. It was simply never read.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LoginFlow, failureLine } from '../src/core/login.js';
import { readFileSync } from 'node:fs';

/** A flow with a pending login, without needing tmux or the claude CLI. */
function pending(startedBy, url = 'https://claude.ai/oauth/authorize?code=true') {
  const flow = new LoginFlow(/** @type {any} */ ({ loginEnabled: true, loginTimeoutMs: 600_000 }));
  flow.pending = { startedAt: Date.now(), startedBy, url, mode: 'claudeai' };
  flow.isPending = () => true;
  return flow;
}

test('a member cannot finish the admin’s box login', async () => {
  const flow = pending('fleet:admin@example.com');
  const r = await flow.submitCode('code_from_the_attacker', 'fleet:member@example.com');
  assert.equal(r.ok, false);
  assert.match(r.message, /No login is waiting/);
});

test('the refusal is byte-identical to “nothing is waiting”', async () => {
  // Otherwise it is an oracle: a distinct "that is not your login" tells a
  // member that somebody else's flow is open RIGHT NOW, which is the timing
  // half of the attack handed over for free. Same discipline as the
  // scheduler's unknown_session refusal.
  const wrongPerson = await pending('fleet:admin@example.com').submitCode('x', 'fleet:member@example.com');

  const idle = new LoginFlow(/** @type {any} */ ({ loginEnabled: true, loginTimeoutMs: 600_000 }));
  idle.isPending = () => false;
  const nothing = await idle.submitCode('x', 'fleet:member@example.com');

  assert.equal(wrongPerson.message, nothing.message);
  assert.equal(wrongPerson.ok, nothing.ok);
});

test('one member cannot land their credential in another member’s slot', async () => {
  // submitCode takes the destination from pending.linkFor, never from the
  // caller — so without this check, A's code completing B's flow stores A's
  // credential under B's email and B's sessions run as A.
  const flow = pending('fleet:victim@example.com');
  flow.pending.linkFor = 'victim@example.com';
  const r = await flow.submitCode('code_from_the_attacker', 'fleet:attacker@example.com');
  assert.equal(r.ok, false);
});

test('the box’s own surfaces are one identity, so the installer still works', async () => {
  // install.sh starts a login as `web` and the operator may finish it from
  // Telegram later. Both already required the hub token or the allowlist —
  // treating them as one identity names who they already are.
  const flow = pending('web');
  // Gets past the ownership check and fails later, on the real work, because
  // there is no pane. What matters is WHICH failure.
  const r = await flow.submitCode('a-code', 'telegram:12345').catch((e) => ({ ok: false, message: e.message }));
  assert.equal(/No login is waiting/.test(r.message), false, 'a local surface was refused as if it were a stranger');
});

test('a fleet member cannot pose as the box', async () => {
  // The mirror of the test above, and the reason the rule is not simply
  // "non-empty actors are interchangeable".
  const flow = pending('web');
  const r = await flow.submitCode('a-code', 'fleet:member@example.com');
  assert.equal(r.ok, false);
  assert.match(r.message, /No login is waiting/);
});

test('a pending login’s URL is not handed to whoever asks', async () => {
  // The disclosure that turned a race into a plan. `start()` used to refuse a
  // second login WITH the first one's authorization URL — so an attacker could
  // ask for a login, be told one was waiting, receive the admin's URL, open
  // it, authorize with their own account and hand back a code. PKCE binds the
  // code to the pane on this box, so without the URL there was nothing they
  // could produce.
  const flow = pending('fleet:admin@example.com', 'https://claude.ai/oauth/authorize?code=true&client_id=SECRETISH');

  const stranger = await flow.start({ actor: 'fleet:member@example.com' });
  assert.equal(stranger.ok, false);
  assert.equal(stranger.message.includes('claude.ai'), false, 'the URL leaked to somebody else');
  assert.match(stranger.message, /already in progress/);

  const starter = await flow.start({ actor: 'fleet:admin@example.com' });
  assert.ok(starter.message.includes('claude.ai'), 'the person who started it still gets it back');
});

test('a refused sign-in shows the CLI\'s sentence, not the tail of a URL', () => {
  // Captured from a real pane (CLI 2.1.234) after submitting a bad code. The
  // CLI says something genuinely useful — a diagnosis and a remedy in one
  // sentence — and taking the last five lines delivered it underneath two
  // fragments of a percent-encoded authorize URL, with "copied" split across a
  // line break by the terminal, to somebody who is already frustrated.
  const pane = [
    'ri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreat',
    'e_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Am',
    'cp_servers+user%3Afile_upload&code_challenge=73B22ApJYsxEi0_P4C5CaVOOlGf_8terzkM',
    'JNF19Wz0&code_challenge_method=S256&state=nI7Oooazgk7X1iIMo5Dz0DCRootaVGVW6V69Dc',
    'tfyqE',
    'Paste code here if prompted > Invalid code. Please make sure the full code was c',
    'opied.',
  ].join('\n');

  const line = failureLine(pane);

  assert.equal(line, 'Invalid code. Please make sure the full code was copied.');
  assert.equal(line.includes('code_challenge'), false, 'the URL leaked into the reason');
  assert.equal(line.includes('Paste code here'), false, 'our own prompt is not the reason');
});

test('both apps warn about the partial copy before the round trip', () => {
  // "Please make sure the full code was copied" is the CLI telling us what the
  // common failure is. On a phone it is easy: the code is long, it wraps, and a
  // selection drag stops early. Saying so before is cheaper than refusing after.
  const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  for (const [name, src] of [
    ['iOS', read('apps/ios/Fleetwright/Credentials.swift')],
    ['Android', read('apps/android/app/src/main/java/network/thetech/fleetwright/CredentialsSheet.kt')],
  ]) {
    assert.match(src, /including anything after a #/, `${name} does not warn about a partial copy`);
  }
});
