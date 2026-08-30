// Updating the deployment in place, from chat.
//
// The point is the same as /login's: a box you can only fix by SSHing into it
// is a box that does not get fixed. Pulling a fix from a phone is the whole
// difference between "I will look at it on Monday" and it being done.
//
// Today that means `git pull`. The step after it — updating packages, the
// Claude CLI, the sandbox image — goes in `STEPS` below, which is why this is
// a list rather than one function.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//
// It does not merge. `--ff-only` means a deployment whose local history has
// diverged fails loudly instead of quietly creating a merge commit that nobody
// reviewed and that the next pull will trip over.
//
// It does not touch a dirty tree. Someone editing files on the box directly is
// either mid-debug or mid-hotfix, and blowing that away from a chat message is
// not a recoverable mistake.
//
// It does not restart by itself. Restarting is asked for explicitly, and even
// then it works by EXITING — systemd's Restart=always brings the process back
// with the new code, which needs no privileges the service does not already
// have. `systemctl restart` from an unprivileged service user would need
// polkit rules; exiting needs nothing.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { Connections } from './connectors.js';
import { refreshSandboxImage, podmanAvailable } from './podman.js';
import { requestRestart } from './restart-watch.js';

/** Long enough for a slow network, short enough that chat does not time out. */
const GIT_TIMEOUT_MS = 60_000;

/** npm is slower than git and a cold cache is not unusual. */
const NPM_TIMEOUT_MS = 180_000;

/** Time to let an adapter deliver the reply before the process exits. */
const RESTART_DELAY_MS = 1500;

/**
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || (r.error ? r.error.message : '')).trim(),
  };
}

/**
 * Where the deployment lives, and what state it is in.
 * @param {import('../config.js').Config} cfg
 */
export function updateStatus(cfg) {
  const dir = cfg.installDir;
  if (!existsSync(path.join(dir, '.git'))) {
    return { ok: false, dir, message: `${dir} is not a git checkout, so there is nothing to pull.` };
  }
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(dir, ['rev-parse', '--short', 'HEAD']);
  const dirty = git(dir, ['status', '--porcelain']);
  if (branch.status !== 0 || head.status !== 0) {
    // Overwhelmingly this is git's "dubious ownership" refusal: the checkout is
    // owned by whoever cloned it and the service runs as somebody else. Saying
    // so beats the raw message, which sends people looking at permissions.
    const detail = [branch.stderr, head.stderr].filter(Boolean).join(' ');
    const hint = /dubious ownership|safe\.directory/i.test(detail)
      ? `\n${dir} is owned by another user. Either chown it to the user this service runs as, ` +
        `or: git config --global --add safe.directory ${dir}`
      : '';
    return { ok: false, dir, message: `Could not read the checkout at ${dir}: ${detail}${hint}` };
  }
  return {
    ok: true,
    dir,
    branch: branch.stdout,
    head: head.stdout,
    dirty: dirty.stdout ? dirty.stdout.split('\n') : [],
  };
}

/**
 * The things an update does, in order. One entry today; the package and image
 * updates the deployment will eventually want are additions here rather than a
 * rewrite of the caller.
 *
 * Each returns { ok, changed, text }.
 */
/**
 * How far behind upstream this checkout is.
 *
 * Separate from updateStatus because it costs a network round trip: this
 * fetches. Cached for CHECK_TTL_MS so that a health report every fifteen
 * seconds does not turn into a git fetch every fifteen seconds.
 *
 * Deliberately fetch-and-compare rather than `git pull --dry-run`, which is not
 * a thing, and rather than asking the forge over HTTP, which would need a token
 * and would only work for one forge.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ now?: () => number, force?: boolean }} [opts]
 * @returns {{ ok: boolean, behind: number, head?: string, upstream?: string, checkedAt: number, message?: string }}
 */
export function updateAvailable(cfg, { now = () => Date.now(), force = false } = {}) {
  if (!force && cached && now() - cached.checkedAt < CHECK_TTL_MS) return cached;

  const dir = cfg.installDir;
  const status = updateStatus(cfg);
  if (!status.ok) return { ok: false, behind: 0, checkedAt: now(), message: status.message };

  const fetched = git(dir, ['fetch', '--quiet', '--no-tags']);
  if (fetched.status !== 0) {
    // Offline is not an error worth shouting about — a box that cannot reach
    // the remote still runs sessions perfectly well.
    const result = { ok: false, behind: 0, checkedAt: now(), message: `could not fetch: ${fetched.stderr.slice(0, 120)}` };
    cached = result;
    return result;
  }

  // SCOPED TO WHAT A HOST RUNS. Unscoped, this counted docs and app commits,
  // and a box that is "3 commits behind" for three README edits will be
  // updated and restarted by somebody who believes the number.
  const counted = git(dir, ['rev-list', '--count', 'HEAD..@{upstream}', '--', ...HOST_PATHS]);
  if (counted.status !== 0) {
    const result = { ok: false, behind: 0, checkedAt: now(), message: 'this branch has no upstream to compare against' };
    cached = result;
    return result;
  }

  const result = {
    ok: true,
    behind: Number(counted.stdout) || 0,
    head: status.head,
    upstream: git(dir, ['rev-parse', '--abbrev-ref', '@{upstream}']).stdout,
    checkedAt: now(),
  };
  cached = result;
  return result;
}

