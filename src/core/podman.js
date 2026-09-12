// Podman: the per-session sandbox's volumes and containers.
//
// design.md §2 in one line: give a session full root, and delete everything it
// did afterwards. That works by splitting state by LIFETIME rather than by
// trying to make root safe:
//
//   conversation (~/.claude)   named volume   survives stop, deleted on /forget
//   workspace (/work)          named volume   survives stop, deleted on /forget
//   system (packages, /etc)    container fs   gone on every stop
//
// tmux does not move. The pane's process becomes `podman run -it`, so
// capture-pane still reads the TUI podman is drawing and send-keys still types
// into it — which is why resume-dialog detection, the Remote Control retry and
// peek all keep working untouched. Validated on hardware, design.md §10.
//
// Everything here is argv-array spawnSync, never a shell string, for the same
// reason tmux.js is: a session name must never be able to become a command.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { readHouseRules } from './rules.js';
import { Accounts, emailFromActor, extractOauthAccount, rowForActor, operatorAccount } from './accounts.js';
import { readCredentialState } from './claude-credential.js';
import { Connections } from './connectors.js';
import { sessionImage, variantOf, pinnedByEnv } from './sandbox-variant.js';

// A first build pulls a base image, apt-installs a toolchain and npm-installs
// the CLI. Minutes, not seconds — and a timeout shorter than the work turns a
// slow network into a mystery.
const BUILD_TIMEOUT_MS = 15 * 60_000;

/**
 * @param {import('../config.js').Config} cfg
 * @param {string[]} args
 */
/** @param {import('../config.js').Config} cfg @param {string[]} args @param {{ timeout?: number, input?: string }} [opts] */
export function podman(cfg, args, { timeout, input } = {}) {
  // `input` goes to the container's stdin rather than into the argument list.
  // Content a caller supplies — a file being written, say — is the one thing
  // that must never be parsed as shell, and stdin is the only place it cannot be.
  const r = spawnSync(cfg.podmanBin, args, {
    encoding: 'utf8',
    ...(timeout ? { timeout } : {}),
    ...(input === undefined ? {} : { input }),
    // A file can be larger than the default 1MB pipe buffer, and a truncated
    // read that looks successful is worse than a refusal.
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? r.error.message : ''),
  };
}

/** @param {import('../config.js').Config} cfg */
/**
 * Does this image / volume / container exist?
 *
 * `inspect`, NOT `exists`. Podman has `podman volume exists` and friends; Docker
 * has none of the three, and this project has one place where that matters: CI
 * has Docker and no Podman, so the container half of the sandbox — the part
 * that actually touches a volume — could not be exercised at all. Everything
 * around it was tested and the thing itself was asserted by reading the source.
 *
 * `inspect` exists on both and answers the same question the same way: zero if
 * it is there, non-zero if it is not. Output is discarded; only the status is
 * read. So `AGENT_HUB_PODMAN_BIN=docker` now runs this code path unchanged.
 *
 * THE PRODUCT STILL WANTS PODMAN, and that is not a preference. docs/hardening.md
 * is built on rootless: NoNewPrivileges against setuid newuidmap, ProtectHome
 * against ~/.local/share/containers, and a refusal list including
 * --userns=host. Docker's default is a root daemon, where "escaped the
 * container" and "root on the box" are the same sentence. This makes the CLI
 * calls portable so a test can run somewhere else; it does not move the fleet.
 *
 * @param {import('../config.js').Config} cfg
 * @param {'image'|'volume'|'container'} kind
 * @param {string} id
 */
function exists(cfg, kind, id) {
  return podman(cfg, [kind, 'inspect', id]).status === 0;
}

/** @param {import('../config.js').Config} cfg */
export function podmanAvailable(cfg) {
  return spawnSync(cfg.podmanBin, ['--version'], { encoding: 'utf8' }).status === 0;
}

/**
 * Recreate a rootless "pause" namespace poisoned by systemd `ProtectProc`, so a
 * session can mount /proc again.
 *
 * THE FAULT THIS UNDOES, because it took a fleet-wide outage to find and the
 * error names the wrong thing. Rootless podman keeps ONE pause process per user,
 * and every rootless container joins ITS namespaces. If the process that first
 * created that pause ran under `ProtectProc=invisible`, the pause namespace's
 * /proc is mounted `hidepid` — and a hidepid /proc is not "fully visible", so
 * the kernel refuses an unprivileged container a fresh proc mount and EVERY
 * session dies at start with `crun: mount \`proc\` to \`proc\`: Operation not
 * permitted`. The error blames crun; the cause is the unit. install/agent-hub.service
 * no longer sets ProtectProc, so a NEW pause comes up clean — but the already
 * poisoned one SURVIVES A SERVICE RESTART (KillMode=process leaves the user's
 * pause alone), so removing the directive and restarting is not enough on a box
 * that is already broken: the update would rewrite the unit and still not fix it.
 * Recreating the pause here, on the way up under the now-clean unit, is what
 * makes an in-app update actually recover the box.
 *
 * SAFE, AND ONLY WHEN NEEDED. A poisoned pause cannot have running containers —
 * they could not have started — so recreating it disturbs nothing. When /proc is
 * already clean this does nothing at all and never touches a live session.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {{ healed: boolean, why?: string }}
 */
