#!/usr/bin/env node
// The pinned Claude Code, asked what its dialogs say.
//
//   node scripts/claude-dialog-check.mjs
//   CLAUDE_BIN=/path/to/claude node scripts/claude-dialog-check.mjs
//
// Fetches the Claude Code release this repository pins and hands its binary
// to src/fleet/host/claude-dialogs.js, which fails when a dialog the fleet
// has an opinion about is one the matchers would miss or misread. Dialog
// drift fails here, in CI, instead of in a session nobody is watching.
//
// WHICH RELEASE. The one Renovate moves: mac-host.yml and ephemeral-mac.yml
// install it on the macOS hosts, and sandbox/Containerfile bakes it into the
// session image every Linux session runs in. One custom manager in
// renovate.json reads all three and bumps them in one pull request, so this
// reads the version with that manager's own patterns rather than keeping a
// fourth copy that nothing bumps. If the three ever disagree it refuses, since
// "the pinned release" would then mean two things. A box that installed
// Claude Code itself runs whatever it installed, and this says nothing about it.
//
// NOT INSTALLED, AND NOT RUN. The JavaScript is embedded in the binary as
// text, so reading it needs no session, no login and no credential. `npm pack`
// fetches the one platform package that holds the binary, without the wrapper
// and without its postinstall, and always the linux-x64 one: the text is the
// same on every platform, so the check does not depend on where it runs.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { dialogProblems } from '../src/fleet/host/claude-dialogs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The files that pin the release, which Renovate's claude-code manager reads. */
export const PINNED_IN = ['.github/workflows/mac-host.yml', '.github/workflows/ephemeral-mac.yml', 'sandbox/Containerfile'];

const PACKAGE = '@anthropic-ai/claude-code';

/**
 * The Claude Code version each file pins, read the way Renovate reads it.
 *
 * @param {string} [root]
 * @returns {{ file: string, version: string|null }[]}
 */
export function claudeCodePins(root = ROOT) {
  const config = JSON.parse(readFileSync(path.join(root, 'renovate.json'), 'utf8'));
  return PINNED_IN.map((file) => {
    const text = readFileSync(path.join(root, file), 'utf8');
    /** @type {string[]} */
    const versions = [];
    for (const manager of config.customManagers ?? []) {
      if (!manager.managerFilePatterns?.some((/** @type {string} */ p) => new RegExp(p.slice(1, -1)).test(file))) continue;
      for (const source of manager.matchStrings ?? []) {
        for (const m of text.matchAll(new RegExp(source, 'g'))) {
          if (m.groups?.depName === PACKAGE && m.groups.currentValue) versions.push(m.groups.currentValue);
        }
      }
    }
    return { file, version: versions.length === 1 ? versions[0] : null };
  });
}

/**
 * The one version all of them pin, or an error that says which file is off.
 *
 * @param {string} [root]
 */
export function claudeCodeVersion(root = ROOT) {
  const pins = claudeCodePins(root);
  const missing = pins.filter((p) => !p.version).map((p) => p.file);
  if (missing.length) throw new Error(`Renovate reads no single ${PACKAGE} version in ${missing.join(', ')}.`);
  const versions = new Set(pins.map((p) => p.version));
  if (versions.size !== 1) {
    throw new Error(`The ${PACKAGE} pins disagree: ${pins.map((p) => `${p.file} ${p.version}`).join(', ')}.`);
  }
  return /** @type {string} */ (pins[0].version);
}

/**
 * The binary of `version`, fetched into a directory removed on exit.
 *
 * @param {string} version
 */
function fetchBinary(version) {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-dialogs-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const spec = `${PACKAGE}-linux-x64@${version}`;
  const tarball = execFileSync('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', dir, spec], {
    cwd: dir,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .pop();
  execFileSync('tar', ['-xzf', path.join(dir, /** @type {string} */ (tarball)), '-C', dir, 'package/claude']);
  return path.join(dir, 'package', 'claude');
}

function main() {
  const version = claudeCodeVersion();
  const bin = process.env.CLAUDE_BIN || fetchBinary(version);
  // latin1, so every byte is one character and the embedded source reads as
  // itself. The dialog text is ASCII; the minifier escapes the rest.
  const source = readFileSync(bin, 'latin1');
  const says = /\/\/ Version: (\d+\.\d+\.\d+)/.exec(source)?.[1] ?? 'an unknown version';
  if (!process.env.CLAUDE_BIN && says !== version) {
    console.error(`Fetched ${PACKAGE} ${version} and the binary says it is ${says}.`);
    process.exit(1);
  }
  const label = process.env.CLAUDE_BIN ? `Claude Code ${says} (${bin})` : `Claude Code ${version}, as pinned`;
  const { problems, notes } = dialogProblems(source);
  for (const note of notes) console.log(`  ${note}`);
  if (problems.length) {
    console.error(`${label} draws dialogs this fleet gets wrong:`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`${label}: every dialog the fleet watches for is one it notices, and reads as what it is.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
