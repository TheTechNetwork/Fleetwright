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
import { HOLDER_ID_RE, HOLDER_SECRET_RE } from '../protocol/holder-join.js';
import { connectionOf, PVE_HOLDER_TAG } from './pve-pools.js';
import { IMAGES } from './vm-image.js';

export const UNIT = 'fleetwright-pve-setup';
export const LINE_FILE = '/root/.fleetwright-pve-line';
/** Where the pin and name the cluster's own machine joins with are written, root only; the script removes it. */
export const HOLDER_JOIN_FILE = '/root/.fleetwright-holder-join';
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
 *   firewall?: boolean, rebuildImage?: boolean, noImage?: boolean, images?: string[],
 *   channel?: 'stable'|'rolling', storage?: string, bridge?: string,
 *   expireDays?: number, groups?: number, labsOpen?: number, labsClosed?: number,
 *   holder?: boolean, holderAgain?: boolean, holderSecret?: string,
 *   edge?: boolean, edgeBlock?: boolean, edgeAgain?: boolean, edgePair?: boolean,
 *   grants?: { upgrades?: boolean, reboot?: boolean },
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
  // WHICH IMAGES, by the catalogue's keys (vm-image.js, IMAGES), which are
  // the script's own (`pinned`): each once, in the order asked, at least one.
  if (o.images !== undefined && o.images !== null) {
    if (!Array.isArray(o.images) || o.images.length === 0 || o.images.length > Object.keys(IMAGES).length) return no('the images are a list of one or more');
    if (o.images.some((/** @type {unknown} */ k) => typeof k !== 'string' || !Object.hasOwn(IMAGES, k))) return no(`the images are ${Object.keys(IMAGES).join(', ')}`);
    if (new Set(o.images).size !== o.images.length) return no('each image is asked for once');
    out.images = [...o.images];
  }
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
  // A MACHINE OF ITS OWN (docs/proxmox.md): whether to make one, whether to
  // make it again, the secret the person's phone made for it to ask to join
  // with (src/fleet/protocol/holder-join.js), and what it may do from chat.
  // AN EDGE ROUTER (docs/proxmox.md, "The edge router"): whether to make one,
  // whether it drops what the threat rules match, whether to make it again,
  // and whether there are two of them (`edgePair`).
  for (const k of ['edge', 'edgeBlock', 'edgeAgain', 'edgePair']) {
    if (o[k] === undefined || o[k] === null) continue;
    if (typeof o[k] !== 'boolean') return no(`${k} is yes or no`);
    if (o[k]) /** @type {any} */ (out)[k] = true;
  }
  if ((out.edgeBlock || out.edgeAgain || out.edgePair) && !out.edge) return no('the edge router drops, is made again and comes in two only while it is asked for');
  for (const k of ['holder', 'holderAgain']) {
    if (o[k] === undefined || o[k] === null) continue;
    if (typeof o[k] !== 'boolean') return no(`${k} is yes or no`);
    if (o[k]) /** @type {any} */ (out)[k] = true;
  }
  if (out.holderAgain && !out.holder) return no('the machine of its own is made again only while it is asked for');
  if (o.holderSecret !== undefined && o.holderSecret !== null) {
    if (!out.holder || typeof o.holderSecret !== 'string' || !HOLDER_SECRET_RE.test(o.holderSecret)) return no('that is not a secret for the machine of its own');
    out.holderSecret = o.holderSecret;
  }
  if (o.grants !== undefined && o.grants !== null) {
    if (typeof o.grants !== 'object' || Array.isArray(o.grants)) return no('what it may do from chat is a set of yes or no');
    /** @type {{ upgrades?: boolean, reboot?: boolean }} */
    const g = {};
    for (const k of ['upgrades', 'reboot']) {
      if (o.grants[k] === undefined) continue;
      if (typeof o.grants[k] !== 'boolean') return no(`${k} is yes or no`);
      g[/** @type {'upgrades'|'reboot'} */ (k)] = o.grants[k];
    }
    if (Object.keys(g).length) out.grants = g;
  }
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
    o.images ? ` --images ${o.images.join(',')}` : '',
    o.channel ? ` --channel ${o.channel}` : '',
    o.storage ? ` --storage ${o.storage}` : '',
    o.bridge ? ` --bridge ${o.bridge}` : '',
    o.expireDays ? ` --expire-days ${o.expireDays}` : '',
    o.groups !== undefined ? ` --groups ${o.groups}` : '',
    o.labsOpen !== undefined ? ` --labs-open ${o.labsOpen}` : '',
    o.labsClosed !== undefined ? ` --labs-closed ${o.labsClosed}` : '',
    o.edge ? (o.edgeBlock ? ' --edge-block' : ' --edge') : '',
    o.edge && o.edgeAgain ? ' --edge-again' : '',
    o.edge && o.edgePair ? ' --edge-pair' : '',
  ].join('');
}

