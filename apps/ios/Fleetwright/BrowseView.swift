import SwiftUI
import UIKit
import WebKit
import Network

/// The words of a page through a machine, in one place. The same sentences
/// as Android's BrowseWords (BrowsePage.kt); test/browse-in-apps.test.js
/// holds the two to each other.
enum BrowseWords {
    static let openPort = "Open a port"
    static let browse = "Browse"
    static let pagesHead = "Pages through this machine"
    static let portTitle = "Open a port"
    static let portField = "Port"
    static let portHint = "What the session is serving on, such as 3000 or 5173."
    static let portOpen = "Open"
    static let addressField = "Address"
    static let go = "Go"
    static let back = "Back"
    static let forward = "Forward"
    static let reload = "Reload"
    static let openAgain = "Open again"
    static let notSecure = "Not secure: this page is readable on its way through the machine."
    static let lost = "Lost the connection."
    static let closed = "The page closed."
    static let couldNotConnect = "Couldn't connect."
    static let listedHead = "This machine opens"
    static let web = "The web, on ports 80 and 443"

    static func opening(_ host: String) -> String { "Opening through \(host)…" }
    static func through(_ host: String) -> String { "Through \(host)" }
    static func session(_ name: String, _ host: String) -> String { "\(name) on \(host)" }

    /// What a machine opens, in one line, for its page.
    static func opensLine(web: Bool, hosts: [String]) -> String {
        switch (web, hosts.isEmpty) {
        case (true, true): return "Opens the web on ports 80 and 443."
        case (true, false): return "Opens the web on ports 80 and 443, and \(hosts.count == 1 ? "1 address" : "\(hosts.count) addresses") on its network."
        default: return "Opens \(hosts.count == 1 ? "1 address" : "\(hosts.count) addresses") on its network."
        }
    }

    /// An address as typed, made a URL: `localhost`, an address and a name
    /// the machine lists go as plain HTTP, which is what they usually
    /// serve; anything else is asked for over HTTPS.
    static func url(from typed: String, listed: [String]) -> URL? {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if text.contains("://") { return URL(string: text) }
        let hostPart = String(text.split(separator: "/", maxSplits: 1).first ?? "")
        let bare = hostPart.split(separator: ":").first.map(String.init)?.lowercased() ?? hostPart.lowercased()
        let plain = bare == "localhost" || bare.allSatisfy { $0.isNumber || $0 == "." } || listed.contains { $0.lowercased().hasPrefix(bare) }
        return URL(string: (plain ? "http://" : "https://") + text)
    }

    /// A listed entry that can be opened as it is: a name or an address,
    /// with its port if it has one. A range is said, not opened.
    static func openable(_ entry: String) -> URL? {
        guard !entry.contains("/") else { return nil }
        return URL(string: "http://" + entry)
    }
}

/// A web view whose connections leave from one of your machines.
/// docs/browse.md. Asked for: "Web view that proxies any web page through one
/// of our hosts?", then "All 3 combined": a session's own ports, the names a
/// machine's owner listed, and the public web where its owner turned it on.
///
/// THE PROXY IS THIS SCREEN'S AND THIS WEB VIEW'S ALONE (BrowseTunnel): it is
/// set on a data store made for this screen, which keeps nothing, no cookies
/// and no cache, past it.
struct BrowseView: View {
    @State private var model: BrowseModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(settings: Settings, host: String, session: String?, start: URL? = nil) {
        _model = State(initialValue: BrowseModel(settings: settings, host: host, session: session, start: start))
    }

