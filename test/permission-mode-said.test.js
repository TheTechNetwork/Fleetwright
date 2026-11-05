// A start, and the session list, say which permission mode a session is in,
// the box default included.
//
//   node --test test/permission-mode-said.test.js
//
// The box default is bypassed unless the operator turns it off. A /new that
// took it used to add no sentence, and /list marked only the sessions that
// differed from the box, so the session running commands without asking was
// the one neither reply mentioned. Siri, chat and text starts send no mode
// unless one is chosen, so for them the reply is the only place it is said.
// From cursor/phone-permission-mode-8499 (#1408), whose phone half main
// redesigned and whose reply half it did not take.

import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatch } from '../src/adapters/commands.js';

/**
 * @param {{ skipPermissions?: boolean, sessions?: any[] }} [over]
 */
function ctx(over = {}) {
  return /** @type {any} */ ({
    cfg: { skipPermissions: over.skipPermissions ?? true, maxSessions: 4, hostname: 'box', loginEnabled: true },
    actor: 'local',
    sessions: {
      list: () => over.sessions ?? [],
      running: () => (over.sessions ?? []).filter((s) => s.status === 'running'),
      binned: () => [],
      start: async () => ({ ok: true, message: 'Started "api".' }),
    },
  });
}

test('/new names the mode it took, and says when that is the box default', async () => {
  const bypassed = await dispatch(ctx(), '/new api');
  assert.match(bypassed.text, /Permission checks are BYPASSED for this session: it runs commands without asking\. That is this box's default\./);

  const safe = await dispatch(ctx(), '/new api --safe');
  assert.match(safe.text, /Permission prompts are ON for this session: it stops and asks before it runs a command\./);
  assert.doesNotMatch(safe.text, /this box's default/, 'an override is not the default');

  const prompted = await dispatch(ctx({ skipPermissions: false }), '/new api');
  assert.match(prompted.text, /Permission prompts are ON for this session.*That is this box's default\./);
});

test('/list labels a session running at the box default', async () => {
  const running = { name: 'api', status: 'running', createdAt: Date.now(), skipPermissions: null };

  const bypassed = await dispatch(ctx({ sessions: [running] }), '/list');
  assert.match(bypassed.text, /api {2}\(permissions bypassed, box default\)/);

  const safe = await dispatch(ctx({ sessions: [{ ...running, skipPermissions: false }] }), '/list');
  assert.match(safe.text, /api {2}\(permission prompts on\)/);
  assert.doesNotMatch(safe.text, /box default/);

  const usualSafe = await dispatch(ctx({ skipPermissions: false, sessions: [running] }), '/list');
  assert.match(usualSafe.text, /api {2}\(permission prompts on, box default\)/);
});