/** @type {ReturnType<typeof updateAvailable>|null} */
let cached = null;

// Fifteen minutes. Long enough that health reporting does not hammer the
// remote, short enough that "there is an update" arrives the same day.
const CHECK_TTL_MS = 15 * 60_000;

/**
 * Does this git failure mean "you do not own this checkout"?
 *
 * Exported because the phrasing is the entire content of the check, and the
 * only way to be sure it covers a case is to assert it against the porcelain
 * git actually prints. The first version matched "permission denied" alone,
 * which is NOT what git says for the common case — see the strings below.
 *
 * @param {string} output combined stdout and stderr from git
 */
export function looksLikeOwnershipProblem(output) {
  return /permission denied|insufficient permission|failed to write object|unpack-objects failed|dubious ownership|safe\.directory|read-only file system/i.test(
    output,
  );
}

/**
 * What a HOST actually runs.
 *
 * The repository is a monorepo: two apps, a Worker, a coordinator, docs, and
 * the host. A host runs a fraction of it — and `rev-list HEAD..@{upstream}`
 * counted all of it, so a README commit made every box report "1 commit
 * behind" and `/update --restart` then bounced three services to deliver a
 * paragraph.
 *
 * This list IS the package boundary, expressed in the only place that can act
 * on it today. When host code is published as a versioned artifact
 * (docs/packaging.md), this is the manifest that artifact is built from — so
 * getting it right now is work that carries forward rather than work thrown
 * away.
 *
 * `worker/` is deliberately absent: it is deployed by CI to Cloudflare and no
 * host runs it. `src/fleet/coordinator` IS present, because a box can run the
 * Node coordinator.
 */
export const HOST_PATHS = Object.freeze([
  'bin',
  'src',
  'install',
  'sandbox',
  'package.json',
  'package-lock.json',
]);

