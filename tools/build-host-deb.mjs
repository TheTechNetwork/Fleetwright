// Wrap a host release in a .deb, with the Node that runs it.
//
//   node tools/build-host-deb.mjs --arch amd64 [--arch arm64]
//
// READS dist/, WRITES dist/deb/. The input is the tarball and manifest that
// tools/build-host-package.mjs already built and proved reproducible; this adds
// nothing to the code and changes none of its bytes. The deb is a courier: it
// carries that tarball to /usr/lib/fleetwright/release, and its postinst hands
// over to the installer inside — the same handover bootstrap.sh makes. See
// install/deb/postinst for why dpkg never unpacks into /opt itself.
//
// THE NODE IS NODE'S OWN BUILD, checked against the SHASUMS256.txt nodejs.org
// publishes beside it, at the version install/deb/node.env names. Renovate
// moves that version, so shipping a runtime does not mean shipping an old one.
// Only bin/node is kept: npm, corepack and the headers are 60 MB this box has
// no use for, and a host that ran npm is the thing packaging exists to end.
//
// DETERMINISTIC, like the tarball it wraps: fixed mtimes, root ownership, sorted
// entries. dpkg-deb reads SOURCE_DATE_EPOCH for the ar member timestamps.
//
// Environment:
//   DEB_NODE_DIST        a directory holding node-v<ver>-linux-<arch>.tar.xz and
//                        SHASUMS256.txt, instead of fetching them. For tests,
//                        and for a builder with no network.
//   DEB_MAINTAINER       the Maintainer field.
//   RELEASE_OUT_DIR      where the host release is, as for the package build.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = process.env.RELEASE_OUT_DIR || path.join(ROOT, 'dist');
const DEB_SRC = path.join(ROOT, 'install', 'deb');

/** Debian's name for an architecture, and Node's. */
export const ARCHES = Object.freeze({ amd64: 'x64', arm64: 'arm64' });

/** The Node version install/deb/node.env pins. */
export function pinnedNodeVersion(text = readFileSync(path.join(DEB_SRC, 'node.env'), 'utf8')) {
  const m = /^NODE_VERSION=(\d+\.\d+\.\d+)\s*$/m.exec(text);
  if (!m) throw new Error('install/deb/node.env has no NODE_VERSION=<x.y.z> line');
  return m[1];
}

/**
 * A release version as dpkg will compare it.
 *
 * Tags are `v0.2.3`; dpkg wants a leading digit. A hyphen means a Debian
 * revision to dpkg and a prerelease to semver, so it becomes `~`, which sorts
 * BEFORE the release — `0.3.0~rc1` < `0.3.0`, the order semver means. Only
 * stable releases are published through apt, so this is a guard, not a feature.
 */
export function debVersion(version) {
  const v = String(version).replace(/^v/, '').replace(/-/g, '~').replace(/[^0-9A-Za-z.+~]/g, '.');
  if (!/^[0-9]/.test(v)) throw new Error(`"${version}" cannot be a Debian version — it has to start with a digit`);
  return v;
}

/** The sha256 SHASUMS256.txt lists for one file, or null. */
export function shasumFor(shasums, file) {
  for (const line of shasums.split('\n')) {
    const [sum, name] = line.trim().split(/\s+/);
    if (name === file && /^[0-9a-f]{64}$/.test(sum)) return sum;
  }
  return null;
}

