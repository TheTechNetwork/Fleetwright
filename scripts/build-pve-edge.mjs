// The Proxmox VE edge router's two configurations, beside the setup script
// that writes one into the edge image (install/fleetwright-pve-setup, step
// `edge`). The script has no Fleetwright to build them with, so they are
// built here from the boxes' own edgeConfig (src/fleet/host/edge-router.js,
// pveEdgeConfig) and pinned in the script by SHA-256;
// test/pve-edge.test.js holds the files, the pins and this equal.
//
//   node scripts/build-pve-edge.mjs

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { pveEdgeConfig } from '../src/fleet/host/edge-router.js';

export const OUTPUTS = Object.freeze({
  filter: new URL('../install/fleetwright-pve-edge.xml', import.meta.url),
  block: new URL('../install/fleetwright-pve-edge-block.xml', import.meta.url),
});

const script = new URL('../install/fleetwright-pve-setup', import.meta.url);

if (import.meta.url === `file://${process.argv[1]}`) {
  let text = readFileSync(script, 'utf8');
  for (const [kind, file] of Object.entries(OUTPUTS)) {
    writeFileSync(file, pveEdgeConfig(kind === 'block'));
    // THE FILE'S DIGEST, as the node will check it: the bytes on disk, a
    // pin of a published file. It holds no secret (root's password is `*`).
    const sum = createHash('sha256').update(readFileSync(file)).digest('hex');
    const name = kind === 'block' ? 'EDGE_CONFIG_BLOCK_SHA' : 'EDGE_CONFIG_SHA';
    text = text.replace(new RegExp(`^${name}=[0-9a-f]*$`, 'm'), `${name}=${sum}`);
    console.log(`build-pve-edge: ${file.pathname} ${sum}`);
  }
  writeFileSync(script, text);
}