export function healRootlessSandbox(cfg) {
  if (!podmanAvailable(cfg)) return { healed: false, why: 'podman is not available' };
  // Read the pause namespace's OWN mount table — `podman unshare` runs in the
  // rootless user+mount namespace every container inherits, so this is the /proc
  // a session would get, not the one this shell sees.
  const before = podman(cfg, ['unshare', 'cat', '/proc/self/mountinfo']);
  if (before.status !== 0) return { healed: false, why: 'could not read the rootless namespace' };
  if (!procNotFullyVisible(before.stdout)) return { healed: false };
  log.warn(
    'sandbox: the rootless namespace has a /proc that is not fully visible — a ProtectProc or ' +
      'ProtectKernelLogs unit poisoned it, and every session would die at `mount proc`. Recreating it.',
  );
  const migrated = podman(cfg, ['system', 'migrate']);
  if (migrated.status !== 0) {
    const why = migrated.stderr.trim().slice(0, 200);
    log.warn(`sandbox: could not recreate the rootless namespace: ${why}`);
    return { healed: false, why };
  }
  // VERIFY, do not assume. The first version of this logged success straight
  // after `migrate` and was wrong on a box where agent-hub ITSELF still ran
  // under a /proc-masking directive: `migrate` recreated the pause from that
  // same masked namespace, so it came back just as poisoned, and the reassuring
  // log line sent everyone looking elsewhere. If the pause is still not fully
  // visible, the fault is agent-hub's own unit, not something migrate can fix.
  const after = podman(cfg, ['unshare', 'cat', '/proc/self/mountinfo']);
  if (after.status === 0 && procNotFullyVisible(after.stdout)) {
    log.warn(
      'sandbox: recreated the rootless namespace but its /proc is STILL not fully visible — ' +
        'agent-hub itself is running under a /proc-masking directive (ProtectProc/ProtectKernelLogs). ' +
        'See the REJECTED list in install/agent-hub.service.',
    );
    return { healed: false, why: 'agent-hub is still masking /proc' };
  }
  log.info('sandbox: recreated the rootless namespace with a fully-visible /proc — sessions can start again');
  return { healed: true };
}

/**
 * Is this /proc mount table one that a container CANNOT mount a fresh /proc over?
 *
 * The kernel refuses an unprivileged container a new proc mount unless it
 * already has a "fully visible" proc. Two systemd directives break that, both
 * seen taking the whole fleet down:
 *
 *   ProtectProc=invisible   mounts /proc `hidepid` — the flag lives in the
 *                           SUPERBLOCK options after the ` - ` separator, and
 *                           `hidepid=0`/`off` is the visible default, not it.
 *   ProtectKernelLogs=yes   overmounts /proc/kmsg onto systemd's
 *   (and the ProtectKernel* /systemd/inaccessible/ marker, which hides a /proc
 *   family)                 pseudo-file and makes the whole /proc not-visible.
 *
 * A functional submount like /proc/sys/fs/binfmt_misc is NOT poisoning (a
 * healthy box has it and sessions run), so this matches the masking shapes
 * specifically rather than "any submount" — which would migrate a healthy box
 * and take its live sessions down with it.
 *
 * @param {string} mountinfo
 */
function procNotFullyVisible(mountinfo) {
  for (const line of mountinfo.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const fields = left.split(' ');
    const mountRoot = fields[3]; // field 4: the fs root that is mounted
    const mountPoint = fields[4]; // field 5: where it is mounted
    if (mountPoint === '/proc') {
      const m = right.match(/\bhidepid=(\S+?)(?:,|$)/);
      if (m && m[1] !== '0' && m[1] !== 'off') return true;
    }
    // A /proc pseudo-file hidden behind systemd's inaccessible marker — what
    // ProtectKernelLogs and the ProtectKernelTunables family do.
    if (mountPoint.startsWith('/proc/') && mountRoot.includes('/systemd/inaccessible')) return true;
  }
  return false;
}

/**
 * The two volumes and the container name for a session. Derived rather than
 * stored, so nothing can drift out of step with the session's name.
 * @param {string} name
 */
export function sandboxNames(name) {
  return {
    claude: `claude-${name}`,
    work: `work-${name}`,
    container: `agent-${name}`,
  };
}

/**
 * Is the sandbox image actually built?
 *
 * Checked before anything else touches podman, because otherwise a missing
 * image first surfaces from the credential-seeding step — which then blames the
 * credentials file, and sends whoever is reading the error at the wrong
 * problem entirely.
 *
 * @param {import('../config.js').Config} cfg
 */
export function sandboxImageExists(cfg) {
  return exists(cfg, 'image', sessionImage(cfg));
}

/**
 * Get the sandbox image, building or pulling it if it is not there.
 *
 * Refusing to start a session over a missing image is refusing over something
 * we know exactly how to fix. The first session on a fresh box waits a few
 * minutes; every one after it is instant. AGENT_HUB_SANDBOX_AUTO_BUILD=0 turns
 * this off for a deployment that manages its images elsewhere.
 *
 * A `localhost/` image is ours and gets built from the Containerfile. Anything
 * else names a registry, so it gets pulled — building our Containerfile and
 * tagging it with somebody else's name would be a lie.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {{ ok: boolean, built?: boolean, message?: string }}
 */
