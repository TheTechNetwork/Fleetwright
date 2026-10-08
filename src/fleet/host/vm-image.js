// The machine image: a Debian 13 template on the pool, with Fleetwright
// installed and not enrolled, that sessions' machines are cloned from.
// docs/hypervisors.md, "Machines from your pool".
//
// WHY AN IMAGE AND NOT AN INSTALL PER MACHINE. Installing Fleetwright on a
// bare Debian takes minutes (Node, podman, the Claude CLI, the session
// image), and a machine asked for from a phone should be up in about one. So
// the install happens once, here, into a template, and every machine after
// it is a clone that only has to boot and enrol.
//
// HOW IT IS BUILT WITHOUT ANYBODY AT A CONSOLE. Debian's own cloud image
// (genericcloud, the build pinned below by its published SHA-512) reads
// cloud-init from the config drive Xen Orchestra makes for a VM. The machine
// running the policy job downloads its qcow2 once, checks it against that
// digest, reads the raw disk out of it into Xen Orchestra's disk import as it
// goes (qcow2.js, Node's own zlib, nothing to install), grows the disk to
// the size a session needs, and boots a VM from it on the uplink, behind the
// edge router, with a cloud-init that installs Fleetwright from this fleet's
// own /install without a pin, wipes everything that would make two clones
// the same machine (the machine id, SSH host keys, any host key), cleans
// cloud-init so each clone runs its own, and powers off. Then the VM becomes
// the template, tagged so the fleet's boxes find it, and is put in the
// resource set so the limited user can clone it.
//
// HOW THE BUILD SAYS IT FAILED. The install script powers off when
// everything worked and reboots when anything did not: cloud-init does not
// run its script twice, so a reboot is a VM that comes back up and stays up,
// and Xen Orchestra's `startTime` moves. That is read as the failure, at
// once, instead of after a timeout.
//
// AND WHERE IT HAS GOT TO. Power state was all the box could see, so a real
// build sat at "18 min so far, usually about 8" with nothing to say why. The
// script now reports each step to this fleet's coordinator with a token the
// box asked for (core.js, imageReport), the coordinator passes it to the box,
// and the phone is told the step: installing packages, installing
// Fleetwright, or a VM that has not reported in at all, which is a network
// or a start-up script that did not run. A failure sends the end of the
// install log with it, the only way to read it: the VM has no password. A
// failed or timed-out VM is kept, stopped and named for what happened; the
// next build removes it.
//
// FIRST RUN against a real pool ended at vm.create: Xen Orchestra puts a
// cloud-init drive on the storage of the VM's first disk and this VM had
// none yet, so the drive is now made by its own call after the disk is in,
// and taken off again before the VM becomes the template. The calls are Xen
// Orchestra's documented ones (disk.import, disk.resize or vdi.set,
// vm.create, vm.attachDisk, vm.createCloudInitConfigDrive, vdi.delete,
// vm.convertToTemplate, resourceSet.addObject), exercised against a stand-in
// that refuses what the real one refuses; the whole build is NOT YET RUN
// through to a template on a real pool.

import { fetchPinned, uploadDisk, srName } from './edge-router.js';
import { qcow2Raw, qcow2Size } from './qcow2.js';
import { IMAGE_REPORT_TOKEN_RE } from '../protocol/intents.js';

/** Debian 13's cloud image, pinned. A newer build is a new entry here. */
export const DEBIAN_IMAGE = Object.freeze({
  key: 'debian-13',
  os: 'Debian 13',
  name: 'Fleetwright Debian 13',
  format: 'qcow2',
  label: 'Debian',
  algorithm: /** @type {'sha512'} */ ('sha512'),
  release: '13',
  build: '20261001-2618',
  url: 'https://cloud.debian.org/images/cloud/trixie/20261001-2618/debian-13-genericcloud-amd64-20261001-2618.qcow2',
  /** As published in that build's SHA512SUMS, and as downloaded. */
  sha512: 'f46f0671a6e5bdec5291ab8972bae2f10e5408c2f64a74078f11efc2f06a436a9d0313ed50e0472542eeabf780e9f7c792ac0a314c6c20507fcd9fd81b468c3d',
  compressedSize: 341508096,
  /** The disk's size inside the qcow2, before it is grown. */
  rawSize: 3221225472,
});

/**
 * Ubuntu's cloud images, pinned the same way and read the same way: from the
 * qcow2 Ubuntu publishes (its tarball holds a bare ext4 partition, which does
 * not boot). `rawSize` is the virtual size in the qcow2 header.
 */
