// One design system, three surfaces, and the numbers held equal across them.
//
// THE FAILURE THIS EXISTS FOR is quiet. The console's greeting is 26px, the
// iOS greeting is 26pt and the Android greeting is 26sp, and nothing about that
// arrangement keeps them equal: somebody moves one, two surfaces disagree, and
// the only way to notice is to hold two phones next to a laptop. Same for the
// accent, the card radius, the page margin and every state colour — the parts
// of a product that are supposed to make three screens feel like one thing.
//
// docs/app-parity.md already makes this argument for behaviour and answers it
// with a table both apps run against. A token cannot be run, but it does not
// need to be: it IS its literal, written in the source, so reading the three
// files is not a proxy for the check — it is the check.
//
// WHAT THIS CANNOT SEE, said plainly: a token that is declared and never used.
// The per-surface tests are what cover that — test/design-tokens.test.js fails
// a colour written outside the palette in the stylesheet, and the apps' own
// builds fail an unresolved symbol. What this file guarantees is narrower and
// is the thing nothing else could say: where a token exists in more than one
// place, the places agree.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const TABLE = JSON.parse(read('test/fixtures/parity/design-tokens.json'));
const CSS = read('src/web/console/console.css');
const SWIFT = read('apps/ios/Fleetwright/Design.swift');
const KOTLIN = read('apps/android/app/src/main/java/network/thetech/fleetwright/Design.kt');

/** Source with its commentary gone, so a note about a token is never read as one. */
const bare = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * The body of `<opener> { … }`, brace-matched.
 *
 * Deliberately tiny, and it can be: these are three files written to be read
 * this way. A parser for three languages would be a larger promise than the job
 * and a second thing to be wrong.
 */
function block(/** @type {string} */ source, /** @type {string} */ opener) {
  const at = source.indexOf(opener);
  assert.ok(at >= 0, `no ${opener} in this file`);
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(source.indexOf('{', at) + 1, i);
    }
  }
  assert.fail(`${opener} is never closed`);
}

const CSS_BARE = bare(CSS);
const SWIFT_BARE = bare(SWIFT);
const KOTLIN_BARE = bare(KOTLIN);

/**
 * `--t-greeting` from `greeting`, which is the naming rule and not a lookup table.
 *
 * A capital starts a new word and so does a digit: `bodySmall` is
 * `--t-body-small` and `chart1` is `--chart-1`.
 */
const cssName = (/** @type {string} */ prefix, /** @type {string} */ token) =>
  prefix + token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).replace(/(\d)/g, '-$1');

