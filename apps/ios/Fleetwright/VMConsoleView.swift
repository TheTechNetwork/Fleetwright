import SwiftUI
import UIKit
import WebKit
import Network

/// A running VM's screen, in the app. docs/manage.md, "The console". Asked
/// for: "we should be able to connect to vm console".
///
/// THE PHONE HOLDS THE SOCKET, THE PAGE DRAWS IT. XOConsole opens Xen
/// Orchestra's console WebSocket with the pool's token and pin, the way the
/// pool page connects; the bundled page (vnc.html, built from src/vnc/page.js)
/// runs noVNC on the bytes it is handed. The token never enters the web view,
/// and the page may fetch nothing (its content security policy).
///
/// FROM AWAY, THROUGH ONE OF YOUR MACHINES (ConsoleTunnel): a page read
/// through a machine opens it that way at once, and a console that cannot
/// reach the pool from here tries that way once before saying so. The phone
/// still holds the TLS and the pin; the machine carries ciphertext.
struct VMConsoleView: View {
    let name: String
    @State private var model: ConsoleModel
    @State private var typing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(address: String, vm: String, name: String, settings: Settings, away: Bool = false) {
        self.name = name
        _model = State(initialValue: ConsoleModel(address: address, target: .xo(vm: vm), name: name, settings: settings, away: away))
    }

    /// A Proxmox VE machine's screen, by node and number, opened with the
    /// cluster's record this phone keeps (ProxmoxKept).
    init(proxmox address: String, node: String, vmid: Int, name: String, settings: Settings) {
        self.name = name
        _model = State(initialValue: ConsoleModel(address: address, target: .proxmox(node: node, vmid: vmid), name: name, settings: settings))
    }

    var body: some View {
        VStack(spacing: 0) {
            if let line = model.line {
                VStack(alignment: .leading, spacing: Design.Space.insideTight) {
                    Text(line)
                        .fleetType(.label)
                        .foregroundStyle(model.troubled ? Design.Palette.bad : Design.Palette.inkDim)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if model.retry {
                        Button(Manage.Words.openAgain) { model.restart() }
                            .frame(minHeight: 44)
                            .tint(Design.Palette.accent)
                    }
                }
                .padding(Design.Space.inside)
                .background(Design.Palette.card)
                .transition(.opacity)
            } else if let via = model.via {
                // FROM AWAY, said once and quietly, AS A CHIP: which machine
                // carries the screen, in the small type on its own small
                // surface, not a banner across the top of a console somebody
                // is working in. The words are Manage.Words', the pool page's.
                HStack {
                    Text(Manage.Words.consoleAwayVia(via))
                        .fleetType(.micro)
                        .foregroundStyle(Design.Palette.inkDim)
                        .padding(.horizontal, Design.Space.insideTight)
                        .padding(.vertical, Design.Space.hair)
                        .background(
                            Design.Palette.card,
                            in: RoundedRectangle(cornerRadius: Design.Radius.chip, style: .continuous)
                        )
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Design.Space.inside)
                .padding(.vertical, Design.Space.insideTight)
                .transition(.opacity)
            }
            ZStack {
                ConsoleWeb(model: model)
                KeyCatcher(active: $typing, onText: model.type, onKey: model.key)
                    .frame(width: 1, height: 1)
                    .opacity(0)
                    .accessibilityHidden(true)
            }
        }
        .animation(reduceMotion ? nil : Design.Motion.change, value: model.line)
        .background(Design.Palette.bg)
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                // The keyboard has a symbol and takes it, so it can stand in the
                // Duo's vertical bar. Ctrl-Alt-Del does not: the words ARE the
                // information, so it stays horizontal, as Apple's own guidance
                // keeps text that means something on its own.
                Button { typing.toggle() } label: {
                    Label(Manage.Words.keyboard, systemImage: "keyboard")
                }
                    .disabled(!model.connected)
                Spacer()
                Button(Manage.Words.ctrlAltDel) { model.ctrlAltDel() }
                    .disabled(!model.connected)
            }
        }
        .onDisappear { model.stop() }
    }
}

/// The console's state, and the bridge between the socket and the page.
@MainActor @Observable
final class ConsoleModel {
    /// The address the page is loaded under, BASE in scripts/build-vnc.mjs:
    /// https, so the page is a secure context, and resolving nowhere.
    static let base = "https://console.fleetwright.invalid/"

    let address: String
    let target: Target
    let name: String

    /// Whose console: Xen Orchestra's by its VM id, or Proxmox VE's by node
    /// and number.
    enum Target {
        case xo(vm: String)
        case proxmox(node: String, vmid: Int)
    }

    /// What the console is doing, said above it; nil once the screen shows.
    private(set) var line: String? = nil
    private(set) var troubled = false
    private(set) var retry = false
    private(set) var connected = false