export function ensureSandboxImage(cfg, { refresh = false } = {}) {
  // `refresh` is what /update passes. Without it this returns on the first
  // line for the entire life of a box: the image was treated as a one-time
  // install, and it is a moving dependency — the session entrypoint, the
  // credential seeding, the trust flags all live inside it. Shipping a fix
  // there reached nobody until somebody pulled by hand, which is the same
  // shape as a deploy filter that names the wrong directory: true when
  // written, quietly false later.
  // ONE RESOLUTION FOR THE WHOLE FUNCTION. Reading the variant twice inside a
  // build could pull one tag and tag the result as the other, if somebody
  // changed it from a phone while the build was running.
  const image = sessionImage(cfg);
  if (refresh && !image.startsWith('localhost/')) {
    const pulled = refreshSandboxImage(cfg);
    // A failed refresh is NOT fatal. The box has a working image; the network
    // is what failed. Falling through to the existence check leaves it running
    // on what it has rather than breaking an update over a registry hiccup.
    if (pulled.ok) return { ok: true, built: pulled.changed };
    log.warn(`sandbox: could not refresh ${image}: ${pulled.message}`);
  }
  if (sandboxImageExists(cfg)) return { ok: true, built: false };

  const manual =
    `Build it with:\n  podman build -t ${image} -f ${cfg.sandboxContainerfile} ` +
    `${path.dirname(cfg.sandboxContainerfile)}\n(or re-run install/install.sh)`;

  if (!cfg.sandboxAutoBuild) {
    return { ok: false, message: `the sandbox image ${image} is not built, and auto-build is off.\n${manual}` };
  }

  const isLocal = image.startsWith('localhost/');
  if (!isLocal) {
    log.info(`sandbox: pulling ${image}`);
    const pulled = podman(cfg, ['pull', image]);
    if (pulled.status === 0) return { ok: true, built: true };
    return { ok: false, message: `could not pull ${image}: ${pulled.stderr.trim().slice(0, 300)}` };
  }

  if (!existsSync(cfg.sandboxContainerfile)) {
    return {
      ok: false,
      message: `the sandbox image ${image} is not built and ${cfg.sandboxContainerfile} does not exist.\n${manual}`,
    };
  }

  // This blocks the session that asked for it, which is the point — it is the
  // difference between waiting once and being told to go and do it yourself.
  log.warn(`sandbox: ${image} is not built — building it now, this takes a few minutes`);
  const context = path.dirname(cfg.sandboxContainerfile);
  const built = spawnSync(
    cfg.podmanBin,
    // --build-arg, because a LOCAL build of the browser variant is the same
    // Containerfile with the conditional layer switched on. Without this a box
    // that builds rather than pulls would tag a minimal image `:web` and every
    // browser session on it would fail at `chromium: not found` — with the tag
    // saying it should have worked.
    ['build', '-t', image, ...(variantOf(image) === 'browser' ? ['--build-arg', 'WITH_CHROMIUM=1'] : []),
      '-f', cfg.sandboxContainerfile, context],
    { encoding: 'utf8', timeout: BUILD_TIMEOUT_MS },
  );
  if (built.status === 0) {
    log.info(`sandbox: built ${image}`);
    return { ok: true, built: true };
  }
  // The last few lines of a build log are the ones that say what failed; the
  // rest is layers succeeding.
  const tail = String(built.stderr || built.stdout || '').trim().split('\n').slice(-6).join('\n');
  return { ok: false, message: `could not build ${image}:\n${tail}\n\n${manual}` };
}

/**
 * Does this session have a workspace volume yet?
 *
 * Asked before any file operation, because `run -v name:/work` CREATES the
 * volume when it is absent — so a read of a session that does not exist would
 * quietly make one, with a name the caller chose. See src/core/files.js.
 *
 * @param {import('../config.js').Config} cfg @param {string} name
 */
export function workspaceExists(cfg, name) {
  return exists(cfg, 'volume', sandboxNames(name).work);
}

/** @param {import('../config.js').Config} cfg @param {string} volume */
function volumeExists(cfg, volume) {
  return exists(cfg, 'volume', volume);
}

/**
 * Refresh the image on the way into a session — cheaply, and never in the way.
 *
 * OFF BY DEFAULT NOW (`sandboxRefreshMs` is 0 unless set). It stays because a
 * box that WANTS its image to track a tag on its own should be able to say so,
 * but the default is the deliberate one: a background re-pull changes what
 * sessions run with no changelog and no line a person looks at, which is the
 * silent drift the `updates` verb and the /update path exist to replace. When a
 * box does opt in, THE CONSTRAINTS ARE WHAT MAKE IT SAFE:
 *
 *  - **Stamped.** At most once per refreshEveryMs (whatever the box set), read
 *    off a file mtime. A pull per start would put a registry between a person
 *    and their session, and this project has already measured what a
 *    fifteen-second start feels like.
 *  - **Bounded.** The pull gets a short timeout. A slow registry delays a
 *    session by seconds, never by minutes, and a hung one delays it not at all.
 *  - **Never fatal.** Every failure path — no network, no podman, a timeout,
 *    an unwritable stamp — falls through to starting on the image already on
 *    disk. A box with a working image must never fail to start a session
 *    because a refresh could not happen.
 *  - **Only for a NEW volume.** The caller only asks when it is about to seed,
 *    because that is the moment the image's contents get baked into a session.
 *    A resume keeps its own, as it must.
 *
 * The stamp is touched even when the pull FAILS. Otherwise an unreachable
 * registry means every start retries, and a box offline for a day starts every
 * session slowly for a day.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {{ changed: boolean }}
 */
