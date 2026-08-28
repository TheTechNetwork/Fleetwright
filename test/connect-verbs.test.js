// Connecting a credential from a phone, without an SSH session.
//
// The old note in intents.js said login/code must not be reachable from the
// coordinator, because a compromised Worker could point a box at an attacker's
// Claude account or harvest a code mid-flow. Half of that was answered and
// half of it is still true, and the difference is what this file pins.
//
// ANSWERED: nothing can be aimed. There is no email parameter, so "link my
// account" cannot become "link an account".
//
// STILL TRUE: a compromised coordinator can show somebody a different
// authorization page. It cannot do so with more authority than `start` already
// gives it on the same box, and docs/trust.md says exactly that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateIntent, PROTOCOL_VERSION, VERBS, isMutating } from '../src/fleet/protocol/intents.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';
import { redactCommandLine } from '../src/core/redact.js';
import { place } from '../src/fleet/coordinator/scheduler.js';

const intent = (verb, params, actor) => ({
  v: PROTOCOL_VERSION, kind: 'intent', id: 'abcd1234', verb, params, issuedAt: Date.now(),
  ...(actor ? { actor } : {}),
});

test('whose account is derived from the actor, never from a parameter', () => {
  // The whole security argument in one line: a caller can say WHAT to connect
  // and never WHOSE. Change this and the aiming attack comes back.
  const line = toCommandLine({ verb: 'connect', params: { provider: 'claude', scope: 'me' }, actor: 'guest@example.com' });
  assert.equal(line, '/login for guest@example.com');

  // And it cannot be overridden: the parameter does not exist, so an intent
  // carrying one is refused before any of this runs.
  assert.equal(
    validateIntent(intent('connect', { provider: 'claude', scope: 'me', email: 'victim@example.com' })).ok,
    false,
  );
});

test('an unattributed caller cannot link "their" account', () => {
  // Telegram, the CLI, anything with no verified email. Defaulting to the box
  // would silently do the admin-only thing on behalf of somebody who never
  // asked for it, so it refuses instead.
  assert.throws(
    () => toCommandLine({ verb: 'connect', params: { provider: 'claude', scope: 'me' }, actor: 'telegram:12345' }),
    /signed-in identity/,
  );
});

test('each provider lands on the command that already existed', () => {
  const as = 'me@example.com';
  const cases = [
    [{ verb: 'connect', params: {} }, '/connect'],
    [{ verb: 'connect', params: { provider: 'github' } }, '/connect github'],
    [{ verb: 'connect', params: { provider: 'claude', scope: 'host' } }, '/login force'],
    [{ verb: 'link', params: { provider: 'github', secret: 'ghp_x' } }, '/link github ghp_x'],
    [{ verb: 'link', params: { provider: 'claude', secret: 'code_x' } }, '/code code_x'],
    [{ verb: 'unlink', params: { provider: 'cloudflare' } }, '/unlink cloudflare'],
    [{ verb: 'unlink', params: { provider: 'claude' } }, `/accounts remove ${as}`],
    [{ verb: 'unlink', params: { provider: 'claude', scope: 'host' } }, '/login logout'],
  ];
  for (const [spec, expected] of cases) {
    assert.equal(toCommandLine({ ...spec, actor: as }), expected, JSON.stringify(spec.params));
  }
});

test('the credential is masked on the way to the pane', () => {
  // The line is real and the log line is not. Both `/code` and `/link` are in
  // redact.js's table precisely because these are the two lines toCommandLine
  // can produce with a live credential in them.
  const secret = 'ghp_notarealtokenatall0000';
  for (const params of [{ provider: 'github', secret }, { provider: 'claude', secret }]) {
    const line = toCommandLine({ verb: 'link', params, actor: 'me@example.com' });
    assert.ok(line.includes(secret), 'the command itself must carry it');
    assert.equal(redactCommandLine(line).includes(secret), false, 'the log must not');
  }
});

const twoHosts = () => ({
  reachable: () => [{ hostId: 'a' }, { hostId: 'b' }],
  list: () => [{ hostId: 'a' }, { hostId: 'b' }],
  findSessions: () => [],
  schedulable: () => [{ hostId: 'a' }, { hostId: 'b' }],
});

test('a CLAUDE connection is pinned, because its two halves are a pair', () => {
  // `connect` starts a login in a pane on one host and `link` types the code
  // into that same pane. A second step landing elsewhere would type a live
  // credential into a box that never asked for one.
  //
  // This is the case where pinning is not a preference but a fact about where
  // the state lives.
  const two = twoHosts();
  for (const verb of ['connect', 'link', 'unlink']) {
    const p = place(/** @type {any} */ (two), intent(verb, { provider: 'claude', secret: 'x' }));
    assert.equal(p.kind, 'refused', verb);
    assert.equal(p.code, 'ambiguous_host', verb);
  }
  const one = { ...two, reachable: () => [{ hostId: 'a' }] };
  assert.equal(place(/** @type {any} */ (one), intent('link', { provider: 'claude', secret: 'x' })).kind, 'host');
});

