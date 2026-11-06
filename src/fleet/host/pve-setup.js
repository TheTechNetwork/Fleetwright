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
import { connectionOf } from './pve-pools.js';

export const UNIT = 'fleetwright-pve-setup';
export const LINE_FILE = '/root/.fleetwright-pve-line';
export const SCRIPT_URL = 'https://raw.githubusercontent.com/TheTechNetwork/Fleetwright/main/install/fleetwright-pve-setup';

/** The node's clock at the start, so the journal is read from this run alone. */
export const NOW = 'date +%s';

/**
 * A range of machine numbers as the person gives it, FROM-TO: what goes into
 * a command, so it is checked to be digits and a dash before it does. The
 * script and the boxes hold it to Proxmox's own bounds again (vmidsOf).
 */
export const VMIDS_RE = /^(?:[1-9]\d{2,8})-(?:[1-9]\d{2,8})$/;

/**
 * The command a person runs by hand, and the one both phones show: the
 * script fetched and run, naming the fleet a closed lab answers names for,
 * and the range its machines take when the person gave one.
 *
 * @param {string} coordinator @param {string|null} [vmids] @param {PveOptions|null} [options]
 */
export function setupCommand(coordinator, vmids = null, options = null) {
  return `curl -fsSLo /root/fleetwright-pve-setup ${SCRIPT_URL} && bash /root/fleetwright-pve-setup --coordinator ${coordinator}` +
    (vmids && VMIDS_RE.test(vmids) ? ` --vmids ${vmids}` : '') + optionArgs(options);
}

/**
 * @typedef {{
 *   firewall?: boolean, rebuildImage?: boolean, noImage?: boolean,
 *   channel?: 'stable'|'rolling', storage?: string, bridge?: string,
 *   expireDays?: number, groups?: number, labsOpen?: number, labsClosed?: number,
 * }} PveOptions
 */

/** A storage id as Proxmox VE names one. */
export const PVE_STORAGE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A Linux bridge's name. */
export const PVE_BRIDGE_RE = /^[A-Za-z0-9_.-]{1,15}$/;

/**
 * EVERY OPTION THE SETUP TAKES, from the app. Asked for: "Everything should
 * be in app". The datacenter firewall, the storage and bridge the fleet
 * uses, how many group and lab networks it makes, the update channel its
 * machines follow, whether the image is built again or not at all, and how
 * long the token lasts. Each is checked here because it goes into a
 * command, and the phones check the same (ProxmoxLine); the script checks
 * again and says what is wrong. Null for anything that is not a valid set,
 * with what is wrong; an empty set is no options at all.
 *
 * @param {unknown} v
 * @returns {{ options: PveOptions, problem: null }|{ options: null, problem: string }}
 */
export function pveOptionsOf(v) {
  if (v === undefined || v === null) return { options: {}, problem: null };
  if (typeof v !== 'object' || Array.isArray(v)) return { options: null, problem: 'the options are not a set of options' };
  const o = /** @type {any} */ (v);
  /** @type {PveOptions} */
  const out = {};
  const no = (/** @type {string} */ problem) => ({ options: null, problem });
  for (const k of ['firewall', 'rebuildImage', 'noImage']) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== 'boolean') return no(`${k} is yes or no`);
    if (o[k]) /** @type {any} */ (out)[k] = true;
  }
  if (out.rebuildImage && out.noImage) return no('the image cannot be built again and not built at all');
  if (o.channel !== undefined && o.channel !== '') {
    if (o.channel !== 'stable' && o.channel !== 'rolling') return no('the channel is stable or rolling');
    out.channel = o.channel;
  }
  if (o.storage !== undefined && o.storage !== '') {
    if (typeof o.storage !== 'string' || !PVE_STORAGE_RE.test(o.storage)) return no('the storage is not a Proxmox VE storage id');
    out.storage = o.storage;
  }
  if (o.bridge !== undefined && o.bridge !== '') {
    if (typeof o.bridge !== 'string' || !PVE_BRIDGE_RE.test(o.bridge)) return no("the bridge is not a bridge's name");
    out.bridge = o.bridge;
  }
  if (o.expireDays !== undefined && o.expireDays !== null) {
    if (!Number.isInteger(o.expireDays) || o.expireDays < 1 || o.expireDays > 3650) return no('the token lasts 1 to 3650 days');
    out.expireDays = o.expireDays;
  }
  for (const k of ['groups', 'labsOpen', 'labsClosed']) {
    if (o[k] === undefined || o[k] === null) continue;
    if (!Number.isInteger(o[k]) || o[k] < 0 || o[k] > 4) return no('group and lab networks are 0 to 4 each');
    /** @type {any} */ (out)[k] = o[k];
  }
  if ((out.labsOpen ?? 0) + (out.labsClosed ?? 0) > 4) return no('four labs at most, open and closed together');
  return { options: out, problem: null };
}

/**
 * The options as the script's arguments, each one only when it was given,
 * so a node run with none is run exactly as before.
 *
 * @param {PveOptions|null|undefined} options
 */
export function optionArgs(options) {
  const read = pveOptionsOf(options ?? null);
  const o = read.options;
  if (!o) return '';
  return [
    o.firewall ? ' --enable-firewall' : '',
    o.rebuildImage ? ' --rebuild-image' : '',
    o.noImage ? ' --no-image' : '',
    o.channel ? ` --channel ${o.channel}` : '',
    o.storage ? ` --storage ${o.storage}` : '',
    o.bridge ? ` --bridge ${o.bridge}` : '',
    o.expireDays ? ` --expire-days ${o.expireDays}` : '',
    o.groups !== undefined ? ` --groups ${o.groups}` : '',
    o.labsOpen !== undefined ? ` --labs-open ${o.labsOpen}` : '',
    o.labsClosed !== undefined ? ` --labs-closed ${o.labsClosed}` : '',
  ].join('');
}

