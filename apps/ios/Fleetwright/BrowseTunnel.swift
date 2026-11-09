import Foundation
import Network
import Security

/// A web view's connections, leaving from one of your machines: this phone's
/// half. docs/browse.md; the fleet's half is src/fleet/coordinator/browse.js
/// and src/fleet/host/browse.js.
///
/// AN HTTP PROXY ON THIS PHONE'S LOOPBACK, joined to one socket to the fleet
/// (GET /api/browse). The web view is pointed at it (`ProxyConfiguration`, set
/// on its own data store, so it reaches that web view and nothing else). Each
/// connection the web view makes becomes a STREAM: the machine makes that TCP
/// connection, and the bytes go both ways as frames. The console's tunnel
/// carries one connection; a page is dozens.
///
/// THE PHONE STILL HOLDS THE TLS. For an https page the web view sends
/// `CONNECT host:443`, and once the machine has connected it opens TLS through
/// the stream itself, to the page's own name, checked by the system's trust.
/// What the machine and the fleet carry is TLS records.
///
/// A PLAIN-HTTP REQUEST may come as `GET http://host/path` rather than as a
/// CONNECT. The stream goes to that host, the first line is rewritten to
/// `GET /path`, the `Proxy-` headers are dropped, and the server is asked to
/// close after one answer, so the next request opens the next stream.
///
/// ONLY THE WEB VIEW MAY USE IT. Loopback is every app on the phone, and this
/// proxy spends this person's credential on a machine's address, so it answers
/// only a request carrying the name and password made for this screen, which
/// the web view is given and nothing else is. It listens on 127.0.0.1 only.
final class BrowseTunnel: @unchecked Sendable {
    let host: String
    let session: String?
    /// What the machine opens for this person besides the session, as the
    /// fleet said when it opened: nil where its own rules do not apply to them.
    struct Opens: Equatable {
        let web: Bool
        let hosts: [String]
    }

    private let queue = DispatchQueue(label: "fleetwright.browse")
    private var task: URLSessionWebSocketTask?
    private var listener: NWListener?
    private var finished = false
    private var waiting: CheckedContinuation<(NWEndpoint, Opens?), Error>?
    private var opens: Opens?
    private var next = 1
    private var streams: [Int: Conn] = [:]
    /// Every connection the web view has made that is not yet a stream: still
    /// sending its head, or being told 407. Cancelled with the rest.
    private var unjoined: [ObjectIdentifier: NWConnection] = [:]
    /// The name and password this screen's web view is given for the proxy.
    let proxyUser = "fleetwright"
    let proxyPassword: String = {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
    }()
    private var expectedAuth: String { "Basic " + Data("\(proxyUser):\(proxyPassword)".utf8).base64EncodedString() }

    /// The fleet or the machine ended it: said in their words.
    var onEnd: (@Sendable (String) -> Void)?
    /// The machine would not open a connection, and why. The screen shows
    /// the last one when a page does not load.
    var onRefused: (@Sendable (String) -> Void)?

    private final class Conn {
        let client: NWConnection
        var head = Data()
        var stream = 0
        var tunnel = false
        var pending = Data()
        var joined = false
        init(_ client: NWConnection) { self.client = client }
    }

    init(host: String, session: String?) {
        self.host = host
        self.session = session
    }

    /// A tunnel nobody closed still lets go of its socket and its listener.
    deinit {
        listener?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        for c in streams.values { c.client.cancel() }
        for c in unjoined.values { c.cancel() }
    }

