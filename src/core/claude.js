// Everything agent-hub knows about driving the `claude` CLI unattended.
//
// Three hard-won behaviours live here. Each cost a real outage on the fleet
// this tool was extracted from; none of them are obvious from the CLI's help
// text.

import { capturePane, hasSession, sendKeys } from './tmux.js';
import { dewrapPane } from './pane.js';
import { log } from '../log.js';

/** @param {number} ms */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the command that runs inside the tmux pane.
 *
 * IS_SANDBOX=1 because root refuses --dangerously-skip-permissions otherwise.
 * `exec` so the pane's process IS claude — when claude exits the session ends,
 * rather than dropping to a bash prompt that looks alive but does nothing.
 *
 * skipPermissions and remoteControl accept null to mean "use the global
 * setting". A session that was started with an explicit override keeps it on
 * every later resume — silently promoting a session someone deliberately
 * started in safe mode would be the worst kind of surprise.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ name: string, resumeUuid?: string|null, skipPermissions?: boolean|null, remoteControl?: boolean|null }} opts
 */
export function buildCommand(cfg, { name, resumeUuid = null, skipPermissions = null, remoteControl = null }) {
  const rc = remoteControl === null ? cfg.remoteControl : remoteControl;
  const skip = skipPermissions === null ? cfg.skipPermissions : skipPermissions;

  const argv = [cfg.claudeBin];
  if (rc) argv.push('--remote-control', name);
  if (skip) argv.push('--dangerously-skip-permissions');
  if (resumeUuid) argv.push('--resume', resumeUuid);
  // Single-quote each argument: cfg.claudeBin can be an absolute path with
  // spaces, and resumeUuid/name are already charset-validated upstream.
  const quoted = argv.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  return `IS_SANDBOX=1 exec ${quoted}`;
}

// --- 1. Remote Control can silently fail to attach --------------------------
// A bare "does the tmux session exist?" check passes even when Remote Control
// never came up: the pane is alive but shows a plain local prompt with no RC
// status line, so whoever asked for the session can never reach it. The fix
// that works by hand is to re-issue `/remote-control <name>` in the session,
// so that is what we do automatically before giving up.

// Markers Claude Code prints once RC is online, across its interactive and
// server modes: the status line, the shareable URL, and the connected banner.
const RC_ONLINE_RE =
  /remote-control is active|claude\.ai\/code|Continue (?:here, on your phone|coding in the Claude mobile app)|·\s*Connected/i;

// The Remote Control URL is one long token in a fixed-width grid, so the pane
// may well have broken it across two rows before we ever read it — the same
// hazard the login flow already handles with dewrapPane. At 80 columns the URL
// happens to land on a line of its own and nothing goes wrong, which is why
// this went unnoticed; a narrower pane or a longer session id wraps it and the
// old `\S+` match returned a truncated URL that looks perfectly well-formed.
//
// Matching an explicit URL character set rather than `\S+` is the other half of
// the guard. De-wrapping can only ever join MORE text onto the end of the URL,
// and the pane is a TUI: the thing sitting there is as likely to be a box-drawing
// character as a real path segment. `\S+` would swallow it; this stops at the
// first character that cannot appear in a URL.
const RC_URL_RE = /https?:\/\/claude\.ai\/code\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/;

/** @param {string} text */
export function extractRcUrl(text) {
  const m = dewrapPane(text).match(RC_URL_RE);
  // Trailing punctuation is legal in a URL but is almost always the sentence
  // around it, so it goes — same rule the login flow uses on the auth URL.
  return m ? m[0].replace(/[)\].,]+$/, '') : null;
}

/**
 * Wait for Remote Control, re-issuing the command once if it does not appear.
 * Returns as soon as the marker shows up, so a healthy start costs a second or
 * two; only a genuine failure spends the full 2×timeout.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @returns {Promise<{ online: boolean, url: string|null, detail: string }>}
 */
export async function verifyRemoteControl(cfg, name) {
  /** @param {string} label */
  const watch = async (label) => {
    for (let waited = 0; waited < cfg.rcTimeoutMs; waited += 1000) {
      await sleep(1000);
      if (!hasSession(name)) {
        return { online: false, url: null, detail: `session exited during ${label}` };
      }
      const text = capturePane(name);
      // De-wrapped for the marker test too: one of the markers is the URL
      // itself, and a pane narrow enough to wrap it would split
      // "claude.ai/code" across two rows and match nothing.
      if (RC_ONLINE_RE.test(dewrapPane(text))) {
        return { online: true, url: extractRcUrl(text), detail: `remote control online (${label})` };
      }
    }
    return null; // not online within this window
  };

  const first = await watch('startup');
  if (first) return first; // online, or the pane died — either way we are done

  sendKeys(name, [`/remote-control ${name}`, 'Enter']);
  log.warn(`rc ${name}: not up after ${cfg.rcTimeoutMs}ms, re-issued /remote-control`);

  const second = await watch('retry');
  if (second) return second;

  return {
    online: false,
    url: null,
    detail: `remote control did not come online after retry (~${2 * cfg.rcTimeoutMs}ms)`,
  };
}

// --- 2. `--resume` does not always resume -----------------------------------
// On a large or stale conversation, claude shows an interactive dialog FIRST:
//
//     This session is 6d 12h old and 347.8k tokens.
//     Resuming the full session will consume a substantial portion of your
//     usage limits. We recommend resuming from a summary.
//       ❯ 1. Resume from summary (recommended)
//         2. Resume full session as-is
//         3. Don't ask me again
//
// and then blocks forever waiting for a keypress nobody sends. Unattended
// restore therefore fails silently for exactly the long-running sessions it
// exists to protect — one sat at this dialog for two days, alive in tmux and
// doing nothing.
//
// So: watch the pane, and press a key ONLY when the dialog is actually on
// screen. A session that resumed cleanly must never receive a stray Enter,
// which would submit an empty prompt into a live conversation.
//
// The default is a bare Enter = the highlighted "Resume from summary", which
// is the product's own recommendation and the cheapest in usage.
// AGENT_HUB_RESUME_CHOICE=2 resumes full sessions instead. Option 3 is
// deliberately unreachable: it flips a global preference for every future
// session, interactive ones included.

