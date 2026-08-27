// Does the SHIPPED page put content on screen?
//
// This test exists because one did not. The first console was reviewed by
// reading it, passed "does it parse" and "does it avoid innerHTML", and was
// sent to a phone where it rendered a title bar and nothing else. Neither I nor
// the agent that wrote it had ever executed it.
//
// So this is deliberately not a component test — test/console.test.jsx already
// renders components in isolation and would have passed while the page was
// blank. This one takes the BUILT ARTIFACT, runs its script in a DOM it did not
// choose, and measures how much text a person would actually see.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** The smallest DOM preact will actually mount into. */
function browser() {
  const node = (tag) => ({
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    attributes: /** @type {Record<string, string>} */ ({}),
    style: {},
    _text: '',
    nodeType: 1,
    parentNode: /** @type {any} */ (null),
    firstChild: /** @type {any} */ (null),
    nextSibling: null,
    setAttribute(/** @type {string} */ k, /** @type {any} */ v) {
      this.attributes[k] = String(v);
    },
    getAttribute(/** @type {string} */ k) {
      return this.attributes[k] ?? null;
    },
    removeAttribute(/** @type {string} */ k) {
      delete this.attributes[k];
    },
    appendChild(/** @type {any} */ c) {
      c.parentNode = this;
      this.childNodes.push(c);
      this.firstChild = this.childNodes[0];
      return c;
    },
    insertBefore(/** @type {any} */ c, /** @type {any} */ ref) {
      c.parentNode = this;
      const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, c);
      this.firstChild = this.childNodes[0];
      return c;
    },
    removeChild(/** @type {any} */ c) {
      const i = this.childNodes.indexOf(c);
      if (i >= 0) this.childNodes.splice(i, 1);
      this.firstChild = this.childNodes[0] ?? null;
      return c;
    },
    addEventListener() {},
    removeEventListener() {},
    contains() {
      return false;
    },
    get textContent() {
      return this._text + this.childNodes.map((/** @type {any} */ c) => c.textContent ?? '').join('');
    },
    set textContent(v) {
      this._text = String(v);
      this.childNodes = [];
      this.firstChild = null;
    },
  });
  const text = (/** @type {any} */ t) => ({
    nodeType: 3,
    data: String(t),
    parentNode: null,
    get textContent() {
      return this.data;
    },
    set textContent(v) {
      this.data = String(v);
    },
  });

  const root = node('div');
  root.attributes.id = 'console-root';
  const prev = { document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame };

  globalThis.document = /** @type {any} */ ({
    createElement: node,
    createElementNS: (/** @type {any} */ _ns, /** @type {any} */ t) => node(t),
    createTextNode: text,
    getElementById: (/** @type {string} */ id) => (id === 'console-root' ? root : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    body: node('body'),
    documentElement: node('html'),
  });
  globalThis.window = /** @type {any} */ ({
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (/** @type {any} */ f) => {
      f(0);
      return 0;
    },
    location: { href: 'https://x/' },
  });
  globalThis.requestAnimationFrame = /** @type {any} */ ((f) => {
    f(0);
    return 0;
  });

  return {
    root,
    restore() {
      globalThis.document = /** @type {any} */ (prev.document);
      globalThis.window = /** @type {any} */ (prev.window);
      globalThis.requestAnimationFrame = /** @type {any} */ (prev.raf);
    },
  };
}

test('the built page renders something a person can read', (t) => {
  const html = readFileSync(new URL('../build/console-preview.html', import.meta.url), 'utf8');
  const js = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

  const dom = browser();
  t.after(dom.restore);
  new Function(js)();

  assert.ok(dom.root.childNodes.length > 0, 'nothing was mounted into #console-root');
  const seen = dom.root.textContent;
  // The specific failure this guards: a page that renders its chrome and none
  // of its content still looks like a page until you read it.
  assert.ok(seen.length > 200, `only ${seen.length} characters rendered — this is the blank-page failure`);
  assert.match(seen, /Nothing needs you/, 'the calm state is the one it opens on');
  assert.match(seen, /enrolled machines are connected/, 'and it shows its working');
});

test('the built page is self-contained', () => {
  const html = readFileSync(new URL('../build/console-preview.html', import.meta.url), 'utf8');
  // No CDN, no font, no analytics. It has to open from a file:// URL on a
  // phone with no network, because that is how it will be looked at.
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external, []);
  assert.equal(html.includes('<style>'), true, 'the stylesheet is inlined');
});


test('the page shows the console even when scripts do not run', () => {
  // THE ACTUAL BUG, finally diagnosed. The first console was opened in a file
  // viewer inside an app — one that renders HTML and CSS in a sandbox and does
  // not execute scripts. It showed a title bar and nothing else, and every
  // check available at the time passed it, including a real Chromium run where
  // it rendered 6,368 characters perfectly.
  //
  // Measured with scripts disabled: the old page produced 40 characters, which
  // is exactly the static topbar in the screenshot. The JSX rebuild produced
  // ZERO, because every pixel of it came from a script — strictly worse in the
  // one place it was actually being looked at.
  //
  // So the markup is pre-rendered into the file at build time. This asserts it
  // stays that way, WITHOUT needing a browser: the shipped HTML must contain
  // the console's own text, not just a mount point.
  const html = readFileSync(new URL('../build/console-preview.html', import.meta.url), 'utf8');
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script>'));

  assert.ok(body.length > 1000, 'the body is a mount point and nothing else');
  assert.match(body, /Nothing needs you/, 'the calm state is in the HTML itself');
  assert.match(body, /enrolled machines are connected/);
  assert.match(body, /deb13-staging/, 'and so are the machines');
});
