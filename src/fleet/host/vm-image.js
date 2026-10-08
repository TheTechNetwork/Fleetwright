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
// digest, hands it to Xen Orchestra's disk import as it is, grows the disk to
// the size a session needs, and boots a VM from it on the uplink, behind the
// edge router, with a cloud-init that installs Fleetwright from this fleet's
// own /install without a pin, wipes everything that would make two clones
// the same machine (the machine id, SSH host keys, any host key), cleans
// cloud-init so each clone runs its own, and powers off. Then the VM becomes
// the template, tagged so the fleet's boxes find it, and is put in the
// resource set so the limited user can clone it.
//
// HOW THE BUILD SAYS IT FAILED. A VM cannot hand anything back but its power
// state, so the install script powers off when everything worked and reboots
// when anything did not: cloud-init does not run its script twice, so a
// reboot is a VM that comes back up and stays up, and Xen Orchestra's
// `startTime` moves. That is read as the failure, at once, instead of after
// a timeout. The failed VM is kept, stopped and named for what happened, so
// its log can be read in Xen Orchestra's console; the next build removes it.
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

import { createReadStream } from 'node:fs';

import { fetchPinned, uploadDisk, srName } from './edge-router.js';

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
 * Ubuntu's cloud images, pinned the same way and uploaded the same way: as
 * the qcow2 Ubuntu publishes (its tarball holds a bare ext4 partition, which
 * does not boot). `rawSize` is the virtual size in the qcow2 header.
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
 * @param {{ coordinatorUrl: string }} opts
 */
export function buildCloudConfig({ coordinatorUrl }) {
  const origin = new URL(coordinatorUrl).origin;
  const script = [
    '#!/bin/bash',
    'set -u',
    'log=/var/log/fleetwright-image.log',
    '{',
    '  set -e',
    '  export DEBIAN_FRONTEND=noninteractive',
    '  apt-get update',
    '  apt-get install -y curl ca-certificates openssh-server',
    // The Xen guest agent, where Debian has it: it is what lets Xen
    // Orchestra see a clone's address and know it has booted.
    '  apt-get install -y xe-guest-utilities || true',
    // What a clone fences itself with on the uplink and finds the others in
    // its group by (install/fleetwright-net). A clone installs them itself
    // when they are missing, at the cost of a minute.
    '  apt-get install -y nftables avahi-daemon libnss-mdns || true',
    `  curl -fsSL '${origin}/install' | FLEETWRIGHT_COORDINATOR_URL='${origin}' FLEETWRIGHT_USER=${RUN_USER} sh -s -- --yes`,
    '  test -x /opt/fleetwright/current/install/fleetwright-vm-join',
    // Started by each clone once it has enrolled, never by the image.
    '  systemctl disable --now fleetwright-sidecar fleetwright 2>/dev/null || true',
    // NOTHING THAT MAKES TWO CLONES ONE MACHINE.
    '  rm -f /var/lib/fleetwright-sidecar/host-key.json /var/lib/fleetwright-sidecar/host-key.json.*',
    '  truncate -s 0 /etc/machine-id',
    '  rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*',
    '  cloud-init clean --logs',
    '} >"$log" 2>&1 && systemctl poweroff || systemctl reboot',
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
/** The same file is downloaded and then written. @param {number} downloaded @param {number} written @param {any} [spec] */
export function imageFill(downloaded, written, spec = DEBIAN_IMAGE) {
  const size = spec.compressedSize;
  return Math.min(BYTES_SHARE, Math.floor((BYTES_SHARE * (Math.min(downloaded, size) + Math.min(written, size))) / (2 * size)));
}

/** How far through the install, by time against what it usually takes, never quite done. @param {number} elapsed */
export function installFill(elapsed) {
  const share = Math.min(0.95, elapsed / VM_IMAGE.installTypicalMs);
  return BYTES_SHARE + Math.floor((INSTALLED - BYTES_SHARE) * share);
}

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
 * }} opts
 */
export async function ensureImage({
  admin, pool, poolName = 'this pool', uplink, setId, srs, fleetSrs, sr: chosenSr = null, address, pin, plain, imageDir, coordinatorUrl, say, signal,
  image: key = DEBIAN_IMAGE.key,
  resize = 'disk.resize',
  getImage = fetchPinned, upload = uploadDisk, now = () => Date.now(), sleep = sleepFor, pollMs = 10_000,
}) {
  const spec = IMAGES[key];
  if (!spec) throw new Error(`there is no machine image called ${key}. Nothing was built`);
  const templates = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {}));
  const there = templates.find((t) => t?.$pool === pool && t?.tags?.includes?.(VM_IMAGE.tag) && imageKeyOf(t) === key);
  if (there) {
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
  try {
    say(`Writing the machine image’s disk to ${on}.`, stage(2, imageFill(spec.compressedSize, 0, spec)));
    const { $sendTo } = await admin.call('disk.import', {
      sr: sr.id,
      // AS PUBLISHED: Xen Orchestra reads the qcow2 itself (xo-server
      // 5.201.0 and on, which the policy job requires), so nothing on this
      // machine unpacks or converts it, and a third of a gigabyte crosses
      // the network where a 3 GiB raw disk did.
      type: 'qcow2',
      name: VM_IMAGE.buildName,
      description: `${os} (${spec.build}), becoming Fleetwright's machine image`,
    });
    vdi = await upload({
      address,
      pin,
      plain,
      sendTo: $sendTo,
      body: createReadStream(file),
      size: spec.compressedSize,
      filename: `${spec.key}.qcow2`,
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
    await admin.call('vm.createCloudInitConfigDrive', { vm, sr: sr.id, config: buildCloudConfig({ coordinatorUrl }) });
    signal?.throwIfAborted();
    await admin.call('vm.start', { id: vm });

    const started = now();
    /** @type {number|null} */
    let firstStart = null;
    for (;;) {
      signal?.throwIfAborted();
      await sleep(pollMs);
      signal?.throwIfAborted();
      const seen = /** @type {any} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { id: vm } })) || {})[0]);
      if (!seen) throw new Error('the machine image’s build VM disappeared from Xen Orchestra while it was installing');
      if (seen.power_state === 'Halted') break;
      if (seen.power_state === 'Running') {
        const at = Number(seen.startTime) || null;
        if (firstStart === null) firstStart = at;
        else if (at !== null && at !== firstStart) {
          // REBOOTED: the install said it failed (see the top of this file).
          keep = true;
          await admin.call('vm.stop', { id: vm, force: true }).catch(() => {});
          await admin.call('vm.set', { id: vm, name_label: `${VM_IMAGE.buildName} (install failed)` }).catch(() => {});
          throw new Error(
            'Fleetwright did not install on the machine image. Its build VM was kept, stopped, as ' +
            `"${VM_IMAGE.buildName} (install failed)": start it and read /var/log/fleetwright-image.log in its console. ` +
            'Applying again removes it and starts over',
          );
        }
      }
      const elapsed = now() - started;
      if (elapsed > VM_IMAGE.installMs) {
        throw new Error(`the install on the machine image did not finish within ${Math.round(VM_IMAGE.installMs / 60_000)} minutes, so the build was given up`);
      }
      say(`Installing Fleetwright on the machine image: ${Math.max(1, Math.round(elapsed / 60_000))} min so far, usually about ${Math.round(VM_IMAGE.installTypicalMs / 60_000)}.`, stage(3, installFill(elapsed)));
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
  return (
    `The machine image is ready on ${poolName}: ${spec.name}, ${os} with Fleetwright installed, its disk on ${on}. ` +
    'Start a session on a new machine from it under New session › Where.'
  );
}