export function refreshSandboxImageIfStale(cfg) {
  const every = cfg.sandboxRefreshMs ?? 0;
  if (!every || String(sessionImage(cfg) || '').startsWith('localhost/')) return { changed: false };
  const stamp = path.join(cfg.stateDir, '.sandbox-image-checked');
  try {
    const age = Date.now() - statSync(stamp).mtimeMs;
    if (age < every) return { changed: false };
  } catch {
    // No stamp yet: this is the first start since install, which is exactly
    // when a check is most worth doing.
  }
  let changed = false;
  try {
    const r = refreshSandboxImage(cfg, { timeout: 60_000 });
    changed = r.ok && r.changed;
    if (!r.ok) log.warn(`sandbox: image check failed, starting on the image already here: ${r.message}`);
  } catch (e) {
    log.warn(`sandbox: image check failed: ${/** @type {Error} */ (e).message}`);
  }
  try {
    mkdirSync(path.dirname(stamp), { recursive: true });
    writeFileSync(stamp, new Date().toISOString());
  } catch { /* unwritable state dir: check every start rather than never start */ }
  return { changed };
}

/**
 * Pull the sandbox image again, and say whether it actually moved.
 *
 * The digest before and after is the only honest way to answer "did anything
 * change": `podman pull` on an up-to-date image succeeds and prints almost
 * nothing, and parsing its output for "Already exists" would be reading
 * someone else's prose as an API.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ timeout?: number }} [opts]
 * @returns {{ ok: boolean, changed: boolean, message?: string }}
 */
export function refreshSandboxImage(cfg, { timeout } = {}) {
  const digest = () => {
    const r = podman(cfg, ['image', 'inspect', '--format', '{{.Digest}}', sessionImage(cfg)]);
    return r.status === 0 ? String(r.stdout).trim() : null;
  };
  const before = digest();
  const pulled = podman(cfg, ['pull', sessionImage(cfg)], { timeout });
  if (pulled.status !== 0) {
    return { ok: false, changed: false, message: pulled.stderr.trim().slice(0, 200) };
  }
  const after = digest();
  const changed = Boolean(after) && after !== before;
  if (changed) log.info(`sandbox: image updated (${(before || 'none').slice(0, 19)} → ${(after || '').slice(0, 19)})`);
  return { ok: true, changed };
}

/**
 * What image sessions run, and whether it drifts under this box.
 *
 * The gap this fills: the app and the OS both report what they have waiting, and
 * the one component that actually runs a session — its image — reported nothing.
 * A box on `…/fleetwright-session:latest` is on a tag whose bytes can change
 * under the same name, so the thing sessions run can change with no changelog
 * and, until now, no line anywhere a person looks. That is the C-5 rule turned
 * on its own updater: "up to date" is a claim, and a moving tag cannot make it.
 *
 * `mutable` is the honest signal: a registry tag resolves to different bytes
 * over its life, so an update following it can change what a session runs; a
 * digest-pinned ref (`…@sha256:…`) or a `localhost/` image built here cannot.
 * The digest is read LOCALLY — no network, no pull — so this is cheap enough to
 * compute on every `updates`; whether a newer one exists on the registry is a
 * separate, heavier question and deliberately not asked here.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {{ image: string|null, variant: string|null, mutable: boolean, pinned: boolean, digest: string|null }}
 */
export function sandboxImageStatus(cfg) {
  /** @type {string|null} */
  let image = null;
  let pinned = false;
  try {
    image = sessionImage(cfg);
    pinned = pinnedByEnv(cfg);
  } catch {
    /* an incompletely configured box — falls through to the cannot-tell shape */
  }
  if (!image || typeof image !== 'string') {
    // C-5: null is cannot-tell, never "nothing". A box with no image configured
    // is not a box running a pinned one.
    return { image: null, variant: null, mutable: false, pinned, digest: null };
  }
  const pinnedToDigest = /@sha256:[0-9a-f]{64}$/i.test(image);
  const isLocal = image.startsWith('localhost/');
  // Mutable exactly when the ref can resolve to different bytes over its life: a
  // remote tag not pinned to a digest. That is the one shape whose contents an
  // update can change without the name changing.
  const mutable = !pinnedToDigest && !isLocal;
  let digest = null;
  const r = podman(cfg, ['image', 'inspect', '--format', '{{.Digest}}', image]);
  if (r.status === 0) {
    const d = String(r.stdout).trim().replace(/^sha256:/, '');
    digest = d ? d.slice(0, 12) : null;
  }
  return { image, variant: variantOf(image), mutable, pinned, digest };
}