    @ObservationIgnored weak var web: WKWebView?
    @ObservationIgnored private var socket: ConsoleSocket?
    @ObservationIgnored private var pageReady = false
    @ObservationIgnored private let settings: Settings
    /// Through one of your machines, from the first try (a page read away)
    /// or after this phone could not reach the pool itself.
    @ObservationIgnored private var away: Bool
    @ObservationIgnored private var tunnel: ConsoleTunnel?
    /// The socket reached Xen Orchestra: a close after this is Xen
    /// Orchestra's answer, not the network's.
    @ObservationIgnored private var reached = false
    /// The machine carrying it from away, said above the screen.
    private(set) var via: String? = nil

    init(address: String, target: Target, name: String, settings: Settings, away: Bool = false) {
        self.address = address
        self.target = target
        self.name = name
        self.settings = settings
        self.away = away
        line = away ? Manage.Words.consoleAwayOpening : Manage.Words.consoleOpening(name)
    }

    /// The page said what it is doing.
    func fromPage(_ m: [String: Any]) {
        switch m["t"] as? String {
        case "send":
            if let b = m["b"] as? String, let data = Data(base64Encoded: b) { socket?.send(data) }
        case "close":
            socket?.close()
            socket = nil
        case "state":
            switch m["s"] as? String {
            case "ready":
                pageReady = true
                open()
            case "connected":
                connected = true
                show(nil)
            case "ended":
                ended(Manage.Words.consoleEnded)
            case "refused":
                ended(Manage.Words.consoleRefused((m["why"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "it gave no reason"))
            default: break
            }
        default: break
        }
    }

    func restart() {
        socket?.close()
        socket = nil
        tunnel?.close()
        tunnel = nil
        connected = false
        pageReady = false
        show(Manage.Words.consoleOpening(name))
        load()
    }

    func stop() {
        socket?.close()
        socket = nil
        tunnel?.close()
        tunnel = nil
    }

    func type(_ text: String) { call("fwConsole.type(\(Self.quoted(text)))") }
    func key(_ name: String) { call("fwConsole.key(\(Self.quoted(name)))") }
    func ctrlAltDel() { call("fwConsole.ctrlAltDel()") }

    /// The page, from the bundle, under `base`.
    func load() {
        guard let web, let url = Bundle.main.url(forResource: "vnc", withExtension: "html"),
              let html = try? String(contentsOf: url, encoding: .utf8) else { return }
        web.loadHTMLString(html, baseURL: URL(string: Self.base))
    }

    private func open() {
        guard pageReady, socket == nil else { return }
        // WHAT THE SOCKET IS OPENED WITH, behind the check it is only ever
        // sent through: a Xen Orchestra pool's token and pin, or a Proxmox VE
        // cluster's token and CA, as this phone keeps them.
        switch target {
        case let .xo(vm):
            guard let raw = Keychain.get(XOSetupHandoff.tokenAccount(address)),
                  let record = Manage.record(raw, address: address), !record.plain, let pin = record.pin
            else {
                ended(Manage.Words.consoleShut)
                return
            }
            let make: (NWEndpoint?) -> ConsoleSocket? = { [address] proxy in XOConsole(address: address, vm: vm, token: record.token, pin: pin, proxy: proxy) }
            guard away else {
                connect(make(nil))
                return
            }
            Task { @MainActor in
                guard let proxy = await reach() else { return }
                connect(make(proxy))
            }
        case let .proxmox(node, vmid):
            guard let trust = ProxmoxKept.record(address) else {
                ended(Manage.Words.consoleShut)
                return
            }
            Task { @MainActor in await openProxmox(node: node, vmid: vmid, trust: trust) }
        }
    }

    /// FROM AWAY, a tunnel through one of your machines, said once it is
    /// carrying; nil when it could not be opened, which has been said.
    private func reach() async -> NWEndpoint? {
        tunnel?.close()
        let tunnel = ConsoleTunnel(address: address)
        self.tunnel = tunnel
        tunnel.onEnd = { [weak self] why in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.tunnelEnded(why) } }
        }
        show(Manage.Words.consoleAwayOpening)
        do {
            let (proxy, host) = try await tunnel.open(settings: settings)
            guard self.tunnel === tunnel else { return nil }
            via = host
            return proxy
        } catch {
            guard self.tunnel === tunnel else { return nil }
            self.tunnel = nil
            ended(error.localizedDescription)
            return nil
        }
    }

    /// PROXMOX VE'S, IN TWO REQUESTS: the ticket, then the screen. From away
    /// each takes a tunnel of its own, the ticket's closed before the screen's
    /// opens, because a tunnel carries one connection. A node this phone
    /// cannot reach is tried once through one of your machines.
    private func openProxmox(node: String, vmid: Int, trust: ProxmoxKept.Trust) async {
        var proxy: NWEndpoint? = nil
        if away {
            guard let p = await reach() else { return }
            proxy = p
        }
        let handed: ProxmoxConsole.Handed
        do {
            handed = try await ProxmoxConsole.ticket(address: address, node: node, vmid: vmid, trust: trust, proxy: proxy)
        } catch ProxmoxConsole.Refusal.wrongCertificate {
            show(Manage.Words.wrongCertificate(address), troubled: true, retry: false)
            return
        } catch ProxmoxConsole.Refusal.unreachable(let why) {
            if !away {
                away = true
                await openProxmox(node: node, vmid: vmid, trust: trust)
            } else {
                ended(Manage.Words.consoleRefused(why))
            }
            return
        } catch {
            ended(Manage.Words.consoleRefused(error.localizedDescription))
            return
        }
        if away {
            // The ticket's tunnel is done; the screen takes its own.
            let spent = tunnel
            tunnel = nil
            spent?.close()
            guard let p = await reach() else { return }
            proxy = p
        }
        connect(ProxmoxConsole(address: address, node: node, vmid: vmid, trust: trust, handed: handed, proxy: proxy))
    }

