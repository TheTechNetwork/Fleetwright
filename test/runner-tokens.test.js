import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRegistry, RUNNER_PREFIX } from '../src/fleet/coordinator/clients.js';

test('a runner token is reusable — that is the whole requirement', async () => {
  // "it needs to be a reusable token to be able to be used in a repo". A
  // single-use code cannot live in a GitHub secret: the second run of any
  // workflow would fail, and nothing would say why.
  const runners = new ClientRegistry({ prefix: RUNNER_PREFIX });
  const { token } = await runners.issue('the fleetwright repo');

  for (let i = 0; i < 3; i++) {
    const seen = await runners.verify(token);
    assert.notEqual(seen, null, `spend ${i + 1} should still work`);
  }
});

test('a runner token cannot authenticate as a device', async () => {
  // THE REASON THESE ARE TWO STORES RATHER THAN A FLAG. A runner token lives
  // in a repository secret and is spent on every run; a device credential
  // calls the API as a person. If one could be mistaken for the other, a token
  // whose worst case is "somebody gets a free Mac" would become one whose
  // worst case is the whole fleet.
  //
  // The authenticator consults the device store, so this is structural rather
  // than a check somebody has to remember.
  const devices = new ClientRegistry();
  const runners = new ClientRegistry({ prefix: RUNNER_PREFIX });
  const { token } = await runners.issue('a repo');

  assert.equal(await devices.verify(token), null);
  // And the reverse, so neither store is a skeleton key for the other.
  const { token: deviceToken } = await devices.issue('a phone');
  assert.equal(await runners.verify(deviceToken), null);
});

test('revoking one leaves the others alone', async () => {
  // An organisation secret and a per-repository secret are different tokens
  // for different blast radii. Revoking the leaked one must not stop the rest.
  const runners = new ClientRegistry({ prefix: RUNNER_PREFIX });
  const a = await runners.issue('org-wide');
  const b = await runners.issue('one repo');

  assert.equal(runners.revoke(a.client.id), true);
  assert.equal(await runners.verify(a.token), null);
  assert.notEqual(await runners.verify(b.token), null);
});

test('a revoked token is indistinguishable from one that never existed', async () => {
  // Otherwise the refusal is an oracle for which tokens used to be real.
  const runners = new ClientRegistry({ prefix: RUNNER_PREFIX });
  const { client, token } = await runners.issue('a repo');
  runners.revoke(client.id);

  assert.equal(await runners.verify(token), null);
  assert.equal(await runners.verify(`${RUNNER_PREFIX}_deadbeef_cafe`), null);
});

test('it survives a restart, because a repository is holding it', async () => {
  // A token that did not survive a deploy would break every repository holding
  // one, silently, at the moment somebody deployed something unrelated.
  const runners = new ClientRegistry({ prefix: RUNNER_PREFIX });
  const { token } = await runners.issue('a repo');

  const after = new ClientRegistry({ prefix: RUNNER_PREFIX });
  after.restore(runners.serialise());
  assert.notEqual(await after.verify(token), null);
});
