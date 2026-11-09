import SwiftUI
import WebKit

/// A terminal on a machine of yours, in the app, over SSH as `fleetwright`
/// with this phone's own key. docs/hypervisors.md, "SSH in the app". Asked
/// for: "if it's not on local network should be able to reach it somehow as
/// well as ssh".
///
/// THE PHONE HOLDS THE SSH, THE PAGE DRAWS IT: SSHTerminal speaks SSH with the
/// key, and the bundled page (term.html, built from src/term/page.js) runs
/// xterm.js on the bytes it is handed. The key never enters the web view, and
/// the page may fetch nothing.
///
/// ON THE MACHINE'S NETWORK FIRST, THEN THROUGH ONE OF YOUR MACHINES
/// (ConsoleTunnel, naming the machine) when it does not answer from here: the
/// machine carrying it connects to the machine's port 22, and both it and the
/// fleet carry SSH's ciphertext.
struct SSHTerminalView: View {
    let settings: Settings
    let machine: String
    @State private var model: TerminalModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(settings: Settings, machine: String, address: String, ip: String) {
        self.settings = settings
        self.machine = machine
        _model = State(initialValue: TerminalModel(settings: settings, machine: machine, address: address, ip: ip))
    }

    var body: some View {
        VStack(spacing: 0) {
            if let line = model.line {
                VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                    Text(line)
                        .fleetType(.label)
                        .foregroundStyle(model.troubled ? Design.Palette.bad : Design.Palette.inkDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if model.needsKey {
                        Button(model.adding ? TerminalWords.adding : TerminalWords.addKey) { model.addKey() }
                            .disabled(model.adding)
                            .frame(minHeight: 44)
                            .tint(Design.Palette.accent)
                    } else if model.retry {
                        Button(Manage.Words.openAgain) { model.restart() }
                            .frame(minHeight: 44)
                            .tint(Design.Palette.accent)
                    }
                }
                .padding(Design.Space.inside)
                .background(Design.Palette.card)
                .transition(.opacity)
            } else if let via = model.via {
                HStack {
                    Text(Manage.Words.consoleAwayVia(via))
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .padding(.horizontal, Design.Space.insideTight)
                        .padding(.vertical, Design.Space.hair)
                        .background(Design.Palette.card, in: RoundedRectangle(cornerRadius: Design.Radius.chip, style: .continuous))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Design.Space.inside)
                .padding(.vertical, Design.Space.insideTight)
            }
            TerminalWeb(model: model)
        }
        .animation(reduceMotion ? nil : Design.Motion.change, value: model.line)
        .background(Design.Palette.bg)
        .navigationTitle(machine)
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear { model.stop() }
    }
}

/// What the terminal says, in both apps' words (Android's TerminalWords).
enum TerminalWords {
    static let open = "Open a terminal"
    static func opening(_ machine: String) -> String { "Connecting to \(machine)…" }
    static let away = "Connecting through one of your machines…"
    static let needsKey = "This machine doesn’t have this phone’s key. Add it to your vault, and machines made after that take it."
    static let addKey = "Add this phone’s key"
    static let adding = "Adding…"
    static let added = "Added. Machines made from now on take this phone’s key; this one was made before."
    static func ended(_ why: String) -> String { "The terminal closed: \(why)." }
    static let phoneHeader = "This phone"
    static let phoneKept = "This phone’s key is in your vault."
    static let phoneFooter = "The terminal on a machine’s page signs in with a key made on this phone, which never leaves it; its public half goes in your vault beside the keys above. Machines made after you add it take it."
}

/// The terminal's state, and the bridge between the SSH and the page.
@MainActor @Observable
final class TerminalModel {
    static let base = "https://terminal.fleetwright.invalid/"

    let machine: String
    let address: String
    let ip: String
    private(set) var line: String? = nil
    private(set) var troubled = false
    private(set) var retry = false
    private(set) var needsKey = false
    private(set) var adding = false
    private(set) var via: String? = nil

    @ObservationIgnored weak var web: WKWebView?
    @ObservationIgnored private let settings: Settings
    @ObservationIgnored private var ssh: SSHTerminal?
    @ObservationIgnored private var tunnel: ConsoleTunnel?
    @ObservationIgnored private var away = false
    @ObservationIgnored private var reached = false
    @ObservationIgnored private var cols = 80
    @ObservationIgnored private var rows = 24
    @ObservationIgnored private var pageReady = false

    init(settings: Settings, machine: String, address: String, ip: String) {
        self.settings = settings
        self.machine = machine
        self.address = address
        self.ip = ip
        line = TerminalWords.opening(machine)
    }

