// Signing an engine in on a box (src/core/engine-signin.js, docs/engines.md
// "Signing in on the machine"), through a script that stands in for Podman,
// the real runner (sandbox/engine.mjs) inside it, and a stand-in for each
// engine that answers as its source reads. test/helpers/stub-signin-podman.js
// says what stands in and what does not.
//
// NOT RUN: real Podman, a real container, a real Codex or OpenCode, OpenAI,
// GitHub, or any account. What is tested here is what this box does with
// what the runner says, and what it keeps, reports and never says.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import path from 'node:path';

import { EngineSignins, SIGNIN_PAGES, containerFor } from '../src/core/engine-signin.js';
import { engineHomeVolume, engineHomeArgs, memberOfEngineHome, ENGINE_HOME } from '../src/core/engine-home.js';
import { forgetPerson } from '../src/core/forget-person.js';
import { buildCommand } from '../src/core/claude.js';
import { ownerTag } from '../src/core/accounts.js';
import { Registry } from '../src/core/registry.js';
import { SessionManager } from '../src/core/sessions.js';
import { HttpAdapter } from '../src/adapters/http.js';
import { ensureApiToken } from '../src/core/api-token.js';
import { HubClient } from '../src/fleet/host/hub-client.js';
import { Sidecar } from '../src/fleet/host/sidecar.js';
import { SessionWatcher } from '../src/fleet/host/watcher.js';
import { setLogStream } from '../src/log.js';
import { signinBox, TOKEN } from './helpers/stub-signin-podman.js';
import { SIGNIN_PAGES as RUNNER_PAGES } from '../sandbox/engine.mjs';
import { codexSignIn } from './helpers/engine-files.js';
import { startStubHub } from './helpers/stub-hub.js';

