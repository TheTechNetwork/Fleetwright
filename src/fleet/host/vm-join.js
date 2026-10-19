// A machine from somebody's hypervisor joining the fleet, from the inside.
// docs/hypervisors.md, "Machines from your pool".
//
// The box that made the machine booted it with one file (xo-pools.js,
// machineCloudConfig), which the join script moves beside this process's key
// and names in FLEETWRIGHT_VM_JOIN (install/fleetwright-vm-join). It holds
// the coordinator, a single-use ticket, whose machine this is, and how long
// the machine lives.
//
// NOT THE CLAUDE LOGIN ANY MORE. Every box holding the pool's token may
// export a machine's cloud-init drive through Xen Orchestra until it is
// destroyed after boot (docs/security.md, G14), so the sidecar asks for the
// login once this machine has enrolled, and the box that made it hands it
// over sealed to this machine (sidecar.js, #handVmLogin). A file from a box
// older than that still carries it as `claude`, and it is used as given.
//
// THE SIDECAR ENROLS ITSELF, ONCE. A permanent box is enrolled by a person
// with a pin, and `enrol` is deliberately a command rather than something
// the service does on start: a service that enrolled itself could be talked
// into enrolling somewhere else. Here nobody is at the machine, and the
// ticket is single-use and spent on the first start: it is removed from the
// file the moment the coordinator has taken it, so a restart has nothing to
// enrol with and dials under the name it was given, like any other host.
//
// THE POOL'S OWN MACHINE asks to join instead, when the person's phone gave
// the policy job a secret for it (src/fleet/protocol/holder-join.js): under
// the name the coordinator reserved for it (core.js, #onHolderPin), with the
// key it made here and a proof of the secret, and it waits until its owner
// has checked that proof and let it in from the phone, one approval that
// also lets it hold the pool. A machine made from an image older than this
// file does not read the secret, and joins as it always did, with the pin the
// job asked for just before it cloned the machine, which is why the job still
// asks for one: a permanent host, and nobody's temporary machine, that holds
// nothing until approved.

import { readFileSync, writeFileSync, rmSync } from 'node:fs';

import { recordAssignedName, enrol, checkEnrolled } from './identity.js';
import { HOLDER_ID_RE, HOLDER_SECRET_RE, keyHashOf, proofOf } from '../protocol/holder-join.js';

const TICKET_RE = /^fwt_[0-9a-f]{12}_[0-9a-f]{48}$/;
const PIN_RE = /^\d{6}$/;
const CLAUDE_RE = /^[A-Za-z0-9._~+/=-]{20,2048}$/;

/**
 * @typedef {{ v?: number, coordinator?: string, ticket?: string|null, owner?: string, claude?: string|null, minutes?: number, pin?: string|null, hostId?: string, holder?: string, secret?: string|null }} JoinFile
 */

/** How often a machine waiting to be let in checks, and asks again. */
export const HOLDER_WAIT = Object.freeze({ checkMs: 60_000, askMs: 10 * 60_000, forMs: 24 * 60 * 60_000 });

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
  // ASKING, NOT A PIN, when the person's phone gave the job a secret for this
  // machine (src/fleet/protocol/holder-join.js): the pin runs out in ten
  // minutes and a first boot can take longer, which is how a holder sat
  // outside the fleet for good. The pin is dropped unused, and the machine
  // dials under its name once its owner has let it in (waitToBeLetIn).
  if (HOLDER_ID_RE.test(named) && holderAsking(join)) {
    if (pin) writeFileSync(file, `${JSON.stringify({ ...join, pin: null })}\n`, { mode: 0o600 });
    recordAssignedName(hostKeyFile, { hostId: named, origin });
    await askToJoin({ origin, join: /** @type {JoinFile} */ (join), publicJwk, fetchImpl }).catch(() => null);
    return named;
  }
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

/** Whether the file says to ask to join, with a secret and the pool it holds. @param {JoinFile|null} join */
function holderAsking(join) {
  return typeof join?.secret === 'string' && HOLDER_SECRET_RE.test(join.secret) && typeof join.holder === 'string' && join.holder.length > 0;
}

/**
 * Ask once, with this machine's key and the proof the secret makes. Answers
 * the coordinator's sentence; throws when it could not be asked at all.
 *
 * @param {{ origin: string, join: JoinFile, publicJwk: any, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ ok: boolean, code: string|null, text: string }>}
 */
export async function askToJoin({ origin, join, publicJwk, fetchImpl = globalThis.fetch }) {
  const hostId = String(join.hostId);
  const address = String(join.holder);
  const key = { kty: 'EC', crv: 'P-256', x: String(publicJwk.x), y: String(publicJwk.y) };
  const proof = await proofOf(String(join.secret), { hostId, address, keyHash: await keyHashOf(key) });
  const res = await fetchImpl(new URL('/api/holder/join', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostId, publicJwk: key, proof }),
  });
  const body = /** @type {any} */ (await res.json().catch(() => null));
  return { ok: res.ok && body?.ok === true, code: body?.error?.code ?? null, text: String(body?.text || `the coordinator said ${res.status}`) };
}

/**
 * WAIT TO BE LET IN, before dialling: a machine nobody has let in yet would
 * be refused on every dial, and each refusal is a line in the fleet's event
 * history. Checks without connecting every minute (checkEnrolled, which
 * records nothing), asks again every ten, as a request pushed out by
 * strangers' needs to, and gives up after the day its name is held for.
 * Resolves true once it is in, when the secret is wiped from the file, or
 * false at the end of the day. Nothing to wait for answers true at once.
 *
 * @param {{ file: string, origin: string, hostId: string, publicJwk: any, privateJwk: any, fetchImpl?: typeof fetch, log?: { info: (s: string) => void, warn: (s: string) => void }, wait?: Partial<typeof HOLDER_WAIT>, sleep?: (ms: number) => Promise<void>, now?: () => number }} opts
 */
export async function waitToBeLetIn({ file, origin, hostId, publicJwk, privateJwk, fetchImpl = globalThis.fetch, log = { info() {}, warn() {} }, wait = {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const join = readJoin(file);
  if (!holderAsking(join) || join?.hostId !== hostId) return true;
  const { checkMs, askMs, forMs } = { ...HOLDER_WAIT, ...wait };
  const until = now() + forMs;
  let asked = now();
  log.info(`waiting for whoever made ${hostId} to let it in from their phone; it holds ${join?.holder}`);
  while (now() < until) {
    const known = await checkEnrolled({ origin, hostId, privateJwk, fetchImpl }).catch(() => null);
    if (known?.ok) {
      writeFileSync(file, `${JSON.stringify({ ...join, secret: null })}\n`, { mode: 0o600 });
      log.info(`${hostId} was let in`);
      return true;
    }
    if (now() - asked >= askMs) {
      asked = now();
      const r = await askToJoin({ origin, join: /** @type {JoinFile} */ (join), publicJwk, fetchImpl }).catch((e) => ({ ok: false, code: null, text: String(e?.message || e) }));
      if (!r.ok) log.warn(`asking to join again: ${r.text}`);
      if (r.code === 'not_reserved') break;
    }
    await sleep(checkMs);
  }
  log.warn(`${hostId} was not let in within the day its name was held for. Make it again from the pool's page.`);
  return false;
}

/**
 * Whose machine this is, for the hub, and the Claude login when the file
 * came from a box that still put one on the drive (null otherwise: it is
 * asked for), or null when the file has been handed over already.
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
