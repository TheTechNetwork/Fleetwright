// AGENT_HUB_SANDBOX_ARGS, checked.
//
// The escape hatch is real and worth keeping: extra mounts, --device=/dev/kvm
// for an emulator, a --network somebody's deployment needs. But it is spliced
// straight into `podman run`, and a handful of the things it can say do not
// extend the sandbox — they REMOVE it, quietly, while every document in this
// repository goes on describing a session as contained.
//
// That is the shape this project keeps producing: true where it was written,
// quietly false one layer up. `docs/design.md` says a session gets root inside
// a container that maps to an unprivileged host user. `--privileged` in an env
// file makes that sentence false and changes nothing anybody can see.
//
// So the sandbox-defeating ones are refused BY NAME, at startup, before a
// session exists. Loudly, because a host whose sandbox is not a sandbox should
// not start quietly — and with an escape hatch that has to be typed, because
// somebody with a real reason should not be forced to patch the source.
//
// WHAT THIS IS NOT: a defence against whoever can write the env file. They own
// the box. It is a defence against the option someone pasted from a forum three
// months ago and nobody re-read.

/**
 * Options that end containment rather than adjust it.
 *
 * Each entry is [matcher, why]. `why` is shown to a person, so it says what the
 * option does to this system, not what the manual says it does.
 *
 * @type {Array<[(arg: string, next: string|undefined) => boolean, string]>}
 */
const UNSAFE = [
  [(a) => a === '--privileged', 'gives the session every capability on the host — the container stops being a boundary'],
  [
    (a, next) => /^--(net|network)(=|$)/.test(a) && val(a, next) === 'host',
    'puts the session on the host network: it can reach 127.0.0.1:8790, which is the hub\'s own unauthenticated loopback API',
  ],
  [(a, next) => /^--pid(=|$)/.test(a) && val(a, next) === 'host', 'lets the session see and signal every process on the box, including agent-hub'],
  [(a, next) => /^--ipc(=|$)/.test(a) && val(a, next) === 'host', 'shares the host IPC namespace with the session'],
  [(a, next) => /^--uts(=|$)/.test(a) && val(a, next) === 'host', 'shares the host UTS namespace with the session'],
  [
    (a, next) => /^--userns(=|$)/.test(a) && val(a, next) === 'host',
    'turns off the user namespace, so container root IS host root — this is the single line that makes IS_SANDBOX a lie',
  ],
  [
    (a, next) => /^--cap-add(=|$)/.test(a) && /^(all|sys_admin|sys_ptrace|sys_module|sys_rawio)$/i.test(val(a, next) || ''),
    'adds a capability that is equivalent to host root from inside a container',
  ],
  [
    (a, next) => /^--security-opt(=|$)/.test(a) && /^(seccomp=unconfined|apparmor=unconfined|label=disable)$/i.test(val(a, next) || ''),
    'removes the kernel-level confinement the container runtime applies by default',
  ],
  [
    (a, next) => /^(-v|--volume|--mount)(=|$)/.test(a) && mountsHostRoot(val(a, next) || ''),
    'bind-mounts the host filesystem root into the session, which hands it every credential on the box',
  ],
];

/** `--flag=value` or `--flag value`. @param {string} arg @param {string|undefined} next */
function val(arg, next) {
  const eq = arg.indexOf('=');
  return eq >= 0 ? arg.slice(eq + 1) : next;
}

/**
 * A mount whose HOST side is `/`.
 *
 * Deliberately narrow. Mounting a project directory is the ordinary use of this
 * variable and must keep working; mounting `/` is the one that cannot be a
 * considered decision. `/etc` and `~` are not listed because a deployment with
 * a reason for them exists and the line has to be drawn where it is unarguable.
 *
 * @param {string} spec
 */
function mountsHostRoot(spec) {
  if (!spec) return false;
  // --mount type=bind,source=/,target=...
  if (spec.includes('=')) {
    const source = /(?:^|,)(?:source|src)=([^,]*)/.exec(spec)?.[1];
    return source === '/';
  }
  // -v /:/host or -v /:/host:ro
  return spec.split(':')[0] === '/';
}

/**
 * @param {string[]} args
 * @returns {Array<{ arg: string, why: string }>} empty when nothing is wrong
 */
export function unsafeSandboxArgs(args) {
  const found = [];
  for (let i = 0; i < args.length; i++) {
    for (const [matches, why] of UNSAFE) {
      if (matches(args[i], args[i + 1])) {
        found.push({ arg: args[i + 1] && !args[i].includes('=') ? `${args[i]} ${args[i + 1]}` : args[i], why });
        break;
      }
    }
  }
  return found;
}

/**
 * The message a host refuses to start with.
 *
 * Names every offending option and what it does, then the one way to proceed
 * anyway — because a refusal a person cannot act on gets worked around by
 * deleting the check.
 *
 * @param {Array<{ arg: string, why: string }>} found
 */
export function unsafeSandboxMessage(found) {
  return [
    `AGENT_HUB_SANDBOX_ARGS contains ${found.length === 1 ? 'an option that removes' : 'options that remove'} the sandbox:`,
    ...found.map((f) => `  ${f.arg}\n    ${f.why}`),
    '',
    'Sessions run root-capable code, and every document here describes them as contained.',
    'Refusing to start rather than describing a box that way while it is not.',
    '',
    'If this is deliberate, say so explicitly:',
    '  AGENT_HUB_SANDBOX_ALLOW_UNSAFE_ARGS=1',
    'It stays in the log on every start, so nobody inherits it by accident.',
  ].join('\n');
}