test('a TOKEN is the person’s, so it reaches every box they can', () => {
  // The correction: "credentials should be per user not per host". A GitHub
  // token belongs to a person, and connecting it again on every box — and
  // again on each box enrolled later — is bookkeeping the fleet exists to
  // remove. Unlike Claude, there is no pane state to land in: the token is
  // minted on the provider's page and the host only stores it.
  const two = twoHosts();
  for (const verb of ['link', 'unlink']) {
    for (const provider of ['github', 'cloudflare']) {
      const p = place(/** @type {any} */ (two), intent(verb, { provider, secret: 'ghp_x' }));
      assert.equal(p.kind, 'fanout', `${verb} ${provider}`);
      assert.deepEqual(p.hosts.map((h) => h.hostId), ['a', 'b']);
    }
  }
});

test('but a named host still wins, because saying "this box" means it', () => {
  const p = place(/** @type {any} */ (twoHosts()), intent('link', { provider: 'github', secret: 'x' }), {
    preferHost: 'b',
  });
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'b');
});

test('connect still asks ONE box, even for a token', () => {
  // `connect` returns a URL and the current state, which is a question rather
  // than a change — fanning it out would mean N copies of one answer, and the
  // catalogue is identical on every box anyway.
  const p = place(/** @type {any} */ (twoHosts()), intent('connect', { provider: 'github' }));
  assert.equal(p.kind, 'refused');
  assert.equal(p.code, 'ambiguous_host');
});

test('a named host is honoured, so Claude’s second step reaches its first', () => {
  const two = twoHosts();
  const p = place(/** @type {any} */ (two), intent('link', { provider: 'claude', secret: 'x' }), { preferHost: 'b' });
  assert.equal(p.kind, 'host');
  assert.equal(p.host.hostId, 'b');
});

test('all three change state, so a retried paste cannot start two logins', () => {
  for (const verb of ['connect', 'link', 'unlink']) assert.equal(isMutating(verb), true, verb);
});

test('the provider list is an enum, not a caller-supplied destination', () => {
  // Same argument as logs.service: naming the providers this project supports
  // is a different thing from letting a caller nominate a page for somebody to
  // paste a credential into.
  for (const verb of ['connect', 'link', 'unlink']) {
    assert.deepEqual(VERBS[verb].params.provider.values, ['claude', 'github', 'cloudflare']);
  }
  assert.equal(validateIntent(intent('connect', { provider: 'https://evil.example' })).ok, false);
});

test('a member cannot change the account the box itself runs on', async (t) => {
  // Precisely what this defends against: a MEMBER replacing the shared Claude
  // account every other session on that box runs on. Not a defence against a
  // compromised coordinator — the coordinator is the party checking.
  const { CoordinatorCore } = await import('../src/fleet/coordinator/core.js');
  const core = new CoordinatorCore({ log: { info() {}, warn() {}, error() {} } });

  const member = { email: 'guest@example.com', admin: false };
  const refused = await core.dispatch({ verb: 'connect', params: { provider: 'claude', scope: 'host' }, actor: 'guest@example.com', requester: member });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'not_admin');
  // And it points at the thing they CAN do, rather than only saying no.
  assert.match(refused.text, /own credential/i);

  // Their own credential needs no permission at all, so it gets past the gate
  // and fails later for the honest reason: this fleet has no hosts.
  const allowed = await core.dispatch({ verb: 'connect', params: { provider: 'claude' }, actor: 'guest@example.com', requester: member });
  assert.notEqual(allowed.error?.code, 'not_admin');
});

test('scope reaches the host, so the admin gate is not a no-op', () => {
  // THE GATE WAS BYPASSABLE BY OMITTING A PARAMETER THAT CHANGED NOTHING.
  // `scope: host` is admin-only at the coordinator, but for token providers
  // the scope was never placed on the command line — so `scope: host` and no
  // scope produced the identical `/link github <tok>`, and the host performed
  // the host-scoped effect either way. A permission check on a value the
  // enforcing end never sees is not a permission check.
  const as = 'me@example.com';
  assert.equal(
    toCommandLine({ verb: 'link', params: { provider: 'github', secret: 'ghp_x', scope: 'host' }, actor: as }),
    '/link github ghp_x --host',
  );
  assert.equal(
    toCommandLine({ verb: 'link', params: { provider: 'github', secret: 'ghp_x' }, actor: as }),
    '/link github ghp_x',
  );
  assert.equal(
    toCommandLine({ verb: 'unlink', params: { provider: 'cloudflare', scope: 'host' }, actor: as }),
    '/unlink cloudflare --host',
  );
  assert.equal(toCommandLine({ verb: 'connect', params: { scope: 'host' }, actor: as }), '/connect --host');
});

test('a credential cannot be smuggled in as a flag', () => {
  // agent-hub's parser reads `-word` as a flag, so a secret beginning with a
  // dash would stop being an argument — and `--host` specifically would be
  // read as the flag that selects the box's SHARED row, which is the thing the
  // admin gate exists to protect. No provider issues such a token.
  for (const secret of ['--host', '-x', '—host', '–host']) {
    const r = validateIntent(intent('link', { provider: 'github', secret }));
    assert.equal(r.ok, false, secret);
    assert.equal(r.code, 'bad_params');
  }
});
