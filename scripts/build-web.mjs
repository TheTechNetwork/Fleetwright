// Compile the console.
//
// Two outputs from one source, and the second is the point:
//
//   build/console/       ESM with preact left external, so `node --test` can
//                        import the components and render them to a string.
//                        The first version of this page could not be tested at
//                        all, which is how it shipped broken.
//
//   src/web/console.js   one self-contained bundle for the browser, preact
//                        included, minified. The Worker ships no files, so this
//                        gets inlined into the page.
//
// esbuild rather than a framework toolchain: it is one binary, it was already a
// dependency of the Worker build, and it does JSX without a config file.

import { build } from 'esbuild';
import { readdirSync } from 'node:fs';

const SRC = 'src/web/console';
const jsx = { jsxFactory: 'h', jsxFragment: 'Fragment', jsxImportSource: 'preact', jsx: 'automatic' };

const entries = readdirSync(SRC).filter((f) => f.endsWith('.jsx') || f.endsWith('.js')).map((f) => `${SRC}/${f}`);

// For the tests: preact stays external so one copy is shared with the runner.
await build({
  entryPoints: entries,
  outdir: 'build/console',
  format: 'esm',
  platform: 'neutral',
  bundle: false,
  ...jsx,
});

// For the browser: everything in, nothing out.
await build({
  entryPoints: [`${SRC}/app.jsx`],
  outfile: 'src/web/console.js',
  format: 'iife',
  platform: 'browser',
  bundle: true,
  minify: true,
  ...jsx,
});

console.log(`built ${entries.length} modules for tests, and one bundle for the browser`);

// The test file uses JSX too, so it gets the same treatment.
await build({
  entryPoints: ['test/console.test.jsx'],
  outfile: 'build/console.test.js',
  format: 'esm',
  platform: 'node',
  bundle: false,
  ...jsx,
});
