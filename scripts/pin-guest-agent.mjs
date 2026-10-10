#!/usr/bin/env node
// Pins the Xen guest agent's file to the release GUEST_AGENT names
// (src/fleet/host/vm-image.js), which is the half Renovate cannot write.
//
//   node scripts/pin-guest-agent.mjs
//
// Renovate bumps `release` from GitLab's releases; this reads that release's
// own asset links, takes its Linux x86-64 build, and writes its address, size
// and SHA-256 into `file`. Before writing anything it checks what it
// downloaded is what an image here can run: an x86-64 ELF, asking for no
// glibc newer than the oldest image's, and that upstream's systemd unit at
// that tag is still the one the image writes (GUEST_AGENT_UNIT). A release
// that fails any of those is refused, and the pull request stays red until a
// person decides.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SOURCE = new URL('../src/fleet/host/vm-image.js', import.meta.url);
const PROJECT = 'xen-project/xen-guest-agent';

/** Ubuntu 24.04's, the oldest glibc of the images in vm-image.js (Debian 13 has 2.41). */
export const OLDEST_GLIBC = Object.freeze([2, 39]);

/**
 * The release's Linux x86-64 build among its asset links. Upstream has called
 * it "Linux x86 64bit binary" and then "executable", so the name is matched
 * on what does not change.
 *
 * @param {{ assets?: { links?: Array<{ name: string, url: string }> } }} release
 * @returns {string}
 */
export function linuxAsset(release) {
  const links = (release?.assets?.links ?? []).filter((l) => /^linux x86[ _-]?64/i.test(l.name));
  if (links.length !== 1) throw new Error(`the release has ${links.length} Linux x86-64 builds among its assets, not one`);
  return links[0].url;
}

/**
 * What an image here needs of the file: a 64-bit little-endian x86-64 ELF,
 * and no glibc symbol version newer than OLDEST_GLIBC. Answers the newest
 * glibc it asks for.
 *
 * @param {Buffer} bin @returns {string}
 */
export function checkBinary(bin) {
  if (bin.length < 20 || bin.subarray(0, 4).toString('latin1') !== '\x7fELF') throw new Error('it is not an ELF executable');
  if (bin[4] !== 2 || bin[5] !== 1 || bin.readUInt16LE(18) !== 62) throw new Error('it is not a 64-bit x86-64 executable');
  /** @type {number[]} */
  let newest = [2, 0];
  for (const m of bin.toString('latin1').matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const v = [Number(m[1]), Number(m[2])];
    if (v[0] > newest[0] || (v[0] === newest[0] && v[1] > newest[1])) newest = v;
  }
  const [a, b] = OLDEST_GLIBC;
  if (newest[0] > a || (newest[0] === a && newest[1] > b)) throw new Error(`it needs glibc ${newest.join('.')}, and the oldest image here has ${a}.${b}`);
  return newest.join('.');
}

/**
 * The source with GUEST_AGENT's `file` written for this release, and nothing
 * else changed. Refuses a source it cannot find the block in, rather than
 * writing somewhere else.
 *
 * @param {string} source
 * @param {{ release: string, url: string, size: number, sha256: string }} file
 * @returns {string}
 */
export function writePin(source, { release, url, size, sha256 }) {
  const block = /(export const GUEST_AGENT = Object\.freeze\(\{[\s\S]*?\n  file: Object\.freeze\(\{\n)[\s\S]*?(\n  \}\),\n\}\);)/;
  if (!block.test(source)) throw new Error('GUEST_AGENT.file is not where this script expects it in vm-image.js');
  const body = [`    release: '${release}',`, `    url: '${url}',`, `    size: ${size},`, `    sha256: '${sha256}',`].join('\n');
  return source.replace(block, (_m, head, tail) => `${head}${body}${tail}`);
}

/** @param {string} url */
async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res;
}

async function main() {
  const { GUEST_AGENT, GUEST_AGENT_UNIT } = await import('../src/fleet/host/vm-image.js');
  const { release } = GUEST_AGENT;
  const api = `https://gitlab.com/api/v4/projects/${encodeURIComponent(PROJECT)}/releases/${encodeURIComponent(release)}`;
  const url = linuxAsset(await (await get(api)).json());
  const bin = Buffer.from(await (await get(url)).arrayBuffer());
  const glibc = checkBinary(bin);
  const unit = (await (await get(`https://gitlab.com/${PROJECT}/-/raw/${encodeURIComponent(release)}/startup/xen-guest-agent.service`)).text()).trimEnd();
  if (unit !== GUEST_AGENT_UNIT.join('\n')) {
    throw new Error(`upstream's unit at ${release} is not the one the image writes; change GUEST_AGENT_UNIT to it first:\n${unit}`);
  }
  const sha256 = createHash('sha256').update(bin).digest('hex');
  writeFileSync(SOURCE, writePin(readFileSync(SOURCE, 'utf8'), { release, url, size: bin.length, sha256 }));
  console.log(`xen-guest-agent ${release}: ${bin.length} bytes, SHA-256 ${sha256}, glibc ${glibc} at most\n  ${url}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`pin-guest-agent: ${e.message}`);
    process.exit(1);
  });
}
