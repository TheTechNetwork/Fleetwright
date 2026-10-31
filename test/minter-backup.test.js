// The minter's keys and rows, kept a second time outside its Durable Object.
//
//   node --test test/minter-backup.test.js
//
// Everything a person keeps sits in one object, sealed to a key that object
// made and keeps beside it. These are the ways back when it is lost: the keys
// from Secrets Store, the rows from a sealed copy in R2, and the one-time
// export that gets the keys out to put them there (src/fleet/minter/backup.js,
// scripts/minter-key-export.mjs). Secrets Store and R2 are stood in for by
// what their bindings answer; the export is fetched over loopback by the
// script an operator runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import minterWorker, { ClaudeLogins, KEY_PATH, EXPORT_HEADER } from '../worker/src/minter.js';
import { newDepositKey, importDepositKey, open, MINTER_EXPORT_AAD } from '../src/fleet/seal.js';
import { backupPrefix, snapshot, BACKUP_KEPT_DAYS } from '../src/fleet/minter/backup.js';

/** A Durable Object's storage, as much of it as the object uses. */
function storage() {
  const rows = new Map();
  let alarm = /** @type {number|null} */ (null);
  /** Puts left before the next one throws, as an object stopped part way would. @type {{ left: number }} */
  const failAfter = { left: Infinity };
  return {
    rows,
    failAfter,
    alarmAt: () => alarm,
    clearAlarm: () => { alarm = null; },
    get: async (/** @type {string} */ k) => rows.get(k),
    put: async (/** @type {string} */ k, /** @type {any} */ v) => {
      if (failAfter.left-- <= 0) throw new Error('storage went away');
      rows.set(k, structuredClone(v));
    },
    delete: async (/** @type {string} */ k) => rows.delete(k),
    list: async (/** @type {{ prefix?: string, limit?: number }} */ o = {}) =>
      new Map([...rows.entries()].filter(([k]) => k.startsWith(o.prefix ?? '')).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, o.limit ?? Infinity)),
    getAlarm: async () => alarm,
    setAlarm: async (/** @type {number} */ t) => { alarm = t; },
  };
}

/** An R2 bucket binding, as much of it as the object uses. */
function bucket() {
  const objects = new Map();
  return {
    objects,
    put: async (/** @type {string} */ k, /** @type {string} */ v) => { objects.set(k, v); },
    get: async (/** @type {string} */ k) => (objects.has(k) ? { text: async () => objects.get(k) } : null),
    list: async (/** @type {{ prefix: string }} */ o) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(o.prefix)).map((key) => ({ key })) }),
    delete: async (/** @type {string|string[]} */ k) => { for (const one of [k].flat()) objects.delete(one); },
  };
}

/** A Secrets Store binding holding `value`. @param {string} value */
const stored = (value) => ({ get: async () => value });

/** A minter Worker over this object. @param {Record<string, any>} env @param {ReturnType<typeof storage>} store */
function minter(env, store) {
  const instance = new ClaudeLogins({ storage: store }, env);
  env.LOGINS = { idFromName: () => 'logins', get: () => ({ fetch: (/** @type {string} */ u, /** @type {any} */ i) => instance.fetch(new Request(u, i)) }) };
  /** @param {string} op @param {unknown} [body] */
  const op = async (op, body = {}) => /** @type {any} */ (await (await instance.fetch(new Request(`https://logins.internal/${op}`, { method: 'POST', body: JSON.stringify(body) }))).json());
  return { instance, op, lookup: async (/** @type {Record<string, string>} */ headers = {}) => minterWorker.fetch(new Request(`https://fleet.test${KEY_PATH}`, { headers }), env) };
}

