// A machine from somebody's hypervisor joining the fleet, from the inside.
// docs/hypervisors.md, "Machines from your pool".
//
// The box that made the machine booted it with one file (xo-pools.js,
// machineCloudConfig), which the join script moves beside this process's key
// and names in FLEETWRIGHT_VM_JOIN (install/fleetwright-vm-join). It holds
// the coordinator, a single-use ticket, whose machine this is, that person's
// Claude login, and how long the machine lives.
//
// THE SIDECAR ENROLS ITSELF, ONCE. A permanent box is enrolled by a person
// with a pin, and `enrol` is deliberately a command rather than something
// the service does on start: a service that enrolled itself could be talked
// into enrolling somewhere else. Here nobody is at the machine, and the
// ticket is single-use and spent on the first start: it is removed from the
// file the moment the coordinator has taken it, so a restart has nothing to
// enrol with and dials under the name it was given, like any other host.
//
// THE POOL'S OWN MACHINE joins the same way with a pin instead of a ticket:
// a permanent host, under the name the coordinator bound the pin to
// (core.js, #onHolderPin), and nobody's temporary machine. The policy job
// that cloned it asked for the pin just before it did. It holds nothing
// until its owner approves it on the phone, like any other box.

import { readFileSync, writeFileSync, rmSync } from 'node:fs';

import { recordAssignedName, enrol } from './identity.js';

const TICKET_RE = /^fwt_[0-9a-f]{12}_[0-9a-f]{48}$/;
const PIN_RE = /^\d{6}$/;
const HOLDER_ID_RE = /^holder-[0-9a-f]{6}$/;
const CLAUDE_RE = /^[A-Za-z0-9._~+/=-]{20,2048}$/;

/**
 * @typedef {{ v?: number, coordinator?: string, ticket?: string|null, owner?: string, claude?: string|null, minutes?: number, pin?: string|null, hostId?: string, holder?: string }} JoinFile
 */

/** @param {string} file @returns {JoinFile|null} */
export function readJoin(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/**
 * Enrol this machine with the ticket it was booted with, if it still has
 * one, and record the name the coordinator gave it. Answers that name, or
 * null when there was nothing to enrol with (already done).
 *
 * @param {{ file: string, origin: string, hostKeyFile: string, publicJwk: any, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<string|null>}
 */
export async function enrolVmOnce({ file, origin, hostKeyFile, publicJwk, fetchImpl = globalThis.fetch }) {
  const join = readJoin(file);
  const pin = typeof join?.pin === 'string' ? join.pin : '';
  const named = typeof join?.hostId === 'string' ? join.hostId : '';
  if (PIN_RE.test(pin) && HOLDER_ID_RE.test(named)) {
    // Spent either way, as the ticket below: a pin is redeemed before
    // anything that can fail after it.
    writeFileSync(file, `${JSON.stringify({ ...join, pin: null })}\n`, { mode: 0o600 });
    const body = await enrol({ origin, code: pin, hostId: named, publicJwk, fetchImpl });
    const hostId = typeof body?.hostId === 'string' ? body.hostId : named;
    recordAssignedName(hostKeyFile, { hostId, origin });
    return hostId;
  }
  const ticket = typeof join?.ticket === 'string' ? join.ticket : '';
  if (!TICKET_RE.test(ticket)) return null;
  const res = await fetchImpl(new URL('/api/enroll/vm', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket, publicJwk }),
  });
  const body = /** @type {any} */ (await res.json().catch(() => null));
  // SPENT EITHER WAY: the coordinator redeems a ticket before anything that
  // can fail after it, so a refused one is gone too, and trying it again on
  // every restart would only fill the journal.
  writeFileSync(file, `${JSON.stringify({ ...join, ticket: null })}\n`, { mode: 0o600 });
  if (!res.ok || !body?.ok || typeof body.hostId !== 'string') {
    throw new Error(body?.text || `the coordinator refused this machine (${res.status})`);
  }
  recordAssignedName(hostKeyFile, { hostId: body.hostId, origin });
  return body.hostId;
}

/**
 * Whose machine this is and the Claude login it runs on, for the hub, or
 * null when the file has been handed over already.
 *
 * @param {string} file
 * @returns {{ email: string, token: string|null }|null}
 */
export function vmLogin(file) {
  const join = readJoin(file);
  const email = typeof join?.owner === 'string' ? join.owner.toLowerCase() : '';
  if (!email) return null;
  const token = typeof join?.claude === 'string' && CLAUDE_RE.test(join.claude) ? join.claude : null;
  return { email, token };
}

/**
 * The file, once the hub has the login: nothing in it is needed again.
 *
 * @param {string} file
 */
export function forgetJoin(file) {
  rmSync(file, { force: true });
}
