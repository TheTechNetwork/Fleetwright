// SETTING UP PROXMOX VE THROUGH A MACHINE OF THE FLEET, for a phone that
// cannot reach the node itself. docs/proxmox.md, "Through a machine".
//
// Asked for, after setup from the phone shipped direct-only: "If phone can
// not ssh directly why not ssh through one of the nodes that it can reach?
// Same as all the other things we did?" So it is the same as the others: the
// phone asks the fleet who reaches the node (`xoprobe`, which reports the SSH
// host key it was answered with), the person compares that key with the
// node's console, the chosen machine signs a key for the job (`xosetup`
// phase `pve`, under `pvesetup-key`), and the root password comes sealed to
// that key, so the coordinator relays what it cannot read. The machine opens
// the SSH connection an install opens (xo-deploy.js, openPool: the host key
// held to the one compared, the password answered once and wiped), and then
// does on the node exactly what the phone does when it reaches it: the SAME
// COMMANDS, which test/pve-pools.test.js holds equal across the three.
//
// THE LINE COMES BACK SEALED to the key the phone sent with the password,
// under its own name (seal.js, pvesetupHandoffAad), and this machine keeps
// nothing of it: it is read from the root-only file once, the file removed,
// and the copy dropped with the job.
//
// A CANCEL STOPS THE UNIT on the node, which the script is written to be
// stopped in: it finds what it made first when run again.

import { PVESETUP_STEPS } from '../protocol/intents.js';
import { parseConnection } from './pve-pools.js';

export const UNIT = 'fleetwright-pve-setup';
export const LINE_FILE = '/root/.fleetwright-pve-line';
export const SCRIPT_URL = 'https://raw.githubusercontent.com/TheTechNetwork/Fleetwright/main/install/fleetwright-pve-setup';

/** The node's clock at the start, so the journal is read from this run alone. */
export const NOW = 'date +%s';

/**
 * The command a person runs by hand, and the one both phones show: the
 * script fetched and run, naming the fleet a closed lab answers names for.
 *
 * @param {string} coordinator
 */
export function setupCommand(coordinator) {
  return `curl -fsSLo /root/fleetwright-pve-setup ${SCRIPT_URL} && bash /root/fleetwright-pve-setup --coordinator ${coordinator}`;
}

/**
 * Start the setup as a unit of its own, with the line to a file. A run
 * already going is stopped first: the person asked again.
 *
 * @param {string} coordinator
 */
export function startCommand(coordinator) {
  const run = `${setupCommand(coordinator)} --line-file ${LINE_FILE}`;
  return `systemctl stop ${UNIT} 2>/dev/null; systemctl reset-failed ${UNIT} 2>/dev/null; rm -f ${LINE_FILE}; ` +
    `systemd-run --unit=${UNIT} --collect /bin/bash -c '${run}'`;
}

/**
 * How far it has got: its step and error lines since `since`, whether it
 * runs, and whether the line is there.
 *
 * @param {number} since
 */
export function pollCommand(since) {
  return `journalctl -u ${UNIT} --since @${since} -o cat --no-pager | grep -E '^fleetwright-(step|error):' | tail -n 40; ` +
    `echo "state=$(systemctl is-active ${UNIT})"; test -f ${LINE_FILE} && echo line=ready`;
}

/** The line, read once and removed. */
export const TAKE_LINE = `cat ${LINE_FILE} && rm -f ${LINE_FILE}`;

/** Stopping a run the person cancelled. */
export const STOP = `systemctl stop ${UNIT} 2>/dev/null; rm -f ${LINE_FILE}`;

/**
 * What a poll said.
 *
 * @param {string} out
 * @returns {{ steps: string[], error: string|null, running: boolean, lineReady: boolean }}
 */
export function progressOf(out) {
  const lines = String(out || '').split('\n');
  const error = lines.filter((l) => l.startsWith('fleetwright-error: ')).pop();
  return {
    steps: lines.filter((l) => l.startsWith('fleetwright-step: ')).map((l) => l.slice('fleetwright-step: '.length).trim()),
    error: error ? error.slice('fleetwright-error: '.length).trim() : null,
    running: lines.includes('state=active') || lines.includes('state=activating'),
    lineReady: lines.includes('line=ready'),
  };
}

/** The script's own steps, in the order it says them, after `node`. */
const SCRIPT_STEPS = PVESETUP_STEPS.slice(1);

