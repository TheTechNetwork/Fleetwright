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
// goes (qcow2.js, Node's own zlib, nothing to install), and keeps that disk
// on the pool as it was published (baseOf, below), so a rebuild starts from a
// copy of it and sends nothing. Then it grows a copy of the disk to the size
// a session needs, and boots a VM from it on the uplink, behind the
// edge router, with a cloud-init that installs Fleetwright from this fleet's
// own /install without a pin, wipes everything that would make two clones
// the same machine (the machine id, SSH host keys, any host key), cleans
// cloud-init so each clone runs its own, and powers off. Then the VM becomes
// the template, tagged so the fleet's boxes find it, written into the list
// of what the policy job made (xo-made.js), which is what makes it the
// fleet's image rather than its tag, and put in the resource set so the
// limited user can clone it.
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

import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import { gzipSync } from 'node:zlib';

import { builtInTemplate, fetchPinned, uploadDisk, srName } from './edge-router.js';
import { qcow2Raw, qcow2Size } from './qcow2.js';
import { forgetMade, outsideSets, recordMade, setsOf } from './xo-made.js';
import { IMAGE_REPORT_TOKEN_RE } from '../protocol/intents.js';

/**
 * Debian 13's cloud image, pinned. KEPT CURRENT BY RENOVATE IN TWO HALVES:
 * Renovate moves each image's `build` from its vendor's directory listing
 * (renovate.json, customDatasources), and `node scripts/pin-images.mjs`
 * writes the address, digest and sizes that build has, once it has soaked
 * three days. Until it has run the build and the address disagree, and
 * test/pin-images.test.js fails naming the command.
 */
export const DEBIAN_IMAGE = Object.freeze({
  key: 'debian-13',
  os: 'Debian 13',
  name: 'Fleetwright Debian 13',
  format: 'qcow2',
  label: 'Debian',
  algorithm: /** @type {'sha512'} */ ('sha512'),
  release: '13',
  // renovate: datasource=custom.debian-cloud depName=trixie
  build: '20261015-2632',
  url: 'https://cloud.debian.org/images/cloud/trixie/20261015-2632/debian-13-genericcloud-amd64-20261015-2632.qcow2',
  /** As published in that build's SHA512SUMS, and as downloaded. */
  sha512: '7f1d06b629fa01241ec5817735777d0554554ff8c8d9dc27f9eac65ba3c3a6f859deb6079ebc9c65795d1955abd00a77aa3ff9cb84ae6307dfbbd8b2e398dab2',
  compressedSize: 341180416,
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
  // renovate: datasource=custom.ubuntu-cloud depName=noble
  build: 'release-20261017',
  url: 'https://cloud-images.ubuntu.com/releases/noble/release-20261017/ubuntu-24.04-server-cloudimg-amd64.img',
  /** As published in that release's SHA256SUMS, and as downloaded. */
  sha256: '04e8f2461a16a44e78a370284471f29616cdd9baf1893df25807b71f985b6c94',
  compressedSize: 621284352,
  rawSize: 3758096384,
});

