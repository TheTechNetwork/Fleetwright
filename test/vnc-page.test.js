// The VM console page both apps show (src/vnc/page.js, scripts/build-vnc.mjs).
//
// Two contracts. The apps carry the page the source describes, which a noVNC
// update or an edit to the page breaks until `npm run vnc` is run; and the
// page, fed bytes the way the phones feed them, completes a VNC handshake and
// says so, which a change to noVNC's channel checks or to the bridge breaks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { BASE, OUTPUTS, vncPage } from '../scripts/build-vnc.mjs';

test('both apps carry the console page as it is built now', async () => {
  const page = await vncPage();
  for (const path of OUTPUTS) {
    assert.ok(readFileSync(path, 'utf8') === page, `${path} is not the page src/vnc/page.js builds: run npm run vnc`);
  }
  // It can fetch nothing: the content security policy allows no source at all.
  assert.match(page, /default-src 'none'/);
});

/** A browser to run the page in: Playwright's, a runner's Chrome, or this container's. */
async function browser() {
  const { chromium } = await import('playwright');
  const tries = [{}, { channel: 'chrome' }, { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }];
  for (const options of tries) {
    if (options.executablePath && !existsSync(options.executablePath)) continue;
    try {
      return await chromium.launch(options);
    } catch {}
  }
  return null;
}

test('the page completes a VNC handshake over the bridge, and types what is typed', async (t) => {
  const b = await browser();
  if (!b) return t.skip('no browser to run the page in');
  try {
    const page = await b.newPage();
    // The Android bridge's shape: one call, a JSON string.
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window);
      w.sent = [];
      w.FleetwrightBridge = { post: (/** @type {string} */ s) => w.sent.push(JSON.parse(s)) };
    });
    // Loaded the way both apps load it: from a string, under an https base
    // that resolves nowhere, so the page is a secure context and can reach
    // nothing.
    await page.route(BASE, (route) => route.fulfill({ contentType: 'text/html', body: readFileSync(OUTPUTS[1], 'utf8') }));
    await page.goto(BASE);
    const posts = () => page.evaluate(() => /** @type {any} */ (window).sent);
    const waitFor = async (/** @type {(m: any[]) => boolean} */ ok) => {
      for (let i = 0; i < 100; i++) {
        const m = await posts();
        if (ok(m)) return m;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`never: ${JSON.stringify(await posts())}`);
    };
    const feed = (/** @type {Buffer} */ bytes) => page.evaluate((b64) => /** @type {any} */ (window).fwConsole.data(b64), bytes.toString('base64'));
    const sentBytes = async () => Buffer.concat((await posts()).filter((m) => m.t === 'send').map((m) => Buffer.from(m.b, 'base64')));

    await waitFor((m) => m.some((x) => x.t === 'state' && x.s === 'ready'));
    await page.evaluate(() => /** @type {any} */ (window).fwConsole.opened());

    // RFB 3.8 as Xen Orchestra relays it from XAPI: version, the None
    // security type, success, then the server's screen.
    await feed(Buffer.from('RFB 003.008\n'));
    await waitFor((m) => m.some((x) => x.t === 'send'));
    assert.equal((await sentBytes()).toString(), 'RFB 003.008\n');
    await feed(Buffer.from([1, 1]));
    await waitFor(() => true);
    await feed(Buffer.from([0, 0, 0, 0]));
    const name = Buffer.from('vm');
    const init = Buffer.alloc(24 + name.length);
    init.writeUInt16BE(640, 0);
    init.writeUInt16BE(480, 2);
    Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(init, 4);
    init.writeUInt32BE(name.length, 20);
    name.copy(init, 24);
    await feed(init);
    await waitFor((m) => m.some((x) => x.t === 'state' && x.s === 'connected'));

    // Typing on a phone: the hidden field's text goes as key presses, a
    // KeyEvent message (type 4) down and up for each.
    const before = (await sentBytes()).length;
    await page.evaluate(() => /** @type {any} */ (window).fwConsole.keyboard());
    await page.keyboard.type('a');
    await waitFor(() => true);
    const keys = (await sentBytes()).subarray(before);
    const events = [];
    for (let i = 0; i + 8 <= keys.length; i += 8) if (keys[i] === 4) events.push([keys[i + 1], keys.readUInt32BE(i + 4)]);
    assert.deepEqual(events.filter(([, sym]) => sym === 0x61), [[1, 0x61], [0, 0x61]]);
    // And what iOS catches natively and hands over: text, and a key by name.
    const mark = (await sentBytes()).length;
    await page.evaluate(() => { const c = /** @type {any} */ (window).fwConsole; c.type('é'); c.key('Backspace'); });
    await waitFor(() => true);
    const more = (await sentBytes()).subarray(mark);
    const syms = [];
    for (let i = 0; i + 8 <= more.length; i += 8) if (more[i] === 4 && more[i + 1] === 1) syms.push(more.readUInt32BE(i + 4));
    assert.deepEqual(syms, [0xe9, 0xff08]);

    // The phone's socket ending is the console ending.
    await page.evaluate(() => /** @type {any} */ (window).fwConsole.closed('gone'));
    await waitFor((m) => m.some((x) => x.t === 'state' && x.s === 'ended'));
  } finally {
    await b.close();
  }
});
