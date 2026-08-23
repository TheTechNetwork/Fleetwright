// Sidecar configuration: one place that turns environment variables into a
// frozen, validated object.
//
// Same posture as agent-hub's config.js — everything else takes the config as
// an argument, so a test constructs one by hand and nothing reads process.env
// behind your back. Deployment supplies these through a systemd
// EnvironmentFile, next to the one agent-hub already reads.

import os from 'node:os';
import { REPLAY_TTL_MS } from './sidecar.js';

/** @typedef {ReturnType<typeof loadSidecarConfig>} SidecarConfig */

/** @param {NodeJS.ProcessEnv} env @param {string} name @param {string} [fallback] */
const str = (env, name, fallback = '') => {
  const v = env[name];
  return v === undefined || v === '' ? fallback : v;
};

/** @param {NodeJS.ProcessEnv} env @param {string} name @param {number} fallback */
const int = (env, name, fallback) => {
  const v = parseInt(env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
};

/** @param {NodeJS.ProcessEnv} env @param {string} name */
const list = (env, name) =>
  str(env, name)
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** @param {NodeJS.ProcessEnv} [env] */
export function loadSidecarConfig(env = process.env) {
  return Object.freeze({
    // --- the agent-hub this sidecar drives ---------------------------------
    // Loopback by default, because that is where agent-hub binds and the
    // sidecar is meant to run on the same box. Pointing this off-box is
    // possible but means agent-hub is listening on a routable interface, which
    // its own config refuses without a token.
    hubUrl: str(env, 'AGENT_FLEET_HUB_URL', 'http://127.0.0.1:8790'),
    // Whatever AGENT_HUB_TOKEN the hub was configured with. Empty is valid: a
    // loopback-bound hub with no token needs none. Holding this is the
    // sidecar's real privilege — /api/command runs any line it is given.
    hubToken: str(env, 'AGENT_FLEET_HUB_TOKEN') || null,
    // Generous, and matching agent-hub's own CLI: a start waits out the Remote
    // Control check, a resume waits for the dialog to render.
    hubCommandTimeoutMs: Math.max(5_000, int(env, 'AGENT_FLEET_HUB_COMMAND_TIMEOUT_MS', 300_000)),
    hubReadTimeoutMs: Math.max(1_000, int(env, 'AGENT_FLEET_HUB_READ_TIMEOUT_MS', 10_000)),

    // --- the coordinator ----------------------------------------------------
    // §5: the agent pins the expected coordinator origin. The sidecar refuses
    // to start without one — a transport that will talk to whoever answers is
    // the same shape of mistake as accepting command strings.
    coordinatorUrl: str(env, 'AGENT_FLEET_COORDINATOR_URL'),
    // `websocket` is the real one: a persistent outbound connection, so nothing
    // on this box ever listens. `stdio` speaks the same protocol over
    // stdin/stdout and exists for driving the sidecar by hand.
    transport: str(env, 'AGENT_FLEET_TRANSPORT', 'websocket'),
    // This box's private key, 0600 on disk. Nothing derived from it is reusable:
    // connecting means signing a nonce the coordinator issued seconds earlier.
    // It replaces AGENT_FLEET_HOST_TOKEN, which was one shared string that
    // could not tell two hosts apart and could not be revoked for one of them.
    hostKeyFile: str(env, 'AGENT_FLEET_HOST_KEY', '/var/lib/agent-fleet/host-key.json'),

    // --- this host ----------------------------------------------------------
    hostId: str(env, 'AGENT_FLEET_HOST_ID', os.hostname()),
    // Constraint labels the scheduler filters on before it ranks by capacity
    // (§3) — e.g. "gpu", "debian13", "has-monorepo".
    labels: list(env, 'AGENT_FLEET_LABELS'),

    // How far from now an intent's issuedAt may be. Bounds replay on top of the
    // idempotency key. Must stay below the replay cache TTL — see the check in
    // Sidecar's constructor for why. Set 0 to disable, which is right if the
    // host clock is not reliably synchronised.
    maxSkewMs: Math.max(0, int(env, 'AGENT_FLEET_MAX_SKEW_MS', 300_000)),

    // May a notification quote the session — a path, a command line — or only
    // the question this fleet wrote? Off by default: the fuller form reaches a
    // lock screen through somebody else's servers, and the fleet may not belong
    // to the person holding the phone. See src/fleet/host/prompt.js.
    promptText: str(env, 'AGENT_FLEET_PROMPT_TEXT', '0') === '1',

    // --- the per-session hook socket ---------------------------------------
    // Where the sockets bind-mounted into sandboxes live. See host/hook-socket.js.
    hookSocketDir: str(env, 'AGENT_FLEET_HOOK_SOCKET_DIR', '/run/agent-fleet'),
    hookSocketsEnabled: str(env, 'AGENT_FLEET_HOOK_SOCKETS', '1') !== '0',

    logLevel: str(env, 'AGENT_FLEET_LOG_LEVEL', 'info'),
  });
}

/**
 * Problems that should stop the process, and warnings that should not.
 * Separated from loadSidecarConfig so a test can inspect a config without it
 * exiting.
 *
 * @param {SidecarConfig} cfg
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateSidecarConfig(cfg) {
  /** @type {string[]} */ const errors = [];
  /** @type {string[]} */ const warnings = [];

  if (!cfg.coordinatorUrl) {
    errors.push(
      'AGENT_FLEET_COORDINATOR_URL is empty. The sidecar pins the coordinator it will talk to and ' +
        'refuses to start without one; use a placeholder like "stdio:local" for the stdio transport.',
    );
  }
  if (cfg.maxSkewMs >= REPLAY_TTL_MS) {
    errors.push(
      `AGENT_FLEET_MAX_SKEW_MS (${cfg.maxSkewMs}) must be below the replay cache TTL (${REPLAY_TTL_MS}), ` +
        'or a replayed intent can arrive after the cache has forgotten it and run a second time.',
    );
  }
  if (cfg.maxSkewMs === 0) {
    warnings.push(
      'AGENT_FLEET_MAX_SKEW_MS is 0 — intent freshness is not checked, so replay protection rests ' +
        'entirely on the idempotency cache and its 10-minute window.',
    );
  }

  try {
    const u = new URL(cfg.hubUrl);
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
    if (!loopback && !cfg.hubToken) {
      errors.push(
        `AGENT_FLEET_HUB_URL points off-box (${u.hostname}) with no AGENT_FLEET_HUB_TOKEN. ` +
          '/api/command runs any command line it is given; do not reach it unauthenticated.',
      );
    }
    if (!loopback) {
      warnings.push(
        `AGENT_FLEET_HUB_URL is ${u.hostname}, not loopback. The sidecar is designed to sit on the same ` +
          'box as agent-hub; anything else means that control port is on a routable interface.',
      );
    }
  } catch {
    errors.push(`AGENT_FLEET_HUB_URL is not a valid URL: ${cfg.hubUrl}`);
  }

  if (!['stdio', 'websocket'].includes(cfg.transport)) {
    errors.push(`AGENT_FLEET_TRANSPORT="${cfg.transport}" is not implemented. Available: websocket, stdio.`);
  }

  if (cfg.transport === 'websocket') {
    try {
      const u = new URL(cfg.coordinatorUrl);
      if (!['http:', 'https:'].includes(u.protocol)) {
        errors.push(`AGENT_FLEET_COORDINATOR_URL must be http(s) for the websocket transport, got ${u.protocol}`);
      } else if (u.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(u.hostname)) {
        // The proof on the wire is single-use, so a listener learns nothing it
        // can replay — but everything after the upgrade is session content, and
        // an active attacker on a cleartext path can still be the coordinator.
        warnings.push(
          `AGENT_FLEET_COORDINATOR_URL is plain http to ${u.hostname} — session output crosses the network ` +
            'in clear, and nothing authenticates the far end. Use https for anything that is not loopback.',
        );
      }
    } catch {
      /* the empty/invalid case is already reported above */
    }
  }

  return { errors, warnings };
}
