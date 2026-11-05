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
  assert.match(kt, /XoLink\.handshake\(address, pin, path, "token=\$token", via = via\)/);
  // The handshake checks the pin before the upgrade, with its cookie, is written.
  const link = read(`${KT}XoLink.kt`);
  const shake = link.slice(link.indexOf('suspend fun handshake('), link.indexOf('private fun upgrade('));
  assert.ok(shake.indexOf('ssl.startHandshake()') > 0 && shake.indexOf('upgrade(ssl, host, port, path, cookie)') > shake.indexOf('ssl.startHandshake()'));
  // And the page never sees it: nothing hands the token to the web view.
  for (const f of [`${IOS}VMConsoleView.swift`, `${KT}ConsolePage.kt`]) {
    assert.ok(!/evaluate[jJ]ava[sS]cript\([^)]*token/.test(read(f)), `${f} hands the token to the page`);
  }
});

test('both apps offer the console for a running VM, and a page read away opens it through a machine', () => {
  assert.match(read(`${IOS}ManageView.swift`), /if c\.kind == \.vm, c\.state == \.running, !c\.holder, watch\.phase == \.live \{\s*Section \{\s*NavigationLink\(Manage\.Words\.console\) \{\s*VMConsoleView\(address: watch\.address, vm: c\.id, name: c\.name, settings: settings, away: watch\.via != nil\)/);
  assert.match(read(`${KT}PoolPage.kt`), /if \(c\.kind == Manage\.Kind\.VM && c\.state == Manage\.State\.RUNNING && !c\.holder && watch\.phase == PoolWatch\.Phase\.Live\) \{[\s\S]{0,200}?OpenRow\(Manage\.Words\.console\) \{ console = true \}/);
  assert.match(read(`${KT}PoolPage.kt`), /ConsolePage\(watch\.settings, watch\.address, c\.id, c\.name, away = watch\.via != null\)/);
});

// FROM AWAY THE PHONE STILL HOLDS THE TLS (src/fleet/coordinator/tunnels.js):
// iOS points the console's own session at a loopback CONNECT proxy, so the
// URL, the server name and the pin check are unchanged; Android layers the
// same pinned TLS on a loopback socket with the pool's own host name. Both
// open the fleet's socket with this device's credential, never in the clear.
test('both apps carry the console from away inside their own pinned TLS', () => {
  const ios = read(`${IOS}ConsoleTunnel.swift`);
  const kt = read(`${KT}ConsoleTunnel.kt`);
  for (const src of [ios, kt]) {
    assert.ok(src.includes('/api/xoconsole/tunnel'), 'not the tunnel route');
    assert.match(src, /Bearer \$?\\?\(?\{?settings\.credential/);
    assert.match(src, /Refusing to send your credential over plain http/);
  }
  assert.match(read(`${IOS}XOConsole.swift`), /if let proxy \{ config\.proxyConfigurations = \[ProxyConfiguration\(httpCONNECTProxy: proxy\)\] \}/);
  assert.match(ios, /requiredLocalEndpoint = \.hostPort\(host: "127\.0\.0\.1", port: \.any\)/);
  assert.match(kt, /ServerSocket\(0, 1, InetAddress\.getLoopbackAddress\(\)\)/);
  // The pin is checked over the tunnel exactly as on the pool's network.
  const link = read(`${KT}XoLink.kt`);
  assert.match(link, /val raw = via \?: Socket\(\)/);
  assert.match(link, /context\.socketFactory\.createSocket\(raw, host, port, true\)/);
});

test('both apps hand the screen to the page in the order it arrived', () => {
  // VNC is a stream: one frame out of turn corrupts every one after it.
  assert.match(read(`${IOS}VMConsoleView.swift`), /socket\.onData = \{ \[weak self\] data in[\s\S]{0,120}?DispatchQueue\.main\.async/);
  assert.match(read(`${KT}ConsolePage.kt`), /opened\.onData = \{ bytes ->[\s\S]{0,160}?main\.post \{ call\("fwConsole\.data/);
});
