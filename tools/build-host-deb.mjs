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

/**
 * THE LIBRARIES NODE'S OWN BUILD LINKS, AND THE DEBIAN PACKAGE EACH LIVES IN.
 *
 * dpkg-shlibdeps would work this out for a package built from source; this
 * one carries a binary somebody else built, so the table is written down.
 * Node 24 wanted libc, libgcc_s and libstdc++, which every Debian has because
 * apt itself needs them. Node 25 moved to linking libatomic, which a stock
 * Debian 13 does not install, so a deb that did not name libatomic1 put a
 * node on the box that could not start, and the service with it. The build
 * reads bin/node's NEEDED entries and refuses to ship one that wants a
 * library `Depends` does not cover; a soname this table does not know is a
 * refusal too, since nobody can say which package would satisfy it.
 */
export const SHARED_LIBRARY_PACKAGES = Object.freeze({
  'libc.so.6': 'libc6',
  'libm.so.6': 'libc6',
  'libdl.so.2': 'libc6',
  'libpthread.so.0': 'libc6',
  'librt.so.1': 'libc6',
  'ld-linux-x86-64.so.2': 'libc6',
  'ld-linux-aarch64.so.1': 'libc6',
  'libgcc_s.so.1': 'libgcc-s1',
  'libstdc++.so.6': 'libstdc++6',
  'libatomic.so.1': 'libatomic1',
});

/** True when the bytes begin as an ELF file does. A fixture that is a shell script is not one. */
export function isElf(buf) {
  return buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
}

/**
 * The DT_NEEDED sonames of a 64-bit little-endian ELF, read from its
 * .dynamic section and the string table that section links to. Only what the
 * two Node builds we ship are; anything else is refused by name rather than
 * misread.
 *
 * @param {Buffer} buf
 * @returns {string[]}
 */
export function neededLibraries(buf) {
  if (!isElf(buf)) throw new Error('not an ELF file');
  if (buf[4] !== 2 || buf[5] !== 1) throw new Error('not a 64-bit little-endian ELF');
  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shentsize = buf.readUInt16LE(0x3a);
  const shnum = buf.readUInt16LE(0x3c);
  const section = (i) => {
    const o = shoff + i * shentsize;
    return {
      type: buf.readUInt32LE(o + 4),
      offset: Number(buf.readBigUInt64LE(o + 24)),
      size: Number(buf.readBigUInt64LE(o + 32)),
      link: buf.readUInt32LE(o + 40),
    };
  };
  for (let i = 0; i < shnum; i++) {
    const dyn = section(i);
    if (dyn.type !== 6) continue; // SHT_DYNAMIC
    const strtab = section(dyn.link);
    const names = [];
    for (let o = dyn.offset; o + 16 <= dyn.offset + dyn.size; o += 16) {
      const tag = Number(buf.readBigUInt64LE(o));
      if (tag === 0) break; // DT_NULL
      if (tag !== 1) continue; // DT_NEEDED
      const at = strtab.offset + Number(buf.readBigUInt64LE(o + 8));
      names.push(buf.toString('latin1', at, buf.indexOf(0, at)));
    }
    return names;
  }
  throw new Error('no .dynamic section: a static binary, or not one of ours');
}

/** The package names a `Depends:` value names, alternatives included. */
export function dependsPackages(control) {
  const m = /^Depends:\s*(.*)$/m.exec(control);
  if (!m) return [];
  return m[1].split(',').flatMap((d) => d.split('|')).map((d) => d.trim().split(/[\s(]/)[0]).filter(Boolean);
}

/**
 * Which of a binary's sonames `Depends` does not cover: each with the package
 * that would, or with nothing when the table has no row for it.
 *
 * @param {string} control  the control file, or the template
 * @param {string[]} sonames
 * @returns {{ soname: string, package: string | null }[]}
 */
export function undeclaredLibraries(control, sonames) {
  const have = new Set(dependsPackages(control));
  const out = [];
  for (const soname of sonames) {
    const pkg = SHARED_LIBRARY_PACKAGES[soname] ?? null;
    if (pkg === null || !have.has(pkg)) out.push({ soname, package: pkg });
  }
  return out;
}

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
 *
 * A BUILD OF MAIN IS `main-<run>`, and the deb job builds on every push to
 * main — that is what makes the pipeline one that has run before the day it
 * matters. To dpkg it is a PRERELEASE OF THE NEXT RELEASE, `<next>~main.<run>`,
 * where <next> is the version in package.json at that commit with its patch
 * raised by one: the bump commit IS the release, and until 1.0 every release
 * raises the patch (docs/ci.md, "Which number"). `0.4.12~main.330` sorts above
 * 0.4.11 and below 0.4.12, which is where the code sits, and reads as what it
 * is — the same `~` the rc form above uses, semver's `0.4.12-main.330`. So
 * moving a box from stable to rolling is an ordinary upgrade, and `apt list
 * --upgradable` reads as a version rather than a riddle. Each `<run>` is higher
 * than the last, so a box on the rolling suite takes every build in turn.
 *
 * IT WAS `0.0.0~main.<run>`, below every release, from the day the rolling
 * suite existed until 0.4.12. That kept a box with both suite lines on stable,
 * and no box has had both lines since /channel moved the one word instead. What
 * it left was a rolling box being told "0.0.0~main.325 is waiting (this box
 * has 0.4.11)" about the very commit 0.4.11 was cut from, and a downgrade pin
 * in a root-run script to make rolling installable at all. The pin moved to the
 * stable side with this (install/fleetwright-apt-channel), because going back
 * to a release is now the downgrade.
 *
 * Two edges, both ordered right. The build between a version bump merging and
 * its tag being published is named a prerelease of the release AFTER the one
 * being cut; it is that release's code, so it sorts just above it, which is
 * where a rolling box should be. And a release that raises the minor instead,
 * 0.5.0 after builds called 0.4.12~main, still outranks them: the name guessed
 * the number, not the order.
 *
 * @param {string} version the manifest's version: a tag, or `main-<run>`
 * @param {string} [base] package.json's version, for a build of main
 */
export function debVersion(version, base = packageVersion()) {
  const rolling = /^main-(\d+)$/.exec(String(version));
  if (rolling) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
    if (!m) throw new Error(`a build of main needs the release it follows as x.y.z, not "${base}"`);
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}~main.${rolling[1]}`;
  }
  const v = String(version).replace(/^v/, '').replace(/-/g, '~').replace(/[^0-9A-Za-z.+~]/g, '.');
  if (!/^[0-9]/.test(v)) throw new Error(`"${version}" cannot be a Debian version — it has to start with a digit`);
  return v;
}

/** The version in this checkout's package.json, which test/version.test.js keeps equal to the apps'. */
export function packageVersion(file = path.join(ROOT, 'package.json')) {
  return JSON.parse(readFileSync(file, 'utf8')).version;
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
  const nodeBin = readFileSync(path.join(work, top, 'bin/node'));
  if (isElf(nodeBin)) {
    const missing = undeclaredLibraries(readFileSync(path.join(DEB_SRC, 'control.in'), 'utf8'), neededLibraries(nodeBin));
    if (missing.length) {
      const said = missing.map((m) => (m.package ? `${m.soname} (${m.package})` : `${m.soname} (no package named for it in SHARED_LIBRARY_PACKAGES)`));
      throw new Error(`node v${nodeVersion} for ${arch} links libraries install/deb/control.in does not depend on: ${said.join(', ')} — refusing to ship a node that cannot start`);
    }
  }
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