const STEPS = [
  {
    name: 'code',
    /** @param {import('../config.js').Config} cfg */
    run(cfg) {
      const dir = cfg.installDir;
      const before = git(dir, ['rev-parse', 'HEAD']).stdout;
      const pull = git(dir, ['pull', '--ff-only']);
      if (pull.status !== 0) {
        const output = pull.stderr + pull.stdout;
        if (/not possible to fast-forward|diverged/i.test(output)) {
          return {
            ok: false,
            changed: false,
            text:
              'This checkout has local commits that are not upstream, so it cannot fast-forward.\n' +
              `Sort it out on the box: git -C ${dir} status`,
          };
        }
        // The common one on a box where the checkout was made by root and the
        // service runs as somebody else. Giving the service sudo would be a
        // much larger grant than the problem deserves.
        //
        // "insufficient permission" is git's own wording for the case that
        // actually happens most — a root-owned object under .git/objects,
        // usually left by somebody running `sudo git pull` once. It never says
        // "permission denied" there, so matching only that phrase meant this
        // whole branch was dead for the very failure it was written for, and
        // the operator got the raw porcelain instead of the fix.
        if (looksLikeOwnershipProblem(output)) {
          return {
            ok: false,
            changed: false,
            text:
              `Cannot write to ${dir} — some of it belongs to another user.\n\n` +
              'Usually a root-owned object left by a `sudo git pull`. Re-run the installer,\n' +
              'which gives the whole checkout back to the account the service runs as:\n' +
              `  sudo ${dir}/install/install.sh\n\n` +
              'Or fix just the ownership:\n' +
              `  sudo chown -R $(stat -c %U ${dir}/bin/agent-hub) ${dir}`,
          };
        }
        return { ok: false, changed: false, text: `git pull failed: ${output.slice(0, 400)}` };
      }
      const after = git(dir, ['rev-parse', 'HEAD']).stdout;
      if (before === after) return { ok: true, changed: false, text: 'Already up to date.' };

      const shortlog = git(dir, ['log', '--oneline', '--no-decorate', `${before}..${after}`]);
      const lines = shortlog.stdout ? shortlog.stdout.split('\n') : [];
      const shown = lines.slice(0, 10);
      const more = lines.length > shown.length ? `\n…and ${lines.length - shown.length} more` : '';
      const summary = `Updated ${before.slice(0, 7)} → ${after.slice(0, 7)}:\n${shown.map((l) => `  ${l}`).join('\n')}${more}`;

      // DID ANY OF IT REACH THIS BOX? The checkout moved, but a host runs a
      // fraction of this repository. When the pull was all docs, apps or
      // Worker, `changed: false` means the caller does not restart — three
      // services bounced to deliver a paragraph is a real cost, and the
      // sessions that survive a restart are surviving something that did not
      // need to happen.
      const forHost = git(dir, ['rev-list', '--count', `${before}..${after}`, '--', ...HOST_PATHS]);
      const hostCommits = Number(forHost.stdout) || 0;
      if (forHost.status === 0 && hostCommits === 0) {
        return {
          ok: true,
          changed: false,
          text: `${summary}\n\nNothing in that runs on this box — docs, apps or the Worker. Not restarting.`,
        };
      }
      return { ok: true, changed: true, text: summary };
    },
  },

  {
    name: 'dependencies',
    /**
     * A pull can change what the code needs, and until this step existed it
     * did not change what is installed. The failure that produces is the worst
     * shape available: /update reports success, the service restarts, and the
     * coordinator dies with ERR_MODULE_NOT_FOUND naming a package nobody has
     * heard of — after the operator has been told it worked.
     *
     * @param {import('../config.js').Config} cfg
     * @param {{ changed: boolean }} prior
     */
    run(cfg, prior) {
      const dir = cfg.installDir;
      // A deployment with no package.json has no packages, and running npm in
      // one is how a perfectly good update reports a failure. Caught by the
      // existing update tests, which drive a bare git repo.
      if (!existsSync(path.join(dir, 'package.json'))) return { ok: true, changed: false, text: '' };

      const installed = existsSync(path.join(dir, 'node_modules'));
      // Nothing pulled and the packages are there: there is nothing this could
      // usefully do, and running npm on every /update turns a five-second
      // command into a thirty-second one.
      if (!prior.changed && installed) return { ok: true, changed: false, text: '' };

      const r = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: NPM_TIMEOUT_MS,
      });
      if (r.error && /** @type {any} */ (r.error).code === 'ENOENT') {
        return {
          ok: false,
          changed: false,
          text:
            'The code is updated, but npm is not installed on this box, so its packages are not.\n' +
            'agent-hub and the sidecar are fine without them; a coordinator here is not.\n' +
            `  sudo apt install npm && cd ${dir} && npm ci --omit=dev`,
        };
      }
      if (r.status !== 0) {
        const output = `${r.stderr || ''}${r.stdout || ''}`;
        // Same ownership story as the git objects above, and the same fix.
        if (looksLikeOwnershipProblem(output)) {
          return {
            ok: false,
            changed: false,
            text:
              `Cannot write ${path.join(dir, 'node_modules')} — it belongs to another user.\n` +
              `  sudo ${dir}/install/install.sh`,
          };
        }
        return { ok: false, changed: false, text: `npm ci failed:\n${output.slice(0, 400)}` };
      }

      // Comparing the lockfile before and after was the first version of this,
      // and it could not work: the code step has already pulled by the time
      // this runs, so both readings are of the same file. What is actually
      // known here is whether something was pulled and whether the packages
      // were there — which is enough to say something true.
      return installed
        ? { ok: true, changed: true, text: 'Packages are up to date.' }
        : { ok: true, changed: true, text: 'Installed the packages that were missing.' };
    },
  },

  {
    // THE SANDBOX IMAGE, which /update never touched.
    //
    // ensureSandboxImage returned on its first line for the entire life of a
    // box — `if (sandboxImageExists) return` — because the image was written
    // as a one-time install. It is a moving dependency: the session
    // entrypoint, the credential seeding and the trust flags all live inside
    // it, so shipping a fix there reached nobody until somebody ran `podman
    // pull` by hand. An update that leaves half the product on old code is the
    // same failure as a green CI run that deployed nothing.
    //
    // Sessions already running keep the image they started with — a container
    // does not swap its filesystem underneath itself — so this changes what
    // the NEXT session gets, which is exactly when it matters.
    name: 'sandbox image',
    /**
     * @param {import('../config.js').Config} cfg
     * @param {{ changed: boolean }} [_state] unused; the signature is shared
     *   across STEPS so the union stays inferable
     * @returns {{ ok: boolean, changed: boolean, text?: string }}
     */
    run(cfg, _state) {
      if (!cfg.sandbox) return { ok: true, changed: false };
      // Local builds are not pullable, and a box that builds its own image is
      // saying it wants that one.
      if (String(cfg.sandboxImage || '').startsWith('localhost/')) {
        return { ok: true, changed: false, text: 'Sandbox image is built locally — not refreshed.' };
      }
      if (!podmanAvailable(cfg)) return { ok: true, changed: false };
      const r = refreshSandboxImage(cfg);
      if (!r.ok) {
        // NOT a failure of the update. The box has a working image and the
        // registry is what went wrong; saying so and carrying on beats
        // failing an update over a network hiccup.
        return { ok: true, changed: false, text: `Could not refresh the sandbox image: ${r.message}` };
      }
      return r.changed
        ? { ok: true, changed: true, text: 'Sandbox image updated — new sessions will use it.' }
        : { ok: true, changed: false, text: 'Sandbox image is up to date.' };
    },
  },
  {
    name: 'credentials',
    /**
     * Clear out credential material this box will never use again.
     *
     * AN UPDATE IS THE MOMENT THIS BECOMES NECESSARY, which is why it lives
     * here rather than on a timer. Code that stops reading a field does not
     * remove the field: the release that moved the GitHub client secret onto
     * the config frame left a copy of the FLEET-WIDE secret in
     * `<row>.renewal.json` on every box that had ever connected GitHub, once
     * per member. Nothing reads it now, which does not make it harmless — a
     * credential nobody reads is a credential nobody is watching, and it is
     * still valid, still fleet-wide, and still in every backup taken since.
     *
     * Also drops renewal records that cannot renew anything: no client id, no
     * refresh token, or a provider this host no longer knows. Their only effect
     * is to make a box look like it can do something it cannot.
     *
     * @param {import('../config.js').Config} cfg
     */
    run(cfg) {
      let swept;
      try {
        swept = new Connections(cfg.stateDir).sweep();
      } catch (e) {
        // Never fails an update. A box that could not tidy up is a box that
        // still wants the new code.
        return { ok: true, changed: false, text: `Could not tidy stored credentials: ${/** @type {Error} */ (e).message}` };
      }

      const lines = [];
      if (swept.scrubbed.length) {
        lines.push(
          `Removed a stored copy of the GitHub app secret from ${swept.scrubbed.length} credential file(s). `
            + 'Nothing reads it any more; it should not have been left on disk.',
        );
      }
      if (swept.dropped.length && !swept.reconnect.length) {
        lines.push(`Dropped ${swept.dropped.length} renewal record(s) that could no longer renew anything.`);
      }
      // THE ONE A PERSON HAS TO ACT ON, said in the words of what happens to
      // them rather than of what we deleted. Somebody reading this has a GitHub
      // connection that works right now and stops within the day, and the
      // failure mode without this line is "it worked yesterday" with nothing on
      // any screen explaining why.
      if (swept.reconnect.length) {
        const who = [...new Set(swept.reconnect.map((r) => r.split('/')[0]))];
        lines.push(
          `GITHUB NEEDS RECONNECTING for ${who.join(', ')}.
`
            + 'Those tokens still work but can no longer renew themselves, so they will stop within eight hours. '
            + 'Reconnecting takes one tap in the app — Settings, Credentials, Connect GitHub — and nothing needs '
            + 'to be pasted or copied. Sessions already running keep the token they started with.',
        );
      }
      return { ok: true, changed: false, text: lines.join('\n\n') };
    },
  },
];



