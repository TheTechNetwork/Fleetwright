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

/**
 * The ceremony in flight, if there is one.
 *
 * `pin: null` is an EMPTY HOST — step one found nothing running, so there is
 * no pin to match and the hostname alone finishes it. Set by step one and only
 * by step one: no argument turns the pin off.
 *
 * @type {{ pin: string|null, actor: string|null, at: number }|null}
 */
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

  // Step 1: no arguments. Say what will be lost, and ask for as much as the
  // loss is worth.
  if (!args.length) {
    // THE CEREMONY COSTS WHAT THE REBOOT COSTS, which it did not before.
    //
    // Three confirmations were asked of every reboot, including one of a box
    // with nothing running on it — where the whole loss is a machine being
    // away for thirty seconds and coming back. That is not the end of the
    // world, and a ritual that treats it as one is a ritual people learn to
    // rush, which is exactly how the case that DOES matter gets rushed too.
    //
    // An empty host asks once. A host with work on it names the work and asks
    // for something only that machine could have issued.
    if (!sessions.length) {
      pending = { pin: null, actor, at: now() };
      return {
        ok: true,
        reboot: { sessions: 0, pinRequired: false, hostname },
        text:
          `Reboot ${hostname}?\n\nNo sessions are running, so nothing is lost — the box goes ` +
          `away and comes back.\n\nConfirm with:\n  /reboot ${hostname}`,
      };
    }

    // Six DIGITS, not hex. This gets typed on a phone, where a numeric keypad
    // is the difference between confirming and giving up — and randomInt is
    // uniform over the range, unlike the modulo of a random byte string.
    const pin = String(randomInt(0, 1_000_000)).padStart(6, '0');
    pending = { pin, actor, at: now() };
    return {
      ok: true,
      // AS DATA, so a screen can size its own ceremony rather than parsing this
      // sentence for a number. The apps ask for a fingerprint when this says
      // nothing is running and for the PIN when it does not.
      reboot: { sessions: sessions.length, pinRequired: true, hostname },
      // THE PIN AND THE HOSTNAME MAY ARRIVE TOGETHER, and once they were not
      // allowed to. The protocol asked for the PIN on its own first and refused
      // `/reboot <pin> <hostname>` in one message — but the apps append the
      // targeted host to the PIN the person entered, so the two ALWAYS arrive
      // together and the refusal was a step no phone could get past. Both proofs
      // are still required and checked — the live PIN this box issued, and the
      // hostname typed out, which is the wrong-box guard that actually matters —
      // and step 1 is still its own message, so a reboot still cannot happen in
      // one shot. What was dropped is only the second round trip, which no client
      // was making. The prompt still shows two steps for a client that does send
      // the PIN alone; both paths finish.
      text:
        `Reboot ${hostname}?\n\n` +
        `This will kill ${sessions.length} running session${sessions.length === 1 ? '' : 's'}:\n` +
        sessions.map((s) => `  ${s}`).join('\n') +
        '\n\nA reboot takes the tmux server with it. Nothing here resumes them afterwards.' +
        `\n\nStep 2 of 3 — confirm with:\n  /reboot ${pin}`,
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
  // AN EMPTY HOST NEEDS NO PIN, so the hostname alone finishes it. `pin: null`
  // is set by step one and only by step one — there is no argument that turns
  // the PIN off, and a box that had sessions when it was asked keeps needing
  // one even if they end while somebody is deciding.
  if (current.pin === null) {
    if (args[0] !== hostname) {
      return {
        ok: false,
        text: `This box is ${hostname}, not ${args[0]}. Nothing was done. /reboot to start again.`,
      };
    }
  } else {
    if (args[0] !== current.pin) {
      return { ok: false, text: 'That PIN does not match. /reboot to start again.' };
    }

    // The PIN alone: a client that sends it on its own gets step 3, so the
    // stepwise flow still works. The apps do not — they append the hostname —
    // and that combined message is handled just below.
    if (args.length === 1) {
      pending = { ...current, at: now() };
      return {
        ok: true,
        text:
          `Step 3 of 3 — type the hostname to confirm which machine this is:\n` +
          `  /reboot ${current.pin} ${hostname}`,
      };
    }

    // The PIN and the hostname together — the one message the apps actually
    // send. The wrong-box guard is the same as step 3's on its own: the second
    // argument has to be this machine's name, or nothing happens.
    if (args[1] !== hostname) {
      return {
        ok: false,
        text: `This box is ${hostname}, not ${args[1]}. Nothing was done. /reboot to start again.`,
      };
    }
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
