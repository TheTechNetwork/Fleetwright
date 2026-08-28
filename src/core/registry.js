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
    /**
     * Forgotten, but not yet gone.
     *
     * `/forget` was the only action in this product with no undo: it killed
     * the session, dropped the record and deleted both volumes, so a name
     * typed one word wrong destroyed a conversation and a workspace with no
     * way back. Everything else here is recoverable by trying again.
     *
     * A binned record is the same SessionRecord with `deletedAt` on it. The
     * VOLUMES ARE LEFT ON DISK — that is the whole feature, and it is also the
     * cost: a bin holds real bytes for real days. sweepBin() is what makes
     * that bounded, and it has to actually run rather than be intended.
     * @type {Map<string, SessionRecord & { deletedAt: number }>}
     */
    this.bin = new Map();
    this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      for (const rec of raw.sessions || []) {
        if (rec && typeof rec.name === 'string') this.sessions.set(rec.name, rec);
      }
      // Absent in a file written by an older build, which is exactly right:
      // nothing was ever binned, so the bin is empty.
      for (const rec of raw.bin || []) {
        if (rec && typeof rec.name === 'string') this.bin.set(rec.name, rec);
      }
      log.info(
        `registry: loaded ${this.sessions.size} session record(s)` +
          `${this.bin.size ? ` and ${this.bin.size} in the bin` : ''} from ${this.stateFile}`,
      );
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
      { version: VERSION, savedAt: Date.now(), sessions: [...this.sessions.values()], bin: [...this.bin.values()] },
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

  /**
   * Move a record to the bin rather than deleting it.
   *
   * @param {string} name
   * @returns {(SessionRecord & { deletedAt: number })|null}
   */
  bin_(name) {
    const rec = this.sessions.get(name);
    if (!rec) return null;
    const binned = { ...rec, deletedAt: Date.now() };
    this.sessions.delete(name);
    // A name can only be in one place. Binning over an existing binned record
    // of the same name replaces it — the volumes are keyed by NAME, so there
    // was only ever one copy of the data to point at anyway.
    this.bin.set(name, binned);
    this.save();
    return binned;
  }

  /**
   * Take it back out. Returns the restored record, or null.
   * @param {string} name
   */
  unbin(name) {
    const rec = this.bin.get(name);
    if (!rec) return null;
    const { deletedAt, ...restored } = rec;
    void deletedAt;
    this.bin.delete(name);
    this.sessions.set(name, /** @type {SessionRecord} */ (restored));
    this.save();
    return restored;
  }

  /** Drop a binned record without restoring it. @param {string} name */
  dropBinned(name) {
    const had = this.bin.delete(name);
    if (had) this.save();
    return had;
  }

  /**
   * What is in the bin, soonest to expire first.
   * @param {number} ttlMs
   */
  binned(ttlMs) {
    return [...this.bin.values()]
      .map((rec) => ({ ...rec, expiresAt: rec.deletedAt + ttlMs }))
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }

  /**
   * Everything whose time is up.
   *
   * Returns the names rather than deleting anything itself: the volumes belong
   * to sessions.js, and a registry that shells out to podman is a registry
   * that cannot be tested without it.
   *
   * @param {number} ttlMs
   * @param {number} [now]
   */
  expiredFromBin(ttlMs, now = Date.now()) {
    return [...this.bin.values()].filter((rec) => now - rec.deletedAt >= ttlMs).map((rec) => rec.name);
  }

  /** Is this name spoken for, in either place? @param {string} name */
  taken(name) {
    return this.sessions.has(name) || this.bin.has(name);
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