test('a minter that lost its object takes its keys back from Secrets Store and its rows from R2', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const restored = t.mock.method(console, 'log', () => {});
  const r2 = bucket();
  const exportTo = await newDepositKey();
  const before = storage();
  const a = minter({ BACKUP: r2, FLEETWRIGHT_MINTER_EXPORT_TO: exportTo.publicKey }, before);
  const keyA = (await a.op('deposit-key')).secret;
  const signingA = (await a.op('signing-key')).key;
  // THE NAME IS LONG ON PURPOSE. The copy is checked below for not containing
  // it, and the copy is base64 of ciphertext: three letters turn up in a few
  // hundred random base64 characters about once in a thousand runs, which is
  // how a lane went red for a row it had sealed correctly.
  const login = 'eli-whose-name-must-stay-sealed-in-the-copy';
  const row = { at: 1, login, kind: 'login', sealed: { epk: 'e', iv: 'i', ct: 'c' } };
  assert.equal((await a.op('put', { id: '42', row })).ok, true);
  assert.ok(before.alarmAt(), 'a change asks for a copy in a few minutes');

  // THE COPY: every row but the keys, sealed to the deposit key.
  await a.instance.alarm();
  const prefix = await backupPrefix((await importDepositKey(keyA)).publicKey);
  const copy = r2.objects.get(`${prefix}latest.json`);
  assert.ok(copy, 'filed under the deposit key it is sealed to');
  assert.ok(r2.objects.has(`${prefix}${new Date().toISOString().slice(0, 10)}.json`), 'and as the day’s');
  assert.ok(!copy.includes(login) && !copy.includes(JSON.parse(keyA).d), 'nothing in it readable, and no key');

  // THE EXPORT: the keys, sealed to the operator's key, asked for by header
  // at the public address; without the header, the public halves as ever.
  assert.equal((/** @type {any} */ (await (await a.lookup()).json())).key, (await importDepositKey(keyA)).publicKey);
  const res = await a.lookup({ [EXPORT_HEADER]: 'keys' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  /** @type {any} */
  const said = await res.json();
  const opened = await open({ ...(await importDepositKey(exportTo.secret)), aad: MINTER_EXPORT_AAD, sealed: said.sealed });
  assert.equal(opened.depositKey, keyA);
  assert.equal(opened.signingKey.d, before.rows.get('signing:key').d);
  const stranger = await newDepositKey();
  await assert.rejects(open({ ...(await importDepositKey(stranger.secret)), aad: MINTER_EXPORT_AAD, sealed: said.sealed }), 'opens for nobody else');

  // LOST, and started again on empty storage with the keys in Secrets Store.
  const after = storage();
  const b = minter({ BACKUP: r2, DEPOSIT_KEY_STORED: stored(opened.depositKey), SIGNING_KEY_STORED: stored(JSON.stringify(opened.signingKey)) }, after);
  assert.deepEqual((await b.op('get', { id: '42' })).row, row, 'the rows came back');
  assert.equal((await b.op('deposit-key')).secret, keyA, 'and the key every vault is sealed to');
  assert.deepEqual((await b.op('signing-key')).key, signingA, 'and the key every box pinned');
  assert.match(String(restored.mock.calls.at(-1)?.arguments[0]), /filled from the copy made at .*: 1 row\./);
});

test('a minter with no key kept outside starts empty and leaves the old copies alone', async (t) => {
  const r2 = bucket();
  const old = await newDepositKey();
  const oldPrefix = await backupPrefix(old.publicKey);
  r2.objects.set(`${oldPrefix}latest.json`, 'the copy of a key this object no longer has');
  const warned = t.mock.method(console, 'warn', () => {});
  const store = storage();
  const m = minter({ BACKUP: r2 }, store);
  assert.equal((await m.op('get', { id: '42' })).row, null);
  assert.equal(warned.mock.callCount(), 1);
  await m.instance.alarm();
  assert.equal(r2.objects.get(`${oldPrefix}latest.json`), 'the copy of a key this object no longer has', 'not written over');
  assert.equal([...r2.objects.keys()].filter((k) => k.endsWith('latest.json')).length, 2, 'its own copy is filed beside it');
});

test('the key an object holds wins over another in Secrets Store, and one bound but unreadable makes no new key', async (t) => {
  const errors = t.mock.method(console, 'error', () => {});
  const store = storage();
  const held = await newDepositKey();
  store.rows.set('deposit:key', held.secret);
  const other = await newDepositKey();
  const m = minter({ DEPOSIT_KEY_STORED: stored(other.secret) }, store);
  assert.equal((await m.op('deposit-key')).secret, held.secret);
  await new Promise((r) => setImmediate(r));
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /not the one this minter holds; the one it holds is used/);

  // EMPTY, and the store cannot be read: refused, rather than a new key made
  // over the one sitting there unread.
  const empty = storage();
  const broken = minter({ DEPOSIT_KEY_STORED: { get: async () => { throw new Error('store unreachable'); } } }, empty);
  await assert.rejects(broken.op('deposit-key'), /store unreachable/);
  assert.equal(empty.rows.has('deposit:key'), false);
});

test('a copy that is there and will not open stops the object, and writes nothing into it', async () => {
  const r2 = bucket();
  const key = await newDepositKey();
  r2.objects.set(`${await backupPrefix(key.publicKey)}latest.json`, JSON.stringify({ v: 1, depositPublic: key.publicKey, sealed: { epk: 'x', iv: 'y', ct: 'z' } }));
  const store = storage();
  const m = minter({ BACKUP: r2, DEPOSIT_KEY_STORED: stored(key.secret) }, store);
  const said = await m.op('get', { id: '42' });
  assert.equal(said.error?.code, 'restore_failed');
  assert.match(said.text, /answers nothing until it can/);
  assert.equal(store.rows.size, 0);
});