    func fromPage(_ m: [String: Any]) {
        switch m["t"] as? String {
        case "state" where m["s"] as? String == "ready":
            pageReady = true
            open()
        case "input":
            if let b = m["d"] as? String, let data = Data(base64Encoded: b) { ssh?.send(data) }
        case "size":
            if let c = m["cols"] as? Int, let r = m["rows"] as? Int, c > 0, r > 0 {
                cols = c
                rows = r
                ssh?.resize(cols: c, rows: r)
            }
        default: break
        }
    }

    func load() {
        guard let web, let url = Bundle.main.url(forResource: "term", withExtension: "html"),
              let html = try? String(contentsOf: url, encoding: .utf8) else { return }
        web.loadHTMLString(html, baseURL: URL(string: Self.base))
    }

    func restart() {
        stop()
        away = false
        pageReady = false
        show(TerminalWords.opening(machine))
        load()
    }

    func stop() {
        ssh?.close()
        ssh = nil
        tunnel?.close()
        tunnel = nil
    }

    func addKey() {
        adding = true
        Task { @MainActor in
            do {
                _ = try await PhoneSSHKey.add(settings)
                adding = false
                needsKey = false
                show(TerminalWords.added, troubled: false, retry: true)
            } catch {
                adding = false
                show(error.localizedDescription, troubled: true, retry: false)
                needsKey = true
            }
        }
    }

    private func open() {
        guard pageReady, ssh == nil else { return }
        if away {
            Task { @MainActor in
                show(TerminalWords.away)
                let tunnel = ConsoleTunnel(address: address, machine: machine)
                self.tunnel = tunnel
                tunnel.onEnd = { [weak self] why in
                    DispatchQueue.main.async { MainActor.assumeIsolated { self?.ended(why, refusedKey: false) } }
                }
                do {
                    let (proxy, host) = try await tunnel.open(settings: settings)
                    guard self.tunnel === tunnel else { return }
                    via = host
                    start(SSHTerminal(machine: machine, host: ip, proxy: proxy))
                } catch {
                    guard self.tunnel === tunnel else { return }
                    self.tunnel = nil
                    show(error.localizedDescription, troubled: true, retry: true)
                }
            }
        } else {
            start(SSHTerminal(machine: machine, host: ip))
        }
    }

    private func start(_ terminal: SSHTerminal) {
        reached = false
        terminal.onOpen = { [weak self] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.reached = true
                    self?.show(nil)
                    self?.call("fwTerm.opened()")
                }
            }
        }
        terminal.onData = { [weak self] data in
            let b64 = data.base64EncodedString()
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.call("fwTerm.data('\(b64)')") } }
        }
        terminal.onEnd = { [weak self] why, refusedKey in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.ended(why, refusedKey: refusedKey) } }
        }
        ssh = terminal
        terminal.open(cols: cols, rows: rows)
    }

    private func ended(_ why: String, refusedKey: Bool) {
        ssh = nil
        // NOT ANSWERED FROM HERE: once, through one of your machines.
        if !reached, !refusedKey, !away {
            away = true
            open()
            return
        }
        tunnel?.close()
        tunnel = nil
        call("fwTerm.closed(\(Self.quoted(why)))")
        if refusedKey {
            needsKey = true
            show(TerminalWords.needsKey, troubled: true, retry: false)
        } else {
            show(TerminalWords.ended(why), troubled: true, retry: true)
        }
    }

    private func show(_ said: String?, troubled: Bool = false, retry: Bool = false) {
        line = said
        self.troubled = troubled
        self.retry = retry
    }

    private func call(_ js: String) {
        web?.evaluateJavaScript(js, completionHandler: nil)
    }

    private static func quoted(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }
}

/// The web view the page runs in.
private struct TerminalWeb: UIViewRepresentable {
    let model: TerminalModel

    func makeCoordinator() -> Bridge { Bridge(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.dataDetectorTypes = []
        config.userContentController.add(context.coordinator, name: "fw")
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.scrollView.isScrollEnabled = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsLinkPreview = false
        model.web = web
        model.load()
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    static func dismantleUIView(_ web: WKWebView, coordinator: Bridge) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "fw")
    }

    final class Bridge: NSObject, WKScriptMessageHandler {
        weak var model: TerminalModel?
        init(model: TerminalModel) { self.model = model }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let m = message.body as? [String: Any] else { return }
            MainActor.assumeIsolated { model?.fromPage(m) }
        }
    }
}
