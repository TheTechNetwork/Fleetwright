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
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

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

// --- one openable file ------------------------------------------------------
//
// The bundle, the stylesheet and a shell, inlined. Not a convenience: the first
// version of this page was reviewed by READING it, rendered a topbar and
// nothing else, and nobody found out until somebody opened it on a phone. A
// design that cannot be opened has not been reviewed.

const preview = await build({
  entryPoints: [`${SRC}/preview.jsx`],
  outfile: 'build/preview.bundle.js',
  format: 'iife',
  platform: 'browser',
  bundle: true,
  minify: true,
  write: false,
  ...jsx,
});

const css = readFileSync(`${SRC}/console.css`, 'utf8');
const js = preview.outputFiles[0].text;

// PRE-RENDERED, and this is not an optimisation.
//
// The first version of this page was opened in a file viewer inside an app,
// which renders HTML and CSS in a sandbox and does not execute scripts. It
// showed a title bar and nothing else — measured afterwards: 40 characters with
// JavaScript disabled. The JSX rebuild was strictly WORSE there, at zero
// characters, because every pixel of it came from a script.
//
// So the markup is rendered here, at build time, and shipped in the file. With
// scripts, the page hydrates and the switcher works. Without, you still see the
// console. A design nobody can open has not been reviewed.
const { render: renderToString } = await import('preact-render-to-string');
const { h } = await import('preact');
const { Console } = await import('../build/console/components.js');
const { SCENARIOS } = await import('../build/console/demo.js');
const prerendered = renderToString(h(Console, { snap: SCENARIOS.calm.snap }));

mkdirSync('build', { recursive: true });
writeFileSync(
  'build/console-preview.html',
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleetwright console</title>
<style>
${css}
.preview-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:2}
.preview-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-dim)}
.preview-pick{flex:1;max-width:24rem;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:8px;min-height:38px;padding:0 10px;font:inherit;font-size:.9rem}
</style>
</head>
<body>
<div id="console-root">${prerendered}</div>
<script>${js}</script>
</body>
</html>
`,
);
console.log('and one openable preview at build/console-preview.html');