/** Wait until `said()` is true, or say what never happened. */
async function until(/** @type {() => boolean|Promise<boolean>} */ said, /** @type {string} */ what, ms = 15_000) {
  const by = Date.now() + ms;
  while (!(await said())) {
    if (Date.now() > by) assert.fail(`waited ${ms} ms and never saw: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Everything this process logs while a test runs, so it can be searched. */
function logged(/** @type {import('node:test').TestContext} */ t) {
  /** @type {string[]} */
  const lines = [];
  setLogStream(new Writable({ write(chunk, _enc, done) { lines.push(String(chunk)); done(); } }));
  t.after(() => setLogStream(null));
  return () => lines.join('');
}

const DEBBIE = { member: 'debbie', account: 'debbie@members.invalid', by: 'eli@example.com', box: 'ops-box' };
/** A box, its sign-ins, and one way to ask them. */
function box(/** @type {import('node:test').TestContext} */ t, /** @type {Record<string, unknown>} */ cfgPatch = {}, /** @type {any} */ opts = {}) {
  const b = signinBox(t);
  const cfg = b.cfg(cfgPatch);
  const signins = new EngineSignins(cfg, opts);
  t.after(() => signins.close());
  /** @type {any[]} */
  const answers = [];
  const ask = async (/** @type {string} */ action, /** @type {Record<string, unknown>} */ over = {}) => {
    const r = await signins.ask({ ...DEBBIE, engine: 'codex', action, ...over });
    answers.push(r);
    return r;
  };
  const kept = () => (existsSync(signins.file) ? readFileSync(signins.file, 'utf8') : '');
  return { ...b, cfg, signins, ask, answers, kept };
}

test('a start runs the runner with the member’s engine home and nothing of a session, answers with the page and the code, and a second start is the one in flight', async (t) => {
  const said = logged(t);
  const b = box(t);
  const [first, second] = await Promise.all([b.ask('start'), b.ask('start')]);
  // One container, whichever of the two arrived first.
  assert.equal(b.runs().length, 1);
  assert.equal(b.runs()[0], `run --rm --name fw-signin-codex-debbie -v fw-engine-debbie:${ENGINE_HOME} -e FLEETWRIGHT_ENGINE_HOME=${ENGINE_HOME} img fleetwright-engine --signin codex`);
  const waiting = first.already ? second : first;
  assert.deepEqual(
    { ...waiting, text: '', startedAt: 0, expiresAt: 0 },
    { ok: true, state: 'waiting', member: 'debbie', engine: 'codex', url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH', startedAt: 0, expiresAt: 0, expiresInMinutes: 15, signedIn: null, text: '' },
  );
  assert.equal(waiting.expiresAt - waiting.startedAt, 15 * 60_000);
  assert.equal(waiting.text, 'Open https://auth.openai.com/codex/device and enter ABCD-EFGH to sign Codex in for debbie on ops-box. The code lasts about 15 more minutes.');
  // The other was answered with the same attempt, and said so.
  const other = first.already ? first : second;
  assert.deepEqual([other.already, other.state, other.code, other.startedAt], [true, 'waiting', 'ABCD-EFGH', waiting.startedAt]);
  // And a third, later, the same. Status says where it stands, with the code, for whoever may ask.
  assert.equal((await b.ask('start')).already, true);
  assert.deepEqual([(await b.ask('status')).state, (await b.ask('status')).code], ['waiting', 'ABCD-EFGH']);
  assert.equal(b.runs().length, 1);

  // WHILE IT WAITS, what is on disk is a mark that an attempt is out, and no page or code.
  assert.deepEqual(JSON.parse(b.kept()).signins['debbie/codex'], { member: 'debbie', engine: 'codex', volume: 'fw-engine-debbie', signedIn: null, last: null, attempt: { startedAt: waiting.startedAt, by: 'eli@example.com' } });
  // And the box reports nobody signed in.
  assert.deepEqual(b.signins.report(), [{ member: 'debbie', engine: 'codex', state: null, at: null, since: null }]);

  b.provider('approved');
  await until(async () => (await b.ask('status')).state === 'signed_in', 'the sign-in approved');
  const now = await b.ask('status');
  assert.deepEqual(now.signedIn, { since: now.at, who: { email: 'debbie@example.com', plan: 'plus' } });
  assert.match(now.text, /^Codex is signed in for debbie on ops-box as debbie@example\.com, since \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
  assert.deepEqual(b.signins.report(), [{ member: 'debbie', engine: 'codex', state: 'signed_in', at: now.at, since: now.at }]);
  // The engine wrote its own sign-in into the member's volume.
  assert.ok(readFileSync(b.volume('fw-engine-debbie', 'codex', 'auth.json'), 'utf8').includes(TOKEN));
  await until(() => !b.running('fw-signin-codex-debbie'), 'the container gone');

  // NO TOKEN ANYWHERE BUT THE ENGINE HOME: not in an answer, the state file or
  // a log line, though the engine printed one on its error output.
  for (const [where, text] of [['an answer', JSON.stringify(b.answers)], ['the state file', b.kept()], ['a log line', said()]]) {
    assert.ok(!text.includes('LEAKCANARY'), `a token is in ${where}`);
  }
  // AND THE PAGE AND THE CODE ONLY IN THE ANSWERS: nothing kept, nothing logged.
  for (const [where, text] of [['the state file', b.kept()], ['a log line', said()], ['what the box reports', JSON.stringify(b.signins.report())]]) {
    // Looked for as the answer gave them, the page by its host: this is a
    // search of what was kept and logged for something that must not be
    // there, and not a check that a URL is a safe one to open.
    assert.ok(!text.includes(waiting.code) && !text.includes(new URL(waiting.url).host), `the code or its page is in ${where}`);
  }
  assert.match(said(), /engines: codex sign-in for debbie, asked by eli@example\.com: signed_in/);
});

test('a person’s engine home is named by a hash of their address, an agent’s by its id, and neither can be the other’s', (t) => {
  assert.equal(engineHomeVolume('debbie@members.invalid'), 'fw-engine-debbie');
  assert.equal(engineHomeVolume('fleet:debbie@members.invalid'), 'fw-engine-debbie');
  const eli = engineHomeVolume('fleet:Eli@Example.com');
  assert.equal(eli, `fw-engine-person.${ownerTag('eli@example.com')}`);
  assert.match(String(eli), /^fw-engine-person\.[0-9a-f]{16}$/, 'an address in a volume’s name');
  // An agent filed under an id shaped like that tag is still not that person: an id holds no full stop.
  assert.notEqual(engineHomeVolume(`person-${ownerTag('eli@example.com')}@members.invalid`), eli);
  // Nobody behind the session, or something that is not an account, is no volume at all.
  for (const nobody of [null, '', 'fleet', 'web', 'a b@example.com; rm -rf /', 'x@y']) assert.equal(engineHomeVolume(nobody), null, String(nobody));
  assert.deepEqual(engineHomeArgs(null), []);

  // A SESSION'S OWN CONTAINER is given it when its pane is an engine behind the runner, and not when it is Claude Code.
  const b = signinBox(t);
  const cfg = b.cfg({ sandboxHookSocketDir: path.join(b.dir, 's'), claudeBin: 'claude' });
  const mount = `'-v' 'fw-engine-debbie:${ENGINE_HOME}' '-e' 'FLEETWRIGHT_ENGINE_HOME=${ENGINE_HOME}'`;
  assert.ok(buildCommand(cfg, { name: 'job', owner: 'fleet:debbie@members.invalid', engine: { engine: 'codex' }, hookSocket: false }).includes(mount));
  assert.ok(buildCommand(cfg, { name: 'job', owner: 'fleet:debbie@members.invalid', engine: { engine: 'opencode', model: 'github-copilot/gpt-5' }, hookSocket: false }).includes(mount));
  for (const claude of [{ engine: 'claude-code' }, null]) {
    assert.ok(!buildCommand(cfg, { name: 'job', owner: 'fleet:debbie@members.invalid', engine: claude, hookSocket: false }).includes('fw-engine'), 'a Claude Code pane was handed the member’s other sign-ins');
  }
});

test('an attempt nobody approves expires on this box’s own clock, one the engine refuses says so in its words, and neither replaces a sign-in that was there', async (t) => {
  const said = logged(t);
  const b = box(t, {}, { capMs: 500, graceMs: 200 });
  // Signed in first, so there is something a later attempt must not replace.
  await b.ask('start');
  b.provider('approved');
  await until(async () => (await b.ask('status')).state === 'signed_in', 'the first sign-in');
  const first = (await b.ask('status')).signedIn;
  b.set('provider-approved', false);
  await until(() => !b.running('fw-signin-codex-debbie'), 'the first container gone');

  // NOBODY APPROVES IT. The runner's own 15 minutes are not waited for here: the box's clock runs out first.
  const again = await b.ask('start');
  assert.deepEqual([again.state, again.signedIn], ['waiting', first], 'the sign-in already there is said beside the new attempt');
  // FOR AN ANSWER THE SIDECAR WILL SEAL (`sealed`), the same facts come back
  // for it to seal, and the sentence spells none of the page, the code or
  // the account: that sentence goes on in the clear.
  const quiet = await b.ask('status', { sealed: true });
  assert.deepEqual([quiet.state, quiet.url, quiet.code, quiet.signedIn], ['waiting', again.url, again.code, first]);
  assert.equal(quiet.text, 'A code is out to sign Codex in for debbie on ops-box, and lasts about 1 more minute. It and its page are sealed to whoever asked. Until it is approved, Codex stays signed in there.');
  assert.equal(quiet.quietText, undefined);
  await until(async () => (await b.ask('status')).state === 'expired', 'the code running out');
  const expired = await b.ask('status');
  assert.deepEqual(expired.signedIn, first);
  assert.match(expired.text, /^The code ran out before anybody approved it, so Codex was not signed in for debbie on ops-box\. Start again for a new code\. Codex is still signed in as debbie@example\.com there, since /);
  assert.equal(expired.quietText, undefined);
  assert.match((await b.ask('status', { sealed: true })).text, /^The code ran out before anybody approved it, so Codex was not signed in for debbie on ops-box\. Start again for a new code\. Codex is still signed in there, since \d{4}-/);
  // A refusal that says where the sign-in stands is worded the same two ways.
  const nothing = await b.ask('cancel', { sealed: true });
  assert.match(nothing.text, /^No Codex sign-in was waiting for debbie on ops-box\. .* Codex is still signed in there, since /);
  assert.deepEqual(b.signins.report().map((r) => [r.state, r.since]), [['expired', first.since]], 'still reported as signed in, since the first time');
  await until(() => !b.running('fw-signin-codex-debbie'), 'the expired attempt’s container ended');

  // THE ENGINE REFUSES IT, with a sign-in there that a new one would have replaced.
  const b2 = box(t);
  mkdirSync(b2.volume('fw-engine-debbie', 'codex'), { recursive: true });
  writeFileSync(b2.volume('fw-engine-debbie', 'codex', 'auth.json'), codexSignIn({ refresh: TOKEN }));
  await b2.ask('start');
  b2.provider('refused', 'device code exchange failed: this account is not for this workspace');
  await until(async () => (await b2.ask('status')).state === 'failed', 'the refusal');
  const failed = await b2.ask('status');
  assert.equal(failed.detail, 'device code exchange failed: this account is not for this workspace');
  assert.equal(failed.text, 'Codex was not signed in for debbie on ops-box: device code exchange failed: this account is not for this workspace.');
  for (const [where, text] of [['an answer', JSON.stringify([...b.answers, ...b2.answers])], ['a state file', b.kept() + b2.kept()], ['a log line', said()]]) {
    assert.ok(!text.includes('LEAKCANARY'), `a token is in ${where}`);
  }
});

test('an account with device code turned off is refused as that at the start, in Codex’s words, with nothing left waiting', async (t) => {
  const b = box(t);
  b.set('codex-off');
  const r = await b.ask('start');
  assert.deepEqual([r.ok, r.error?.code, r.state], [false, 'device_code_off', 'failed']);
  assert.equal(r.text, 'Codex says device code sign-in is not turned on for this account or its workspace, in its words: device code login is not enabled for this Codex server. Use the browser login or verify the server URL. Turn it on there, or paste a sign-in instead.');
  assert.equal(r.url, undefined);
  assert.deepEqual([(await b.ask('status')).state, b.signins.attempts.size], ['failed', 0]);
});

test('a cancel tells the engine, ends the container and is written down; with nothing waiting it says so and changes nothing', async (t) => {
  const b = box(t);
  await b.ask('start');
  const cancelled = await b.ask('cancel');
  assert.deepEqual([cancelled.ok, cancelled.state, cancelled.signedIn], [true, 'cancelled', null]);
  assert.equal(cancelled.text, 'The Codex sign-in for debbie on ops-box was cancelled.');
  // The signal reached the runner, which told Codex to stop asking OpenAI.
  assert.ok(b.codexSaw().includes('account/login/cancel'));
  assert.equal(b.running('fw-signin-codex-debbie'), false);
  assert.ok(b.calls().includes('rm -f fw-signin-codex-debbie'));
  assert.equal(existsSync(b.volume('fw-engine-debbie', 'codex', 'auth.json')), false);
  // Nothing waiting: said, and the last word stands.
  const none = await b.ask('cancel');
  assert.deepEqual([none.ok, none.state], [true, 'cancelled']);
  assert.match(none.text, /^No Codex sign-in was waiting for debbie on ops-box\. /);
  // A code that was cancelled is not approved afterwards by a late answer.
  b.provider('approved');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await b.ask('status')).state, 'cancelled');
});

test('an attempt begun the moment the last one ended is not ended by the last one’s tidying up', async (t) => {
  // Both run under one name. The removal that follows an attempt was not
  // waited for, so a slow one found the next attempt's container under the
  // name and removed that.
  const b = box(t);
  await b.ask('start');
  b.set('slow-rm-once');
  b.provider('approved');
  await until(async () => (await b.ask('status')).state === 'signed_in', 'the first sign-in');
  b.set('provider-approved', false);
  assert.equal((await b.ask('start')).state, 'waiting');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await b.ask('status')).state, 'waiting');
  assert.equal(b.running('fw-signin-codex-debbie'), true);
});

/**
 * A hub in a process of its own that starts one attempt and is then killed
 * outright, as a hub that crashes or is restarted under it is: its memory
 * goes, and the file and the container are left.
 */
async function hubThatDies(/** @type {{ cfg: any }} */ b) {
  const script = `
    import { EngineSignins } from ${JSON.stringify(new URL('../src/core/engine-signin.js', import.meta.url).href)};
    const signins = new EngineSignins(JSON.parse(process.env.CFG));
    process.stdout.write(JSON.stringify(await signins.ask(JSON.parse(process.env.ASK))) + '\\n');
    setInterval(() => {}, 1000);`;
  const hub = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CFG: JSON.stringify(b.cfg), ASK: JSON.stringify({ ...DEBBIE, engine: 'codex', action: 'start' }) }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  const answered = await new Promise((resolve) => createInterface({ input: hub.stdout }).on('line', (l) => l.startsWith('{') && resolve(JSON.parse(l))));
  hub.kill('SIGKILL');
  await once(hub, 'exit');
  return answered;
}

test('a hub that restarts under a waiting attempt asks the home what became of it: lost when nobody had approved the code, signed in when somebody had, and never waiting', async (t) => {
  const said = logged(t);
  const b = box(t);
  assert.equal((await hubThatDies(b)).state, 'waiting');
  assert.equal(b.running('fw-signin-codex-debbie'), true, 'the container outlives the hub that started it');
  // The hub that comes up in its place: asked, it ends the container nobody
  // is listening to, looks in the home, and says what it found.
  const after = await b.ask('status');
  assert.deepEqual([after.state, after.url, after.code, after.signedIn], ['lost', undefined, undefined, null]);
  assert.equal(after.text, 'ops-box restarted while a Codex sign-in for debbie was waiting, so that attempt is gone. Start again for a new code.');
  assert.equal(b.running('fw-signin-codex-debbie'), false, 'the container was still running when the home was asked about');
  // ASKED WITH NO ENGINE AND NO NETWORK, in a container of its own name.
  assert.equal(b.runs().at(-1), `run --rm --name fw-signin-codex-debbie-asked -v fw-engine-debbie:${ENGINE_HOME} -e FLEETWRIGHT_ENGINE_HOME=${ENGINE_HOME} --network=none img fleetwright-engine --signedin codex`);
  assert.deepEqual(b.codexSaw().filter((m) => m !== 'initialize' && m !== 'initialized' && m !== 'account/login/start'), [], 'the engine was started to answer');
  // What nobody could see does not go on to sign in.
  b.provider('approved');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(existsSync(b.volume('fw-engine-debbie', 'codex', 'auth.json')), false);
  assert.deepEqual(b.signins.report().map((r) => [r.state, r.since]), [['lost', null]]);

  // THE OTHER ORDER: THE CODE WAS APPROVED WHILE THE HUB WAS DOWN. The
  // container outlived it and the engine signed the member in. The hub that
  // came back said the attempt was gone and reported nobody, with the
  // member's sessions running on the sign-in and nothing offering to sign it out.
  const o = box(t);
  assert.equal((await hubThatDies(o)).state, 'waiting');
  o.provider('approved');
  await until(() => existsSync(o.volume('fw-engine-debbie', 'codex', 'auth.json')), 'the code approved with no hub listening');
  const back = await o.ask('status');
  assert.deepEqual([back.ok, back.state, back.url, back.code], [true, 'signed_in', undefined, undefined]);
  // Since when the engine wrote it. Who is not known: no engine was asked, and the box does not read the file.
  assert.deepEqual([back.signedIn.who, back.signedIn.since > 0, back.signedIn.since <= Date.now()], [null, true, true]);
  assert.match(back.text, /^Codex is signed in for debbie on ops-box, since \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/);
  assert.deepEqual(o.signins.report().map((r) => [r.state, r.since]), [['signed_in', back.signedIn.since]]);
  assert.match(said(), /engines: codex sign-in for debbie: lost, and the code had been approved: signed in/);
  // It can be signed out, which is what no screen offered while the box said nobody was signed in.
  assert.equal((await o.ask('signout')).state, 'signed_out');

  // AND WHEN IT CANNOT ASK, IT CANNOT TELL. Never lost, never not signed in: a refusal that says so, and it looks again when asked again.
  const c = box(t);
  await hubThatDies(c);
  c.provider('approved');
  await until(() => existsSync(c.volume('fw-engine-debbie', 'codex', 'auth.json')), 'approved here too');
  c.set('no-image');
  for (const action of ['status', 'cancel']) {
    const blind = await c.ask(action);
    assert.deepEqual([blind.ok, blind.error?.code, blind.state, blind.signedIn], [false, 'cannot_tell', undefined, undefined], action);
    assert.equal(blind.text, 'ops-box did not hear how the last Codex sign-in for debbie ended (it restarted while the code was out), and has not been able to ask whether the code was approved first. So it cannot tell whether Codex is signed in for debbie there. Ask again in a moment, and it looks again.');
  }
  c.set('no-image', false);
  assert.equal((await c.ask('status')).state, 'signed_in');

  // FOUND AS THE HUB COMES UP, before anybody asks, and written down once the home has answered.
  const b2 = box(t);
  await hubThatDies(b2);
  b2.signins.recover();
  assert.notEqual(b2.signins.report()[0].state, 'waiting');
  await until(() => b2.signins.report()[0].state === 'lost', 'the attempt a restart left, written down as lost');
  assert.equal(b2.running('fw-signin-codex-debbie'), false);
  // AND A HUB THAT STOPS IN GOOD ORDER ends what is waiting itself, as lost and not as cancelled: nobody cancelled it.
  // The runner said so as it was stopped, so there is nothing to ask.
  const b3 = box(t);
  await b3.ask('start');
  await b3.signins.close();
  assert.equal((await b3.ask('status')).state, 'lost');
  assert.equal(b3.running('fw-signin-codex-debbie'), false);
  assert.ok(!b3.runs().some((l) => l.includes('--signedin')), 'a home was asked about an ending the runner had said');
});

test('a sign out has the engine remove its sign-in and stops reporting it; one that fails changes nothing this box says', async (t) => {
  const b = box(t);
  await b.ask('start');
  b.provider('approved');
  await until(async () => (await b.ask('status')).state === 'signed_in', 'the sign-in');
  await until(() => !b.running('fw-signin-codex-debbie'), 'the container gone');
  // THE CONTAINER THAT ASKS THE ENGINE CANNOT RUN: nothing is recorded.
  b.set('fail-run');
  const failed = await b.ask('signout');
  assert.deepEqual([failed.ok, failed.error?.code], [false, 'signout_failed']);
  assert.match(failed.text, /^Codex was not signed out for debbie on ops-box: .*What ops-box knows of the sign-in is unchanged\.$/);
  assert.equal((await b.ask('status')).state, 'signed_in');
  b.set('fail-run', false);
  // ASKED TWICE AT ONCE, the second is told the first is at it, and what to do next.
  const [out, busy] = await Promise.all([b.ask('signout'), b.ask('signout')]);
  assert.deepEqual([busy.ok, busy.error?.code], [false, 'busy']);
  assert.equal(busy.text, 'Codex is already being signed out for debbie on ops-box, so this asked for nothing more. Ask where it stands in a moment.');
  assert.deepEqual([out.ok, out.state, out.signedIn], [true, 'signed_out', null]);
  assert.equal(b.runs().at(-1), `run --rm --name fw-signin-codex-debbie -v fw-engine-debbie:${ENGINE_HOME} -e FLEETWRIGHT_ENGINE_HOME=${ENGINE_HOME} img fleetwright-engine --signout codex`);
  assert.equal(existsSync(b.volume('fw-engine-debbie', 'codex', 'auth.json')), false, 'Codex removed its own file');
  assert.deepEqual(b.signins.report().map((r) => [r.state, r.since]), [['signed_out', null]]);
});

test('OpenCode is signed in to Copilot the same way, and who it is signed in as is not known', async (t) => {
  const said = logged(t);
  const b = box(t);
  const waiting = await b.ask('start', { engine: 'opencode' });
  assert.deepEqual([waiting.state, waiting.url, waiting.code], ['waiting', 'https://github.com/login/device', 'WXYZ-1234']);
  // Its own attempt, beside Codex's: one a member and engine.
  assert.equal((await b.ask('status')).state, 'none');
  b.provider('approved');
  await until(async () => (await b.ask('status', { engine: 'opencode' })).state === 'signed_in', 'the sign-in');
  const now = await b.ask('status', { engine: 'opencode' });
  assert.deepEqual(now.signedIn, { since: now.at, who: null });
  assert.match(now.text, /^OpenCode is signed in for debbie on ops-box, since /);
  assert.ok(readFileSync(b.volume('fw-engine-debbie', 'opencode', 'auth.json'), 'utf8').includes(TOKEN));
  for (const [where, text] of [['an answer', JSON.stringify(b.answers)], ['the state file', b.kept()], ['a log line', said()]]) {
    assert.ok(!text.includes('LEAKCANARY'), `a token is in ${where}`);
  }
});

test('a box that does not run the engine, has no image, or cannot run a container refuses in words and keeps nothing', async (t) => {
  // Codex alone: OpenCode is refused for every action, before anything is run.
  const b = box(t, { engines: ['codex'] });
  for (const action of ['start', 'status', 'cancel', 'signout']) {
    const r = await b.ask(action, { engine: 'opencode' });
    assert.deepEqual([r.ok, r.error?.code], [false, 'no_engine'], action);
    assert.equal(r.text, 'ops-box does not run OpenCode, so it cannot be signed in here. Its operator adds OpenCode to the session image and names it in FLEETWRIGHT_ENGINES, or the sign-in is made on a machine that runs it.');
  }
  // A box whose sessions are not in a container with the socket runs Claude Code alone, whatever is named.
  assert.equal((await box(t, { sandbox: false }).ask('start')).error?.code, 'no_engine');
  b.set('no-image');
  const noImage = await b.ask('start');
  assert.deepEqual([noImage.ok, noImage.error?.code], [false, 'no_image']);
  assert.match(noImage.text, /^ops-box has not fetched its session image yet/);
  b.set('no-image', false);
  b.set('fail-run');
  const noRun = await b.ask('start');
  assert.deepEqual([noRun.ok, noRun.error?.code, noRun.state], [false, 'signin_failed', 'failed']);
  assert.equal(noRun.text, 'Codex was not signed in for debbie on ops-box: the sign-in container stopped before it gave a code: Error: crun: cannot set memory limit.');
  assert.equal(b.signins.attempts.size, 0);
  // A RECORD THAT CANNOT BE READ is cannot tell: nothing is reported, and nothing is said of where a sign-in stands.
  const blind = new EngineSignins(/** @type {any} */ ({ ...b.cfg, get stateDir() { throw new Error('EACCES: permission denied'); } }));
  assert.equal(blind.report(), null);
  assert.equal((await blind.ask({ ...DEBBIE, engine: 'codex', action: 'status' })).error?.code, 'state_unreadable');
  // What is asked is held to its shape, whoever posts it: an agent's account is that agent's.
  for (const bad of [{ member: 'Debbie' }, { engine: 'claude-code' }, { action: 'renew' }, { account: 'not an address' }, { account: 'jason@members.invalid' }]) {
    assert.equal((await b.ask('status', bad)).error?.code, 'bad_params', JSON.stringify(bad));
  }
  assert.equal(b.runs().length, 1, 'only the start that could not run reached Podman');
});

test('a sign-in a session finds ended is no longer reported, and an engine on a key ending says nothing of a sign-in', async (t) => {
  const b = box(t);
  for (const engine of ['codex', 'opencode']) {
    await b.ask('start', { engine });
    b.provider('approved');
    await until(async () => (await b.ask('status', { engine })).state === 'signed_in', `${engine} signed in`);
  }
  const registry = new Registry({ stateFile: path.join(b.dir, 'state.json'), spoolFile: path.join(b.dir, 'spool') });
  const sm = new SessionManager(b.cfg, registry);
  sm.engineSignins = b.signins;
  const ended = (/** @type {string} */ name, /** @type {any} */ engines, /** @type {string} */ engine, reason = 'auth') => {
    registry.upsert(name, { status: 'running', cwd: '/work', createdBy: 'fleet:debbie@members.invalid', member: 'debbie', engines, engineAt: 0 });
    return sm.recordEvent({ name, event: 'TurnEnded', turn: { engine, reason, detail: null, model: null, usage: null, resetsAt: null } });
  };
  const since = () => Object.fromEntries(b.signins.report().map((r) => [r.engine, r.state]));
  // A limit is not a sign-in ending, and OpenCode on a key has no sign-in to end.
  ended('job-1', [{ engine: 'codex' }], 'codex', 'limit');
  ended('job-2', [{ engine: 'opencode', model: 'openrouter/some-model' }], 'opencode');
  assert.deepEqual(since(), { codex: 'signed_in', opencode: 'signed_in' });
  // Codex itself says it is not signed in.
  ended('job-3', [{ engine: 'codex' }], 'codex');
  assert.deepEqual(since(), { codex: 'ended', opencode: 'signed_in' });
  const now = await b.ask('status');
  assert.deepEqual([now.state, now.signedIn], ['ended', null]);
  assert.equal(now.text, 'Codex said its sign-in for debbie on ops-box no longer works. Sign it in again.');
});

test('the hub itself answers on that route for whoever holds its token, tells a session’s ending to the same store, and says in its state who is signed in', async (t) => {
  const b = signinBox(t);
  const cfg = b.cfg({ bind: '127.0.0.1', port: 0, token: '', workdir: path.join(b.dir, 'work'), maxSessions: 5, loginEnabled: true, sandboxCredentialsFile: '', sandboxImagePinned: false, releaseChannel: '', rulesFile: path.join(b.dir, 'CLAUDE.md') });
  const sessions = /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [], forgetOwner: () => [] });
  const token = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions, login: /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null, forget: () => false }), token });
  await adapter.start();
  t.after(() => adapter.stop());
  const baseUrl = `http://127.0.0.1:${/** @type {any} */ (adapter.server).address().port}`;
  const ask = { ...DEBBIE, engine: 'codex', action: 'start' };
  // Not for anybody who can reach the port.
  const anybody = await fetch(`${baseUrl}/api/engine-signin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ask) });
  assert.equal(anybody.status, 401);
  assert.deepEqual(b.runs(), []);
  const hub = new HubClient({ baseUrl, token });
  const waiting = await hub.engineSignin(ask);
  assert.deepEqual([waiting.ok, waiting.state, waiting.url, waiting.code], [true, 'waiting', 'https://auth.openai.com/codex/device', 'ABCD-EFGH']);
  // A refusal is an answer too, with its code, and is passed on as one.
  assert.deepEqual([(await hub.engineSignin({ ...ask, engine: 'claude-code' })).error?.code, (await hub.engineSignin({ ...ask, engine: 'claude-code' })).ok], ['bad_params', false]);
  b.provider('approved');
  await until(async () => (await hub.state()).engineSignins?.[0]?.since > 0, 'the hub’s state saying debbie is signed in');
  const state = await hub.state();
  assert.deepEqual(state.engineSignins.map((/** @type {any} */ e) => [e.member, e.engine, e.state]), [['debbie', 'codex', 'signed_in']]);
  assert.ok(!JSON.stringify(state).includes('ABCD-EFGH') && !JSON.stringify(state).includes('LEAKCANARY'), 'the hub’s state carries the code or a token');
  // The store a session's ending is told to is this one.
  assert.equal(sessions.engineSignins, adapter.engineSignins);

  // AND IT IS THE STORE A REMOVAL REACHES, on the two routes the sidecar has for one.
  // A person removed from the fleet (forget-person.js):
  const eli = { ...ELI, engine: 'codex', action: 'start' };
  assert.equal((await hub.engineSignin(eli)).state, 'waiting');
  const forgot = await hub.forgetPerson('eli@example.com');
  assert.deepEqual([forgot.ok, forgot.forgot?.engines?.attempts], [true, 1]);
  assert.equal(adapter.engineSignins.attempts.size, 0);
  // A member the vault no longer lists (keepMembers), which only the hub's own token may say.
  const anybodyAgain = await fetch(`${baseUrl}/api/engine-members`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ members: [] }) });
  assert.equal(anybodyAgain.status, 401);
  assert.deepEqual((await hub.state()).engineSignins.map((/** @type {any} */ e) => e.member), ['debbie']);
  assert.deepEqual(await hub.engineMembers(['debbie']), { ok: true, gone: [], text: 'Every member this machine holds an engine sign-in for is still listed.' });
  assert.deepEqual((await hub.engineMembers([])).gone, ['debbie']);
  assert.deepEqual((await hub.state()).engineSignins, []);
});

test('the sidecar asks its hub on a route of its own, says so when the hub is older, reports only who is signed in, and says when an attempt ends', async (t) => {
  // An older hub has no such route.
  const old = await startStubHub({ host: 'ops-box', without: ['/api/engine-signin', '/api/engine-members'] });
  t.after(() => old.close());
  // Said by the machine's name, with what to do there: "fleetwright here" reads, on a phone, as the phone.
  assert.deepEqual(await new HubClient({ baseUrl: old.baseUrl, token: null }).engineSignin({ ...DEBBIE, engine: 'codex', action: 'start' }), {
    ok: false, error: { code: 'hub_outdated' },
    text: 'ops-box is running a fleetwright from before engines were signed in on a machine. Update fleetwright on ops-box and restart it, then ask again.',
  });
  // And none for who is still a member: it keeps everything, and says it is not done.
  assert.deepEqual(await new HubClient({ baseUrl: old.baseUrl, token: null }).engineMembers(['debbie']), { ok: false, gone: [], text: 'fleetwright here is older than forgetting a removed member’s engine sign-ins; update it' });

  const at = Date.UTC(2026, 10, 25, 10);
  const hub = await startStubHub({ host: 'ops-box', facts: { engines: ['claude-code', 'codex'], engineSignins: [
    { member: 'debbie', engine: 'codex', state: 'signed_in', at, since: at },
    { member: 'jason', engine: 'codex', state: 'expired', at, since: null },
    { member: 'ada', engine: 'opencode', state: 'expired', at, since: at - 1000 },
    // What a hub would never send, and a frame would never carry.
    { member: 'Not An Id', engine: 'codex', state: 'signed_in', at, since: at }, { member: 'zed', engine: 'claude-code', state: 'signed_in', at, since: at },
  ] } });
  t.after(() => hub.close());
  const quiet = { info() {}, warn() {}, error() {}, debug() {} };
  /** @type {any[]} */
  const sent = [];
  const sidecar = new Sidecar({
    hub: new HubClient({ baseUrl: hub.baseUrl, token: null }), hostId: 'ops-box', watch: false, healthIntervalMs: 0, renewIntervalMs: 0, logger: quiet,
    transport: /** @type {any} */ ({ origin: 'https://fleet.test', onMessage() {}, start: async () => true, stop: async () => {}, send: (/** @type {any} */ f) => { sent.push(f); return true; } }),
  });
  // NOT TO A COORDINATOR THAT HAS NOT SHOWN IT KNOWS THE LIST. One from before
  // protocol 22 passes every health key it does not know to every member, so
  // a box that updated first told the whole fleet who was signed in where.
  // Absent, which every reader takes as cannot tell.
  assert.equal('engineSignins' in (await sidecar.health()), false, 'the list went to a coordinator that has said nothing of what it speaks');
  await sidecar.handle({ v: 21, kind: 'vault-changed' });
  assert.equal('engineSignins' in (await sidecar.health()), false, 'the list went to a coordinator that speaks 21');
  await sidecar.handle({ v: 22, kind: 'vault-changed' });
  // THE FRAME: who is signed in now, by id, engine and since when. An attempt that expired leaves the sign-in before it.
  assert.deepEqual((await sidecar.health()).engineSignins, [{ member: 'debbie', engine: 'codex', since: at }, { member: 'ada', engine: 'opencode', since: at - 1000 }]);
  // An intent is spoken in the older of the two parties' versions, so one in 21 does not say the coordinator is behind, and one in 22 says it is not.
  await sidecar.handle({ v: 21, kind: 'intent', id: 'health-0001-older', verb: 'health', params: {}, issuedAt: Date.now() });
  assert.equal('engineSignins' in (await sidecar.health()), true, 'an intent in an older version took the list back');
  // A coordinator rolled back under a box that stays up is heard, by the next frame it stamps.
  await sidecar.handle({ v: 21, kind: 'vault-changed' });
  assert.equal('engineSignins' in (await sidecar.health()), false);
  await sidecar.handle({ v: 22, kind: 'intent', id: 'health-0002-newer', verb: 'health', params: {}, issuedAt: Date.now() });
  assert.equal('engineSignins' in (await sidecar.health()), true);

  // THE EVENT, on a change and never on the first look.
  const watcher = new SessionWatcher({ hub: new HubClient({ baseUrl: hub.baseUrl, token: null }), emit: (/** @type {any} */ e) => sidecar.emitEvent(e), logger: quiet });
  await watcher.tick();
  assert.deepEqual(sent.filter((f) => f.kind === 'event'), [], 'what was already there is not news');
  hub.setFacts({ engineSignins: [
    { member: 'debbie', engine: 'codex', state: 'signed_in', at, since: at },
    { member: 'jason', engine: 'codex', state: 'signed_in', at: at + 5000, since: at + 5000, url: 'https://auth.openai.com/codex/device', code: 'ABCD-EFGH' },
  ] });
  await watcher.tick();
  await watcher.tick();
  // A member's id, an engine, a state and a time: whatever else a hub's state held is not carried.
  assert.deepEqual(sent.filter((f) => f.kind === 'event').map(({ v: _v, ...f }) => f), [{ kind: 'event', hostId: 'ops-box', event: 'engine.signin', member: 'jason', engine: 'codex', state: 'signed_in', at: at + 5000 }]);
});

test('the name a sign-in’s container runs under is its engine and its member, and an id that is not one never reaches Podman', async (t) => {
  assert.equal(containerFor('debbie', 'codex'), 'fw-signin-codex-debbie');
  // What would break out of a name, or of the command it is in, is not a member's id, and is refused before anything is run or named.
  const b = box(t);
  for (const member of ['debbie --privileged', 'debbie;reboot', '../debbie', 'debbie/codex', '-v', 'debbie\n--rm', 'DEBBIE', 'person.0123456789abcdef', '']) {
    for (const action of ['start', 'status', 'cancel', 'signout']) {
      assert.equal((await b.ask(action, { member, account: 'debbie@members.invalid' })).error?.code, 'bad_params', `${JSON.stringify(member)} ${action}`);
    }
  }
  assert.deepEqual(b.calls(), [], 'Podman was run for something that is not a member');
  assert.equal(b.kept(), '', 'and something was written down for it');
});

// ── What the runner says is held to what this box knows ─────────────────────

/**
 * A Podman whose container prints the lines a test gives it and then waits
 * to be stopped: what this box does with a first line, whatever printed it.
 * The runner and the engines are not in it, on purpose. What they print is
 * theirs (test/engine-signin-run.test.js); what the box does with a line it
 * should not believe must not depend on their being unable to print one.
 */
function sayingBox(/** @type {import('node:test').TestContext} */ t, /** @type {Record<string, unknown>[]} */ lines, /** @type {any} */ opts = {}, /** @type {{ ends?: boolean, home?: Record<string, unknown>|null }} */ { ends = false, home = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-signin-says-'));
  const podmanBin = path.join(dir, 'podman');
  writeFileSync(path.join(dir, 'lines'), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  // What the container that looks in the home says of it (`--signedin`), when it says anything.
  if (home) writeFileSync(path.join(dir, 'home'), `${JSON.stringify(home)}\n`);
  writeFileSync(podmanBin, `#!/bin/sh
D='${dir}'
printf '%s\\n' "$*" >> "$D/podman.log"
case "$1" in
  --version) echo 'podman version 5.0.0'; exit 0 ;;
  rm) for last; do :; done; if [ -e "$D/ctr-$last.pid" ]; then kill -9 "-$(cat "$D/ctr-$last.pid")" 2>/dev/null; rm -f "$D/ctr-$last.pid"; fi; exit 0 ;;
  run) ;;
  *) exit 0 ;;
