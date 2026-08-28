// The session manager. Every surface — Telegram, the web UI, the CLI — goes
// through this one object, so they can never disagree about what a "start"
// means.
//
// The single biggest simplification over the two-plane design this was
// extracted from: the process that decides and the process that acts are the
// SAME process. There is no request queue, no status handshake, no heartbeat
// protocol and no stale-row reaper, because there are no two planes that can
// drift apart. tmux is asked directly, every time.

import { hasSession, listSessions, newSession, killSession, capturePane } from './tmux.js';
import {
  buildCommand,
  verifyRemoteControl,
  dismissResumeDialogs,
  waitForResumeDialog,
  readResumeDialog,
  answerResumeDialog,
  RESUME_REQUIRES_UUID,
} from './claude.js';
import { isValidName, nameError, generateName } from './names.js';
import { titleFromCwd, cleanTitle } from './titles.js';
import { ensureWorkdirTrusted, trustDirectory, resolveWorkdir } from './trust.js';
import { ensureSandboxVolumes, removeSandboxVolumes, stopSandboxContainer } from './podman.js';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';

/**
 * @typedef {object} Result
 * @property {boolean} ok
 * @property {string} message
 * @property {import('./registry.js').SessionRecord} [session]
 */

export class SessionManager {
  /**
   * @param {import('../config.js').Config} cfg
   * @param {import('./registry.js').Registry} registry
   * @param {import('./hook-socket.js').HookSocketServer|null} [hooks]
   */
  constructor(cfg, registry, hooks = null) {
    this.cfg = cfg;
    this.registry = registry;
    // Serves the per-session hook sockets a sandboxed session reports through.
    // Optional: an unsandboxed deployment does not need one, and the fleet
    // sidecar can supply its own.
    this.hooks = hooks;
    // Names with a start/resume in flight. A start takes up to ~2×rcTimeoutMs
    // while Remote Control is verified, and during that window the session is
    // in tmux but not yet finished. Without this, a second /start with the same
    // name — or a reconcile pass — would act on a half-built session.
    /** @type {Set<string>} */
    this.inFlight = new Set();
    // Sessions parked at the "resume from summary or in full?" dialog, waiting
    // for their requester to choose. Held in memory only: a hub restart with a
    // session still at the dialog leaves it there, and reconcile shows it as
    // running — `tmux attach` finishes it by hand.
    /** @type {Map<string, { dialog: import('./claude.js').ResumeDialog, verb: string, at: number }>} */
    this.awaitingChoice = new Map();
  }

  // --- reconciliation -----------------------------------------------------

  /**
   * Bring the registry in line with what tmux actually has. Cheap enough to
   * run before every read: two tmux calls plus a file write only if something
   * changed.
   *
   * Three jobs:
   *  1. Apply any conversation uuids the hook spooled while we were restarting.
   *  2. Mark records whose tmux session is gone as stopped — but KEEP the
   *     record, because its uuid is what makes the session resumable later.
   *  3. Adopt live tmux sessions we have no record of.
   *
   * (3) is not tidiness. On the fleet this came from, sessions revived after a
   * reboot were structurally invisible: absent from the UI, and free of the
   * concurrency cap. The box ran 9 concurrent sessions against a cap of 5 with
   * nothing surfacing it — which is exactly the load the cap exists to prevent.
   * A cap that only counts the sessions it launched is not a cap.
   */
  reconcile() {
    this.registry.drainSpool();

    const live = new Set(listSessions());
    let changed = false;

    for (const rec of this.registry.list()) {
      if (this.inFlight.has(rec.name)) continue; // mid-launch; not ours to judge
      const alive = live.has(rec.name);
      if (rec.status === 'running' && !alive) {
        // It went away without anyone asking — a reboot, an OOM kill, a tmux
        // server crash. Flag it for restore HERE rather than inferring it later
        // from "status is still running", because this very pass is what clears
        // that status. (Getting this wrong made restore a no-op: reconcile ran
        // at startup, marked everything stopped, and restore then found nothing
        // to bring back.) An explicit /stop clears the flag instead.
        this.registry.upsert(rec.name, {
          status: 'stopped',
          resumeOnBoot: true,
          detail: 'session ended',
          stoppedAt: Date.now(),
        });
        log.info(`reconcile: ${rec.name} ended`);
        changed = true;
      } else if (rec.status !== 'running' && alive) {
        // Came back without us — a hand-started tmux session reusing the name.
        this.registry.upsert(rec.name, { status: 'running', detail: 'running (adopted)' });
        changed = true;
      }
    }

    if (this.cfg.adoptUntracked !== false) {
      for (const name of live) {
        if (this.registry.has(name) || this.inFlight.has(name)) continue;
        // The login pane is a transient TUI we drive ourselves, not a session
        // anyone can resume or stop — see core/login.js.
        if (name === this.cfg.loginSessionName) continue;
        // Names outside our charset were never ours — the box is free to run
        // whatever tmux sessions it likes and we do not claim them.
        if (!isValidName(name)) continue;
        this.registry.upsert(name, {
          status: 'running',
          cwd: this.cfg.workdir,
          detail: 'adopted: already running on this box',
          createdBy: 'adopted',
        });
        log.info(`reconcile: adopted untracked session ${name}`);
        changed = true;
      }
    }

    return changed;
  }

