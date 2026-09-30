// How much of each linked account's limit is used, read from the endpoint
// Claude Code's own /usage reads — on exactly the terms src/core/usage.js sets
// out: the shape it answered with is what is read, and anything else is
// CANNOT TELL with a reason.
//
//   node --test test/usage.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normaliseUsage, accessTokenFrom, readUsage, UsageMonitor, USAGE_URL } from '../src/core/usage.js';
import { Accounts } from '../src/core/accounts.js';

const ANSWER = {
  five_hour: { utilization: 42, resets_at: '2026-09-30T05:00:00.000Z' },
  seven_day: { utilization: 12.5, resets_at: '2026-10-03T00:00:00.000Z' },
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 0, resets_at: null },
  extra_usage: { something: 'this does not read' },
};

/** @param {number} status @param {unknown} body */
function answering(status, body, calls = /** @type {any[]} */ ([])) {
  return async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === 'not json') throw new SyntaxError('nope');
        return body;
      },
    };
  };
}

// --- the shape ----------------------------------------------------------------

test('the four windows are read as percent used and a reset time in epoch ms', () => {
  const u = normaliseUsage(ANSWER);
  assert.deepEqual(u?.fiveHour, { used: 42, resetsAt: Date.parse('2026-09-30T05:00:00.000Z') });
  assert.deepEqual(u?.sevenDay, { used: 12.5, resetsAt: Date.parse('2026-10-03T00:00:00.000Z') });
  assert.equal(u?.sevenDayOpus, null, 'the endpoint said null, so does this');
  assert.deepEqual(u?.sevenDaySonnet, { used: 0, resetsAt: null }, 'zero used is a number, not nothing');
});

test('a shape with none of the windows is null, so a wrong guess is never drawn as a number', () => {
  assert.equal(normaliseUsage({}), null);
  assert.equal(normaliseUsage({ five_hour: { pct: 40 } }), null, 'a window with neither field is not understood');
  assert.equal(normaliseUsage({ limits: [{ percent: 54 }] }), null);
  assert.equal(normaliseUsage(null), null);
  assert.equal(normaliseUsage([ANSWER]), null);
  assert.equal(normaliseUsage('42%'), null);
});

test('a reset given as epoch seconds is read as such; an unparseable one is null', () => {
  assert.equal(normaliseUsage({ five_hour: { utilization: 1, resets_at: 1_800_000_000 } })?.fiveHour?.resetsAt, 1_800_000_000_000);
  assert.equal(normaliseUsage({ five_hour: { utilization: 1, resets_at: 'soon' } })?.fiveHour?.resetsAt, null);
});

// --- the token --------------------------------------------------------------------

test('the access token is read from either shape the CLI has written, and never invented', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const nested = path.join(dir, 'nested.json');
  writeFileSync(nested, JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-nested', refreshToken: 'r', expiresAt: 1 } }));
  const flat = path.join(dir, 'flat.json');
  writeFileSync(flat, JSON.stringify({ accessToken: 'sk-ant-oat01-flat', expiresAt: 1 }));
  const empty = path.join(dir, 'empty.json');
  writeFileSync(empty, JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } }));
  const junk = path.join(dir, 'junk.json');
  writeFileSync(junk, 'not json');

  assert.equal(accessTokenFrom(nested), 'sk-ant-oat01-nested');
  assert.equal(accessTokenFrom(flat), 'sk-ant-oat01-flat');
  assert.equal(accessTokenFrom(empty), null);
  assert.equal(accessTokenFrom(junk), null);
  assert.equal(accessTokenFrom(path.join(dir, 'missing.json')), null);
  assert.equal(accessTokenFrom(null), null);
});

// --- the request -------------------------------------------------------------------

test('the endpoint is asked the way the CLI asks it, and a good answer is normalised', async () => {
  const calls = /** @type {any[]} */ ([]);
  const r = await readUsage('sk-ant-oat01-x', { fetch: answering(200, ANSWER, calls) });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.usage.fiveHour?.used, 42);
  assert.equal(calls[0].url, USAGE_URL);
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-ant-oat01-x');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(calls[0].init.method, 'GET');
});

