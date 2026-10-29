// A start says which permission mode it took, including the fleet default.
//
//   node --test test/permission-mode.test.js
//
// The default is bypassed. A /new that matched it used to add no sentence, so
// the session running commands without asking was the one the reply did not
// mention. /list did the same: the suffix was empty whenever the session
// matched the box, which is every session on a box nobody has reconfigured.

import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatch } from '../src/adapters/commands.js';

/**
 * @param {{ skipPermissions?: boolean, sessions?: any[] }} [over]
 */
function ctx(over = {}) {
  return /** @type {any} */ ({
    cfg: { skipPermissions: over.skipPermissions ?? true, maxSessions: 4, hostname: 'box', profileDir: '/none' },
    actor: 'fleet:e@example.com',
    sessions: {
      list: () => over.sessions ?? [],
      start: async () => ({ ok: true, message: 'Started "api".' }),
    },
  });
}

test('/new names the permission mode, and names it when it is the fleet default', async () => {
  const bypassed = await dispatch(ctx(), '/new api');
  assert.match(bypassed.text, /Permission checks are BYPASSED for this session — it runs commands without asking\. This is the fleet default\./);

  const safe = await dispatch(ctx(), '/new api --safe');
  assert.match(safe.text, /Permission prompts are ON for this session — it stops and asks before it runs a command\./);
  assert.equal(/This is the fleet default/.test(safe.text), false, 'an override is not the default');

  const prompted = await dispatch(ctx({ skipPermissions: false }), '/new api');
  assert.match(prompted.text, /Permission prompts are ON for this session/);
  assert.match(prompted.text, /This is the fleet default/);

  const forced = await dispatch(ctx({ skipPermissions: false }), '/new api --dangerous');
  assert.match(forced.text, /Permission checks are BYPASSED/);
  assert.equal(/This is the fleet default/.test(forced.text), false);
});

test('/list labels a session running at the fleet default', async () => {
  const running = { name: 'api', status: 'running', createdAt: Date.now(), skipPermissions: null };
  const bypassed = await dispatch(ctx({ sessions: [running] }), '/list');
  assert.match(bypassed.text, /▶ api {2}\(permissions bypassed, fleet default\)/);

  const safe = await dispatch(
    ctx({ sessions: [{ ...running, skipPermissions: false }] }),
    '/list',
  );
  assert.match(safe.text, /▶ api {2}\(permission prompts on\)/);
  assert.equal(/fleet default/.test(safe.text), false);

  const usualSafe = await dispatch(
    ctx({ skipPermissions: false, sessions: [{ ...running, skipPermissions: null }] }),
    '/list',
  );
  assert.match(usualSafe.text, /▶ api {2}\(permission prompts on, fleet default\)/);
});
