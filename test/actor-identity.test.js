// WHO the host thinks is asking, end to end.
//
// This file exists because two halves of one feature disagreed about the shape
// of an actor and nothing exercised the seam between them. The coordinator
// sends a BARE email; `emailFromActor` answers only for `fleet:<email>`; the
// sidecar built the prefixed form and then passed the bare one on. Every
// consumer downstream therefore got "I don't know who this is" — and the
// connectors store treated that as "the box's shared row", so a member's live
// GitHub token was written over the operator's and seeded into every other
// member's sessions.
//
// The old tests could not catch it: test/connectors.test.js hand-built
// `ctx.actor = 'fleet:me@example.com'`, a value production never produced,
// while test/connect-verbs.test.js correctly used the bare form for the
// sidecar. Both passed. Neither crossed the boundary.
//
// So these tests take the actor from where it actually comes from — an intent
// envelope — and follow it all the way to the row a token lands in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commandMeta, toCommandLine } from '../src/fleet/host/sidecar.js';
import { Accounts, emailFromActor, rowForActor, HOST_ROW } from '../src/core/accounts.js';
import { Connections } from '../src/core/connectors.js';
import { pickSecretsFile, pickCredentialSource } from '../src/core/podman.js';
import { dispatch } from '../src/adapters/commands.js';

const dir = () => mkdtempSync(join(tmpdir(), 'actor-'));

// What the coordinator actually puts on an intent: `client.email`, verbatim.
// Not prefixed. Both server.js and the Worker's fleet-do.js do this.
const FROM_THE_COORDINATOR = 'guest@example.com';

test('the actor the coordinator sends is bare, and the host must prefix it', () => {
  // The bug in one assertion. If this ever reads `true`, somebody has started
  // prefixing upstream and the sidecar would then double-prefix.
  assert.equal(FROM_THE_COORDINATOR.startsWith('fleet:'), false);
  assert.equal(emailFromActor(FROM_THE_COORDINATOR), null, 'bare is deliberately not an identity');
  assert.equal(emailFromActor(`fleet:${FROM_THE_COORDINATOR}`), FROM_THE_COORDINATOR);
});

test('commandMeta carries a verified identity the host can resolve', () => {
  // This is the line that was wrong. `commandMeta(..., intent.actor)` passed
  // the bare value; everything downstream asks `emailFromActor`.
  const meta = commandMeta('link', { provider: 'github', secret: 'ghp_x' }, `fleet:${FROM_THE_COORDINATOR}`);
  assert.equal(emailFromActor(meta.actor), FROM_THE_COORDINATOR);
});

test('an intent with no actor still records no actor', () => {
  // The prefix must not invent an identity where there was none: `fleet` on
  // its own is not somebody, and an unattributed session must stay
  // unattributed rather than acquiring a fake owner.
  assert.equal('actor' in commandMeta('list', {}, ''), false);
  assert.equal(rowForActor(''), HOST_ROW);
});

test('a member’s token lands in THEIR row, through the real command path', async () => {
  const state = dir();
  const store = new Connections(state);
  // The operator's box-wide token, set from the CLI.
  store.save(HOST_ROW, 'github', 'the-operators-token', 'org');

  // A fleet member links their own, exactly as the sidecar would drive it.
  const meta = commandMeta('link', {}, `fleet:${FROM_THE_COORDINATOR}`);
  const line = toCommandLine({
    verb: 'link',
    params: { provider: 'github', secret: 'the-guests-token' },
    actor: FROM_THE_COORDINATOR,
  });
  assert.equal(line, '/link github the-guests-token');

  const ctx = /** @type {any} */ ({
    cfg: { stateDir: state, hostname: 'box', loginEnabled: true },
    actor: meta.actor,
    login: { status: () => ({ loggedIn: false }) },
  });
  // Verification is a network call; stub it so this test is about identity.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ login: 'guest' }), { status: 200 });
  try {
    const reply = await dispatch(ctx, line);
    assert.equal(reply.ok, true, reply.text);
  } finally {
    globalThis.fetch = realFetch;
  }

  // THE ASSERTION THE WHOLE FILE IS FOR.
  const theirs = readFileSync(store.envPathFor(FROM_THE_COORDINATOR), 'utf8');
  assert.ok(theirs.includes('the-guests-token'));
  const boxes = readFileSync(store.envPathFor(HOST_ROW), 'utf8');
  assert.ok(boxes.includes('the-operators-token'), 'the operator’s token was not overwritten');
  assert.equal(boxes.includes('the-guests-token'), false, 'the member’s token did not reach the shared row');
});

test('and a session seeded for that member gets theirs, not the box’s', () => {
  const state = dir();
  const store = new Connections(state);
  store.save(HOST_ROW, 'github', 'the-operators-token', 'org');
  store.save(FROM_THE_COORDINATOR, 'github', 'the-guests-token', 'guest');
  const cfg = /** @type {any} */ ({ stateDir: state });

  // createdBy is what the registry stored, which is meta.actor — prefixed.
  const seeded = pickSecretsFile(cfg, `fleet:${FROM_THE_COORDINATOR}`);
  assert.ok(readFileSync(seeded, 'utf8').includes('the-guests-token'));
  assert.equal(readFileSync(seeded, 'utf8').includes('the-operators-token'), false);
});

