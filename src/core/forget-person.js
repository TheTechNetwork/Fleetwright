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
//   a sign-in   a Claude login in their name still waiting for its code,
//   under way   which kept its pane and its authorization URL until it timed
//               out, and wrote back the account just deleted if a code came
//
// AND ONE MORE, found by the review of engine sign-in, which added a store
// and did not add it here:
//
//   engines     Codex and OpenCode signed in for them on this box
//               (engine-signin.js): a ChatGPT sign-in and a GitHub token in
//               their engine home, a Podman volume, which stayed; this box
//               went on reporting them signed in; and a sign-in of theirs
//               still waiting for its code went on waiting, and signed them
//               in again when it was approved after they had gone. The
//               attempts are stopped, the entries dropped and the volume
//               removed. Unlike a session, nothing of it goes in the bin: it
//               is a credential, as what their vault gave this box is.
//
// ONE PERSON'S FILES AND NOBODY ELSE'S. Each store is keyed by the address
// normalised as everywhere on this box (accounts.js normaliseEmail), and a
// session is theirs when its record says they started it (emailFromActor).
// Asked twice, or of a box that holds nothing of theirs, it does nothing the
// second time and says so: the coordinator asks again whenever it cannot
// tell whether the first one landed.
//
// NOT DONE IS SAID AS NOT DONE. A volume Podman would not remove, or a record
// that could not be written, is a sign-in of theirs still on this box: the
// answer is then not a yes, and the coordinator, which owes each box the
// forgetting until the box says it is done, asks again.

import { Accounts, normaliseEmail } from './accounts.js';
import { Connections, PROVIDERS } from './connectors.js';
import { forgetVault } from './vault-store.js';
import { log } from '../log.js';

/**
 * @param {{ stateDir: string }} cfg
 * @param {{ forgetOwner: (email: string) => string[] }} sessions  the hub's SessionManager
 * @param {unknown} email
 * @param {{ forget: (email: string) => boolean }|null} [login]  the hub's LoginFlow
 * @param {{ forget: (account: string) => Promise<{ ok: boolean, entries: number, attempts: number, removed: boolean, why?: string }> }|null} [engines]
 *   the hub's EngineSignins; null on a box that keeps none
 * @returns {Promise<{ ok: boolean, text: string, forgot?: { sessions: number, claude: boolean, providers: string[], vault: boolean, login: boolean, engines: { entries: number, attempts: number, removed: boolean } } }>}
 */
export async function forgetPerson(cfg, sessions, email, login = null, engines = null) {
  const who = normaliseEmail(email);
  if (!who) return { ok: false, text: 'That is not an address this box keeps anything under.' };
  // FIRST, because a session of theirs on Codex or OpenCode is what holds
  // their engine home open, and the home is removed last.
  const binned = sessions.forgetOwner(who);
  // Before the account goes, so no code arriving meanwhile can write it back.
  const signIn = login?.forget(who) ?? false;
  const claude = new Accounts(cfg.stateDir).remove(who);
  const providers = new Connections(cfg.stateDir).forget(who);
  const vault = forgetVault(cfg, who);
  const engine = (await engines?.forget(who)) ?? { ok: true, entries: 0, attempts: 0, removed: false };
  const forgot = { sessions: binned.length, claude, providers, vault, login: signIn, engines: { entries: engine.entries, attempts: engine.attempts, removed: engine.removed } };
  const parts = [
    `${binned.length} session${binned.length === 1 ? '' : 's'} stopped and put in the bin`,
    claude ? 'their Claude account unlinked' : null,
    providers.length ? `their ${providers.map((p) => PROVIDERS[p]?.label ?? p).join(' and ')} sign-in${providers.length === 1 ? '' : 's'} and renewal deleted` : null,
    vault ? 'what their vault gave this box deleted' : null,
    signIn ? 'a Claude sign-in in their name that was waiting for its code cancelled' : null,
    engine.attempts ? `${engine.attempts === 1 ? 'an engine sign-in' : `${engine.attempts} engine sign-ins`} in their name that ${engine.attempts === 1 ? 'was' : 'were'} waiting for a code stopped` : null,
    engine.entries || engine.removed ? 'the engines signed in for them here signed out by removing their engine home' : null,
  ].filter(Boolean);
  if (!engine.ok) {
    // Everything else of theirs is gone, and is said. What is not is said too, and the answer is not a yes.
    const text = `Forgot ${who}, who was removed from the fleet: ${parts.join(', ')}. Their engine sign-ins on this box may still be here: ${engine.why ?? 'no reason given'}. Asked again, it is tried again.`;
    log.warn(`forget-person: ${text}`);
    return { ok: false, text, forgot };
  }
  const text = `Forgot ${who}, who was removed from the fleet: ${parts.join(', ')}.`;
  log.info(`forget-person: ${text}`);
  return { ok: true, text, forgot };
}
