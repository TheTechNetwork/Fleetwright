// Which user namespace a session container runs in — and every helper that
// touches its volumes, which is the part that is easy to miss.
//
// THE DEFAULT WAS THE SERVICE USER, AND NOTHING SAID SO. `sandboxArgv` passed no
// `--userns` at all, and for rootless podman the default is `host`: the
// container gets the caller's own user namespace, so uid 0 inside IS the
// service uid outside. Not root on the box — but the account that owns the
// Claude credential, the state directory and every hook socket. Every document
// here said "its root maps to an unprivileged host user", and the sentence was
// true only in the sense that the service user is not uid 0.
// docs/recommendations-review.md §1 is the full account.
//
// `nomap` is the fix: "creates a user namespace where the current rootless
// user's UID:GID are not mapped into the container." Container root becomes the
// first subordinate uid — a uid that owns nothing on the box — and the mapping
// is the SAME for every container, which is why it is `nomap` and not `auto`.
// `auto` allocates a fresh range per container and podman chowns a named volume
// only on first use, so under `auto` a resumed session would find its own
// workspace owned by a dead range.
//
// ONE FLAG, EVERY CONTAINER. The session, the credential seed, the house-rules
// write, the account read and the file browser all mount the same two volumes.
// A volume written under one mapping and read under another is unreadable,
// silently, on the next resume. So the argument list lives here and every
// `podman run` that names a session volume spreads it in.
//
// Two things `nomap` cannot do, and config.js downgrades to `host` for both,
// loudly: it "is not allowed for containers created by the root user", and
// docker has no such option at all (AGENT_HUB_PODMAN_BIN=docker is a test
// arrangement, not a deployment — see podman.js).

/** The two answers `AGENT_HUB_SANDBOX_USERNS` may hold. */
export const USERNS_MODES = Object.freeze(['nomap', 'host']);

/**
 * The `podman run` arguments that put a container in the session namespace.
 *
 * Empty under `host`, which is what the launcher passed before this existed —
 * so a box that opts out runs exactly the old line.
 *
 * @param {{ sandboxUserns?: string }} cfg
 * @returns {string[]}
 */
export function usernsArgs(cfg) {
  return cfg.sandboxUserns === 'nomap' ? ['--userns=nomap'] : [];
}

/**
 * The bind-mount spec for the per-session hook socket.
 *
 * Under `nomap` the socket, created 0600 by the service user, is owned by a uid
 * the container does not map, and container root cannot connect to it. The `U`
 * volume option "tells Podman to use the correct host UID and GID based on the
 * UID and GID within the container, to change recursively the owner and group
 * of the source volume" — one inode here, so it is instant. The hub keeps the
 * listening descriptor it already holds; only who may CONNECT changes. See
 * hook-socket.js `clearStaleSocket` for the probe this obliges to tell EACCES
 * from a dead listener.
 *
 * @param {{ sandboxUserns?: string }} cfg
 * @param {string} hostPath
 * @param {string} containerPath
 */
export function hookSocketMount(cfg, hostPath, containerPath) {
  return `${hostPath}:${containerPath}${cfg.sandboxUserns === 'nomap' ? ':U' : ''}`;
}