/** Every `--name: value` in the stylesheet's base palette, with one level of `var()` resolved. */
function cssTokens() {
  const root = block(CSS_BARE, ':root {');
  /** @type {Record<string, string>} */
  const out = {};
  for (const [, name, value] of root.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  for (const [name, value] of Object.entries(out)) {
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    if (ref) out[name] = out[ref[1]] ?? value;
  }
  return out;
}

/** The light overrides, which fall through to the base palette exactly as the cascade does. */
function cssLight() {
  const base = cssTokens();
  const chosen = block(CSS_BARE, ":root[data-theme='light'] {");
  /** @type {Record<string, string>} */
  const out = { ...base };
  for (const [, name, value] of chosen.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  for (const [name, value] of Object.entries(out)) {
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    if (ref) out[name] = out[ref[1]] ?? value;
  }
  return out;
}

/** A CSS length in px, whatever it was written in. Sizes are rem so a reader's setting moves them. */
function px(/** @type {string} */ value) {
  const rem = value.match(/^(-?[\d.]+)rem$/);
  if (rem) return Number(rem[1]) * 16;
  const raw = value.match(/^(-?[\d.]+)px$/);
  assert.ok(raw, `${value} is neither rem nor px`);
  return Number(raw[1]);
}

const BASE = cssTokens();
const LIGHT = cssLight();

test('every size, step and radius is the same number on all three surfaces', () => {
  for (const [scale, spec] of Object.entries(TABLE.scales)) {
    const swift = block(SWIFT_BARE, `enum ${spec.swift.split('.').pop()} {`);
    const kotlin = block(KOTLIN_BARE, `object ${spec.kotlin.split('.').pop()} {`);

    for (const [token, expected] of Object.entries(spec.tokens)) {
      const css = BASE[cssName(spec.cssPrefix, token)];
      assert.ok(css, `${scale}.${token} has no ${cssName(spec.cssPrefix, token)} in console.css`);
      assert.equal(px(css), expected, `console.css disagrees about ${scale}.${token}`);

      const inSwift = swift.match(new RegExp(`static let ${token}: CGFloat = (-?[\\d.]+)`));
      assert.ok(inSwift, `${scale}.${token} is missing from Design.swift`);
      assert.equal(Number(inSwift[1]), expected, `Design.swift disagrees about ${scale}.${token}`);

      // `26.sp`, `26.dp`, or `(-0.9).sp` for the tracking, which is negative.
      const inKotlin = kotlin.match(new RegExp(`val ${token} = \\(?(-?[\\d.]+)\\)?\\.(sp|dp)`));
      assert.ok(inKotlin, `${scale}.${token} is missing from Design.kt`);
      assert.equal(Number(inKotlin[1]), expected, `Design.kt disagrees about ${scale}.${token}`);
    }
  }
});

test('a scale gains a token in one place or in all three', () => {
  // THE HALF THE LOOP ABOVE CANNOT CATCH. Checking the table against the three
  // files proves nothing about a token that is in a file and not in the table —
  // which is exactly what an app-only addition looks like, and it is how two
  // surfaces start to differ while every existing check stays green.
  for (const [scale, spec] of Object.entries(TABLE.scales)) {
    const expected = Object.keys(spec.tokens).sort();
    const swift = [...block(SWIFT_BARE, `enum ${spec.swift.split('.').pop()} {`)
      .matchAll(/static let (\w+): CGFloat/g)].map((m) => m[1]).sort();
    const kotlin = [...block(KOTLIN_BARE, `object ${spec.kotlin.split('.').pop()} {`)
      .matchAll(/val (\w+) = \(?-?[\d.]+\)?\.(?:sp|dp)/g)].map((m) => m[1]).sort();
    assert.deepEqual(swift, expected, `Design.swift's ${scale} scale is not the table's`);
    assert.deepEqual(kotlin, expected, `Design.kt's ${scale} scale is not the table's`);
  }
});

test('every colour is the same colour on all three surfaces, in both themes', () => {
  const colours = Object.entries(TABLE.colours).filter(([name]) => !name.startsWith('$'));
  const swift = block(SWIFT_BARE, 'enum Palette {');
  const kotlin = block(KOTLIN_BARE, 'object Palette {');

  for (const [token, pair] of colours) {
    const css = cssName('--', token);
    assert.equal(BASE[css]?.toLowerCase(), pair.dark, `console.css disagrees about ${token} in dark`);
    assert.equal(LIGHT[css]?.toLowerCase(), pair.light, `console.css disagrees about ${token} in light`);

    // `static let bg = adaptive(dark: 0x0b0d10, light: 0xf7f8fa)` — the ring and
    // the shadow are built by a different helper on purpose, so they are not
    // matched here and are not in the table.
    const inSwift = swift.match(
      new RegExp(`static let ${token} = adaptive\\(dark: 0x([0-9a-fA-F]{6}), light: 0x([0-9a-fA-F]{6})\\)`),
    );
    assert.ok(inSwift, `${token} is missing from Design.swift`);
    assert.equal(`#${inSwift[1].toLowerCase()}`, pair.dark, `Design.swift disagrees about ${token} in dark`);
    assert.equal(`#${inSwift[2].toLowerCase()}`, pair.light, `Design.swift disagrees about ${token} in light`);

    const inKotlin = kotlin.match(
      new RegExp(`val ${token} = Tone\\(dark = 0xFF([0-9a-fA-F]{6}), light = 0xFF([0-9a-fA-F]{6})\\)`),
    );
    assert.ok(inKotlin, `${token} is missing from Design.kt`);
    assert.equal(`#${inKotlin[1].toLowerCase()}`, pair.dark, `Design.kt disagrees about ${token} in dark`);
    assert.equal(`#${inKotlin[2].toLowerCase()}`, pair.light, `Design.kt disagrees about ${token} in light`);
  }
});

test('the accent is one value, and it is never a state', () => {
  // Two claims the design makes that a token comparison would otherwise let
  // through. `#3866D6` is the brand, unchanged by theme — dark lifts only the
  // *interactive* tint so a hairline clears the ground — and `active`, the
  // colour of a session that is working, is deliberately not a second indigo:
  // "working" must not be mistakable for "tappable".
  assert.equal(TABLE.colours.accentDeep.dark, '#3866d6');
  assert.equal(TABLE.colours.accentDeep.light, '#3866d6');
  assert.notEqual(TABLE.colours.active.dark, TABLE.colours.accent.dark);
  assert.notEqual(TABLE.colours.active.light, TABLE.colours.accent.light);
});

test('the table says why it exists, in the file that has to be edited to break it', () => {
  // Every fixture here carries its argument. One that does not becomes a list
  // of magic numbers within a year, and the next person deletes a case they
  // cannot see the point of.
  assert.ok(Array.isArray(TABLE.$comment) && TABLE.$comment.join(' ').length > 400);
  for (const spec of Object.values(TABLE.scales)) {
    assert.equal(typeof spec.unit, 'string', 'a scale does not say what its numbers are in');
    assert.ok(Object.keys(spec.tokens).length > 0);
  }
});
