// Build the VM console page both apps show (src/vnc/page.js) into one HTML
// file, noVNC inlined, and write it where each app reads it:
//
//   apps/ios/Fleetwright/vnc.html                 a bundle resource
//   apps/android/app/src/main/assets/vnc.html     an asset
//
// One file, no other requests: the page is loaded from a string with no base
// URL, so it can fetch nothing and reach nothing. Both copies are committed,
// because the apps build in Xcode and Gradle and neither runs node; the test
// in test/vnc-page.test.js rebuilds it and fails when a copy differs, which
// is how a noVNC update from Renovate says it needs this run
// (`npm run vnc`).

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The address both apps load the page under. A string loaded with no base is
 * not a secure context, and noVNC expects one. This one resolves nowhere, and
 * the page's policy lets it fetch nothing anyway.
 */
export const BASE = 'https://console.fleetwright.invalid/';

export const OUTPUTS = ['apps/ios/Fleetwright/vnc.html', 'apps/android/app/src/main/assets/vnc.html'];

/** The page, as both apps carry it. */
export async function vncPage() {
  const out = await build({
    entryPoints: ['src/vnc/page.js'],
    format: 'esm',
    platform: 'browser',
    target: ['safari16', 'chrome110'],
    bundle: true,
    minify: true,
    legalComments: 'none',
    write: false,
  });
  const js = out.outputFiles[0].text.replaceAll('</script', '<\\/script');
  const { version } = JSON.parse(readFileSync('node_modules/@novnc/novnc/package.json', 'utf8'));
  // The black around the picture is the machine's own screen edge, not one
  // of the apps' colours: the apps draw their status around this view.
  return `<!doctype html>
<!-- Built by scripts/build-vnc.mjs from src/vnc/page.js. Do not edit.
     Includes noVNC ${version} (https://github.com/novnc/noVNC), MPL-2.0. -->
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:">
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#screen{position:absolute;inset:0}#typing{position:absolute;left:-1000px;top:0;width:1px;height:1px;opacity:0}</style>
</head><body><div id="screen"></div><textarea id="typing" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"></textarea>
<script type="module">${js}</script></body></html>
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const page = await vncPage();
  for (const path of OUTPUTS) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, page);
  }
  console.log(`wrote the console page (${Math.round(page.length / 1024)} KB) to ${OUTPUTS.join(' and ')}`);
}
