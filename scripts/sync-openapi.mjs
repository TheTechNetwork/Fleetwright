// Regenerate the Worker's inlined copy of openapi.json.
//
// The Worker ships no files, so the contract is compiled into its bundle. That
// makes it a COPY, and a copy of a contract is a thing that drifts — which is
// the failure `test/openapi.test.js` exists to catch and which it caught
// again: a verb added to openapi.json and to the protocol was still absent
// from the Worker, so the two coordinators would have disagreed about what
// they accept.
//
// Hand-editing the copy is the thing to avoid. It is a thousand lines of
// escaped JSON inside a source file, and every edit to it is an opportunity to
// make the two differ in a way nobody reads. So this rewrites it wholesale
// from the source, and `verify.sh` runs it, so the only way to change the
// contract is to change the file the tests execute.
//
//   node scripts/sync-openapi.mjs [--check]
//
// `--check` exits non-zero if the copy is stale, without writing.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const specFile = path.join(root, 'openapi.json');
const workerFile = path.join(root, 'worker', 'src', 'worker.js');

const spec = JSON.parse(readFileSync(specFile, 'utf8'));
const source = readFileSync(workerFile, 'utf8');

const START = 'const OPENAPI = JSON.stringify(';
const begin = source.indexOf(START);
if (begin === -1) {
  console.error('sync-openapi: could not find the inlined spec in worker/src/worker.js');
  process.exit(2);
}
// The block ends at the first line that is exactly `});` — the JSON is
// pretty-printed with every closing brace indented, so this is unambiguous.
const endMarker = '\n});\n';
const end = source.indexOf(endMarker, begin);
if (end === -1) {
  console.error('sync-openapi: the inlined spec has no closing `});`');
  process.exit(2);
}

// Two-space JSON at column zero, which is exactly how the block was already
// written: the object's opening brace closes `JSON.stringify(` on the first
// line and its closing brace is the `}` in the trailing `});`. Matching that
// shape keeps a diff of this block reading as a diff of the CONTRACT rather
// than as a reflow of a thousand lines.
// NON-ASCII ESCAPED, which is how the block was already written and is worth
// keeping. The descriptions in this contract are full of em dashes, and a
// bundler, a shell or an editor with the wrong assumption about encoding
// anywhere between here and Cloudflare would corrupt them silently. Escaping
// also keeps the diff of a regeneration to the thing that actually changed
// rather than to a thousand lines of re-encoded punctuation.
const body = JSON.stringify(spec, null, 2).replace(
  /[\u0080-\uffff]/g,
  (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
);
const next = source.slice(0, begin) + START + body + ');\n' + source.slice(end + endMarker.length);

if (next === source) {
  console.log('sync-openapi: the Worker copy is current');
  process.exit(0);
}
if (process.argv.includes('--check')) {
  console.error(
    'sync-openapi: worker/src/worker.js has a STALE copy of openapi.json.\n' +
      'Run `node scripts/sync-openapi.mjs` and commit the result — do not edit the copy by hand.',
  );
  process.exit(1);
}
writeFileSync(workerFile, next);
console.log('sync-openapi: rewrote the Worker copy from openapi.json');