/**
 * Can this box actually start a session right now?
 *
 * The honest health signal for commit-confirm — and the one the mount-proc
 * outage would have failed. "The sidecar reached the coordinator" says the box
 * is online; it says nothing about whether a session can run, and that outage
 * was exactly a box that was online with every session dead at `mount proc`. So
 * this runs the smallest real thing: a throwaway container that mounts its own
 * /proc and exits. If that works, a session can start.
 *
 * `--network=none` and `true` keep it to seconds and touch nothing — no image
 * pull (the image is already here or the box could not run sessions anyway), no
 * network, no state. A cheap, definitive answer.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ timeout?: number }} [opts]
 * @returns {boolean}
 */
export function canStartSession(cfg, { timeout = 30_000 } = {}) {
  try {
    const r = podman(cfg, ['run', '--rm', '--network=none', sessionImage(cfg), 'true'], { timeout });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Make sure a session's volumes exist, and that the conversation volume has
 * credentials in it.
 *
 * The seeding is the part that is easy to miss: a fresh `claude-<name>` volume
 * is empty, so the session inside would come up unauthenticated and sit at a
 * login prompt nobody is there to answer — the exact silent hang this whole
 * tool exists to prevent. So on first creation we copy the host's
 * `.credentials.json` in, and nothing else: `projects/` stays empty on purpose,
 * because a per-session conversation history is the point of the volume.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @param {string|null} [actor]
 * @param {{ account?: string|null, createdBy?: string|null }} [opts]  what the
 *   registry already knows about this session, when it is a resume: the Claude
 *   account its volume holds, and the actor who started it. See
 *   refreshSeededCredentials for why both are needed and why neither is the
 *   actor pressing resume.
 * @returns {{ ok: boolean, message?: string, account?: string|null }}
 */
export function ensureSandboxVolumes(cfg, name, actor = null, { account: recorded = null, createdBy = null } = {}) {
  if (!podmanAvailable(cfg)) {
    return { ok: false, message: `${cfg.podmanBin} is not installed, but AGENT_HUB_SANDBOX is on` };
  }
  // Only when a volume is missing — that is when the image's contents get
  // baked into a session. A resume finds both volumes present, skips this
  // entirely, and keeps the image it began with.
  const { claude: claudeVol, work: workVol } = sandboxNames(name);
  const creating = !volumeExists(cfg, claudeVol) || !volumeExists(cfg, workVol);
  if (creating) refreshSandboxImageIfStale(cfg);

  const image = ensureSandboxImage(cfg);
  if (!image.ok) return { ok: false, message: image.message };

  const { claude, work } = sandboxNames(name);
  // null = the volumes already existed and nothing identified whose account
  // they hold, so they keep what they have.
  let account = null;
  let fresh = false;

  for (const volume of [claude, work]) {
    if (volumeExists(cfg, volume)) continue;
    const created = podman(cfg, ['volume', 'create', volume]);
    if (created.status !== 0) {
      return { ok: false, message: `could not create volume ${volume}: ${created.stderr.trim().slice(0, 200)}` };
    }
    log.info(`sandbox: created volume ${volume}`);

    if (volume !== claude) continue;
    const seeded = seedCredentials(cfg, claude, pickCredentialSource(cfg, actor), actor);
    if (!seeded.ok) return seeded;
    account = seeded.account ?? 'shared';
    // AFTER the credential and never instead of it: this one cannot refuse a
    // start, so it must not run before the thing that can.
    seedHouseRules(cfg, claude);
    fresh = true;
  }
  // A RESUME REFRESHES THE CREDENTIAL IT ALREADY HAS. This used to be the one
  // line of the file that was confidently wrong: "a resume never re-seeds,
  // which is what keeps a session on the account it began with." The account
  // is what had to be kept. The BYTES were never the account, and keeping them
  // is what made a week-old session come back logged out while a new one on
  // the same box worked — the difference being only that the new one got a
  // snapshot taken today.
  //
  // An OAuth access token has hours on it and a refresh token gets rotated
  // when the host renews. A copy taken on Tuesday is therefore not a
  // credential by Thursday; it is a receipt for one.
  //
  // So the account is pinned and the credential is not: same person, current
  // token. Failure here is NOT fatal — a session that resumes with the
  // credential it had is exactly the old behaviour, and refusing to resume
  // because a refresh could not happen would be a worse bug than the one this
  // fixes.
  if (!fresh) {
    const again = refreshSeededCredentials(cfg, name, { account: recorded, actor: createdBy ?? actor });
    if (again.account) account = again.account;
  }
  return { ok: true, account };
}

/**
 * Put today's credential into a volume that already exists, for the account
 * that volume already belongs to.
 *
 * WHOSE, in three cases and three answers — the same discipline `rowForActor`
 * uses, and for the same reason:
 *
 *   the record says      → that account, whatever the actor is. A session
 *                          resumed by somebody else keeps the account it began
 *                          with; that invariant is real and this preserves it.
 *   the record is silent → ask the VOLUME. `.oauth-account.json` is seeded
 *                          beside the credential and carries the email, so the
 *                          volume can identify itself without a record.
 *   neither answers      → do nothing. Guessing here would silently move a
 *                          session onto a different Claude account mid-flight,
 *                          which is worse than the staleness being fixed.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * The provider tokens — GitHub, Cloudflare — follow a SEPARATE key, and the
 * separation is deliberate rather than an oversight. A person with no linked
 * Claude account runs on the shared one but still gets their own GitHub token,
 * so "whose Claude account" does not answer "whose GitHub token". The second
 * question is answered by the actor who STARTED the session, off the registry
 * record — never by the actor pressing resume, or a colleague resuming
 * somebody else's work would quietly lend it their repositories.
 *
 * @param {{ account?: string|null, actor?: string|null }} [opts]  `actor` is
 *   the session's original creator, for the provider tokens.
 * @returns {{ refreshed: boolean, account: string|null, why?: string }}
 */
export function refreshSeededCredentials(cfg, name, { account = null, actor = null } = {}) {
  const { claude } = sandboxNames(name);
  const owner = account ?? volumeAccount(cfg, claude);
  if (!owner) {
    log.info(`sandbox: ${claude} does not say whose account it holds; leaving its credential alone`);
    return { refreshed: false, account: null, why: 'unknown account' };
  }
  const picked = credentialSourceForAccount(cfg, owner);
  if (!picked?.source) {
    // The account was unlinked since this session started. Saying so beats
    // seeding somebody else's credential, and beats silence.
    log.warn(`sandbox: ${owner} has no credential on this box any more; ${claude} keeps the one it has`);
    return { refreshed: false, account: owner, why: 'no credential for that account' };
  }
  const state = readCredentialState(picked.source);
  if (state.state === 'expired') {
    log.warn(`sandbox: ${owner}'s credential on this box is itself expired; ${claude} would gain nothing`);
    return { refreshed: false, account: owner, why: 'the host credential is expired too' };
  }
  const seeded = seedCredentials(cfg, claude, picked, actor);
  if (!seeded.ok) {
    log.warn(`sandbox: could not refresh ${claude}: ${seeded.message}`);
    return { refreshed: false, account: owner, why: seeded.message };
  }
  // The RESOLVED account, not the recorded one. A volume recorded as `shared`
  // resolves to the person the box credential was adopted as, and reporting the
  // old word would write it straight back onto the registry record — keeping a
  // name alive for something that no longer exists.
  return { refreshed: true, account: picked.account };
}

/**
 * Which credential file belongs to a named account.
 *
 * Deliberately keyed on the ACCOUNT rather than on an actor: a refresh has to
 * reproduce a decision made at volume-creation time, possibly by a different
 * person, and re-running the actor rule would answer a different question.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} account  an email, or "shared"
 * @returns {{ source: string|null, accountMeta: string|null, account: string }|null}
 */
export function credentialSourceForAccount(cfg, account) {
  // `shared` is what volumes created before docs/one-account-per-person.md
  // recorded, and those sessions are still running. The migration adopts the
  // box credential into a named row, so the honest answer for an old volume is
  // the account that adoption produced — resolved through the operator, which
  // is the same person.
  const email = account === 'shared' ? operatorAccount(cfg).email : account;
  if (!email) return null;
  const store = new Accounts(cfg.stateDir);
  const linked = store.credentialPathFor(email);
  if (!linked) return null;
  return { source: linked, accountMeta: store.accountMetaPathFor(email), account: email };
}

/**
 * The email a conversation volume was seeded for, read out of the volume.
 *
 * The volume can identify itself because `.oauth-account.json` is seeded
 * beside the credential — so this works for sessions that predate the account
 * field on the registry record, which is most of the ones anybody has running
 * when this ships.
 *
 * Returns "shared" for a volume with no email in it, because that is what the
 * shared credential's metadata looks like when the box has one, and null when
 * the read fails at all — cannot-tell, not shared.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} volume
 * @returns {string|null}
 */
export function volumeAccount(cfg, volume) {
  const r = podman(cfg, [
    'run', '--rm', '-v', `${volume}:/dest:ro`, sessionImage(cfg),
    'sh', '-c', 'cat /dest/.oauth-account.json 2>/dev/null || true',
  ]);
  if (r.status !== 0) return null;
  const text = String(r.stdout).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const email = parsed?.emailAddress ?? parsed?.email_address;
    if (typeof email !== 'string' || !email) return null;
    // Whether that email is a LINKED account or the shared one is answered by
    // the store, not by the shape of the address: the shared credential has an
    // email too, and it is not a per-person account.
    return new Accounts(cfg.stateDir).credentialPathFor(email) ? email : 'shared';
  } catch {
    return null;
  }
}

/**
 * Give a fresh conversation volume this box's house rules, if it has any.
 *
 * NEVER FAILS A START. Credentials are load-bearing — a session without one
 * comes up at a login prompt nobody is there to answer, so seedCredentials
 * refuses. Rules are not: a session without them does the same work slightly
 * differently. So everything here warns and carries on, and the warning is the
 * point, because "you wrote rules and they are being ignored" is the failure
 * mode worth catching.
 *
 * THE CONTENT GOES ON STDIN, not into the argument list and not through a
 * mount. Not through the argument list for the reason this whole file is
 * careful about: text a person wrote must never be parsed as shell. Not
 * through a mount because the size was checked in this process a moment ago,
 * and a mount would copy whatever the file says NOW — a gap that only matters
 * on a box where somebody is editing the file as sessions start, which is
 * exactly the box where somebody is editing the file.
 *
 * ON CREATION ONLY, like the credential and for a firmer reason: a session's
 * standing instructions must not change under it. Edit the file and the next
 * session gets it; the one already running keeps what it began with, which is
 * the property that makes a running session something you can reason about.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} volume
 * @returns {{ seeded: boolean, chars: number }}
 */
function seedHouseRules(cfg, volume) {
  const rules = readHouseRules(cfg);
  if (!rules) return { seeded: false, chars: 0 };
  if (!rules.ok || !rules.text) {
    log.warn(`sandbox: no house rules for ${volume} — ${rules.why}`);
    return { seeded: false, chars: rules.chars };
  }

  const r = podman(
    cfg,
    ['run', '--rm', '-i', '-v', `${volume}:/dest`, '--network', 'none', sessionImage(cfg),
      'sh', '-c', 'cat > /dest/CLAUDE.md && chmod 644 /dest/CLAUDE.md'],
    { input: rules.text },
  );
  if (r.status !== 0) {
    log.warn(`sandbox: could not write house rules into ${volume}: ${r.stderr.trim().slice(0, 200)}`);
    return { seeded: false, chars: rules.chars };
  }
  log.info(`sandbox: gave ${volume} ${rules.chars} characters of house rules`);
  return { seeded: true, chars: rules.chars };
}

/**
 * Copy a Claude credential into a conversation volume.
 *
 * Done with a throwaway container rather than by writing into the volume's
 * host path directly: under rootless podman that path is inside a user
 * namespace, and the uid mapping is exactly the thing we must not hand-roll.
 *
 * WHOSE credential is decided by the caller and handed in, not worked out
 * here. There are two callers with two different questions — a fresh start
 * asks "whose is this actor's" and a resume asks "whose was this volume's" —
 * and a function that answered both would have to guess which one it was being
 * asked, which is how a resume ends up on a different account.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} volume
 * @param {{ source: string|null, accountMeta?: string|null, account: string, why?: string }} picked
 * @param {string|null} [actor]  for the provider tokens, which key on the
 *   person rather than on the Claude account — see pickSecretsFile.
 * @returns {{ ok: boolean, message?: string, account?: string }}
 */
function seedCredentials(cfg, volume, picked, actor = null) {
  const source = picked.source;
  if (!source) {
    // REFUSED, NOT SKIPPED. This used to return ok — "deliberately disabled" —
    // because the only way to get here was an operator emptying the config.
    // Now it means nobody's account was found, and starting anyway produces a
    // session that comes up at a login prompt with nobody there to answer it,
    // which is the exact silent hang this whole tool exists to prevent.
    //
    // The refusal carries WHY, because every version of it is a thing one
    // person can fix in one step: link an account, or name which of several is
    // the operator.
    return {
      ok: false,
      message:
        `No Claude account to give this session on ${cfg.hostname}: ${picked.why ?? 'none is linked on this box'}.\n`
        // NAMES THE MACHINE, and does not name a screen. Claude is linked PER
        // MACHINE, so "connect one" without saying which box is an instruction
        // somebody can follow and still not fix this — they connect on the host
        // they happen to be looking at, and the scheduler puts the next session
        // somewhere else.
        //
        // The screen was named too, and named wrongly: it said "under Your
        // credentials in the app", which on iOS hid Claude and on Android does
        // not exist. A remedy pointing at a surface that cannot perform it is
        // worse than one that just says what is needed.
        + `Connect a Claude account for ${cfg.hostname} from the app, or run \`agent-hub login\` on that box.`,
    };
  }
  // The identity rides with the credential when there is one. The entrypoint
  // merges .oauth-account.json into the container's /root/.claude.json on
  // every start — the newer CLI reads logged-in-ness off the PAIR, and a
  // credential without its oauthAccount is a login that fails while every
  // file involved is genuine.
  const mounts = ['-v', `${volume}:/dest`, '-v', `${source}:/seed/.credentials.json:ro`];
  let copy = 'cp /seed/.credentials.json /dest/.credentials.json && chmod 600 /dest/.credentials.json';
  if (picked.accountMeta) {
    mounts.push('-v', `${picked.accountMeta}:/seed/.oauth-account.json:ro`);
    copy += ' && cp /seed/.oauth-account.json /dest/.oauth-account.json && chmod 600 /dest/.oauth-account.json';
  }
  // The other credentials — GitHub, Cloudflare, whatever gets added — ARE NOT
  // SEEDED ANY MORE. They used to be copied in as `.secrets.env` and exported
  // by the entrypoint, which froze them at start: a rotated token reached the
  // next session and could not reach into a running one.
  //
  // The session asks the broker instead, over the socket it already has. See
  // credential-broker.js. Nothing about the Claude credential changes — that
  // one is read by a CLI we do not control, from a path it expects, so it is
  // still a file in the volume.
  const r = podman(cfg, ['run', '--rm', ...mounts, sessionImage(cfg), 'sh', '-c', copy]);
  if (r.status !== 0) {
    return {
      ok: false,
      message: `could not seed credentials into ${volume}: ${r.stderr.trim().slice(0, 200)}\n(is ${source} readable?)`,
    };
  }
  log.info(`sandbox: seeded ${picked.account} credentials into ${volume}`);
  return { ok: true, account: picked.account };
}

/**
 * Which credential file a session gets, and whose it is.
 *
 * Exported for tests: the selection is the whole feature and podman is not.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string|null} actor
 * @returns {{ source: string|null, accountMeta?: string|null, account: string, why?: string }}
 *   `why` is present only when `source` is null, and is written to be shown to
 *   a person: it is the difference between "this session cannot start" and
 *   "this session cannot start because you have not linked an account".
 */
export function pickCredentialSource(cfg, actor) {
  const email = emailFromActor(actor);
  const store = new Accounts(cfg.stateDir);
  if (email) {
    const linked = store.credentialPathFor(email);
    if (linked) return { source: linked, accountMeta: store.accountMetaPathFor(email), account: email };
    // NO FALLBACK TO THE BOX ANY MORE. This used to return the machine's own
    // account here, on the grounds that a shared org plan is a licence somebody
    // chose to share. True of an org and false of a guest — and the standing
    // rule for guests is that they bring their own everything, which was a
    // policy nobody could see being applied. Now it is structural.
    return { source: null, accountMeta: null, account: email, why: `${email} has not linked a Claude account` };
  }
  // An actor with no email is somebody operating the box: Telegram, the CLI,
  // the local web UI. They run as a PERSON now rather than as the machine —
  // see operatorAccount and docs/one-account-per-person.md.
  const operator = operatorAccount(cfg);
  if (!operator.email) return { source: null, accountMeta: null, account: 'nobody', why: operator.why };
  return {
    source: store.credentialPathFor(operator.email),
    accountMeta: store.accountMetaPathFor(operator.email),
    account: operator.email,
  };
}

/**
 * Which connected tokens a session gets — GitHub, Cloudflare, and whatever
 * else is in the catalogue.
 *
 * An actor with a verified email gets THEIR tokens or none — "the guests will
 * be bringing their own GitHub, Cloudflare, Claude creds, no shared creds to
 * them." The box's own row is for actors that have no email — the CLI,
 * Telegram, the web UI, all of which are somebody operating the box itself.
 *
 * This used to be described here as differing from the Claude credential, which
 * fell back to the box's shared account. It no longer does: there is no box
 * account (docs/one-account-per-person.md), so all three providers now follow
 * the rule this function always had.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string|null} actor
 * @returns {string|null}
 */
export function pickSecretsFile(cfg, actor) {
  // rowForActor, not emailFromActor: this used to read `emailFromActor(actor)`
  // and hand `null` straight to the store, where null MEANT THE BOX'S SHARED
  // ROW. So a fleet actor that failed to parse did not fail — it silently
  // selected the row every session on the machine reads. Now the three cases
  // are three answers, and the unparseable one is a refusal.
  const row = rowForActor(actor);
  if (row === null) return null;
  const file = new Connections(cfg.stateDir).envPathFor(row);
  return file && existsSync(file) ? file : null;
}

/**
 * Extract the shared account's identity into a seedable file, refreshed on
 * every call so a re-login on the box propagates to the next session.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {string|null}
 */
export function sharedAccountMetaFile(cfg) {
  try {
    if (!cfg.sandboxCredentialsFile) return null;
    const home = path.dirname(path.dirname(cfg.sandboxCredentialsFile));
    const meta = extractOauthAccount(readFileSync(path.join(home, '.claude.json'), 'utf8'));
    if (!meta) return null;
    const dir = path.join(cfg.stateDir, 'accounts');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, '.shared.account.json');
    writeFileSync(file, meta, { mode: 0o600 });
    return file;
  } catch {
    return null; // no state file, unreadable, no oauthAccount — all mean "seed without it"
  }
}

