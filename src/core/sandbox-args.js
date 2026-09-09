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
    (a, next) => /^(-v|--volume|--mount)(=|$)/.test(a) && mountsSensitiveHostPath(val(a, next) || ''),
    'bind-mounts a host path that hands the session the box itself — the root, the container socket, /etc, a credential directory',
  ],
];

/** `--flag=value` or `--flag value`. @param {string} arg @param {string|undefined} next */
function val(arg, next) {
  const eq = arg.indexOf('=');
  return eq >= 0 ? arg.slice(eq + 1) : next;
}

/**
 * Host paths a session must never be handed, however the mount is spelled.
 *
 * The first version refused exactly one host side, `/`, and drew the line
 * there because it was the unarguable one. It was also the one nobody types:
 * the mount that actually defeats the sandbox is the container runtime's own
 * socket — `-v /run/podman/podman.sock:/run/podman.sock` is a forum snippet
 * for "let the agent build images", and inside a root-capable container it
 * is the whole host. The others below are the same shape: a directory whose
 * presence inside the session means the session has the box's keys, its
 * accounts, or its process table, and the escape hatch this guards is pitched
 * for "an extra mount" in so many words.
 *
 * STILL A LIST OF NAMES, and still deliberately short. A mount under /srv or
 * /home/agent/shared is what the hatch is for, and refusing the operator's
 * own choice of directory is how a check gets deleted. What is here is what
 * cannot be a deliberate choice for a contained session.
 */
const NEVER_MOUNT = [
  // The whole box.
  '/',
  // The container runtime's socket: root on the host, one API call away.
  '/run/podman',
  '/var/run/podman',
  '/run/docker.sock',
  '/var/run/docker.sock',
  // Every credential the box holds, and the sudoers rules that make it root.
  '/etc',
  '/root',
  // The process table, the kernel, the devices — the namespaces exist to hide
  // exactly these.
  '/proc',
  '/sys',
  '/dev',
  // Runtime state: sockets for every service on the box, including this one.
  '/run',
  '/var/run',
];

/** Dot-directories that are a credential store wherever they live. */
const NEVER_MOUNT_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.claude', '.config', '.kube', '.docker']);

/**
 * The host side of a mount spec, in either spelling.
 *
 *   -v /host/path:/in/container[:opts]
 *   --mount type=bind,source=/host/path,target=/in/container
 *
 * @param {string} spec
 */
function hostSideOf(spec) {
  if (!spec) return '';
  if (spec.includes('=')) return /(?:^|,)(?:source|src)=([^,]*)/.exec(spec)?.[1] || '';
  return spec.split(':')[0];
}

/**
 * Does this mount hand the session a path it must never have?
 *
 * Matched by path segment, so `/etc` refuses `/etc/ssh` and does not refuse
 * `/etcetera`. `~` and `$HOME` are left alone: podman does not expand them
 * either, so a spec that uses them fails at podman with its own message.
 *
 * @param {string} spec
 */
function mountsSensitiveHostPath(spec) {
  const host = hostSideOf(spec).replace(/\/+$/, '') || (spec ? '/' : '');
  if (!host) return false;
  if (host === '/') return true;
  const segments = host.split('/').filter(Boolean);
  for (const never of NEVER_MOUNT) {
    if (never === '/') continue;
    const want = never.split('/').filter(Boolean);
    if (want.every((seg, i) => segments[i] === seg)) return true;
  }
  return segments.some((seg) => NEVER_MOUNT_DIRS.has(seg));
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

/**
 * Split AGENT_HUB_SANDBOX_ARGS the way a shell would, minus the shell.
 *
 * It was `split(/\s+/)`, which is right until a mount path has a space in it
 * or somebody writes `--label="my session"`. The naive split handed podman
 * two arguments where the operator meant one, and the unsafe-args check saw
 * the same two, so what was checked and what was meant quietly disagreed.
 * Quotes group, a backslash escapes the next character, and nothing else is
 * interpreted — no variables, no globs, no subshells, because this is an
 * argument list and not a script.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitArgs(text) {
  /** @type {string[]} */
  const out = [];
  let current = '';
  let inWord = false;
  /** @type {'"' | "'" | null} */
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) current += text[++i];
      else current += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < text.length) {
      current += text[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(current);
      current = '';
      inWord = false;
    } else {
      current += c;
      inWord = true;
    }
  }
  if (inWord) out.push(current);
  return out;
}
