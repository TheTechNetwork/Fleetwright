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
import { Accounts, emailFromActor, extractOauthAccount } from './accounts.js';
import { Connections } from './connectors.js';

// A first build pulls a base image, apt-installs a toolchain and npm-installs
// the CLI. Minutes, not seconds — and a timeout shorter than the work turns a
// slow network into a mystery.
const BUILD_TIMEOUT_MS = 15 * 60_000;

/**
 * @param {import('../config.js').Config} cfg
 * @param {string[]} args
 */
/** @param {import('../config.js').Config} cfg @param {string[]} args @param {{ timeout?: number }} [opts] */
export function podman(cfg, args, { timeout } = {}) {
  const r = spawnSync(cfg.podmanBin, args, { encoding: 'utf8', ...(timeout ? { timeout } : {}) });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? r.error.message : ''),
  };
}

/** @param {import('../config.js').Config} cfg */
export function podmanAvailable(cfg) {
  return spawnSync(cfg.podmanBin, ['--version'], { encoding: 'utf8' }).status === 0;
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
  return podman(cfg, ['image', 'exists', cfg.sandboxImage]).status === 0;
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
  if (refresh && !cfg.sandboxImage.startsWith('localhost/')) {
    const pulled = refreshSandboxImage(cfg);
    // A failed refresh is NOT fatal. The box has a working image; the network
    // is what failed. Falling through to the existence check leaves it running
    // on what it has rather than breaking an update over a registry hiccup.
    if (pulled.ok) return { ok: true, built: pulled.changed };
    log.warn(`sandbox: could not refresh ${cfg.sandboxImage}: ${pulled.message}`);
  }
  if (sandboxImageExists(cfg)) return { ok: true, built: false };

  const manual =
    `Build it with:\n  podman build -t ${cfg.sandboxImage} -f ${cfg.sandboxContainerfile} ` +
    `${path.dirname(cfg.sandboxContainerfile)}\n(or re-run install/install.sh)`;

  if (!cfg.sandboxAutoBuild) {
    return { ok: false, message: `the sandbox image ${cfg.sandboxImage} is not built, and auto-build is off.\n${manual}` };
  }

  const isLocal = cfg.sandboxImage.startsWith('localhost/');
  if (!isLocal) {
    log.info(`sandbox: pulling ${cfg.sandboxImage}`);
    const pulled = podman(cfg, ['pull', cfg.sandboxImage]);
    if (pulled.status === 0) return { ok: true, built: true };
    return { ok: false, message: `could not pull ${cfg.sandboxImage}: ${pulled.stderr.trim().slice(0, 300)}` };
  }

  if (!existsSync(cfg.sandboxContainerfile)) {
    return {
      ok: false,
      message: `the sandbox image ${cfg.sandboxImage} is not built and ${cfg.sandboxContainerfile} does not exist.\n${manual}`,
    };
  }

  // This blocks the session that asked for it, which is the point — it is the
  // difference between waiting once and being told to go and do it yourself.
  log.warn(`sandbox: ${cfg.sandboxImage} is not built — building it now, this takes a few minutes`);
  const context = path.dirname(cfg.sandboxContainerfile);
  const built = spawnSync(
    cfg.podmanBin,
    ['build', '-t', cfg.sandboxImage, '-f', cfg.sandboxContainerfile, context],
    { encoding: 'utf8', timeout: BUILD_TIMEOUT_MS },
  );
  if (built.status === 0) {
    log.info(`sandbox: built ${cfg.sandboxImage}`);
    return { ok: true, built: true };
  }
  // The last few lines of a build log are the ones that say what failed; the
  // rest is layers succeeding.
  const tail = String(built.stderr || built.stdout || '').trim().split('\n').slice(-6).join('\n');
  return { ok: false, message: `could not build ${cfg.sandboxImage}:\n${tail}\n\n${manual}` };
}

/** @param {import('../config.js').Config} cfg @param {string} volume */
function volumeExists(cfg, volume) {
  return podman(cfg, ['volume', 'exists', volume]).status === 0;
}

/**
 * Refresh the image on the way into a session — cheaply, and never in the way.
 *
 * A session that starts on a stale image gets stale behaviour, and the fix
 * living only in `/update` means it arrives when somebody remembers to run it.
 * So a start checks too. THE CONSTRAINTS ARE WHAT MAKE THIS SAFE:
 *
 *  - **Stamped.** At most once per refreshEveryMs (six hours by default), read
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
  if (!every || String(cfg.sandboxImage || '').startsWith('localhost/')) return { changed: false };
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
    const r = podman(cfg, ['image', 'inspect', '--format', '{{.Digest}}', cfg.sandboxImage]);
    return r.status === 0 ? String(r.stdout).trim() : null;
  };
  const before = digest();
  const pulled = podman(cfg, ['pull', cfg.sandboxImage], { timeout });
  if (pulled.status !== 0) {
    return { ok: false, changed: false, message: pulled.stderr.trim().slice(0, 200) };
  }
  const after = digest();
  const changed = Boolean(after) && after !== before;
  if (changed) log.info(`sandbox: image updated (${(before || 'none').slice(0, 19)} → ${(after || '').slice(0, 19)})`);
  return { ok: true, changed };
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
 * @returns {{ ok: boolean, message?: string, account?: string|null }}
 */