/**
 * Delete a session's volumes. This is what makes /forget mean what it says:
 * it already meant "no longer resumable", and without this the conversation and
 * the workspace both survive on disk indefinitely.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @returns {{ removed: string[], failed: Array<{volume: string, why: string}> }}
 */
export function removeSandboxVolumes(cfg, name) {
  const { claude, work } = sandboxNames(name);
  /** @type {string[]} */ const removed = [];
  /** @type {Array<{volume: string, why: string}>} */ const failed = [];

  for (const volume of [claude, work]) {
    if (!volumeExists(cfg, volume)) continue;
    // -f because the container may still be shutting down; the session was
    // killed a moment ago and podman's cleanup is asynchronous.
    const r = podman(cfg, ['volume', 'rm', '-f', volume]);
    if (r.status === 0) {
      removed.push(volume);
      log.info(`sandbox: removed volume ${volume}`);
    } else {
      failed.push({ volume, why: r.stderr.trim().slice(0, 200) });
      log.warn(`sandbox: could not remove ${volume}: ${r.stderr.trim().slice(0, 200)}`);
    }
  }
  return { removed, failed };
}

/**
 * Stop a session's container directly.
 *
 * Normally unnecessary — killing the tmux session kills the pane process, which
 * is podman, and `--rm` cleans up. This is the belt-and-braces path for a
 * container that outlived its pane.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 */
export function stopSandboxContainer(cfg, name) {
  const { container } = sandboxNames(name);
  if (!exists(cfg, 'container', container)) return false;
  podman(cfg, ['rm', '-f', container]);
  return true;
}