export const UBUNTU_2404_IMAGE = Object.freeze({
  key: 'ubuntu-24.04',
  os: 'Ubuntu 24.04 LTS',
  name: 'Fleetwright Ubuntu 24.04',
  format: 'qcow2',
  label: 'Ubuntu',
  algorithm: /** @type {'sha256'} */ ('sha256'),
  build: 'release-20260926',
  url: 'https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img',
  /** As published in that release's SHA256SUMS, and as downloaded. */
  sha256: '6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2',
  compressedSize: 625612288,
  rawSize: 3758096384,
});

export const UBUNTU_2604_IMAGE = Object.freeze({
  key: 'ubuntu-26.04',
  os: 'Ubuntu 26.04 LTS',
  name: 'Fleetwright Ubuntu 26.04',
  format: 'qcow2',
  label: 'Ubuntu',
  algorithm: /** @type {'sha256'} */ ('sha256'),
  build: 'release-20260927',
  url: 'https://cloud-images.ubuntu.com/releases/resolute/release-20260927/ubuntu-26.04-server-cloudimg-amd64.img',
  sha256: '8800651811af9a85465ad1d552add729947bb16488dddb4a9b5305a3d97332b2',
  compressedSize: 865115136,
  rawSize: 3758096384,
});

/**
 * WHICH OPERATING SYSTEMS A MACHINE CAN RUN: the ones Fleetwright's installer
 * supports, each pinned. Asked for: "os selection not just Debian". A new one
 * is an entry here and nothing else; the phone lists what the box offers.
 *
 * @typedef {typeof DEBIAN_IMAGE | typeof UBUNTU_2404_IMAGE} ImageSpec
 */
export const IMAGES = Object.freeze(/** @type {Record<string, any>} */ ({
  [DEBIAN_IMAGE.key]: DEBIAN_IMAGE,
  [UBUNTU_2404_IMAGE.key]: UBUNTU_2404_IMAGE,
  [UBUNTU_2604_IMAGE.key]: UBUNTU_2604_IMAGE,
}));

/** The digest a spec is pinned to, by its algorithm. @param {any} spec */
const digestOf = (spec) => (spec.algorithm === 'sha512' ? spec.sha512 : spec.sha256);

/** The tag naming which image a template is, beside `fleetwright-image`. @param {string} key */
export const imageTag = (key) => `fleetwright-image:${key}`;

/**
 * Which catalogue entry a template is: by its key tag, or, for an image
 * built before there was more than one, Debian by its name.
 *
 * @param {any} t @returns {string|null}
 */
export function imageKeyOf(t) {
  const tags = Array.isArray(t?.tags) ? t.tags : [];
  const tagged = tags.find((/** @type {string} */ x) => x.startsWith('fleetwright-image:'));
  if (tagged) return tagged.slice('fleetwright-image:'.length);
  return tags.includes('fleetwright-image') ? DEBIAN_IMAGE.key : null;
}

/** Names and sizes in Xen Orchestra. */
export const VM_IMAGE = Object.freeze({
  /** On the template, which is how a box holding a pool's token finds it. */
  tag: 'fleetwright-image',
  name: 'Fleetwright Debian 13',
  /** On the VM while it is being built, so a build left by an earlier try is found and removed. */
  buildTag: 'fleetwright-image-build',
  buildName: 'fleetwright-image-build',
  /** On every machine cloned from it. */
  sessionTag: 'fleetwright-session',
  /** And when each must be gone by, as `fleetwright-until:<epoch seconds>`. */
  untilPrefix: 'fleetwright-until:',
  /** And which template it came from, as `fleetwright-from:<template id>`. */
  fromPrefix: 'fleetwright-from:',
  template: 'Other install media',
  /** The disk a clone has: room for the session image, a workspace and a build. */
  diskSize: 20 * 1024 ** 3,
  cpus: 2,
  memory: 4 * 1024 ** 3,
  /** How long the install may take before the build is given up on. */
  installMs: 25 * 60_000,
  /** What the install usually takes, for the bar. */
  installTypicalMs: 8 * 60_000,
});

/** The run user's account, which the install makes the hub run as. */
const RUN_USER = 'fleetwright';