/**
 * Start the setup as a unit of its own, with the line to a file. A run
 * already going is stopped first: the person asked again.
 *
 * @param {string} coordinator @param {string|null} [vmids] @param {PveOptions|null} [options]
 */
export function startCommand(coordinator, vmids = null, options = null, holderJoin = false) {
  // THE MACHINE OF ITS OWN only with the file its pin was written to, and
  // made again only then: the script refuses one without the other.
  const holder = holderJoin ? ` --holder-join ${HOLDER_JOIN_FILE}${options?.holderAgain ? ' --holder-again' : ''}` : '';
  const run = `${setupCommand(coordinator, vmids, options)}${holder} --line-file ${LINE_FILE}`;
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

/**
 * THE CLUSTER'S OWN MACHINES as the script finds them: outside the pool, not
 * templates, tagged. Asked before a pin is, so a setup run again over a
 * machine already there spends no pin and reserves no name.
 */
export const HOLDER_FIND = 'pvesh get /cluster/resources --type vm --output-format json';

/**
 * The cluster's own machines in that answer, by name and whether each is up.
 *
 * @param {string} out @param {string} [pool]
 * @returns {Array<{ vmid: number, name: string, running: boolean }>}
 */
export function holdersIn(out, pool = 'fleetwright') {
  let all;
  try {
    all = JSON.parse(String(out || '[]'));
  } catch {
    return [];
  }
  return (Array.isArray(all) ? all : [])
    .filter((v) => v?.type === 'qemu' && (v.pool ?? '') !== pool && Number(v.template) !== 1 && String(v.tags || '').split(/[;,\s]+/).includes(PVE_HOLDER_TAG))
    .map((v) => ({ vmid: Number(v.vmid), name: String(v.name || '').slice(0, 80), running: v.status === 'running' }))
    .sort((a, b) => a.vmid - b.vmid);
}

/**
 * THE ADDRESS THE LINE WILL CARRY, worked out on the node as the script works
 * it out (its first address, port 8006), before a pin is asked for: the
 * machine of its own is reserved for that address, proves its request with
 * it and is let hold the vault item named by it, so the three must agree.
 * The script refuses a join file for any other.
 */
export const ADDRESS_FIND = "hostname -I | awk '{print $1}'";

/**
 * The address the line will carry, from ADDRESS_FIND's answer; null when the
 * node gave none.
 *
 * @param {string} out
 */
export function lineAddressOf(out) {
  const ip = String(out || '').trim().split(/\s+/)[0] ?? '';
  return /^[0-9A-Fa-f.:]{2,45}$/.test(ip) ? `${ip}:8006` : null;
}

/**
 * The file the script reads the pin from, written root-only in one command:
 * the JSON in base64, so nothing in it reaches the shell as words.
 *
 * @param {{ hostId: string, pin: string, address: string, secret?: string|null, grants?: { upgrades?: boolean, reboot?: boolean }|null }} join
 */
export function holderJoinCommand({ hostId, pin, address, secret = null, grants = null }) {
  if (!HOLDER_ID_RE.test(hostId)) throw new Error(`${hostId} is not a name the fleet gives a machine of its own`);
  if (!/^\d{6}$/.test(pin)) throw new Error('that is not an enrolment pin');
  if (!/^[A-Za-z0-9.:[\]-]{1,253}$/.test(String(address))) throw new Error('that is not the address of the cluster');
  if (secret !== null && !HOLDER_SECRET_RE.test(secret)) throw new Error('that is not a secret for a machine of its own');
  const json = JSON.stringify({ hostId, pin, address, ...(secret ? { secret } : {}), ...(grants && Object.keys(grants).length ? { grants } : {}) });
  return `umask 077; printf %s ${Buffer.from(json).toString('base64')} | base64 -d >${HOLDER_JOIN_FILE}`;
}

/**
 * THE MACHINES OF ITS OWN THIS RUN REMOVED to make one again, read once its
 * step is over: apart from pollCommand, which both phones send word for word.
 *
 * @param {number} since
 */
export function removedCommand(since) {
  return `journalctl -u ${UNIT} --since @${since} -o cat --no-pager | grep '^fleetwright-holder-removed: ' || true`;
}

/** The line, read once and removed. */
export const TAKE_LINE = `cat ${LINE_FILE} && rm -f ${LINE_FILE}`;

/** Stopping a run the person cancelled. */
export const STOP = `systemctl stop ${UNIT} 2>/dev/null; rm -f ${LINE_FILE} ${HOLDER_JOIN_FILE}`;

/**
 * What a poll said. `part` is how far into its step the script is: `fill` in
 * thousandths, or null when it measured nothing, and what it is doing; null
 * when it has said nothing of the step it is on.
 *
 * @param {string} out
 * @returns {{ steps: string[], error: string|null, running: boolean, lineReady: boolean, part: { fill: number|null, text: string }|null, removed: string[] }}
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
    // THE CLUSTER'S OWN MACHINES IT REMOVED to make one again, by name, and
    // only names of the fleet's shape: anything else on a VM is a label.
    removed: lines.filter((l) => l.startsWith('fleetwright-holder-removed: ')).map((l) => l.slice('fleetwright-holder-removed: '.length).trim()).filter((n) => HOLDER_ID_RE.test(n)),
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
 *   holderPin?: ((ctx: any, address: string) => Promise<{ ok: boolean, pin?: string, hostId?: string, text?: string }|null>)|null,
 *   removed?: (ctx: any, hostId: string) => void,
 *   say?: (ctx: any, part: { fill: number|null, text: string }) => void,
 *   sleep: (ms: number) => Promise<void>,
 *   now: () => number,
 *   pollMs?: number,
 *   limitMs?: number,
 * }} deps
 * @returns {Array<(ctx: any) => Promise<any>>}
 */
export function pveSteps({ open, coordinatorUrl, sealLine, holderPin = null, removed = () => {}, say = () => {}, sleep, now, pollMs = 5_000, limitMs = 45 * 60_000 }) {
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
      const options = ctx.rec?.options ?? null;
      // THE CLUSTER'S OWN MACHINE, when asked for: its pin, only when there
      // is none to keep, written where the script reads it.
      let holderJoin = false;
      if (options?.holder) {
        if (!holderPin) throw new Error('this machine cannot ask the fleet for the pin the cluster’s own machine joins with. Update it, or set the cluster up without one.');
        const found = await ctx.pool.remote(HOLDER_FIND, { timeoutMs: 60_000 });
        const there = found.code === 0 ? holdersIn(found.stdout) : [];
        if (!there.length || options.holderAgain) {
          const said = await ctx.pool.remote(ADDRESS_FIND, { timeoutMs: 30_000 });
          const address = said.code === 0 ? lineAddressOf(said.stdout) : null;
          if (!address) throw new Error('the node did not say its address, which its own machine is reserved for. Nothing was started.');
          const given = await holderPin(ctx, address);
          if (!given?.ok || typeof given.pin !== 'string' || typeof given.hostId !== 'string' || !HOLDER_ID_RE.test(given.hostId)) {
            throw new Error(`the fleet gave no pin for the cluster’s own machine: ${given?.text || 'it did not answer'}. Nothing was started.`);
          }
          const wrote = await ctx.pool.remote(holderJoinCommand({ hostId: given.hostId, pin: given.pin, address, secret: options.holderSecret ?? null, grants: options.grants ?? null }), { timeoutMs: 30_000 });
          if (wrote.code !== 0) throw new Error('the pin for the cluster’s own machine could not be written on the node. Nothing was started.');
          holderJoin = true;
        }
      }
      const started = await ctx.pool.remote(startCommand(coordinatorUrl, ctx.rec?.vmids ?? null, options, holderJoin), { timeoutMs: 60_000 });
      if (started.code !== 0) throw new Error(`the node would not start the setup: ${lastLine(started.stderr || started.stdout) || `systemd-run said ${started.code}`}.`);
      ctx.started = true;
      ctx.deadline = now() + limitMs;
    },
    ...SCRIPT_STEPS.filter((s) => s !== 'line').map((key) => async (/** @type {any} */ ctx) => until(ctx, key)),
    // line
    async (ctx) => {
      await until(ctx, 'line');
      // A MACHINE OF ITS OWN MADE AGAIN (the script's step `holder`, which
      // ends before this one): the one it replaced, told to the fleet by
      // name, which retires the host it was (core.js, #onHolderRemoved).
      if (ctx.rec?.options?.holderAgain) {
        const r = await ctx.pool.remote(removedCommand(ctx.since), { timeoutMs: 60_000 });
        for (const name of progressOf(r.stdout).removed) removed(ctx, name);
      }
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
