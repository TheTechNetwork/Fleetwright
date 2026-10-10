// Work out, from an OPNsense nano image, the bytes that give its
// configuration file a whole block (src/fleet/host/ufs-room.js), check them
// the way fsck would, and print them for OPNSENSE_IMAGE.grow in
// src/fleet/host/edge-router.js.
//
// For a new OPNsense release: download its nano image, check it against the
// published SHA-256, unpack it (`bzip2 -dc … > nano.img`; a sparse file is
// enough), find the configuration's inode (its size field is where the old
// release's sizeField pointed, or `ls -i` on a mounted copy), and run:
//
//   node scripts/opnsense-room.mjs nano.img <inode>
//
// Nothing is written to the image.

import { openSync, readSync } from 'node:fs';

import { planRoom, checkRoom } from '../src/fleet/host/ufs-room.js';

const [file, inodeArg] = process.argv.slice(2);
if (!file || !/^\d+$/.test(inodeArg || '')) {
  console.error('usage: node scripts/opnsense-room.mjs <nano.img> <inode>');
  process.exit(2);
}
const fd = openSync(file, 'r');
/** @param {number} offset @param {number} length */
const read = (offset, length) => {
  const b = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, b, got, length - got, offset + got);
    if (!n) break;
    got += n;
  }
  return b;
};
const plan = planRoom(read, { inode: Number(inodeArg), room: 32768 });
checkRoom(read, plan);
console.log(JSON.stringify(plan, null, 2));