esac
name=''
asked=''
while [ $# -gt 0 ]; do case "$1" in --name) name="$2"; shift ;; --signedin) asked=1 ;; esac; shift; done
if [ -n "$asked" ]; then cat "$D/home" 2>/dev/null; exit 0; fi
echo $$ > "$D/ctr-$name.pid"
cat "$D/lines"
${ends ? 'exit 0' : 'exec sleep 30'}
`);
  chmodSync(podmanBin, 0o755);
  const pid = (/** @type {string} */ container) => (existsSync(path.join(dir, `ctr-${container}.pid`)) ? Number(readFileSync(path.join(dir, `ctr-${container}.pid`), 'utf8')) : 0);
  const running = (/** @type {string} */ container) => {
    try {
      return pid(container) > 0 && (process.kill(pid(container), 0), true);
    } catch {
      return false;
    }
  };
  const cfg = /** @type {any} */ ({ stateDir: path.join(dir, 'state'), hostname: 'ops-box', podmanBin, sandbox: true, sandboxHookSocket: true, sandboxImage: 'img', sandboxUserns: 'host', sandboxExtraArgs: [], engines: ['codex', 'opencode'] });
  const signins = new EngineSignins(cfg, opts);
  t.after(async () => {
    await signins.close();
    for (const engine of ['codex', 'opencode']) {
      // Only one that is known: a group of 0 is this process's own.
      const left = pid(`fw-signin-${engine}-debbie`);
      try {
        if (left > 0) process.kill(-left, 'SIGKILL');
      } catch { /* gone already */ }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const kept = () => (existsSync(signins.file) ? readFileSync(signins.file, 'utf8') : '');
  const calls = () => (existsSync(path.join(dir, 'podman.log')) ? readFileSync(path.join(dir, 'podman.log'), 'utf8').split('\n').filter(Boolean) : []);
  return { dir, cfg, signins, running, kept, calls, ask: (/** @type {string} */ action, /** @type {Record<string, unknown>} */ over = {}) => signins.ask({ ...DEBBIE, engine: 'codex', action, ...over }) };
}

test('a first line that does not read as a page and a code is refused at once, in words that say which half, and nothing is left waiting', async (t) => {
  const said = logged(t);
  // WHAT A RUNNER PRINTED on a machine whose engine home already held a Codex
  // sign-in: it took the issuer in that file for a secret and cut it out of
  // the page. The box skipped the line without a word and, 45 seconds later,
  // said Codex gave no code.
  for (const [line, half] of /** @type {const} */ ([
    [{ signin: 'code', engine: 'codex', url: '[withheld]/codex/device', code: 'ABCD-EFGH', expiresInMinutes: 15 }, 'what it was given as the page does not begin https://'],
    [{ signin: 'code', engine: 'codex', url: SIGNIN_PAGES.codex.page, code: 'ABCD EFGH; open evil', expiresInMinutes: 15 }, 'what it was given as the code is not letters, digits and hyphens'],
    [{ signin: 'code', engine: 'codex', code: 'ABCD-EFGH' }, 'what it was given as the page does not begin https://'],
  ])) {
    const b = sayingBox(t, [line]);
    const began = Date.now();
    const r = await b.ask('start');
    assert.ok(Date.now() - began < 10_000, 'it waited out its 45 seconds to say so');
    assert.deepEqual([r.ok, r.error?.code, r.state, r.url, r.code], [false, 'unreadable_code', 'failed', undefined, undefined]);
    assert.equal(r.text, `Codex was not signed in for debbie on ops-box: ops-box could not read the page and the code it gave (${half}). Nothing is waiting. That is a fault in fleetwright on ops-box and not at OpenAI: update fleetwright on ops-box and start again, or paste a sign-in instead.`);
    assert.deepEqual([(await b.ask('status')).state, b.signins.attempts.size], ['failed', 0]);
    await until(() => !b.running('fw-signin-codex-debbie'), 'the container ended');
    // Neither half is repeated anywhere: what was given is not known to be anybody's page.
    for (const [where, text] of [['the answer', JSON.stringify(r)], ['the state file', b.kept()], ['a log line', said()]]) {
      assert.ok(!text.includes('ABCD') && !text.includes('codex/device'), `the page or the code it could not read is in ${where}`);
    }
  }
});

test('a page that is not the provider’s own ends the attempt, and its code is given to nobody: not in the answer, a status, the record or the log', async (t) => {
  const said = logged(t);
  assert.deepEqual(SIGNIN_PAGES, { codex: { page: 'https://auth.openai.com/codex/device', at: 'OpenAI' }, opencode: { page: 'https://github.com/login/device', at: 'GitHub' } });
  // THE RUNNER HOLDS ITS ENGINE TO THE SAME TWO (sandbox/engine.mjs, which this box cannot import from and the image cannot import this from).
  // One list moved without the other is every sign-in refused by whichever was left behind.
  assert.deepEqual(Object.fromEntries(Object.entries(SIGNIN_PAGES).map(([engine, own]) => [engine, own.page])), { ...RUNNER_PAGES });
  // The engine in a sign-in's container runs on a volume the member's
  // sessions write. Whatever it names, only the one page is this box's word.
  for (const [engine, url] of /** @type {const} */ ([
    ['opencode', 'https://github.com.login-device.example/login/device'],
    ['opencode', 'https://github.com/login/device?next=https://evil.example'],
    ['opencode', 'https://github.com/login/device/'],
    ['opencode', 'https://GITHUB.com/login/device'],
    // Each engine's own page is not the other's.
    ['opencode', SIGNIN_PAGES.codex.page],
    ['codex', SIGNIN_PAGES.opencode.page],
    ['codex', 'https://auth.openai.com.evil.example/codex/device'],
    ['codex', 'https://auth.openai.com/codex/device#x'],
  ])) {
    const b = sayingBox(t, [{ signin: 'code', engine, url, code: 'EVIL-0000', expiresInMinutes: 15 }, { signin: 'done', engine, state: 'signed_in', who: { email: 'mallory@example.com', plan: 'plus' } }]);
    const r = await b.ask('start', { engine });
    const [says, at] = engine === 'codex' ? ['Codex', 'OpenAI'] : ['OpenCode', 'GitHub'];
    assert.deepEqual([r.ok, r.error?.code, r.state, r.url, r.code, r.signedIn], [false, 'wrong_page', 'failed', undefined, undefined, undefined], url);
    assert.equal(r.text, `${says} was not signed in for debbie on ops-box: its sign-in named a page that is not ${at}’s own, so ops-box stopped it and gave nobody the code. Nothing is waiting. Whoever runs ops-box looks at what its session image runs as ${says} and at what is in debbie’s engine home there (fw-engine-debbie), before anybody starts again.`);
    await until(() => !b.running(`fw-signin-${engine}-debbie`), 'the container ended');
    // STOPPED, so the sign-in it then claimed is nobody's: nothing is recorded as signed in.
    const now = await b.ask('status', { engine });
    assert.deepEqual([now.state, now.url, now.code, now.signedIn, b.signins.attempts.size], ['failed', undefined, undefined, null, 0]);
    assert.deepEqual(b.signins.report().map((e) => [e.state, e.since]), [['failed', null]]);
    for (const [where, text] of [['an answer', JSON.stringify([r, now])], ['the state file', b.kept()], ['a log line', said()]]) {
      assert.ok(!text.includes('EVIL-0000') && !text.includes(new URL(url).host.toLowerCase()) && !text.includes('mallory'), `the page it named, its code or who it claimed is in ${where}`);
    }
  }
  // AND THE PROVIDER'S OWN PAGE, from the same Podman, is answered: the check is the page and nothing about who printed it.
  const ok = sayingBox(t, [{ signin: 'code', engine: 'opencode', url: SIGNIN_PAGES.opencode.page, code: 'WXYZ-1234', expiresInMinutes: 15 }]);
  assert.deepEqual([(await ok.ask('start', { engine: 'opencode' })).state, (await ok.ask('status', { engine: 'opencode' })).code], ['waiting', 'WXYZ-1234']);
});

test('an ending the runner did not say, with a code out, is asked of the home before it is said: a container that died, a cancel that raced an approval, a pasted copy', async (t) => {
  const code = { signin: 'code', engine: 'codex', url: SIGNIN_PAGES.codex.page, code: 'ABCD-EFGH', expiresInMinutes: 15 };
  const later = () => Date.now() + 60_000;
  const state = async (/** @type {ReturnType<typeof sayingBox>} */ b) => {
    await until(async () => (await b.ask('status')).state !== 'waiting', 'the attempt over');
    return b.ask('status');
  };
  // THE CONTAINER DIED AFTER THE CODE WAS OUT, having written the sign-in:
  // the box said "was not signed in", of something it had not heard.
  const died = sayingBox(t, [code], {}, { ends: true, home: { signin: 'is', engine: 'codex', signedIn: true, pasted: false, writtenAt: later() } });
  await died.ask('start');
  const signedIn = await state(died);
  assert.deepEqual([signedIn.state, signedIn.signedIn.who, signedIn.signedIn.since > 0], ['signed_in', null, true]);
  assert.match(signedIn.text, /^Codex is signed in for debbie on ops-box, since /);
  // DIED, AND NOTHING IS IN THE HOME: now it is known, and said as it always was.
  const empty = sayingBox(t, [code], {}, { ends: true, home: { signin: 'is', engine: 'codex', signedIn: false, pasted: false, writtenAt: null } });
  await empty.ask('start');
  const not = await state(empty);
  assert.deepEqual([not.state, not.signedIn], ['failed', null]);
  assert.equal(not.text, 'Codex was not signed in for debbie on ops-box: the sign-in container stopped before it said how the sign-in ended.');
  // WHAT IS THERE IS THE BOX'S COPY OF A PASTED ONE, or was written before the attempt began: the attempt signed nobody in.
  for (const home of [{ signedIn: true, pasted: true, writtenAt: later() }, { signedIn: true, pasted: false, writtenAt: 1_000 }]) {
    const b = sayingBox(t, [code], {}, { ends: true, home: { signin: 'is', engine: 'codex', ...home } });
    await b.ask('start');
    const s = await state(b);
    assert.equal(s.state, 'failed', JSON.stringify(home));
    // A sign-in from before, which this box had not been told of, is now known and is said beside the attempt that failed.
    assert.equal(Boolean(s.signedIn), !home.pasted, JSON.stringify(home));
  }
  // THE HOME DOES NOT ANSWER: cannot tell, and not "was not signed in".
  const mute = sayingBox(t, [code], {}, { ends: true });
  await mute.ask('start');
  await until(async () => (await mute.ask('status')).ok === false, 'the attempt over');
  const blind = await mute.ask('status');
  assert.deepEqual([blind.ok, blind.error?.code, blind.state], [false, 'cannot_tell', undefined]);
  assert.equal(blind.text, 'ops-box did not hear how the last Codex sign-in for debbie ended (the container stopped without saying), and has not been able to ask whether the code was approved first. So it cannot tell whether Codex is signed in for debbie there. Ask again in a moment, and it looks again.');
  assert.equal(mute.signins.report()?.[0].since, null);
  // A CANCEL THAT RACED AN APPROVAL: stopped before the runner answered, with the sign-in written. The cancel's own answer says what is true.
  const raced = sayingBox(t, [code], { stopMs: 300 }, { home: { signin: 'is', engine: 'codex', signedIn: true, pasted: false, writtenAt: later() } });
  assert.equal((await raced.ask('start')).state, 'waiting');
  const cancelled = await raced.ask('cancel');
  assert.deepEqual([cancelled.state, cancelled.signedIn?.who], ['signed_in', null]);
  // BEFORE ANY CODE there was nothing to approve, and nothing is asked.
  const early = sayingBox(t, [], {}, { ends: true, home: { signin: 'is', engine: 'codex', signedIn: true, pasted: false, writtenAt: later() } });
  assert.equal((await early.ask('start')).error?.code, 'signin_failed');
  assert.ok(!early.calls().some((l) => l.includes('--signedin')), 'a home was asked about an attempt that never had a code');
});

// ── A record that cannot be written, or does not read ───────────────────────

test('a record that cannot be written ends the attempt that needed it, in words, and nothing stays wedged once it can be written again', async (t) => {
  const b = box(t, {}, { stopMs: 300 });
  mkdirSync(b.cfg.stateDir, { recursive: true });
  // The state directory is there and reads; the one file a write goes through cannot be made.
  const blocked = `${b.signins.file}.${process.pid}`;
  const block = (on = true) => (on ? mkdirSync(blocked) : rmSync(blocked, { recursive: true }));

  // AT THE START: nothing is begun, and it is said. The write was not guarded,
  // with the attempt already held: every later start and status threw.
  block();
  const refused = await b.ask('start');
  assert.deepEqual([refused.ok, refused.error?.code, b.signins.attempts.size, b.runs().length], [false, 'state_unwritable', 0, 0]);
  assert.equal(refused.text, 'ops-box could not write to its own record of engine sign-ins (EISDIR), so it began no Codex sign-in for debbie and nothing is waiting. Whoever runs ops-box looks at its state directory and the room on its disk. Then start again.');
  assert.equal((await b.ask('status')).state, 'none');
  block(false);
  assert.equal((await b.ask('start')).state, 'waiting', 'the disk is fine again, and so is the box');

  // AS AN ATTEMPT ENDS: a cancel is still answered, and with what happened.
  // It used to wait for ever, as did a sign out and this hub's own stop.
  block();
  const cancelled = await Promise.race([b.ask('cancel'), new Promise((r) => setTimeout(() => r({ state: 'never answered' }), 8000))]);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(b.running('fw-signin-codex-debbie'), false);
  assert.deepEqual([(await b.ask('status')).state, b.signins.attempts.size], ['cancelled', 0]);
  assert.deepEqual(b.signins.report().map((e) => e.state), ['cancelled'], 'what could not be written is still what this box says');
  assert.equal(JSON.parse(b.kept()).signins['debbie/codex'].last, null, 'and it is not on disk yet');
  // Written down the next time anything is asked, once it can be. Never as lost: no restart lost it.
  block(false);
  assert.equal((await b.ask('status')).state, 'cancelled');
  assert.deepEqual([JSON.parse(b.kept()).signins['debbie/codex'].last.state, JSON.parse(b.kept()).signins['debbie/codex'].attempt], ['cancelled', null]);

  // AND THE HUB STOPS, with an attempt out and a record it cannot write.
  assert.equal((await b.ask('start')).state, 'waiting');
  block();
  assert.equal(await Promise.race([b.signins.close().then(() => 'stopped'), new Promise((r) => setTimeout(() => r('never stopped'), 8000))]), 'stopped');
  assert.equal(b.running('fw-signin-codex-debbie'), false);
  block(false);
  assert.equal((await b.ask('status')).state, 'lost');
});

test('a record that does not read as one is cannot tell, never nobody: not reported, said once, and not written over', async (t) => {
  const said = logged(t);
  const b = box(t);
  mkdirSync(b.cfg.stateDir, { recursive: true });
  // Cut short, as a disk that filled leaves a file somebody else wrote.
  const cut = '{"v":1,"signins":{"debbie/codex":{"member":"debbie","engine":"codex","signedIn":{"since":1795000000000';
  writeFileSync(b.signins.file, cut);
  // An empty list is this box saying nobody is signed in here. It does not know that.
  assert.deepEqual([b.signins.report(), b.signins.report(), b.signins.report()], [null, null, null]);
  for (const action of ['status', 'start', 'cancel', 'signout']) {
    const r = await b.ask(action);
    assert.deepEqual([r.ok, r.error?.code], [false, 'state_unreadable'], action);
    assert.equal(r.text, 'ops-box cannot read its own record of engine sign-ins, so it cannot say where this one stands or begin another. Whoever runs ops-box looks at engine-signins.json in its state directory: moved aside, the record starts again, and a sign-in made before is not known here until it is made again.');
  }
  assert.equal(b.signins.ended('debbie', 'codex'), false);
  assert.equal((said().match(/does not read as this machine’s record of engine sign-ins/g) ?? []).length, 1, 'said on every read, and the state is read every few seconds');
  assert.equal(b.kept(), cut, 'what it could not read was written over');
  assert.deepEqual(b.runs(), []);
  // Moved aside, as the sentence says, the record starts again.
  rmSync(b.signins.file);
  assert.deepEqual([b.signins.report(), (await b.ask('status')).state], [[], 'none']);
});

// ── Somebody who is gone ────────────────────────────────────────────────────

/**
 * The stand-in Podman, with the two things a removal asks of it: which
 * volumes there are, and removing one. Everything else is the stand-in's own
 * (test/helpers/stub-signin-podman.js), which keeps a volume as a directory.
 */
function withVolumes(/** @type {ReturnType<typeof signinBox>} */ b) {
  const podmanBin = path.join(b.dir, 'podman-volumes');
  writeFileSync(podmanBin, `#!/bin/sh
D='${b.dir}'
if [ "$1" = volume ]; then
  printf '%s\\n' "$*" >> "$D/podman.log"
  for last; do :; done
  case "$2" in
    ls) ls "$D/volumes" 2>/dev/null; exit 0 ;;
    exists) [ -d "$D/volumes/$last" ]; exit $? ;;
    rm) [ -e "$D/keep-volumes" ] && { echo 'Error: volume is being used' >&2; exit 2; }
        [ -d "$D/volumes/$last" ] || { echo "Error: no such volume $last" >&2; exit 1; }
        rm -rf "$D/volumes/$last"; exit 0 ;;
  esac
