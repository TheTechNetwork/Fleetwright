// Which releases this box takes, and where that answer lives.
//
// NOT IN /etc/agent-hub.env, and that is the whole design. The env file is
// installed 0600 and root-owned; agent-hub runs as an unprivileged user and
// cannot write it. A setting somebody is meant to change from a phone cannot
// live somewhere only root can edit — that is the shape this project keeps
// finding, where the product names a fix and only a shell can apply it.
//
// So it lives in the state directory, which the service owns. One line, one
// word, and a file somebody can read with `cat` when they are wondering.
//
// THE ENVIRONMENT STILL WINS, and refuses rather than being overridden
// silently. An operator who sets AGENT_HUB_RELEASE_CHANNEL has said something
// deliberate — probably from configuration management — and a phone quietly
// writing a file that the next process start ignores would be the exact failure
// this repository has paid for repeatedly: true where it was written, quietly
// false one layer up. Setting the channel refuses in that case and says which
// file to edit instead.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** The only two answers. `stable` is what a box gets by saying nothing. */
export const CHANNELS = Object.freeze(['stable', 'prerelease']);

/** @param {import('../config.js').Config} cfg */
function channelFile(cfg) {
  return path.join(cfg.stateDir, 'release-channel');
}

/**
 * Which channel this box is on.
 *
 * Read at the moment it is needed rather than cached into the config at
 * startup, because the point is that it changes without a restart. It is one
 * small file read, on a path taken once per update check.
 *
 * @param {import('../config.js').Config} cfg
 * @returns {'stable'|'prerelease'}
 */
export function readChannel(cfg) {
  const fromEnv = String(cfg.releaseChannel || '').trim().toLowerCase();
  if (CHANNELS.includes(fromEnv)) return /** @type {any} */ (fromEnv);
  try {
    const stored = readFileSync(channelFile(cfg), 'utf8').trim().toLowerCase();
    if (CHANNELS.includes(stored)) return /** @type {any} */ (stored);
  } catch {
    // No file is the ordinary case and means stable, which is what a box that
    // has never been asked should be on.
  }
  return 'stable';
}

/**
 * Whether the environment is forcing a channel, and so overriding the file.
 *
 * @param {import('../config.js').Config} cfg
 */
export function pinnedByEnv(cfg) {
  return CHANNELS.includes(String(cfg.releaseChannel || '').trim().toLowerCase());
}

/**
 * Move this box to a channel.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} value
 * @returns {{ ok: boolean, channel?: string, message: string }}
 */
export function writeChannel(cfg, value) {
  const wanted = String(value || '').trim().toLowerCase();
  if (!CHANNELS.includes(wanted)) {
    return { ok: false, message: `"${String(value).slice(0, 30)}" is not a channel. It is one of: ${CHANNELS.join(', ')}.` };
  }
  // REFUSED RATHER THAN OVERRIDDEN. Writing a file the next read ignores is
  // worse than not writing it: the app would show one channel and the box would
  // take another, and nothing anywhere would say so.
  if (pinnedByEnv(cfg)) {
    return {
      ok: false,
      message:
        `AGENT_HUB_RELEASE_CHANNEL is set to "${cfg.releaseChannel}" in this box's environment, ` +
        'which wins over anything set here.\n' +
        'Remove it from /etc/agent-hub.env and restart if you want to choose the channel from the app.',
    };
  }

  const file = channelFile(cfg);
  const tmp = `${file}.tmp`;
  try {
    // Written and renamed, so a box that loses power mid-write has either the
    // old channel or the new one and never half a word.
    writeFileSync(tmp, `${wanted}\n`, { mode: 0o644 });
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    return { ok: false, message: `could not write ${file}: ${/** @type {Error} */ (e).message}` };
  }
  return {
    ok: true,
    channel: wanted,
    message:
      wanted === 'prerelease'
        ? 'This box now takes prereleases — the newest build of main, on every merge.'
        : 'This box now takes published releases only.',
  };
}
