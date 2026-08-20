// This machine's key, and how it gets one.
//
// A host keeps a P-256 private key in a file only it can read, and the
// coordinator keeps the public half. Connecting is signing a nonce; nothing
// reusable ever leaves the box. That replaces AGENT_FLEET_HOST_TOKEN, which
// was the same string on every machine — unable to distinguish two hosts,
// unable to revoke one, and replayable by anything that saw a single
// connection.
//
// The key never leaves this file's directory and is never sent anywhere. What
// is sent, once, at enrolment, is the public half.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';

import { generateKeyPair, sign, fingerprint, signingInput } from '../crypto.js';
import { log } from '../../log.js';

/**
 * Load this host's key, creating one the first time.
 *
 * Written 0600 in a 0700 directory, and the permissions are CHECKED on every
 * load rather than only set on creation. A key file that became readable —
 * a careless chmod, a restore from a backup, a package manager resetting a
 * directory — is worth refusing to start over, because the alternative is a
 * fleet credential sitting world-readable and nothing saying so.
 *
 * @param {string} file
 */
export async function loadOrCreateKey(file) {
  const dir = path.dirname(file);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      // The usual cause is a box upgraded in place: the unit file gained
      // StateDirectory=agent-fleet, but the copy in /etc/systemd/system is only
      // refreshed by the installer, so nothing has created the directory and an
      // unprivileged service cannot create it under /var/lib itself. EACCES on
      // a path nobody mentioned is a crash loop with an obscure message
      // attached, so say what to run.
      throw new Error(
        `could not create ${dir}: ${/** @type {Error} */ (e).message}\n` +
          '  This box has no state directory for its key yet. Either re-run install.sh, or:\n' +
          `    sudo install -d -m 0700 -o "$(id -un)" ${dir}`,
      );
    }
  }

  if (existsSync(file)) {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `${file} is mode ${mode.toString(8)} — a host key must not be readable by anyone else.\n` +
          `  chmod 600 ${file}`,
      );
    }
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (!stored?.privateJwk?.d) throw new Error(`${file} does not contain a host key`);
    return { ...stored, created: false };
  }

  const keys = await generateKeyPair();
  const record = { privateJwk: keys.privateJwk, publicJwk: keys.publicJwk, createdAt: Date.now() };
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  log.info(`host key created at ${file}`);
  return { ...record, created: true };
}

/**
 * Present the public half to a coordinator, spending an enrolment code.
 *
 * @param {{ origin: string, code: string, hostId: string, publicJwk: any, fetchImpl?: typeof fetch }} spec
 */
export async function enrol({ origin, code, hostId, publicJwk, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(`${origin.replace(/\/$/, '')}/api/enroll/host`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: String(code).replace(/\s+/g, ''), hostId, publicJwk }),
  });
  const body = /** @type {any} */ (await res.json().catch(() => null));
  if (!res.ok || !body?.ok) {
    throw new Error(body?.text || `enrolment failed: ${res.status}`);
  }
  return body;
}

/**
 * Answer a coordinator's challenge.
 *
 * Two round trips before the socket opens — ask for a nonce, sign it — which is
 * the cost of nothing reusable being on the wire. It happens once per
 * connection, and a host reconnects on the order of minutes at worst.
 *
 * @param {{ origin: string, hostId: string, privateJwk: any, fetchImpl?: typeof fetch }} spec
 */
export async function proveIdentity({ origin, hostId, privateJwk, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const res = await doFetch(`${origin.replace(/\/$/, '')}/api/host/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId }),
  });
  if (!res.ok) throw new Error(`could not get a challenge: ${res.status}`);
  const { nonce } = /** @type {any} */ (await res.json());
  if (!nonce) throw new Error('the coordinator issued no challenge');

  return sign(privateJwk, signingInput('host-connect', { hostId, nonce }));
}

/**
 * Ask a coordinator whether it would accept this host, without connecting.
 *
 * What `doctor` needs: "the key on disk is enrolled and not revoked" is not
 * something a host can determine by itself, and the alternative diagnosis is
 * reading a reconnect loop out of the journal.
 *
 * @param {{ origin: string, hostId: string, privateJwk: any, fetchImpl?: typeof fetch }} spec
 */
export async function checkEnrolled({ origin, hostId, privateJwk, fetchImpl }) {
  const doFetch = fetchImpl || globalThis.fetch;
  const proof = await proveIdentity({ origin, hostId, privateJwk, fetchImpl });
  const res = await doFetch(`${origin.replace(/\/$/, '')}/api/host/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId, proof }),
  });
  const body = /** @type {any} */ (await res.json().catch(() => null));
  if (!res.ok || !body?.ok) return { ok: false, reason: body?.text || `coordinator said ${res.status}` };
  return { ok: true, fingerprint: body.fingerprint };
}

/** @param {any} publicJwk */
export function keyFingerprint(publicJwk) {
  return fingerprint(publicJwk);
}