async function fetchTo(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

/** node-v<ver>-linux-<arch>.tar.xz, fetched or found, and verified. */
async function nodeTarball(version, nodeArch, work) {
  const file = `node-v${version}-linux-${nodeArch}.tar.xz`;
  const local = process.env.DEB_NODE_DIST;
  const shasumsPath = path.join(work, 'SHASUMS256.txt');
  const tarPath = path.join(work, file);
  if (local) {
    copyFileSync(path.join(local, 'SHASUMS256.txt'), shasumsPath);
    copyFileSync(path.join(local, file), tarPath);
  } else {
    const base = `https://nodejs.org/dist/v${version}`;
    if (!existsSync(shasumsPath)) await fetchTo(`${base}/SHASUMS256.txt`, shasumsPath);
    await fetchTo(`${base}/${file}`, tarPath);
  }
  const want = shasumFor(readFileSync(shasumsPath, 'utf8'), file);
  if (!want) throw new Error(`SHASUMS256.txt does not list ${file}`);
  const have = createHash('sha256').update(readFileSync(tarPath)).digest('hex');
  if (have !== want) throw new Error(`${file} is ${have}, SHASUMS256.txt says ${want} — refusing to ship it`);
  return tarPath;
}

function walk(dir) {
  const out = [dir];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function duKiB(dir) {
  let bytes = 0;
  for (const p of walk(dir)) {
    const st = statSync(p);
    if (st.isFile()) bytes += st.size;
  }
  return Math.ceil(bytes / 1024);
}

/**
 * Build one .deb. Returns its path.
 *
 * @param {{ arch: string, manifest: any, tarball: string, nodeVersion: string, epoch: number, out: string }} o
 */
export async function buildDeb({ arch, manifest, tarball, nodeVersion, epoch, out }) {
  const nodeArch = ARCHES[arch];
  if (!nodeArch) throw new Error(`no Node build for ${arch} — one of ${Object.keys(ARCHES).join(', ')}`);
  const version = debVersion(manifest.version);
  const work = path.join(out, `.work-${arch}`);
  const stage = path.join(work, 'root');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  // /usr/lib/fleetwright/release — the tarball, and the manifest that vouches for it.
  const rel = path.join(stage, 'usr/lib/fleetwright/release');
  mkdirSync(rel, { recursive: true });
  copyFileSync(tarball, path.join(rel, path.basename(tarball)));
  writeFileSync(path.join(rel, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // /usr/lib/fleetwright/node — bin/node and its licence, nothing else.
  const nodeTar = await nodeTarball(nodeVersion, nodeArch, work);
  const top = `node-v${nodeVersion}-linux-${nodeArch}`;
  execFileSync('tar', ['-xJf', nodeTar, '-C', work, `${top}/bin/node`, `${top}/LICENSE`]);
  const nodeDir = path.join(stage, 'usr/lib/fleetwright/node');
  mkdirSync(path.join(nodeDir, 'bin'), { recursive: true });
  copyFileSync(path.join(work, top, 'bin/node'), path.join(nodeDir, 'bin/node'));
  chmodSync(path.join(nodeDir, 'bin/node'), 0o755);
  const doc = path.join(stage, 'usr/share/doc/fleetwright');
  mkdirSync(doc, { recursive: true });
  copyFileSync(path.join(work, top, 'LICENSE'), path.join(doc, 'node.LICENSE'));
  copyFileSync(path.join(ROOT, 'LICENSE'), path.join(doc, 'copyright'));
  chmodSync(path.join(doc, 'copyright'), 0o644);
  chmodSync(path.join(doc, 'node.LICENSE'), 0o644);

  // DEBIAN/ — control from the template, the maintainer scripts verbatim.
  const control = path.join(stage, 'DEBIAN');
  mkdirSync(control);
  const size = duKiB(path.join(stage, 'usr'));
  writeFileSync(
    path.join(control, 'control'),
    readFileSync(path.join(DEB_SRC, 'control.in'), 'utf8')
      .replace('@VERSION@', version)
      .replace('@ARCH@', arch)
      .replace('@SIZE@', String(size))
      .replace('@MAINTAINER@', process.env.DEB_MAINTAINER || 'Fleetwright <fleetwright@users.noreply.github.com>'),
  );
  for (const f of ['templates', 'config', 'postinst', 'prerm', 'postrm']) {
    copyFileSync(path.join(DEB_SRC, f), path.join(control, f));
    chmodSync(path.join(control, f), f === 'templates' ? 0o644 : 0o755);
  }

  // Deterministic: every mtime the same, so two builds are the same bytes.
  for (const p of walk(stage)) utimesSync(p, epoch, epoch);

  const deb = path.join(out, `fleetwright_${version}_${arch}.deb`);
  execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', stage, deb], {
    env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  rmSync(work, { recursive: true, force: true });
  return deb;
}

async function main() {
  const arches = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--arch') arches.push(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!arches.length) arches.push(...Object.keys(ARCHES));

  const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
  const tarball = path.join(DIST, manifest.file);
  const have = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  if (have !== manifest.sha256) throw new Error(`${manifest.file} does not match its manifest — build it again`);

  const out = path.join(DIST, 'deb');
  mkdirSync(out, { recursive: true });
  const nodeVersion = pinnedNodeVersion();
  // The same fixed instant the tarball uses, so a deb says nothing about when
  // it was built — only what it holds.
  const epoch = Date.UTC(2020, 0, 1) / 1000;
  for (const arch of arches) {
    const deb = await buildDeb({ arch, manifest, tarball, nodeVersion, epoch, out });
    const sum = createHash('sha256').update(readFileSync(deb)).digest('hex');
    console.log(`${path.relative(ROOT, deb)}  ${(statSync(deb).size / 1048576).toFixed(1)} MB  node ${nodeVersion}`);
    console.log(`sha256 ${sum}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`build-host-deb: ${e.message}`);
    process.exit(1);
  });
}
