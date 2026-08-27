// What does this page show when scripts do not run?
//
// Not hypothetical: a file preview inside an app commonly renders HTML and CSS
// in a sandboxed frame with scripting disabled. A page that is entirely
// JS-rendered shows NOTHING there, which is worse than one that shows a title
// bar.
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch();
const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 900 }, colorScheme: 'dark' });
const page = await ctx.newPage();
await page.goto(pathToFileURL(process.argv[2]).href);
const seen = (await page.evaluate(() => document.body.innerText)) ?? '';
console.log(`${process.argv[2]}  ->  ${seen.trim().length} chars visible with JS off`);
if (process.argv[3]) await page.screenshot({ path: process.argv[3], fullPage: true });
await browser.close();