fi
exec "$D/podman" "$@"
`);
  chmodSync(podmanBin, 0o755);
  return podmanBin;
}

const ELI = { member: 'eli', account: 'eli@example.com', by: 'eli@example.com', box: 'ops-box' };

test('a person removed from the fleet has their engine sign-ins here stopped, dropped and removed with their engine home, and nobody else’s', async (t) => {
  const b = signinBox(t);
  const cfg = b.cfg({ podmanBin: withVolumes(b) });
  const signins = new EngineSignins(cfg);
  t.after(() => signins.close());
  const home = String(engineHomeVolume('eli@example.com'));
  // Eli is signed in to Copilot, has a Codex sign-in waiting for its code, and Debbie is signed in beside them.
  for (const who of [{ ...ELI, engine: 'opencode' }, { ...DEBBIE, engine: 'codex' }]) {
    await signins.ask({ ...who, action: 'start' });
    b.provider('approved');
    await until(async () => (await signins.ask({ ...who, action: 'status' })).state === 'signed_in', `${who.member} signed in`);
    b.set('provider-approved', false);
    await until(() => !b.running(`fw-signin-${who.engine}-${who.member}`), 'that container gone');
  }
  assert.equal((await signins.ask({ ...ELI, engine: 'codex', action: 'start' })).state, 'waiting');
  assert.ok(readFileSync(b.volume(home, 'opencode', 'auth.json'), 'utf8').includes(TOKEN));

  const sessions = { forgetOwner: () => [] };
  const forgot = await forgetPerson(cfg, sessions, 'Eli@Example.com', null, signins);
  assert.equal(forgot.ok, true);
  assert.deepEqual(forgot.forgot?.engines, { entries: 2, attempts: 1, removed: true });
  assert.equal(forgot.text, 'Forgot eli@example.com, who was removed from the fleet: 0 sessions stopped and put in the bin, an engine sign-in in their name that was waiting for a code stopped, the engines signed in for them here signed out by removing their engine home.');
  // The token is gone with the volume, the box reports only Debbie, and the attempt is not waiting.
  assert.equal(existsSync(b.volume(home)), false, 'their engine home is still on the box');
  assert.deepEqual(signins.report()?.map((e) => [e.member, e.engine, e.state]), [['debbie', 'codex', 'signed_in']]);
  assert.deepEqual([b.running('fw-signin-codex-eli'), signins.attempts.size], [false, 0]);
  assert.ok(readFileSync(b.volume('fw-engine-debbie', 'codex', 'auth.json'), 'utf8').includes(TOKEN), 'somebody else’s sign-in went with theirs');
  // A CODE APPROVED AFTER THEY HAD GONE signs nobody in: it used to, and was reported.
  b.provider('approved');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(existsSync(b.volume(home)), false);
  assert.deepEqual(signins.report()?.map((e) => e.member), ['debbie']);
  // ASKED AGAIN, there is nothing of theirs and it says so with a yes.
  const again = await forgetPerson(cfg, sessions, 'eli@example.com', null, signins);
  assert.deepEqual([again.ok, again.forgot?.engines], [true, { entries: 0, attempts: 0, removed: false }]);

  // A VOLUME PODMAN WILL NOT REMOVE is a sign-in of theirs still here: not a yes, so the coordinator asks again.
  await signins.ask({ ...ELI, engine: 'opencode', action: 'start' });
  await until(async () => (await signins.ask({ ...ELI, engine: 'opencode', action: 'status' })).state === 'signed_in', 'eli signed in again');
  b.set('keep-volumes');
  const stuck = await forgetPerson(cfg, sessions, 'eli@example.com', null, signins);
  assert.equal(stuck.ok, false);
  assert.match(stuck.text, /Their engine sign-ins on this box may still be here: the volume fw-engine-person\.[0-9a-f]{16} could not be removed \(Error: volume is being used\)\. Asked again, it is tried again\.$/);
  b.set('keep-volumes', false);
  assert.equal((await forgetPerson(cfg, sessions, 'eli@example.com', null, signins)).ok, true);
  assert.equal(existsSync(b.volume(home)), false);
  // An agent's account is nobody removed from the fleet, and is not forgotten this way.
  assert.deepEqual(await signins.forget('debbie@members.invalid'), { ok: true, entries: 0, attempts: 0, removed: false });
  assert.equal(existsSync(b.volume('fw-engine-debbie')), true);
});

test('a member the vault no longer lists is no longer reported, its attempt is stopped and its engine home removed; a list that says nothing removes nothing', async (t) => {
  assert.deepEqual(['fw-engine-debbie', 'fw-engine-person', `fw-engine-person.${ownerTag('eli@example.com')}`, 'cache-0123456789abcdef', 'fw-engine-', 'fw-engine-Debbie'].map(memberOfEngineHome), ['debbie', 'person', null, null, null, null]);
  const b = signinBox(t);
  const cfg = b.cfg({ podmanBin: withVolumes(b) });
  const signins = new EngineSignins(cfg);
  t.after(() => signins.close());
  const JASON = { ...DEBBIE, member: 'jason', account: 'jason@members.invalid' };
  // Debbie and Eli (a person, under their own record) are signed in; Jason's code is out;
  // Ada has a home a pasted sign-in was staged into, which this box recorded nothing of.
  for (const who of [{ ...DEBBIE, engine: 'codex' }, { ...ELI, engine: 'codex' }]) {
    await signins.ask({ ...who, action: 'start' });
    b.provider('approved');
    await until(async () => (await signins.ask({ ...who, action: 'status' })).state === 'signed_in', `${who.member} signed in`);
    b.set('provider-approved', false);
    await until(() => !b.running(`fw-signin-codex-${who.member}`), 'that container gone');
  }
  assert.equal((await signins.ask({ ...JASON, engine: 'codex', action: 'start' })).state, 'waiting');
  mkdirSync(b.volume('fw-engine-ada', 'codex'), { recursive: true });
  writeFileSync(b.volume('fw-engine-ada', 'codex', 'auth.json'), JSON.stringify({ tokens: { refresh_token: TOKEN } }));
  const eliHome = String(engineHomeVolume('eli@example.com'));
  const reported = () => signins.report()?.map((e) => e.member).sort();

  // WHAT IS NOT A LIST removes nothing: a caller that could not check one has nothing to say.
  for (const not of [null, undefined, 'debbie', [null], ['Debbie'], ['debbie', '../ada']]) {
    assert.deepEqual([(await signins.keepMembers(not)).ok, reported()], [false, ['debbie', 'eli', 'jason']], JSON.stringify(not));
  }
  // EVERYBODY STILL LISTED: nothing goes.
  const all = await signins.keepMembers(['ada', 'debbie', 'eli', 'jason', 'zed']);
  assert.deepEqual([all.ok, all.gone, all.text], [true, [], 'Every member this machine holds an engine sign-in for is still listed.']);
  assert.deepEqual([reported(), existsSync(b.volume('fw-engine-ada')), b.running('fw-signin-codex-jason')], [['debbie', 'eli', 'jason'], true, true]);

  // DEBBIE STAYS. Jason, Ada and Eli's record have left the list.
  const some = await signins.keepMembers(['debbie']);
  assert.deepEqual([some.ok, some.gone], [true, ['ada', 'eli', 'jason']]);
  assert.equal(some.text, 'Forgot the engine sign-ins of ada, eli, jason, no longer listed by the vault.');
  assert.deepEqual(reported(), ['debbie']);
  assert.deepEqual([b.running('fw-signin-codex-jason'), signins.attempts.size], [false, 0]);
  assert.deepEqual(['fw-engine-debbie', 'fw-engine-jason', 'fw-engine-ada'].map((v) => existsSync(b.volume(v))), [true, false, false]);
  // A PERSON'S HOME IS THEIRS while they are in the fleet, whatever became of a record of them.
  assert.ok(readFileSync(b.volume(eliHome, 'codex', 'auth.json'), 'utf8').includes(TOKEN));
  // A member filed again under an id that went starts with nothing of the last one's.
  assert.deepEqual([(await signins.ask({ ...JASON, engine: 'codex', action: 'status' })).state, (await signins.ask({ ...JASON, engine: 'codex', action: 'status' })).signedIn], ['none', null]);
});
