// The page an unauthenticated browser gets, held to the design system it
// borrows from.
//
// WHY THIS FILE EXISTS RATHER THAN A FOURTH SURFACE IN design-parity.test.js.
// That test asks whether three files agree about every token in the shared
// table. This page is a different kind of thing: it declares no tokens at all,
// it READS them out of `console.css` at startup and keeps the third it uses.
// So the question worth asking here is the opposite one — not "does it agree
// about `--accent`" but "is every `var(--…)` it references a token the
// stylesheet really declares, and does it write any colour of its own".
//
// Both halves matter and neither is visible any other way. The first fails the
// day somebody renames a token in `console.css`: the parity test is happy, the
// apps still compile, and this page silently renders with `var(--r-card)`
// resolving to nothing — a card with square corners on a screen nobody looks
// at until they are locked out of a box at midnight. The second is the rule
// that put the page here in the first place; a literal written back into
// `http.js` is exactly the fourth copy the whole arrangement exists to avoid.
//
// This reads the STRING the adapter actually serves rather than the source of
// the file that builds it. Reading the source would be a test of a template;
// what ships is the template with the stylesheet folded into it, and the fold
// is the part that can be wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HttpAdapter } from '../src/adapters/http.js';

const CSS = readFileSync(new URL('../src/web/console/console.css', import.meta.url), 'utf8');

/** The two pages, built the way the adapter builds them. */
function pages() {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'gate-page-'));
  const cfg = /** @type {any} */ ({
    stateDir,
    bind: '127.0.0.1',
    port: 0,
    token: 'unused',
    hostname: 'testbox',
    workdir: path.join(stateDir, 'work'),
    maxSessions: 1,
    loginEnabled: false,
    sandbox: false,
    sandboxCredentialsFile: '',
  });
  const adapter = new HttpAdapter(cfg, {
    sessions: /** @type {any} */ ({ list: () => [], running: () => [], binned: () => [] }),
    login: /** @type {any} */ ({ status: () => ({ loggedIn: false }), isPending: () => false }),
    token: 'unused',
  });
  rmSync(stateDir, { recursive: true, force: true });
  return { first: adapter.gatePage, refused: adapter.refusedPage };
}

const { first, refused } = pages();
const BOTH = [['the first visit', first], ['the refusal', refused]];

/** The `<style>` element's contents, which is the only styling on the page. */
function styles(/** @type {string} */ html) {
  const at = html.indexOf('<style>');
  const end = html.indexOf('</style>', at);
  assert.ok(at >= 0 && end > at, 'the page has no stylesheet');
  return html.slice(at + '<style>'.length, end);
}

/** `--name` declarations in the page's own `:root` blocks, which are the borrowed ones. */
function borrowed(/** @type {string} */ css) {
  return new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
}

test('every token the page reaches for is one the stylesheet declares', () => {
  // THE RENAME CASE. A token renamed in console.css and not here resolves to
  // nothing in a browser, silently: `var(--r-card)` with no declaration is not
  // an error, it is a square corner and a card with no shadow.
  const declared = new Set(
    [...CSS.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
  );
  for (const [which, html] of BOTH) {
    const css = styles(html);
    const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
    assert.ok(used.size > 10, `${which} references almost no tokens, which is not what this page does`);
    for (const token of used) {
      assert.ok(declared.has(token), `${which} uses ${token}, which console.css no longer declares`);
      assert.ok(borrowed(css).has(token), `${which} uses ${token} without carrying it into the page`);
    }
  }
});

test('the page writes no colour of its own', () => {
  // The rule test/design-tokens.test.js enforces on console.css, asked of the
  // one other place that renders with this palette. A hex here is a fourth
  // copy of a value that already exists in three files, on the screen least
  // likely to be looked at when one of them moves.
  //
  // The borrowed `:root` blocks are where the colours legitimately are, so
  // they are cut before the scan: what is left is this file's own rules.
  for (const [which, html] of BOTH) {
    const own = styles(html)
      .replace(/:root\s*\{[^}]*\}/g, '')
      .replace(/@media \(prefers-color-scheme:light\)\s*\{[\s\S]*?\}\s*\}/g, '');
    assert.doesNotMatch(
      own,
      /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i,
      `${which} writes a colour instead of using a token`,
    );
  }
});

