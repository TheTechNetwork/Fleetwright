// Build the SSH terminal page both apps show (src/term/page.js) into one HTML
// file, as scripts/build-vnc.mjs builds the console's:
//
//   apps/ios/Fleetwright/term.html                 a bundle resource
//   apps/android/app/src/main/assets/term.html     an asset
//
// Committed, because the apps build in Xcode and Gradle and neither runs
// node; test/term-page.test.js fails when either copy is not what this builds.
//
//   node scripts/build-term.mjs

import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const OUTPUTS = ['apps/ios/Fleetwright/term.html', 'apps/android/app/src/main/assets/term.html'];

/** The page, as both apps carry it. */
export async function termPage() {
  const out = await build({
    entryPoints: ['src/term/page.js'],
    format: 'esm',
    platform: 'browser',
    target: ['safari16', 'chrome110'],
    bundle: true,
    minify: true,
    legalComments: 'none',
    write: false,
  });
  const js = out.outputFiles[0].text.replaceAll('</script', '<\\/script');
  const css = readFileSync('node_modules/@xterm/xterm/css/xterm.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
  const { version } = JSON.parse(readFileSync('node_modules/@xterm/xterm/package.json', 'utf8'));
  return `<!doctype html>
<!-- Built by scripts/build-term.mjs from src/term/page.js. Do not edit.
     Includes xterm.js ${version} (https://github.com/xtermjs/xterm.js), MIT. -->
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>${css} html,body{margin:0;height:100%;background:#000;overflow:hidden}#screen{position:absolute;inset:4px}</style>
</head><body><div id="screen"></div>
<script type="module">${js}</script></body></html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const page = await termPage();
  for (const path of OUTPUTS) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, page);
  }
  console.log(`wrote the terminal page (${Math.round(page.length / 1024)} KB) to ${OUTPUTS.join(' and ')}`);
}
