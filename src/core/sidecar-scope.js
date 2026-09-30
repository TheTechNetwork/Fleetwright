// What the sidecar's token may ask the hub to do.
//
// The sidecar builds every command line it sends from literals in
// src/fleet/host/sidecar.js (`toCommandLine`), so the set of command SHAPES it
// can produce is known and finite. This is that set, from the hub's side: a
// request carrying the sidecar's token may run these and nothing else. The
// operator's token is not gated here — it opens everything, as it always has.
//
// WHAT THIS CLOSES, said plainly, because it is narrower than "scoped" sounds.
// The sidecar is the fleet's hand on this box: the coordinator's verbs ARE
// start, stop, link and the rest, so a compromised sidecar can still do what a
// compromised coordinator could ask of it. What it can no longer do is what
// the sidecar never does — sign the BOX itself in (`/login`, `/login force`),
// list or add accounts, open the web UI, or reach a command the intent table
// has no verb for. The two sub-forms are pinned because the same first word
// covers both: `/login for <email>` is a person's login and is the sidecar's;
// bare `/login` is the machine's and is not.
//
// KEPT IN STEP BY A TEST, not by discipline: test/sidecar-scope.test.js reads
// the words toCommandLine emits and fails if this list and that function
// disagree in either direction. A verb added to the protocol without a line
// here is a verb the fleet cannot run, loudly, in CI — which is the failure
// mode to prefer over one that runs silently.

/** Canonical command names (as src/adapters/commands.js resolves them) the sidecar builds. */
export const SIDECAR_COMMANDS = Object.freeze([
  'list', 'status', 'new', 'profiles', 'secrets', 'updates', 'channel', 'sandbox', 'labels',
  'files', 'readfile', 'writefile', 'copyfile', 'deletefile',
  'resume', 'stop', 'forget', 'restore', 'purge', 'answer', 'logs',
  'update', 'upgrade', 'reboot',
  'connect', 'login', 'code', 'link', 'verify', 'unlink', 'accounts',
  'renew', 'provision', 'runnerrepo', 'githubaccess',
]);

/**
 * May a request carrying the sidecar's token run this command?
 *
 * @param {{ canonical: string|null, args: string[] }} parsed  the command as
 *   commands.js parsed and resolved it; `canonical` null for an unknown word
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function sidecarMayRun({ canonical, args }) {
  if (!canonical || !SIDECAR_COMMANDS.includes(canonical)) {
    return { ok: false, why: `the sidecar's token does not run /${canonical ?? '?'} — it is not a command the fleet sends` };
  }
  // The person's login, never the box's. `/login for <email>` is the only
  // form the sidecar builds; everything else under this word signs the
  // machine in or reads its login state, which is the operator's.
  if (canonical === 'login' && !(args[0] === 'for' && args.length === 2)) {
    return { ok: false, why: "the sidecar's token runs /login only as `/login for <email>` — signing the box in is the operator's" };
  }
  // Unlinking a person is the sidecar's; listing or adding accounts is not.
  if (canonical === 'accounts' && !(args[0] === 'remove' && args.length === 2)) {
    return { ok: false, why: "the sidecar's token runs /accounts only as `/accounts remove <email>`" };
  }
  return { ok: true };
}