test('a fleet identity that cannot be named is seeded nothing at all', () => {
  const state = dir();
  new Connections(state).save(HOST_ROW, 'github', 'the-operators-token', 'org');
  const cfg = /** @type {any} */ ({ stateDir: state });
  // The failure mode that made this a vulnerability rather than a nuisance:
  // an unresolvable fleet actor must NOT fall through to the shared row.
  assert.equal(pickSecretsFile(cfg, 'fleet:not-an-email'), null);
  assert.equal(pickSecretsFile(cfg, 'fleet:'), null);
});

test('per-person Claude credentials resolve over the fleet too', () => {
  // Same defect, quieter symptom: pickCredentialSource has always expected the
  // prefix, so before this fix a member who had linked their own Claude
  // account still got the shared one on every fleet-started session. It failed
  // SAFE, which is why nobody noticed — the connectors store is the same bug
  // failing open.
  const state = dir();
  const cfg = /** @type {any} */ ({ stateDir: state, sandboxCredentialsFile: null });
  // Before a credential exists it is a REFUSAL naming them, not somebody
  // else's account — docs/one-account-per-person.md removed the fallback to
  // the box, which is what "failed safe" used to mean here.
  const before = pickCredentialSource(cfg, `fleet:${FROM_THE_COORDINATOR}`);
  assert.equal(before.source, null);
  assert.match(String(before.why), /has not linked/);

  // With a credential on file it must pick theirs. Written directly, because
  // this test is about the lookup and not about the login flow.
  new Accounts(state).save(FROM_THE_COORDINATOR, JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
  const picked = pickCredentialSource(cfg, `fleet:${FROM_THE_COORDINATOR}`);
  assert.equal(picked.account, FROM_THE_COORDINATOR);
  assert.ok(picked.source && existsSync(picked.source));
});

test('the sidecar never hands the command registry a bare actor', () => {
  // A TRIPWIRE, because the call this guards is inside a private method that
  // needs a live hub to reach — and a test that cannot see the defective line
  // is how this shipped in the first place. Both new tests above pass against
  // the BROKEN code, because both hand-build the prefixed actor themselves.
  //
  // What went wrong is narrow and will look reasonable again: `intent.actor`
  // is right there, it is the obviously-named variable, and the prefixed form
  // was sitting four lines up being used only for a log string.
  const src = readFileSync(new URL('../src/fleet/host/sidecar.js', import.meta.url), 'utf8');
  const call = /commandMeta\(([^)]*)\)/.exec(src);
  assert.ok(call, 'commandMeta is no longer called from the sidecar');
  assert.match(
    call[1],
    /`fleet:\$\{/,
    'commandMeta must be given a fleet:-prefixed actor — a bare one reads as "unknown" everywhere downstream',
  );
});

test('nothing else re-derives an identity from a bare actor', () => {
  // The other half of the same mistake: a consumer calling emailFromActor on
  // something that was never prefixed. Every call site must be reading a value
  // that came from commandMeta (already prefixed) or must go through
  // rowForActor, which has an explicit answer for "cannot tell".
  const src = readFileSync(new URL('../src/core/podman.js', import.meta.url), 'utf8');
  assert.match(src, /rowForActor\(actor\)/, 'pickSecretsFile must fail closed on an unresolvable actor');
  assert.equal(
    /emailFromActor\(actor\)[^;]*\n\s*const file = store\.envPathFor/.test(src),
    false,
    'the connectors lookup must not key on emailFromActor, whose null means two different things',
  );
});

test('a long verified identity is not downgraded into “the box”', () => {
  // FOUND BY THE SECOND SWEEP. The protocol accepts 128 characters of actor
  // and the sidecar prepends `fleet:`, making 134 — while /api/command
  // validated at 120 and, on failure, substituted `web`.
  //
  // `web` is not "unknown". It is THE BOX: rowForActor('web') is HOST_ROW. So
  // a member whose verified address ran long had their credential written to
  // the shared row, was seeded with the operator's tokens, and could finish a
  // login the operator started. An identity check that degrades into a
  // DIFFERENT VALID IDENTITY is worse than one that fails.
  const email = `${'a'.repeat(60)}@${'b'.repeat(55)}.example.com`;
  const prefixed = `fleet:${email}`;
  assert.equal(prefixed.length, 134, 'the exact worst case the protocol permits');

  const src = readFileSync(new URL('../src/adapters/http.js', import.meta.url), 'utf8');
  const limit = /\/\^\[A-Za-z0-9\._:@\+-\]\{1,(\d+)\}\$\//.exec(src);
  assert.ok(limit, 'the actor charset check moved — re-check the length bound');
  assert.ok(
    Number(limit[1]) >= 134,
    `/api/command accepts only ${limit[1]} characters of actor; the protocol allows 134 once prefixed`,
  );

  // And the fallback is gone: a malformed actor is refused, not renamed.
  assert.equal(/:\s*'web'\s*;/.test(src) && /\?\s*claimed\s*:\s*'web'/.test(src), false,
    'a malformed actor must not silently become the box');
  assert.match(src, /actor is not a well-formed identity/);

  // The identity itself still resolves correctly at both ends.
  assert.equal(emailFromActor(prefixed), email);
  assert.equal(rowForActor(prefixed), email);
  assert.notEqual(rowForActor(prefixed), HOST_ROW);
});
