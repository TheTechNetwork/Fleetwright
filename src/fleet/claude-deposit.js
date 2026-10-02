// Depositing your Claude login with the fleet's minting Worker, from your own
// computer. bin/fleetwright-claude-login is the command; this is what it does.
//
// THE ONE CHECK THAT MATTERS HAPPENS HERE, before anything is sent: the key
// the login is sealed to must be the minter's, and not one the coordinator
// chose. The tool learns it from something the coordinator does not answer:
// the minter's own path on the fleet's address (KEY_PATH in
// worker/src/minter.js, routed past the coordinator by the deploy), or a PIN
// your operator gave you, which wins when set. The coordinator also says what
// the key is, and that is useful for exactly one thing: noticing when it says
// something different. A coordinator that swapped in its own key would
// otherwise receive a login it could open; refusing a mismatch is what makes
// "the coordinator relays it unread" true rather than hoped.
//
// Sealed inside, beside the Claude token: a GitHub token of yours, which the
// minter uses once to ask GitHub whose account this is — that account's
// runners are the only ones the login will go to — and does not keep; and the
// time, so a copy replayed later is refused (src/fleet/minter/claude.js).

import { SEAL_KEY_RE, DEPOSIT_AAD, seal } from './seal.js';

/** Where the minting Worker answers for its own key, on the fleet's address. */
export const MINTER_KEY_PATH = '/.well-known/fleetwright-minter';

/**
 * The minter's key, from the minter itself at the fleet's address, or null
 * when nothing there answers with one: a fleet whose deploy gave the minter no
 * route, where the request reaches the coordinator and the coordinator has no
 * such path. Null is CANNOT TELL, and the caller asks for the pin.
 *
 * @param {string} base  the fleet's origin @param {typeof globalThis.fetch} fetchImpl
 * @returns {Promise<string|null>}
 */
export async function lookUpMinterKey(base, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${String(base || '').replace(/\/+$/, '')}${MINTER_KEY_PATH}`, { headers: { accept: 'application/json' } });
    /** @type {any} */
    const r = res.ok ? await res.json().catch(() => null) : null;
    return r?.ok === true && SEAL_KEY_RE.test(String(r.key || '')) ? String(r.key) : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ coordinator: string, credential: string, pin: string|null, claude: string|null, github: string,
 *   fetchImpl?: typeof globalThis.fetch, now?: () => number }} args
 *   `claude` null forgets the login kept for your GitHub account
 * @returns {Promise<{ ok: boolean, code?: string, key?: string, login?: string, text: string }>}
 */
export async function depositClaudeLogin({ coordinator, credential, pin, claude, github, fetchImpl = fetch, now = () => Date.now() }) {
  const base = String(coordinator || '').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${credential}`, 'content-type': 'application/json' };
  /** @param {Response} res */
  const body = async (res) => /** @type {any} */ (await res.json().catch(() => ({})));

  const said = await body(await fetchImpl(`${base}/api/claude-login`, { headers }));
  if (said?.ok !== true || !SEAL_KEY_RE.test(String(said.key || ''))) {
    return { ok: false, code: String(said?.error?.code || 'no_key'), text: String(said?.text || 'The fleet did not say which key to seal to.') };
  }
  const minter = pin || (await lookUpMinterKey(base, fetchImpl));
  if (!minter) {
    return {
      ok: false,
      code: 'no_pin',
      key: said.key,
      text:
        `This fleet's minter does not answer for its own key at ${base}${MINTER_KEY_PATH}, and the fleet says it is\n\n  ${said.key}\n\n` +
        'Check that with whoever runs your fleet, by a route that is not the fleet, then run this again with ' +
        'FLEETWRIGHT_MINTER_KEY set to it. Nothing was sent.',
    };
  }
  if (said.key !== minter) {
    if (!pin) {
      return {
        ok: false,
        code: 'key_mismatch',
        key: said.key,
        text:
          `The fleet offered a key that is not the one its minter gives, so nothing was sent.\n\n  offered  ${said.key}\n  minter   ${minter}\n\n` +
          'Something between you and the minter wants to read your login. Tell whoever runs your fleet.',
      };
    }
    return {
      ok: false,
      code: 'key_mismatch',
      key: said.key,
      text:
        `The fleet offered a key that is not your pin, so nothing was sent.\n\n  offered  ${said.key}\n  pinned   ${pin}\n\n` +
        'Either the minter was given a new key — ask whoever runs your fleet for the new pin — or something between you and it wants to read your login.',
    };
  }

  const sealed = await seal({ to: minter, aad: DEPOSIT_AAD, payload: { v: 1, github, claude, at: now() } });
  const r = await body(await fetchImpl(`${base}/api/claude-login`, { method: 'PUT', headers, body: JSON.stringify({ sealed }) }));
  return r?.ok === true
    ? { ok: true, login: String(r.login || ''), text: String(r.text || 'Done.') }
    : { ok: false, code: String(r?.error?.code || 'refused'), text: String(r?.text || 'The fleet refused it.') };
}
