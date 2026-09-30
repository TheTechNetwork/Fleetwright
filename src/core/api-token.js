// The credential that separates the sidecar from anything else on the box.
//
// fleetwright's HTTP API was unauthenticated whenever FLEETWRIGHT_TOKEN was unset,
// which is the default, and `http.js` justified it in one line: it only listens
// on loopback, so reaching it already implies a shell on the machine.
//
// THAT WAS TRUE WHEN THE API ONLY MANAGED SESSIONS. It is not true now. The v2
// verbs put credential-write on the same endpoint — `/api/command` will run
// `/link github <token>`, `/unlink`, `/peek` and `/reboot` — so a LOCAL UID
// THAT IS NEITHER ROOT NOR THE SERVICE USER can now write a credential into
// somebody's row, read any pane, and reboot the box, without ever being able to
// read a single one of this service's files.
//
// "Already implies a shell" was never the same claim as "already implies the
// service user's shell", and the gap between them is every other account on the
// machine: a CI runner, a second operator, a web server, anything a container
// escaped into. On a single-operator box the difference is nothing. On a shared
// one it is the whole thing.
//
// So there is always a token now. Generated rather than asked for, because the
// standing goal is that spinning up a host asks no questions — an operator who
// has to invent a secret and put it in two files is an operator who will put it
// in one.
//
// IT IS NOT LOGGED. `logs` reaches a phone, so the journal is no longer a
// place only somebody with the box can read; the startup line names the FILE
// and the operator reads it themselves.
//
// TWO TOKENS NOW, NOT ONE. The operator's token above opens everything: the
// web UI, every command, `/login force` included. The sidecar used to hold that
// same token, and hardening.md called it the sidecar's whole privilege — a
// compromised sidecar could not read a member's credential file after #270,
// and could still write one and start a session as anyone, because the token
// said so. So the hub mints a SECOND token, `sidecar-token`, beside the first,
// and http.js knows which one a request carried: the sidecar's opens exactly
// the routes the sidecar calls and, on /api/command, exactly the command
// shapes src/fleet/host/sidecar.js builds (src/core/sidecar-scope.js). It is
// not the web UI's, and `/login force` is not on its list.
//
// AND IT IS THE ANSWER TO A GAP #270 OPENED. The sidecar found the hub's token
// by reading `api-token` out of the hub's state directory — fine while both
// ran as one user, and impossible once the sidecar had its own account and the
// directory was 0750 for somebody else. A fresh separate-user install had a
// sidecar with nothing to send and a hub that refuses an empty credential, by
// design. install.sh, which runs as root, now writes the sidecar token into
// /etc/fleetwright-sidecar.env, and the sidecar's own fallback reads
// `sidecar-token` before `api-token` where it can read either.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { log } from '../log.js';

/** Where the generated token lives when one was not configured.
 * @param {string} stateDir */
export function apiTokenFile(stateDir) {
  return path.join(stateDir, 'api-token');
}

/** Where the sidecar's own token lives — see the header.
 * @param {string} stateDir */
export function sidecarTokenFile(stateDir) {
  return path.join(stateDir, 'sidecar-token');
}

/**
 * The token this box's API requires, generating one the first time.
 *
 * An explicitly configured `FLEETWRIGHT_TOKEN` always wins and is never written
 * to disk — somebody who set it has their own custody arrangement and does not
 * need a second copy of it in our state directory.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {string}
 */
export function ensureApiToken(cfg) {
  if (cfg.token) return cfg.token;
  const file = apiTokenFile(cfg.stateDir);
  const existing = readApiToken(cfg.stateDir);
  if (existing) return existing;

  // 32 bytes of hex. Long enough that the timing-safe comparison in http.js is
  // the only interesting attack surface, and short enough to paste.
  const token = mint();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  log.info(`http: generated an API token at ${file} — the local web UI needs it as ?token=…`);
  return token;
}

/**
 * The sidecar's token, generating one the first time. Always generated, never
 * configured: an explicit FLEETWRIGHT_TOKEN is the operator's, and the point
 * of this one is that it is not.
 *
 * The installer may have written the file first — it runs as root before the
 * hub has started, and needs the value for the sidecar's env — in which case
 * this reads what it wrote. Same file, same mode, either author.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {string}
 */
export function ensureSidecarToken(cfg) {
  const file = sidecarTokenFile(cfg.stateDir);
  const existing = readSidecarToken(cfg.stateDir);
  if (existing) return existing;
  const token = mint();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  log.info(`http: generated the sidecar's token at ${file} — install.sh copies it into the sidecar's env`);
  return token;
}

/**
 * The sidecar's token, or null. Same rules as readApiToken.
 * @param {string} stateDir
 * @returns {string|null}
 */
export function readSidecarToken(stateDir) {
  return readTokenFile(sidecarTokenFile(stateDir));
}

function mint() {
  return randomBytes(24).toString('hex');
}

/**
 * Read the generated token, or null.
 *
 * REFUSES A LOOSENED FILE rather than reading it, matching what
 * `host/identity.js` does for the host key. A credential whose mode was widened
 * by a backup-restore or a stray chmod is one every other account on the box
 * can read, and continuing to use it is how that stays invisible.
 *
 * @param {string} stateDir
 * @returns {string|null}
 */
export function readApiToken(stateDir) {
  return readTokenFile(apiTokenFile(stateDir));
}

/** @param {string} file @returns {string|null} */
function readTokenFile(file) {
  if (!existsSync(file)) return null;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    // Tightened rather than refused, because unlike a host key this one is ours
    // to reissue and an unreadable API is a box nobody can drive. The warning
    // is the point: something loosened it, and that is worth knowing.
    log.warn(`http: ${file} was mode ${mode.toString(8)} — tightening to 600. Something widened it.`);
    try {
      chmodSync(file, 0o600);
    } catch { /* not ours to fix; the warning still stands */ }
  }
  const token = readFileSync(file, 'utf8').trim();
  return token || null;
}
