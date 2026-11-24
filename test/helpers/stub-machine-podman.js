// A `podman` that keeps what it was told, for the machines a box makes out
// of its own containers (src/core/machines.js).
//
// The fake in test/podman.test.js answers every question the same way each
// time, which is enough for a session's container. A machine is made, listed,
// extended and ended, so this one remembers: images that were built,
// containers that were run with their labels, what each `run` was handed on
// its standard input. It is a real program on disk, started the way the hub
// starts Podman, so the arguments and the standard input are what a real
// Podman would have been given.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @param {import('node:test').TestContext} t
 * @returns {{ dir: string, bin: string, state: () => any, set: (patch: Record<string, unknown>) => void, calls: () => string[][], cfg: (patch?: Record<string, unknown>) => any, release: (shape?: 'checkout'|'packaged'|'old') => string }}
 */
export function stubMachinePodman(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-machines-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'podman-state.json');
  const bin = path.join(dir, 'podman');
  const program = path.join(dir, 'podman.cjs');
  writeFileSync(file, JSON.stringify({ images: [], containers: [], volumes: [], seeds: [], calls: [], failBuild: false, buildMs: 0, failRun: false, failSeed: false, down: false }));
  // THE ARGUMENTS REACH THE PROGRAM IN A VARIABLE, not as its own arguments:
  // Node reads `--env-file` out of whatever follows a script's name, and a
  // machine's `podman run` carries exactly that flag.
  writeFileSync(bin, `#!/bin/sh\nPODMAN_ARGS="$(printf '%s\\037' "$@")" exec node ${program}\n`);
  writeFileSync(
    program,
    `const fs = require('node:fs');
const FILE = ${JSON.stringify(file)};
const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const write = (s) => fs.writeFileSync(FILE, JSON.stringify(s));
const args = String(process.env.PODMAN_ARGS || '').split('\\x1f').slice(0, -1);
const done = (code, out = '', err = '') => { if (out) process.stdout.write(out); if (err) process.stderr.write(err); process.exit(code); };
const note = (extra = {}) => { const s = read(); s.calls.push({ args, ...extra }); write(s); return s; };
const after = (flag) => args[args.indexOf(flag) + 1];
const main = async () => {
  if (args[0] === '--version') return done(0, 'podman version 5.4.2\\n');
  let s = note();
  if (s.down) return done(125, '', 'Error: cannot connect to Podman\\n');
  if (args[0] === 'image' && args[1] === 'inspect') return done(s.images.includes(args[2]) ? 0 : 1);
  if (args[0] === 'pull') { if (s.failPull) return done(125, '', 'Error: manifest unknown\\n'); s.images.push(args[1]); write(s); return done(0); }
  if (args[0] === 'build') {
    if (s.buildMs) await new Promise((r) => setTimeout(r, s.buildMs));
    s = read();
    // What a build reads: its context must hold what the Containerfile copies.
    const context = args[args.length - 1];
    const has = fs.existsSync(context + '/release/bin') && fs.existsSync(context + '/entrypoint');
    s.contexts = [...(s.contexts || []), { has, release: has ? fs.readdirSync(context + '/release').sort() : [] }];
    if (s.failBuild) { write(s); return done(1, '', 'STEP 4/9: RUN curl ...\\nError: could not resolve deb.nodesource.com\\n'); }
    s.images.push(after('-t'));
    write(s);
    return done(0);
  }
  if (args[0] === 'images') return done(0, s.images.join('\\n') + '\\n');
  if (args[0] === 'rmi') { s.images = s.images.filter((i) => i !== args[1]); write(s); return done(0); }
  if (args[0] === 'ps') {
    return done(0, s.containers.map((c) => [c.name, c.state, c.labels['fleetwright.machine'] || '', c.labels['fleetwright.owner'] || '', c.labels['fleetwright.made'] || '', c.labels['fleetwright.until'] || ''].join('\\t')).join('\\n') + '\\n');
  }
  if (args[0] === 'run') {
    let stdin = '';
    for await (const c of process.stdin) stdin += c;
    s = read();
    // A SHORT-LIVED CONTAINER THAT WRITES INTO A VOLUME from its standard
    // input, and is gone: what it was handed is what the volume now holds.
    if (args.includes('--rm')) {
      if (s.failSeed) return done(125, '', 'Error: creating volume: no space left on device\\n');
      const volume = after('-v').split(':')[0];
      s.seeds.push({ volume, stdin, wrote: args[args.length - 1] });
      if (!s.volumes.includes(volume)) s.volumes.push(volume);
      write(s);
      return done(0);
    }
    if (s.failRun) return done(125, '', 'Error: crun: cannot set memory limit\\n');
    const labels = {};
    args.forEach((a, i) => { if (a === '--label') { const [k, ...v] = args[i + 1].split('='); labels[k] = v.join('='); } });
    s.containers.push({ name: after('--name'), state: 'running', labels, stdin, image: args[args.length - 1] });
    if (!s.volumes.includes(after('-v').split(':')[0])) s.volumes.push(after('-v').split(':')[0]);
    write(s);
    return done(0, 'c0ffee\\n');
  }
  if (args[0] === 'rm') {
    // ONE SLOW REMOVAL, once (slowRmOnceMs): how a test holds a look at the
    // machines open while something else changes one.
    if (s.slowRmOnceMs) { const ms = s.slowRmOnceMs; s.slowRmOnceMs = 0; write(s); await new Promise((r) => setTimeout(r, ms)); s = read(); }
    s.containers = s.containers.filter((c) => c.name !== args[2]); write(s); return done(0);
  }
  if (args[0] === 'volume' && args[1] === 'rm') { s.volumes = s.volumes.filter((v) => v !== args[3]); write(s); return done(0); }
  return done(0);
};
main();
`,
  );
  chmodSync(bin, 0o755);

  /**
   * A release on disk, in one of the shapes a box has: a checkout (`src/`
   * and `node_modules`), a packaged one (`lib/` and only the web pages of
   * `src/`), or one from before machines (no `sandbox/machine`).
   */
  const release = (/** @type {'checkout'|'packaged'|'old'} */ shape = 'packaged') => {
    const root = mkdtempSync(path.join(dir, `release-${shape}-`));
    const put = (/** @type {string} */ rel, text = 'x\n') => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    };
    put('package.json', '{"version":"1.2.3"}\n');
    put('bin/fleetwright');
    put('bin/fleetwright-sidecar');
    put('src/web/index.html');
    if (shape === 'checkout') {
      put('src/index.js');
      put('node_modules/jose/index.js');
      put('apps/ios/Fleet.swift');
      put('.git/HEAD');
    } else {
      put('lib/fleetwright.mjs');
      put('lib/fleetwright-sidecar.mjs');
    }
    if (shape !== 'old') {
      put('sandbox/machine/Containerfile', 'FROM debian:13-slim\n');
      put('sandbox/machine/entrypoint', '#!/usr/bin/env bash\n');
    }
    return root;
  };

  return {
    dir,
    bin,
    release,
    state: () => JSON.parse(readFileSync(file, 'utf8')),
    set: (patch) => writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch })),
    calls: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).calls.map((/** @type {any} */ c) => c.args) : []),
    cfg: (patch = {}) => ({
      podmanBin: bin,
      stateDir: path.join(dir, 'state'),
      installDir: release('packaged'),
      machineImage: '',
      machineMax: 2,
      sandboxUserns: 'nomap',
      sandboxMemory: '8g',
      sandboxCpus: '2',
      sandboxPidsLimit: '512',
      sandboxEgress: 'open',
      ...patch,
    }),
  };
}
