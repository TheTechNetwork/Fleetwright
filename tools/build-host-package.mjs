// Build the host release: a tarball with a digest, and no npm install anywhere
// near the box it lands on.
//
// WHAT THE DIGEST ACTUALLY BUYS, since "compiled" gets claimed for it wrongly:
// nothing is hidden. The bundle is readable JavaScript and `strings` gets you
// most of it, so this is worth zero as obscurity. What it is worth is
//
//   INTEGRITY — one artifact with one sha256. A node_modules tree of thousands
//   of files edited in place is not verifiable by anybody; a single file
//   against a published digest is. That is what makes "has this host been
//   tampered with" a question with an answer.
//
//   NO INSTALL-TIME EXECUTION — npm runs lifecycle scripts from every
//   dependency in the tree. A release that is unpacked instead of installed
//   runs none of them, on a box whose whole purpose is to be trustworthy.
//
//   THE SAME BYTES EVERYWHERE. "The same commit" never quite promised that once
//   `npm ci` was involved.
//
// The layout mirrors the repository for everything that is not code, so one
// expression finds a resource in either shape — see core/resources.js.
//
//   <root>/package.json          name, version; also how the root is FOUND
//   <root>/openapi.json
//   <root>/src/web/…
//   <root>/install/…             so a release can reinstall and migrate itself
//   <root>/sandbox/…             the image build context
//   <root>/lib/agent-hub.mjs     the bundle
//   <root>/lib/agent-fleet-sidecar.mjs
//   <root>/bin/…                 thin shims, so PATH entries do not change

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { rolloutFraction } from './rollout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/** Passed in by CI, so a release is named after the run that produced it. */
const version = process.env.RELEASE_VERSION || pkg.version || '0.0.0-dev';
const stageName = `fleetwright-host-${version}`;
const stage = path.join(OUT, stageName);

/** Files copied verbatim. Directories are copied whole. */
const VERBATIM = ['openapi.json', 'install', 'sandbox', 'src/web'];