/**
 * Is this process running under systemd, and therefore able to come back after
 * exiting? INVOCATION_ID is set by systemd for every service it starts, and is
 * the cheapest reliable signal — far better than guessing from PPID.
 */
/**
 * The sibling services shipped from the same directory, and still running the
 * code that was on disk before this pull.
 *
 * `/update --restart` restarts THIS process — the hub exits and systemd's
 * Restart=always brings it back. It cannot restart the sidecar or the
 * coordinator: those are system units, and the service user has no privilege
 * over them. So on a box running more than one of them, an update applies to
 * one service and quietly does not apply to the others, and the message said
 * "Restarting now" as though it had covered everything.
 *
 * Says nothing when there is nothing to say — a single-service box, or one
 * where the siblings are already stopped.
 *
 * @returns {string[]} unit names that are active and now running stale code
 */
export function staleSiblings() {
  const units = ['agent-fleet-sidecar', 'agent-fleet-coordinator'];
  const stale = [];
  for (const unit of units) {
    const r = spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8' });
    // is-active answers "inactive" for a unit it has never heard of, so a box
    // without the sidecar installed is indistinguishable from one where it is
    // stopped — and in both cases there is nothing to restart. Only "active"
    // means somebody is running old code.
    if (!r.error && (r.stdout || '').trim() === 'active') stale.push(unit);
  }
  return stale;
}

