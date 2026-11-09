import Foundation
import Network
import Security

/// A Proxmox VE cluster this phone keeps the record for, as the line carried
/// it: the token, and how to trust the cluster. docs/proxmox.md, "A machine's
/// page".
///
/// KEPT HERE TOO, NOT ONLY IN THE VAULT, for the console in the app: the phone
/// opens the console itself, with the token, behind TLS held to the cluster's
/// own CA, so the screen and every key typed travel encrypted from this phone
/// to the node, through one of your machines from away (ConsoleTunnel) as well.
/// The same as a Xen Orchestra pool's token (XOSetupHandoff): this device
/// only, after the first unlock, never in a backup, and gone at sign-out.
enum ProxmoxKept {
    private static let heldKey = "proxmox-held"

    static func account(_ address: String) -> String { "proxmox-record.\(address)" }

    /// Keep the record the setup left, under the address it names.
    static func keep(_ record: ProxmoxLine.Record) {
        Keychain.set(record.json, for: account(record.address))
        var all = held()
        if !all.contains(record.address) { all.append(record.address) }
        UserDefaults.standard.set(all, forKey: heldKey)
    }

    /// The addresses this phone keeps a record for.
    static func held() -> [String] {
        (UserDefaults.standard.stringArray(forKey: heldKey) ?? []).filter { Keychain.get(account($0)) != nil }
    }

    static func record(_ address: String) -> Trust? {
        guard let raw = Keychain.get(account(address)),
              let object = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
              let token = object["token"] as? String, !token.isEmpty
        else { return nil }
        if let ca = object["ca"] as? String, !ca.isEmpty {
            let certs = Trust.certificates(ca)
            return certs.isEmpty ? nil : Trust(token: token, anchors: certs, name: nil)
        }
        guard object["trust"] as? String == "public" else { return nil }
        return Trust(token: token, anchors: nil, name: object["name"] as? String)
    }

    /// Every record, gone: what signing out does (Settings.signOut).
    static func forgetAll() {
        for address in UserDefaults.standard.stringArray(forKey: heldKey) ?? [] {
            Keychain.set("", for: account(address))
        }
        UserDefaults.standard.removeObject(forKey: heldKey)
    }

    /// The token, and the one way the cluster is trusted, as the boxes trust
    /// it (src/fleet/host/pve-api.js, connectTrusted).
    struct Trust {
        let token: String
        /// The cluster's own CA, and only it: no name is checked, because the
        /// CA is the cluster's alone and signs nothing else.
        let anchors: [SecCertificate]?
        /// A publicly trusted certificate, held to the name it was issued to
        /// while the address is dialled (the line's `name`), or to the
        /// address's own host when there is none.
        let name: String?

        /// Whether the server's chain is the cluster's, checked before a byte
        /// is sent.
        func accepts(_ trust: SecTrust, host: String) -> Bool {
            if let anchors {
                SecTrustSetPolicies(trust, SecPolicyCreateBasicX509())
                SecTrustSetAnchorCertificates(trust, anchors as CFArray)
                SecTrustSetAnchorCertificatesOnly(trust, true)
            } else {
                SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, (name ?? host) as CFString))
            }
            return SecTrustEvaluateWithError(trust, nil)
        }

        /// The certificate blocks in a PEM file, as the line carries them.
        static func certificates(_ pem: String) -> [SecCertificate] {
            pem.components(separatedBy: "-----END CERTIFICATE-----").compactMap { block in
                guard let start = block.range(of: "-----BEGIN CERTIFICATE-----") else { return nil }
                let body = block[start.upperBound...].components(separatedBy: .whitespacesAndNewlines).joined()
                guard let der = Data(base64Encoded: body) else { return nil }
                return SecCertificateCreateWithData(nil, der as CFData)
            }
        }
    }
}

/// One machine's screen from Proxmox VE, in two requests: `vncproxy` hands
/// back a port and a one-use ticket (`ticket`), and `vncwebsocket` carries the
/// VNC (this socket). Both send the token as Proxmox VE reads it
/// (`Authorization: PVEAPIToken=…`), behind TLS held to the cluster
/// (ProxmoxKept.Trust). The ticket is also the VNC password noVNC is asked for
/// (page.js, `fwConsole.password`).
///
/// TWO CONNECTIONS, ONE AFTER THE OTHER, because a tunnel from away carries
/// one (ConsoleTunnel): the screen takes a tunnel of its own after the ticket's
/// is closed. Proxmox VE's ticket lasts long enough for that.
///
/// BYTES IN, BYTES OUT, as XOConsole: nothing here speaks VNC, and nothing is
/// logged.
final class ProxmoxConsole: NSObject, URLSessionWebSocketDelegate, ConsoleSocket, @unchecked Sendable {
    private let url: URL
    private let host: String
    private let trust: ProxmoxKept.Trust
    private let proxy: NWEndpoint?
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var sawWrongCertificate = false
    private var ended = false

    var onOpen: (@Sendable () -> Void)?
    var onData: (@Sendable (Data) -> Void)?
    var onEnd: (@Sendable (_ why: String, _ wrongCertificate: Bool) -> Void)?
    let password: String?

    /// A console the cluster handed out: what `ticket` answered.
    struct Handed {
        let port: Int
        let ticket: String
    }

