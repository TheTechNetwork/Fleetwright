// agent-hub entrypoint. Wires config → core → adapters, restores anything that
// was running before the last shutdown, and stays up.

import { mkdirSync } from 'node:fs';
import { loadConfig, validateConfig } from './config.js';
import { log, setLogLevel } from './log.js';
import { Registry } from './core/registry.js';
import { SessionManager } from './core/sessions.js';
import { LoginFlow } from './core/login.js';
import { ensureWorkdirTrusted, markOnboardingComplete } from './core/trust.js';
import { tmuxAvailable } from './core/tmux.js';
import { HookSocketServer } from './core/hook-socket.js';
import { renewAllCredentials } from './core/keepalive.js';
import { HttpAdapter } from './adapters/http.js';
import { TelegramAdapter } from './adapters/telegram.js';

export async function main() {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  const { errors, warnings } = validateConfig(cfg);
  for (const w of warnings) log.warn(`config: ${w}`);
  if (errors.length) {
    for (const e of errors) log.error(`config: ${e}`);
    process.exit(1);
  }

  // tmux is not optional — without it there is nothing to manage, and failing
  // here gives one clear line instead of every command returning nothing.
  if (!tmuxAvailable()) {
    log.error('tmux is not installed or not on PATH. Install it (apt install tmux) and restart.');
    process.exit(1);
  }

  mkdirSync(cfg.stateDir, { recursive: true });
  ensureWorkdirTrusted(cfg);

  const registry = new Registry(cfg);

  // Sandboxed sessions report their conversation uuid over a per-session unix
  // socket rather than the shared loopback endpoint, because the socket they
  // can reach is what proves which session they are. Serving them here means a
  // sandboxed box is resumable on its own, with no fleet sidecar required.
  const hooks =
    cfg.sandbox && cfg.sandboxHookSocket
      ? new HookSocketServer({
          dir: cfg.sandboxHookSocketDir,
          onSessionStart: (r) => sessions.recordUuid(r),
          logger: log,
        })
      : null;
  const sessions = new SessionManager(cfg, registry, hooks);
  const login = new LoginFlow(cfg);

  log.info(`agent-hub starting on ${cfg.hostname} · workdir ${cfg.workdir} · cap ${cfg.maxSessions}`);

  const auth = login.status();
  if (auth.loggedIn) {
    log.info(`claude: logged in as ${auth.email || 'unknown'} (${auth.subscriptionType || auth.authMethod || '?'})`);
    // Authenticated but possibly never onboarded — the state a box is left in
    // by `claude auth login`. Fixing it here rather than only after /login
    // repairs boxes that were authenticated some other way.
    markOnboardingComplete(cfg);
  } else {
    // Not fatal. The hub still runs, and logging in is one of the things it can
    // do for you — which is exactly the situation on a freshly built box.
    log.warn('claude: NOT logged in — sessions will fail until you run /login. The hub is up and can do that for you.');
  }

  // Adopt whatever is already on the box before deciding what to restore, so a
  // session that survived a hub restart is never launched a second time.
  sessions.reconcile();

  /** @type {Array<{ stop: () => Promise<unknown> }>} */
  const adapters = [];
  const http = new HttpAdapter(cfg, { sessions, login });
  await http.start();
  adapters.push(http);

  if (cfg.telegram.token) {
    const telegram = new TelegramAdapter(cfg, { sessions, login });
    if (await telegram.start()) adapters.push(telegram);
  }

  if (cfg.restoreOnStart) {
    // After the adapters are up, so a slow restore (each resumed session waits
    // out its dialog and Remote Control) never delays the hub answering.
    restoreInBackground(sessions);
  }

  /** @param {string} signal */
  const shutdown = async (signal) => {
    // Deliberately does NOT stop the tmux sessions. They are the work; the hub
    // is just the remote control for it. Sessions survive a hub restart and are
    // re-adopted on the next reconcile.
    log.info(`${signal} — shutting down (tmux sessions are left running)`);
    for (const a of adapters) {
      try {
        await a.stop();
      } catch { /* best effort */ }
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A thrown error in a poll loop must not take the hub down silently.
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
  process.on('uncaughtException', (e) => log.error('uncaught exception', e));

  // Periodic reconcile so the state file (and anything reading it) stays
  // honest even if nobody opens the UI. Cheap: two tmux calls.
  setInterval(() => {
    try {
      sessions.reconcile();
    } catch (e) {
      log.warn('reconcile failed', e);
    }
  }, 30_000).unref?.();

  // The bin, on an hour.
  //
  // Every path that touches the bin sweeps it too, so this is for the box that
  // is simply idle — nobody forgets anything for a fortnight and the volumes
  // of something forgotten a fortnight ago are still on the disk. Hourly is
  // plenty: the window is measured in days, and being an hour late to delete
  // something has no consequence, while being a week late is a bin that is
  // really just a slower leak.
  setInterval(() => {
    try {
      const gone = sessions.sweepBin();
      if (gone) log.info(`bin: swept ${gone} expired session(s)`);
    } catch (e) {
      log.warn('bin sweep failed', e);
    }
  }, 3_600_000).unref?.();

  // THE CREDENTIALS, so an idle box is not signed out by the time somebody
  // reaches for it.
  //
  // An OAuth credential renews when it is USED, and nothing on an idle host
  // uses one — no session is running, which is what idle means. So it goes
  // stale exactly when it must not: at the moment somebody starts a session on
  // a box that has been quiet since yesterday. See src/core/keepalive.js for
  // the ladder and for why the verdict is read off the credential file rather
  // than off an exit code.
  //
  // Hourly, and almost always free: the check is a file read, and a credential
  // with hours left costs nothing at all. Once at startup too, because a box
  // that has just been rebooted is the one most likely to be holding something
  // that expired while it was off.
  if (cfg.credentialKeepaliveMs) {
    const keepalive = () => {
      try {
        renewAllCredentials(cfg);
      } catch (e) {
        log.warn('keepalive failed', e);
      }
    };
    setTimeout(keepalive, 30_000).unref?.();
    setInterval(keepalive, cfg.credentialKeepaliveMs).unref?.();
  }
}

/** @param {SessionManager} sessions */
function restoreInBackground(sessions) {
  sessions
    .restore()
    .then(({ restored, skipped }) => {
      if (restored.length) log.info(`restore: brought back ${restored.length} session(s): ${restored.join(', ')}`);
      for (const s of skipped) log.warn(`restore: skipped ${s.name} — ${s.why}`);
      if (!restored.length && !skipped.length) log.info('restore: nothing to bring back');
    })
    .catch((e) => log.error('restore failed', e));
}

// Only auto-start when run directly; the CLI imports pieces of this module.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log.error('fatal', e);
    process.exit(1);
  });
}
