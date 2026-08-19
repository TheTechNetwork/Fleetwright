// Rebooting the box, from a chat message, on purpose.
//
// This is the most destructive thing the hub can do. It is not "restart the
// service" — /update already does that, and it is safe because KillMode=process
// leaves the tmux server alone. A reboot takes the tmux server with it, so
// every running session dies mid-thought, and anything not committed is gone.
//
// THREE CONFIRMATIONS, AND DELIBERATELY NOT THREE OF THE SAME THING. Tapping
// yes three times is one decision made three times; a person who misread the
// first prompt misreads all three. So each step asks for something different
// in kind, and each is harder to produce by accident than the last:
//
//   1. the command, which lists exactly what will be lost
//   2. a one-time six-digit PIN this box just generated — cannot be typed in
//      advance, cannot be replayed, expires
//   3. the hostname, typed out — the step that makes "wrong box" impossible,
//      which is the mistake actually worth preventing
//
// Step 3 is why a button cannot finish this. A button carries its payload with
// it, so a three-button flow is still three taps; typing the hostname is the
// only part that requires having read which machine you are talking to.

import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import os from 'node:os';

import { log } from '../log.js';

/** Long enough to read the list of sessions, short enough to not sit around. */
const CHALLENGE_TTL_MS = 120_000;

/** @type {{ pin: string, actor: string|null, at: number, stage: number }|null} */
let pending = null;

/** @param {() => number} [now] */
function live(now = () => Date.now()) {
  if (pending && now() - pending.at > CHALLENGE_TTL_MS) pending = null;
  return pending;
}

/** Visible for tests, and for a caller that wants to abandon the flow. */
export function cancelReboot() {
  const had = pending !== null;
  pending = null;
  return had;
}

/**
 * Drive the confirmation flow one step.
 *
 * @param {import('../config.js').Config} cfg
 * @param {string[]} args what came after /reboot
 * @param {{ actor?: string|null, sessions?: string[], now?: () => number, exec?: (argv: string[]) => { status: number, stderr: string } }} [opts]
 */
export function reboot(cfg, args, { actor = null, sessions = [], now = () => Date.now(), exec = defaultExec } = {}) {
  if (!cfg.systemReboot) {
    return {
      ok: false,
      text:
        'Rebooting from chat is off.\n\n' +
        'It is a bigger grant than the package one — it ends every running session — so it is a ' +
        'separate rule. On the box:\n\n' +
        `  echo '${cfg.runUser} ALL=(root) NOPASSWD: /usr/bin/systemctl reboot' \\\n` +
        '    | sudo tee /etc/sudoers.d/agent-hub-reboot\n' +
        '  sudo chmod 0440 /etc/sudoers.d/agent-hub-reboot\n\n' +
        'then set AGENT_HUB_SYSTEM_REBOOT=1 in /etc/agent-hub.env and restart.',
    };
  }

  const hostname = os.hostname();
  const current = live(now);

  // Step 1: no arguments. Say what will be lost, then issue the PIN.
  if (!args.length) {
    // Six DIGITS, not hex. This gets typed on a phone, where a numeric keypad
    // is the difference between confirming and giving up — and randomInt is
    // uniform over the range, unlike the modulo of a random byte string.
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    pending = { pin, actor, at: now(), stage: 1 };
    const loss = sessions.length
      ? `This will kill ${sessions.length} running session${sessions.length === 1 ? '' : 's'}:\n` +
        sessions.map((s) => `  ${s}`).join('\n') +
        '\n\nA reboot takes the tmux server with it. Nothing here resumes them afterwards.'
      : 'No sessions are running.';
    return {
      ok: true,
      text: `Reboot ${hostname}?\n\n${loss}\n\nStep 2 of 3 — confirm with:\n  /reboot ${pin}`,
    };
  }

  if (!current) {
    return { ok: false, text: 'No reboot is pending, or it expired. Start again with /reboot.' };
  }
  // Tied to whoever started it: a second person answering somebody else's
  // prompt is not a confirmation, it is a coincidence.
  if (current.actor !== actor) {
    return { ok: false, text: 'That reboot was started by somebody else. /reboot to start your own.' };
  }
  if (args[0] !== current.pin) {
    return { ok: false, text: 'That PIN does not match. /reboot to start again.' };
  }

  // Step 2: the PIN alone. Ask for the hostname.
  if (args.length === 1) {
    pending = { ...current, stage: 2, at: now() };
    return {
      ok: true,
      text:
        `Step 3 of 3 — type the hostname to confirm which machine this is:\n` +
        `  /reboot ${current.pin} ${hostname}`,
    };
  }

  if (current.stage < 2) {
    return { ok: false, text: 'Confirm the PIN on its own first: /reboot ' + current.pin };
  }
  if (args[1] !== hostname) {
    return {
      ok: false,
      text: `This box is ${hostname}, not ${args[1]}. Nothing was done. /reboot to start again.`,
    };
  }

  pending = null;
  log.warn(`reboot: rebooting ${hostname}${actor ? ` for ${actor}` : ''}`);
  const r = exec(['sudo', '-n', '/usr/bin/systemctl', 'reboot']);
  if (r.status !== 0) {
    return {
      ok: false,
      text:
        `Reboot failed: ${r.stderr.split('\n')[0] || 'unknown error'}\n\n` +
        (/password is required|not allowed/i.test(r.stderr)
          ? 'That is the sudoers rule missing — /reboot with AGENT_HUB_SYSTEM_REBOOT unset prints the line.'
          : ''),
    };
  }
  return { ok: true, text: `Rebooting ${hostname} now. This will go quiet for a minute or two.` };
}

/** @param {string[]} argv */
function defaultExec(argv) {
  const r = spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 20_000 });
  return { status: r.status ?? 1, stderr: (r.stderr || '').trim() };
}
