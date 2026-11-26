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

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
// ONE AT A TIME, AND NEVER HALF A FILE. Every call here is its own process,
// and a hub runs several at once: a build going while it lists. They share
// this one file, so a change to it is made under a lock, and written beside
// it and moved into place. Without that a reader met the file half written
// (a test's own look at the state, in CI, while a build was noting its
// call) and two writers lost each other's lines.
const LOCK = FILE + '.lock';
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lock = () => { for (let i = 0; i < 2000; i++) { try { fs.mkdirSync(LOCK); return; } catch { nap(5); } } };
const unlock = () => { try { fs.rmdirSync(LOCK); } catch {} };
const write = (s) => { const next = FILE + '.' + process.pid; fs.writeFileSync(next, JSON.stringify(s)); fs.renameSync(next, FILE); };
const args = String(process.env.PODMAN_ARGS || '').split('\\x1f').slice(0, -1);
const done = (code, out = '', err = '') => { unlock(); if (out) process.stdout.write(out); if (err) process.stderr.write(err); process.exit(code); };
// Whatever takes a while is waited for with the lock let go, and the state read again after.
const letGo = async (wait) => { unlock(); const got = await wait(); lock(); return got; };
const note = (extra = {}) => { const s = read(); s.calls.push({ args, ...extra }); write(s); return s; };
const after = (flag) => args[args.indexOf(flag) + 1];
const main = async () => {
  if (args[0] === '--version') return done(0, 'podman version 5.4.2\\n');
  lock();
  let s = note();
  if (s.down) return done(125, '', 'Error: cannot connect to Podman\\n');
  if (args[0] === 'image' && args[1] === 'inspect') return done(s.images.includes(args[2]) ? 0 : 1);
  if (args[0] === 'pull') { if (s.failPull) return done(125, '', 'Error: manifest unknown\\n'); s.images.push(args[1]); write(s); return done(0); }
  if (args[0] === 'build') {
    if (s.buildMs) await letGo(() => new Promise((r) => setTimeout(r, s.buildMs)));
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
    const stdin = await letGo(async () => { let all = ''; for await (const c of process.stdin) all += c; return all; });
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
    // A START THAT TAKES A WHILE (startMs): how a test looks at the machines
    // between the two steps of a making.
    if (s.startMs) { await letGo(() => new Promise((r) => setTimeout(r, s.startMs))); s = read(); }
    if (s.failRun) return done(125, '', 'Error: crun: cannot set memory limit\\n');
    const labels = {};
    args.forEach((a, i) => { if (a === '--label') { const [k, ...v] = args[i + 1].split('='); labels[k] = v.join('='); } });
    s.containers.push({ name: after('--name'), state: 'running', labels, stdin, image: args[args.length - 1], volume: after('-v').split(':')[0] });
    if (!s.volumes.includes(after('-v').split(':')[0])) s.volumes.push(after('-v').split(':')[0]);
    write(s);
    return done(0, 'c0ffee\\n');
  }
  // WHAT A CONTAINER PRINTED, as Podman hands it back: what it printed on
  // one stream and what it printed as errors on the other, each line with
  // Podman's own time in front when that is asked for, and only the last
  // few of both together. A container is given its log by a test, as
  // \`log: [{ at, err, line }]\`, oldest first.
  if (args[0] === 'logs') {
    const c = s.containers.find((x) => x.name === args[args.length - 1]);
    if (!c || s.failLogs) return done(125, '', 'Error: no container with name or ID "' + args[args.length - 1] + '" found: no such container\\n');
    const tail = (c.log || []).slice(-Number(after('--tail') || 1e9));
    const put = (err) => tail.filter((l) => Boolean(l.err) === err).map((l) => (args.includes('--timestamps') ? l.at + ' ' : '') + l.line + '\\n').join('');
    return done(0, put(false), put(true));
  }
  if (args[0] === 'rm') {
    // ONE SLOW REMOVAL, once (slowRmOnceMs): how a test holds a look at the
    // machines open while something else changes one.
    if (s.slowRmOnceMs) { const ms = s.slowRmOnceMs; s.slowRmOnceMs = 0; write(s); await letGo(() => new Promise((r) => setTimeout(r, ms))); s = read(); }
    // ONE REMOVAL HELD UNTIL THE TEST LETS IT GO (holdRm: 'next', then the
    // test sets it to ''): for what must happen while a look is clearing a
    // machine away, however long that takes on the day. A wait of so many
    // milliseconds is a guess at how slow the things beside it are.
    if (s.holdRm === 'next') {
      s.holdRm = 'held'; write(s);
      await letGo(async () => { for (let i = 0; i < 3000; i++) { await new Promise((r) => setTimeout(r, 10)); try { if (read().holdRm !== 'held') return; } catch {} } });
      s = read();
    }
    s.containers = s.containers.filter((c) => c.name !== args[2]); write(s); return done(0);
  }
  if (args[0] === 'volume' && args[1] === 'ls') return done(0, s.volumes.join('\\n') + '\\n');
  if (args[0] === 'volume' && args[1] === 'rm') {
    // AS PODMAN DOES: one a container has is removed only when forced.
    const volume = args[args.length - 1];
    const held = s.containers.some((c) => c.volume === volume);
    if (held && !args.includes('-f')) return done(2, '', 'Error: volume ' + volume + ' is being used by the following container(s): c0ffee: volume is being used\\n');
    s.volumes = s.volumes.filter((v) => v !== volume); write(s); return done(0);
  }
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
    // Under the stub's own lock and moved into place, for the reason the stub gives.
    set: (patch) => {
      const held = `${file}.lock`;
      for (let i = 0; i < 2000; i++) { try { mkdirSync(held); break; } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } }
      try {
        writeFileSync(`${file}.set`, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...patch }));
        renameSync(`${file}.set`, file);
      } finally {
        rmSync(held, { recursive: true, force: true });
      }
    },
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
