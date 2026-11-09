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

/**
 * Each configuration, by the pin the script holds it to: one router or
 * either of a pair (`-a`, `-b`), filtering or dropping.
 * @type {Readonly<Record<string, { file: URL, block: boolean, node: 0|1|null }>>}
 */
export const OUTPUTS = Object.freeze({
  EDGE_CONFIG_SHA: { file: new URL('../install/fleetwright-pve-edge.xml', import.meta.url), block: false, node: null },
  EDGE_CONFIG_BLOCK_SHA: { file: new URL('../install/fleetwright-pve-edge-block.xml', import.meta.url), block: true, node: null },
  EDGE_CONFIG_A_SHA: { file: new URL('../install/fleetwright-pve-edge-a.xml', import.meta.url), block: false, node: 0 },
  EDGE_CONFIG_B_SHA: { file: new URL('../install/fleetwright-pve-edge-b.xml', import.meta.url), block: false, node: 1 },
  EDGE_CONFIG_BLOCK_A_SHA: { file: new URL('../install/fleetwright-pve-edge-block-a.xml', import.meta.url), block: true, node: 0 },
  EDGE_CONFIG_BLOCK_B_SHA: { file: new URL('../install/fleetwright-pve-edge-block-b.xml', import.meta.url), block: true, node: 1 },
});

const script = new URL('../install/fleetwright-pve-setup', import.meta.url);

if (import.meta.url === `file://${process.argv[1]}`) {
  let text = readFileSync(script, 'utf8');
  for (const [name, { file, block, node }] of Object.entries(OUTPUTS)) {
    writeFileSync(file, pveEdgeConfig(block, node));
    // THE FILE'S DIGEST, as the node will check it: the bytes on disk, a
    // pin of a published file. It holds no secret (root's password is `*`).
    const sum = createHash('sha256').update(readFileSync(file)).digest('hex');
    text = text.replace(new RegExp(`^${name}=[0-9a-f]*$`, 'm'), `${name}=${sum}`);
    console.log(`build-pve-edge: ${file.pathname} ${sum}`);
  }
  writeFileSync(script, text);
}
