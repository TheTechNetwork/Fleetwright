// A page through a machine in both apps (docs/browse.md). The Swift and
// Kotlin compile only in CI, so what this holds is the contract each side
// keeps with the fleet and with its own web view, read from the source the
// way test/vm-console-in-apps.test.js reads the console.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const read = (/** @type {string} */ p) => raw(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*/gm, '');
const IOS = 'apps/ios/Fleetwright/';
const KT = 'apps/android/app/src/main/java/network/thetech/fleetwright/';

const iTunnel = read(`${IOS}BrowseTunnel.swift`);
const aTunnel = read(`${KT}BrowseTunnel.kt`);
const iView = read(`${IOS}BrowseView.swift`);
const aPage = read(`${KT}BrowsePage.kt`);

test('both open the fleet’s browse socket with this device’s credential, never in the clear', () => {
  for (const src of [iTunnel, aTunnel]) {
    assert.ok(src.includes('/api/browse'), 'not the browse route');
    assert.match(src, /Bearer \$?\\?\(?\{?settings\.credential/);
    assert.match(src, /Refusing to send your credential over plain http/);
  }
  // The session goes with it only when there is one.
  assert.match(iTunnel, /URLQueryItem\(name: "host", value: host\)\] \+ \(session\.map \{ \[URLQueryItem\(name: "session", value: \$0\)\] \}/);
  assert.match(aTunnel, /"host=\$\{URLEncoder\.encode\(host, "UTF-8"\)\}" \+ \(session\?\.let \{ "&session=/);
});

test('both proxies listen on loopback only, once the machine agreed, and answer only the web view', () => {
  assert.match(iTunnel, /requiredLocalEndpoint = \.hostPort\(host: "127\.0\.0\.1", port: \.any\)/);
  assert.match(aTunnel, /ServerSocket\(0, 50, InetAddress\.getLoopbackAddress\(\)\)/);
  // Listening waits for `open`.
  assert.match(iTunnel, /case "open":[\s\S]{0,200}?listen\(\)/);
  assert.ok(aTunnel.indexOf('opened.await()') < aTunnel.indexOf('ServerSocket(0, 50'));
  // A NAME AND PASSWORD MADE FOR THIS SCREEN, from a secure random source,
  // and a request without them is told 407 and closed.
  assert.match(iTunnel, /SecRandomCopyBytes\(kSecRandomDefault/);
  assert.match(aTunnel, /SecureRandom\(\)\.nextBytes/);
  for (const src of [iTunnel, aTunnel]) {
    assert.match(src, /407 Proxy Authentication Required/);
    assert.match(src, /proxy-authorization:/);
    assert.match(src, /realm=\\"fleetwright\\"/);
  }
  assert.match(iTunnel, /guard auth == expectedAuth else/);
  assert.match(aTunnel, /if \(auth != expectedAuth\)/);
  // And each web view is given them, for its own proxy only.
  assert.match(iView, /through\.applyCredential\(username: credential\.user, password: credential\.password\)/);
  assert.match(iView, /space\.isProxy\(\), space\.host == "127\.0\.0\.1"/);
  assert.match(aPage, /realm == "fleetwright" && host\?\.startsWith\("127\.0\.0\.1"\) == true/);
  assert.match(aPage, /handler\.cancel\(\)/);
});

test('both carry CONNECT as it is and rewrite a plain-HTTP request to one request, then closed', () => {
  for (const src of [iTunnel, aTunnel]) {
    assert.match(src, /CONNECT/);
    assert.match(src, /HTTP\/1\.1 200 Connection established\\r\\n\\r\\n/);
    assert.match(src, /"Connection: close"/);
    assert.match(src, /startsWith\("proxy-"\)|hasPrefix\("proxy-"\)/);
    // In pieces the fleet carries.
    assert.match(src, /48 \* 1024/);
  }
});

test('the web view keeps nothing past the screen, and only this screen is proxied', () => {
  // iOS: on a data store made for it, which keeps nothing.
  assert.match(iView, /let store = WKWebsiteDataStore\.nonPersistent\(\)[\s\S]{0,300}?store\.proxyConfigurations = \[through\][\s\S]{0,200}?config\.websiteDataStore = store/);
  assert.match(iView, /\.onDisappear \{ model\.stop\(\) \}/);
  // Android: app-wide, so set for the screen, localhost included, and taken
  // off with the cookies and storage when it closes.
  assert.match(aPage, /WebViewFeature\.isFeatureSupported\(WebViewFeature\.PROXY_OVERRIDE\)/);
  assert.match(aPage, /ProxyConfig\.Builder\(\)\s*\.addProxyRule\("127\.0\.0\.1:\$port"\)\s*\.removeImplicitRules\(\)/);
  const stop = aPage.slice(aPage.indexOf('fun stop()'), aPage.indexOf('private fun dropWeb()'));
  assert.match(stop, /clearProxyOverride/);
  assert.match(stop, /CookieManager\.getInstance\(\)\.removeAllCookies/);
  assert.match(stop, /WebStorage\.getInstance\(\)\.deleteAllData\(\)/);
  assert.match(aPage, /DisposableEffect\(page\) \{ onDispose \{ page\.stop\(\) \} \}/);
  assert.match(aPage, /allowFileAccess = false/);
});

test('Open a port and Browse are drawn only where they open something', () => {
  // A running session, on a machine that opens its sessions' ports.
  assert.match(read(`${IOS}SessionView.swift`), /if session\.isRunning, opensPorts, let host = session\.hostId \{\s*NavigationLink\(BrowseWords\.openPort\)/);
  assert.match(read(`${KT}SessionSheet.kt`), /if \(session\.isRunning && onOpenPort != null\)/);
  assert.match(read(`${KT}MainActivity.kt`), /opensSessionPorts == true\) \{\s*\{ portFor = session \}\s*\} else \{\s*null/);
  assert.match(read(`${IOS}Fleet.swift`), /var opensSessionPorts: Bool \{ health\?\.browse\?\.sessions == true \}/);
  assert.match(read(`${KT}Fleet.kt`), /get\(\) = browse\?\.sessions == true/);
  // A machine page, for somebody who administers it, where its owner listed
  // something or turned on the web.
  assert.match(read(`${IOS}HostView.swift`), /if mayAdminister, let opens = health\?\.browse, opens\.web == true \|\| !\(opens\.hosts \?\? \[\]\)\.isEmpty \{/);
  assert.match(read(`${KT}MachinesScreen.kt`), /if \(administers && opens != null && \(opens\.web \|\| opens\.hosts\.isNotEmpty\(\)\)\)/);
  // A session's page opens http://localhost:<port>/ on that session.
  assert.match(iView, /URL\(string: "http:\/\/localhost:\\\(n\)\/"\)/);
  assert.match(aPage, /onOpen\("http:\/\/localhost:\$it\/"\)/);
});

test('both say the same things', () => {
  /** @param {string} src @param {RegExp} re */
  const words = (src, re) => Object.fromEntries([...src.matchAll(re)].map((m) => [m[1].toLowerCase().replace(/_/g, ''), m[2]]));
  const ios = words(raw(`${IOS}BrowseView.swift`), /static let (\w+) = "([^"]*)"/g);
  const kt = words(raw(`${KT}BrowsePage.kt`), /const val (\w+) = "([^"]*)"/g);
  // Android's NO_PROXY is Android's alone: iOS has no such case.
  delete kt.noproxy;
  assert.deepEqual(Object.keys(ios).sort(), Object.keys(kt).sort());
  for (const k of Object.keys(ios)) assert.equal(kt[k], ios[k], k);
  // And the sentences built from parts.
  for (const [i, a] of [
    ['"Opening through \\(host)…"', '"Opening through $host…"'],
    ['"Through \\(host)"', '"Through $host"'],
    ['"\\(name) on \\(host)"', '"$name on $host"'],
    ['"Opens the web on ports 80 and 443."', '"Opens the web on ports 80 and 443."'],
  ]) {
    assert.ok(raw(`${IOS}BrowseView.swift`).includes(i), i);
    assert.ok(raw(`${KT}BrowsePage.kt`).includes(a), a);
  }
  // The new event kind has a label on both phones.
  assert.match(raw(`${IOS}ReasonWords.swift`), /"browse\.opened": "Page through a machine"/);
  assert.match(raw(`${KT}ReasonWords.kt`), /"browse\.opened" to "Page through a machine"/);
});

// WHAT THE REVIEW BEFORE MERGING FOUND, held here so it stays found.
test('both acknowledge what they hand the web view, so the machine reads no further ahead', () => {
  assert.match(iTunnel, /c\.client\.send\(content: bytes, completion: \.contentProcessed \{[\s\S]{0,300}?"op": "ack", "stream": stream, "bytes": bytes\.count/);
  assert.match(aTunnel, /val ok = runCatching \{ c\.write\(bytes\) \}\.isSuccess[\s\S]{0,200}?put\("op", "ack"\)\.put\("stream", stream\)\.put\("bytes", bytes\.size\)/);
});

test('iOS opens nothing until the screen is shown, and answers the proxy challenge by the delegate method WebKit calls', () => {
  // A NavigationLink builds its destination on every draw of the page that
  // holds it: a model that opened its socket as it was made opened one for
  // every draw.
  const init = iView.slice(iView.indexOf('init(settings: Settings, host: String, session: String?, start: URL?) {'), iView.indexOf('func begin()'));
  assert.ok(!/restart\(\)|open\(settings/.test(init), 'BrowseModel opens a socket as it is made');
  assert.match(iView, /\.task \{ model\.begin\(\) \}/);
  assert.match(iView, /func begin\(\) \{\s*guard tunnel == nil else \{ return \}/);
  assert.match(iView, /didReceive challenge: URLAuthenticationChallenge,\s*completionHandler: @escaping/);
  // A web view per tunnel, not per port, and never the new password with the old port.
  assert.match(iView, /context\.coordinator\.made != credential\.password/);
  assert.match(iView, /web = nil[\s\S]{0,200}?proxy = nil[\s\S]{0,40}?let t = BrowseTunnel/);
  assert.match(iTunnel, /deinit \{/);
});

test('Android writes each connection on its own thread, never on the socket reader', () => {
  assert.match(aTunnel, /val writer: ExecutorService = Executors\.newSingleThreadExecutor/);
  const listener = aTunnel.slice(aTunnel.indexOf('private inner class Listener'));
  // Every write the listener makes is handed to a connection's writer.
  for (const m of listener.matchAll(/c\.write\(/g)) {
    const before = listener.slice(Math.max(0, /** @type {number} */ (m.index) - 400), m.index);
    assert.match(before, /c\.writer\.execute \{/, 'a write on the reader thread');
  }
  // The refusal's 502 goes before the waiting connection is let go.
  assert.match(listener, /answer\(c\.socket, "502 Bad Gateway", why\)\s*c\.answered\.countDown\(\)/);
  // The override is marked before it is applied, so a quick close clears it.
  assert.match(aPage, /proxied = true\s*ProxyController\.getInstance\(\)\.setProxyOverride/);
});