test('a refused token, a server error, a non-JSON answer and an unfamiliar shape each say why', async () => {
  const refused = await readUsage('t', { fetch: answering(401, {}) });
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.why : '', /token was refused \(HTTP 401\)/);

  const down = await readUsage('t', { fetch: answering(503, {}) });
  assert.match(!down.ok ? down.why : '', /HTTP 503/);

  const html = await readUsage('t', { fetch: answering(200, 'not json') });
  assert.match(!html.ok ? html.why : '', /did not answer with JSON/);

  const odd = await readUsage('t', { fetch: answering(200, { limits: [], extra_usage: {} }) });
  assert.equal(odd.ok, false);
  assert.match(!odd.ok ? odd.why : '', /shape this version does not read \(limits, extra_usage\)/, 'the keys, so the mismatch can be diagnosed from a log');

  const unreachable = await readUsage('t', { fetch: async () => { throw new TypeError('fetch failed'); } });
  assert.match(!unreachable.ok ? unreachable.why : '', /could not reach.*fetch failed/);
});

// --- the monitor ---------------------------------------------------------------------

/** @param {import('node:test').TestContext} t */
function linked(t) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'usage-mon-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  mkdirSync(path.join(stateDir, 'accounts'), { recursive: true });
  const accounts = new Accounts(stateDir);
  const now = Date.parse('2026-09-30T03:00:00Z');
  accounts.save('fresh@example.com', JSON.stringify({ claudeAiOauth: { accessToken: 'tok-fresh', refreshToken: 'r', expiresAt: now + 3_600_000 } }));
  accounts.save('stale@example.com', JSON.stringify({ claudeAiOauth: { accessToken: 'tok-stale', refreshToken: 'r', expiresAt: now - 1 } }));
  accounts.save('bare@example.com', JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt: now + 3_600_000 } }));
  return { stateDir, accounts, now };
}

test('before the first refresh the snapshot is null — cannot tell, not "no accounts"', (t) => {
  const { stateDir } = linked(t);
  const mon = new UsageMonitor(/** @type {any} */ ({ stateDir }), { fetch: answering(200, ANSWER), log: { info() {}, warn() {} } });
  assert.equal(mon.snapshot(), null);
});

test('one row per linked account: an answer, or the reason there is none', async (t) => {
  const { stateDir, now } = linked(t);
  const calls = /** @type {any[]} */ ([]);
  const mon = new UsageMonitor(/** @type {any} */ ({ stateDir }), { fetch: answering(200, ANSWER, calls), now: () => now, log: { info() {}, warn() {} } });

  const snap = await mon.refresh();

  assert.equal(snap.checkedAt, now);
  assert.deepEqual(snap.accounts.map((a) => a.account), ['bare@example.com', 'fresh@example.com', 'stale@example.com']);
  const by = Object.fromEntries(snap.accounts.map((a) => [a.account, a]));
  assert.equal(by['fresh@example.com'].usage?.fiveHour?.used, 42);
  assert.equal(by['fresh@example.com'].why, null);
  assert.equal(by['stale@example.com'].usage, null);
  assert.match(by['stale@example.com'].why ?? '', /expired and has not renewed/);
  assert.equal(by['bare@example.com'].usage, null);
  assert.match(by['bare@example.com'].why ?? '', /no access token/);
  // Only the account that could be asked was asked, with its own token.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok-fresh');
  assert.equal(mon.snapshot(), snap);
});

test('an endpoint that refuses does not take the other accounts down with it', async (t) => {
  const { stateDir, accounts, now } = linked(t);
  accounts.save('other@example.com', JSON.stringify({ claudeAiOauth: { accessToken: 'tok-other', refreshToken: 'r', expiresAt: now + 3_600_000 } }));
  const fetch = async (/** @type {string} */ _url, /** @type {any} */ init) =>
    init.headers.authorization === 'Bearer tok-other'
      ? { ok: false, status: 401, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ANSWER };
  const mon = new UsageMonitor(/** @type {any} */ ({ stateDir }), { fetch, now: () => now, log: { info() {}, warn() {} } });

  const snap = await mon.refresh();
  const by = Object.fromEntries(snap.accounts.map((a) => [a.account, a]));
  assert.equal(by['fresh@example.com'].usage?.sevenDay?.used, 12.5);
  assert.match(by['other@example.com'].why ?? '', /refused \(HTTP 401\)/);
});

test('nobody linked is an empty list with a time, which is an answer', async (t) => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'usage-none-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const mon = new UsageMonitor(/** @type {any} */ ({ stateDir }), { fetch: answering(200, ANSWER), log: { info() {}, warn() {} } });
  const snap = await mon.refresh();
  assert.deepEqual(snap.accounts, []);
  assert.equal(typeof snap.checkedAt, 'number');
});
