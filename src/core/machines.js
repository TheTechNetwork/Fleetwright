// Machines this box makes out of its own containers: the hub's half.
// docs/api-engines.md, "A machine on a box of your own".
//
// A MACHINE HERE IS A ROOTLESS PODMAN CONTAINER RUNNING THE FLEET'S OWN HOST
// (sandbox/machine/), started with a ticket, which enrols as a temporary
// machine like one from a hypervisor. The hub runs it because the hub is
// what owns this box's containers; the sidecar, which never touches Podman,
// asks over the hub's API (src/adapters/http.js, `/api/machines`), and its
// driver for this is src/fleet/host/own-pools.js.
//
// WHAT IS KEPT, AND WHERE. A container carries who it is for and when it was
// made as labels, which nobody can change afterwards. When it ends can
// change (more time is asked for), so that is in `machines.json` in the
// hub's state. Either alone is enough to end a machine on time: a container
// the file does not know ends when its labels say, and a name in the file
// with no container is dropped. A volume that is a machine's by its name
// and has no container is one a making left behind, and is removed.
//
// And why a machine ended, when nobody ended it: one whose container had
// stopped is removed with its volume, and its log would go with it, which is
// the one place it said why. So the end of that log is read first, with
// anything that looks like a credential taken out, written to this hub's own
// log, and its last line kept for an hour in `machines-ended.json` for its
// owner's list to say.
//
// THE TICKET NEVER TOUCHES A COMMAND LINE OR AN ENVIRONMENT. An argument is
// readable by every user of the box for as long as the process lives, and a
// container's environment is kept in Podman's own record of it and in its
// first process for as long as it runs. So the ticket is written into the
// machine's own volume first, as the join file a VM has, by a container that
// lives just long enough to read it from standard input; the machine then
// starts with that volume and finds the file. The same way a session's
// credential reaches its volume (podman.js).
//
// It was first handed to `podman run --env-file /dev/stdin`, which a real
// Podman refuses: the hub gives a child a socket for its standard input, and
// a socket cannot be opened by path. Found by CI's first real run
// (scripts/machine-smoke.mjs), which is what that run is for.
//
// NOTHING HERE HAS RUN ON A PERSON'S BOX. The tests drive it against a
// stand-in `podman` (test/machines.test.js), and CI builds the image and
// starts one with a real one (scripts/machine-smoke.mjs).

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import { podmanAsync, podmanAvailable } from './podman.js';
import { usernsArgs } from './sandbox-userns.js';

const TICKET_RE = /^fwt_([0-9a-f]{12})_[0-9a-f]{48}$/;
const NAME_RE = /^vm-[0-9a-f]{12}$/;
/** A machine's volume, by the name `machineNames` gives one. */
const VOLUME_RE = /^fwm-(vm-[0-9a-f]{12})-state$/;
/** The fewest and the most minutes a machine is made or extended for, as on a hypervisor. */
export const MACHINE_MIN_MINUTES = 5;
export const MACHINE_MAX_MINUTES = 350;
const DEFAULT_MINUTES = 60;
const BUILD_TIMEOUT_MS = 20 * 60_000;
/** How long the reason a machine ended by itself is kept for its owner's list: as long as a machine lives unless said. */
const ENDED_KEPT_MS = 60 * 60_000;
/** How many such reasons are kept at once, the oldest dropped first. */
const ENDED_KEPT = 20;
/** How much of a stopped machine's log is read, and how much of one line of it goes to this hub's log. */
const LOG_LINES = 20;
const LOG_LINE_CHARS = 240;
/** How much of its last line reaches a screen. The whole sentence has 200 characters there (own-pools.js, and the coordinator after it). */
const LAST_LINE_CHARS = 95;
/** What the entrypoint says as it ends (sandbox/machine/entrypoint), which is true of every machine that stopped and so is no reason. */
const ENTRYPOINT_ENDING = /^fleetwright-machine: the sidecar ended with status \d+, so this machine is ending$/;
/** What marks a container as a machine of this fleet's, and whose. */
export const MACHINE_LABEL = 'fleetwright.machine';
/** What marks an image as one this builds, so an old one can be found and removed. */
const IMAGE_LABEL = 'fleetwright.machine-image';
/** What the image's one image is called on a screen. */
export const MACHINE_IMAGE_NAME = 'Linux, with the fleet';

/**
 * Why a box behind an egress allowlist makes no machines, said wherever one
 * is asked after: the refusal, and the image's own state, so the image is
 * neither built nor offered on a box where every request for one would be
 * refused. It was built and offered there, and then refused, which is a
 * button for something that does not exist.
 */
const BEHIND_ALLOWLIST = 'This machine keeps its sessions behind an egress allowlist, and a machine made on it would not be behind one. So none is made here.';
/** What of a release a host runs from. Whichever of these a box has is copied in. */
const RELEASE_PARTS = Object.freeze(['package.json', 'openapi.json', 'bin', 'lib', 'src', 'node_modules']);

/** The container and the volume a machine is. @param {string} name */
export function machineNames(name) {
  return { container: `fwm-${name}`, volume: `fwm-${name}-state` };
}

/**
 * What a container is doing, from the word Podman lists it with. Read by
 * how it begins, because Podman has printed this column both as a state
 * (`running`, `exited`) and as a sentence (`Up 2 minutes`, `Exited (0) 3
 * seconds ago`), and a machine must be ended on time under either.
 *
 * @param {unknown} said
 * @returns {'running'|'paused'|'over'|'starting'}
 */
