// The VM console in both apps (docs/manage.md, "The console"). The Swift and
// Kotlin compile only in CI, so what this holds is the contract each side
// keeps with the page and with Xen Orchestra, read from the source the way
// test/manage-in-apps.test.js reads the pool page.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BASE } from '../scripts/build-vnc.mjs';

const raw = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const read = (/** @type {string} */ p) => raw(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const IOS = 'apps/ios/Fleetwright/';
const KT = 'apps/android/app/src/main/java/network/thetech/fleetwright/';

test('both apps load the console page under the address it was built for', () => {
  // A different base on one side would leave that side's page not a secure
  // context, which noVNC expects.
  assert.ok(raw(`${IOS}VMConsoleView.swift`).includes(`static let base = "${BASE}"`));
  assert.ok(raw(`${KT}ConsolePage.kt`).includes(`const val BASE = "${BASE}"`));
  assert.match(read(`${IOS}VMConsoleView.swift`), /loadHTMLString\(html, baseURL: URL\(string: Self\.base\)\)/);
  assert.match(read(`${KT}ConsolePage.kt`), /loadDataWithBaseURL\(BASE, html, "text\/html", "utf-8", null\)/);
});

test('both apps send the token only as the console cookie, behind the pin', () => {
  assert.match(raw(`${IOS}XOConsole.swift`), /URL\(string: "wss:\/\/\\\(address\)\/api\/consoles\/\\\(id\)"\)/);
  const swift = read(`${IOS}XOConsole.swift`);
  assert.match(swift, /request\.setValue\("token=\\\(token\)", forHTTPHeaderField: "Cookie"\)/);
  assert.match(swift, /if XOLink\.fingerprint\(of: trust\) == pin \{\s*completionHandler\(\.useCredential[\s\S]{0,200}?completionHandler\(\.cancelAuthenticationChallenge, nil\)/);
  const kt = read(`${KT}XoConsole.kt`);
  assert.match(kt, /XoLink\.handshake\(address, pin, path, "token=\$token"\)/);
  // The handshake checks the pin before the upgrade, with its cookie, is written.
  const link = read(`${KT}XoLink.kt`);
  const shake = link.slice(link.indexOf('suspend fun handshake('), link.indexOf('private fun upgrade('));
  assert.ok(shake.indexOf('ssl.startHandshake()') > 0 && shake.indexOf('upgrade(ssl, host, port, path, cookie)') > shake.indexOf('ssl.startHandshake()'));
  // And the page never sees it: nothing hands the token to the web view.
  for (const f of [`${IOS}VMConsoleView.swift`, `${KT}ConsolePage.kt`]) {
    assert.ok(!/evaluate[jJ]ava[sS]cript\([^)]*token/.test(read(f)), `${f} hands the token to the page`);
  }
});

test('both apps offer the console for a running VM only while watching the pool directly', () => {
  assert.match(read(`${IOS}ManageView.swift`), /if c\.kind == \.vm, c\.state == \.running, !c\.holder, watch\.phase == \.live \{\s*Section \{\s*if watch\.via == nil \{\s*NavigationLink\(Manage\.Words\.console\)[\s\S]{0,200}?\} else \{\s*note\(Manage\.Words\.consoleAway\)/);
  assert.match(read(`${KT}PoolPage.kt`), /if \(c\.kind == Manage\.Kind\.VM && c\.state == Manage\.State\.RUNNING && !c\.holder && watch\.phase == PoolWatch\.Phase\.Live\) \{[\s\S]{0,200}?if \(watch\.via == null\) OpenRow\(Manage\.Words\.console\) \{ console = true \}\s*else Hint\(Manage\.Words\.consoleAway\)/);
});

test('both apps hand the screen to the page in the order it arrived', () => {
  // VNC is a stream: one frame out of turn corrupts every one after it.
  assert.match(read(`${IOS}VMConsoleView.swift`), /socket\.onData = \{ \[weak self\] data in[\s\S]{0,120}?DispatchQueue\.main\.async/);
  assert.match(read(`${KT}ConsolePage.kt`), /opened\.onData = \{ bytes ->[\s\S]{0,160}?main\.post \{ call\("fwConsole\.data/);
});