/**
 * The job's steps, in PVESETUP_STEPS order: `node` opens the connection,
 * starts the script and reads the clock; each later step waits until the
 * script has said the step after it (or `done`), so a step is drawn as
 * running while the script runs it. `line` reads the line, checks it is one
 * and seals it to the phone.
 *
 * @param {{
 *   open: (ctx: any) => Promise<{ remote: (script: string, opts?: { timeoutMs?: number }) => Promise<{ code: number|null, stdout: string, stderr: string }> }>,
 *   coordinatorUrl: string|null,
 *   sealLine: (ctx: any, line: string) => Promise<void>,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   pollMs?: number,
 *   limitMs?: number,
 * }} deps
 * @returns {Array<(ctx: any) => Promise<any>>}
 */
export function pveSteps({ open, coordinatorUrl, sealLine, sleep, now, pollMs = 5_000, limitMs = 45 * 60_000 }) {
  /**
   * Wait until the script has said a step after `key`, or ended.
   *
   * @param {any} ctx
   * @param {string} key
   */
  const until = async (ctx, key) => {
    const after = SCRIPT_STEPS.slice(SCRIPT_STEPS.indexOf(key) + 1).concat('done');
    for (;;) {
      if (ctx.last && after.some((s) => ctx.last.steps.includes(s))) return;
      if (ctx.rec.cancelled) throw new Error('cancelled');
      if (now() > ctx.deadline) throw new Error(`the setup on the node had not finished after ${Math.round(limitMs / 60_000)} minutes. It may still be running there: journalctl -u ${UNIT} on the node says where it is.`);
      const r = await ctx.pool.remote(pollCommand(ctx.since), { timeoutMs: 60_000 });
      if (r.code === null) throw new Error('the node stopped answering over SSH while the setup ran. It may still be running there.');
      ctx.last = progressOf(r.stdout);
      if (after.some((s) => ctx.last.steps.includes(s))) return;
      if (ctx.last.error) throw new Error(`the node said: ${ctx.last.error}`);
      if (!ctx.last.running) throw new Error(`the setup on the node stopped without saying why. journalctl -u ${UNIT} on the node has its output.`);
      await sleep(pollMs);
    }
  };
  return [
    // node
    async (ctx) => {
      if (!coordinatorUrl || !/^https:\/\/[A-Za-z0-9.:/_-]+$/.test(coordinatorUrl)) {
        throw new Error('this machine does not know its fleet’s address, which the setup names for closed labs. Update it and try again.');
      }
      ctx.pool = await open(ctx);
      const clock = await ctx.pool.remote(NOW, { timeoutMs: 30_000 });
      const since = Number.parseInt(String(clock.stdout).trim(), 10);
      if (clock.code !== 0 || !Number.isInteger(since)) throw new Error('the node did not say what time it is, so its setup could not be followed. Nothing was started.');
      ctx.since = since;
      const started = await ctx.pool.remote(startCommand(coordinatorUrl), { timeoutMs: 60_000 });
      if (started.code !== 0) throw new Error(`the node would not start the setup: ${lastLine(started.stderr || started.stdout) || `systemd-run said ${started.code}`}.`);
      ctx.started = true;
      ctx.deadline = now() + limitMs;
    },
    ...SCRIPT_STEPS.filter((s) => s !== 'line').map((key) => async (/** @type {any} */ ctx) => until(ctx, key)),
    // line
    async (ctx) => {
      await until(ctx, 'line');
      // THE FILE CAN LAG THE WORD `done` by the write; one more look.
      for (let i = 0; i < 3 && !ctx.last.lineReady; i++) {
        await sleep(Math.min(pollMs, 2_000));
        const r = await ctx.pool.remote(pollCommand(ctx.since), { timeoutMs: 60_000 });
        ctx.last = progressOf(r.stdout);
      }
      if (!ctx.last.lineReady) throw new Error(`the setup finished but left no line in ${LINE_FILE}. Run it again from the app.`);
      const taken = await ctx.pool.remote(TAKE_LINE, { timeoutMs: 30_000 });
      const line = String(taken.stdout).trim();
      if (taken.code !== 0 || !parseConnection(line)) throw new Error('the line the node wrote is not one the fleet reads. Run the setup again.');
      await sealLine(ctx, line);
      ctx.started = false;
    },
  ];
}

/**
 * Stop the run on the node, for a job that started it and did not finish.
 * Never throws.
 *
 * @param {any} ctx
 */
export async function stopOnNode(ctx) {
  if (!ctx.started || !ctx.pool) return false;
  try {
    const r = await ctx.pool.remote(STOP, { timeoutMs: 30_000 });
    ctx.started = false;
    return r.code === 0;
  } catch {
    return false;
  }
}

/** @param {string} text */
function lastLine(text) {
  return String(text || '').trim().split('\n').pop()?.trim().slice(0, 200) ?? '';
}