const RESUME_DIALOG_RE = /Resume from summary|Resume full session/;

/** @typedef {'summary'|'full'} ResumeChoice */

/**
 * @typedef {object} ResumeDialog
 * @property {string} info    e.g. "This session is 6d 12h old and 347.8k tokens."
 * @property {string[]} options the numbered choices, as shown
 * @property {string} raw     the captured pane, trimmed
 */

/**
 * Pull the readable parts out of the dialog so a requester can be shown what
 * they are choosing between — the age and token count are the whole reason the
 * choice exists, and picking blind is how people accidentally burn a large
 * chunk of their limits on a stale conversation.
 * @param {string} text
 * @returns {ResumeDialog|null}
 */
export function parseResumeDialog(text) {
  if (!RESUME_DIALOG_RE.test(text)) return null;
  const lines = text.split('\n').map((l) => l.trim());
  const info = lines.find((l) => /^This session is /i.test(l)) || '';
  const options = lines
    .filter((l) => /^[❯>»*]?\s*\d\.\s+\S/.test(l))
    // "Don't ask me again" is never offered: it flips a global preference for
    // every future session, interactive ones included. Showing an option we
    // will not honour just invites someone to pick it.
    .filter((l) => !/don'?t ask me again/i.test(l))
    .map((l) => l.replace(/^[❯>»*]\s*/, '').trim());
  return { info, options, raw: text.trim() };
}

/**
 * Is this session sitting at the resume dialog right now?
 * @param {string} name
 */
export function readResumeDialog(name) {
  if (!hasSession(name)) return null;
  return parseResumeDialog(capturePane(name, 40));
}

/**
 * Wait for the dialog to appear. Resolves null when it never does — which is
 * the common, healthy case: a small or recent conversation resumes straight
 * through with no prompt at all.
 * @param {import('../config.js').Config} cfg
 * @param {string} name
 * @returns {Promise<ResumeDialog|null>}
 */
export async function waitForResumeDialog(cfg, name) {
  const deadline = Date.now() + cfg.resumeDialogWaitMs;
  while (Date.now() < deadline) {
    await sleep(1500);
    if (!hasSession(name)) return null; // resumed and exited, or died
    const dialog = readResumeDialog(name);
    if (dialog) return dialog;
  }
  return null;
}

/**
 * Answer the dialog.
 *
 * 'summary' sends a bare Enter to take the already-highlighted "Resume from
 * summary (recommended)" rather than typing "1" — if a future release
 * reorders or unnumbers the menu, accepting the highlighted default still does
 * the right thing, whereas a literal "1" would be typed as text.
 * 'full' has to name its option, so it sends the digit.
 *
 * @param {string} name
 * @param {ResumeChoice} choice
 */
export function answerResumeDialog(name, choice) {
  if (choice === 'full') sendKeys(name, ['2']);
  sendKeys(name, ['Enter']);
  log.info(`resume dialog answered for ${name}: ${choice}`);
}

/**
 * Unattended path (boot restore): watch every just-restored session at once
 * and answer each dialog as it appears, with a fixed choice. Nobody is present
 * at boot, so this never asks — it takes cfg.resumeChoice, defaulting to the
 * cheap, recommended summary.
 *
 * Keys are sent ONLY when the dialog is actually on screen, so a session that
 * resumed cleanly never receives a stray Enter into a live conversation.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string[]} names
 * @param {ResumeChoice} choice
 * @returns {Promise<Record<string, 'answered'|'no-dialog'|'gone'>>}
 */
export async function dismissResumeDialogs(cfg, names, choice = 'summary') {
  /** @type {Record<string, 'answered'|'no-dialog'|'gone'>} */
  const outcome = {};
  let pending = [...names];
  const deadline = Date.now() + cfg.resumeDialogWaitMs;

  // One shared watch pass over everything at once rather than blocking on each
  // session in turn: the dialog takes a few seconds to render and they all
  // render in parallel, so boot stays short even with several sessions.
  while (pending.length && Date.now() < deadline) {
    await sleep(2000);
    /** @type {string[]} */
    const still = [];
    for (const name of pending) {
      if (!hasSession(name)) {
        outcome[name] = 'gone';
        continue;
      }
      if (readResumeDialog(name)) {
        answerResumeDialog(name, choice);
        outcome[name] = 'answered';
      } else {
        still.push(name);
      }
    }
    pending = still;
  }
  for (const name of pending) {
    outcome[name] = 'no-dialog';
    log.info(`${name}: no resume dialog within ${cfg.resumeDialogWaitMs}ms (it likely resumed cleanly)`);
  }
  return outcome;
}

// --- 3. Never fall back to `--continue` -------------------------------------
// `claude --continue` in a shared working directory resumes THAT DIRECTORY's
// most recent conversation. When several sessions share one workdir — which is
// the normal setup here — restoring them all with --continue makes every one of
// them attach to the same conversation. Sessions must be resumed by uuid or not
// at all; a session with no recorded uuid is reported as unresumable, and the
// caller is told to start a fresh one.
export const RESUME_REQUIRES_UUID =
  'No recorded conversation for this session, so it cannot be resumed. ' +
  '(agent-hub deliberately will not use --continue: in a shared workdir that resumes the ' +
  "directory's latest conversation, so every unknown session would collide on the same one.) " +
  'Start a new session instead.';
