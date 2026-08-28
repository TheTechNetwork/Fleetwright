// Reading the service logs from chat.
//
// Same reasoning as /update: an operator who has to SSH in to find out why
// something failed will look at it later, and later is often never. The
// installer already learned this lesson — it prints the journal when a service
// fails to start rather than telling you where to find it — and this is the
// same thing, available after the fact and from a phone.
//
// WHAT IS DELIBERATELY NOT HERE
//
// A unit name from the wire. `journalctl -u "$whatever"` would read any unit on
// the box, and while everyone who can run this can already start a session with
// a shell in it, that is not a reason to add a second way. The verb set is a
// fixed list for the same reason the fleet protocol's is: a small, boring set
// of things is one you can reason about.

import { spawnSync } from 'node:child_process';

import { isValidName } from './names.js';
import { hasSession, capturePane } from './tmux.js';
import { podman, sandboxNames } from './podman.js';

/**
 * The services this can read, by the name someone would actually type.
 * A fixed list, not a pattern.
 */
export const LOG_SOURCES = Object.freeze({
  hub: { unit: 'agent-hub', what: 'the session manager' },
  coordinator: { unit: 'agent-fleet-coordinator', what: 'the fleet coordinator' },
  sidecar: { unit: 'agent-fleet-sidecar', what: 'this box as a fleet host' },
});

/**
 * A SESSION's own logs, which are a different question from a service's.
 *
 * `peek` shows the live pane — what the session looks like right now. This is
 * what it SAID: the container's stderr for a sandboxed session, and the pane
 * tail otherwise. The distinction matters most exactly when it is hardest to
 * get at: a session that died has no pane left to peek, and the reason it died
 * is in the container's output.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @param {number} lines
 * @returns {{ ok: boolean, text: string }}
 */
export function readSessionLogs(cfg, name, lines = 60) {
  if (!isValidName(name)) return { ok: false, text: `"${name}" is not a valid session name.` };

  // The container first: it outlives the pane. A crashed session's tmux window
  // is gone, and podman still has what it printed on the way out.
  if (cfg.sandbox) {
    const { container } = sandboxNames(name);
    const r = podman(cfg, ['logs', '--tail', String(lines), container]);
    // status 125 is "no such container", which is not an error worth showing
    // when a live pane can answer instead.
    if (r.status === 0) {
      const text = `${r.stdout}${r.stderr}`.trim();
      if (text) return { ok: true, text: `Container output for ${name}:\n${text}` };
      return { ok: true, text: `The container for ${name} has printed nothing.` };
    }
  }

  if (hasSession(name)) {
    return { ok: true, text: `Pane for ${name}:\n${capturePane(name, lines)}` };
  }
  return {
    ok: false,
    text:
      `Nothing left to read for "${name}" — no container and no pane.\n` +
      'A stopped session keeps its conversation; its output is gone with the container.',
  };
}

/** Aliases people reach for. @type {Record<string, keyof typeof LOG_SOURCES>} */
const ALIASES = {
  'agent-hub': 'hub',
  hub: 'hub',
  service: 'hub',
  main: 'hub',
  coord: 'coordinator',
  'agent-fleet-coordinator': 'coordinator',
  coordinator: 'coordinator',
  'agent-fleet-sidecar': 'sidecar',
  sidecar: 'sidecar',
  fleet: 'sidecar',
};

const DEFAULT_LINES = 40;
const MAX_LINES = 200;
// Two Telegram messages' worth. The adapter chunks at 4096, so this is a cap on
// how much of somebody's chat a single command may take over.
const MAX_CHARS = 7000;

/** @param {string} word @returns {keyof typeof LOG_SOURCES | null} */
export function resolveSource(word) {
  return ALIASES[String(word || '').toLowerCase()] ?? null;
}

/**
 * @param {import('../config.js').Config} cfg
 * @param {{ source?: string|null, lines?: number|null }} opts
 * @returns {{ ok: boolean, text: string, source?: string }}
 */
export function readLogs(cfg, { source = null, lines = null } = {}) {
  const key = source ? resolveSource(source) : /** @type {const} */ ('hub');
  if (!key) {
    return {
      ok: false,
      text: `"${source}" is not a service I can read. Try: ${Object.keys(LOG_SOURCES).join(', ')}.`,
    };
  }
  const { unit, what } = LOG_SOURCES[key];
  const count = Math.min(MAX_LINES, Math.max(1, Number(lines) || DEFAULT_LINES));

  const r = spawnSync(
    cfg.journalctlBin,
    ['-u', unit, '-n', String(count), '--no-pager', '--output', 'short-iso'],
    { encoding: 'utf8', timeout: 15_000 },
  );

  if (r.error) {
    // No journalctl at all: a container, WSL without systemd, a distro that
    // does not use journald. Nothing is broken, this just is not where the
    // logs are.
    return {
      ok: false,
      text:
        `No journalctl on this box, so I cannot read ${unit}'s logs.\n` +
        'Look wherever the service was started from instead.',
    };
  }

  const out = (r.stdout || '').trim();
  const err = (r.stderr || '').trim();

  // journalctl does not fail when a user cannot see system units — it returns
  // nothing and mentions it on stderr. Without translating that, /logs looks
  // like a service that has never logged anything.
  if (/not seeing messages from other users/i.test(err) && !out) {
    return {
      ok: false,
      text:
        `Cannot read ${unit}'s journal: this user is not allowed to see system logs.\n` +
        'Fix it with:  usermod -aG systemd-journal <user>   (then restart the service)\n' +
        'Re-running install/install.sh does this for you.',
    };
  }

  if (!out || /^-- No entries --$/m.test(out)) {
    return {
      ok: true,
      source: key,
      text: `No log entries for ${unit} (${what}). It may never have been started.`,
    };
  }

  // The TAIL, always. The end of a log is the part that says what went wrong;
  // the beginning is the part that was fine.
  let text = out;
  if (text.length > MAX_CHARS) {
    text = `…trimmed…\n${text.slice(text.length - MAX_CHARS)}`;
  }
  return { ok: true, source: key, text: `${unit} — last ${count} lines\n\n${text}` };
}

/**
 * Whether a unit exists at all, so the caller can offer only the ones this box
 * actually has rather than three buttons where two are dead.
 * @param {import('../config.js').Config} cfg
 * @param {string} unit
 */
export function unitInstalled(cfg, unit) {
  const r = spawnSync(cfg.systemctlBin, ['cat', unit], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0;
}
