#!/usr/bin/env node
// After the VM has halted: the numbers the host needs from the image it
// left, checked against each other, and the manifest and release notes
// written from them. The second half of .github/workflows/edge-image.yml.
//
//   node scripts/edge-image/measure.mjs --image edge.img --facts facts/ \
//     --compressed fleetwright-edge-26.7-26.7.5-amd64.img.zst \
//     --release 26.7 --upstream-url … --upstream-sha256 … \
//     --commit … --workflow-run … --manifest manifest.json --notes notes.md
//
// TWO WITNESSES FOR THE CONFIGURATION'S PLACE. The guest said which inode
// /usr/local/etc/config.xml is, how long it is and its SHA-256 (drive.mjs,
// FACTS). scripts/opnsense-room.mjs reads that inode out of the file system
// and says where its bytes are and where a whole block for it would be. The
// bytes at that offset are then hashed here and must be what the guest said,
// or the manifest is not written: an offset the host would check a build
// against has to be right the first time, because the host's answer to a
// wrong one is to refuse every build.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';

import { OPNSENSE_IMAGE } from '../../src/fleet/host/edge-router.js';

const ROOM = new URL('../opnsense-room.mjs', import.meta.url).pathname;

/** @param {string[]} argv */
function options(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      image: { type: 'string' },
      facts: { type: 'string' },
      compressed: { type: 'string' },
      release: { type: 'string' },
      'upstream-url': { type: 'string' },
      'upstream-sha256': { type: 'string' },
      commit: { type: 'string', default: '' },
      'workflow-run': { type: 'string', default: '' },
      'built-at': { type: 'string', default: new Date().toISOString() },
      manifest: { type: 'string', default: 'manifest.json' },
      notes: { type: 'string', default: 'notes.md' },
    },
  });
  for (const k of /** @type {const} */ (['image', 'facts', 'compressed', 'release', 'upstream-url', 'upstream-sha256'])) {
    if (!values[k]) throw new Error(`--${k} is required`);
  }
  return /** @type {Required<typeof values>} */ (values);
}

/** @param {string} file */
async function sha256File(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/** @param {string} file @param {number} offset @param {number} length */
function readAt(file, offset, length) {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, b, got, length - got, offset + got);
      if (!n) break;
      got += n;
    }
    if (got !== length) throw new Error(`the image ends ${length - got} bytes short of ${offset + length}`);
    return b;
  } finally {
    closeSync(fd);
  }
}

/**
 * The room plan from scripts/opnsense-room.mjs, run as a person would run
 * it, and parsed from what it prints.
 *
 * @param {string} image @param {number} inode
 */