export function canSelfRestart() {
  return Boolean(process.env.INVOCATION_ID);
}

/**
 * @param {import('../config.js').Config} cfg
 * @param {{ restart?: boolean, actor?: string|null, exit?: (code: number) => void }} opts
 * @returns {{ ok: boolean, changed: boolean, message: string, restarting: boolean }}
 */
export function runUpdate(cfg, { restart = false, actor = null, exit } = {}) {
  const status = updateStatus(cfg);
  if (!status.ok) return { ok: false, changed: false, message: status.message ?? 'update failed', restarting: false };

  if (status.dirty && status.dirty.length) {
    const shown = status.dirty.slice(0, 8).map((l) => `  ${l}`).join('\n');
    return {
      ok: false,
      changed: false,
      restarting: false,
      message:
        `${status.dir} has uncommitted changes, so nothing was pulled:\n${shown}` +
        (status.dirty.length > 8 ? `\n  …and ${status.dirty.length - 8} more` : '') +
        '\n\nSomeone is editing this box directly. Commit or discard on the box first.',
    };
  }

  log.info(`update: pulling ${status.dir} (${status.branch})${actor ? ` for ${actor}` : ''}`);

  const parts = [];
  let changed = false;
  for (const step of STEPS) {
    const result = step.run(cfg, { changed });
    // A step with nothing to say says nothing, rather than contributing a blank
    // paragraph to a chat message.
    if (result.text) parts.push(result.text);
    if (!result.ok) return { ok: false, changed, message: parts.join('\n\n'), restarting: false };
    changed = changed || result.changed;
  }

  if (!restart) {
    if (!changed) return { ok: true, changed: false, message: parts.join('\n\n'), restarting: false };
    parts.push(
      canSelfRestart()
        ? 'The new code is on disk but this process is still the old one. /update --restart to apply it.'
        : 'The new code is on disk. Restart the service to apply it.',
    );
    return { ok: true, changed: true, message: parts.join('\n\n'), restarting: false };
  }

  // A RESTART WAS ASKED FOR, so `changed` no longer decides anything.
  //
  // It used to. The check above ran before this block, which broke the exact
  // path the "Restart to apply" button exists to drive: the first /update
  // pulls and offers the button, the button runs /update --restart, that pull
  // finds nothing left to fetch — because the first one already fetched it —
  // and the whole thing returned "Already up to date" without restarting. The
  // new code sat on disk and the old process kept serving it, with the UI
  // reporting success.
  //
  // `changed` answers "did THIS invocation pull anything", which is not the
  // question. The question is whether the running process is the code on disk,
  // and an explicit restart request settles it: somebody asked, and a restart
  // that turns out to be unnecessary costs a few seconds and leaves every
  // session running.
  if (!canSelfRestart()) {
    parts.push('Not running under systemd, so this cannot restart itself — restart it however you started it.');
    return { ok: true, changed, message: parts.join('\n\n'), restarting: false };
  }

  if (!changed) {
    parts.push('Nothing new to pull — this is applying code that was already fetched.');
  }

  // Exit rather than `systemctl restart`: systemd's Restart=always brings us
  // straight back, and it needs no privilege an unprivileged service user does
  // not already have. Sessions are untouched — KillMode=process is what makes
  // that true, and is why that line in the unit is load-bearing.
  // Tell the siblings BEFORE exiting. After would be too late — this process
  // is about to stop, and a marker written from a dead process is not written
  // at all.
  requestRestart({ head: status.head, actor, stateDir: cfg?.stateDir });

  parts.push('Restarting now. Sessions are left running; this reconnects to them on the way back up.');

  // Only this process restarts. Anything else shipped from the same directory
  // keeps running the code that was there before the pull. It used to say so
  // and then hand over a `sudo systemctl restart` line, which is the one thing
  // this product exists so that nobody has to do — an update that needs a
  // terminal to finish is not an update. They watch for the marker now.
  const stale = staleSiblings();
  if (stale.length) {
    parts.push(
      `${stale.join(' and ')} will pick this up within a minute — nothing to run, and nothing to ssh into.`,
    );
  }
  log.warn(`update: restarting to apply ${status.head} → new code${actor ? ` (asked by ${actor})` : ''}`);
  const stop = exit || ((code) => process.exit(code));
  setTimeout(() => stop(0), RESTART_DELAY_MS);

  return { ok: true, changed: true, message: parts.join('\n\n'), restarting: true };
}
