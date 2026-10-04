// A machine makes a Claude token for somebody on a phone, and only the phone
// can read it.
//
//   node --test test/setup-token.test.js
//
// ASKED FOR FROM A PHONE: "If a host is available why not offer to run it,
// return the link, open the page, capture the token?" The phone had a field
// asking for the output of `claude setup-token`, run on a computer the person
// was holding a phone instead of.
//
// The pane is played by a fake here: tmux and the Claude command are not
// available to the suite, and what is being pinned is what this code does with
// what the CLI prints, not the CLI.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LoginFlow, setupTokenFrom } from '../src/core/login.js';
import { dispatch } from '../src/adapters/commands.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';
import { redactCommandLine } from '../src/core/redact.js';
import { newSealKey, open, SETUP_TOKEN_AAD } from '../src/fleet/seal.js';

const TOKEN = `sk-ant-oat01-${'A1b2_C3d4-'.repeat(10)}xyz`;
const URL_ = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=s1';

/** A pane that shows the sign-in page, and the token once a code is typed. */
function fakePane() {
  const io = {
    alive: false,
    typed: /** @type {string[]} */ ([]),
    command: '',
    hasSession: () => io.alive,
    newSession: (/** @type {any} */ o) => { io.alive = true; io.command = o.command; return { status: 0 }; },
    killSession: () => { io.alive = false; return { status: 0 }; },
    capturePane: () => {
      if (!io.alive) return '';
      const page = `Browser didn't open? Use the url below to sign in:\n\n${URL_}\n\nPaste code here if prompted >`;
      if (!io.typed.includes('Enter')) return page;
      // Wrapped at 80 columns, the way a terminal shows it.
      const wrapped = TOKEN.match(/.{1,80}/g)?.join('\n') ?? TOKEN;
      return `${page}\n\nLong-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n${wrapped}\n\nStore this token securely.`;
    },
    sendKeys: (/** @type {string} */ _n, /** @type {string[]} */ keys) => { io.typed.push(...keys); return { status: 0 }; },
    sleep: async () => {},
  };
  return io;
}

function flow() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'setup-token-'));
  const io = fakePane();
  const cfg = /** @type {any} */ ({ loginEnabled: true, loginTimeoutMs: 600_000, loginSessionName: 'fw-login', stateDir, workdir: stateDir, claudeBin: 'claude', hostname: 'deb13' });
  return { login: new LoginFlow(cfg, /** @type {any} */ (io)), io, cfg };
}

test('the token is read whole off a pane that wrapped it', () => {
  const pane = `Your OAuth token (valid for 1 year):\n\n${TOKEN.slice(0, 80)}\n${TOKEN.slice(80)}\n\nStore this token securely.`;
  assert.equal(setupTokenFrom(pane), TOKEN);
  assert.equal(setupTokenFrom('Paste code here if prompted >'), null);
});

test('a machine runs claude setup-token in its own directory, and hands back the page and then the token', async () => {
  const { login, io } = flow();
  const started = await login.startSetupToken({ actor: 'fleet:eli@example.com' });
  assert.equal(started.ok, true, started.message);
  assert.equal(started.url, URL_);
  assert.match(io.command, /CLAUDE_CONFIG_DIR='[^']*pending-setup-[^']*' 'claude' setup-token; sleep 120/);
  const dir = /** @type {any} */ (login.pending).linkDir;
  assert.ok(existsSync(dir));

  // A /code meant for a login does not land in this pane.
  assert.equal((await login.submitCode('code#state', 'fleet:eli@example.com')).ok, false);
  assert.equal(io.typed.length, 0);

  // Nor does somebody else's.
  assert.equal((await login.finishSetupToken('code#state', 'fleet:mallory@example.com')).ok, false);

  const done = await login.finishSetupToken('code#state', 'fleet:eli@example.com');
  assert.equal(done.ok, true, done.message);
  assert.equal(done.token, TOKEN);
  assert.ok(!done.message.includes(TOKEN));
  // Gone before it returned: the pane that showed the token, and the directory.
  assert.equal(io.alive, false);
  assert.equal(existsSync(dir), false);
  assert.equal(login.pending, null);
});

test('/setuptoken answers with the token sealed to the asking key, and never in its words', async () => {
  const { login, cfg } = flow();
  const ctx = /** @type {any} */ ({ cfg, login, actor: 'fleet:eli@example.com', sessions: {} });
  const started = await dispatch(ctx, '/setuptoken');
  assert.equal(started.ok, true);
  assert.equal(started.url, URL_);

  const phone = await newSealKey();
  // No key, no finish: nothing is typed and nothing could come back in the clear.
  assert.equal((await dispatch(ctx, '/setuptoken code#state')).ok, false);

  const done = await dispatch(ctx, `/setuptoken code#state ${phone.publicKey}`);
  assert.equal(done.ok, true, done.text);
  assert.ok(!JSON.stringify({ text: done.text }).includes(TOKEN));
  assert.match(done.text, /on deb13/);
  const inside = await open({ privateKey: phone.privateKey, publicKey: phone.publicKey, aad: SETUP_TOKEN_AAD, sealed: done.sealed });
  assert.deepEqual(inside, { v: 1, token: TOKEN });
});

test('the fleet verb becomes the command, and the journal never sees the code', async () => {
  const phone = await newSealKey();
  assert.equal(toCommandLine({ verb: 'setuptoken', params: {}, actor: 'eli@example.com' }), '/setuptoken');
  const line = toCommandLine({ verb: 'setuptoken', params: { code: 'code#state', reply: phone.publicKey }, actor: 'eli@example.com' });
  assert.equal(line, `/setuptoken code#state ${phone.publicKey}`);
  assert.ok(!redactCommandLine(line).includes('code#state'));
  assert.throws(() => toCommandLine({ verb: 'setuptoken', params: { code: 'code#state' }, actor: 'eli@example.com' }), /reply/);
});
