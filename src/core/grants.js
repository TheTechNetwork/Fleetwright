// The two things a box may be allowed to do from chat, and how to change them.
//
// WHAT WAS WRONG. "Rebooting from chat is off" went on to print a sudoers line
// to echo into /etc/sudoers.d, a chmod, and an edit to a root-owned env file,
// then "restart". Correct, and four steps that each have a way to go wrong —
// on a box installed from apt, which is asked nothing at install and takes
// the defaults, every operator who wanted the button met that paragraph. The
// installer already owns the rule, the recorded answer and the restart; this
// puts a name on doing them together:
//
//   sudo fleetwright grant reboot on
//
// WHY NOT A BUTTON. A phone cannot do it and must not be able to. The grant is
// a root-owned rule that lets an unprivileged service run `systemctl reboot`;
// a service that could write that rule for itself would have the privilege
// already, and a coordinator that could ask it to would hold root on every
// box in the fleet. So the decision stays with somebody who has a shell on
// the machine, which is the same rule docs/task-at-start.md gives for the
// words a session starts with. The app's part is to SAY the state, and the
// one line that changes it.

/**
 * The grants, by the name a person types.
 *
 * @type {Record<'upgrades'|'reboot', { env: string, rule: string, what: string, cfg: 'systemUpgrade'|'systemReboot' }>}
 */
export const GRANTS = Object.freeze({
  upgrades: Object.freeze({
    env: 'FLEETWRIGHT_SYSTEM_UPGRADE',
    rule: '/etc/sudoers.d/fleetwright-upgrade',
    what: 'system upgrades from chat',
    cfg: 'systemUpgrade',
  }),
  reboot: Object.freeze({
    env: 'FLEETWRIGHT_SYSTEM_REBOOT',
    rule: '/etc/sudoers.d/fleetwright-reboot',
    what: 'reboot from chat',
    cfg: 'systemReboot',
  }),
});

/** @typedef {keyof typeof GRANTS} GrantName */

/**
 * The one line that turns a grant on or off, as a refusal should print it.
 *
 * @param {GrantName} name
 * @param {'on'|'off'} [to]
 */
export function grantCommand(name, to = 'on') {
  return `sudo fleetwright grant ${name} ${to}`;
}

/**
 * What a box allows from chat, as data, for the health frame and the apps.
 *
 * Booleans, never null: the hub reads its own env file, so it always knows.
 * (Null is for a HOST too old to send this, and that is the sidecar's to say.)
 *
 * @param {{ systemUpgrade?: boolean, systemReboot?: boolean }} cfg
 */
export function grantsOf(cfg) {
  return { upgrades: Boolean(cfg.systemUpgrade), reboot: Boolean(cfg.systemReboot) };
}

/**
 * The state, as `fleetwright grant` with no arguments prints it.
 *
 * @param {{ systemUpgrade?: boolean, systemReboot?: boolean }} cfg
 */
export function describeGrants(cfg) {
  const g = grantsOf(cfg);
  return (
    /** @type {GrantName[]} */ (Object.keys(GRANTS))
      .map((name) => {
        const on = g[name];
        return `  ${GRANTS[name].what.padEnd(26)} ${on ? 'on ' : 'off'}   ${grantCommand(name, on ? 'off' : 'on')}`;
      })
      .join('\n') +
    '\n\nEach one is a root-owned sudoers rule and a line in /etc/fleetwright.env; changing it restarts the service and keeps every session running.'
  );
}

/**
 * `grant reboot on` → what to run. Root is checked by the caller, the way
 * join does it: a typo is found before the sudo.
 *
 * @param {string[]} args
 * @returns {{ name: GrantName, to: 'on'|'off' } | { error: string }}
 */
export function parseGrantArgs(args) {
  const [rawName, rawTo] = args;
  const name = /** @type {GrantName} */ (rawName);
  if (!(name in GRANTS)) return { error: `not a grant: ${rawName ?? '(nothing)'} — it is "upgrades" or "reboot"` };
  const to = { on: 'on', yes: 'on', off: 'off', no: 'off' }[String(rawTo ?? '').toLowerCase()];
  if (!to) return { error: `"${rawTo ?? ''}" is not on or off: ${grantCommand(name, 'on')}` };
  return { name, to: /** @type {'on'|'off'} */ (to) };
}

/**
 * The installer, in its --grant mode, with the node this CLI runs on named so
 * a deb box does not go looking for another.
 *
 * @param {{ name: GrantName, to: 'on'|'off', root: string, node: string, env?: NodeJS.ProcessEnv }} o
 */
export function grantPlan({ name, to, root, node, env = process.env }) {
  const next = { ...env };
  if (!next.FLEETWRIGHT_NODE_BIN) next.FLEETWRIGHT_NODE_BIN = node;
  return { argv: ['bash', `${root}/install/install.sh`, '--grant', `${name}=${to}`], env: next };
}

/**
 * The `grant` verb, as the CLI runs it. Returns the exit code.
 *
 * With no arguments it reports; with a grant and on/off it runs the installer
 * as root, which writes or removes the rule, records the answer and restarts
 * the service.
 *
 * @param {string[]} args
 * @param {{ cfg: { systemUpgrade?: boolean, systemReboot?: boolean }, root: string, node: string, uid?: number,
 *   spawn?: (cmd: string, argv: string[], opts: object) => { status: number|null }, out?: (s: string) => void, err?: (s: string) => void }} o
 */
export function runGrant(args, { cfg, root, node, uid, spawn, out = console.log, err = console.error }) {
  if (!args.length) {
    out(`What this box allows from chat:\n\n${describeGrants(cfg)}`);
    return 0;
  }
  const parsed = parseGrantArgs(args);
  if ('error' in parsed) {
    err(`grant: ${parsed.error}`);
    return 2;
  }
  if (uid !== undefined && uid !== 0) {
    err(`changing a grant writes /etc/sudoers.d, so it needs root:\n      ${grantCommand(parsed.name, parsed.to)}`);
    return 1;
  }
  const plan = grantPlan({ name: parsed.name, to: parsed.to, root, node });
  if (!spawn) throw new Error('runGrant needs a spawn to run the installer');
  const r = spawn(plan.argv[0], plan.argv.slice(1), { stdio: 'inherit', env: plan.env });
  return r.status ?? 1;
}