/**
 * The cloud-init the build VM boots with. One script, so that "everything
 * worked" and "something did not" are the two ways it can end: powered off,
 * or rebooted (see the top of this file).
 *
 * AND IT SAYS WHERE IT HAS GOT TO, when it was given a token: each step, as
 * a word from IMAGE_REPORT_STEPS, to this fleet's coordinator, which passes
 * it to the box running the build (core.js, imageReport). A failure sends
 * the end of the install log with it, because the VM has no password and
 * nobody can read the log any other way. Python's own urllib, because
 * cloud-init is written in Python and so it is there before anything is
 * installed; a report that cannot be sent is dropped and the install goes
 * on, judged by power state as before.
 *
 * THE STEPS RUN IN A SUBSHELL OF THEIR OWN, and that is the fix for a bug:
 * they used to run in a `{ ... } && poweroff || reboot` group, and bash
 * ignores `set -e` inside anything on the left of `&&`. A step that failed
 * did not stop the script, so a broken install went on, powered off, and
 * became the template.
 *
 * @param {{ coordinatorUrl: string, token?: string|null }} opts
 */
export function buildCloudConfig({ coordinatorUrl, token = null }) {
  const origin = new URL(coordinatorUrl).origin;
  if (token !== null && !IMAGE_REPORT_TOKEN_RE.test(token)) throw new Error('that is not a report token');
  const script = [
    '#!/bin/bash',
    'set -u',
    'log=/var/log/fleetwright-image.log',
    // AND ON THE VM'S OWN SCREEN, which Xen Orchestra's console shows: the
    // VM has no password, so this is the one place a person can watch the
    // install without its reports, when they are what is not getting out.
    "screens='/dev/console /dev/tty1'",
    `origin='${origin}'`,
    `token='${token ?? ''}'`,
    // THE BODY BY PYTHON, which has JSON and is there before anything is
    // installed; SENT BY CURL once there is one, with a user agent of its
    // own. curl is what fetched /install through the same front door, and a
    // stock Python-urllib agent is the kind a CDN's bot check turns away.
    'report() {',
    '  [ -n "$token" ] || return 0',
    "  body=$(python3 -c '",
    'import json, sys',
    'body = {"token": sys.argv[1], "step": sys.argv[2]}',
    'if sys.argv[2] == "failed":',
    '    try:',
    '        body["detail"] = open(sys.argv[3], errors="replace").read()[-2000:]',
    '    except OSError:',
    '        pass',
    'print(json.dumps(body))',
    `' "$token" "$1" "$log" 2>/dev/null) || return 0`,
    '  if command -v curl >/dev/null 2>&1; then',
    `    curl -fsS -m 10 -A fleetwright-image -H 'content-type: application/json' --data-binary "$body" "$origin/api/xosetup/report" >/dev/null 2>&1 || true`,
    '  else',
    "    python3 -c '",
    'import sys, urllib.request',
    'req = urllib.request.Request(sys.argv[1] + "/api/xosetup/report", sys.argv[2].encode(), {"content-type": "application/json", "user-agent": "fleetwright-image"})',
    'urllib.request.urlopen(req, timeout=10).read()',
    `' "$origin" "$body" >/dev/null 2>&1 || true`,
    '  fi',
    '}',
    'steps() {',
    '  set -eo pipefail',
    '  export DEBIAN_FRONTEND=noninteractive',
    // WHETHER IT HAS A NETWORK, first, on the screen: an address, a route,
    // and a name looked up. A VM that never reports in is most often this.
    '  echo "fleetwright: building the machine image"',
    '  ip -4 -br addr || true',
    '  ip -4 route || true',
    '  getent hosts deb.debian.org || echo "fleetwright: cannot look up deb.debian.org, so this VM has no working DNS"',
    '  report packages',
    '  apt-get update',
    '  apt-get install -y curl ca-certificates openssh-server',
    // The Xen guest agent, where Debian has it: it is what lets Xen
    // Orchestra see a clone's address and know it has booted.
    '  apt-get install -y xe-guest-utilities || true',
    // What a clone fences itself with on the uplink and finds the others in
    // its group by (install/fleetwright-net). A clone installs them itself
    // when they are missing, at the cost of a minute.
    '  apt-get install -y nftables avahi-daemon libnss-mdns || true',
    '  report installer',
    `  curl -fsSL '${origin}/install' | FLEETWRIGHT_COORDINATOR_URL='${origin}' FLEETWRIGHT_USER=${RUN_USER} sh -s -- --yes`,
    '  test -x /opt/fleetwright/current/install/fleetwright-vm-join',
    '  report cleaning',
    // Started by each clone once it has enrolled, never by the image.
    '  systemctl disable --now fleetwright-sidecar fleetwright 2>/dev/null || true',
    // NOTHING THAT MAKES TWO CLONES ONE MACHINE.
    '  rm -f /var/lib/fleetwright-sidecar/host-key.json /var/lib/fleetwright-sidecar/host-key.json.*',
    '  truncate -s 0 /etc/machine-id',
    '  rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*',
    // NOR THE TOKEN, which is in this script and cloud-init's copy of it.
    '  rm -f /root/fleetwright-image.sh',
    '  cloud-init clean --logs',
    '}',
    'report started',
    // tee carries on past a screen it cannot open, and the status is the
    // steps', not tee's.
    '( steps ) 2>&1 | tee -a "$log" $screens >/dev/null',
    'if [ "${PIPESTATUS[0]}" -eq 0 ]; then',
    '  report done',
    '  systemctl poweroff',
    'else',
    '  report failed',
    '  systemctl reboot',
    'fi',
  ].join('\n');
  return [
    '#cloud-config',
    'hostname: fleetwright-image',
    'users:',
    '  - default',
    `  - name: ${RUN_USER}`,
    '    shell: /bin/bash',
    '    lock_passwd: true',
    'write_files:',
    '  - path: /root/fleetwright-image.sh',
    "    permissions: '0700'",
    '    content: |',
    ...script.split('\n').map((l) => `      ${l}`),
    'runcmd:',
    '  - [/root/fleetwright-image.sh]',
    '',
  ].join('\n');
}

