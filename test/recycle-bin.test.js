// Forgetting was the one action in this product with no undo.
//
// It killed the session, dropped the record and deleted both volumes — so a
// name typed one word wrong destroyed a conversation and a workspace, with
// nothing to try again. Every other mistake here is recoverable by repeating
// the command correctly.
//
// The bin is a record move plus NOT deleting the volumes. That second half is
// the feature and also the cost: a bin holds real bytes for real days, so the
// sweep has to actually run rather than be intended.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Registry } from '../src/core/registry.js';

const DAY = 86_400_000;
const TTL = 7 * DAY;

function registry() {
  const dir = mkdtempSync(join(tmpdir(), 'bin-'));
  const r = new Registry({ stateFile: join(dir, 'state.json'), spoolFile: join(dir, 'spool.jsonl') });
  r.upsert('bigjob', { cwd: '/work/bigjob', status: 'stopped', title: 'the payments migration', createdBy: 'fleet:me@example.com' });
  return r;
}

test('forgetting moves the record rather than destroying it', () => {
  const r = registry();
  const binned = r.bin_('bigjob');
  assert.ok(binned);
  assert.equal(r.get('bigjob'), null, 'gone from the live list');
  assert.ok(binned.deletedAt > 0);
  // Everything that made it resumable travels with it.
  assert.equal(binned.title, 'the payments migration');
  assert.equal(binned.cwd, '/work/bigjob');
  assert.equal(binned.createdBy, 'fleet:me@example.com');
});

test('restoring puts back exactly what was there', () => {
  const r = registry();
  const before = { ...r.get('bigjob') };
  r.bin_('bigjob');
  const after = r.unbin('bigjob');
  assert.ok(after);
  assert.equal('deletedAt' in after, false, 'a restored record is not still marked deleted');
  assert.deepEqual(after, before);
  assert.equal(r.bin.size, 0);
});

test('the bin survives a restart', () => {
  // The volumes outlive the process; a bin that did not would orphan them
  // silently — disk held for ever by a record nothing remembers.
  const dir = mkdtempSync(join(tmpdir(), 'bin-'));
  const file = join(dir, 'state.json');
  const first = new Registry({ stateFile: file, spoolFile: join(dir, 'spool.jsonl') });
  first.upsert('bigjob', { cwd: '/work/bigjob', status: 'stopped' });
  first.bin_('bigjob');

  const second = new Registry({ stateFile: file, spoolFile: join(dir, 'spool.jsonl') });
  assert.equal(second.bin.size, 1);
  assert.ok(second.bin.get('bigjob').deletedAt > 0);
  assert.equal(second.get('bigjob'), null);
});

test('a name in the bin is taken, because the volumes are keyed by name', () => {
  // `claude-<name>` for a binned session is the same volume a NEW session of
  // that name would be handed. Reusing it either resurrects somebody else's
  // conversation or destroys a recoverable one, depending on which way the
  // race falls — so the name is refused and both remedies are offered.
  const r = registry();
  r.bin_('bigjob');
  assert.equal(r.taken('bigjob'), true);
  assert.equal(r.has('bigjob'), false, 'has() is about live sessions and stays that way');
});

test('a stopped session’s name is taken too, for a new session started over it', async (t) => {
  // The same volumes, kept by a session that is only stopped. A start under
  // its name went on to launch over the old record: its account and its
  // volumes, with its creator rewritten to whoever pressed start, so through
  // the fleet one member took over another's session (a later audit). It is
  // refused and resume is offered. The cap is 0 so that a start let past the
  // check stops at the next refusal rather than launching anything.
  const { SessionManager } = await import('../src/core/sessions.js');
  const dir = mkdtempSync(join(tmpdir(), 'bin-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = new Registry({ stateFile: join(dir, 'state.json'), spoolFile: join(dir, 'spool.jsonl') });
  r.upsert('bigjob', { status: 'stopped', uuid: 'u-1', account: 'b@example.com', createdBy: 'fleet:b@example.com' });
  const sm = new SessionManager(/** @type {any} */ ({ stateDir: dir, workdir: dir, maxSessions: 0, binTtlMs: TTL }), r, null);
  sm.reconcile = () => {};

  const taken = await sm.start({ name: 'bigjob', actor: 'fleet:a@example.com' });
  assert.equal(taken.ok, false);
  assert.match(taken.message, /already exists on this box\. \/resume bigjob/, taken.message);
  assert.equal(r.get('bigjob')?.createdBy, 'fleet:b@example.com');

  // A retry of a start that failed before it had a conversation is the one
  // let through, and only for the person whose start it was.
  r.upsert('flaky', { status: 'error', createdBy: 'fleet:a@example.com' });
  assert.match((await sm.start({ name: 'flaky', actor: 'fleet:b@example.com' })).message, /already exists/);
  assert.match((await sm.start({ name: 'flaky', actor: 'fleet:a@example.com' })).message, /concurrency cap/);
});

test('what expires is what has outstayed the window, and nothing else', () => {
  const r = registry();
  r.upsert('fresh', { cwd: '/work/fresh', status: 'stopped' });
  r.upsert('stale', { cwd: '/work/stale', status: 'stopped' });
  r.bin_('fresh');
  r.bin_('stale');
  r.bin.get('stale').deletedAt = Date.now() - 8 * DAY;

  assert.deepEqual(r.expiredFromBin(TTL), ['stale']);
  // Exactly on the boundary counts as expired: a window that is "seven days
  // and a bit, depending" is a window nobody can reason about.
  r.bin.get('fresh').deletedAt = Date.now() - TTL;
  assert.deepEqual(r.expiredFromBin(TTL).sort(), ['fresh', 'stale']);
});

test('the bin lists soonest-to-go first, with the deadline computed', () => {
  const r = registry();
  r.upsert('later', { cwd: '/w', status: 'stopped' });
  r.bin_('bigjob');
  r.bin_('later');
  r.bin.get('bigjob').deletedAt = Date.now() - 6 * DAY; // one day left
  r.bin.get('later').deletedAt = Date.now(); // seven

  const listed = r.binned(TTL);
  assert.deepEqual(listed.map((b) => b.name), ['bigjob', 'later']);
  // expiresAt is computed here rather than in each client, so two surfaces
  // cannot disagree about when something goes.
  assert.equal(listed[0].expiresAt, listed[0].deletedAt + TTL);
});

test('purging a binned session takes the record with it', () => {
  const r = registry();
  r.bin_('bigjob');
  assert.equal(r.dropBinned('bigjob'), true);
  assert.equal(r.dropBinned('bigjob'), false, 'and says so the second time');
  assert.equal(r.taken('bigjob'), false);
});

test('a state file from before the bin loads cleanly', () => {
  // The field is absent in anything an older build wrote, and absent is
  // exactly right: nothing was ever binned, so the bin is empty.
  const dir = mkdtempSync(join(tmpdir(), 'bin-'));
  const file = join(dir, 'state.json');
  const old = new Registry({ stateFile: file, spoolFile: join(dir, 'spool.jsonl') });
  old.upsert('bigjob', { cwd: '/w', status: 'stopped' });
  // Rewrite without the key, as the previous version of save() did.
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  delete raw.bin;
  writeFileSync(file, JSON.stringify(raw));

  const loaded = new Registry({ stateFile: file, spoolFile: join(dir, 'spool.jsonl') });
  assert.equal(loaded.bin.size, 0);
  assert.ok(loaded.get('bigjob'));
});
