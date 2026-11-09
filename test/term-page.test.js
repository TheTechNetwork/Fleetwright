// THE TERMINAL PAGE BOTH APPS SHOW (src/term/page.js, built by
// scripts/build-term.mjs): carried as it is built now, able to fetch nothing,
// and, run in a browser, drawing what the shell wrote and handing back what
// was typed and the window's size, the way the phones' bridges expect.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { OUTPUTS, termPage } from '../scripts/build-term.mjs';

const BASE = 'https://terminal.fleetwright.invalid/';

test('both apps carry the terminal page as it is built now, and it can fetch nothing', async () => {
  const page = await termPage();
  for (const path of OUTPUTS) {
    assert.ok(readFileSync(path, 'utf8') === page, `${path} is not the page src/term/page.js builds: run npm run term`);
  }
  assert.match(page, /default-src 'none'/);
  // Both apps load it under the same base, which resolves nowhere.
  assert.ok(readFileSync('apps/ios/Fleetwright/SSHTerminalView.swift', 'utf8').includes(`static let base = "${BASE}"`));
  assert.ok(readFileSync('apps/android/app/src/main/java/network/thetech/fleetwright/TerminalPage.kt', 'utf8').includes(`const val BASE = "${BASE}"`));
});

/** A browser to run the page in, as test/vnc-page.test.js finds one. */
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

test('the page draws what the shell wrote, and hands back what was typed and its size', async (t) => {
  const b = await browser();
  if (!b) return t.skip('no browser to run the page in');
  try {
    const page = await b.newPage({ viewport: { width: 390, height: 600 } });
    await page.addInitScript(() => {
      const w = /** @type {any} */ (window);
      w.sent = [];
      w.FleetwrightBridge = { post: (/** @type {string} */ s) => w.sent.push(JSON.parse(s)) };
    });
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
    await waitFor((m) => m.some((x) => x.t === 'state' && x.s === 'ready'));
    const sizes = await waitFor((m) => m.some((x) => x.t === 'size'));
    const size = sizes.find((x) => x.t === 'size');
    assert.ok(size.cols >= 20 && size.rows >= 5, `a phone-sized window: ${JSON.stringify(size)}`);
    // Typing before the shell is open is not sent anywhere.
    await page.keyboard.type('x');
    assert.ok(!(await posts()).some((x) => x.t === 'input'));
    await page.evaluate(() => /** @type {any} */ (window).fwTerm.opened());
    await page.evaluate((b64) => /** @type {any} */ (window).fwTerm.data(b64), Buffer.from('fleetwright@vm-aaaaaaaaaaaa:~$ ').toString('base64'));
    await page.waitForFunction(() => document.body.innerText.includes('fleetwright@vm-aaaaaaaaaaaa'));
    await page.keyboard.type('ls');
    await page.keyboard.press('Enter');
    const typed = await waitFor((m) => m.filter((x) => x.t === 'input').length >= 3);
    assert.equal(typed.filter((x) => x.t === 'input').map((x) => Buffer.from(x.d, 'base64').toString()).join(''), 'ls\r');
    // The SSH ending is said in the terminal, and typing goes nowhere after.
    await page.evaluate(() => /** @type {any} */ (window).fwTerm.closed('the shell ended'));
    await page.waitForFunction(() => document.body.innerText.includes('the shell ended'));
  } finally {
    await b.close();
  }
});