/** What Xen Orchestra names the cloud-init drive it makes (xo-server, createCloudInitConfigDrive). */
export const CONFIG_DRIVE_NAME = 'XO CloudConfigDrive';

/**
 * Deletes the cloud-init drive Xen Orchestra attached to a VM, found by the
 * name it gives every one, among the disks that VM has.
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin
 * @param {string} vm
 */
async function dropConfigDrive(admin, vm) {
  const vbds = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VBD', VM: vm } })) || {}));
  for (const vbd of vbds) {
    if (!vbd?.VDI || vbd.is_cd_drive) continue;
    const vdi = /** @type {any} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VDI', id: vbd.VDI } })) || {})[0]);
    if (vdi?.name_label === CONFIG_DRIVE_NAME) await admin.call('vdi.delete', { id: vdi.id });
  }
}

/**
 * Where the image's disk goes: the storage chosen, or the fleet's storage in
 * the pool with the most room. Either must have room for the whole disk.
 *
 * @param {{ pool: string, srs: any[], fleetSrs: string[], sr?: string|null }} opts
 */
export function imageStorage({ pool, srs, fleetSrs, sr = null }) {
  const room = (/** @type {any} */ s) => (Number(s?.size) || 0) - (Number(s?.physical_usage) || 0);
  const fits = (/** @type {any} */ s) => s?.$pool === pool && room(s) > VM_IMAGE.diskSize;
  const gib = Math.round(VM_IMAGE.diskSize / 1024 ** 3);
  if (sr) {
    const chosen = srs.find((s) => s?.id === sr);
    if (!chosen || chosen.$pool !== pool) throw new Error('the storage chosen for the machine image is not in its pool. Nothing was built');
    if (!fits(chosen)) throw new Error(`${srName(chosen)} has no ${gib} GiB free for the machine image. Nothing was built`);
    return chosen;
  }
  const best = srs.filter((s) => fleetSrs.includes(s?.id) && fits(s)).sort((a, b) => room(b) - room(a))[0];
  if (!best) throw new Error(`none of the storage the fleet may use in this pool has ${gib} GiB free for the machine image. Choose where it goes. Nothing was built`);
  return best;
}

/** @param {number} n */
const mb = (n) => Math.round(n / 1024 ** 2);

/** Four stages: download, write the disk, install, make the template. */
export const IMAGE_STAGES = 4;
/** Thousandths of the bar the bytes take; the install has most of the rest. */
const BYTES_SHARE = 450;
const INSTALLED = 970;
/** The qcow2 downloaded, then the raw disk written. @param {number} downloaded @param {number} written @param {any} [spec] */
export function imageFill(downloaded, written, spec = DEBIAN_IMAGE) {
  const bytes = spec.compressedSize + spec.rawSize;
  return Math.min(BYTES_SHARE, Math.floor((BYTES_SHARE * (Math.min(downloaded, spec.compressedSize) + Math.min(written, spec.rawSize))) / bytes));
}

/**
 * Where each step the build VM reports puts the install's share of the bar:
 * at least the first number, and time moves it no further than the second.
 * The session image is fetched inside `installer`, which is most of it.
 */
const STEP_SHARE = Object.freeze({
  started: [0.05, 0.1], packages: [0.1, 0.25], installer: [0.25, 0.9], cleaning: [0.9, 0.95], done: [0.95, 0.95], failed: [0, 0.95],
});

/**
 * How far through the install: by the step the build VM last reported when
 * it has said one, and by time against what it usually takes when it has
 * not. Never quite done; the VM powering off is done.
 *
 * @param {number} elapsed @param {string|null} [step]
 */
export function installFill(elapsed, step = null) {
  const [least, most] = step && Object.hasOwn(STEP_SHARE, step) ? STEP_SHARE[/** @type {keyof typeof STEP_SHARE} */ (step)] : [0, 0.95];
  const share = Math.min(most, Math.max(least, elapsed / VM_IMAGE.installTypicalMs));
  return BYTES_SHARE + Math.floor((INSTALLED - BYTES_SHARE) * share);
}

/** What the phone says the build VM is doing, for each step it reports. */
const STEP_WORDS = Object.freeze({
  started: 'its VM is up and has started the install',
  packages: 'installing Debian’s packages',
  installer: 'installing Fleetwright and fetching the session image',
  cleaning: 'clearing what would make two machines cloned from it the same',
  done: 'the install is done and its VM is powering off',
  failed: 'the install failed',
});

/** How long a build VM with a token may say nothing before the phone says so. */
const SILENT_MS = 5 * 60_000;

/** The last few lines of a log, for a sentence on a phone. @param {string|null|undefined} log */
const logEnd = (log) => String(log || '').trim().split('\n').slice(-4).join('\n').slice(-600);

/** @param {number} ms */
const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The machine image on this pool: left as it is when it is there, built when
 * it is not. Answers the sentence the job finishes with.
 *
 * @param {{
 *   admin: any,
 *   pool: string,
 *   poolName?: string,
 *   uplink: string,
 *   setId: string,
 *   srs: any[],
 *   fleetSrs: string[],
 *   sr?: string|null,
 *   address: string, pin: string|null, plain: boolean,
 *   imageDir: string,
 *   coordinatorUrl: string,
 *   say: (text: string, part?: { stage: number, stages: number, fill: number }) => void,
 *   signal?: AbortSignal,
 *   image?: string,
 *   resize?: 'disk.resize'|'vdi.set',
 *   getImage?: typeof fetchPinned,
 *   upload?: typeof uploadDisk,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   pollMs?: number,
 *   reporter?: (() => Promise<string|null>)|null,
 *   vmReport?: () => ({ step: string, detail: string|null, at: number }|null),
 *   replace?: boolean,
 * }} opts
 */
export async function ensureImage({
  admin, pool, poolName = 'this pool', uplink, setId, srs, fleetSrs, sr: chosenSr = null, address, pin, plain, imageDir, coordinatorUrl, say, signal,
  image: key = DEBIAN_IMAGE.key,
  resize = 'disk.resize',
  getImage = fetchPinned, upload = uploadDisk, now = () => Date.now(), sleep = sleepFor, pollMs = 10_000,
  reporter = null, vmReport = () => null,
  replace = false,
}) {
  const spec = IMAGES[key];
  if (!spec) throw new Error(`there is no machine image called ${key}. Nothing was built`);
  const templates = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {}));
  const there = templates.find((t) => t?.$pool === pool && t?.tags?.includes?.(VM_IMAGE.tag) && imageKeyOf(t) === key);
  // REBUILT WHEN ASKED: the new one is built beside it and the one there is
  // retired only once the new one is a template, so a build that fails or is
  // cancelled leaves the pool with the image it had (retireImage below).
  if (there && !replace) {
    // IN THE SET, whatever else: an image made before the set existed, or
    // taken out of it in Xen Orchestra, is one the fleet can see and not use.
    await admin.call('resourceSet.addObject', { id: setId, object: there.id }).catch(() => {});
    return `The ${spec.os} machine image was already there on ${poolName}: ${String(there.name_label || spec.name)}.`;
  }

  // A BUILD AN EARLIER TRY LEFT, failed or cut off, is removed first so two
  // never exist at once.
  const vms = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
  for (const old of vms.filter((v) => v?.$pool === pool && v?.tags?.includes?.(VM_IMAGE.buildTag))) {
    if (old.power_state === 'Running') await admin.call('vm.stop', { id: old.id, force: true }).catch(() => {});
    await admin.call('vm.delete', { id: old.id, deleteDisks: true }).catch(() => {});
  }

  const sr = imageStorage({ pool, srs, fleetSrs, sr: chosenSr });
  const on = srName(sr);
  const base = templates.find((t) => t?.$pool === pool && t?.name_label === VM_IMAGE.template);
  if (!base) throw new Error(`this pool has no "${VM_IMAGE.template}" template to make the machine image from. Nothing was built`);

  const stage = (/** @type {number} */ n, /** @type {number} */ fill) => ({ stage: n, stages: IMAGE_STAGES, fill });
  const os = spec.os;
  say(`Downloading ${os} for the machine image.`, stage(1, 0));
  let downloaded = 0;
  const file = await getImage({
    dir: imageDir,
    url: spec.url,
    size: spec.compressedSize,
    algorithm: spec.algorithm,
    digest: digestOf(spec),
    label: spec.label,
    signal,
    onProgress: (d, t) => {
      downloaded = d;
      say(`Downloading ${os} for the machine image: ${mb(d)} of ${mb(t)} MB.`, stage(1, imageFill(d, 0, spec)));
    },
  });
  signal?.throwIfAborted();
  if (!downloaded) say(`${os} was already downloaded and checked.`, stage(1, imageFill(spec.compressedSize, 0, spec)));

  /** @type {string|null} */
  let vdi = null;
  /** @type {string|null} */
  let vm = null;
  let keep = false;
  // THE LENGTH SENT is the disk the qcow2's header holds: Content-Length goes
  // ahead of the bytes, and the download it is read from is the pinned one.
  const holds = await qcow2Size(file);
  try {
    say(`Writing the machine image’s disk to ${on}.`, stage(2, imageFill(spec.compressedSize, 0, spec)));
    const { $sendTo } = await admin.call('disk.import', {
      sr: sr.id,
      // RAW, EXPANDED HERE AS IT GOES. The pool cannot take the qcow2 as it
      // is published: XCP-ng's qcow-stream-tool refused it on a real pool
      // with Compressed_unsupported, and every distribution compresses its
      // clusters. A raw disk is what it takes, so qcow2.js reads the raw disk
      // out of the checked download into the upload, nothing written here.
      type: 'iso',
      name: VM_IMAGE.buildName,
      description: `${os} (${spec.build}), becoming Fleetwright's machine image`,
    });
    vdi = await upload({
      address,
      pin,
      plain,
      sendTo: $sendTo,
      body: qcow2Raw(file, { signal }),
      size: holds,
      filename: `${spec.key}.raw`,
      signal,
      onProgress: (d, t) => say(`Writing the machine image’s disk to ${on}: ${mb(d)} of ${mb(t)} MB.`, stage(2, imageFill(spec.compressedSize, d, spec))),
    });
    signal?.throwIfAborted();
    // ROOM FOR A SESSION. cloud-init grows the partition to fill it on the
    // first boot, the build's and every clone's alike. Through whichever
    // call the server offers (RESIZE_METHODS in xo-setup.js): both take the
    // disk's id and its new size in bytes.
    await admin.call(resize === 'vdi.set' ? 'vdi.set' : 'disk.resize', { id: vdi, size: VM_IMAGE.diskSize });

    say(`Installing Fleetwright on the machine image, its disk on ${on}.`, stage(3, installFill(0)));
    vm = await admin.call('vm.create', {
      template: base.id,
      name_label: VM_IMAGE.buildName,
      name_description: 'Becoming the machine image sessions are cloned from. Made by Fleetwright; it powers off when the install is done.',
      VIFs: [{ network: uplink }],
      VDIs: [],
      CPUs: VM_IMAGE.cpus,
      memory: VM_IMAGE.memory,
      tags: [VM_IMAGE.buildTag],
      bootAfterCreate: false,
    });
    await admin.call('vm.attachDisk', { vm, vdi, bootable: true, position: '0' });
    vdi = null; // the VM's now, and deleted with it
    // THE CLOUD-INIT DRIVE AFTER THE DISK, by its own call and on the disk's
    // storage. vm.create with `cloudConfig` puts the drive on the storage of
    // the VM's first disk, and this VM has none until the line above: Xen
    // Orchestra refused it with "Can't create cloud init config drive for VM
    // without disks", which is how the first build on a real pool ended.
    // A TOKEN FOR ITS REPORTS, when the fleet gives one (core.js,
    // #onImageReporter). Without one the build is judged by power state
    // alone, as it was before reports existed.
    const token = reporter ? await reporter() : null;
    await admin.call('vm.createCloudInitConfigDrive', { vm, sr: sr.id, config: buildCloudConfig({ coordinatorUrl, token }) });
    signal?.throwIfAborted();
    await admin.call('vm.start', { id: vm });

    // A FAILED OR STALLED INSTALL KEEPS ITS VM, stopped and named for what
    // happened, so it can be looked at in Xen Orchestra; the next build
    // removes it. A timeout used to delete it, with the only evidence.
    const giveUp = async (/** @type {string} */ what) => {
      keep = true;
      await admin.call('vm.stop', { id: vm, force: true }).catch(() => {});
      await admin.call('vm.set', { id: vm, name_label: `${VM_IMAGE.buildName} (${what})` }).catch(() => {});
      return `Its build VM was kept, stopped, as "${VM_IMAGE.buildName} (${what})". Applying again removes it and starts over`;
    };
    const failed = async (/** @type {{ detail: string|null }|null} */ report) => {
      const kept = await giveUp('install failed');
      const end = logEnd(report?.detail);
      return new Error(
        end
          ? `Fleetwright did not install on the machine image. The end of its log:\n${end}\n${kept}`
          : `Fleetwright did not install on the machine image, and it did not send its log back. ${kept}`,
      );
    };

    const started = now();
    /** @type {number|null} */
    let firstStart = null;
    for (;;) {
      signal?.throwIfAborted();
      await sleep(pollMs);
      signal?.throwIfAborted();
      const report = vmReport();
      // SAID SO ITSELF: no need to wait for the reboot that says the same.
      if (report?.step === 'failed') throw await failed(report);
      const seen = /** @type {any} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { id: vm } })) || {})[0]);
      if (!seen) throw new Error('the machine image’s build VM disappeared from Xen Orchestra while it was installing');
      if (seen.power_state === 'Halted') break;
      if (seen.power_state === 'Running') {
        const at = Number(seen.startTime) || null;
        if (firstStart === null) firstStart = at;
        // REBOOTED: the install said it failed (see the top of this file),
        // and its report of why may have got here first or not at all.
        else if (at !== null && at !== firstStart) throw await failed(vmReport());
      }
      const elapsed = now() - started;
      const minutes = Math.max(1, Math.round(elapsed / 60_000));
      if (elapsed > VM_IMAGE.installMs) {
        const last = report ? `; the last it said was that ${STEP_WORDS[/** @type {keyof typeof STEP_WORDS} */ (report.step)]}` : token ? ', and its VM never reported in, so it most likely has no network or its start-up script did not run' : '';
        throw new Error(`the install on the machine image did not finish within ${Math.round(VM_IMAGE.installMs / 60_000)} minutes${last}. ${await giveUp('install timed out')}`);
      }
      const words = report
        ? `${STEP_WORDS[/** @type {keyof typeof STEP_WORDS} */ (report.step)]}, ${minutes} min so far.`
        : token && elapsed > SILENT_MS
          ? `${minutes} min so far, and its VM has not reported in. It may have no network, or its start-up script did not run.`
          : `${minutes} min so far, usually about ${Math.round(VM_IMAGE.installTypicalMs / 60_000)}.`;
      say(`Installing Fleetwright on the machine image: ${words}`, stage(3, installFill(elapsed, report?.step ?? null)));
    }

    say(`Making the machine image a template on ${poolName}.`, stage(4, INSTALLED));
    // NOT THE BUILD'S DRIVE IN THE TEMPLATE. It holds the install script, and
    // a clone of a template keeps its disks: every machine would boot with
    // two cloud-init drives, its own and this one, and cloud-init takes
    // whichever it finds first.
    await dropConfigDrive(admin, /** @type {string} */ (vm));
    // NAMED AND TAGGED WHILE IT IS STILL A VM, so a conversion that fails
    // leaves nothing half-renamed: the VM is removed below either way.
    await admin.call('vm.set', {
      id: vm,
      name_label: spec.name,
      name_description: `${os} with Fleetwright installed and not enrolled. Sessions' machines are cloned from this. Made by Fleetwright.`,
    });
    await admin.call('tag.remove', { id: vm, tag: VM_IMAGE.buildTag }).catch(() => {});
    await admin.call('tag.add', { id: vm, tag: VM_IMAGE.tag });
    await admin.call('tag.add', { id: vm, tag: imageTag(spec.key) });
    await admin.call('vm.convertToTemplate', { id: vm });
    await admin.call('resourceSet.addObject', { id: setId, object: vm });
  } catch (e) {
    // Nothing half-made is left, except a failed install's VM, kept on purpose.
    if (vm && !keep) await admin.call('vm.delete', { id: vm, deleteDisks: true }).catch(() => {});
    if (vdi) await admin.call('vdi.delete', { id: vdi }).catch(() => {});
    throw e;
  }
  if (there) {
    const retired = await retireImage(admin, there);
    return (
      `The ${os} machine image was rebuilt on ${poolName}, its disk on ${on}. ` +
      (retired.removed
        ? 'The one that was there was removed.'
        : `The one that was there was kept as "${retired.name}", because ${machines(retired.clones)} made from it still ${retired.clones === 1 ? 'exists' : 'exist'}; New session no longer offers it, and it can be removed once ${retired.clones === 1 ? 'that machine is' : 'they are'} gone.`)
    );
  }
  return (
    `The machine image is ready on ${poolName}: ${spec.name}, ${os} with Fleetwright installed, its disk on ${on}. ` +
    'Start a session on a new machine from it under New session › Where.'
  );
}

