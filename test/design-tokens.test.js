// The console's design system, held to being a system.
//
// A stylesheet is the one artefact in this repo where a mistake is invisible
// to every other check: it parses, it bundles, it ships, and the first person
// to find out that the light palette lost a colour is the person reading the
// page in daylight. `console.css` used to carry its light theme as a partial
// override of its dark one, and the two drifted twice.
//
// So the claims the design makes about itself are asserted here, as text. Not
// "does it look right" — nothing in a terminal can answer that — but the four
// things that are true or false regardless of taste: every value is a token,
// the two light palettes agree, the scale has no values off it, and the page
// still renders with no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSS = readFileSync(new URL('../src/web/console/console.css', import.meta.url), 'utf8');
/** The same file with its commentary gone, so a rule is never confused with a note about one. */
const CLEAN = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The rules of a stylesheet, flattened, with comments gone.
 *
 * Deliberately tiny: this file has no nested rules, so a scanner that tracks
 * at-rule depth and reads each rule body to its closing brace is the whole
 * parser. A dependency would be a larger promise than the job.
 */
function rules(/** @type {string} */ css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  /** @type {{ selector: string, at: string, body: string }[]} */
  const out = [];
  const stack = [];
  let prelude = '';
  let i = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (c === '{') {
      const p = prelude.trim();
      prelude = '';
      if (p.startsWith('@')) {
        stack.push(p);
        i += 1;
        continue;
      }
      const end = clean.indexOf('}', i);
      assert.ok(end > 0, `unterminated rule: ${p}`);
      out.push({ selector: p, at: stack.join(' '), body: clean.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '}') {
      stack.pop();
      prelude = '';
      i += 1;
      continue;
    }
    prelude += c;
    i += 1;
  }
  return out;
}

/** `--name: value` pairs, in source order. */
function declarations(/** @type {string} */ body) {
  return body
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const at = d.indexOf(':');
      return { prop: d.slice(0, at).trim(), value: d.slice(at + 1).trim() };
    })
    .filter((d) => d.prop);
}

const RULES = rules(CSS);
const PALETTES = RULES.filter((r) => r.selector.startsWith(':root'));
const COMPONENTS = RULES.filter((r) => !r.selector.startsWith(':root'));

test('the palette is the only place a colour is written down', () => {
  // Every tone is reinforcement for a word and a glyph (docs/psychology.md §5),
  // which only holds if a tone can be changed in one place. A literal in a rule
  // is a colour that exists in exactly one theme, and it will be the dark one.
  for (const rule of COMPONENTS) {
    for (const { prop, value } of declarations(rule.body)) {
      assert.doesNotMatch(
        value,
        /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i,
        `${rule.selector} { ${prop} } writes a colour instead of using a token`,
      );
    }
  }
});

test('the two light palettes are one palette', () => {
  // Light is declared twice on purpose — once for the system preference and
  // once for an explicit choice, so the toggle wins in both directions. Twice
  // is also how they stop matching, and the failure is silent: the page looks
  // right until somebody flips the switch.
  const map = (/** @type {{ body: string }} */ r) =>
    Object.fromEntries(declarations(r.body).map((d) => [d.prop, d.value]));
  const preferred = PALETTES.find((r) => r.at.includes('prefers-color-scheme: light'));
  const chosen = PALETTES.find((r) => r.selector.includes("[data-theme='light']"));
  assert.ok(preferred, 'no light palette for the system preference');
  assert.ok(chosen, 'no light palette for an explicit choice');
  assert.deepEqual(map(chosen), map(preferred), 'the chosen and preferred light themes disagree');
});

