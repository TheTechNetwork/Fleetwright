// This box's place in the fleet, from a chat message.
//
// A host joins a fleet by presenting its public key with a six-digit pin. The
// pin comes from somebody already in — the app mints it — and it is spent on
// the box itself. Which leaves one question this file answers: how does it get
// spent without SSHing in?
//
// The same way everything else here works. `/enroll 123456` through the
// command registry — `fleetwright enroll 123456` on the box, or the web UI;
// it was Telegram's job until that adapter was archived — runs the sidecar's
// own enrol path in-process, on this box. Nothing about the fleet's
// credentials passes through the surface that typed it: the pin buys
// exactly one exchange and is worthless afterwards, and the private key is
// generated locally and never leaves.
//
// WHAT THIS DELIBERATELY CANNOT DO. It cannot mint a pin, list other hosts, or
// revoke anything. Those are the coordinator's, and doing them from here would
// mean every box in the fleet held a fleet-wide admin credential — which is the
// shared secret this whole rework removed. This box can speak for itself and
// for nothing else.
//
// WHAT IT CANNOT DO ANY MORE, SINCE THE SIDECAR GOT ITS OWN ACCOUNT (#270). The
// key and /etc/fleetwright-sidecar.env belong to `fleetwright-sidecar`, 0600,
// and this process runs as the session user — so on an installed box both
// reads fail with EACCES. That is the point of the split, not a fault to
// repair: whoever can read the key can be this machine, and the process that
// runs sessions must not. Both verbs then say whose the identity is and give
// the one line on the box that answers, rather than the old "re-run install.sh
// to fix the permissions", which would have undone the split. They still work
// where the two run as one user — a Mac, a runner, a checkout run by hand.

import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  loadOrCreateKey,
  enrol as enrolAtCoordinator,
  checkEnrolled,
  keyFingerprint,
} from '../fleet/host/identity.js';
import { loadSidecarConfig } from '../fleet/host/config.js';
import { preferExisting } from '../fleet/legacy-paths.js';

/**
 * Read the sidecar's configuration the way the sidecar does.
 *
 * From the environment, which under systemd is /etc/fleetwright-sidecar.env —
 * except that fleetwright is a DIFFERENT unit with a different EnvironmentFile,
 * so those variables are not in this process. Read the file.
 *
 * @param {{ env?: NodeJS.ProcessEnv, readFile?: (p: string) => string }} [opts]
 */
export function sidecarConfig({ env = process.env, readFile } = {}) {
  const file = env.FLEETWRIGHT_SIDECAR_ENV || preferExisting('/etc/fleetwright-sidecar.env', '/etc/agent-fleet-sidecar.env');
  /** @type {Record<string, string>} */
  const fromFile = {};
  /** @type {string|null} */
  let unreadable = null;
  try {
    const read = readFile || ((/** @type {string} */ p) => readFileSync(p, 'utf8'));
    for (const line of read(file).split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (match) fromFile[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch (e) {
    // A MISSING file is not an error: a box running from a checkout has these
    // in its environment instead. A file that exists and cannot be read is a
    // different thing entirely, and reporting it as "this box is not in a
    // fleet" would send somebody to configure something already configured.
    if (/** @type {any} */ (e)?.code !== 'ENOENT') unreadable = `${file}: ${/** @type {Error} */ (e).message}`;
  }
  // The process environment WINS over the file, so a test or a hand-run hub can
  // point at something else without editing /etc.
  return { ...loadSidecarConfig({ ...fromFile, ...env }), unreadable };
}

/**
 * What this box is, in the fleet's terms.
 *
 * @param {{ config?: ReturnType<typeof sidecarConfig> }} [opts]
 */
export async function identity({ config } = {}) {
  const cfg = config || sidecarConfig();
  if (!cfg.coordinatorUrl) {
    if (cfg.unreadable) return { ok: false, text: belongsToTheSidecar('identity', cfg.unreadable) };
    return { ok: false, text: 'This box is not part of a fleet — FLEETWRIGHT_COORDINATOR_URL is not set.' };
  }

  let key;
  try {
    key = await loadOrCreateKey(cfg.hostKeyFile);
  } catch (e) {
    const err = /** @type {Error & { code?: string }} */ (e);
    if (err.code === 'EACCES' || err.code === 'EPERM') return { ok: false, text: belongsToTheSidecar('identity', `${cfg.hostKeyFile}: ${err.message}`) };
    return { ok: false, text: `Could not read this box's key: ${err.message}` };
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
    return {
      ok: false,
      text: cfg.unreadable
        ? belongsToTheSidecar(`enrol ${code}`, cfg.unreadable)
        : 'This box has no coordinator set, so there is nothing to enrol with.',
    };
  }

  let key;
  try {
    key = await loadOrCreateKey(cfg.hostKeyFile);
  } catch (e) {
    const err = /** @type {Error & { code?: string }} */ (e);
    if (err.code === 'EACCES' || err.code === 'EPERM') return { ok: false, text: belongsToTheSidecar(`enrol ${code}`, `${cfg.hostKeyFile}: ${err.message}`) };
    return { ok: false, text: `Could not use this box's key: ${err.message}` };
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

/**
 * The answer when this process cannot read the sidecar's files: whose they
 * are, and the one line on the box that does what was asked.
 *
 * @param {string} verb  what to run as the sidecar's account
 * @param {string} why   the read that failed, path and message
 */
export function belongsToTheSidecar(verb, why) {
  return (
    "This box's fleet identity belongs to the sidecar's account, and this process cannot read it:\n" +
    `${why}\n\n` +
    'That is the split working (docs/hardening.md), not something to repair. On the box:\n' +
    `  sudo -u fleetwright-sidecar fleetwright-sidecar ${verb}\n` +
    (verb.startsWith('enrol') ? 'Or paste the install line the app shows beside the pin — it enrols as that account.' : '')
  ).trimEnd();
}