/** @param {number} n */
const machines = (n) => (n === 1 ? 'a machine' : `${n} machines`);

/**
 * The machines made from a template: every VM tagged with where it came from
 * (xo-pools.js tags each clone so), the ones kept ready among them.
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin
 * @param {string} template
 */
async function clonesOf(admin, template) {
  const vms = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
  return vms.filter((v) => Array.isArray(v?.tags) && v.tags.includes(`${VM_IMAGE.fromPrefix}${template}`)).length;
}

/**
 * A template that is no longer the image: deleted when nothing was made from
 * it, and otherwise kept, untagged so no box offers it again and renamed so
 * whoever looks in Xen Orchestra can tell why it is there. A machine made from
 * it keeps the disk it was made with either way; deleting the template under
 * it is what this declines to find out about.
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin
 * @param {any} template
 * @returns {Promise<{ removed: true } | { removed: false, clones: number, name: string }>}
 */
async function retireImage(admin, template) {
  const clones = await clonesOf(admin, String(template.id));
  if (!clones) {
    await admin.call('vm.delete', { id: template.id, deleteDisks: true });
    return { removed: true };
  }
  const name = `${String(template.name_label || VM_IMAGE.name).slice(0, 60)} (replaced)`;
  for (const tag of (template.tags || []).filter((/** @type {string} */ t) => t === VM_IMAGE.tag || t.startsWith(`${VM_IMAGE.tag}:`))) {
    await admin.call('tag.remove', { id: template.id, tag }).catch(() => {});
  }
  await admin.call('vm.set', { id: template.id, name_label: name }).catch(() => {});
  return { removed: false, clones, name };
}

