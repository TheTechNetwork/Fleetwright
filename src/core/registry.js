// Persistent record of every session the hub knows about, as one JSON file
// written atomically (temp + rename).
//
// Why not SQLite: the entire dataset is a few dozen small records that only
// this process writes. A JSON file keeps agent-hub at zero runtime
// dependencies and zero build step, which is the whole portability promise —
// a coworker clones the repo and runs it. If this ever needs concurrent
// writers or history, every access already goes through this module, so
// swapping the storage out is contained here.
//
// The record OUTLIVES the tmux session on purpose. tmux is the truth about
// what is running now; this file is the truth about what can be resumed. A
// stopped session keeps its conversation uuid and cwd so `/resume <name>`
// still works days and reboots later.

import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';

/**
 * @typedef {object} SessionRecord
 * @property {string} name
 * @property {string} cwd
 * @property {string|null} uuid           Claude conversation uuid, from the SessionStart hook
 * @property {'running'|'stopped'|'error'} status
 * @property {boolean} resumeOnBoot       ended without anyone asking → bring it back
 * @property {boolean|null} skipPermissions  per-session override; null = use the global setting
 * @property {string|null} title          what the session is about, for people; the name is the identity
 * @property {boolean} [titlePinned]      set by hand, so nothing derived overwrites it
 * @property {string|null} [brief]         a sentence of context, written by a person at start
 * @property {string|null} [account]       whose Claude account was seeded: an email, or "shared"
 * @property {string|null} detail         last human-readable outcome
 * @property {string|null} rcUrl          claude.ai/code URL, when Remote Control came online
 * @property {string|null} createdBy      e.g. "telegram:12345", "web", "cli"
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number|null} stoppedAt
 */

const VERSION = 1;

export class Registry {
  /** @param {{ stateFile: string, spoolFile: string }} opts */
  constructor({ stateFile, spoolFile }) {
    this.stateFile = stateFile;
    this.spoolFile = spoolFile;
    /** @type {Map<string, SessionRecord>} */
    this.sessions = new Map();
    this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      for (const rec of raw.sessions || []) {
        if (rec && typeof rec.name === 'string') this.sessions.set(rec.name, rec);
      }
      log.info(`registry: loaded ${this.sessions.size} session record(s) from ${this.stateFile}`);
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code === 'ENOENT') {
        log.info(`registry: no state at ${this.stateFile} — starting empty`);
      } else {
        // A corrupt state file must not stop the hub from running: the sessions
        // it describes may be long gone, but the box may have live tmux
        // sessions right now that reconcile() would otherwise never adopt.
        // Keep the bad file for forensics rather than overwriting it blind.
        log.error(`registry: ${this.stateFile} is unreadable (${err.message}) — starting empty`);
        try {
          renameSync(this.stateFile, `${this.stateFile}.corrupt-${Date.now()}`);
        } catch { /* best effort */ }
      }
    }
  }

  save() {
    const dir = path.dirname(this.stateFile);
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(
      { version: VERSION, savedAt: Date.now(), sessions: [...this.sessions.values()] },
      null,
      2,
    );
    // Temp + rename inside the same directory, so a reader never sees a
    // half-written file and a crash mid-write leaves the previous state intact.
    const tmp = `${this.stateFile}.tmp-${process.pid}`;
    writeFileSync(tmp, body);
    renameSync(tmp, this.stateFile);
  }

  /** @param {string} name */
  get(name) {
    return this.sessions.get(name) || null;
  }

  /** @returns {SessionRecord[]} newest first */
  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** @param {string} name @returns {boolean} */
  has(name) {
    return this.sessions.has(name);
  }

  /**
   * Create or update a record. Only the supplied fields change, so a partial
   * update (say, just the uuid arriving from the hook) never clobbers the rest.
   * @param {string} name
   * @param {Partial<SessionRecord>} patch
   * @returns {SessionRecord}
   */
  upsert(name, patch) {
    const now = Date.now();
    const existing = this.sessions.get(name);
    /** @type {SessionRecord} */
    const rec = existing
      ? { ...existing, ...patch, name, updatedAt: now }
      : {
          name,
          cwd: patch.cwd || process.cwd(),
          uuid: patch.uuid ?? null,
          status: patch.status || 'stopped',
          resumeOnBoot: patch.resumeOnBoot ?? false,
          skipPermissions: patch.skipPermissions ?? null,
          title: patch.title ?? null,
          brief: patch.brief ?? null,
          account: patch.account ?? null,
          detail: patch.detail ?? null,
          rcUrl: patch.rcUrl ?? null,
          createdBy: patch.createdBy ?? null,
          createdAt: now,
          updatedAt: now,
          stoppedAt: patch.stoppedAt ?? null,
        };
    this.sessions.set(name, rec);
    this.save();
    return rec;
  }

  /** @param {string} name */
  remove(name) {
    const had = this.sessions.delete(name);
    if (had) this.save();
    return had;
  }

  /** Drop every record that is not currently running. Returns how many went. */
  clearFinished() {
    let n = 0;
    for (const [name, rec] of this.sessions) {
      if (rec.status !== 'running') {
        this.sessions.delete(name);
        n++;
      }
    }
    if (n) this.save();
    return n;
  }

  // --- uuid spool ---------------------------------------------------------
  // The SessionStart hook posts each conversation uuid to the hub's HTTP port.
  // When that post fails (hub restarting, port changed, curl missing) the hook
  // appends "name<TAB>cwd<TAB>uuid" here instead. Draining it on every
  // reconcile means a restart window costs latency, never a lost uuid — and a
  // lost uuid means an unresumable session, which is the one failure this
  // whole tool exists to prevent.
  /** @returns {number} records applied */
  drainSpool() {
    if (!existsSync(this.spoolFile)) return 0;
    let text = '';
    try {
      text = readFileSync(this.spoolFile, 'utf8');
      unlinkSync(this.spoolFile);
    } catch (e) {
      log.warn(`registry: could not drain spool: ${/** @type {Error} */ (e).message}`);
      return 0;
    }
    let applied = 0;
    for (const line of text.split('\n')) {
      const [name, cwd, uuid] = line.split('\t');
      if (!name || !uuid) continue;
      this.upsert(name, { uuid, ...(cwd ? { cwd } : {}) });
      applied++;
      log.info(`registry: spooled uuid for ${name} → ${uuid}`);
    }
    return applied;
  }

  /**
   * Append to the spool. Used by the hook's fallback path via the CLI, and by
   * anything else that has a uuid but cannot reach the running hub.
   * @param {{ spoolFile: string }} cfg
   * @param {{ name: string, cwd: string, uuid: string }} rec
   */
  static appendSpool(cfg, rec) {
    mkdirSync(path.dirname(cfg.spoolFile), { recursive: true });
    appendFileSync(cfg.spoolFile, `${rec.name}\t${rec.cwd}\t${rec.uuid}\n`);
  }
}