export function ensureSandboxVolumes(cfg, name, actor = null) {
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
  // null = the volumes already existed, so whatever was seeded on FIRST start
  // still applies — a resume never re-seeds, which is what keeps a session on
  // the account it began with.
  let account = null;

  for (const volume of [claude, work]) {
    if (volumeExists(cfg, volume)) continue;
    const created = podman(cfg, ['volume', 'create', volume]);
    if (created.status !== 0) {
      return { ok: false, message: `could not create volume ${volume}: ${created.stderr.trim().slice(0, 200)}` };
    }
    log.info(`sandbox: created volume ${volume}`);

    if (volume !== claude) continue;
    const seeded = seedCredentials(cfg, claude, actor);
    if (!seeded.ok) return seeded;
    account = seeded.account ?? 'shared';
  }
  return { ok: true, account };
}

/**
 * Copy the host's Claude credentials into a fresh conversation volume.
 *
 * Done with a throwaway container rather than by writing into the volume's
 * host path directly: under rootless podman that path is inside a user
 * namespace, and the uid mapping is exactly the thing we must not hand-roll.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} volume
 * @param {string|null} [actor]
 * @returns {{ ok: boolean, message?: string, account?: string }}
 */
function seedCredentials(cfg, volume, actor = null) {
  // WHOSE account this session runs as. A person who has linked their own
  // Claude account gets it seeded; everyone else — telegram, the CLI, people
  // who never linked — gets the shared org credential, exactly as before.
  // Decided by pickCredentialSource so it can be tested without podman.
  const picked = pickCredentialSource(cfg, actor);
  const source = picked.source;
  if (!source) return { ok: true }; // deliberately disabled
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
  // The other credentials — GitHub, Cloudflare, whatever gets added. Seeded on
  // the same terms as the Claude credential and for the same reason: a resume
  // never re-seeds, so a session keeps the tokens it began with and a rotation
  // reaches the next session rather than reaching backwards into a running one.
  const secrets = pickSecretsFile(cfg, actor);
  if (secrets) {
    mounts.push('-v', `${secrets}:/seed/.secrets.env:ro`);
    copy += ' && cp /seed/.secrets.env /dest/.secrets.env && chmod 600 /dest/.secrets.env';
  }
  const r = podman(cfg, ['run', '--rm', ...mounts, cfg.sandboxImage, 'sh', '-c', copy]);
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
 * @returns {{ source: string|null, accountMeta?: string|null, account: string }}
 */
export function pickCredentialSource(cfg, actor) {
  const email = emailFromActor(actor);
  if (email) {
    const store = new Accounts(cfg.stateDir);
    const linked = store.credentialPathFor(email);
    // Linked or shared, never an error: a member who has not linked simply
    // works on the org account, which is the promised default — not a wall.
    if (linked) return { source: linked, accountMeta: store.accountMetaPathFor(email), account: email };
  }
  return {
    source: cfg.sandboxCredentialsFile || null,
    // The shared identity, derived from the same home the shared credential
    // comes from: ~/.claude/.credentials.json sits inside ~/.claude, and the
    // state file sits beside that directory as ~/.claude.json. Null when it
    // is not there — an old box degrades to exactly the old behaviour.
    accountMeta: sharedAccountMetaFile(cfg),
    account: 'shared',
  };
}

/**
 * Which connected tokens a session gets — GitHub, Cloudflare, and whatever
 * else is in the catalogue.
 *
 * DELIBERATELY NOT THE SAME RULE AS THE CLAUDE CREDENTIAL, and the difference
 * is the point. A person with no linked Claude account falls back to the
 * shared one, because a shared org plan is a licence somebody chose to share.
 * A GitHub token is not: it is one person's access to their own repositories,
 * and handing it to a guest because they happen not to have connected their
 * own would be exactly the thing that was ruled out — "the guests will be
 * bringing their own GitHub, Cloudflare, Claude creds, no shared creds to
 * them."
 *
 * So: an actor with a verified email gets THEIR tokens or none. The box's own
 * row is for actors that have no email — the CLI, Telegram, the web UI, all of
 * which are somebody operating the box itself.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string|null} actor
 * @returns {string|null}
 */
export function pickSecretsFile(cfg, actor) {
  const store = new Connections(cfg.stateDir);
  const email = emailFromActor(actor);
  const file = store.envPathFor(email);
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
  if (podman(cfg, ['container', 'exists', container]).status !== 0) return false;
  podman(cfg, ['rm', '-f', container]);
  return true;
}