/**
 * The machine image `key` taken off a pool, when the person asked. Never
 * from under a machine made from it: then it stays as it is, and the sentence
 * says how many machines and that removing it waits for them.
 *
 * @param {{ admin: any, pool: string, poolName?: string, image: string }} opts
 * @returns {Promise<string>}
 */
export async function removeImage({ admin, pool, poolName = 'this pool', image: key }) {
  const spec = IMAGES[key];
  if (!spec) throw new Error(`there is no machine image called ${key}. Nothing was removed`);
  const templates = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {}));
  const there = templates.filter((t) => t?.$pool === pool && t?.tags?.includes?.(VM_IMAGE.tag) && imageKeyOf(t) === key);
  if (!there.length) return `The ${spec.os} machine image was already gone from ${poolName}.`;
  /** @type {number[]} */
  const kept = [];
  for (const t of there) {
    const clones = await clonesOf(admin, String(t.id));
    if (clones) kept.push(clones);
    else await admin.call('vm.delete', { id: t.id, deleteDisks: true });
  }
  if (!kept.length) return `The ${spec.os} machine image was removed from ${poolName}. New session no longer offers it.`;
  const n = kept.reduce((a, b) => a + b, 0);
  return `The ${spec.os} machine image was kept on ${poolName}: ${machines(n)} made from it still ${n === 1 ? 'exists' : 'exist'}. Remove ${n === 1 ? 'that machine' : 'them'} and apply again.`;
}
