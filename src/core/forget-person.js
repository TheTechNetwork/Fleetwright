// Everything this box keeps in one person's name, ended when they leave the
// fleet.
//
// THE COORDINATOR ASKS, THE SIDECAR CARRIES, THIS PROCESS DOES IT. A person
// removed from the fleet (core.js #forgetOnBoxes) is forgotten by each of the
// fleet's own boxes with one `forgetperson`, whose actor is the person; the
// sidecar sends their address here on the loopback, as it sends a vault
// answer, because every store below is this process's own files
// (http.js, /api/forget-person). Never from a session: a sandboxed session
// holds no token for this API, and the sidecar takes the address only from
// the actor of an intent that came down its coordinator socket and passed
// validateIntent.
//
// WHAT WENT ON IN THEIR NAME BEFORE THIS (ninth audit), each closed here:
//
//   sessions    kept running with their Remote Control link, and one that
//               ended with its box came back as them on the next boot. Each
//               is stopped, marked to stay down, and put in the bin, so an
//               admin can still bring back work removed by mistake while
//               the bin keeps it, and nothing restarts it by itself
//   Claude      `${stateDir}/accounts/<email>.json`, which the keepalive
//               renews on its timer for as long as it exists (keepalive.js)
//   GitHub,     `<email>.env` and its metadata, and `<email>.renewal.json`,
//   Cloudflare  the refresh token the hourly renewal the sidecar asks for
//               trades for a new access token with the fleet's client secret,
//               writing the row back however often it was emptied
//   the vault   what this box was given from their vault, which the minter
//               stops giving on its next ask; deleted now rather than then
//
// ONE PERSON'S FILES AND NOBODY ELSE'S. Each store is keyed by the address
// normalised as everywhere on this box (accounts.js normaliseEmail), and a
// session is theirs when its record says they started it (emailFromActor).
// Asked twice, or of a box that holds nothing of theirs, it does nothing the
// second time and says so: the coordinator asks again whenever it cannot
// tell whether the first one landed.

import { Accounts, normaliseEmail } from './accounts.js';
import { Connections, PROVIDERS } from './connectors.js';
import { forgetVault } from './vault-store.js';
import { log } from '../log.js';

/**
 * @param {{ stateDir: string }} cfg
 * @param {{ forgetOwner: (email: string) => string[] }} sessions  the hub's SessionManager
 * @param {unknown} email
 * @returns {{ ok: boolean, text: string, forgot?: { sessions: number, claude: boolean, providers: string[], vault: boolean } }}
 */
export function forgetPerson(cfg, sessions, email) {
  const who = normaliseEmail(email);
  if (!who) return { ok: false, text: 'That is not an address this box keeps anything under.' };
  const binned = sessions.forgetOwner(who);
  const claude = new Accounts(cfg.stateDir).remove(who);
  const providers = new Connections(cfg.stateDir).forget(who);
  const vault = forgetVault(cfg, who);
  const forgot = { sessions: binned.length, claude, providers, vault };
  const parts = [
    `${binned.length} session${binned.length === 1 ? '' : 's'} stopped and put in the bin`,
    claude ? 'their Claude account unlinked' : null,
    providers.length ? `their ${providers.map((p) => PROVIDERS[p]?.label ?? p).join(' and ')} sign-in${providers.length === 1 ? '' : 's'} and renewal deleted` : null,
    vault ? 'what their vault gave this box deleted' : null,
  ].filter(Boolean);
  const text = `Forgot ${who}, who was removed from the fleet: ${parts.join(', ')}.`;
  log.info(`forget-person: ${text}`);
  return { ok: true, text, forgot };
}