    /// Why a console could not be handed out.
    enum Refusal: Error, LocalizedError {
        case wrongCertificate
        case unreachable(String)
        case refused(String)
        var errorDescription: String? {
            switch self {
            case .wrongCertificate: return "the certificate was not the cluster's"
            case let .unreachable(why), let .refused(why): return why
            }
        }
    }

    static func path(node: String, vmid: Int) -> String? {
        node.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$", options: .regularExpression) == nil ? nil : "api2/json/nodes/\(node)/qemu/\(vmid)"
    }

    /// Ask the cluster for a console: `vncproxy` with the token, through
    /// `proxy` from away.
    static func ticket(address: String, node: String, vmid: Int, trust: ProxmoxKept.Trust, proxy: NWEndpoint?) async throws -> Handed {
        guard let path = path(node: node, vmid: vmid), let base = URL(string: "https://\(address)/"), let host = base.host else {
            throw Refusal.refused("the machine's place on the cluster is not one this phone can name")
        }
        let checker = TrustCheck(trust: trust, host: host)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        config.httpCookieStorage = nil
        if let proxy { config.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: proxy)] }
        let session = URLSession(configuration: config, delegate: checker, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var ask = URLRequest(url: base.appendingPathComponent("\(path)/vncproxy"))
        ask.httpMethod = "POST"
        ask.setValue("PVEAPIToken=\(trust.token)", forHTTPHeaderField: "Authorization")
        ask.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        ask.httpBody = Data("websocket=1".utf8)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: ask)
        } catch {
            if checker.mismatch { throw Refusal.wrongCertificate }
            throw Refusal.unreachable(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let answer = object["data"] as? [String: Any],
              let ticket = answer["ticket"] as? String,
              let port = (answer["port"] as? Int) ?? Int(answer["port"] as? String ?? "")
        else {
            throw Refusal.refused(status == 403
                ? "the cluster's token may not open this machine's console; run the setup again on the node"
                : "the cluster did not hand out a console (\(status))")
        }
        return Handed(port: port, ticket: ticket)
    }

    init?(address: String, node: String, vmid: Int, trust: ProxmoxKept.Trust, handed: Handed, proxy: NWEndpoint? = nil) {
        guard let path = Self.path(node: node, vmid: vmid), let base = URL(string: "https://\(address)/"), let host = base.host,
              var parts = URLComponents(url: base.appendingPathComponent("\(path)/vncwebsocket"), resolvingAgainstBaseURL: false)
        else { return nil }
        parts.scheme = "wss"
        parts.queryItems = [URLQueryItem(name: "port", value: String(handed.port)), URLQueryItem(name: "vncticket", value: handed.ticket)]
        // A ticket carries + and /, which a query must not leave bare.
        parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = parts.url else { return nil }
        self.url = url
        self.host = host
        self.trust = trust
        self.proxy = proxy
        self.password = handed.ticket
        super.init()
    }

    func open() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        config.httpCookieStorage = nil
        if let proxy { config.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: proxy)] }
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        var request = URLRequest(url: url)
        request.setValue("PVEAPIToken=\(trust.token)", forHTTPHeaderField: "Authorization")
        request.setValue("binary", forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 16 * 1024 * 1024
        lock.withLock {
            self.session = session
            self.task = task
        }
        task.resume()
    }

    func send(_ data: Data) {
        let task: URLSessionWebSocketTask? = lock.withLock { ended ? nil : self.task }
        task?.send(.data(data)) { [weak self] error in
            if let error { self?.end(error.localizedDescription) }
        }
    }

    /// Asked to end: nothing is reported to `onEnd`.
    func close() {
        let (task, session): (URLSessionWebSocketTask?, URLSession?) = lock.withLock {
            ended = true
            return (self.task, self.session)
        }
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        if trust.accepts(serverTrust, host: host) {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            lock.withLock { sawWrongCertificate = true }
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol chosen: String?) {
        onOpen?()
        receive()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        end("Proxmox VE closed the console")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        end(error?.localizedDescription ?? "the connection closed")
    }

    private func receive() {
        let task: URLSessionWebSocketTask? = lock.withLock { ended ? nil : self.task }
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(.data(data)):
                self.onData?(data)
                self.receive()
            case let .success(.string(text)):
                self.onData?(Data(text.utf8))
                self.receive()
            case .success:
                self.receive()
            case let .failure(error):
                self.end(error.localizedDescription)
            }
        }
    }

    private func end(_ why: String) {
        let (already, wrong): (Bool, Bool) = lock.withLock {
            defer { ended = true }
            return (ended, sawWrongCertificate)
        }
        guard !already else { return }
        session?.invalidateAndCancel()
        onEnd?(why, wrong)
    }
}

/// The cluster's check for the ticket's request, and whether it failed.
private final class TrustCheck: NSObject, URLSessionDelegate, @unchecked Sendable {
    let trust: ProxmoxKept.Trust
    let host: String
    private let lock = NSLock()
    private var failed = false
    var mismatch: Bool { lock.withLock { failed } }

    init(trust: ProxmoxKept.Trust, host: String) {
        self.trust = trust
        self.host = host
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        if trust.accepts(serverTrust, host: host) {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            lock.withLock { failed = true }
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