test('both themes arrive, and the light one is not a partial dark one', () => {
  // The failure this guards is the one console.css had twice: a light palette
  // that overrides some of the dark values and inherits the rest, so the page
  // reads correctly until somebody's phone is in light mode and half of it is
  // still tuned for a dark room.
  for (const [which, html] of BOTH) {
    const css = styles(html);
    assert.match(css, /@media \(prefers-color-scheme:light\)/, `${which} has no light theme`);

    // Every colour token the page carries must be answered in both blocks.
    // The scale tokens (sizes, spacing, radii) do not move between themes and
    // are deliberately not required here.
    const light = css.slice(css.indexOf('@media (prefers-color-scheme:light)'));
    for (const token of ['--bg', '--card', '--inner', '--ink', '--ink-dim', '--accent', '--bad']) {
      assert.ok(light.includes(`${token}:`), `${which} does not answer ${token} in light`);
    }
  }
});

test('nothing on the page is fetched, and nothing on it is a script', () => {
  // This is served on a path with no token, so a second request is a request
  // the browser makes unauthenticated and gets a 401 for. One response, or the
  // page does not work — which also rules out a script, so the form has to be
  // a plain GET that this same route already handles.
  for (const [which, html] of BOTH) {
    assert.doesNotMatch(html, /<script/i, `${which} carries a script`);
    assert.doesNotMatch(html, /@import|url\(/i, `${which} fetches a stylesheet or a font`);
    assert.doesNotMatch(html, /<link\b/i, `${which} links something it would have to go and get`);
    assert.match(html, /<form method="get" action="\/">/, `${which} has no form to submit`);
    assert.match(html, /name="token"/, `${which} has a form that does not carry a token`);
  }
});

test('what can be tapped is 44px, and what can be focused says so', () => {
  // 44px minimum, the same number and the same reason as console.css: this
  // gets opened on a phone whether or not it was designed to. And a focus
  // outline that is removed and not replaced is the fastest way to make a page
  // unusable without a mouse — there are exactly two controls here and both
  // are on the way to the only action on the screen.
  for (const [which, html] of BOTH) {
    const css = styles(html);
    assert.equal(
      (css.match(/min-height:44px/g) || []).length, 2,
      `${which} does not give both the field and the button a 44px target`,
    );
    assert.match(css, /input:focus-visible,button:focus-visible\{outline:2px solid/, `${which} has no focus indicator`);
    assert.doesNotMatch(css, /outline:\s*(none|0)\b/, `${which} removes a focus outline`);
  }
});

test('a card with no border gets one where shadows are not painted', () => {
  // console.css restores borders under forced-colours mode because that mode
  // paints no box-shadow, and this page is separated from the ground by
  // nothing else at all. A borderless card there is text floating on a plane.
  for (const [which, html] of BOTH) {
    const css = styles(html);
    assert.match(css, /@media \(forced-colors:active\)\{[^}]*border:1px solid/, `${which} vanishes under forced colours`);
  }
});

test('the refusal is a different page, and it is a word before it is a colour', () => {
  // docs/psychology.md §7 on the smallest surface in the product: "you have
  // not tried" and "that one does not work" are different answers, and only
  // one of them is helped by an explanation of how tokens work.
  //
  // AND NEVER COLOUR ALONE (§5). The refusal carries the `x` the session
  // vocabulary already uses for broken and a sentence that reads without it;
  // the tone only agrees.
  assert.notEqual(first, refused, 'a refused token gets the same page as a first visit');
  assert.doesNotMatch(first, /not accepted/, 'the first visit already claims something was refused');
  assert.match(refused, /class="refused"/);
  assert.match(refused, /The token this browser sent was not accepted\./);
  assert.match(refused, /<span class="glyph" aria-hidden="true">x<\/span>/, 'the refusal has no glyph');
  assert.match(styles(refused), /color:var\(--bad\)/, 'the refusal does not carry the tone for refused');

  // The card wears the tone too, and only this card and only in this state —
  // "one card at a time wears a tone", docs/design-system.md.
  assert.match(styles(refused), /var\(--bad\) 55%/, 'the refused card keeps the calm hairline');
  assert.doesNotMatch(styles(first), /var\(--bad\) 55%/, 'the first visit is already wearing a tone');
});

test('the copy still says both of the true things', () => {
  // The two ways in, and they are not interchangeable: one is for a person at
  // a browser and leaves a cookie, the other is for a program and leaves
  // nothing. A page that names only the first sends everybody through the
  // cookie; a page that names only the second is no use to the person who is
  // actually reading it.
  for (const [which, html] of BOTH) {
    assert.match(html, /<code>\?token=…<\/code>/, `${which} no longer names the query parameter`);
    assert.match(html, /<code>Authorization: Bearer …<\/code>/, `${which} no longer names the header`);
  }
});

test('the token is never rendered back into the page', () => {
  // A wrong token is still a secret: it may be the right token for a different
  // box, and it is about to be in a screenshot of an error page. The refusal
  // says that something was sent and not what.
  assert.doesNotMatch(refused, /value=/, 'the form pre-fills a field');
  assert.match(refused, /type="password"/, 'the token is typed in the clear');
});
