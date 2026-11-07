// The words on screen, held to being a person's.
//
// `docs/reviews/copy-2026-11-06.md` found the two apps explaining their
// reasoning in place of the answer: rows that said what was checked and from
// where, footers that were documentation, and the codebase's own nouns (box,
// minter, sealed, the line, way out) standing in for the person's. The fix was
// a rule in `docs/design-system.md` ("Words") and a rewrite of every screen.
//
// The rule's first half, what a row may say, is a judgement, and no test here
// can hold it. The second half is checkable: a list of words that belong to
// the code and never to a sentence a person reads. This fails a sentence in
// either app that uses one, the way `design-tokens.test.js` fails a colour
// written outside the palette.
//
// A sentence is a string literal with a space in it. Keys, identifiers,
// commands and URLs have none, and a comment is not a string. The scanner is
// a character walk, not a regex over the whole file, because `//` inside a
// URL inside a string is not a comment, and a quote inside a comment is not a
// string.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const IOS = 'apps/ios/Fleetwright/';
const ANDROID = 'apps/android/app/src/main/java/network/thetech/fleetwright/';

/** The words, each with the one a person says instead. The regexes are case-insensitive and whole-word. */
const RETIRED = [
  // THE FLEET AS AN ACTOR: "the fleet said", "Asking the fleet". As a place
  // ("in the fleet", "the fleet's repository", the screen title "Change what
  // the fleet may use") it is where things are, which is allowed.
  [/\basking the fleet\b|\bthe fleet\s+(?:did|does|said|says|refus\w*|pays|paid|no longer|could|cannot|can't|has|have|had|picks|picked|dispatch\w*|answer\w*|is|was|will|asks|asked|sends|sent|keeps|kept|places|placed|closed|tries|tried|knows|knew|holds|held|makes|made|starts|started|decides|allows|lets|relays|carries)\b/, 'name the machine, or "your fleet" as a place; the fleet is never the actor of a sentence'],
  [/\bthe coordinator\b/, 'your fleet, or nothing'],
  [/\bboxe?s?\b/, 'machine'],
  [/\bminter\b/, 'nothing: custody detail goes under a disclosure'],
  [/\bseal(?:ed|s)\b/, 'saved, or nothing'],
  [/\bway out\b/, 'internet access'],
  [/\bhold(?:s|ing)? (?:the|its|this|your) pool\b|\bholder\b/, 'manages'],
  [/\b(?:the|its|a new|that) line\b|\bhand(?:s|ed|ing)? (?:over|back)\b/, 'the token, under a disclosure; on the page, "added"'],
  [/\bcannot tell\b/, 'Unknown'],
  [/\breadmit/, 'let it back in'],
  // "Let it in" stays as the button's verb: it names the one action. The
  // narration ("asks to join", "lets it in by itself") is what goes.
  [/\b(?:asks?|asked|asking) to join\b|\blets it in\b/, 'joins / approve'],
];

/** Sentences allowed to keep a retired word, each with its reason. Exact strings, after unescaping nothing. */
const ALLOWED = new Map([
  // THE BANNER KEEPS ITS BASIS (docs/design-system.md, Words): the one line
  // the second sentence was argued for in psychology.md, and the fixture
  // test/fixtures/parity/reassurance.json holds both phones to it.
  ['The fleet has not yet said which machines report, so this cannot say whether anything is running.', 'Reassurance.basis'],
  ['The coordinator has no health from any machine, so this cannot say whether anything is running.', 'Reassurance.basis'],
]);

/**
 * Every string literal in a Swift or Kotlin source that contains a space,
 * with comments skipped. @param {string} src
 */
function sentences(src) {
  /** @type {{ line: number, text: string }[]} */
  const out = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '\n') { line += 1; i += 1; continue; }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k += 1) if (src[k] === '\n') line += 1;
      i = stop;
      continue;
    }
    if (c === '"') {
      // A triple-quoted literal is read to its closing triple quote; a plain
      // one to the next unescaped quote on the line.
      const triple = d === '"' && src[i + 2] === '"';
      let j = i + (triple ? 3 : 1);
      let text = '';
      const start = line;
      while (j < n) {
        if (src[j] === '\\') { text += src[j] + (src[j + 1] ?? ''); j += 2; continue; }
        if (triple ? src.startsWith('"""', j) : src[j] === '"') break;
        if (src[j] === '\n') { if (!triple) break; line += 1; }
        text += src[j];
        j += 1;
      }
      i = j + (triple ? 3 : 1);
      // AN INTERPOLATION IS NOT A WORD: `\(one.box)` and `$box` name a
      // variable, not what the person reads, so they are blanked before the
      // sentence is judged (the text kept is the literal as written).
      const said = text.replace(/\\\([^)]*\)/g, ' ').replace(/\$\{[^}]*\}/g, ' ').replace(/\$\w+/g, ' ');
      if (/\S \S/.test(text)) out.push({ line: start, text, said });
      continue;
    }
    i += 1;
  }
  return out;
}

const files = (/** @type {string} */ dir, /** @type {string} */ ext) =>
  readdirSync(new URL(dir, root)).filter((f) => f.endsWith(ext)).map((f) => dir + f);

const sources = [...files(IOS, '.swift'), ...files(ANDROID, '.kt')];

test('the scanner reads strings and skips comments', () => {
  const got = sentences('let a = "two words" // "not this one"\n/* "nor this" */ val b = "https://x.y/z path" ; "nospace"');
  assert.deepEqual(got.map((s) => s.text), ['two words', 'https://x.y/z path']);
});

test('no sentence on either phone uses a word that belongs to the code', () => {
  /** @type {string[]} */
  const hits = [];
  for (const file of sources) {
    const src = readFileSync(new URL(file, root), 'utf8');
    for (const { line, text, said } of sentences(src)) {
      if (ALLOWED.has(text)) continue;
      for (const [re, say] of RETIRED) {
        if (new RegExp(re.source, 'i').test(said)) hits.push(`${file}:${line}  ${JSON.stringify(text)}\n    ${re}  →  say: ${say}`);
      }
    }
  }
  assert.equal(hits.length, 0, `${hits.length} sentence(s) use a retired word:\n${hits.join('\n')}`);
});

test('the allow list names only sentences that still exist', () => {
  const all = new Set();
  for (const file of sources) for (const { text } of sentences(readFileSync(new URL(file, root), 'utf8'))) all.add(text);
  for (const text of ALLOWED.keys()) assert.ok(all.has(text), `allowed but gone: ${JSON.stringify(text)}`);
});
