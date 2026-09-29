#!/usr/bin/env node
// One section of CHANGELOG.md, for whichever store is asking.
//
// WHY THIS EXISTS. Both app pipelines took their notes from
// `github.event.release.body`, falling back to the commit subject — so a build
// from a push to main told testers "Pick a task from the phone, and three
// repos worth bootstrapping", and a release told them whatever was pasted into
// the release box, which was often the PR description. Neither is a release
// note. The changelog is written once, for people, and everything downstream
// reads it.
//
//   node scripts/release-notes.mjs                 # the top section
//   node scripts/release-notes.mjs 0.2.1           # a named version
//   node scripts/release-notes.mjs --max 500       # Play's per-locale limit
//   node scripts/release-notes.mjs --version       # just the number
//
// Exits non-zero when the version asked for is not in the file, because a
// release that quietly ships empty notes is the failure this replaces.
//
// THE PARSER LIVES IN src/core/changelog.js, because a host reads the same
// file the same way to tell a phone what an update contains. One reading of
// the heading format, so the notes a store shows and the notes a phone shows
// for a version are the same notes.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sections as parse, fit } from '../src/core/changelog.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Every version section in the changelog, in file order.
 * @param {string} [text]
 */
export function sections(text = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')) {
  return parse(text);
}

export { fit };

/** @param {string[]} argv */
function main(argv) {
  const max = Number(argv[argv.indexOf('--max') + 1]) || 0;
  const wanted = argv.find((a) => /^\d+\.\d+\.\d+$/.test(a));
  const all = sections();
  if (!all.length) {
    process.stderr.write('release-notes: CHANGELOG.md has no version sections\n');
    process.exit(1);
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${all[0].version}\n`);
    return;
  }
  const found = wanted ? all.find((s) => s.version === wanted) : all[0];
  if (!found) {
    process.stderr.write(
      `release-notes: CHANGELOG.md has no section for ${wanted}. It has: ${all.map((s) => s.version).join(', ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${fit(found.body, max)}\n`);
}

// Only when run, so the parser above can be imported by a test.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
