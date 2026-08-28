// Config: one place that turns environment variables into a frozen, validated
// object. Everything else in agent-hub takes the config as an argument, so a
// test can construct one by hand and nothing reads process.env behind your back.
//
// Deployment supplies these via the systemd EnvironmentFile (/etc/agent-hub.env)
// — see install/agent-hub.env.example for the annotated template a new operator
// actually fills in.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBin } from './core/which.js';

// The checkout this process is running from — two levels up from src/config.js.
// Derived rather than configured, so it is right by construction even when the
// service is started from somewhere else entirely.
const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {ReturnType<typeof loadConfig>} Config */

/** @param {string} name @param {string} [fallback] */
function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

/** @param {string} name @param {number} fallback */
function int(name, fallback) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

/** @param {string} name @param {boolean} fallback */
function bool(name, fallback) {
  const v = str(name).toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** Comma/whitespace separated list → trimmed non-empty strings. */
/** @param {string} name */
function list(name) {
  return str(name)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  // Kept as a parameter for symmetry with tests, but the helpers above read
  // process.env directly; swap it in so an injected env actually applies.
  if (env !== process.env) process.env = /** @type {any} */ (env);

  const home = os.homedir();
  const stateDir = str('AGENT_HUB_STATE_DIR', '/var/lib/agent-hub');

  const cfg = {
    // --- where state lives -------------------------------------------------
    // The deployment itself, which /update pulls into. Overridable for the odd
    // layout where the checkout is not the parent of src/.
    installDir: str('AGENT_HUB_INSTALL_DIR', INSTALL_DIR),
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    // The SessionStart hook appends here when it cannot reach the HTTP control
    // port (hub restarting, port moved). The hub drains it on every reconcile,
    // so a conversation uuid is never lost just because of a timing gap.
    spoolFile: path.join(stateDir, 'uuid-spool.tsv'),

    // --- how sessions are launched ----------------------------------------
    // Sessions start here. It MUST be a trusted folder in ~/.claude.json or
    // claude blocks on the interactive "trust this folder?" prompt forever;
    // core/trust.js guarantees that at startup.
    workdir: path.resolve(str('AGENT_HUB_WORKDIR', path.join(home, 'agent-runs'))),
    // Resolved to an absolute path so sessions do not depend on how a login
    // shell happens to build PATH — see core/which.js for the specific trap
    // this avoids on a stock Debian box.
    claudeBin: resolveBin(str('AGENT_HUB_CLAUDE_BIN', 'claude')),
    // Concurrency cap. The box this pattern came from hard-froze under agent
    // load (load ~14 with 4 claude + 6 headless-chrome), which is what the cap
    // exists to prevent. It counts EVERY live tmux session the hub can see, not
    // just ones it launched — a cap that only counts its own launches is not a
    // cap.
    maxSessions: Math.max(1, int('AGENT_HUB_MAX_SESSIONS', 5)),
    // --dangerously-skip-permissions. On by default because an unattended
    // session that stops for a permission prompt is a hung session, which is
    // the entire failure mode this tool exists to avoid. Turn it off and you
    // must drive every session interactively.
    skipPermissions: bool('AGENT_HUB_SKIP_PERMISSIONS', true),
    // Ask Claude Code to bring up Remote Control so a session is drivable from
    // claude.ai/code. Requires an account with Remote Control available; if
    // yours does not have it, set this to 0 and drive sessions over SSH/tmux.
    remoteControl: bool('AGENT_HUB_REMOTE_CONTROL', true),
    // How long to wait for the Remote Control status line before re-issuing
    // /remote-control once and waiting again.
    rcTimeoutMs: Math.max(3000, int('AGENT_HUB_RC_TIMEOUT_MS', 10000)),
    // If Remote Control never comes online, is the session still useful? When
    // true the hub keeps it (you can still reach it over SSH); when false it
    // kills it so the slot frees and the failure is visible.
    rcRequired: bool('AGENT_HUB_RC_REQUIRED', false),
    // --- the ephemeral root sandbox (design.md §2) --------------------------
    // Off by default: it needs podman and a built image, and a box without
    // either must keep working exactly as before. When on, the pane's process
    // becomes `podman run -it` and the session gets real root inside a
    // container whose filesystem is discarded on every stop, while its
    // conversation and workspace live in named volumes that survive.
    sandbox: bool('AGENT_HUB_SANDBOX', false),
    podmanBin: str('AGENT_HUB_PODMAN_BIN', 'podman'),
    // Fully qualified with the `localhost/` prefix on purpose. `podman build -t
    // agent-session:latest` stores it as localhost/agent-session:latest, and a
    // BARE name at run time goes through short-name resolution — which fails
    // outright on a stock Debian 13, where no unqualified-search-registries are
    // configured. Naming it in full skips that lookup entirely. A remote image
    // must likewise be given in full (registry/name:tag).
    // Applying system packages needs root, which this service deliberately does
    // not have. Turning this on is half the story; the other half is a scoped
    // sudoers rule, and /upgrade prints the exact line when this is off.
    systemUpgrade: bool('AGENT_HUB_SYSTEM_UPGRADE', false),
    // Separate from systemUpgrade, and separately off. Rebooting ends every
    // running session; installing packages does not.
    systemReboot: bool('AGENT_HUB_SYSTEM_REBOOT', false),
    runUser: str('AGENT_HUB_USER', process.env.USER || 'agent'),

    // Pulled, not built. Every host running the same published image is the
    // only way "the sandbox" is one thing: with a local build, what a box got
    // depended on the day it built it, and two hosts on the same commit could
    // disagree about how a session behaves.
    //
    // Set this to localhost/agent-session:latest to go back to building
    // locally — ensureSandboxImage builds anything localhost/ and pulls
    // anything else, so an offline or air-gapped box has a way out.
    sandboxImage: str('AGENT_HUB_SANDBOX_IMAGE', 'ghcr.io/thetechnetwork/fleetwright-session:latest'),
    // Build the image on demand if it is missing, rather than refusing to start
    // a session over something we know how to fix. The first session on a fresh
    // box pays a few minutes for it; every one after that is instant.
    sandboxAutoBuild: bool('AGENT_HUB_SANDBOX_AUTO_BUILD', true),
    // The Containerfile to build from, next to the checkout by default.
    sandboxContainerfile: str('AGENT_HUB_SANDBOX_CONTAINERFILE', path.join(INSTALL_DIR, 'sandbox', 'Containerfile')),
    // Resource limits become podman flags — one mechanism rather than a
    // separate cgroup layer. Empty disables the flag entirely.
    sandboxMemory: str('AGENT_HUB_SANDBOX_MEMORY', '8g'),
    sandboxCpus: str('AGENT_HUB_SANDBOX_CPUS', '2'),
    sandboxPidsLimit: str('AGENT_HUB_SANDBOX_PIDS_LIMIT', '512'),
    // Anything else to hand podman, space separated. An escape hatch for the
    // deployment-specific (extra mounts, --network, --userns) that does not
    // belong hard-coded here.
    sandboxExtraArgs: str('AGENT_HUB_SANDBOX_ARGS').split(/\s+/).filter(Boolean),
    // Bind-mount the per-session hook socket, so a container can report its
    // conversation uuid without being able to name another session.
    sandboxHookSocket: bool('AGENT_HUB_SANDBOX_HOOK_SOCKET', true),
    sandboxHookSocketDir: str('AGENT_HUB_SANDBOX_HOOK_SOCKET_DIR', '/run/agent-fleet'),
    // Copied into each session's fresh conversation volume, or the session
    // comes up unauthenticated and hangs at a login prompt nobody can answer.
    // Set empty to disable and manage credentials yourself.
    sandboxCredentialsFile: str('AGENT_HUB_SANDBOX_CREDENTIALS', path.join(home, '.claude', '.credentials.json')),
    // How often a session start may check the registry for a newer sandbox
    // image. Six hours, matching the package-list refresh: often enough that a
    // fix ships within a working day without anybody running /update, rare
    // enough that the registry is never on the critical path of a start.
    // 0 disables the check entirely — /update still refreshes.
    sandboxRefreshMs: int('AGENT_HUB_SANDBOX_REFRESH_MS', 6 * 60 * 60 * 1000),

    // Count (and show) tmux sessions this hub did not start. On by default:
    // what matters for the cap is the box's REAL concurrency, not who asked.
    // Turn it off on a shared box where other tmux sessions are none of the
    // hub's business.
    adoptUntracked: bool('AGENT_HUB_ADOPT_UNTRACKED', true),

    // --- Claude account login ----------------------------------------------
    // Run `claude auth login` from chat / the web UI, so a fresh box can be
    // authenticated without SSH. The flow needs a dedicated tmux pane to type
    // the pasted code into; it is kept out of the session list and never
    // counts against the cap.
    loginEnabled: bool('AGENT_HUB_LOGIN', true),
    loginSessionName: str('AGENT_HUB_LOGIN_SESSION', 'agent-hub-login'),
    loginTimeoutMs: Math.max(30_000, int('AGENT_HUB_LOGIN_TIMEOUT_MS', 600_000)),
    // HOW LONG A FORGOTTEN SESSION IS STILL RECOVERABLE.
    //
    // Seven days, because the mistake this exists for is usually noticed the
    // next time somebody looks for the work — which is a day or two later, not
    // a minute later. Shorter than that and the bin is decoration.
    //
    // It costs disk: a binned session's conversation and workspace volumes
    // stay on the box for the whole window. Zero turns the bin off and
    // restores the old behaviour, deleting immediately, which is the right
    // setting for a box that is tight on space and the wrong default.
    binTtlMs: Math.max(0, int('AGENT_HUB_BIN_DAYS', 7) * 86_400_000),

    // --- resume ------------------------------------------------------------
    // `claude --resume <uuid>` on a large or stale conversation shows a blocking
    // dialog before it resumes. See core/claude.js for the whole story.
    //
    // What an interactive /resume does when it hits that dialog:
    //   'ask'     (default) — report what the dialog says (age, token count,
    //             the options) and hold the session there until the requester
    //             picks. This is the only way to make an informed choice, and
    //             resuming a 350k-token conversation in full is not a decision
    //             worth making blind.
    //   'summary' — always take "Resume from summary (recommended)".
    //   'full'    — always resume the full session as-is.
    // A choice on the command itself (/resume <name> full) beats this setting.
    // We deliberately never offer "Don't ask me again", which flips a global
    // preference for every future session, interactive ones included.
    resumeChoice: /** @type {'ask'|'summary'|'full'} */ (
      ['ask', 'summary', 'full'].includes(str('AGENT_HUB_RESUME_CHOICE', 'ask').toLowerCase())
        ? str('AGENT_HUB_RESUME_CHOICE', 'ask').toLowerCase()
        : 'ask'
    ),
    // Boot restore can never ask — nobody is present at 3am after a reboot —
    // so it always uses a concrete choice. Defaults to the cheap, recommended
    // summary; set 'full' if you would rather pay for complete context.
    resumeChoiceUnattended: /** @type {'summary'|'full'} */ (
      str('AGENT_HUB_RESUME_CHOICE_UNATTENDED', 'summary').toLowerCase() === 'full' ? 'full' : 'summary'
    ),
    // How long a session may sit at the dialog waiting for someone to choose.
    // On timeout the summary option is taken, so a forgotten /resume degrades
    // into the safe default instead of a session hung forever.
    resumeAskTimeoutMs: Math.max(30_000, int('AGENT_HUB_RESUME_ASK_TIMEOUT_MS', 600_000)),
    resumeDialogWaitMs: Math.max(5000, int('AGENT_HUB_RESUME_DIALOG_WAIT_MS', 45000)),
    // On hub startup, resume any session that state says was running but whose
    // tmux is gone — i.e. the box rebooted or the tmux server died under it.
    restoreOnStart: bool('AGENT_HUB_RESTORE_ON_START', true),

    // --- the HTTP control surface -----------------------------------------
    // ALWAYS bound, because the SessionStart hook posts conversation uuids to
    // it. Default 127.0.0.1: safe with no token. Bind wider (or point a
    // Cloudflare Tunnel at it) and a token becomes mandatory — see validate().
    bind: str('AGENT_HUB_BIND', '127.0.0.1'),
    port: int('AGENT_HUB_PORT', 8790),
    token: str('AGENT_HUB_TOKEN'),
    // Serve the browser UI. Turn off for a Telegram-only deployment; the
    // internal hook endpoint keeps working either way.
    webEnabled: bool('AGENT_HUB_WEB', true),

    // --- Telegram ----------------------------------------------------------
    telegram: {
      token: str('AGENT_HUB_TELEGRAM_TOKEN'),
      // Numeric Telegram user ids allowed to run commands. There is no "open to
      // everyone" mode: a session here is unsupervised shell access on this
      // box, so an empty allowlist means the bot answers /whoami (so you can
      // learn your id) and refuses everything else.
      allowedUsers: list('AGENT_HUB_TELEGRAM_ALLOWED_USERS'),
      apiBase: str('AGENT_HUB_TELEGRAM_API', 'https://api.telegram.org'),
    },

    // Overridable so a test can point them at a stub rather than the real ones.
    journalctlBin: str('AGENT_HUB_JOURNALCTL_BIN', 'journalctl'),
    systemctlBin: str('AGENT_HUB_SYSTEMCTL_BIN', 'systemctl'),

    logLevel: str('AGENT_HUB_LOG_LEVEL', 'info'),
    hostname: os.hostname(),
  };

  return Object.freeze(cfg);
}

/**
 * Problems that should stop the process, and warnings that should not.
 * Separated from loadConfig so tests can inspect a config without it exiting.
 * @param {Config} cfg
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateConfig(cfg) {
  const errors = [];
  const warnings = [];

  // A control surface reachable off-box with no token is remote shell access
  // for anyone who can route to the port. Refuse to start rather than warn.
  const localOnly = cfg.bind === '127.0.0.1' || cfg.bind === 'localhost' || cfg.bind === '::1';
  if (!localOnly && !cfg.token) {
    errors.push(
      `AGENT_HUB_BIND is ${cfg.bind} (not loopback) but AGENT_HUB_TOKEN is empty. ` +
        'Set a token, or bind 127.0.0.1 and put a Cloudflare Tunnel in front.',
    );
  }
  if (cfg.token && cfg.token.length < 16) {
    errors.push('AGENT_HUB_TOKEN is shorter than 16 characters — generate one with `openssl rand -hex 24`.');
  }

  if (!cfg.telegram.token) {
    warnings.push('No AGENT_HUB_TELEGRAM_TOKEN — the Telegram adapter is disabled.');
  } else if (cfg.telegram.allowedUsers.length === 0) {
    warnings.push(
      'AGENT_HUB_TELEGRAM_ALLOWED_USERS is empty — the bot will refuse every command except /whoami. ' +
        'Message the bot /whoami, then add the id it returns.',
    );
  }
  if (!cfg.telegram.token && !cfg.webEnabled) {
    warnings.push('Neither Telegram nor the web UI is enabled — only the CLI can drive this hub.');
  }

  return { errors, warnings };
}
