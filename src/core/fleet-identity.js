// This box's place in the fleet, from a chat message.
//
// A host joins a fleet by presenting its public key with a six-digit pin. The
// pin comes from somebody already in — the app mints it — and it is spent on
// the box itself. Which leaves one question this file answers: how does it get
// spent without SSHing in?
//
// The same way everything else here works. `/enroll 123456` in Telegram runs
// the sidecar's own enrol path in-process, on the box the bot is running on.
// Nothing about the fleet's credentials passes through the chat: the pin buys
// exactly one exchange and is worthless afterwards, and the private key is
// generated locally and never leaves.
//
// WHAT THIS DELIBERATELY CANNOT DO. It cannot mint a pin, list other hosts, or
// revoke anything. Those are the coordinator's, and doing them from here would
// mean every box in the fleet held a fleet-wide admin credential — which is the
// shared secret this whole rework removed. This box can speak for itself and
// for nothing else.

import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  loadOrCreateKey,
  enrol as enrolAtCoordinator,
  checkEnrolled,
  keyFingerprint,
} from '../fleet/host/identity.js';
import { loadSidecarConfig } from '../fleet/host/config.js';

/**
 * Read the sidecar's configuration the way the sidecar does.
 *
 * From the environment, which under systemd is /etc/agent-fleet-sidecar.env —
 * except that agent-hub is a DIFFERENT unit with a different EnvironmentFile,
 * so those variables are not in this process. Read the file.
 *
 * @param {{ env?: NodeJS.ProcessEnv, readFile?: (p: string) => string }} [opts]
 */
export function sidecarConfig({ env = process.env, readFile } = {}) {
  const file = env.AGENT_FLEET_SIDECAR_ENV || '/etc/agent-fleet-sidecar.env';
  /** @type {Record<string, string>} */
  const fromFile = {};
  try {
    const read = readFile || ((/** @type {string} */ p) => readFileSync(p, 'utf8'));
    for (const line of read(file).split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match) fromFile[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch {
    // No file is not an error: a box running from a checkout has these in its
    // environment instead, and one that has neither gets told so below.
  }
  // The process environment WINS over the file, so a test or a hand-run hub can
  // point at something else without editing /etc.
  return loadSidecarConfig({ ...fromFile, ...env });
}

/**
 * What this box is, in the fleet's terms.
 *
 * @param {{ config?: ReturnType<typeof sidecarConfig> }} [opts]
 */
export async function identity({ config } = {}) {
  const cfg = config || sidecarConfig();
  if (!cfg.coordinatorUrl) {
    return { ok: false, text: 'This box is not part of a fleet — AGENT_FLEET_COORDINATOR_URL is not set.' };
  }

  let key;
  try {
    key = await loadOrCreateKey(cfg.hostKeyFile);
  } catch (e) {
    return { ok: false, text: `Could not read this box's key: ${/** @type {Error} */ (e).message}` };
  }
  const fingerprint = await keyFingerprint(key.publicJwk);

  // Asking the coordinator, rather than reporting what is on disk. A key that
  // exists locally but was never presented, and one that has since been
  // revoked, look identical in the file and completely different on the wire.
  const known = await checkEnrolled({
    origin: cfg.coordinatorUrl,
    hostId: cfg.hostId,
    privateJwk: key.privateJwk,
  }).catch((e) => ({ ok: false, reason: /** @type {Error} */ (e).message }));

  const lines = [
    `Host       ${cfg.hostId}`,
    `Coordinator ${cfg.coordinatorUrl}`,
    `Key        ${fingerprint}`,
    known.ok ? 'Enrolled   yes' : `Enrolled   no — ${'reason' in known ? known.reason : ''}`,
  ];
  if (!known.ok) lines.push('', 'Mint a pin in the app, then send: /enroll 123456');
  return { ok: known.ok, text: lines.join('\n'), fingerprint, hostId: cfg.hostId };
}

/**
 * Spend a pin.
 *
 * @param {string} pin
 * @param {{ config?: ReturnType<typeof sidecarConfig>, actor?: string|null }} [opts]
 */
export async function enrol(pin, { config, actor = null } = {}) {
  const cfg = config || sidecarConfig();
  const code = String(pin || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, text: 'Send the six digits: /enroll 123456' };
  }
  if (!cfg.coordinatorUrl) {
    return { ok: false, text: 'This box has no coordinator set, so there is nothing to enrol with.' };
  }

  let key;
  try {
    key = await loadOrCreateKey(cfg.hostKeyFile);
  } catch (e) {
    return {
      ok: false,
      text:
        `Could not use this box's key: ${/** @type {Error} */ (e).message}\n\n` +
        `The key lives at ${cfg.hostKeyFile}, and the hub has to be able to read it — ` +
        'which means running as the same user as the sidecar.',
    };
  }

  try {
    const result = await enrolAtCoordinator({
      origin: cfg.coordinatorUrl,
      code,
      hostId: cfg.hostId,
      publicJwk: key.publicJwk,
    });
    const fingerprint = await keyFingerprint(key.publicJwk);
    return {
      ok: true,
      text:
        `${result.replaced ? 'Re-enrolled' : 'Enrolled'} ${cfg.hostId} at ${cfg.coordinatorUrl}.\n` +
        `Key ${fingerprint}\n\n` +
        (result.replaced ? 'The key this host had registered before no longer works.\n\n' : '') +
        'Restart the sidecar to connect: /logs sidecar will show it.',
      fingerprint,
      actor,
    };
  } catch (e) {
    return { ok: false, text: `Enrolment failed: ${/** @type {Error} */ (e).message}` };
  }
}

/** Where the key file is, for messages that need to name it.
 *  @param {{ hostKeyFile: string }} cfg */
export function keyFileFor(cfg) {
  return path.resolve(cfg.hostKeyFile);
}
