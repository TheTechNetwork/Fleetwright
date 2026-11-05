import Foundation
import Network

/// A VM's console for this phone away from the pool, through one of your
/// machines that holds the pool. docs/manage.md, "The console"; the fleet's
/// half is src/fleet/coordinator/tunnels.js and src/fleet/host/console-tunnel.js.
///
/// THE PHONE STILL OPENS TLS ITSELF, held to the pool's pin, exactly as it does
/// on the pool's own network (XOConsole): the machine makes one plain TCP
/// connection to the pool and pumps bytes, and the fleet carries them, so what
/// crosses both is TLS records, the token and the screen inside them.
///
/// HOW THE CONSOLE'S OWN SOCKET RIDES IT. XOConsole's URLSession is pointed at
/// an HTTP CONNECT proxy on this phone's loopback (`ProxyConfiguration`), which
/// is this: it answers the CONNECT and then joins that connection to the
/// fleet's socket (GET /api/xoconsole/tunnel). The URL, the Host the request
/// names and the server name TLS asks for are the pool's own, so nothing about
/// the console changes but the path its bytes take.
///
/// ONE CONSOLE, ONE CONNECTION: the proxy takes the first connection made to
/// it and refuses any other, and listens on loopback only.
final class ConsoleTunnel: @unchecked Sendable {
    let address: String
    private let queue = DispatchQueue(label: "fleetwright.console-tunnel")
    private var task: URLSessionWebSocketTask?
    private var listener: NWListener?
    private var client: NWConnection?
    private var head = Data()
    private var joined = false
    private var finished = false
    private var hostId = ""
    private var waiting: CheckedContinuation<(NWEndpoint, String), Error>?

    /// The fleet or the machine ended it: said in their words.
    var onEnd: (@Sendable (String) -> Void)?

    init(address: String) {
        self.address = address
    }

    /// Open the tunnel and the proxy, and wait until the machine has reached
    /// the pool. Answers the proxy's endpoint and the machine carrying it.
    func open(settings: Settings) async throws -> (NWEndpoint, String) {
        guard var parts = URLComponents(string: settings.coordinatorURL + "/api/xoconsole/tunnel"), let scheme = parts.scheme?.lowercased() else {
            throw FleetError.message("That coordinator URL is not a URL")
        }
        // NOT OVER CLEARTEXT: the upgrade carries this device's credential.
        if scheme != "https", !Fleet.isLocal(parts.host) {
            throw FleetError.message("Refusing to send your credential over plain http. Use https:// for \(parts.host ?? "that address").")
        }
        parts.scheme = scheme == "https" ? "wss" : "ws"
        parts.queryItems = [URLQueryItem(name: "address", value: address)]
        guard let url = parts.url else { throw FleetError.message("That coordinator URL is not a URL") }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(settings.credential)", forHTTPHeaderField: "authorization")
        if settings.viewAsMember { request.setValue("member", forHTTPHeaderField: "x-fleetwright-view") }
        let task = URLSession.shared.webSocketTask(with: request)
        task.maximumMessageSize = 1 << 20
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.task = task
                self.waiting = continuation
                task.resume()
                self.receive()
            }
        }
    }

    /// Stop: the proxy, its connection and the fleet's socket all end now.
    func close() {
        queue.async { self.finish(nil) }
    }

    // MARK: The fleet's side

    private func receive() {
        task?.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard !self.finished else { return }
                switch result {
                case .success(.string(let text)):
                    self.handle(text)
                    self.receive()
                case .success:
                    self.receive()
                case .failure:
                    self.finish("The connection to the fleet ended, so the console from away closed.")
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let op = frame["op"] as? String
        else { return }
        switch op {
        case "ready":
            hostId = frame["hostId"] as? String ?? ""
        case "open":
            // THE MACHINE HAS REACHED THE POOL: only now is there anywhere
            // for the console's bytes to go, so only now does the proxy listen.
            listen()
        case "data":
            guard let encoded = frame["data"] as? String, let bytes = Data(base64Encoded: encoded) else { return }
            client?.send(content: bytes, completion: .contentProcessed { _ in })
        case "closed":
            finish(frame["text"] as? String ?? "The fleet closed the console from away.")
        default:
            break
        }
    }

    private func toFleet(_ frame: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: frame), let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { [weak self] error in
            guard error != nil, let self else { return }
            self.queue.async { self.finish("The connection to the fleet ended, so the console from away closed.") }
        }
    }

    // MARK: The proxy, on loopback

    private func listen() {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        guard let listener = try? NWListener(using: parameters) else {
            finish("This phone could not start the console from away.")
            return
        }
        self.listener = listener
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            self.queue.async { self.accept(connection) }
        }
        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            self.queue.async {
                switch state {
                case .ready:
                    guard let port = listener.port, let waiting = self.waiting else { return }
                    self.waiting = nil
                    waiting.resume(returning: (.hostPort(host: "127.0.0.1", port: port), self.hostId))
                case .failed:
                    self.finish("This phone could not start the console from away.")
                default:
                    break
                }
            }
        }
        listener.start(queue: queue)
    }

    private func accept(_ connection: NWConnection) {
        // ONE CONNECTION: the console's. Anything else on loopback is refused.
        guard client == nil, !finished else {
            connection.cancel()
            return
        }
        client = connection
        connection.start(queue: queue)
        readHead()
    }

    /// The CONNECT request, up to its blank line; then the proxy's answer,
    /// and from there every byte is the console's TLS.
    private func readHead() {
        client?.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, done, error in
            guard let self else { return }
            self.queue.async {
                if let data { self.head.append(data) }
                if let end = self.head.range(of: Data("\r\n\r\n".utf8)) {
                    guard self.head.starts(with: Data("CONNECT ".utf8)) else {
                        self.finish("The console asked this phone's proxy for something other than a connection.")
                        return
                    }
                    let rest = self.head[end.upperBound...]
                    self.head = Data()
                    self.joined = true
                    self.client?.send(content: Data("HTTP/1.1 200 Connection established\r\n\r\n".utf8), completion: .contentProcessed { _ in })
                    if !rest.isEmpty { self.carry(Data(rest)) }
                    self.pump()
                } else if done || error != nil || self.head.count > 16384 {
                    self.finish("The console closed before it reached the pool.")
                } else {
                    self.readHead()
                }
            }
        }
    }

    private func pump() {
        client?.receive(minimumIncompleteLength: 1, maximumLength: 48 * 1024) { [weak self] data, _, done, error in
            guard let self else { return }
            self.queue.async {
                if let data, !data.isEmpty { self.carry(data) }
                if done || error != nil {
                    self.finish(nil)
                } else {
                    self.pump()
                }
            }
        }
    }

    /// Bytes for the pool, in pieces the fleet carries (48 KiB at most).
    private func carry(_ data: Data) {
        var at = data.startIndex
        while at < data.endIndex {
            let next = data.index(at, offsetBy: 48 * 1024, limitedBy: data.endIndex) ?? data.endIndex
            toFleet(["op": "data", "data": data[at..<next].base64EncodedString()])
            at = next
        }
    }

    private func finish(_ why: String?) {
        guard !finished else { return }
        finished = true
        if why == nil { toFleet(["op": "end"]) }
        client?.cancel()
        listener?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        let text = why ?? "The console from away closed."
        if let waiting {
            self.waiting = nil
            waiting.resume(throwing: FleetError.message(text))
        } else if why != nil {
            onEnd?(text)
        }
    }
}
