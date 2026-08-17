// The only place in agent-hub that shells out to tmux. Everything is argv-array
// spawnSync — no shell string interpolation anywhere, so a session name can
// never become a command. (Names are validated separately in names.js; this is
// the second layer.)

import { spawnSync } from 'node:child_process';

/**
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
export function tmux(args) {
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  return {
    status: r.status === null ? 1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || (r.error ? r.error.message : ''),
  };
}

/** Is tmux installed and usable at all? Checked once at startup so the failure
 * is a clear message instead of every command silently returning nothing. */
export function tmuxAvailable() {
  return spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
}

// Exact-match targeting. A bare `-t name` is a PREFIX match in tmux, so a
// session called "api" would happily answer for "api-staging" — and stopping
// the wrong session is not a recoverable mistake.
//
// The two forms differ, which is easy to get wrong: `=name` is a session
// target and works for has-session/kill-session, but pane-targeting commands
// (capture-pane, send-keys) parse their target as session:window.pane, where a
// bare `=name` is read as a PANE name and fails with "can't find pane". Those
// need the session-qualified `=name:`.
/** @param {string} name */
const sessionTarget = (name) => `=${name}`;
/** @param {string} name */
const paneTarget = (name) => `=${name}:`;

/** @param {string} name */
export function hasSession(name) {
  return tmux(['has-session', '-t', sessionTarget(name)]).status === 0;
}

/**
 * Live session names. `=name` exact-match targeting is used everywhere else;
 * here we just list. Returns [] when there is no tmux server running at all
 * (exit 1), which is the normal state on a freshly booted box.
 * @returns {string[]}
 */
export function listSessions() {
  const r = tmux(['list-sessions', '-F', '#{session_name}']);
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Start a detached session running `command` under `bash -lc` in `cwd`.
 * bash -lc (login shell) so PATH and the claude credential helper resolve the
 * same way they do for an interactive operator — a plain exec finds neither.
 * @param {{ name: string, cwd: string, command: string }} opts
 */
export function newSession({ name, cwd, command }) {
  return tmux(['new-session', '-d', '-s', name, '-c', cwd, 'bash', '-lc', command]);
}

/** @param {string} name */
export function killSession(name) {
  return tmux(['kill-session', '-t', sessionTarget(name)]);
}

/**
 * Visible text of a session's pane, including `lines` of scrollback. Used to
 * detect the Remote Control status line and the resume dialog.
 * @param {string} name
 * @param {number} lines
 */
export function capturePane(name, lines = 120) {
  const r = tmux(['capture-pane', '-t', paneTarget(name), '-p', '-S', `-${lines}`]);
  return r.status === 0 ? r.stdout : '';
}

/**
 * @param {string} name
 * @param {string[]} keys tmux key names or literal text
 */
export function sendKeys(name, keys) {
  return tmux(['send-keys', '-t', paneTarget(name), ...keys]);
}