function stateOf(said) {
  const s = String(said || '').trim().toLowerCase();
  if (s.startsWith('running') || s.startsWith('up')) return s.includes('paused') ? 'paused' : 'running';
  if (s.startsWith('paused')) return 'paused';
  if (s.startsWith('exited') || s.startsWith('stopped') || s.startsWith('dead') || s.startsWith('removing')) return 'over';
  return 'starting';
}

/** One printable line, bounded: Podman's own words reach a screen. */
function line(/** @type {unknown} */ v) {
  return String(v ?? '').trim().split('\n').pop()?.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 200) ?? '';
}

/**
 * A machine's own words with anything that looks like a credential taken
 * out, before they are kept, logged or shown. Its log is its hub's and its
 * sidecar's, and neither prints one on purpose, but a log is whatever a
 * program said on its way down. A ticket and the fleet's other tokens by
 * their shape, and any long unbroken run of a token's alphabet, as a VM's
 * report of its own boot withholds them (pve-pools.js). A long path or host
 * name goes the same way, which is the price of not listing shapes.
 *
 * @param {string} text
 */
function withheld(text) {
  return text
    .replace(/\bfwt_[A-Za-z0-9_-]+/g, '[ticket]')
    .replace(/\b(?:fw[a-z]_|sk-ant-)[A-Za-z0-9._~+/=-]+/g, '[removed]')
    .replace(/[A-Za-z0-9_+/=.~-]{32,}/g, '[removed]');
}

/**
 * What its owner's list says of a machine that ended by itself, as one
 * sentence that fits whole where a place's problem is drawn. Only what this
 * box knows: it found the container stopped and removed it, and how its log
 * ended. Why it stopped is in that line or it is not known.
 *
 * @param {{ name: string, at: number, said: string|null }} e  `said` is null when the log could not be read, and empty when it was empty
 * @param {number} now
 */
