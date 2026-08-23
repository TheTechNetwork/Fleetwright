// Open a built page in a real browser and say what a person would see.
//
// This exists because a page was shipped that rendered a title bar and nothing
// else, and every check available at the time passed it. A DOM shim proves the
// script runs; only a browser proves the page works.
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const [file, widthArg, shot, scenario, scheme] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(widthArg || 390), height: 900 },
  deviceScaleFactor: 2,
  colorScheme: scheme === 'light' ? 'light' : 'dark',
});

const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CONSOLE: ' + m.text());
});

await page.goto(pathToFileURL(file).href, { waitUntil: 'networkidle' });
if (scenario) {
  await page.selectOption('.preview-pick', scenario);
  await page.waitForTimeout(200);
}
await page.waitForTimeout(300);

const seen = await page.evaluate(() => document.body.innerText.trim());
console.log(`--- ${file} @ ${widthArg}px ${scheme || 'dark'}${scenario ? ' [' + scenario + ']' : ''} ---`);
console.log('errors      :', errors.length ? errors.join(' | ') : 'none');
console.log('visible text:', seen.length, 'chars');
if (shot) {
  await page.screenshot({ path: shot, fullPage: true });
  console.log('screenshot  :', shot);
}
await browser.close();
process.exit(errors.length ? 1 : 0);