    private func tunnelEnded(_ why: String) {
        tunnel = nil
        socket?.close()
        socket = nil
        call("fwConsole.closed(\(Self.quoted(why)))")
        ended(why)
    }

    private func connect(_ made: ConsoleSocket?) {
        guard let socket = made else {
            ended(Manage.Words.consoleShut)
            return
        }
        reached = false
        // IN ORDER, on the main queue: VNC is a stream, and a frame handed
        // over out of turn corrupts every one after it. A Task each would not
        // promise the order; the main queue does.
        socket.onOpen = { [weak self, weak socket] in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.reached = true
                    // PROXMOX VE'S VNC TICKET, the password its console asks
                    // for, handed to the page before it is told the socket is open.
                    if let password = socket?.password { self?.call("fwConsole.password(\(Self.quoted(password)))") }
                    self?.call("fwConsole.opened()")
                }
            }
        }
        socket.onData = { [weak self] data in
            let b64 = data.base64EncodedString()
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.call("fwConsole.data('\(b64)')") } }
        }
        socket.onEnd = { [weak self] why, wrongCertificate in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.socketEnded(why, wrongCertificate: wrongCertificate) } }
        }
        self.socket = socket
        socket.open()
    }

    private func socketEnded(_ why: String, wrongCertificate: Bool) {
        socket = nil
        // THIS PHONE COULD NOT REACH THE POOL: once, the same console through
        // one of your machines, before anything is said.
        if !reached, !wrongCertificate, !away {
            away = true
            open()
            return
        }
        call("fwConsole.closed(\(Self.quoted(why)))")
        if wrongCertificate {
            show(Manage.Words.wrongCertificate(address), troubled: true, retry: false)
        } else if !connected {
            // Closed before the screen came: Xen Orchestra refusing the
            // token's user, most likely, which it does by closing.
            ended(Manage.Words.consoleShut)
        } else {
            ended(Manage.Words.consoleEnded)
        }
    }

    private func ended(_ said: String) {
        guard line == nil || !retry else { return }
        connected = false
        show(said, troubled: true, retry: true)
    }

    private func show(_ said: String?, troubled: Bool = false, retry: Bool = false) {
        line = said
        self.troubled = troubled
        self.retry = retry
    }

    private func call(_ js: String) {
        web?.evaluateJavaScript(js, completionHandler: nil)
    }

    /// A string as a JavaScript literal.
    private static func quoted(_ s: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [s])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }
}

/// The web view the page runs in.
private struct ConsoleWeb: UIViewRepresentable {
    let model: ConsoleModel

    func makeCoordinator() -> Bridge { Bridge(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.dataDetectorTypes = []
        config.userContentController.add(context.coordinator, name: "fw")
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
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

    /// Holds the model weakly: the content controller keeps its handler.
    final class Bridge: NSObject, WKScriptMessageHandler {
        weak var model: ConsoleModel?
        init(model: ConsoleModel) { self.model = model }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let m = message.body as? [String: Any] else { return }
            MainActor.assumeIsolated { model?.fromPage(m) }
        }
    }
}

/// A view that takes the keyboard and hands each key to the console: iOS
/// raises no keyboard for a web field focused from code. Bound to `active`.
private struct KeyCatcher: UIViewRepresentable {
    @Binding var active: Bool
    let onText: (String) -> Void
    let onKey: (String) -> Void

    func makeUIView(context: Context) -> Catcher {
        let v = Catcher()
        v.onText = onText
        v.onKey = onKey
        return v
    }

    func updateUIView(_ v: Catcher, context: Context) {
        if active, !v.isFirstResponder { v.becomeFirstResponder() }
        if !active, v.isFirstResponder { v.resignFirstResponder() }
    }

    final class Catcher: UIView, UIKeyInput {
        var onText: (String) -> Void = { _ in }
        var onKey: (String) -> Void = { _ in }
        override var canBecomeFirstResponder: Bool { true }
        var hasText: Bool { true }
        var autocorrectionType: UITextAutocorrectionType = .no
        var autocapitalizationType: UITextAutocapitalizationType = .none
        var spellCheckingType: UITextSpellCheckingType = .no
        var smartQuotesType: UITextSmartQuotesType = .no
        var smartDashesType: UITextSmartDashesType = .no
        func insertText(_ text: String) { onText(text) }
        func deleteBackward() { onKey("Backspace") }
    }
}