function endedText(e, now) {
  const minutes = Math.max(0, Math.round((now - e.at) / 60_000));
  const found = `This machine found ${e.name} stopped ${minutes < 1 ? 'just now' : minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`} and removed it with its disk.`;
  if (e.said === null) return `${found} Podman could not read its log.`;
  return e.said ? `${found} Its log ends: ${e.said}` : `${found} Its log was empty.`;
}

/**
 * How new a file may be and still have its tag kept. A file's times are
 * written on the kernel's coarse clock, so one changed twice inside a tick
 * shows the same times for both; a tag is kept only once every file is older
 * than this, when a later change cannot hide in the same tick.
 */
const SETTLED_MS = 2000;
/** The tag last worked out for a release, and what its files looked like then. @type {Map<string, { seen: string, tag: string }>} */
const tags = new Map();

/**
 * What identifies the release this box runs, as a short tag: THE BYTES of
 * every file a host runs from, by its path. A checkout that pulled and a
 * release that was replaced both change it, and the image is built again.
 *
 * IT WAS EACH FILE'S PATH, SIZE AND TIME, and a release has no times: the
 * packager stamps every file 2020 so that two builds of one commit are the
 * same bytes (tools/build-host-package.mjs). So a fix that kept a file's
 * length kept the tag, and machines went on being made from the image with
 * the old host in it. The same bytes are now the same image whenever they
 * were unpacked, and different bytes never are.
 *
 * WORKED OUT ONCE AND KEPT, because this is asked at every look at the
 * machines and a checkout's `src/` is megabytes. What says a kept tag is
 * stale is each file's size, both its times and its inode: the time a file
 * was last changed in any way is the kernel's own and nothing unpacking a
 * release can set, so a file rewritten at the same length with its old time
 * put back still shows.
 *
 * `node_modules` is not walked. What npm installed there is listed in its
 * own `.package-lock.json`, and that file's bytes stand for the directory; a
 * release has no `node_modules`, since everything is in its bundle.
 *
 * @param {string} installDir
 */
export function releaseTag(installDir) {
  /** @type {Array<{ rel: string, at: string, st: import('node:fs').Stats }>} */
  const files = [];
  /** @param {string} rel */
  const walk = (rel) => {
    const at = path.join(installDir, rel);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return;
    }
    if (rel === 'node_modules') {
      const lock = path.join(at, '.package-lock.json');
      try {
        files.push({ rel: path.join(rel, '.package-lock.json'), at: lock, st: statSync(lock) });
      } catch {
        files.push({ rel, at: '', st });
      }
      return;
    }
    if (st.isDirectory()) {
      for (const n of readdirSync(at).sort()) walk(path.join(rel, n));
      return;
    }
    files.push({ rel, at, st });
  };
  for (const part of RELEASE_PARTS) walk(part);
  walk(path.join('sandbox', 'machine'));
  const seen = files.map((f) => `${f.rel}\0${f.st.size}\0${f.st.mtimeMs}\0${f.st.ctimeMs}\0${f.st.ino}`).join('\n');
  const kept = tags.get(installDir);
  if (kept?.seen === seen) return kept.tag;
  const h = createHash('sha256');
  for (const f of files) {
    // A link is where it points, and anything else that is not a file is
    // only its name: neither is read through.
    const bytes = f.st.isSymbolicLink() ? Buffer.from(readlinkSync(f.at)) : f.st.isFile() ? readFileSync(f.at) : Buffer.alloc(0);
    h.update(`${f.rel}\0${bytes.length}\0`);
    h.update(bytes);
  }
  const tag = h.digest('hex').slice(0, 12);
  const newest = Math.max(0, ...files.map((f) => Math.max(f.st.mtimeMs, f.st.ctimeMs)));
  if (Date.now() - newest > SETTLED_MS) tags.set(installDir, { seen, tag });
  else tags.delete(installDir);
  return tag;
}

/**
 * The image a machine is made from: the operator's own if they named one
 * (`FLEETWRIGHT_MACHINE_IMAGE`), or the one this builds from the release.
 *
 * @param {{ machineImage?: string, installDir: string }} cfg
 */
export function machineImage(cfg) {
  return cfg.machineImage ? cfg.machineImage : `localhost/fleetwright-machine:${releaseTag(cfg.installDir)}`;
}

/**
 * Lay out what the image is built from, in a directory of the hub's own:
 * the release's parts under `release/`, and the entrypoint beside them.
 *
 * WHY A COPY, AND NOT THE RELEASE AS THE BUILD'S CONTEXT. A release is not
 * one shape: a packaged box has `lib/` with everything bundled and no
 * `src/` but the web pages, and a checkout has `src/` and `node_modules`.
 * A Containerfile cannot copy "whichever is there", and a checkout as a
 * context would send its `.git` and its apps to the build. So the parts
 * that exist are copied here, and the Containerfile copies one directory.
 *
 * @param {{ installDir: string }} cfg @param {string} dir  emptied first
 * @returns {{ ok: boolean, text?: string }}
 */
export function stageMachineContext(cfg, dir) {
  const entry = path.join(cfg.installDir, 'sandbox', 'machine', 'entrypoint');
  if (!existsSync(entry) || !existsSync(path.join(cfg.installDir, 'bin', 'fleetwright-sidecar'))) {
    return { ok: false, text: `The release at ${cfg.installDir} has no machine image to build (sandbox/machine and bin/), so this machine cannot make one. Update fleetwright here.` };
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'release'), { recursive: true, mode: 0o700 });
  for (const part of RELEASE_PARTS) {
    const from = path.join(cfg.installDir, part);
    if (!existsSync(from)) continue;
    // Through a link at the top (a checkout's node_modules can be one), and
    // links below it kept as links: node_modules/.bin is made of them.
    cpSync(realpathSync(from), path.join(dir, 'release', part), { recursive: true, verbatimSymlinks: true });
  }
  cpSync(entry, path.join(dir, 'entrypoint'));
  return { ok: true };
}

export class Machines {
  /**
   * @param {any} cfg  the hub's config
   * @param {{ now?: () => number }} [opts]
   */
  constructor(cfg, { now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.now = now;
    /** The build in flight, so two asks build once. @type {Promise<{ ok: boolean, text?: string, built?: boolean }>|null} */
    this.building = null;
    /** The image last seen to be there, so a look does not ask Podman each time. @type {string|null} */
    this.ready = null;
    /** The last build that failed: of which image, why, and when. @type {{ image: string, text: string, at: number }|null} */
    this.failed = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.timer = null;
    /** What is being made or changed, one at a time. @type {Promise<unknown>} */
    this.turn = Promise.resolve();
    /** The machines being made this moment, whose volume has no container yet. @type {Set<string>} */
    this.making = new Set();
  }

  /**
   * One making or changing at a time. Two people asking at once would each
   * count the machines before the other's was started and both be let past
   * the cap, and each would write the file of ends over the other's.
   *
   * @template T @param {() => Promise<T>} work @returns {Promise<T>}
   */
  #inTurn(work) {
    const next = this.turn.then(work, work);
    this.turn = next.catch(() => {});
    return next;
  }

  /**
   * Where the ends are kept. Read when it is needed and not when the hub
   * starts: nothing here touches the box's state until a machine is asked
   * for, and a hub whose state cannot be read must still come up.
   */
  get file() {
    return path.join(this.cfg.stateDir, 'machines.json');
  }

  /** Where the reasons machines ended by themselves are kept, for a while. */
  get endedFile() {
    return path.join(this.cfg.stateDir, 'machines-ended.json');
  }

  /**
   * The machines that ended by themselves within the last hour, oldest first.
   *
   * @returns {Array<{ name: string, owner: string, at: number, said: string|null }>}
   */
  #ended() {
    try {
      const read = JSON.parse(readFileSync(this.endedFile, 'utf8'));
      const now = this.now();
      return (Array.isArray(read) ? read : [])
        .filter((e) => NAME_RE.test(e?.name) && typeof e.owner === 'string' && Number.isFinite(e.at) && now - e.at < ENDED_KEPT_MS && (e.said === null || typeof e.said === 'string'))
        .map((e) => ({ name: e.name, owner: e.owner, at: e.at, said: e.said }));
    } catch {
      return [];
    }
  }

  /** @param {Array<{ name: string, owner: string, at: number, said: string|null }>} ended */
  #keepEnded(ended) {
    mkdirSync(path.dirname(this.endedFile), { recursive: true });
    writeFileSync(`${this.endedFile}.new`, `${JSON.stringify(ended.slice(-ENDED_KEPT))}\n`, { mode: 0o600 });
    renameSync(`${this.endedFile}.new`, this.endedFile);
  }

  /**
   * The end of a stopped machine's log, oldest line first, with anything
   * that looks like a credential taken out. Null when Podman could not read it.
   *
   * WITH PODMAN'S OWN TIME ON EACH LINE, and put back in order by it. Podman
   * hands back what a container printed and what it printed as errors
   * apart, and the fleet's host prints its warnings as errors: read one after
   * the other, the last line would be the last warning, however long before
   * the end that was. The time is taken off again. A Podman that prints no
   * time gives the lines as it gave them.
   *
   * @param {string} name
   * @returns {Promise<string[]|null>}
   */
  async #lastWords(name) {
    const r = await podmanAsync(this.cfg, ['logs', '--timestamps', '--tail', String(LOG_LINES), machineNames(name).container], { timeout: 30_000 });
    if (r.status !== 0) return null;
    /** @type {Array<{ at: string, text: string }>} */
    const lines = [];
    for (const stream of [r.stdout, r.stderr]) {
      for (const l of String(stream || '').split('\n')) {
        const m = /^(\d{4}-\d\d-\d\dT[\d:.,]+(?:Z|[+-]\d\d:?\d\d))\s(.*)$/.exec(l);
        lines.push({ at: m ? m[1] : '', text: m ? m[2] : l });
      }
    }
    return lines
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .map((l) => withheld(l.text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[^\x20-\x7e’]/g, '')).trim().slice(0, LOG_LINE_CHARS))
      .filter(Boolean)
      .slice(-LOG_LINES);
  }

  /**
   * Read how a stopped machine's log ended, before it is removed with it:
   * into this hub's own log, and its last line kept for its owner's list.
   *
   * THE LAST LINE THAT SAYS SOMETHING. The entrypoint's own last line is
   * that the sidecar ended, which is true of every machine that stopped; the
   * line before it is the sidecar's, and is the reason where there is one.
   * This hub's own time and level are taken off the front of a line, since a
   * screen has 200 characters for the whole sentence.
   *
   * @param {{ name: string, owner: string }} c
   */
  async #noteEnded(c) {
    const words = await this.#lastWords(c.name);
    // TWO LOOKS CAN MEET THE SAME STOPPED CONTAINER (the minute's, and
    // somebody asking). The first to read its log keeps what it read; the
    // second may find the container already gone, and "could not read" must
    // not be written over what was read.
    const ended = this.#ended();
    if (ended.some((e) => e.name === c.name)) return;
    if (words === null) log.warn(`machines: ${c.name} had stopped, and Podman could not read its log before it was removed`);
    else if (!words.length) log.warn(`machines: ${c.name} had stopped, with nothing in its log`);
    else {
      log.warn(`machines: ${c.name} had stopped. Its log ended:`);
      for (const l of words) log.warn(`machines: ${c.name} | ${l}`);
    }
    const last = words === null ? null : ([...words].reverse().find((l) => !ENTRYPOINT_ENDING.test(l)) ?? words.at(-1) ?? '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+(?:DEBUG|INFO|WARN|ERROR)\s+/, '');
    const said = last !== null && last.length > LAST_LINE_CHARS ? `${last.slice(0, LAST_LINE_CHARS - 3)}...` : last;
    this.#keepEnded([...ended, { name: c.name, owner: c.owner, at: this.now(), said }]);
  }

  /** How many may run at once: `FLEETWRIGHT_MACHINE_MAX`, two unless set. */
  get max() {
    return Number.isInteger(this.cfg.machineMax) && this.cfg.machineMax >= 0 ? this.cfg.machineMax : 2;
  }

  /** When each machine ends, as this box last wrote it. @returns {Record<string, { until: number }>} */
  #ends() {
    try {
      const read = JSON.parse(readFileSync(this.file, 'utf8'));
      /** @type {Record<string, { until: number }>} */
      const out = {};
      for (const [k, v] of Object.entries(read && typeof read === 'object' ? read : {})) {
        if (NAME_RE.test(k) && Number.isFinite(/** @type {any} */ (v)?.until)) out[k] = { until: /** @type {any} */ (v).until };
      }
      return out;
    } catch {
      return {};
    }
  }

  /** @param {Record<string, { until: number }>} ends */
  #keep(ends) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.new`, `${JSON.stringify(ends)}\n`, { mode: 0o600 });
    renameSync(`${this.file}.new`, this.file);
  }

  /**
   * The image, built if it is not there. One build at a time: a second ask
   * waits for the first.
   *
   * @returns {Promise<{ ok: boolean, text?: string, built?: boolean }>}
   */
  ensureImage() {
    const image = machineImage(this.cfg);
    this.building ??= this.#ensureImage(image)
      .then((r) => {
        this.ready = r.ok ? image : null;
        this.failed = r.ok ? null : { image, text: r.text ?? 'The machine image could not be built.', at: this.now() };
        if (!r.ok) log.warn(`machines: ${this.failed?.text}`);
        return r;
      })
      .finally(() => {
        this.building = null;
      });
    return this.building;
  }

  /**
   * Whether there is an image to make a machine from, without building one.
   * `problem` is why not, in a sentence for a screen: it is being built, or
   * the build failed and what Podman said.
   *
   * @returns {Promise<{ ready: boolean, building: boolean, problem: string|null }>}
   */
  async imageState() {
    if (this.cfg.sandboxEgress === 'allowlist') return { ready: false, building: false, problem: BEHIND_ALLOWLIST };
    const image = machineImage(this.cfg);
    if (this.ready !== image) this.ready = (await podmanAsync(this.cfg, ['image', 'inspect', image], { timeout: 30_000 })).status === 0 ? image : null;
    if (this.ready === image) return { ready: true, building: false, problem: null };
    if (this.building) return { ready: false, building: true, problem: 'This machine is building its machine image, which takes a few minutes the first time and after an update.' };
    return { ready: false, building: false, problem: this.failed?.image === image ? this.failed.text : null };
  }

  /**
   * Start building the image if there is none, and do not wait for it. What
   * the sidecar asks when its operator turned machines on, so the first
   * machine a person asks for does not wait out a build. A build that failed
   * is not tried again for half an hour: it fetches Debian's and Node's
   * packages, and a box that cannot reach them would otherwise try every
   * minute.
   */
  async prepare() {
    const state = await this.imageState();
    if (state.ready || state.building || this.cfg.sandboxEgress === 'allowlist') return state;
    const image = machineImage(this.cfg);
    if (this.failed?.image === image && this.now() - this.failed.at < 30 * 60_000) return state;
    void this.ensureImage().catch(() => {});
    return this.imageState();
  }

  /** @param {string} image @returns {Promise<{ ok: boolean, text?: string, built?: boolean }>} */
  async #ensureImage(image) {
    const cfg = this.cfg;
    if ((await podmanAsync(cfg, ['image', 'inspect', image], { timeout: 30_000 })).status === 0) return { ok: true, built: false };
    // THE OPERATOR'S OWN IMAGE IS THEIRS TO PROVIDE. It is pulled if it has
    // somewhere to be pulled from, and never built over.
    if (cfg.machineImage) {
      if (image.startsWith('localhost/')) return { ok: false, text: `FLEETWRIGHT_MACHINE_IMAGE names ${image}, and this machine has no such image. Build it here, or unset it to have the fleet build its own.` };
      const pulled = await podmanAsync(cfg, ['pull', image], { timeout: BUILD_TIMEOUT_MS });
      return pulled.status === 0 ? { ok: true, built: true } : { ok: false, text: `FLEETWRIGHT_MACHINE_IMAGE names ${image}, and it could not be pulled: ${line(pulled.stderr || pulled.stdout) || 'podman said nothing'}` };
    }
    const stage = path.join(cfg.stateDir, 'machine-build');
    const staged = stageMachineContext(cfg, stage);
    if (!staged.ok) return staged;
    log.warn(`machines: ${image} is not built — building it from this release now, which takes a few minutes`);
    const built = await podmanAsync(
      cfg,
      [
        'build', '-t', image,
        '--label', `${IMAGE_LABEL}=1`,
        // THE NODE THIS HUB RUNS ON, so the host inside runs on what the host
        // outside does (sandbox/machine/Containerfile).
        '--build-arg', `NODE_MAJOR=${process.versions.node.split('.')[0]}`,
        '-f', path.join(cfg.installDir, 'sandbox', 'machine', 'Containerfile'),
        stage,
      ],
      { timeout: BUILD_TIMEOUT_MS },
    );
    rmSync(stage, { recursive: true, force: true });
    if (built.status !== 0) {
      const tail = String(built.stderr || built.stdout || '').trim().split('\n').slice(-4).map((l) => l.replace(/[^\x20-\x7e]/g, '').slice(0, 200)).join(' / ');
      return { ok: false, text: `The machine image could not be built on this machine: ${tail || 'podman said nothing'}` };
    }
    log.info(`machines: built ${image}`);
    // THE ONES BEFORE IT, which a release that changed left behind. One a
    // running machine still uses is refused by Podman and stays until it ends.
    const old = await podmanAsync(cfg, ['images', '--filter', `label=${IMAGE_LABEL}=1`, '--format', '{{.Repository}}:{{.Tag}}'], { timeout: 30_000 });
    for (const ref of String(old.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('localhost/fleetwright-machine:') && l !== image)) {
      await podmanAsync(cfg, ['rmi', ref], { timeout: 60_000 });
    }
    return { ok: true, built: true };
  }

  /**
   * The containers that are machines, as Podman lists them, each with what
   * its labels say. Throws when Podman cannot be asked: "none" and "could
   * not look" are different answers, and only one of them may end a machine
   * on the coordinator's side.
   *
   * @returns {Promise<Array<{ name: string, owner: string, state: string, madeAt: number|null, labelled: number|null }>>}
   */
  async #containers() {
    const r = await podmanAsync(this.cfg, ['ps', '-a', '--filter', `label=${MACHINE_LABEL}`, '--format', '{{.Names}}\t{{.State}}\t{{.Label "fleetwright.machine"}}\t{{.Label "fleetwright.owner"}}\t{{.Label "fleetwright.made"}}\t{{.Label "fleetwright.until"}}'], { timeout: 30_000 });
    if (r.status !== 0) throw new Error(line(r.stderr || r.stdout) || 'podman did not answer');
    return String(r.stdout || '')
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((f) => f.length >= 6 && NAME_RE.test(f[2]) && f[0] === machineNames(f[2]).container)
      .map((f) => ({
        name: f[2],
        owner: String(f[3] || '').toLowerCase(),
        state: stateOf(f[1]),
        madeAt: Number.isFinite(Number(f[4])) && Number(f[4]) > 0 ? Number(f[4]) : null,
        labelled: Number.isFinite(Number(f[5])) && Number(f[5]) > 0 ? Number(f[5]) : null,
      }));
  }

  /** Remove a machine's container and its volume. @param {string} name */
  async #remove(name) {
    const { container, volume } = machineNames(name);
    const gone = await podmanAsync(this.cfg, ['rm', '-f', container], { timeout: 60_000 });
    await podmanAsync(this.cfg, ['volume', 'rm', '-f', volume], { timeout: 60_000 });
    return gone;
  }

  /**
   * Remove the volumes that are a machine's by their name and that no
   * container has.
   *
   * A MACHINE'S VOLUME IS MADE BEFORE ITS CONTAINER, with the ticket in it
   * (`#make`). A hub that stopped between the two left a volume holding an
   * unspent ticket, and nothing ever looked for one: every removal here
   * starts from a container. So each look at the machines also lists the
   * volumes.
   *
   * NOT FORCED, AND NOT ONE BEING MADE. Podman refuses to remove a volume a
   * container has, which is the check that matters and is Podman's own: a
   * machine started since the containers were listed keeps its volume. The
   * moment between the two steps of a making is the one where a volume is
   * rightly alone, and that making says so in `making`. A Podman that
   * cannot list them is left for the next look.
   *
   * @param {Array<{ name: string }>} containers  every machine's container, in any state
   */
  async #clearStrays(containers) {
    const listed = await podmanAsync(this.cfg, ['volume', 'ls', '--format', '{{.Name}}'], { timeout: 30_000 });
    if (listed.status !== 0) return;
    const has = new Set(containers.map((c) => c.name));
    for (const volume of String(listed.stdout || '').split('\n').map((l) => l.trim())) {
      const name = VOLUME_RE.exec(volume)?.[1];
      if (!name || has.has(name) || this.making.has(name)) continue;
      const gone = await podmanAsync(this.cfg, ['volume', 'rm', volume], { timeout: 60_000 });
      if (gone.status === 0) log.warn(`machines: removed ${volume}, the volume of a machine that was never started`);
    }
  }

  /**
   * What machines this box has, after ending any whose time is up. The
   * whole answer the sidecar reports from.
   *
   * @param {{ prepare?: boolean }} [opts]  also start building the image if there is none
   * `ended` is the machines that stopped by themselves in the last hour and
   * were removed, each with a sentence for its owner on how its log ended.
   * One this box ended, on its owner's word or when its time was up, is not
   * among them: its owner knows why.
   *
   * @returns {Promise<{ ok: true, max: number, image: { name: string, ready: boolean, building: boolean, problem: string|null }, machines: Array<{ name: string, owner: string, state: string, until: number|null, madeAt: number|null }>, ended: Array<{ name: string, owner: string, at: number, text: string }> } | { ok: false, text: string }>}
   */
  async list({ prepare = false } = {}) {
    if (!podmanAvailable(this.cfg)) return { ok: false, text: 'Podman is not installed on this machine, and a machine here is a Podman container.' };
    let all;
    try {
      all = await this.#containers();
    } catch (e) {
      return { ok: false, text: `Podman could not list this machine’s containers: ${/** @type {Error} */ (e).message}` };
    }
    const ends = this.#ends();
    const now = this.now();
    const machines = [];
    /** The machines this look removed. @type {Set<string>} */
    const removed = new Set();
    for (const c of all) {
      // WHEN IT ENDS: what this box last wrote, or what it was made with.
      const until = ends[c.name]?.until ?? c.labelled;
      // ITS TIME IS UP, or it stopped by itself (its sidecar ended, or the
      // box restarted): either way it is over, and it goes with its volume.
      const over = (until !== null && until <= now) || c.state === 'over';
      if (over) {
        // ITS LOG GOES WITH ITS CONTAINER, and is the one place it said why
        // it stopped. Read first, for a machine nobody ended.
        if (c.state === 'over') await this.#noteEnded(c);
        await this.#remove(c.name);
        removed.add(c.name);
        log.info(`machines: ended ${c.name} (${until !== null && until <= now ? 'its time was up' : 'its container had stopped'})`);
        continue;
      }
      machines.push({ name: c.name, owner: c.owner, state: c.state === 'running' ? 'Running' : c.state === 'paused' ? 'Paused' : 'Starting', until, madeAt: c.madeAt });
    }
    // WHAT IS WRITTEN BACK IS ONLY WHAT IS GONE, read again now. A removal
    // above is awaited, and this runs beside the one-at-a-time turn (the
    // minute's timer, and anybody asking for the list), so writing the end
    // times as they were read at the top put back an end somebody had just
    // extended: they were told two more hours, and the machine went in ten
    // minutes with its disk.
    //
    // AND GONE IS WHAT THIS LOOK SAW GO, never "not among the containers it
    // listed". That list is from before the removals too, so a machine made
    // while one was being cleared away was not on it, and its end was taken
    // out of the file as one that had gone: made for ten minutes and given
    // two hours in the same breath, its owner was told two hours and it went
    // at the ten its label said. So an end is dropped only when it was in
    // the file as this look began and is the same now, and its machine was
    // removed here or had no container then. An end written since is
    // somebody's newer word and stays for the next look to judge.
    await this.#clearStrays(all);
    const listed = new Set(all.map((c) => c.name));
    const fresh = this.#ends();
    const still = Object.fromEntries(Object.entries(fresh).filter(([n, e]) => !(ends[n]?.until === e.until && (removed.has(n) || !listed.has(n)))));
    if (Object.keys(still).length !== Object.keys(fresh).length) this.#keep(still);
    const image = await (prepare ? this.prepare() : this.imageState());
    const ended = this.#ended().map((e) => ({ name: e.name, owner: e.owner, at: e.at, text: endedText(e, now) }));
    return { ok: true, max: this.max, image: { name: MACHINE_IMAGE_NAME, ...image }, machines, ended };
  }

  /**
   * Start a machine for a person, with the ticket it enrols with.
   *
   * @param {{ owner: string, ticket: string, coordinator: string, minutes?: number|null }} ask
   * @returns {Promise<{ ok: boolean, text: string, name?: string, minutes?: number, until?: number }>}
   */
  make(ask) {
    return this.#inTurn(() => this.#make(ask));
  }

  /** @param {{ owner: string, ticket: string, coordinator: string, minutes?: number|null }} ask @returns {Promise<{ ok: boolean, text: string, name?: string, minutes?: number, until?: number }>} */
  async #make({ owner, ticket, coordinator, minutes = null }) {
    const cfg = this.cfg;
    const who = String(owner || '').toLowerCase();
    const m = TICKET_RE.exec(String(ticket || ''));
    if (!m) return { ok: false, text: 'That machine came without the ticket it enrols with, so it was not made.' };
    // An address is a label on the container and one word of one line: one
    // with a space or a line in it is not an address.
    if (!who || /[\s=]/.test(who) || who.length > 254) return { ok: false, text: 'A machine is made for a signed-in person.' };
    if (!/^https:\/\/[^\s]+$/.test(String(coordinator || ''))) return { ok: false, text: 'This machine was not told the fleet’s address to give the new one, so it was not made.' };
    if (!podmanAvailable(cfg)) return { ok: false, text: 'Podman is not installed on this machine, and a machine here is a Podman container.' };
    // A BOX THAT KEEPS ITS SESSIONS BEHIND AN ALLOWLIST would be making a
    // container that is not behind it: a machine dials the fleet itself, and
    // its sessions reach what it reaches. Refused, not quietly let out.
    if (cfg.sandboxEgress === 'allowlist') return { ok: false, text: BEHIND_ALLOWLIST };
    const name = `vm-${m[1]}`;
    const life = Math.max(MACHINE_MIN_MINUTES, Math.min(MACHINE_MAX_MINUTES, Number(minutes) || DEFAULT_MINUTES));
    const listed = await this.list();
    if (!listed.ok) return { ok: false, text: listed.text };
    // THE SAME TICKET IS THE SAME MACHINE: asked twice, made once.
    const there = listed.machines.find((x) => x.name === name);
    if (there) return { ok: true, name, minutes: life, until: there.until ?? undefined, text: `${name} is already running here.` };
    if (listed.machines.length >= this.max) {
      return { ok: false, text: `This machine already runs ${listed.machines.length} of the ${this.max} machines it may (FLEETWRIGHT_MACHINE_MAX). End one, or wait for one to end.` };
    }
    // NEVER WAITED FOR HERE: a build is minutes, and whoever asked is
    // holding a request open. It is started, and they are told.
    const image = await this.prepare();
    if (!image.ready) return { ok: false, text: image.problem ?? 'This machine has no machine image yet. Ask again in a few minutes.' };
    // FROM HERE ITS VOLUME EXISTS BEFORE ITS CONTAINER DOES, and a look at
    // the machines must not take it for one left behind (`#clearStrays`).
    this.making.add(name);
    try {
      return await this.#start({ name, who, ticket, coordinator, life });
    } finally {
      this.making.delete(name);
    }
  }

  /**
   * The two steps of a making: the ticket into the machine's volume, then
   * the machine.
   *
   * @param {{ name: string, who: string, ticket: string, coordinator: string, life: number }} m
   * @returns {Promise<{ ok: boolean, text: string, name?: string, minutes?: number, until?: number }>}
   */
  async #start({ name, who, ticket, coordinator, life }) {
    const cfg = this.cfg;
    const now = this.now();
    const until = now + life * 60_000;
    const { container, volume } = machineNames(name);
    // THE JOIN FILE, INTO THE MACHINE'S VOLUME, from standard input: what
    // install/fleetwright-vm-join leaves on a VM, which the sidecar enrols
    // from and blanks. JSON, so an address is only ever text.
    const seeded = await podmanAsync(
      cfg,
      ['run', '--rm', '-i', ...usernsArgs(cfg), '--entrypoint', 'sh', '-v', `${volume}:/var/lib/fleetwright-sidecar`, machineImage(cfg), '-c', 'umask 077 && cat > /var/lib/fleetwright-sidecar/vm-join.json'],
      { timeout: 120_000, input: `${JSON.stringify({ v: 1, coordinator, ticket, owner: who, minutes: life })}\n` },
    );
    if (seeded.status !== 0) {
      await this.#remove(name);
      this.ready = null;
      return { ok: false, text: `Podman did not prepare ${name}: ${line(seeded.stderr || seeded.stdout) || 'it said nothing'}` };
    }
    const run = await podmanAsync(
      cfg,
      [
        'run', '-d',
        '--name', container,
        '--hostname', name,
        ...usernsArgs(cfg),
        '--label', `${MACHINE_LABEL}=${name}`,
        '--label', `fleetwright.owner=${who}`,
        '--label', `fleetwright.made=${now}`,
        '--label', `fleetwright.until=${until}`,
        // The fleet it joins, which is no secret. The ticket is in the
        // volume below and nowhere here.
        '-e', `FLEETWRIGHT_COORDINATOR=${coordinator}`,
        // Its key and its join file, so a restart of the container is the
        // same machine. Gone when the machine ends.
        '-v', `${volume}:/var/lib/fleetwright-sidecar`,
        // What this box gives a session, since they share its memory.
        ...(cfg.sandboxMemory ? [`--memory=${cfg.sandboxMemory}`] : []),
        ...(cfg.sandboxCpus ? [`--cpus=${cfg.sandboxCpus}`] : []),
        ...(cfg.sandboxPidsLimit ? [`--pids-limit=${cfg.sandboxPidsLimit}`] : []),
        machineImage(cfg),
      ],
      { timeout: 120_000 },
    );
    if (run.status !== 0) {
      // What a failed start can leave: a created container and its volume.
      await this.#remove(name);
      // An image somebody removed is found gone at the next look.
      this.ready = null;
      return { ok: false, text: `Podman did not start ${name}: ${line(run.stderr || run.stdout) || 'it said nothing'}` };
    }
    this.#keep({ ...this.#ends(), [name]: { until } });
    log.info(`machines: started ${name} for ${who}, for ${life} minutes`);
    this.watch();
    return { ok: true, name, minutes: life, until, text: `Made ${name} on this machine, for ${life} minutes.` };
  }

  /**
   * End one of a person's machines, or give it more time.
   *
   * @param {{ owner: string, name: string, action: string, minutes?: number|null }} ask
   * @returns {Promise<{ ok: boolean, text: string, notHere?: boolean, minutes?: number, until?: number }>}
   */
  control(ask) {
    return this.#inTurn(() => this.#control(ask));
  }

  /** @param {{ owner: string, name: string, action: string, minutes?: number|null }} ask @returns {Promise<{ ok: boolean, text: string, notHere?: boolean, minutes?: number, until?: number }>} */
  async #control({ owner, name, action, minutes = null }) {
    const who = String(owner || '').toLowerCase();
    if (!NAME_RE.test(String(name))) return { ok: false, text: 'That is not the name of a machine this fleet made.' };
    const listed = await this.list();
    if (!listed.ok) return { ok: false, text: listed.text };
    // ITS OWNER'S, AND NOBODY ELSE'S: somebody else's machine is "not here"
    // to this person, the answer a name nobody has gets.
    const found = listed.machines.find((x) => x.name === name && x.owner === who);
    if (!found) return { ok: false, notHere: true, text: `${name} is not a machine of yours on this machine.` };
    if (action === 'stop') {
      const gone = await this.#remove(found.name);
      if (gone.status !== 0) return { ok: false, text: `Podman did not end ${name}: ${line(gone.stderr || gone.stdout) || 'it said nothing'}` };
      const ends = this.#ends();
      delete ends[found.name];
      this.#keep(ends);
      log.info(`machines: ended ${name} for ${who}`);
      return { ok: true, text: `Ended ${name}. Its container and its disk are removed.` };
    }
    if (action === 'extend') {
      const more = Math.max(MACHINE_MIN_MINUTES, Math.min(MACHINE_MAX_MINUTES, Number(minutes) || DEFAULT_MINUTES));
      // From when it would have ended, as on a hypervisor, and NEVER PAST
      // THE LONGEST A MACHINE LIVES, COUNTED FROM WHEN IT WAS MADE. It was
      // counted from now, so asking again every few hours kept a machine for
      // ever, and with a box's few places taken that way the next person was
      // refused one. The hypervisor's driver has always counted from the
      // making (xo-pools.js), and this said "as on a hypervisor".
      if (!found.madeAt) return { ok: false, text: `${name} does not say when it was made, so it cannot be given longer.` };
      const was = found.until ?? 0;
      const until = Math.min(found.madeAt + MACHINE_MAX_MINUTES * 60_000, Math.max(was, this.now()) + more * 60_000);
      if (until <= was) return { ok: false, text: `${name} already runs to the longest a machine can, ${MACHINE_MAX_MINUTES} minutes from when it was made.` };
      this.#keep({ ...this.#ends(), [found.name]: { until } });
      return { ok: true, minutes: more, until, text: `${name} now ends ${Math.max(1, Math.round((until - this.now()) / 60_000))} minutes from now.` };
    }
    return { ok: false, text: `A machine on a box of your own can be ended or given more time. ${action === 'reboot' ? 'A restart' : action === 'resize' ? 'A resize' : 'Anything else'} needs a hypervisor.` };
  }

  /**
   * Keep the box's clock on its machines: look once a minute while there is
   * one, and stop looking when there is none. Asked at the hub's start too,
   * where it does nothing on a box that never made a machine (no file).
   */
  watch() {
    if (this.timer || !Object.keys(this.#ends()).length) return;
    this.timer = setInterval(() => {
      void this.list().then((r) => {
        if (r.ok && !r.machines.length) this.unwatch();
      }).catch(() => {});
    }, 60_000);
    this.timer.unref?.();
  }

  unwatch() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