    var body: some View {
        VStack(spacing: 0) {
            addressBar
            if let line = model.line {
                VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                    Text(line)
                        .fleetType(.label)
                        .foregroundStyle(model.troubled ? Design.Palette.bad : Design.Palette.inkDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if model.retry {
                        Button(BrowseWords.openAgain) { model.restart() }
                            .frame(minHeight: 44)
                            .tint(Design.Palette.accent)
                    }
                }
                .padding(Design.Space.inside)
                .background(Design.Palette.card)
                .transition(.opacity)
            }
            ZStack {
                BrowseWeb(model: model)
                    .opacity(model.showsPage ? 1 : 0)
                if !model.showsPage, model.connected {
                    listed
                }
            }
        }
        .animation(reduceMotion ? nil : Design.Motion.change, value: model.line)
        .background(Design.Palette.bg)
        .navigationTitle(model.session.map { BrowseWords.session($0, model.host) } ?? BrowseWords.through(model.host))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                Button { _ = model.web?.goBack() } label: { Label(BrowseWords.back, systemImage: "chevron.backward") }
                    .disabled(!model.canGoBack)
                Button { _ = model.web?.goForward() } label: { Label(BrowseWords.forward, systemImage: "chevron.forward") }
                    .disabled(!model.canGoForward)
                Spacer()
                Button { _ = model.web?.reload() } label: { Label(BrowseWords.reload, systemImage: "arrow.clockwise") }
                    .disabled(!model.showsPage)
            }
        }
        .onDisappear { model.stop() }
    }

    /// The address, what the page is, and Go.
    private var addressBar: some View {
        VStack(alignment: .leading, spacing: Design.Space.hair) {
            HStack(spacing: Design.Space.insideTight) {
                TextField(BrowseWords.addressField, text: $model.typed)
                    .fleetType(.body)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { model.go() }
                    .frame(minHeight: 44)
                    .padding(.horizontal, Design.Space.insideTight)
                    .background(Design.Palette.inner, in: RoundedRectangle(cornerRadius: Design.Radius.chip, style: .continuous))
                    .accessibilityLabel(BrowseWords.addressField)
                Button(BrowseWords.go) { model.go() }
                    .frame(minWidth: 44, minHeight: 44)
                    .disabled(!model.connected || model.typed.trimmingCharacters(in: .whitespaces).isEmpty)
                    .tint(Design.Palette.accent)
            }
            if model.insecure {
                Text(BrowseWords.notSecure)
                    .fleetType(.micro)
                    .foregroundStyle(Design.Palette.attention)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, Design.Space.inside)
        .padding(.vertical, Design.Space.insideTight)
        .background(Design.Palette.card)
    }

    /// Before any page: what this machine opens, each name a way in.
    private var listed: some View {
        List {
            if let opens = model.opens, opens.web || !opens.hosts.isEmpty {
                Section {
                    if opens.web {
                        Text(BrowseWords.web).fleetType(.body).foregroundStyle(Design.Palette.ink)
                    }
                    ForEach(opens.hosts, id: \.self) { entry in
                        if let url = BrowseWords.openable(entry) {
                            Button(entry) { model.load(url) }
                                .fleetType(.body)
                                .frame(minHeight: 44)
                        } else {
                            Text(entry).fleetType(.labelMono).foregroundStyle(Design.Palette.inkDim)
                        }
                    }
                } header: {
                    Text(BrowseWords.listedHead).fleetType(.label).foregroundStyle(Design.Palette.inkDim)
                }
                .listRowBackground(Design.Palette.card)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
    }
}

/// The socket, the proxy and the page's state.
@MainActor @Observable
final class BrowseModel {
    let settings: Settings
    let host: String
    let session: String?
    let start: URL?
    var typed = ""
    /// What the screen is doing, said above the page; nil once a page shows.
    private(set) var line: String?
    private(set) var troubled = false
    private(set) var retry = false
    private(set) var connected = false
    private(set) var showsPage = false
    private(set) var insecure = false
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var opens: BrowseTunnel.Opens?
    /// The proxy's endpoint, for the web view's data store.
    private(set) var proxy: NWEndpoint?
    /// The last thing the machine refused, shown when a page does not load.
    @ObservationIgnored private var refused: String?
    @ObservationIgnored private var tunnel: BrowseTunnel?
    @ObservationIgnored weak var web: WKWebView?
    @ObservationIgnored private var pendingLoad: URL?

    init(settings: Settings, host: String, session: String?, start: URL?) {
        self.settings = settings
        self.host = host
        self.session = session
        self.start = start
        self.typed = start?.absoluteString ?? ""
        restart()
    }

    var credential: (user: String, password: String)? {
        guard let t = tunnel else { return nil }
        return (user: t.proxyUser, password: t.proxyPassword)
    }

    func restart() {
        tunnel?.close()
        line = BrowseWords.opening(host)
        troubled = false
        retry = false
        connected = false
        showsPage = false
        // THE OLD WEB VIEW POINTS AT THE OLD PROXY: nothing loads on it now,
        // and the new one is made when the new proxy exists (BrowseWeb).
        web = nil
        let t = BrowseTunnel(host: host, session: session)
        t.onEnd = { [weak self] why in Task { @MainActor in self?.ended(why) } }
        t.onRefused = { [weak self] why in Task { @MainActor in self?.refused = why } }
        tunnel = t
        Task {
            do {
                let (endpoint, opens) = try await t.open(settings: settings)
                guard tunnel === t else { return }
                self.opens = opens
                self.proxy = endpoint
                connected = true
                line = nil
                // WHERE IT WAS: the address in the bar, which is the page it
                // was opened on or the one it had reached.
                if let url = BrowseWords.url(from: typed, listed: opens?.hosts ?? []) { load(url) }
            } catch {
                guard tunnel === t else { return }
                ended(error.localizedDescription)
            }
        }
    }

    func stop() {
        tunnel?.close()
        tunnel = nil
    }

    private func ended(_ why: String) {
        connected = false
        showsPage = false
        line = why
        troubled = true
        retry = true
    }

    func go() {
        guard let url = BrowseWords.url(from: typed, listed: opens?.hosts ?? []) else { return }
        load(url)
    }

    func load(_ url: URL) {
        typed = url.absoluteString
        refused = nil
        guard let web, connected else {
            pendingLoad = url
            return
        }
        web.load(URLRequest(url: url))
    }

    /// The web view is ready for a proxy: made once the socket is open.
    func attached(_ web: WKWebView) {
        self.web = web
        if let url = pendingLoad {
            pendingLoad = nil
            web.load(URLRequest(url: url))
        }
    }

    func started() {
        line = nil
        troubled = false
    }

    func committed(_ web: WKWebView) {
        showsPage = true
        if let url = web.url {
            typed = url.absoluteString
            insecure = url.scheme?.lowercased() == "http"
        }
        canGoBack = web.canGoBack
        canGoForward = web.canGoForward
    }

    func failed(_ error: Error) {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain, ns.code == NSURLErrorCancelled { return }
        line = refused ?? error.localizedDescription
        troubled = true
    }
}

/// The web view, on a data store of its own with the proxy set on it.
private struct BrowseWeb: UIViewRepresentable {
    let model: BrowseModel

    func makeCoordinator() -> Delegate { Delegate(model: model) }

    func makeUIView(context: Context) -> UIView {
        let holder = UIView()
        holder.backgroundColor = .clear
        return holder
    }

    /// The web view is made when the proxy exists, and not before: a data
    /// store's proxy is read when its first connection is made. OPEN AGAIN
    /// MAKES A NEW PROXY, so a new one replaces the web view that pointed at
    /// the old, with its history: that history's pages came through a
    /// socket that is gone.
    func updateUIView(_ holder: UIView, context: Context) {
        guard let proxy = model.proxy, let credential = model.credential, context.coordinator.endpoint != proxy else { return }
        context.coordinator.web?.removeFromSuperview()
        context.coordinator.endpoint = proxy
        let store = WKWebsiteDataStore.nonPersistent()
        var through = ProxyConfiguration(httpCONNECTProxy: proxy)
        through.applyCredential(username: credential.user, password: credential.password)
        store.proxyConfigurations = [through]
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store
        let web = WKWebView(frame: holder.bounds, configuration: config)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.navigationDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        holder.addSubview(web)
        context.coordinator.web = web
        context.coordinator.credential = credential
        model.attached(web)
    }

    @MainActor
    final class Delegate: NSObject, WKNavigationDelegate {
        let model: BrowseModel
        weak var web: WKWebView?
        var endpoint: NWEndpoint?
        var credential: (user: String, password: String)?
        init(model: BrowseModel) { self.model = model }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { model.started() }
        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { model.committed(webView) }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { model.committed(webView) }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { model.failed(error) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { model.failed(error) }

        /// THE PROXY'S NAME AND PASSWORD, if the web view is asked for them
        /// rather than sending them: only for this screen's own proxy.
        func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
            let space = challenge.protectionSpace
            if space.isProxy(), space.host == "127.0.0.1", let credential, challenge.previousFailureCount == 0 {
                return (.useCredential, URLCredential(user: credential.user, password: credential.password, persistence: .forSession))
            }
            return (.performDefaultHandling, nil)
        }
    }
}

/// Which port of a running session to open.
struct BrowsePortView: View {
    let settings: Settings
    let host: String
    let session: String
    @State private var port = ""
    @State private var opened: URL?

    private var valid: URL? {
        guard let n = Int(port.trimmingCharacters(in: .whitespaces)), (1...65535).contains(n) else { return nil }
        return URL(string: "http://localhost:\(n)/")
    }

    var body: some View {
        List {
            Section {
                TextField(BrowseWords.portField, text: $port)
                    .fleetType(.body)
                    .keyboardType(.numberPad)
                    .frame(minHeight: 44)
                    .accessibilityLabel(BrowseWords.portField)
                Text(BrowseWords.portHint)
                    .fleetType(.label)
                    .foregroundStyle(Design.Palette.inkDim)
                    .fixedSize(horizontal: false, vertical: true)
                Button(BrowseWords.portOpen) { opened = valid }
                    .frame(minHeight: 44)
                    .disabled(valid == nil)
                    .tint(Design.Palette.accent)
            }
            .listRowBackground(Design.Palette.card)
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Design.Palette.bg)
        .navigationTitle(BrowseWords.session(session, host))
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(item: $opened) { url in
            BrowseView(settings: settings, host: host, session: session, start: url)
        }
    }
}
