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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import path from 'node:path';

import { EngineSignins, containerFor } from '../src/core/engine-signin.js';
import { engineHomeVolume, engineHomeArgs, ENGINE_HOME } from '../src/core/engine-home.js';
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
  assert.deepEqual(JSON.parse(b.kept()).signins['debbie/codex'], { member: 'debbie', engine: 'codex', signedIn: null, last: null, attempt: { startedAt: waiting.startedAt, by: 'eli@example.com' } });
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
    assert.ok(!text.includes('ABCD-EFGH') && !text.includes('auth.openai.com'), `the code or its page is in ${where}`);
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

  // THE ENGINE REFUSES IT, quoting a token from the sign-in that is there.
  const b2 = box(t);
  mkdirSync(b2.volume('fw-engine-debbie', 'codex'), { recursive: true });
  writeFileSync(b2.volume('fw-engine-debbie', 'codex', 'auth.json'), JSON.stringify({ tokens: { refresh_token: TOKEN } }));
  await b2.ask('start');
  b2.provider('refused', `device code exchange failed: token ${TOKEN} is not for this workspace`);
  await until(async () => (await b2.ask('status')).state === 'failed', 'the refusal');
  const failed = await b2.ask('status');
  assert.equal(failed.detail, 'device code exchange failed: token [withheld] is not for this workspace');
  assert.equal(failed.text, 'Codex was not signed in for debbie on ops-box: device code exchange failed: token [withheld] is not for this workspace.');
  for (const [where, text] of [['an answer', JSON.stringify([...b.answers, ...b2.answers])], ['a state file', b.kept() + b2.kept()], ['a log line', said()]]) {
    assert.ok(!text.includes('LEAKCANARY'), `a token is in ${where}`);
  }
});

test('an account with device code turned off is refused as that at the start, in Codex’s words, with nothing left waiting', async (t) => {
  const b = box(t);
  b.set('codex-off');
  const r = await b.ask('start');
  assert.deepEqual([r.ok, r.error?.code, r.state], [false, 'device_code_off', 'failed']);
  assert.equal(r.text, 'Codex says device code sign-in is not turned on for this account or its workspace, in its words: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.. Turn it on there, or paste a sign-in instead.');
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

test('a hub that restarts under a waiting attempt says it is lost, never that it is waiting, and ends its container', async (t) => {
  const b = box(t);
  assert.equal((await hubThatDies(b)).state, 'waiting');
  assert.equal(b.running('fw-signin-codex-debbie'), true, 'the container outlives the hub that started it');
  // The hub that comes up in its place: asked, it says what it knows.
  const after = await b.ask('status');
  assert.deepEqual([after.state, after.url, after.code], ['lost', undefined, undefined]);
  assert.equal(after.text, 'ops-box restarted while a Codex sign-in for debbie was waiting, so that attempt is gone. Start again for a new code.');
  await until(() => !b.running('fw-signin-codex-debbie'), 'the container nobody is listening to, ended');
  // What nobody could see does not go on to sign in.
  b.provider('approved');
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(existsSync(b.volume('fw-engine-debbie', 'codex', 'auth.json')), false);
  assert.deepEqual(b.signins.report().map((r) => [r.state, r.since]), [['lost', null]]);

  // FOUND AS THE HUB COMES UP, before anybody asks.
  const b2 = box(t);
  await hubThatDies(b2);
  b2.signins.recover();
  assert.deepEqual(b2.signins.report().map((r) => r.state), ['lost']);
  await until(() => !b2.running('fw-signin-codex-debbie'), 'that container ended too');
  // AND A HUB THAT STOPS IN GOOD ORDER ends what is waiting itself, as lost and not as cancelled: nobody cancelled it.
  const b3 = box(t);
  await b3.ask('start');
  await b3.signins.close();
  assert.equal((await b3.ask('status')).state, 'lost');
  assert.equal(b3.running('fw-signin-codex-debbie'), false);
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
  const out = await b.ask('signout');
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
  const sessions = /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] });
  const token = ensureApiToken(cfg);
  const adapter = new HttpAdapter(cfg, { sessions, login: /** @type {any} */ ({ status: () => ({ loggedIn: true }), isPending: () => false, pending: null }), token });
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
});

test('the sidecar asks its hub on a route of its own, says so when the hub is older, reports only who is signed in, and says when an attempt ends', async (t) => {
  // An older hub has no such route.
  const old = await startStubHub({ host: 'ops-box', without: ['/api/engine-signin'] });
  t.after(() => old.close());
  assert.deepEqual(await new HubClient({ baseUrl: old.baseUrl, token: null }).engineSignin({ ...DEBBIE, engine: 'codex', action: 'start' }), { ok: false, error: { code: 'hub_outdated' }, text: 'fleetwright here is older than signing an engine in; update it' });

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
  // THE FRAME: who is signed in now, by id, engine and since when. An attempt that expired leaves the sign-in before it.
  assert.deepEqual((await sidecar.health()).engineSignins, [{ member: 'debbie', engine: 'codex', since: at }, { member: 'ada', engine: 'opencode', since: at - 1000 }]);

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

test('the name a sign-in’s container runs under is its engine and its member, which a member’s id cannot break out of', () => {
  assert.equal(containerFor('debbie', 'codex'), 'fw-signin-codex-debbie');
});