const ENTRIES = [
  ['bin/agent-hub', 'lib/agent-hub.mjs'],
  ['bin/agent-fleet-sidecar', 'lib/agent-fleet-sidecar.mjs'],
  ['bin/agent-fleet-mcp', 'lib/agent-fleet-mcp.mjs'],
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(path.join(stage, 'lib'), { recursive: true });
mkdirSync(path.join(stage, 'bin'), { recursive: true });

for (const [entry, out] of ENTRIES) {
  await build({
    entryPoints: [path.join(ROOT, entry)],
    outfile: path.join(stage, out),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Node builtins stay external by platform:node. `jose` is the only runtime
    // dependency and it goes IN — leaving it out would put an npm install back
    // on the host, which is the thing this removes.
    banner: {
      js:
        '// Built by tools/build-host-package.mjs. Do not edit — the digest in\n' +
        '// the manifest is of this file, and editing it in place is exactly the\n' +
        '// tampering the digest exists to make visible.',
    },
    // Keep it readable. Minifying would save a little bandwidth and cost the
    // ability to read a stack trace on a box that is misbehaving, which on a
    // host this small is a bad trade.
    minify: false,
    sourcemap: false,
    logLevel: 'warning',
  });
}

for (const rel of VERBATIM) {
  cpSync(path.join(ROOT, rel), path.join(stage, rel), { recursive: true });
}

// A package.json with no dependencies — its absence of a `dependencies` block
// is a load-bearing statement, and it is also how resources.js finds the root.
writeFileSync(
  path.join(stage, 'package.json'),
  `${JSON.stringify({ name: pkg.name, version, type: 'module', bin: pkg.bin, private: true }, null, 2)}\n`,
);

// Thin shims, so `/usr/local/bin/agent-hub` keeps pointing at a path that
// exists and nobody's muscle memory changes.
for (const [entry, out] of ENTRIES) {
  const name = path.basename(entry);
  // JAVASCRIPT, NOT SH, AND THIS TOOK A HOST DOWN. This was `#!/bin/sh` with an
  // `exec node …` inside, which works when something RUNS the file — and the
  // systemd unit does not run it:
  //
  //     ExecStart=__NODE__ __DIR__/bin/agent-hub serve
  //
  // node strips the `#!` line, meets the `#` on line 2, and every packaged
  // service died at startup with `SyntaxError: Invalid or unexpected token`, in
  // a restart loop, on the first host ever converted.
  //
  // A checkout's bin/agent-hub is JS with a node shebang, so `node bin/x` and
  // `./bin/x` both work there. The packaged shim was the only artifact where
  // those two differed, and it is the one systemd invokes.
  const shim =
    `#!/usr/bin/env node\n` +
    `// Shipped by ${stageName}.\n` +
    `//\n` +
    `// JS rather than sh because the systemd unit runs \`node <this file>\`, and\n` +
    `// a shell script handed to node is a syntax error.\n` +
    `import { fileURLToPath } from 'node:url';\n` +
    `import path from 'node:path';\n` +
    `await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '${out}'));\n`;
  const file = path.join(stage, 'bin', name);
  writeFileSync(file, shim);
  chmodSync(file, 0o755);
}

const tarball = path.join(OUT, `${stageName}.tar.gz`);
// Deterministic: sorted entries, no mtimes, no owner. Two builds of the same
// commit must produce the same digest or the digest says nothing.
execFileSync('tar', [
  '--sort=name',
  '--mtime=UTC 2020-01-01',
  '--owner=0', '--group=0', '--numeric-owner',
  '--format=gnu',
  '-czf', tarball,
  '-C', OUT, stageName,
]);

const bytes = readFileSync(tarball);
const sha256 = createHash('sha256').update(bytes).digest('hex');

const manifest = {
  version,
  file: path.basename(tarball),
  sha256,
  bytes: bytes.length,
  // THE FLAG DAY, VISIBLE BEFORE IT HAPPENS. A host refuses an update that
  // would strand it from its coordinator instead of discovering the mismatch
  // afterwards, when it is no longer able to say so.
  //
  // READ FROM THE PROTOCOL, NOT FROM AN ENVIRONMENT VARIABLE. This was
  // `Number(process.env.RELEASE_PROTOCOL || 2)`, nothing ever set that
  // variable, and the literal was correct on the day it was written. So the
  // first manifest this project ever published — v0.2.1, built from code that
  // speaks v3 — advertised `"protocol": 2`.
  //
  // That is the dangerous direction. A v2 host reading it sees its own number,
  // concludes the release matches, installs v3 code and strands itself from its
  // coordinator — which is the exact failure this field exists to prevent,
  // caused by the field. A number written down in a second place is a number
  // that is wrong one release later, and this one had a default that made
  // being wrong silent.
  protocol: PROTOCOL_VERSION,
  // The two artifacts are already coupled — the entrypoint and the credential
  // broker's client live in the image — and until now nothing said so.
  sandboxImage: process.env.RELEASE_SANDBOX_IMAGE || null,
  // WHO THIS RELEASE IS FOR, and both default to "everybody" so that a release
  // built without thinking about either behaves as releases always have.
  //
  // Unlike `protocol` above, these two CANNOT be read out of the code: they are
  // facts about how a particular release is being shipped, not about what it
  // is. So they are environment variables — the thing `protocol` should never
  // have been.
  prerelease: process.env.RELEASE_PRERELEASE === 'true',
  // 0–1. A host derives its own position from its name and this version, so
  // widening a rollout only ever adds machines. Written as a number so a
  // manifest is readable: 0.25 is a quarter, not a string somebody parses.
  //
  // Absent, empty and unparseable all mean everybody. That is one line of
  // arithmetic with a long story behind it, and the story lives with the
  // function in tools/rollout.mjs rather than being repeated here.
  rollout: rolloutFraction(process.env.RELEASE_ROLLOUT),
};
writeFileSync(path.join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`${path.relative(ROOT, tarball)}  ${(bytes.length / 1048576).toFixed(1)} MB`);
console.log(`sha256 ${sha256}`);