    /// Open the socket and the proxy, and wait until the machine agrees.
    /// Answers the proxy's endpoint, and what the machine opens for you.
    func open(settings: Settings) async throws -> (NWEndpoint, Opens?) {
        guard var parts = URLComponents(string: settings.coordinatorURL + "/api/browse"), let scheme = parts.scheme?.lowercased() else {
            throw FleetError.message("That fleet address is not a URL")
        }
        // NOT OVER CLEARTEXT: the upgrade carries this device's credential.
        if scheme != "https", !Fleet.isLocal(parts.host) {
            throw FleetError.message("Refusing to send your credential over plain http. Use https:// for \(parts.host ?? "that address").")
        }
        parts.scheme = scheme == "https" ? "wss" : "ws"
        parts.queryItems = [URLQueryItem(name: "host", value: host)] + (session.map { [URLQueryItem(name: "session", value: $0)] } ?? [])
        guard let url = parts.url else { throw FleetError.message("That fleet address is not a URL") }
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

    /// Stop: the proxy, every connection and the fleet's socket end now.
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
                    self.finish(BrowseWords.lost)
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let op = frame["op"] as? String
        else { return }
        let stream = frame["stream"] as? Int ?? 0
        switch op {
        case "ready":
            if let o = frame["opens"] as? [String: Any] {
                opens = Opens(web: o["web"] as? Bool ?? false, hosts: o["hosts"] as? [String] ?? [])
            }
        case "open":
            // THE MACHINE AGREED: only now is there anywhere for a page's
            // bytes to go, so only now does the proxy listen.
            listen()
        case "connected":
            guard let c = streams[stream] else { return }
            c.joined = true
            if c.tunnel {
                c.client.send(content: Data("HTTP/1.1 200 Connection established\r\n\r\n".utf8), completion: .contentProcessed { _ in })
            }
            if !c.pending.isEmpty { carry(c.pending, on: stream) }
            c.pending = Data()
            pump(c)
        case "failed":
            guard let c = streams.removeValue(forKey: stream) else { return }
            let why = frame["text"] as? String ?? BrowseWords.couldNotConnect
            onRefused?(why)
            answer(c.client, status: "502 Bad Gateway", body: why)
        case "data":
            guard let c = streams[stream], let encoded = frame["data"] as? String, let bytes = Data(base64Encoded: encoded) else { return }
            // HANDED ON, THEN ACKNOWLEDGED: the machine reads no further ahead
            // of this phone than its window (docs/browse.md, "How fast").
            c.client.send(content: bytes, completion: .contentProcessed { [weak self] error in
                guard error == nil, let self else { return }
                self.queue.async {
                    guard self.streams[stream] === c else { return }
                    self.toFleet(["op": "ack", "stream": stream, "bytes": bytes.count])
                }
            })
        case "end":
            guard let c = streams.removeValue(forKey: stream) else { return }
            c.client.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.client.cancel() })
        case "closed":
            finish(frame["text"] as? String ?? BrowseWords.closed)
        default:
            break
        }
    }

    private func toFleet(_ frame: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: frame), let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { [weak self] error in
            guard error != nil, let self else { return }
            self.queue.async { self.finish(BrowseWords.lost) }
        }
    }

    // MARK: The proxy, on loopback

    private func listen() {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        guard let listener = try? NWListener(using: parameters) else {
            finish(BrowseWords.couldNotConnect)
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
                    waiting.resume(returning: (.hostPort(host: "127.0.0.1", port: port), self.opens))
                case .failed:
                    self.finish(BrowseWords.couldNotConnect)
                default:
                    break
                }
            }
        }
        listener.start(queue: queue)
    }

    private func accept(_ connection: NWConnection) {
        guard !finished else {
            connection.cancel()
            return
        }
        let c = Conn(connection)
        unjoined[ObjectIdentifier(connection)] = connection
        connection.start(queue: queue)
        readHead(c)
    }

    /// The request's head, up to its blank line: a CONNECT, or a plain-HTTP
    /// request in absolute form. Anything else is answered and closed.
    private func readHead(_ c: Conn) {
        c.client.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, done, error in
            guard let self else { return }
            self.queue.async {
                if let data { c.head.append(data) }
                guard let end = c.head.range(of: Data("\r\n\r\n".utf8)) else {
                    if done || error != nil || c.head.count > 16384 {
                        self.unjoined.removeValue(forKey: ObjectIdentifier(c.client))
                        c.client.cancel()
                    } else {
                        self.readHead(c)
                    }
                    return
                }
                self.unjoined.removeValue(forKey: ObjectIdentifier(c.client))
                let rest = Data(c.head[end.upperBound...])
                let lines = String(decoding: c.head[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
                c.head = Data()
                self.route(c, lines: lines, rest: rest)
            }
        }
    }

    private func route(_ c: Conn, lines: [String], rest: Data) {
        let first = lines.first?.split(separator: " ", omittingEmptySubsequences: true).map(String.init) ?? []
        guard first.count == 3 else { return answer(c.client, status: "400 Bad Request", body: "") }
        let headers = Array(lines.dropFirst())
        // THE WEB VIEW'S NAME AND PASSWORD, or nothing: see the type's header.
        let auth = headers.first { $0.lowercased().hasPrefix("proxy-authorization:") }
            .map { String($0.dropFirst("proxy-authorization:".count)).trimmingCharacters(in: .whitespaces) }
        guard auth == expectedAuth else {
            let reply = "HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm=\"fleetwright\"\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            c.client.send(content: Data(reply.utf8), contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in c.client.cancel() })
            return
        }
        let target: (host: String, port: Int)?
        if first[0].uppercased() == "CONNECT" {
            target = Self.hostPort(first[1], defaultPort: 443)
            c.tunnel = true
            c.pending = rest
        } else if let url = URLComponents(string: first[1]), url.scheme?.lowercased() == "http", let h = url.host, !h.isEmpty {
            target = (host: h, port: url.port ?? 80)
            // ONE REQUEST, THEN CLOSED: the path alone on the first line, no
            // proxy headers, and the server asked to close when it answers.
            let path = (url.percentEncodedPath.isEmpty ? "/" : url.percentEncodedPath) + (url.percentEncodedQuery.map { "?" + $0 } ?? "")
            let kept = headers.filter {
                let l = $0.lowercased()
                return !l.hasPrefix("proxy-") && !l.hasPrefix("connection:") && !l.hasPrefix("keep-alive:")
            }
            let head = (["\(first[0]) \(path) \(first[2])"] + kept + ["Connection: close", "", ""]).joined(separator: "\r\n")
            c.pending = Data(head.utf8) + rest
        } else {
            target = nil
        }
        guard let target, target.port > 0, target.port < 65536 else { return answer(c.client, status: "400 Bad Request", body: "") }
        let stream = next
        next += 1
        c.stream = stream
        streams[stream] = c
        toFleet(["op": "connect", "stream": stream, "host": target.host, "port": target.port])
        // NOT FOR EVER: a machine that never answers for a connection frees
        // it after thirty seconds, as Android does.
        queue.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self, self.streams[stream] === c, !c.joined else { return }
            self.streams.removeValue(forKey: stream)
            self.toFleet(["op": "end", "stream": stream])
            self.answer(c.client, status: "504 Gateway Timeout", body: BrowseWords.couldNotConnect)
        }
    }

    /// `host:port`, `[v6]:port`, or a host alone on the default port.
    static func hostPort(_ s: String, defaultPort: Int) -> (host: String, port: Int)? {
        if s.hasPrefix("["), let close = s.firstIndex(of: "]") {
            let h = String(s[s.index(after: s.startIndex)..<close])
            let after = s[s.index(after: close)...]
            if after.isEmpty { return (h, defaultPort) }
            guard after.hasPrefix(":"), let p = Int(after.dropFirst()) else { return nil }
            return (h, p)
        }
        guard let colon = s.lastIndex(of: ":") else { return (s, defaultPort) }
        guard let p = Int(s[s.index(after: colon)...]) else { return nil }
        return (String(s[..<colon]), p)
    }

    /// Bytes the web view wrote, for the machine.
    private func pump(_ c: Conn) {
        c.client.receive(minimumIncompleteLength: 1, maximumLength: 48 * 1024) { [weak self] data, _, done, error in
            guard let self else { return }
            self.queue.async {
                guard self.streams[c.stream] === c else { return }
                if let data, !data.isEmpty { self.carry(data, on: c.stream) }
                if done || error != nil {
                    self.streams.removeValue(forKey: c.stream)
                    self.toFleet(["op": "end", "stream": c.stream])
                    c.client.cancel()
                } else {
                    self.pump(c)
                }
            }
        }
    }

    /// Bytes for the machine, in pieces the fleet carries (48 KiB at most).
    private func carry(_ data: Data, on stream: Int) {
        var at = data.startIndex
        while at < data.endIndex {
            let next = data.index(at, offsetBy: 48 * 1024, limitedBy: data.endIndex) ?? data.endIndex
            toFleet(["op": "data", "stream": stream, "data": data[at..<next].base64EncodedString()])
            at = next
        }
    }

    /// A short answer from the proxy itself, then closed.
    private func answer(_ client: NWConnection, status: String, body: String) {
        let bytes = Data(body.utf8)
        let reply = "HTTP/1.1 \(status)\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: \(bytes.count)\r\nconnection: close\r\n\r\n"
        client.send(content: Data(reply.utf8) + bytes, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in client.cancel() })
    }

    private func finish(_ why: String?) {
        guard !finished else { return }
        finished = true
        if why == nil { toFleet(["op": "close"]) }
        for c in streams.values { c.client.cancel() }
        streams = [:]
        for c in unjoined.values { c.cancel() }
        unjoined = [:]
        listener?.cancel()
        task?.cancel(with: .goingAway, reason: nil)
        let text = why ?? BrowseWords.closed
        if let waiting {
            self.waiting = nil
            waiting.resume(throwing: FleetError.message(text))
        } else if why != nil {
            onEnd?(text)
        }
    }
}
