// The credential broker: a session asks for a token instead of being handed one.
//
// WHAT IT REPLACES
//
// Until now every connected token was written into the session's volume as
// `.secrets.env` and exported by the entrypoint with `set -a`. That was already
// the careful version — not `-e` flags on the podman command line, which the
// tmux pane's `ps` output would have published — but it still means every
// process in the container holds GH_TOKEN for as long as the session lives.
//
// Two things follow from that, and the second is the one people actually hit:
//
//  1. The token is in `environ` for anything running in there, readable from
//     /proc, inherited by every child, and visible in any crash dump or log
//     that dumps the environment.
//  2. IT IS FROZEN AT START. A session holds whatever was current when it
//     began. Rotating a token reaches the NEXT session and cannot reach into a
//     running one, so the fix for "my GitHub token expired" is "stop working
//     and restart the session". A socket makes that difference disappear —
//     the file is read at the moment of the request, so renewal lands
//     mid-session with nothing to restart.
//
// WHY IT IS A ROUTE ON THE HOOK SOCKET AND NOT A NEW ONE
//
// The hook socket already gives us the exact property this needs: one socket
// per session, bind-mounted into exactly that container, so WHICH SOCKET a
// request arrives on is what identifies the session. Nothing in the request
// says who is asking, because nothing in the request could be believed.
//
// A second socket would need a second lifecycle, a second mount, and a second
// place to get that reasoning wrong. This is the same door with another thing
// behind it.
//
// WHAT THIS IS NOT
//
// It is not the credential-terminating proxy in trust.md. The session still
// receives the real token and can copy it anywhere; what changed is that it
// must ask, that the asking is logged, and that it gets the CURRENT one. That
// is the order trust.md argues for — "minting without the broker is a shorter
// fuse on the same bomb; the broker without minting is already an improvement."
//
// It also does not narrow what a session can reach. A session that asks for
// github gets the same token it used to be handed. Narrowing is what per-session
// minting is for, and that waits on the private-key question in github-app.md.

import { PROVIDERS } from './connectors.js';

/** The route a session asks on. Sits beside HOOK_PATH on the same socket. */
export const CREDENTIAL_PATH = '/internal/credential';

/**
 * Which provider serves a given git remote host.
 *
 * A MAP RATHER THAN A GUESS. The git credential helper protocol hands us a
 * hostname and asks for a password, and the tempting shortcut is to answer with
 * whatever token we have. That would send a GitHub token to any host a session
 * happened to clone from — including one chosen by whatever the session is
 * currently reading. An unknown host gets nothing, silently, which is exactly
 * what git expects from a helper that cannot answer.
 */
/** @type {Readonly<Record<string, string>>} */
export const HOST_PROVIDERS = Object.freeze({
  'github.com': 'github',
  'gist.github.com': 'github',
});

/**
 * Answer one request.
 *
 * Pure: the caller supplies the secrets already read from disk, so the decision
 * is testable without a filesystem and the reading happens at the edge where
 * freshness matters.
 *
 * @param {object} q
 * @param {string} q.provider           what is being asked for
 * @param {Record<string, string>|null} q.secrets  the row's env, read just now; null = no row
 * @returns {{ ok: true, provider: string, env: Record<string, string> }
 *          | { ok: false, error: string, message: string }}
 */
export function answerCredentialRequest({ provider, secrets }) {
  const p = PROVIDERS[provider];
  if (!p) {
    // Named rather than generic. A session asking for "githib" should be told
    // it typoed, not left concluding the fleet has no GitHub token.
    return {
      ok: false,
      error: 'unknown_provider',
      message: `"${String(provider).slice(0, 40)}" is not a provider this host knows.`,
    };
  }
  // NULL IS NOT EMPTY, again. No row at all means the asker could not be
  // identified; an empty row means they have simply not connected anything.
  // Both end in no token, and only one of them is the person's own doing, so
  // they must not share a message.
  if (secrets === null) {
    return {
      ok: false,
      error: 'no_row',
      message: 'This session has no credential row — nobody was identified as its owner.',
    };
  }
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of p.env) {
    const value = secrets[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  if (!Object.keys(env).length) {
    return {
      ok: false,
      error: 'not_connected',
      message: `${p.label} is not connected for this session. Connect it in the app and ask again — nothing needs restarting.`,
    };
  }
  return { ok: true, provider, env };
}

/**
 * The git credential helper's question, answered.
 *
 * git speaks a line protocol on stdin/stdout: it sends `protocol=`, `host=` and
 * friends, and a helper prints `username=` and `password=` or prints nothing.
 * PRINTING NOTHING IS THE CORRECT REFUSAL — git falls through to the next
 * helper and eventually to asking a person, where an error here would break a
 * clone of a repository that needs no credential at all.
 *
 * @param {{ protocol?: string, host?: string }} ask
 * @param {(provider: string) => ({ ok: true, env: Record<string,string> } | { ok: false })} lookup
 * @returns {{ username: string, password: string }|null}
 */
export function answerGitCredential(ask, lookup) {
  // https only. A helper that answers for `protocol=http` hands the token to
  // the network, which is the whole of SEC-NET-1 one layer down.
  if ((ask.protocol || '').toLowerCase() !== 'https') return null;
  const provider = HOST_PROVIDERS[(ask.host || '').toLowerCase()];
  if (!provider) return null;
  const got = lookup(provider);
  if (!got.ok) return null;
  const token = got.env.GH_TOKEN || got.env.GITHUB_TOKEN;
  if (!token) return null;
  // `x-access-token` is what GitHub documents for a token in the password
  // field. The username is ignored but must not be empty.
  return { username: 'x-access-token', password: token };
}