test('nothing on the page is fetched, so it opens with no network', () => {
  // The console ships as one inlined file. It has to render inside a file
  // viewer that will not run a script and on a phone that is not online — a
  // webfont from a CDN turns "openable" into "openable if you are online",
  // which is the property the whole build exists to keep. Inter Tight is used
  // when the machine already has it, and the system face carries it otherwise.
  assert.doesNotMatch(CLEAN, /@import/, 'the stylesheet imports something');
  assert.doesNotMatch(CLEAN, /url\(/, 'the stylesheet fetches something');
  const font = declarations(PALETTES[0].body).find((d) => d.prop === '--font');
  assert.ok(font, 'no type family token');
  assert.match(font.value, /^'Inter Tight'/, 'the design face is not first in the stack');
  assert.match(font.value, /sans-serif$/, 'the stack does not end somewhere that always exists');
});

test('every step of space, every radius and every size comes off the scale', () => {
  // "Dense and predictable" is a claim about the numbers, and a stylesheet
  // enforces it or it is decoration in a comment. `0`, `auto`, `inherit` and
  // percentages are allowed; a fresh px value is not.
  const scaled = /^(padding|margin|gap|border-radius|font-size|letter-spacing)$/;
  for (const rule of COMPONENTS) {
    for (const { prop, value } of declarations(rule.body)) {
      if (!scaled.test(prop)) continue;
      for (const part of value.split(/\s+(?![^(]*\))/)) {
        if (/^(0|auto|inherit|normal|\d+%)$/.test(part) || part.startsWith('var(--')) continue;
        assert.fail(`${rule.selector} { ${prop}: ${value} } uses ${part}, which is off the scale`);
      }
    }
  }
});

test('the system the docs describe is the system in the file', () => {
  // docs/console-design.md §5 names these. A token renamed in one and not the
  // other is a design doc that describes a page nobody is looking at.
  const dark = Object.fromEntries(declarations(PALETTES[0].body).map((d) => [d.prop, d.value]));
  for (const token of [
    '--t-greeting', '--t-title', '--t-section', '--t-body', '--t-body-sm', '--t-label', '--t-micro',
    '--ls-greeting', '--ls-title', '--ls-section',
    '--s-page', '--s-group', '--s-group-tight', '--s-in', '--s-in-tight', '--s-hair',
    '--r-frame', '--r-card', '--r-card-sm', '--r-row', '--r-chip', '--r-round',
    '--ring', '--highlight', '--shadow-drop', '--card-shadow',
    '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5',
  ]) {
    assert.ok(dark[token], `${token} is documented and missing`);
  }
  assert.equal(dark['--accent-deep'], '#3866D6', 'the primary accent moved');
  assert.equal(dark['--s-page'], '26px', 'the page margin moved');
  assert.equal(dark['--r-frame'], '54px', 'the device frame radius moved');

  // Headings are tightened between -0.7px and -0.9px, and nothing smaller is
  // tightened at all: negative tracking on 13px body text costs legibility and
  // buys nothing.
  for (const name of ['--ls-greeting', '--ls-title', '--ls-section']) {
    const px = Number.parseFloat(dark[name]);
    assert.ok(px <= -0.7 && px >= -0.9, `${name} is ${dark[name]}, outside the heading range`);
  }
  const tightened = COMPONENTS.filter((r) => declarations(r.body).some((d) => d.prop === 'letter-spacing'));
  for (const rule of tightened) {
    const value = declarations(rule.body).find((d) => d.prop === 'letter-spacing')?.value;
    assert.match(
      String(value),
      /var\(--ls-(greeting|title|section)\)|normal/,
      `${rule.selector} tightens text that is not a heading`,
    );
  }
});

test('a card is separated without a border, and gets one back where shadows are not painted', () => {
  // Zero visible borders is the look: an inset highlight, a soft drop shadow
  // and a 1px ring. Forced-colours mode paints none of those, and a borderless
  // card there is three panes of text running together — so the borders come
  // back in exactly that mode and nowhere else.
  const cards = COMPONENTS.filter((r) => /^\.(confidence|host|ask|srow)$/.test(r.selector.trim()));
  assert.equal(cards.length, 4, 'the cards are not the cards this test thinks they are');
  for (const card of cards) {
    for (const { prop, value } of declarations(card.body)) {
      if (prop === 'border') assert.equal(value, '0', `${card.selector} draws a border`);
      assert.doesNotMatch(prop, /^border-(top|right|bottom|left|width|style|color)$/, `${card.selector} draws an edge`);
    }
    assert.ok(
      declarations(card.body).some((d) => d.prop === 'box-shadow'),
      `${card.selector} has nothing separating it from the page`,
    );
  }
  const forced = COMPONENTS.filter((r) => r.at.includes('forced-colors: active'));
  assert.ok(forced.length, 'nothing is drawn for forced-colours mode');
  assert.ok(
    forced.some((r) => declarations(r.body).some((d) => d.prop === 'border')),
    'forced-colours mode gets no border back',
  );
});
