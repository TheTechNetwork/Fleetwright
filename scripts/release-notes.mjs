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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** `## 0.2.1 — 2026-09-02`. The dash may be an em dash or a hyphen. */
const HEADING = /^##\s+(\d+\.\d+\.\d+)\s*(?:[—-]\s*(.*))?$/;

/**
 * Every version section in the changelog, in file order.
 * @param {string} [text]
 * @returns {Array<{ version: string, date: string, body: string }>}
 */
export function sections(text = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')) {
  const lines = text.split('\n');
  /** @type {Array<{ version: string, date: string, body: string }>} */
  const out = [];
  /** @type {{ version: string, date: string, lines: string[] } | null} */
  let current = null;
  for (const line of lines) {
    const m = HEADING.exec(line.trim());
    if (m) {
      if (current) out.push({ version: current.version, date: current.date, body: current.lines.join('\n').trim() });
      current = { version: m[1], date: (m[2] || '').trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) out.push({ version: current.version, date: current.date, body: current.lines.join('\n').trim() });
  return out;
}

/**
 * Fit notes into a store's limit WITHOUT cutting a word in half.
 *
 * Play refuses more than 500 characters per locale and refusing is the good
 * case — a truncated sentence that ends mid-clause reads as a bug in the app.
 * Trimmed at a paragraph boundary where one fits, at a line otherwise, and the
 * ellipsis says a fuller version exists rather than pretending this is all.
 *
 * @param {string} body
 * @param {number} max
 */
export function fit(body, max) {
  if (!max || body.length <= max) return body;
  const tail = '\n\nFull notes: github.com/TheTechNetwork/Fleetwright/blob/main/CHANGELOG.md';
  const room = max - tail.length;
  // A negative or tiny budget means the caller's limit cannot hold a pointer
  // as well as prose. Prose wins: a note that is only a URL is not a note.
  if (room < 80) return body.slice(0, max);
  let cut = body.lastIndexOf('\n\n', room);
  if (cut < room / 2) cut = body.lastIndexOf('\n', room);
  if (cut < room / 2) cut = body.lastIndexOf(' ', room);
  if (cut < 0) cut = room;
  return body.slice(0, cut).trimEnd() + tail;
}

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
