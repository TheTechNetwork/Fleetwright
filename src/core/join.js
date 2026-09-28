// `fleetwright join <coordinator>` — the one command between an installed box
// and a box in a fleet.
//
// THE WHOLE FLOW IS THREE LINES, and this is the third:
//
//   deploy the coordinator (docs/coordinator-deploy.md)
//   sudo apt install fleetwright          or the one-liner
//   sudo fleetwright join fleet.example.com
//
// It adds nothing the installer does not already do. The installer's wizard is
// the thing that writes the coordinator URL, enrols with a pin and starts the
// services; `join` names the fleet for it — the way `curl <coordinator>/install`
// does — and hands over, with the terminal, so the questions that remain are
// asked the way the one-liner asks them. One implementation of joining, reached
// three ways (one-liner, debconf, this), rather than a second one here that
// would drift from it.
//
// It checks the address ANSWERS before handing over, because the installer
// writes whatever it is given into the sidecar's env file and a typo there is
// discovered as a host that silently never connects.

/**
 * What somebody typed, as the URL a sidecar dials.
 *
 * HTTPS UNLESS SAID OTHERWISE. `fleet.example.com` is somebody naming a host,
 * and every coordinator reachable from somewhere else is behind TLS — a
 * Worker only answers on https. The exception is a loopback address, where
 * the local coordinator listens on plain http and there is no certificate to
 * be had; guessing https there would be a refusal blamed on the fleet.
 *
 * An explicit scheme is kept exactly as written, including http:// to a
 * remote host: that is a decision, and the person who typed it may know about
 * a TLS-terminating proxy this cannot see.
 *
 * @param {string} input
 * @returns {{ ok: true, url: string } | { ok: false, message: string }}
 */
export function coordinatorUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, message: 'Which fleet? Give the coordinator\'s address: fleetwright join fleet.example.com' };
  let withScheme = raw;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    const host = raw.split(/[/:]/)[0].replace(/^\[|\]$/g, '');
    const loopback = host === 'localhost' || /^127\./.test(host) || host === '::1' || raw.startsWith('[::1]');
    withScheme = `${loopback ? 'http' : 'https'}://${raw}`;
  }
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return { ok: false, message: `"${raw}" is not an address a box can dial.` };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, message: `A coordinator is reached over https (or http), not ${u.protocol.replace(/:$/, '')}.` };
  }
  if (u.search || u.hash) {
    return { ok: false, message: `Give the coordinator's address alone, without ${u.search ? 'a query' : 'a fragment'}.` };
  }
  // No trailing slash: the sidecar appends paths to this, and `//api/...` is
  // a 404 on a Worker.
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

/**
 * Does something at this address answer as a coordinator?
 *
 * Both coordinators — the Worker and the Node one — serve `/healthz` without
 * auth. Anything else (a 404 from a web server that is not ours, a TLS error,
 * nothing at all) is said now, before the installer has written it anywhere.
 *
 * @param {string} url
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function probeCoordinator(url, { fetch: doFetch = fetch, timeoutMs = 10_000 } = {}) {
  try {
    const r = await doFetch(`${url}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return { ok: false, message: `${url} answered ${r.status} — that is not a Fleetwright coordinator, or not this path to one.` };
    return { ok: true, message: `${url} is a coordinator` };
  } catch (e) {
    const err = /** @type {any} */ (e);
    const why = err?.cause?.code || err?.name || err?.message || 'no answer';
    return { ok: false, message: `could not reach ${url} (${why}).` };
  }
}

/**
 * The refusal for somebody who is not root, or null for root.
 *
 * Joining writes /etc and the service units. Asked AFTER the address has been
 * checked, which needs no privilege, so a typo is found before the sudo.
 *
 * @param {number|undefined} uid  undefined where there is no getuid (Windows)
 * @param {string} typed          what they typed, echoed back in the line to run
 * @param {boolean} hasPin
 * @returns {string|null}
 */
export function rootRefusal(uid, typed, hasPin) {
  if (uid === undefined || uid === 0) return null;
  return `joining writes /etc and the service units, so it needs root:\n      sudo fleetwright join ${typed}${hasPin ? ' --pin …' : ''}`;
}

/**
 * How to run the installer so it joins this fleet.
 *
 * `--wizard`, with the terminal: the same questions the one-liner asks, minus
 * the one this command already answered. The pin is passed only when given —
 * blank, the wizard asks for it, which is the ordinary case: it comes from the
 * app and lives for minutes.
 *
 * The node is the one running this, because on a box installed from the deb it
 * is the only node there is, and the installer would otherwise go looking.
 *
 * @param {{ url: string, pin?: string, root: string, node: string, env?: NodeJS.ProcessEnv }} o
 */
export function joinPlan({ url, pin, root, node, env = process.env }) {
  /** @type {NodeJS.ProcessEnv} */
  const next = { ...env, FLEETWRIGHT_COORDINATOR_URL: url };
  if (pin) next.FLEETWRIGHT_ENROL_PIN = pin;
  if (!next.FLEETWRIGHT_NODE_BIN) next.FLEETWRIGHT_NODE_BIN = node;
  return { argv: ['bash', `${root}/install/install.sh`, '--wizard'], env: next };
}

/**
 * The `join` verb, as the CLI runs it. Returns the exit code.
 *
 * Order matters and is tested: the arguments, then the address (no privilege
 * needed, and a typo found before the sudo is one fewer round trip), then
 * root, then the installer.
 *
 * @param {string[]} args
 * @param {{ root: string, node: string, uid?: number, fetch?: typeof fetch,
 *   spawn?: (cmd: string, argv: string[], opts: object) => { status: number|null },
 *   out?: (s: string) => void, err?: (s: string) => void }} o
 * @returns {Promise<number>}
 */
export async function runJoin(args, { root, node, uid, fetch: doFetch = fetch, spawn, out = console.log, err = console.error }) {
  const fail = (/** @type {string} */ message) => {
    err(`\n  FAIL ${message}\n`);
    return 2;
  };
  let target = '';
  let pin = '';
  let skipCheck = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pin') pin = args[++i] ?? '';
    else if (a.startsWith('--pin=')) pin = a.slice('--pin='.length);
    else if (a === '--no-check') skipCheck = true;
    else if (a.startsWith('-')) return fail(`unknown option ${a}`);
    else if (!target) target = a;
    else return fail(`one coordinator at a time — got "${target}" and "${a}"`);
  }

  const u = coordinatorUrl(target);
  if (!u.ok) return fail(u.message);
  // Six digits or nothing, the installer's own rule, checked before anything
  // runs as root.
  if (pin && !/^\d{6}$/.test(pin)) return fail('a pin is six digits, from the app (Fleet → Add a host).');

  if (!skipCheck) {
    const probe = await probeCoordinator(u.url, { fetch: doFetch });
    if (!probe.ok) return fail(`${probe.message}\n      Nothing was changed. Check the address, or --no-check to join it anyway.`);
    out(`  ok   ${probe.message}`);
  }

  const refusal = rootRefusal(uid, target, Boolean(pin));
  if (refusal) return fail(refusal);

  const plan = joinPlan({ url: u.url, pin, root, node });
  if (!spawn) throw new Error('runJoin needs a spawn to run the installer');
  const r = spawn(plan.argv[0], plan.argv.slice(1), { stdio: 'inherit', env: plan.env });
  return r.status ?? 1;
}