export function room(image, inode) {
  const r = spawnSync(process.execPath, [ROOM, image, String(inode)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`opnsense-room.mjs could not plan room for inode ${inode}: ${(r.stderr || r.stdout).trim()}`);
  return /** @type {import('../../src/fleet/host/ufs-room.js').Plan} */ (JSON.parse(r.stdout));
}

/**
 * The manifest from the facts the guest gave and what the image shows.
 *
 * @param {{ facts: Record<string, string>, plan: import('../../src/fleet/host/ufs-room.js').Plan, bytesSha256: string, zeros: boolean,
 *   rawSize: number, compressed: { name: string, sha256: string, size: number },
 *   release: string, upstreamUrl: string, upstreamSha256: string, commit: string, workflowRun: string, builtAt: string }} m
 */
export function manifest(m) {
  const { facts, plan } = m;
  const length = Number(facts['config-length']);
  const inode = Number(facts['config-inode']);
  if (plan.from.length !== length) throw new Error(`the file system says inode ${inode} is ${plan.from.length} bytes and the router said ${length}`);
  if (m.bytesSha256 !== facts['config-sha256']) {
    throw new Error(`the bytes at ${plan.from.offset} hash to ${m.bytesSha256.slice(0, 16)}…, not the ${facts['config-sha256'].slice(0, 16)}… the router reported for /usr/local/etc/config.xml, so the offset cannot be trusted and nothing was written`);
  }
  if (!m.zeros) throw new Error(`the block at ${plan.data.offset} that the configuration would move to is not zeros, so the host would refuse this plan`);
  const pinned = OPNSENSE_IMAGE.config;
  return {
    schema: 1,
    opnsense_release: m.release,
    opnsense_version: facts['opnsense-version'],
    core_package: facts['core-package'],
    freebsd_version: facts['freebsd-version'],
    kernel: facts.uname,
    os_xen: facts['os-xen'],
    accel: facts.accel,
    upstream_url: m.upstreamUrl,
    upstream_sha256: m.upstreamSha256,
    built_at: m.builtAt,
    commit: m.commit,
    workflow_run: m.workflowRun,
    raw_size: m.rawSize,
    compressed: { name: m.compressed.name, sha256: m.compressed.sha256, size: m.compressed.size, format: 'zstd' },
    config: {
      path: '/usr/local/etc/config.xml',
      inode,
      offset: plan.from.offset,
      length,
      sha256: facts['config-sha256'],
      /** Whether the file the image ships is byte for byte the one pinned in edge-router.js for the upstream release. */
      same_as_pinned: pinned.offset === plan.from.offset && pinned.length === length && pinned.sha256 === facts['config-sha256'],
      owner: facts['config-owner'] === 'none' ? null : facts['config-owner'],
    },
    grow: { room: plan.room, inode, data: plan.data, edits: plan.edits },
    packages: facts.packages.split('\n').filter(Boolean),
    ran: {
      packages: facts['update-packages'],
      base_kernel_check: facts['update-base-kernel-check'],
      base_kernel: facts['update-base-kernel'],
      packages_again: facts['update-packages-again'],
      base_kernel_check_again: facts['update-base-kernel-check-again'],
    },
  };
}

/**
 * The release body, from the manifest and nothing else, so the two cannot
 * disagree.
 *
 * @param {ReturnType<typeof manifest>} m
 */
export function notes(m) {
  const short = (/** @type {string} */ s) => `\`${s}\``;
  return [
    `OPNsense ${m.opnsense_version} (release ${m.opnsense_release}) with the Xen guest agent installed, built in CI from the pinned upstream image and ready for the edge router.`,
    '',
    `**Started from** [${path.basename(m.upstream_url)}](${m.upstream_url}), SHA-256 ${short(m.upstream_sha256)}.`,
    '',
    '**What ran inside**, over the serial console (`scripts/edge-image/drive.mjs`):',
    '',
    `1. \`opnsense-update -pt opnsense\`, then \`opnsense-update -bk\` when \`-bk -c\` offered one, then a reboot — the order OPNsense's own update takes.`,
    '2. `pkg install -y os-xen`, `register.php install os-xen`, `pkg autoremove -y` — how OPNsense installs a plugin.',
    '3. Caches, logs, leases, history, SSH host keys, the host id and the saved entropy removed; `/conf/config.xml` removed so the host\'s own configuration applies on first boot.',
    '',
    `**Versions**: core ${short(`${m.core_package} ${m.opnsense_version}`)}, os-xen ${short(m.os_xen)}, ${m.freebsd_version}.`,
    '',
    `**The configuration file** \`${m.config.path}\` is at offset ${m.config.offset}, ${m.config.length} bytes, SHA-256 ${short(m.config.sha256)}${m.config.same_as_pinned ? ' (the same bytes at the same place as the upstream image)' : ' (**not** where or what the upstream image has: the host-side pin must change with it)'}. The block it moves to for room is at ${m.grow.data.offset}; \`manifest.json\` carries the full plan.`,
    '',
    `**Assets**: \`${m.compressed.name}\` (${m.compressed.size} bytes, SHA-256 ${short(m.compressed.sha256)}; ${m.raw_size} bytes raw), \`manifest.json\`, \`SHA256SUMS\`. Built at ${m.built_at} from ${m.commit ? short(m.commit.slice(0, 12)) : 'an unknown commit'}${m.workflow_run ? ` by [this run](${m.workflow_run})` : ''}.`,
    '',
    '<details>',
    `<summary>${m.packages.length} packages</summary>`,
    '',
    '```',
    ...m.packages,
    '```',
    '',
    '</details>',
    '',
  ].join('\n');
}

async function main() {
  const o = options(process.argv.slice(2));
  /** @type {Record<string, string>} */
  const facts = JSON.parse(readFileSync(path.join(o.facts, 'facts.json'), 'utf8'));
  for (const k of ['opnsense-version', 'config-inode', 'config-length', 'config-sha256', 'packages', 'os-xen']) {
    if (!facts[k]) throw new Error(`facts.json has no ${k}: the drive did not get that far`);
  }
  const plan = room(o.image, Number(facts['config-inode']));
  console.log(`inode ${facts['config-inode']}: ${plan.from.length} bytes at ${plan.from.offset}; room at ${plan.data.offset}, ${plan.edits.length} edits`);
  const bytesSha256 = createHash('sha256').update(readAt(o.image, plan.from.offset, plan.from.length)).digest('hex');
  console.log(`bytes there: sha256 ${bytesSha256} (the router said ${facts['config-sha256']})`);
  const zeros = readAt(o.image, plan.data.offset, plan.data.length).every((x) => x === 0);
  const compressed = { name: path.basename(o.compressed), sha256: await sha256File(o.compressed), size: statSync(o.compressed).size };
  const m = manifest({
    facts, plan, bytesSha256, zeros, rawSize: statSync(o.image).size, compressed,
    release: o.release, upstreamUrl: o['upstream-url'], upstreamSha256: o['upstream-sha256'],
    commit: o.commit, workflowRun: o['workflow-run'], builtAt: o['built-at'],
  });
  writeFileSync(o.manifest, `${JSON.stringify(m, null, 2)}\n`);
  writeFileSync(o.notes, notes(m));
  console.log(`wrote ${o.manifest} and ${o.notes}: OPNsense ${m.opnsense_version}, os-xen ${m.os_xen}, ${m.packages.length} packages, configuration ${m.config.same_as_pinned ? 'as pinned' : 'DIFFERENT from the pin'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