  /** Records that tmux says are alive right now. */
  running() {
    this.reconcile();
    return this.registry.list().filter((r) => r.status === 'running');
  }

  /**
   * How many sessions count against the cap, given a set of live tmux names.
   *
   * This MUST agree with running(): with adoption on, every live session is
   * ours and counts; with adoption off, only sessions we have a record for do.
   * Counting raw tmux sessions instead made restore believe a box with
   * unrelated tmux sessions was permanently at cap, and it silently restored
   * nothing.
   *
   * @param {Set<string>} live
   */
  #countAgainstCap(live) {
    let n = 0;
    for (const name of live) {
      if (name === this.cfg.loginSessionName) continue; // transient, never a session
      if (this.cfg.adoptUntracked !== false ? isValidName(name) : this.registry.has(name)) n++;
    }
    return n;
  }

  /** Everything we know about, running or resumable. */
  list() {
    this.reconcile();
    return this.registry.list();
  }

  /** @param {string} name */
  get(name) {
    this.reconcile();
    return this.registry.get(name);
  }

  // --- actions ------------------------------------------------------------

  /**
   * Start a brand-new session.
   * @param {{ name?: string|null, cwd?: string|null, actor?: string|null, skipPermissions?: boolean|null, title?: string|null, brief?: string|null }} opts
   *   skipPermissions overrides AGENT_HUB_SKIP_PERMISSIONS for this session
   *   only, and is remembered so every later resume runs the same way.
   *   title is prose a PERSON wrote; supplying it pins the title so nothing
   *   derived later — the transcript hook, the cwd guess — overwrites it.
   *   brief is a sentence of context, kept for the moment of re-entry.
   * @returns {Promise<Result>}
   */
  async start({ name = null, cwd = null, actor = null, skipPermissions = null, title = null, brief = null } = {}) {
    this.reconcile();

    if (name && !isValidName(name)) return { ok: false, message: nameError(name) };
    if (name === this.cfg.loginSessionName) {
      return { ok: false, message: `"${name}" is reserved for the login flow. Pick another name.` };
    }
    const sessionName = name || generateName((n) => this.registry.has(n) || hasSession(n));

    if (hasSession(sessionName)) {
      return { ok: false, message: `"${sessionName}" is already running. Use /stop first, or pick another name.` };
    }
    if (this.inFlight.has(sessionName)) {
      return { ok: false, message: `"${sessionName}" is already starting — give it a moment.` };
    }

    const active = this.running().length;
    if (active >= this.cfg.maxSessions) {
      return {
        ok: false,
        message:
          `At the concurrency cap (${active}/${this.cfg.maxSessions}). Stop a session first, ` +
          'or raise AGENT_HUB_MAX_SESSIONS if this box can take the load.',
      };
    }

    // Validate a supplied path rather than handing it to tmux, which silently
    // falls back to its own cwd for a directory that does not exist.
    let workdir = this.cfg.workdir;
    if (cwd) {
      const resolved = resolveWorkdir(cwd);
      if (!resolved.ok) {
        return {
          ok: false,
          message: `${resolved.message}\nLeave the path off to use the default: ${this.cfg.workdir}`,
        };
      }
      workdir = resolved.path;
    }

    return this.#launch({
      name: sessionName,
      cwd: workdir,
      actor,
      resumeUuid: null,
      verb: 'started',
      skipPermissions,
      // Only on a fresh start. A resume must never carry these: the record
      // already holds whatever was written the first time, and re-supplying
      // them on every resume would let a later caller quietly rewrite a title
      // somebody set deliberately.
      title,
      brief,
    });
  }

  /**
   * Resume a session's previous conversation. Works whether or not the session
   * is still in the registry as running — that is the point of keeping records
   * past the end of their tmux session.
   *
   * @param {{ name: string, actor?: string|null, choice?: 'summary'|'full'|null }} opts
   *   choice picks how to answer the "resume from summary or in full?" dialog.
   *   Omit it to use AGENT_HUB_RESUME_CHOICE, which defaults to showing you the
   *   dialog and waiting.
   * @returns {Promise<Result>}
   */
  async resume({ name, actor = null, choice = null }) {
    this.reconcile();

    if (!isValidName(name)) return { ok: false, message: nameError(name) };
    const rec = this.registry.get(name);
    if (!rec) return { ok: false, message: `No session named "${name}". Use /list to see what exists.` };

    if (hasSession(name)) {
      // Already up — but it may be the one we parked at the dialog waiting for
      // exactly this answer, in which case "already running" would be a
      // maddening reply to `/resume x full`.
      const waiting = this.awaitingChoice.get(name);
      if (waiting && readResumeDialog(name)) {
        if (!choice) {
          return { ok: false, message: renderDialogPrompt(name, waiting.dialog) };
        }
        return this.#answerAndFinish(name, choice, waiting.verb || 'resumed');
      }
      return { ok: false, message: `"${name}" is already running — nothing to resume.` };
    }
    // Never silently fall back to --continue. See claude.js for why.
    if (!rec.uuid) return { ok: false, message: `${name}: ${RESUME_REQUIRES_UUID}` };

    const active = this.running().length;
    if (active >= this.cfg.maxSessions) {
      return {
        ok: false,
        message: `At the concurrency cap (${active}/${this.cfg.maxSessions}). Stop a session first.`,
      };
    }

    return this.#launch({
      name,
      cwd: rec.cwd || this.cfg.workdir,
      actor,
      resumeUuid: rec.uuid,
      verb: 'resumed',
      choice,
      // Carry the session's own mode forward, not the current global default.
      skipPermissions: rec.skipPermissions ?? null,
    });
  }

  /**
   * Answer a dialog a session is already parked at, then finish the launch
   * (Remote Control check and all) as if it had never paused.
   * @param {string} name
   * @param {'summary'|'full'} choice
   * @param {string} verb
   * @returns {Promise<Result>}
   */
  async #answerAndFinish(name, choice, verb) {
    answerResumeDialog(name, choice);
    this.awaitingChoice.delete(name);
    this.registry.upsert(name, { detail: `${verb} (${choice})` });
    const rc = await this.#settleRemoteControl(name, verb);
    return {
      ok: true,
      message:
        `Resuming "${name}" ${choice === 'full' ? 'in full' : 'from summary'}.` +
        (rc.url ? `\nRemote Control: ${rc.url}` : ''),
      session: this.registry.get(name) ?? undefined,
    };
  }

  /**
   * @param {{ name: string, cwd: string, actor: string|null, resumeUuid: string|null, verb: string, choice?: 'summary'|'full'|null, skipPermissions?: boolean|null , title?: string|null, brief?: string|null }} opts
   * @returns {Promise<Result>}
   */
  async #launch({ name, cwd, actor, resumeUuid, verb, choice = null, skipPermissions = null, title = null, brief = null }) {
    // Whose Claude account got seeded, when THIS start created the volumes.
    // Stays null on resume and on non-sandboxed sessions: null on the record
    // means "whatever was already there".
    /** @type {string|null} */
    let seededAccount = null;
    if (this.cfg.sandbox) {
      // Trust does not live on the host any more: the image bakes
      // hasTrustDialogAccepted for /work, so ~/.claude.json is never mutated
      // here again. The host directory still has to exist, though — it is the
      // tmux pane's cwd, and `tmux new-session -c` on a missing directory
      // fails. Skipping trust is not the same as skipping the directory.
      try {
        mkdirSync(cwd, { recursive: true });
      } catch { /* already there, or not ours to make — tmux reports either */ }

      // What DOES have to happen first is the volumes existing and the
      // conversation volume having credentials in it — without that the
      // session comes up unauthenticated and hangs at a login prompt.
      const volumes = ensureSandboxVolumes(this.cfg, name, actor);
      if (!volumes.ok) {
        this.registry.upsert(name, { status: 'error', detail: volumes.message ?? 'sandbox setup failed', cwd, createdBy: actor });
        return { ok: false, message: `Could not prepare the sandbox for "${name}": ${volumes.message}` };
      }
      seededAccount = volumes.account ?? null;
    } else {
      ensureWorkdirTrusted(this.cfg);
      // A session in any OTHER directory needs that directory trusted too, or it
      // stops at "Do you trust the files in this folder?" with nobody to answer.
      if (cwd !== this.cfg.workdir) trustDirectory(cwd);
    }
    this.inFlight.add(name);
    try {
      const command = buildCommand(this.cfg, {
        name,
        resumeUuid,
        skipPermissions,
        hookSocket: await this.#ensureHookSocket(name),
      });
      const spawned = newSession({ name, cwd, command });
      if (spawned.status !== 0) {
        const detail = (spawned.stderr || 'tmux new-session failed').trim().slice(0, 300);
        this.registry.upsert(name, { status: 'error', detail, cwd, createdBy: actor });
        return { ok: false, message: `Could not start "${name}": ${detail}` };
      }
      if (!hasSession(name)) {
        // The pane died the instant it opened — almost always claude missing
        // from PATH, or unauthenticated.
        const detail = 'session exited immediately — is `claude` on PATH and logged in?';
        this.registry.upsert(name, { status: 'error', detail, cwd, createdBy: actor });
        return { ok: false, message: `Could not start "${name}": ${detail}` };
      }

      // Something readable from the moment it starts. The hook replaces this
      // with what the person actually asked for as soon as they say it.
      const existing = this.registry.get(name);
      const rec = this.registry.upsert(name, {
        status: 'running',
        cwd,
        // A title somebody WROTE beats anything derived, and is pinned so that
        // nothing later — the transcript hook, the cwd guess — overwrites what
        // they said. Without the pin the hook replaces it a few seconds later
        // and the field looks like it silently did not save.
        ...(title ? { title, titlePinned: true } : existing?.title ? {} : { title: titleFromCwd(cwd) }),
        ...(brief ? { brief } : {}),
        // Whose Claude account this session runs on. Only set when this start
        // created the volumes — a resume keeps the account it began with, and
        // null on the record means "whatever was there already".
        ...(typeof seededAccount === 'string' ? { account: seededAccount } : {}),
        detail: `${verb}`,
        stoppedAt: null,
        ...(actor ? { createdBy: actor } : {}),
        ...(resumeUuid ? { uuid: resumeUuid } : {}),
        // Only write the override on a fresh start. A resume passes the value
        // it read off the record, and writing null back on a plain resume
        // would erase a deliberate safe-mode choice.
        ...(skipPermissions === null ? {} : { skipPermissions }),
      });

      // A resumed session may stop at the "resume from summary or in full?"
      // dialog; a fresh one never does. Only wait when it can actually happen.
      if (resumeUuid) {
        const dialog = await waitForResumeDialog(this.cfg, name);
        if (dialog) {
          const decided = choice || (this.cfg.resumeChoice === 'ask' ? null : this.cfg.resumeChoice);
          if (!decided) {
            // Hold the session AT the dialog and hand the numbers back, so the
            // choice is made knowing the age and token cost. This is a
            // deliberate, visible pause with a deadline — not the silent hang
            // that made unattended restore fail before.
            this.awaitingChoice.set(name, { dialog, verb, at: Date.now() });
            this.#armChoiceTimeout(name, verb);
            this.registry.upsert(name, { detail: 'waiting for resume choice' });
            return { ok: false, message: renderDialogPrompt(name, dialog), session: rec };
          }
          answerResumeDialog(name, decided);
          this.registry.upsert(name, { detail: `${verb} (${decided})` });
        }
      }

      if (!this.cfg.remoteControl) {
        log.info(`${verb} ${name} in ${cwd}`);
        return { ok: true, message: `${cap(verb)} "${name}" in ${cwd}.`, session: rec };
      }

      const rc = await this.#settleRemoteControl(name, verb);
      if (rc.online) {
        return {
          ok: true,
          message: `${cap(verb)} "${name}" in ${cwd}.` + (rc.url ? `\nRemote Control: ${rc.url}` : ''),
          session: this.registry.get(name) ?? rec,
        };
      }
      if (rc.killed) {
        return { ok: false, message: `Started "${name}" but ${rc.detail}. Killed it — try again.` };
      }
      return {
        ok: true,
        message:
          `${cap(verb)} "${name}" in ${cwd}, but Remote Control did not come online.` +
          // WHY, when the pane said why. The bare message sent someone to a
          // terminal to find a reason the watcher had already read — and when
          // the cause is systemic (a domain migration, a login prompt), the
          // reason is the only thing distinguishing "this session" from
          // "every session".
          (rc.detail ? `\n${rc.detail}` : '') +
          `\nReach it on the box with: tmux attach -t ${name}`,
        session: this.registry.get(name) ?? rec,
      };
    } finally {
      this.inFlight.delete(name);
    }
  }

  /**
   * Make sure this session has a hook socket to report through, opening one if
   * there is not already.
   *
   * This used to warn and carry on, which was the wrong call. podman creates a
   * DIRECTORY for a bind-mount source that does not exist, so mounting a
   * missing socket does not fail loudly — it produces a container whose
   * /run/hub.sock is a directory, whose SessionStart hook cannot report, and
   * therefore a session with no conversation uuid. An unresumable session, made
   * quietly, which is the single failure this whole tool exists to prevent.
   *
   * So it is opened here instead. Warning about something we can fix is just
   * asking somebody else to go and fix it.
   *
   * @param {string} name
   * @returns {Promise<boolean>} whether the launch should mount it
   */
  async #ensureHookSocket(name) {
    if (!this.cfg.sandbox || !this.cfg.sandboxHookSocket) return false;
    const socket = path.join(this.cfg.sandboxHookSocketDir, `${name}.sock`);
    if (existsSync(socket)) return true;
    if (!this.hooks) {
      log.warn(
        `${name}: no hook socket at ${socket} and nothing here serves them — starting without it. ` +
          'The session will not record a conversation uuid, so it will not be resumable.',
      );
      return false;
    }
    try {
      await this.hooks.open(name);
      return true;
    } catch (e) {
      log.warn(`${name}: could not open a hook socket: ${/** @type {Error} */ (e).message}`);
      return false;
    }
  }

  /**
   * Verify Remote Control and record the outcome. Shared by the fresh-launch
   * path and by the resume-after-a-choice path, so a session that paused at
   * the dialog ends up in exactly the same state as one that never did.
   *
   * @param {string} name
   * @param {string} verb
   * @returns {Promise<{ online: boolean, url: string|null, detail: string, killed?: boolean }>}
   */
  async #settleRemoteControl(name, verb) {
    if (!this.cfg.remoteControl) return { online: false, url: null, detail: 'remote control disabled' };

    const rc = await verifyRemoteControl(this.cfg, name);
    if (rc.online) {
      this.registry.upsert(name, { rcUrl: rc.url, detail: `${verb} · ${rc.detail}` });
      log.info(`${verb} ${name}: ${rc.detail}${rc.url ? ' ' + rc.url : ''}`);
      return rc;
    }

    // Remote Control never attached. Whether that is fatal depends on how the
    // operator drives sessions — with RC required we kill it so the slot frees
    // and the failure is loud; otherwise the session is still reachable over
    // SSH/tmux and killing it would destroy usable work.
    if (this.cfg.rcRequired) {
      killSession(name);
      this.registry.upsert(name, { status: 'error', resumeOnBoot: false, detail: rc.detail, stoppedAt: Date.now() });
      log.warn(`${name}: ${rc.detail}; killed (AGENT_HUB_RC_REQUIRED=1)`);
      return { ...rc, killed: true };
    }
    this.registry.upsert(name, { detail: `${verb} · ${rc.detail}` });
    log.warn(`${name}: ${rc.detail} (session kept — reach it with \`tmux attach -t ${name}\`)`);
    return rc;
  }

  /**
   * A session parked at the dialog must not sit there forever if nobody
   * answers — that is the original silent hang wearing a different hat. After
   * the deadline, take the cheap recommended option and say so in the log.
   * @param {string} name
   * @param {string} verb
   */
  #armChoiceTimeout(name, verb) {
    const timer = setTimeout(() => {
      const waiting = this.awaitingChoice.get(name);
      if (!waiting) return;
      if (!readResumeDialog(name)) {
        this.awaitingChoice.delete(name);
        return; // answered elsewhere, or the session went away
      }
      log.warn(
        `${name}: nobody chose within ${Math.round(this.cfg.resumeAskTimeoutMs / 1000)}s — ` +
          'taking "resume from summary"',
      );
      answerResumeDialog(name, this.cfg.resumeChoiceUnattended);
      this.awaitingChoice.delete(name);
      this.registry.upsert(name, { detail: `${verb} (${this.cfg.resumeChoiceUnattended}, timed out)` });
      void this.#settleRemoteControl(name, verb);
    }, this.cfg.resumeAskTimeoutMs);
    timer.unref?.();
  }

  /**
   * @param {{ name: string, actor?: string|null }} opts
   * @returns {Result}
   */
  stop({ name, actor = null }) {
    this.reconcile();
    if (!isValidName(name)) return { ok: false, message: nameError(name) };

    const rec = this.registry.get(name);
    if (!hasSession(name)) {
      if (!rec) return { ok: false, message: `No session named "${name}".` };
      if (rec.status === 'running') {
        const updated = this.registry.upsert(name, {
          status: 'stopped',
          resumeOnBoot: false,
          detail: 'already gone',
          stoppedAt: Date.now(),
        });
        return { ok: true, message: `"${name}" had already ended.`, session: updated };
      }
      // Asked for explicitly, so it stays down through the next reboot.
      if (rec.resumeOnBoot) this.registry.upsert(name, { resumeOnBoot: false });
      return { ok: true, message: `"${name}" is not running.`, session: rec };
    }

    const killed = killSession(name);
    if (killed.status !== 0) {
      const detail = (killed.stderr || 'tmux kill-session failed').trim().slice(0, 300);
      return { ok: false, message: `Could not stop "${name}": ${detail}` };
    }
    const updated = this.registry.upsert(name, {
      status: 'stopped',
      // Someone asked for this. It must NOT come back by itself at the next
      // boot — that is the difference between a stop and a crash.
      resumeOnBoot: false,
      detail: actor ? `stopped by ${actor}` : 'stopped',
      stoppedAt: Date.now(),
    });
    log.info(`stopped ${name}${actor ? ` (by ${actor})` : ''}`);
    return {
      ok: true,
      // Say this explicitly: the whole reason the record survives is so the
      // conversation can come back, and nobody should have to guess that.
      message: updated.uuid
        ? `Stopped "${name}". Its conversation is kept — /resume ${name} brings it back.`
        : `Stopped "${name}".`,
      session: updated,
    };
  }

  /**
   * Forget a session entirely. Stops it first if it is running, because a
   * record-less live session would just be re-adopted on the next reconcile.
   * @param {{ name: string }} opts
   * @returns {Result}
   */
  forget({ name }) {
    if (!isValidName(name)) return { ok: false, message: nameError(name) };
    if (hasSession(name)) killSession(name);

    // /forget already meant "no longer resumable". In sandbox mode that was
    // only true of the record: the conversation and the workspace both lived on
    // in named volumes indefinitely. Make it true on disk too (design.md §2).
    let volumes = '';
    if (this.cfg.sandbox) {
      void this.hooks?.close(name);
      stopSandboxContainer(this.cfg, name);
      const { removed, failed } = removeSandboxVolumes(this.cfg, name);
      if (removed.length) volumes = `\nDeleted ${removed.join(' and ')}.`;
      // Not fatal, and said out loud rather than swallowed: a volume left
      // behind is disk someone has to reclaim by hand, and silently succeeding
      // is how it goes unnoticed until the box fills up.
      if (failed.length) {
        volumes += `\nCould not delete ${failed.map((f) => `${f.volume} (${f.why})`).join(', ')}.`;
      }
    }

    const had = this.registry.remove(name);
    return had
      ? { ok: true, message: `Forgot "${name}". Its conversation can no longer be resumed from here.${volumes}` }
      : { ok: false, message: `No session named "${name}".${volumes}` };
  }

  /**
   * Last lines of a session's pane. Read-only — used by the web UI to show
   * what a session is doing, and by /status.
   * @param {string} name
   * @param {number} lines
   */
  peek(name, lines = 40) {
    if (!isValidName(name) || !hasSession(name)) return null;
    return capturePane(name, lines);
  }

  /**
   * Record a conversation uuid reported by the SessionStart hook. This is what
   * makes resume reliable: claude hands the hook its own session_id and
   * transcript path, so the uuid is authoritative rather than scraped.
   * @param {{ name: string, cwd?: string|null, uuid: string, title?: string|null }} opts
   */
  recordUuid({ name, cwd = null, uuid, title = null }) {
    if (!isValidName(name)) return { ok: false, message: nameError(name) };
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(uuid)) return { ok: false, message: `Not a conversation uuid: ${uuid}` };
    // A title from the hook is the best one available — it is what the person
    // actually typed — so it wins over the directory-name fallback. It does not
    // overwrite one somebody set on purpose.
    const clean = cleanTitle(title);
    const existing = this.registry.get(name);
    const rec = this.registry.upsert(name, {
      uuid,
      status: hasSession(name) ? 'running' : 'stopped',
      ...(cwd ? { cwd } : {}),
      ...(clean && !existing?.titlePinned ? { title: clean } : {}),
    });
    log.info(`hook: ${name} → ${uuid}`);
    return { ok: true, message: 'recorded', session: rec };
  }

  // --- boot restore -------------------------------------------------------

  /**
   * Bring back sessions that were running when this box (or this hub) went
   * down. Called once at startup.
   *
   * The distinction that makes this safe is the resumeOnBoot flag, not the
   * status: a session someone stopped on purpose has resumeOnBoot false and is
   * left alone, while one that vanished on its own is flagged by reconcile and
   * comes back. Keying off a flag rather than off "status is still running"
   * makes this independent of whether reconcile has run yet — which matters,
   * because the periodic reconcile can fire while a slow restore is still
   * working through its list.
   *
   * @returns {Promise<{ restored: string[], skipped: Array<{name: string, why: string}> }>}
   */
  async restore() {
    this.registry.drainSpool();

    /** @type {string[]} */
    const restored = [];
    /** @type {Array<{name: string, why: string}>} */
    const skipped = [];
    const live = new Set(listSessions());
    const alreadyCounted = this.#countAgainstCap(live);

    // Oldest first, so the cap is spent on the longest-lived sessions rather
    // than whichever happened to be written last.
    const candidates = this.registry
      .list()
      .filter((r) => !live.has(r.name) && (r.status === 'running' || r.resumeOnBoot === true))
      .sort((a, b) => a.createdAt - b.createdAt);

    for (const rec of candidates) {
      if (!rec.uuid) {
        // Not an error worth shouting about: the session existed but never got
        // far enough for the hook to fire. Recording it as stopped keeps it in
        // the list as a name you can start fresh.
        this.registry.upsert(rec.name, {
          status: 'stopped',
          resumeOnBoot: false,
          detail: 'not restored: no recorded conversation',
        });
        skipped.push({ name: rec.name, why: 'no recorded conversation uuid' });
        continue;
      }
      if (restored.length + alreadyCounted >= this.cfg.maxSessions) {
        // Leave resumeOnBoot set: it did not come back because the box was
        // full, not because anyone decided it should stay down, so the next
        // start is still entitled to bring it back.
        this.registry.upsert(rec.name, { status: 'stopped', detail: `not restored: at cap ${this.cfg.maxSessions}` });
        skipped.push({ name: rec.name, why: `at cap (${this.cfg.maxSessions})` });
        continue;
      }

      // Hold the name for the duration so a concurrent reconcile cannot see a
      // half-launched session and mark it ended.
      this.inFlight.add(rec.name);
      try {
        const command = buildCommand(this.cfg, {
          name: rec.name,
          resumeUuid: rec.uuid,
          skipPermissions: rec.skipPermissions ?? null,
        });
        const spawned = newSession({ name: rec.name, cwd: rec.cwd || this.cfg.workdir, command });
        if (spawned.status !== 0 || !hasSession(rec.name)) {
          const why = (spawned.stderr || 'tmux new-session failed').trim().slice(0, 200);
          this.registry.upsert(rec.name, { status: 'error', resumeOnBoot: false, detail: `restore failed: ${why}` });
          skipped.push({ name: rec.name, why });
          continue;
        }
        this.registry.upsert(rec.name, {
          status: 'running',
          resumeOnBoot: false,
          detail: `restored (--resume ${rec.uuid})`,
        });
        restored.push(rec.name);
        log.info(`restored ${rec.name} (--resume ${rec.uuid}) in ${rec.cwd}`);
      } finally {
        this.inFlight.delete(rec.name);
      }
    }

    // One shared pass over everything just launched — they render their resume
    // dialogs in parallel, so this keeps boot short even with several sessions.
    // Nobody is present at boot, so this takes the configured unattended choice
    // rather than parking sessions at the dialog waiting for an answer.
    if (restored.length) await dismissResumeDialogs(this.cfg, restored, this.cfg.resumeChoiceUnattended);

    // Remote Control is verified opportunistically for restored sessions: the
    // session is already useful over tmux, so a slow RC attach must not hold
    // startup. Failures are logged, never fatal.
    if (this.cfg.remoteControl) {
      for (const name of restored) {
        const rc = await verifyRemoteControl(this.cfg, name);
        if (rc.online) this.registry.upsert(name, { rcUrl: rc.url, detail: `restored · ${rc.detail}` });
        else log.warn(`restore ${name}: ${rc.detail}`);
      }
    }

    return { restored, skipped };
  }
}

/** @param {string} s */
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * What the requester sees when a resume stops to ask. Leads with the age and
 * token count, because that is the whole reason there is a choice: resuming a
 * 350k-token conversation in full can eat a serious share of a usage limit,
 * and the summary option exists precisely to avoid that.
 *
 * @param {string} name
 * @param {import('./claude.js').ResumeDialog} dialog
 */
function renderDialogPrompt(name, dialog) {
  const lines = [`"${name}" is waiting for you to choose how to resume.`, ''];
  if (dialog.info) lines.push(dialog.info, '');
  if (dialog.options.length) {
    lines.push(...dialog.options.map((o) => `  ${o}`), '');
  }
  lines.push(
    `/resume ${name} summary   — resume from a summary (recommended, cheapest)`,
    `/resume ${name} full      — resume the full conversation as-is`,
    '',
    'The session is held at this prompt until you pick.',
  );
  return lines.join('\n');
}
