// The `secrets` verb and its command, the sibling of `profiles`.
//
// THE PROPERTY WORTH TESTING is the same one profiles has: the wire carries a
// NAME and never the value. A picker exists so `start --secret` is not blind,
// and it lists what a box holds without ever handing over what is inside.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { toCommandLine } from '../src/fleet/host/sidecar.js';
import { dispatch } from '../src/adapters/commands.js';

/** @param {string[]} names */
function store(names) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'secrets-cmd-'));
  for (const name of names) writeFileSync(path.join(dir, name), 'a-value');
  return dir;
}

/** A command context with a stub session manager; `start` records its opts. */
function ctxWith(dir) {
  /** @type {any[]} */
  const started = [];
  return {
    started,
    ctx: /** @type {any} */ ({
      cfg: { secretsDir: dir, profileDir: '/nowhere', skipPermissions: true },
      actor: 'fleet:e@example.com',
      sessions: {
        start: async (/** @type {any} */ opts) => {
          started.push(opts);
          return { ok: true, message: `Started "${opts.name || 'cc-x'}".` };
        },
      },
    }),
  };
}

test('the sidecar maps the secrets verb to /secrets', () => {
  assert.equal(toCommandLine({ verb: 'secrets', params: {} }), '/secrets');
});

test('/secrets lists the names a box holds, and offers each as a tap', async () => {
  const dir = store(['github-deploy', 'npm-publish']);
  const { ctx } = ctxWith(dir);
  const r = await dispatch(ctx, '/secrets');

  assert.match(r.text, /2 named secrets/);
  assert.match(r.text, /github-deploy/);
  // Names only — no value appears anywhere in the reply.
  assert.equal(/a-value/.test(r.text), false, 'a value must never be in the listing');
  assert.deepEqual(r.secrets, [{ name: 'github-deploy' }, { name: 'npm-publish' }]);
  // Tappable, so granting one is a tap rather than typing a name blind.
  assert.deepEqual(r.buttons?.map((b) => b.command), ['/new --secret=github-deploy', '/new --secret=npm-publish']);
});

test('/secrets on a box with none says where to put one, and answers [] not absent', async () => {
  const { ctx } = ctxWith('/nowhere/at/all');
  const r = await dispatch(ctx, '/secrets');
  assert.match(r.text, /No named secrets/);
  assert.match(r.text, /\/nowhere\/at\/all\/<name>/, 'says how to add one');
  // [] is "this box holds none"; a missing key would be "too old to know the
  // verb", and a picker has to tell them apart.
  assert.deepEqual(r.secrets, []);
});

test('/new --secret grants a NAME, and the value never reaches the command layer', async () => {
  const dir = store(['github-deploy']);
  const { ctx, started } = ctxWith(dir);

  await dispatch(ctx, '/new api --secret=github-deploy');
  assert.equal(started[0].secret, 'github-deploy');
  // The command layer has the name only — no value, and nowhere to have gotten
  // one, because the value is read on the host at the moment of the request.
  assert.equal('secretValue' in started[0], false);
});