/**
 * Start the setup as a unit of its own, with the line to a file. A run
 * already going is stopped first: the person asked again.
 *
 * @param {string} coordinator @param {string|null} [vmids] @param {PveOptions|null} [options]
 */
export function startCommand(coordinator, vmids = null, options = null) {
  const run = `${setupCommand(coordinator, vmids, options)} --line-file ${LINE_FILE}`;
  return `systemctl stop ${UNIT} 2>/dev/null; systemctl reset-failed ${UNIT} 2>/dev/null; rm -f ${LINE_FILE}; ` +
    `systemd-run --unit=${UNIT} --collect /bin/bash -c '${run}'`;
}

/**
 * How far it has got: its step and error lines since `since`, the last
 * `fleetwright-part:` line of the step it is on (none once a later step has
 * begun), whether it runs, and whether the line is there.
 *
 * @param {number} since
 */
export function pollCommand(since) {
  return `journalctl -u ${UNIT} --since @${since} -o cat --no-pager | ` +
    `awk '/^fleetwright-(step|error):/ {print} /^fleetwright-step:/ {p=0} /^fleetwright-part:/ {p=$0} END {if (p) print p}'; ` +
    `echo "state=$(systemctl is-active ${UNIT})"; test -f ${LINE_FILE} && echo line=ready`;
}

/** The line, read once and removed. */
export const TAKE_LINE = `cat ${LINE_FILE} && rm -f ${LINE_FILE}`;

/** Stopping a run the person cancelled. */
export const STOP = `systemctl stop ${UNIT} 2>/dev/null; rm -f ${LINE_FILE}`;

/**
 * What a poll said. `part` is how far into its step the script is: `fill` in
 * thousandths, or null when it measured nothing, and what it is doing; null
 * when it has said nothing of the step it is on.
 *
 * @param {string} out
 * @returns {{ steps: string[], error: string|null, running: boolean, lineReady: boolean, part: { fill: number|null, text: string }|null }}
 */
export function progressOf(out) {
  const lines = String(out || '').split('\n');
  const error = lines.filter((l) => l.startsWith('fleetwright-error: ')).pop();
  // Only after the last step line: a part belongs to the step it was said in.
  let after = 0;
  lines.forEach((l, i) => {
    if (l.startsWith('fleetwright-step: ')) after = i + 1;
  });
  return {
    steps: lines.filter((l) => l.startsWith('fleetwright-step: ')).map((l) => l.slice('fleetwright-step: '.length).trim()),
    error: error ? error.slice('fleetwright-error: '.length).trim() : null,
    running: lines.includes('state=active') || lines.includes('state=activating'),
    lineReady: lines.includes('line=ready'),
    part: partOf(lines.slice(after).filter((l) => l.startsWith('fleetwright-part: ')).pop()),
  };
}

/**
 * One `fleetwright-part:` line, or null for none or one that is not shaped
 * as the script writes it.
 *
 * @param {string|undefined} line
 * @returns {{ fill: number|null, text: string }|null}
 */
export function partOf(line) {
  const m = /^fleetwright-part: (-|\d{1,4}) (.+)$/.exec(String(line ?? '').trim());
  if (!m) return null;
  const fill = m[1] === '-' ? null : Math.min(1000, Number(m[1]));
  return { fill, text: m[2].replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 160) };
}

/** The script's own steps, in the order it says them, after `node`. */
const SCRIPT_STEPS = PVESETUP_STEPS.slice(1);

/**
 * The job's steps, in PVESETUP_STEPS order: `node` opens the connection,
 * starts the script and reads the clock; each later step waits until the
 * script has said the step after it (or `done`), so a step is drawn as
 * running while the script runs it, and what the script says of how far into
 * it it is goes to `say`. `line` reads the line, checks it is one and seals
 * it to the phone.
 *
 * @param {{
 *   open: (ctx: any) => Promise<{ remote: (script: string, opts?: { timeoutMs?: number }) => Promise<{ code: number|null, stdout: string, stderr: string }> }>,
 *   coordinatorUrl: string|null,
 *   sealLine: (ctx: any, line: string) => Promise<void>,
 *   say?: (ctx: any, part: { fill: number|null, text: string }) => void,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   pollMs?: number,
 *   limitMs?: number,
 * }} deps
 * @returns {Array<(ctx: any) => Promise<any>>}
 */
export function pveSteps({ open, coordinatorUrl, sealLine, say = () => {}, sleep, now, pollMs = 5_000, limitMs = 45 * 60_000 }) {
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
      // HOW FAR INTO THIS STEP, said while it is still this step's: the
      // image's download and build are most of the wait.
      if (ctx.last.part && ctx.last.steps.at(-1) === key) say(ctx, ctx.last.part);
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
      const started = await ctx.pool.remote(startCommand(coordinatorUrl, ctx.rec?.vmids ?? null, ctx.rec?.options ?? null), { timeoutMs: 60_000 });
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
      if (taken.code !== 0) throw new Error(`the line the node wrote could not be read from ${LINE_FILE}. Run the setup again.`);
      const read = connectionOf(line);
      if (!read.record) throw new Error(`the line the node wrote is not one the fleet reads: ${read.problem}. Run the setup again.`);
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
