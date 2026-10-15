#!/usr/bin/env node
// Pins the Xen Orchestra installer's files to the commit INSTALLER names
// (src/fleet/host/xo-deploy.js), which is the half Renovate cannot write.
//
//   node scripts/pin-xo-installer.mjs
//
// Renovate moves `commit` to the head of the fork's master (renovate.json,
// git-refs); this writes `base` for that commit and the SHA-256 of each file
// the deploy reads from it, every one fetched at that commit. A file that is
// gone or bigger than the deploy takes is refused, and so is a commit younger
// than three days: git-refs carries no dates, so the soak renovate.json keeps
// for everything else is kept here, from the commit's own date. Set
// GITHUB_TOKEN to ask GitHub for it past the anonymous rate limit.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { SOAK_MS, soakLeft } from './pin-images.mjs';

const SOURCE = new URL('../src/fleet/host/xo-deploy.js', import.meta.url);

/** The most a file of the installer may be, as fetchInstaller holds it (MAX_FILE). */
export const MAX_FILE = 2 * 1024 * 1024;

/** @param {string} repository @param {string} commit */
export const baseFor = (repository, commit) => `https://raw.githubusercontent.com/${repository}/${commit}/`;

/**
 * The source with INSTALLER's `base` and each file's digest written for this
 * commit, and nothing else changed. Refuses a source it cannot find the block
 * in, or a file list that is not the one there, rather than write elsewhere.
 *
 * @param {string} source @param {string} base @param {Record<string, string>} files
 */
export function writeInstallerPin(source, base, files) {
  const block = /(export const INSTALLER = Object\.freeze\(\{[\s\S]*?\n {2}base: ')[^']*(',\n {2}files: Object\.freeze\(\{\n)([\s\S]*?)(\n {2}\}\),\n\}\);)/;
  const m = block.exec(source);
  if (!m) throw new Error('INSTALLER is not where this script expects it in xo-deploy.js');
  const there = [...m[3].matchAll(/'([^']+)': '[0-9a-f]*'/g)].map((x) => x[1]);
  if (there.join('\n') !== Object.keys(files).join('\n')) throw new Error('the files to pin are not the ones INSTALLER lists');
  const body = Object.entries(files).map(([name, sha]) => `    '${name}': '${sha}',`).join('\n');
  return source.replace(block, (_all, head, mid, _old, tail) => `${head}${base}${mid}${body}${tail}`);
}

/** @param {string} url */
async function get(url) {
  const token = process.env.GITHUB_TOKEN;
  let res = await fetch(url, { headers: token && url.startsWith('https://api.github.com/') ? { authorization: `Bearer ${token}` } : {} });
  // A token GitHub does not take is asked again without one: the commit is
  // public, and anonymous is only slower to run out.
  if (res.status === 401 && token) res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res;
}

async function main() {
  const { INSTALLER } = await import('../src/fleet/host/xo-deploy.js');
  const { repository, commit } = INSTALLER;
  const base = baseFor(repository, commit);
  if (INSTALLER.base === base) {
    console.log(`${repository} ${commit.slice(0, 7)}: already pinned`);
    return;
  }
  const info = await (await get(`https://api.github.com/repos/${repository}/commits/${commit}`)).json();
  const at = new Date(info?.commit?.committer?.date || '');
  if (Number.isNaN(at.getTime())) throw new Error(`GitHub gave no date for ${commit}, so its soak cannot be told`);
  if (soakLeft(at, Date.now()) > 0) {
    throw new Error(`${commit.slice(0, 7)} was committed ${at.toUTCString()}, and is held for three days like everything else: run this again after ${new Date(at.getTime() + SOAK_MS).toUTCString()}`);
  }
  /** @type {Record<string, string>} */
  const files = {};
  for (const name of Object.keys(INSTALLER.files)) {
    const bytes = Buffer.from(await (await get(`${base}${name}`)).arrayBuffer());
    if (bytes.length > MAX_FILE) throw new Error(`${name} is ${bytes.length} bytes at ${commit.slice(0, 7)}, more than the deploy takes`);
    files[name] = createHash('sha256').update(bytes).digest('hex');
    console.log(`  ${name}: ${bytes.length} bytes, ${files[name]}`);
  }
  writeFileSync(SOURCE, writeInstallerPin(readFileSync(SOURCE, 'utf8'), base, files));
  console.log(`${repository} ${commit.slice(0, 7)}, committed ${at.toUTCString()}: pinned`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(`pin-xo-installer: ${e.message}`);
    process.exit(1);
  });
}