export const UBUNTU_2604_IMAGE = Object.freeze({
  key: 'ubuntu-26.04',
  os: 'Ubuntu 26.04 LTS',
  name: 'Fleetwright Ubuntu 26.04',
  format: 'qcow2',
  label: 'Ubuntu',
  algorithm: /** @type {'sha256'} */ ('sha256'),
  // renovate: datasource=custom.ubuntu-cloud depName=resolute
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
 * Which apt suite an image installs Fleetwright from, and so which one every
 * machine cloned from it updates along: `stable`, published releases once their
 * rollout is complete, or `rolling`, the newest build of main (apt-repo.yml).
 * Chosen on the pool's policy, per build; docs/hypervisors.md, "Built from main".
 */
export const IMAGE_CHANNELS = Object.freeze(['stable', 'rolling']);

/** The tag saying which suite a template was built from. @param {string} channel */
export const channelTag = (channel) => `fleetwright-channel:${channel}`;

/**
 * Which suite a template was built from: by its tag, or `stable` for an image
 * built before there was a choice, which is the only suite there was.
 *
 * @param {any} t @returns {'stable'|'rolling'}
 */
export function imageChannelOf(t) {
  const tags = Array.isArray(t?.tags) ? t.tags : [];
  return tags.includes(channelTag('rolling')) ? 'rolling' : 'stable';
}

/** How a person reads a suite, in a sentence about an image. @param {string} channel */
const builtFrom = (channel) => (channel === 'rolling' ? 'the newest build of main' : 'released versions');

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

/**
 * WHETHER A TEMPLATE IS THE FLEET'S MACHINE IMAGE, which its tag alone does
 * not say: `fleetwright-image` is a string anybody who can make a template can
 * give it, and every template so tagged on any pool used to be written into
 * the fleet's resource set, where every approved box's token clones it, and
 * left alone as the image by the next build. Now it is the fleet's only when
 * an admin put it there: on the list of what the policy job made, or already
 * in the fleet's resource set, both of which only an admin of Xen Orchestra
 * can write (xo-made.js); and made in no resource set, so not by the fleet's
 * own user, whatever list it is on. Nothing puts a template in the fleet's set
 * now that is not on the list, so an image in it was put there by a job. The
 * one that remains open: a version from before the list put every tagged
 * template in the set, and one planted then, by somebody at the pool's admin
 * or above, cannot be told from an image a job built then.
 *
 * @param {any} t  a VM-template as xo.getAllObjects gave it
 * @param {{ fleet: Set<string>, made: Set<string> }} sets  as xo-made.js reads them
 */
export function isFleetImage(t, sets) {
  const id = String(t?.id);
  return (sets.made.has(id) || sets.fleet.has(id)) && outsideSets(t);
}

/** Names and sizes in Xen Orchestra. */
/**
 * XCP-ng's guest agent, pinned like the images: what tells Xen Orchestra a
 * VM's addresses and that it has booted. Upstream's own release build (the
 * 0.4.0 release's "Linux x86 64bit executable"), which needs glibc 2.28 at
 * most, so it runs on every image here.
 *
 * WHY IT IS CARRIED AND NOT INSTALLED. Debian has no package for any Xen
 * guest agent, so `apt-get install xe-guest-utilities || true` installed
 * nothing on Debian and every Debian clone showed no address in Xen
 * Orchestra; and apt needs the network, so a build VM whose network was the
 * problem never had one either. Now the box downloads it, checks it, and
 * writes it into the cloud-init drive, and the build VM starts it before
 * anything needs a network. It stays in the image, so every clone has it.
 *
 * AGPL-3.0, unmodified, fetched from upstream by the person's own box onto
 * their own VM; this repository carries only its address and digest. Its
 * address is a CI artifact of the release job: if it ever goes, the build
 * goes on without it and says so.
 *
 * KEPT CURRENT BY RENOVATE, in two halves. Renovate reads `release` (the
 * annotation, matched by the custom manager in renovate.json) and proposes
 * the next GitLab release. It cannot follow the file: the address is a job
 * number, not the version, and upstream publishes no digest. So `file` is
 * written only by `node scripts/pin-guest-agent.mjs`, which reads that
 * release's own asset link, downloads it, checks it is an x86-64 ELF that
 * needs no newer glibc than the oldest image here, and pins its size and
 * SHA-256. Until it has run, the two disagree: test/xo-pools.test.js fails
 * on the pull request, naming the command, and a box given the mismatch
 * refuses the file and builds without it rather than trust an old digest
 * for a new name.
 */
export const GUEST_AGENT = Object.freeze({
  // renovate: datasource=gitlab-releases depName=xen-project/xen-guest-agent
  release: '0.4.0',
  /** The release's "Linux x86 64bit" asset, as scripts/pin-guest-agent.mjs pinned it. */
  file: Object.freeze({
    release: '0.4.0',
    url: 'https://gitlab.com/xen-project/xen-guest-agent/-/jobs/6041686346/artifacts/raw/target/release/xen-guest-agent',
    size: 6644528,
    sha256: 'aa2e1dca26594f7de4377f5a74999329fa51b10235b78ee8fbf4a814f654b3a3',
  }),
});

/**
 * Upstream's unit for it (startup/xen-guest-agent.service at 0.4.0), as
 * written there. scripts/pin-guest-agent.mjs refuses a release whose unit
 * is not this one.
 */
export const GUEST_AGENT_UNIT = [
  '[Unit]',
  'Description=Xen guest agent',
  'Conflicts=xe-linux-distribution.service',
  '',
  '[Service]',
  'ExecStart=/usr/sbin/xen-guest-agent',
  'Restart=on-failure',
  '',
  '[Install]',
  'WantedBy=multi-user.target',
];

export const VM_IMAGE = Object.freeze({
  /** On the template, which is how a box holding a pool's token finds it. */
  tag: 'fleetwright-image',
  name: 'Fleetwright Debian 13',
  /** On the VM while it is being built, so a build left by an earlier try is found and removed. */
  buildTag: 'fleetwright-image-build',
  buildName: 'fleetwright-image-build',
  /**
   * On a base disk's template (baseOf, below), and as
   * `fleetwright-base:<image key>:<build>` beside it, saying which pinned
   * download it holds.
   */
  baseTag: 'fleetwright-base',
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
 * How a machine cloned from the image runs its join script, as root, once,
 * on its first boot (install/fleetwright-vm-join): the cloud-init line both
 * kinds of machine carry (xo-pools.js, xo-holder.js).
 *
 * ROOT'S COPY, in /usr/local/sbin, which the installer puts there from the
 * package's own extract. It ran the one in `current`, and the installer
 * gives `current` to the run user on the image as on every box. On a clone
 * nothing has run as that account by cloud-init's last stage except the
 * machine's owner, who has sudo there, so the copy in `current` was still
 * what apt laid out; but that rests on the order of a boot, and root running
 * a file another account owns is the thing docs/security.md's G10 closes
 * everywhere else.
 *
 * AN IMAGE BUILT BEFORE THAT COPY EXISTED has only `current`'s, and keeps
 * using it — under exactly the ordering argument above — rather than a clone
 * that cannot join.
 */
export const JOIN_RUNCMD = `  - [sh, -c, 'j=/usr/local/sbin/fleetwright-vm-join; [ -x "$j" ] || j=/opt/fleetwright/current/install/fleetwright-vm-join; exec "$j" "$0"', /run/fleetwright/join.json]`;

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
 * A REPORT STILL GETS OUT WHEN NAMES DO NOT. The box looks up the
 * coordinator's addresses as it writes this (`addresses`), and a report curl
 * could not send by name is sent again to those, under the same name, so
 * TLS still checks the coordinator's own certificate. Asked for after a real
 * build VM had an address and a route and could not look up a single name:
 * it said so on its screen and nowhere the phone could see.
 *
 * AND THE GUEST AGENT, when the box has it (`agent`, GUEST_AGENT gzipped and
 * in base64): written by cloud-init and started first, so Xen Orchestra
 * shows the build VM's address whatever its network does.
 *
 * AND FROM WHICH SUITE, `channel`: one of IMAGE_CHANNELS, checked before it is
 * written into the apt line, which every clone keeps.
 *
 * @param {{ coordinatorUrl: string, token?: string|null, addresses?: string[], agent?: string|null, channel?: string }} opts
 */
export function buildCloudConfig({ coordinatorUrl, token = null, addresses = [], agent = null, channel = 'stable' }) {
  const url = new URL(coordinatorUrl);
  const origin = url.origin;
  if (!IMAGE_CHANNELS.includes(channel)) throw new Error('that is not a suite an image is built from');
  if (token !== null && !IMAGE_REPORT_TOKEN_RE.test(token)) throw new Error('that is not a report token');
  if (agent !== null && !/^[A-Za-z0-9+/]+=*$/.test(agent)) throw new Error('that is not the guest agent');
  // Addresses as the box's own resolver gave them, and nothing else: each is
  // checked to be one before it is written into a shell script.
  const pinned = [...new Set(addresses.filter((a) => isIPv4(a)))].slice(0, 4);
  const port = url.port || (url.protocol === 'http:' ? '80' : '443');
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
    `pinned='${pinned.length ? `${url.hostname}:${port}:${pinned.join(',')}` : ''}'`,
    // THE BODY BY PYTHON, which has JSON and is there before anything is
    // installed; SENT BY CURL once there is one, with a user agent of its
    // own. curl is what fetched /install through the same front door, and a
    // stock Python-urllib agent is the kind a CDN's bot check turns away.
    'report() {',
    '  [ -n "$token" ] || return 0',
    "  body=$(python3 -c '",
    'import json, sys',
    'body = {"token": sys.argv[1], "step": sys.argv[2]}',
    'if sys.argv[2] == "image":',
    '    body["got"] = int(sys.argv[4] or 0)',
    '    if sys.argv[5:] and sys.argv[5]:',
    '        body["of"] = int(sys.argv[5])',
    'if sys.argv[2] == "failed":',
    '    try:',
    '        body["detail"] = open(sys.argv[3], errors="replace").read()[-2000:]',
    '    except OSError:',
    '        pass',
    'print(json.dumps(body))',
    `' "$token" "$1" "$log" "\${2-}" "\${3-}" 2>/dev/null) || return 0`,
    '  if command -v curl >/dev/null 2>&1; then',
    `    curl -fsS -m 10 -A fleetwright-image -H 'content-type: application/json' --data-binary "$body" "$origin/api/xosetup/report" >/dev/null 2>&1 ||`,
    `      { [ -n "$pinned" ] && curl -fsS -m 10 -A fleetwright-image --resolve "$pinned" -H 'content-type: application/json' --data-binary "$body" "$origin/api/xosetup/report" >/dev/null 2>&1; } || true`,
    '  else',
    "    python3 -c '",
    'import sys, urllib.request',
    'req = urllib.request.Request(sys.argv[1] + "/api/xosetup/report", sys.argv[2].encode(), {"content-type": "application/json", "user-agent": "fleetwright-image"})',
    'urllib.request.urlopen(req, timeout=10).read()',
    `' "$origin" "$body" >/dev/null 2>&1 || true`,
    '  fi',
    '}',
    // THE SESSION IMAGE'S PULL, WATCHED FROM BESIDE IT. The installer pulls
    // it inside `apt-get install fleetwright` (install.sh, 5b), and it is
    // most of a build: one step said nothing for ten minutes and the phone's
    // bar moved by the clock. This finds the `podman pull` among the VM's
    // processes, asks the image's registry how big it is, and reports the
    // bytes the VM has received since, every 15 seconds, until the pull is
    // gone. Counted off the network, so nothing in the installer changes.
    'procs=/proc',
    'nets=/sys/class/net',
    'every=15',
    'received() {',
    '  local n=0 f',
    '  for f in "$nets"/*/statistics/rx_bytes; do',
    '    [ "$f" = "$nets/lo/statistics/rx_bytes" ] && continue',
    '    n=$(( n + $(cat "$f" 2>/dev/null || echo 0) ))',
    '  done',
    '  echo "$n"',
    '}',
    // The size the registry gives: the config and every layer of the
    // manifest for this machine's architecture, as podman will fetch them.
    // Anonymous, as the pull is; nothing printed when it cannot tell.
    'image_size() {',
    "  python3 - \"$1\" <<'PY'",
    'import json, platform, re, sys, urllib.parse, urllib.request, urllib.error',
    'host, _, rest = sys.argv[1].partition("/")',
    'if "@" in rest:',
    '    name, want = rest.split("@", 1)',
    'elif ":" in rest.rsplit("/", 1)[-1]:',
    '    name, want = rest.rsplit(":", 1)',
    'else:',
    '    name, want = rest, "latest"',
    'kinds = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"]',
    'token = None',
    'def get(ref):',
    '    global token',
    '    while True:',
    '        h = {"Accept": ", ".join(kinds), "User-Agent": "fleetwright-image"}',
    '        if token:',
    '            h["Authorization"] = "Bearer " + token',
    '        try:',
    '            return json.load(urllib.request.urlopen(urllib.request.Request("https://%s/v2/%s/manifests/%s" % (host, name, ref), headers=h), timeout=10))',
    '        except urllib.error.HTTPError as e:',
    '            ask = e.headers.get("WWW-Authenticate", "")',
    '            if e.code != 401 or token is not None or not ask.startswith("Bearer "):',
    '                raise',
    '            f = dict(re.findall(r\'(\\w+)="([^"]*)"\', ask))',
    '            q = urllib.parse.urlencode({k: f[k] for k in ("service", "scope") if k in f})',
    '            t = json.load(urllib.request.urlopen(f["realm"] + "?" + q, timeout=10))',
    '            token = t.get("token") or t.get("access_token") or ""',
    'm = get(want)',
    'if "manifests" in m:',
    '    arch = {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine(), platform.machine())',
    '    m = get(next(x["digest"] for x in m["manifests"] if x.get("platform", {}).get("architecture") == arch and x.get("platform", {}).get("os", "linux") == "linux"))',
    'print(m["config"]["size"] + sum(l["size"] for l in m["layers"]))',
    'PY',
    '}',
    'watch_pull() {',
    '  set +e',
    '  local f c image= pid= base= of= last=0',
    '  while sleep 3; do',
    '    if [ -z "$pid" ]; then',
    '      for f in "$procs"/[0-9]*/cmdline; do',
    "        c=$(tr '\\0' ' ' <\"$f\" 2>/dev/null) || continue",
    '        case "$c" in "podman pull "*) read -r _ _ image _ <<<"$c"; pid=${f%/cmdline}; break ;; esac',
    '      done',
    '      [ -n "$pid" ] || continue',
    '      base=$(received)',
    '      of=$(image_size "$image" 2>/dev/null)',
    '      [[ "$of" =~ ^[0-9]+$ ]] || of=',
    '      report image 0 "$of"',
    '      last=$SECONDS',
    '    elif [ ! -e "$pid" ]; then',
    '      report image $(( $(received) - base )) "$of"',
    '      return 0',
    '    elif (( SECONDS - last >= every )); then',
    '      report image $(( $(received) - base )) "$of"',
    '      last=$SECONDS',
    '    fi',
    '  done',
    '}',
    'steps() {',
    '  set -eo pipefail',
    '  export DEBIAN_FRONTEND=noninteractive',
    // WHETHER IT HAS A NETWORK, first, on the screen: an address, a route,
    // and a name looked up. A VM that never reports in is most often this.
    '  echo "fleetwright: building the machine image"',
    '  ip -4 -br addr || true',
    '  ip -4 route || true',
    // A NAME, GIVEN HALF A MINUTE. The first real run looked once, in the
    // VM's first second, and said it had no DNS while its resolver may not
    // yet have been told the server DHCP named. Every step after this needs
    // names, so without them it stops here, saying which server it asked.
    '  named=',
    '  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do',
    '    if getent hosts deb.debian.org; then named=1; break; fi',
    '    sleep 2',
    '  done',
    '  if [ -z "$named" ]; then',
    '    echo "fleetwright: cannot look up deb.debian.org after 30 seconds, so this VM has no working DNS. The servers it was told to ask:"',
    "    resolvectl dns 2>/dev/null || grep '^nameserver' /etc/resolv.conf || echo '(none)'",
    // AND WHO ANSWERS WHEN ASKED STRAIGHT: each server it was told, its
    // gateway and whichever router gave it its lease, by a DNS query of its
    // own, with the address the answer came back from. Asked for after a
    // build behind two edge routers was told 10.254.0.1 and heard nothing:
    // whether the routers answer at all, only at their own addresses, or
    // from the wrong one, is the difference between three fixes. Then whose
    // MAC the shared address resolves to.
    '    echo "fleetwright: asked straight for deb.debian.org:"',
    "    gw=$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}') || true",
    "    lease=$(cat /run/systemd/netif/leases/* /var/lib/dhcp/*.leases 2>/dev/null | grep -oE '(SERVER_ADDRESS=|dhcp-server-identifier )[0-9.]+' | grep -oE '[0-9.]+$' | head -1) || true",
    "    for s in $( { resolvectl dns 2>/dev/null; grep '^nameserver' /etc/resolv.conf 2>/dev/null; echo \"$gw $lease\"; } | grep -oE '([0-9]{1,3}[.]){3}[0-9]{1,3}' | grep -v '^127[.]' | sort -u ); do",
    "      python3 -c '",
    'import socket, struct, sys',
    'q = struct.pack(">6H", 0x1234, 0x0100, 1, 0, 0, 0) + b"".join(bytes([len(p)]) + p.encode() for p in "deb.debian.org".split(".")) + b"\\0" + struct.pack(">2H", 1, 1)',
    's = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)',
    's.settimeout(3)',
    'try:',
    '    s.sendto(q, (sys.argv[1], 53))',
    '    r, a = s.recvfrom(512)',
    '    print("  " + sys.argv[1] + ": answered from " + a[0] + ", " + str(struct.unpack(">H", r[6:8])[0]) + " records, rcode " + str(r[3] & 15))',
    'except OSError as e:',
    '    print("  " + sys.argv[1] + ": no answer (" + (str(e) or type(e).__name__) + ")")',
    "' \"$s\" || true",
    '    done',
    '    ip neigh show 2>/dev/null || true',
    '    exit 1',
    '  fi',
    '  report packages',
    '  apt-get update',
    '  apt-get install -y curl ca-certificates openssh-server',
    // The packaged agent only where the box could not bring GUEST_AGENT:
    // Ubuntu has one, Debian has none, and the two must not both run.
    '  [ -x /usr/sbin/xen-guest-agent ] || apt-get install -y xe-guest-utilities || true',
    // What a clone fences itself with on the uplink and finds the others in
    // its group by (install/fleetwright-net). A clone installs them itself
    // when they are missing, at the cost of a minute.
    '  apt-get install -y nftables avahi-daemon libnss-mdns || true',
    '  report installer',
    // FROM APT, AS ONE PACKAGE. The installer needs the node package.json
    // names and refuses an older one; the distributions' own are older
    // (Debian 13 ships 20), so a build that ran it straight away stopped with
    // "too old". The package carries Node's own build in /usr/lib/fleetwright,
    // so nothing else is needed, and its postinst is the installer with no
    // fleet named: laid out, units written, left stopped for the clone to
    // join (docs/packaging.md, "Joining a fleet under apt"). Signed, and the
    // run user preseeded, which is the one question it would otherwise guess.
    // The suite is the one the policy chose, and the line stays on every clone,
    // so a machine made from a rolling image updates along rolling.
    "  curl -fsSL https://fleet-apt.thetech.network/fleetwright.gpg -o /usr/share/keyrings/fleetwright.gpg",
    `  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/fleetwright.gpg] https://fleet-apt.thetech.network ${channel} main" >/etc/apt/sources.list.d/fleetwright.list`,
    // A here-string and not a pipe: under pipefail an echo into a reader that
    // has already exited fails the step for nothing.
    `  debconf-set-selections <<<'fleetwright fleetwright/user string ${RUN_USER}'`,
    '  apt-get update',
    // Stopped however this step ends: a pull it outlives is no pull at all.
    '  watch_pull &',
    '  watcher=$!',
    `  trap 'kill "$watcher" 2>/dev/null || true' EXIT`,
    '  apt-get install -y fleetwright',
    '  kill "$watcher" 2>/dev/null || true',
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
    // FIRST, so Xen Orchestra has its address before anything can fail.
    '[ -x /usr/sbin/xen-guest-agent ] && systemctl enable --now xen-guest-agent.service',
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
    ...(agent
      ? [
          '  - path: /usr/sbin/xen-guest-agent',
          "    permissions: '0755'",
          '    encoding: gz+b64',
          `    content: ${agent}`,
          '  - path: /etc/systemd/system/xen-guest-agent.service',
          "    permissions: '0644'",
          '    content: |',
          ...GUEST_AGENT_UNIT.map((l) => (l ? `      ${l}` : '')),
        ]
      : []),
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
/**
 * The same, when the disk is a copy of one kept from an earlier build: that
 * takes seconds, and at 450 a rebuild opened at 45% and spent its whole
 * install, nearly all of its time, in the half of the bar that was left.
 */
const KEPT_SHARE = 50;
const INSTALLED = 970;
/** The qcow2 downloaded, then the raw disk written. @param {number} downloaded @param {number} written @param {any} [spec] */
export function imageFill(downloaded, written, spec = DEBIAN_IMAGE) {
  const bytes = spec.compressedSize + spec.rawSize;
  return Math.min(BYTES_SHARE, Math.floor((BYTES_SHARE * (Math.min(downloaded, spec.compressedSize) + Math.min(written, spec.rawSize))) / bytes));
}

/**
 * Where each step the build VM reports puts the install's share of the bar:
 * at least the first number, and time moves it no further than the second.
 * The session image's pull is most of it, and `image` is moved by its bytes
 * when the VM could say how many there are to come.
 */
const STEP_SHARE = Object.freeze({
  started: [0.05, 0.1], packages: [0.1, 0.2], installer: [0.2, 0.3], image: [0.3, 0.9], cleaning: [0.9, 0.95], done: [0.95, 0.95], failed: [0, 0.95],
});

/**
 * How far through the install: by the step the build VM last reported when
 * it has said one, and by time against what it usually takes when it has
 * not; within the pull, by its bytes, when it said how many. Never quite
 * done; the VM powering off is done. `head` is what the disk took of the bar.
 *
 * @param {number} elapsed @param {string|null} [step] @param {number|null} [part]  0 to 1 of the pull
 * @param {number} [head]
 */
export function installFill(elapsed, step = null, part = null, head = BYTES_SHARE) {
  const [least, most] = step && Object.hasOwn(STEP_SHARE, step) ? STEP_SHARE[/** @type {keyof typeof STEP_SHARE} */ (step)] : [0, 0.95];
  const share = part === null
    ? Math.min(most, Math.max(least, elapsed / VM_IMAGE.installTypicalMs))
    : least + (most - least) * Math.min(1, Math.max(0, part));
  return head + Math.floor((INSTALLED - head) * share);
}

/** What the phone says the build VM is doing, for each step it reports. */
const STEP_WORDS = Object.freeze({
  started: 'its VM is up and has started the install',
  packages: 'installing Debian’s packages',
  installer: 'installing Fleetwright',
  image: 'fetching the session image',
  cleaning: 'clearing what would make two machines cloned from it the same',
  done: 'the install is done and its VM is powering off',
  failed: 'the install failed',
});

/**
 * How much of the session image is in, 0 to 1, when the build VM is pulling
 * it and said how big it is; null otherwise. A count a little past the size
 * is the network's own overhead, and is all of it.
 *
 * @param {{ step: string, got?: number, of?: number }|null} report
 */
function pullPart(report) {
  return report?.step === 'image' && Number.isFinite(report.got) && Number(report.of) > 0 ? Math.min(1, Number(report.got) / Number(report.of)) : null;
}

/**
 * The pull's bytes, for the phone's sentence: so many of so many, then that
 * they are in and being unpacked, which rootless podman does layer by layer
 * after it has them and which is not counted anywhere. Nothing before the
 * VM has said a number.
 *
 * @param {{ step: string, got?: number, of?: number }|null} report
 */
function pulled(report) {
  if (report?.step !== 'image' || !Number.isFinite(report.got)) return '';
  const got = Number(report.got);
  const part = pullPart(report);
  if (part === null) return got > 0 ? `: ${mb(got)} MB received` : '';
  return part >= 0.98 ? `: all ${mb(Number(report.of))} MB are in and being unpacked` : `: ${mb(got)} of ${mb(Number(report.of))} MB`;
}

/** How long a build VM with a token may say nothing before the phone says so. */
const SILENT_MS = 5 * 60_000;

/** The last few lines of a log, for a sentence on a phone. @param {string|null|undefined} log */
// Enough for the DNS probe above, its servers and who answered ARP; and still
// within what a sealed push carries.
const logEnd = (log) => String(log || '').trim().split('\n').slice(-12).join('\n').slice(-1000);

/**
 * THE BASE DISK: the pinned cloud image's disk as it was published, kept on
 * the pool as a template that has never booted, so a rebuild starts from a
 * copy of it instead of downloading it here and sending it through Xen
 * Orchestra again.
 *
 * ASKED FOR: "Rebuilding machines why don’t we have cached copies?" The
 * download was already kept, on the one box that ran the policy; what every
 * build did again was write the whole disk (3 to 3.5 GiB) from that box,
 * through Xen Orchestra, to the pool's storage, which on NFS is that much
 * across the network once more. A VM made from a template with a disk is a
 * clone of that disk, copy-on-write on the storage XCP-ng keeps as VHD files
 * (NFS, ext, LVM): seconds, and what sessions' machines are already made by.
 *
 * One per image, build and storage: a clone is fast only on the storage the
 * template's disk is on, so a build asked onto other storage makes a base
 * there. Tagged `fleetwright-base` and not `fleetwright-image`, so no box
 * offers it, and kept out of the resource set, so the fleet's token cannot
 * clone it.
 *
 * FOUND BY ITS ID, as the edge router's is and for the same reason
 * (edge-router.js, THE KEPT DISK): a base skips the download and its digest,
 * so a template carrying the tag is not enough. Only one whose id is on the
 * list of what the policy job made (xo-made.js), that is not in the fleet's
 * resource set and was made in no set, is used; otherwise the image is
 * downloaded and checked as if nothing were kept. Only listed bases are
 * removed when a newer build is kept.
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin
 * @param {any[]} templates  every VM-template, as xo.getAllObjects gave them
 * @param {string} pool @param {string} tag  `${VM_IMAGE.baseTag}:<key>:<build>` @param {string} sr
 * @param {{ fleet: Set<string>, made: Set<string> }} sets  as xo-made.js reads them
 * @returns {Promise<any|null>}
 */
async function baseOf(admin, templates, pool, tag, sr, sets) {
  for (const t of templates.filter((x) => x?.$pool === pool && x?.tags?.includes?.(tag) && baseByUs(x, sets))) {
    const disks = await disksOf(admin, t.id);
    if (disks.length === 1 && disks[0].$SR === sr) return t;
  }
  return null;
}

/**
 * A base the policy job made (baseOf, FOUND BY ITS ID).
 *
 * @param {any} t @param {{ fleet: Set<string>, made: Set<string> }} sets
 */
const baseByUs = (t, sets) => sets.made.has(String(t?.id)) && !sets.fleet.has(String(t?.id)) && outsideSets(t);

/**
 * A VM's or template's disks: every one that is not a CD drive or a
 * cloud-init drive. All of them, as the edge router's are (edge-router.js,
 * disksOf): the first of two is a guess at which one boots.
 *
 * @param {{ call: (method: string, params?: any) => Promise<any> }} admin @param {string} vm
 * @returns {Promise<any[]>}
 */
async function disksOf(admin, vm) {
  const vbds = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VBD', VM: vm } })) || {}));
  const disks = [];
  for (const vbd of vbds) {
    if (!vbd?.VDI || vbd.is_cd_drive) continue;
    const vdi = /** @type {any} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VDI', id: vbd.VDI } })) || {})[0]);
    if (vdi && vdi.name_label !== CONFIG_DRIVE_NAME) disks.push(vdi);
  }
  return disks;
}

/**
 * The bases kept for `key`: every build's, on every storage. An older build's
 * is removed once a newer one is made, and all of them with the image itself
 * (removeImage). Removing one never touches a machine image or a session's
 * machine made from it: XCP-ng keeps a clone's parent on disk while anything
 * still reads from it.
 *
 * @param {any[]} templates @param {string} pool @param {string} key
 */
const basesFor = (templates, pool, key) =>
  templates.filter((t) => t?.$pool === pool && (t?.tags || []).some((/** @type {string} */ x) => x.startsWith(`${VM_IMAGE.baseTag}:${key}:`)));

/**
 * The coordinator's IPv4 addresses as this box's resolver has them, for a
 * build VM whose own names do not work (buildCloudConfig). None, rather than
 * an error, when they cannot be had: the VM then reports by name alone.
 *
 * @param {string} host @returns {Promise<string[]>}
 */
async function addressesFor(host) {
  try {
    /** @type {Promise<Array<{ address: string }>>} */
    const late = new Promise((resolve) => setTimeout(() => resolve([]), 5_000).unref());
    const found = await Promise.race([lookup(host, { all: true, family: 4 }), late]);
    return found.map((a) => a.address);
  } catch {
    return [];
  }
}

/**
 * GUEST_AGENT, downloaded once into the state directory and checked against
 * its digest on every use (fetchPinned).
 *
 * @param {string} imageDir @param {AbortSignal} [signal] @returns {Promise<Buffer>}
 */
async function fetchAgent(imageDir, signal) {
  const { release, file: pin } = GUEST_AGENT;
  if (pin.release !== release) throw new Error(`the pinned file is ${pin.release}'s, not ${release}'s, so it was not used`);
  const file = await fetchPinned({ dir: imageDir, url: pin.url, size: pin.size, algorithm: 'sha256', digest: pin.sha256, label: 'Xen guest agent', signal });
  return readFileSync(file);
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
 *   say: (text: string, part?: import('./edge-router.js').BuildPart) => void,
 *   signal?: AbortSignal,
 *   image?: string,
 *   resize?: 'disk.resize'|'vdi.set',
 *   getImage?: typeof fetchPinned,
 *   upload?: typeof uploadDisk,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   pollMs?: number,
 *   reporter?: (() => Promise<string|null>)|null,
 *   addressesOf?: (host: string) => Promise<string[]>,
 *   getAgent?: (imageDir: string, signal?: AbortSignal) => Promise<Buffer>,
 *   vmReport?: () => ({ step: string, detail: string|null, got?: number, of?: number, at: number }|null),
 *   replace?: boolean,
 *   channel?: string|null,
 * }} opts
 */
export async function ensureImage({
  admin, pool, poolName = 'this pool', uplink, setId, srs, fleetSrs, sr: chosenSr = null, address, pin, plain, imageDir, coordinatorUrl, say, signal,
  image: key = DEBIAN_IMAGE.key,
  resize = 'disk.resize',
  getImage = fetchPinned, upload = uploadDisk, now = () => Date.now(), sleep = sleepFor, pollMs = 10_000,
  reporter = null, vmReport = () => null, addressesOf = addressesFor, getAgent = fetchAgent,
  replace = false,
  channel: asked = null,
}) {
  const spec = IMAGES[key];
  if (!spec) throw new Error(`there is no machine image called ${key}. Nothing was built`);
  if (asked !== null && !IMAGE_CHANNELS.includes(asked)) throw new Error(`${asked} is not a suite an image is built from. Nothing was built`);
  const templates = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM-template' } })) || {}));
  // THE FLEET'S IMAGE, by the lists and not by its tag (isFleetImage): one
  // that only carries the tag is neither left as the image nor retired.
  const sets = await setsOf(admin);
  const there = templates.find((t) => t?.$pool === pool && t?.tags?.includes?.(VM_IMAGE.tag) && imageKeyOf(t) === key && isFleetImage(t, sets));
  // REBUILT WHEN ASKED: the new one is built beside it and the one there is
  // retired only once the new one is a template, so a build that fails or is
  // cancelled leaves the pool with the image it had (retireImage below).
  if (there && !replace) {
    // IN THE SET, whatever else: an image the job made and listed, taken out
    // of the set in Xen Orchestra, is one the fleet can see and not use.
    if (!sets.fleet.has(String(there.id))) await admin.call('resourceSet.addObject', { id: setId, object: there.id }).catch(() => {});
    // KEPT AS IT WAS BUILT, and said so when that is not what was asked: the
    // suite is chosen per build, and changing the choice changes nothing until
    // the image is rebuilt.
    const was = imageChannelOf(there);
    return `The ${spec.os} machine image was already there on ${poolName}: ${String(there.name_label || spec.name)}.` +
      (asked !== null && asked !== was ? ` It was built from ${builtFrom(was)}; rebuild it to build it from ${builtFrom(asked)}.` : '');
  }
  // NOT SAID IS AS BEFORE: a rebuild keeps the suite the image was built from,
  // and a new image is built from released versions, which is all a policy
  // from before the choice can have meant.
  const channel = asked ?? (there ? imageChannelOf(there) : 'stable');

  // A BUILD AN EARLIER TRY LEFT, failed or cut off, is removed first so two
  // never exist at once.
  const vms = /** @type {any[]} */ (Object.values((await admin.call('xo.getAllObjects', { filter: { type: 'VM' } })) || {}));
  for (const old of vms.filter((v) => v?.$pool === pool && v?.tags?.includes?.(VM_IMAGE.buildTag))) {
    if (old.power_state === 'Running') await admin.call('vm.stop', { id: old.id, force: true }).catch(() => {});
    await admin.call('vm.delete', { id: old.id, deleteDisks: true }).catch(() => {});
  }

  const sr = imageStorage({ pool, srs, fleetSrs, sr: chosenSr });
  const on = srName(sr);
  // XCP-NG'S OWN, by its mark and not its name (edge-router.js, builtInTemplate).
  const base = builtInTemplate(templates, pool, VM_IMAGE.template, 'the machine image');

  const stage = (/** @type {number} */ n, /** @type {number} */ fill) => ({ stage: n, stages: IMAGE_STAGES, fill });
  const os = spec.os;
  const baseTag = `${VM_IMAGE.baseTag}:${spec.key}:${spec.build}`;
  /** @type {any} */
  let from = await baseOf(admin, templates, pool, baseTag, sr.id, sets);

  /** @type {string|null} */
  let vdi = null;
  /** @type {string|null} */
  let vm = null;
  /** @type {string|null} */
  let making = null;
  let keep = false;
  const head = from ? KEPT_SHARE : BYTES_SHARE;
  try {
    if (from) {
      say(`${os} is already on ${on}, kept from an earlier build, so the machine image starts from a copy of it.`, stage(2, KEPT_SHARE));
    } else {
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
          say(`Downloading ${os} for the machine image: ${mb(d)} of ${mb(t)} MB.`, { ...stage(1, imageFill(d, 0, spec)), doing: 'download', done: mb(d), total: mb(t) });
        },
      });
      signal?.throwIfAborted();
      if (!downloaded) say(`${os} was already downloaded and checked.`, stage(1, imageFill(spec.compressedSize, 0, spec)));

      // THE LENGTH SENT is the disk the qcow2's header holds: Content-Length goes
      // ahead of the bytes, and the download it is read from is the pinned one.
      const holds = await qcow2Size(file);
      say(`Writing ${os}’s disk to ${on}, where it is kept for the next build.`, stage(2, imageFill(spec.compressedSize, 0, spec)));
      const { $sendTo } = await admin.call('disk.import', {
        sr: sr.id,
        // RAW, EXPANDED HERE AS IT GOES. The pool cannot take the qcow2 as it
        // is published: XCP-ng's qcow-stream-tool refused it on a real pool
        // with Compressed_unsupported, and every distribution compresses its
        // clusters. A raw disk is what it takes, so qcow2.js reads the raw disk
        // out of the checked download into the upload, nothing written here.
        type: 'iso',
        name: `${os} (${spec.build})`,
        description: `${os}'s cloud image as published, kept by Fleetwright so a machine image is built from a copy of it`,
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
        // `keep`: this disk is the image as published, kept for the next build.
        onProgress: (d, t) => say(`Writing ${os}’s disk to ${on}: ${mb(d)} of ${mb(t)} MB.`, { ...stage(2, imageFill(spec.compressedSize, d, spec)), doing: 'keep', done: mb(d), total: mb(t) }),
      });
      signal?.throwIfAborted();

      // KEPT AS IT WAS PUBLISHED, never booted, so every build starts from the
      // same disk the digest vouched for (baseOf, above).
      making = await admin.call('vm.create', {
        template: base.id,
        name_label: `Fleetwright base: ${os} (${spec.build})`,
        name_description: `${os}'s cloud image as published, never booted. Fleetwright builds the machine image from a copy of it, so a rebuild sends nothing; it is not offered for sessions.`,
        VIFs: [],
        VDIs: [],
        CPUs: VM_IMAGE.cpus,
        memory: VM_IMAGE.memory,
        tags: [VM_IMAGE.baseTag, baseTag],
        bootAfterCreate: false,
      });
      await admin.call('vm.attachDisk', { vm: making, vdi, bootable: true, position: '0' });
      vdi = null; // the base's now, and deleted with it
      await admin.call('vm.convertToTemplate', { id: making });
      // ON THE LIST before it is used, or removed with the rest (baseOf).
      await recordMade(admin, /** @type {string} */ (making));
      from = { id: making };
      making = null; // kept from here, whatever happens to this build
      for (const old of basesFor(templates, pool, spec.key).filter((t) => !t.tags.includes(baseTag) && baseByUs(t, sets))) {
        await admin.call('vm.delete', { id: old.id, deleteDisks: true }).then(() => forgetMade(admin, old.id), () => {});
      }
    }

    // THE GUEST AGENT, or the build goes on without it and says so: an
    // image without one works, Xen Orchestra just cannot see its address.
    /** @type {string|null} */
    let agent = null;
    let noAgent = '';
    try {
      agent = gzipSync(await getAgent(imageDir, signal)).toString('base64');
    } catch (e) {
      signal?.throwIfAborted();
      noAgent = ` It goes without the Xen guest agent, so Xen Orchestra will not show its address: ${String(/** @type {any} */ (e)?.message || e).slice(0, 160)}.`;
    }
    say(`Installing Fleetwright on the machine image, its disk on ${on}.${noAgent}`, stage(3, installFill(0, null, null, head)));
    // A COPY OF THE BASE'S DISK comes with the VM, as a session's machine
    // gets a copy of the image's.
    vm = await admin.call('vm.create', {
      template: from.id,
      name_label: VM_IMAGE.buildName,
      name_description: 'Becoming the machine image sessions are cloned from. Made by Fleetwright; it powers off when the install is done.',
      VIFs: [{ network: uplink }],
      CPUs: VM_IMAGE.cpus,
      memory: VM_IMAGE.memory,
      tags: [VM_IMAGE.buildTag],
      bootAfterCreate: false,
    });
    // ONE DISK, OR NOTHING IS GROWN AND NOTHING BOOTS: the install goes on
    // the disk the VM starts from, and with two there is no telling which.
    const disks = await disksOf(admin, /** @type {string} */ (vm));
    if (disks.length !== 1) {
      throw new Error(disks.length
        ? `the machine image’s build VM came from the kept ${os} with ${disks.length} disks where it has one, so none was grown and it was not started`
        : `the machine image’s build VM was made from the kept ${os} without a disk`);
    }
    const [disk] = disks;
    // ROOM FOR A SESSION. cloud-init grows the partition to fill it on the
    // first boot, the build's and every clone's alike. Through whichever
    // call the server offers (RESIZE_METHODS in xo-setup.js): both take the
    // disk's id and its new size in bytes.
    await admin.call(resize === 'vdi.set' ? 'vdi.set' : 'disk.resize', { id: disk.id, size: VM_IMAGE.diskSize });
    // THE CLOUD-INIT DRIVE AFTER THE DISK, by its own call and on the disk's
    // storage. vm.create with `cloudConfig` puts the drive on the storage of
    // the VM's first disk, and a VM made with no disk of its own has none: Xen
    // Orchestra refused it with "Can't create cloud init config drive for VM
    // without disks", which is how the first build on a real pool ended.
    // A TOKEN FOR ITS REPORTS, when the fleet gives one (core.js,
    // #onImageReporter). Without one the build is judged by power state
    // alone, as it was before reports existed.
    const token = reporter ? await reporter() : null;
    const addresses = token ? await addressesOf(new URL(coordinatorUrl).hostname) : [];
    await admin.call('vm.createCloudInitConfigDrive', { vm, sr: sr.id, config: buildCloudConfig({ coordinatorUrl, token, addresses, agent, channel }) });
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
        ? `${STEP_WORDS[/** @type {keyof typeof STEP_WORDS} */ (report.step)]}${pulled(report)}, ${minutes} min so far.`
        : token && elapsed > SILENT_MS
          ? `${minutes} min so far, and its VM has not reported in. It may have no network, or its start-up script did not run.`
          : `${minutes} min so far, usually about ${Math.round(VM_IMAGE.installTypicalMs / 60_000)}.`;
      say(`Installing Fleetwright on the machine image: ${words}`, stage(3, installFill(elapsed, report?.step ?? null, pullPart(report), head)));
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
      name_description: `${os} with Fleetwright installed from ${builtFrom(channel)} and not enrolled. Sessions' machines are cloned from this. Made by Fleetwright.`,
    });
    await admin.call('tag.remove', { id: vm, tag: VM_IMAGE.buildTag }).catch(() => {});
    await admin.call('tag.add', { id: vm, tag: VM_IMAGE.tag });
    await admin.call('tag.add', { id: vm, tag: imageTag(spec.key) });
    await admin.call('tag.add', { id: vm, tag: channelTag(channel) });
    await admin.call('vm.convertToTemplate', { id: vm });
    // ON THE LIST, then in the set: what makes it the fleet's image is that
    // this job made it (isFleetImage), not the tags just given it.
    await recordMade(admin, /** @type {string} */ (vm));
    await admin.call('resourceSet.addObject', { id: setId, object: vm });
  } catch (e) {
    // Nothing half-made is left, except a failed install's VM, kept on purpose,
    // and a base that was finished, kept for the next build.
    if (making) await admin.call('vm.delete', { id: making, deleteDisks: true }).catch(() => {});
    if (vm && !keep) await admin.call('vm.delete', { id: vm, deleteDisks: true }).catch(() => {});
    if (vdi) await admin.call('vdi.delete', { id: vdi }).catch(() => {});
    throw e;
  }
  if (there) {
    const retired = await retireImage(admin, there);
    return (
      `The ${os} machine image was rebuilt on ${poolName} from ${builtFrom(channel)}, its disk on ${on}. ` +
      (retired.removed
        ? 'The one that was there was removed.'
        : `The one that was there was kept as "${retired.name}", because ${machines(retired.clones)} made from it still ${retired.clones === 1 ? 'exists' : 'exist'}; New session no longer offers it, and it can be removed once ${retired.clones === 1 ? 'that machine is' : 'they are'} gone.`)
    );
  }
  return (
    `The machine image is ready on ${poolName}: ${spec.name}, ${os} with Fleetwright installed from ${builtFrom(channel)}, its disk on ${on}. ` +
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
    await forgetMade(admin, String(template.id));
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
  // ONLY WHAT THE JOB MADE: an admin's session deletes nothing, disks and
  // all, because somebody else gave it a tag (isFleetImage, baseOf).
  const sets = await setsOf(admin);
  const there = templates.filter((t) => t?.$pool === pool && t?.tags?.includes?.(VM_IMAGE.tag) && imageKeyOf(t) === key && isFleetImage(t, sets));
  // ITS KEPT DISKS GO WITH IT (baseOf): asked to remove the image is asked
  // for the room back, and a machine made from it keeps the disk it reads.
  for (const b of basesFor(templates, pool, key).filter((t) => baseByUs(t, sets))) {
    await admin.call('vm.delete', { id: b.id, deleteDisks: true }).then(() => forgetMade(admin, b.id), () => {});
  }
  if (!there.length) return `The ${spec.os} machine image was already gone from ${poolName}.`;
  /** @type {number[]} */
  const kept = [];
  for (const t of there) {
    const clones = await clonesOf(admin, String(t.id));
    if (clones) kept.push(clones);
    else await admin.call('vm.delete', { id: t.id, deleteDisks: true }).then(() => forgetMade(admin, String(t.id)));
  }
  if (!kept.length) return `The ${spec.os} machine image was removed from ${poolName}. New session no longer offers it.`;
  const n = kept.reduce((a, b) => a + b, 0);
  return `The ${spec.os} machine image was kept on ${poolName}: ${machines(n)} made from it still ${n === 1 ? 'exists' : 'exist'}. Remove ${n === 1 ? 'that machine' : 'them'} and apply again.`;
}