test('the keys are exported only while the operator names a key, and only by GET', async () => {
  const quiet = minter({}, storage());
  assert.equal((await quiet.lookup({ [EXPORT_HEADER]: 'keys' })).status, 404, 'no key named, no export');
  const env = /** @type {Record<string, any>} */ ({ FLEETWRIGHT_MINTER_EXPORT_TO: (await newDepositKey()).publicKey });
  minter(env, storage());
  const head = await minterWorker.fetch(new Request(`https://fleet.test${KEY_PATH}`, { method: 'HEAD', headers: { [EXPORT_HEADER]: 'keys' } }), env);
  assert.equal(head.status, 404);
  const get = await minterWorker.fetch(new Request(`https://fleet.test${KEY_PATH}`, { headers: { [EXPORT_HEADER]: 'keys' } }), env);
  assert.equal(get.status, 200);
});

test('dated copies past their days are dropped, and the latest kept', async () => {
  const r2 = bucket();
  const key = await newDepositKey();
  const prefix = await backupPrefix(key.publicKey);
  const now = Date.parse('2026-10-25T12:00:00Z');
  r2.objects.set(`${prefix}2026-09-01.json`, 'old');
  r2.objects.set(`${prefix}${new Date(now - (BACKUP_KEPT_DAYS - 1) * 86_400_000).toISOString().slice(0, 10)}.json`, 'recent');
  await snapshot(/** @type {any} */ (r2), new Map([['gh:42', { at: 1 }], ['deposit:key', 'secret']]), ['deposit:key'], key, now);
  assert.deepEqual([...r2.objects.keys()].sort(), [`${prefix}2026-09-26.json`, `${prefix}2026-10-25.json`, `${prefix}latest.json`]);
});

test('the operator’s script takes the keys out through the public address, sealed, and writes them for them alone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'minter-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = promisify(execFile);
  const made = await run(process.execPath, ['scripts/minter-key-export.mjs', 'new', dir]);
  const exportTo = /'([A-Za-z0-9_-]{87})'/.exec(made.stdout)?.[1];
  assert.ok(exportTo, made.stdout);
  assert.equal(statSync(join(dir, 'export-key.json')).mode & 0o777, 0o600);

  const store = storage();
  const env = /** @type {Record<string, any>} */ ({ FLEETWRIGHT_MINTER_EXPORT_TO: exportTo });
  const m = minter(env, store);
  const deposit = (await m.op('deposit-key')).secret;
  const server = createServer(async (req, res) => {
    const answer = await minterWorker.fetch(new Request(`https://fleet.test${req.url}`, { headers: /** @type {any} */ (req.headers) }), env);
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(await answer.text());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  t.after(() => server.close());
  const port = /** @type {any} */ (server.address()).port;
  const got = await run(process.execPath, ['scripts/minter-key-export.mjs', 'open', `http://127.0.0.1:${port}`, dir], { env: { ...process.env, HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '' } });
  assert.match(got.stdout, /secrets-store secret create <store-id> --name fleetwright-minter-deposit-key --scopes workers --remote/);
  assert.equal(readFileSync(join(dir, 'deposit-key.json'), 'utf8').trim(), deposit);
  assert.equal(JSON.parse(readFileSync(join(dir, 'signing-key.json'), 'utf8')).d, store.rows.get('signing:key').d);
  for (const f of ['deposit-key.json', 'signing-key.json']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
});

test('a restore cut off part way is finished at the next ask, not left holding some of the rows', async (t) => {
  t.mock.method(console, 'log', () => {});
  const r2 = bucket();
  const key = await newDepositKey();
  const rows = new Map([['gh:1', { at: 1 }], ['gh:2', { at: 2 }], ['gh:3', { at: 3 }]]);
  await snapshot(/** @type {any} */ (r2), rows, [], await importDepositKey(key.secret), Date.now());
  const store = storage();
  const m = minter({ BACKUP: r2, DEPOSIT_KEY_STORED: stored(key.secret) }, store);
  // STOPPED after the marker and one row.
  store.failAfter.left = 2;
  assert.equal((await m.op('get', { id: '3' })).error?.code, 'restore_failed');
  assert.ok(store.rows.size > 0 && store.rows.size < 4, 'part way: not empty, not full');
  store.failAfter.left = Infinity;
  assert.deepEqual((await m.op('get', { id: '3' })).row, { at: 3 }, 'the rest came back at the next ask');
  for (const id of ['1', '2']) assert.deepEqual((await m.op('get', { id })).row, { at: Number(id) });
  assert.equal(store.rows.has('restore:pending'), false);
});

test('a copy is asked for after a write, and a read asks for none', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const store = storage();
  const m = minter({ BACKUP: bucket() }, store);
  await m.op('signing-key');
  await m.op('put', { id: '42', row: { at: 1 } });
  assert.ok(store.alarmAt(), 'a write asks for a copy');
  await m.instance.alarm();
  store.clearAlarm();
  assert.deepEqual((await m.op('get', { id: '42' })).row, { at: 1 });
  await m.op('signing-key');
  await m.op('deposit-key');
  assert.equal(store.alarmAt(), null, 'reads after the copy ask for nothing');
});
