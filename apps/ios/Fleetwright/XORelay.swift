import CryptoKit
import Foundation
import Network
import Security

/// A relay through this phone, for a pool no machine in the fleet can reach.
/// docs/hypervisors.md, "Through the phone".
///
/// WHAT THIS PHONE DOES: it is a length of wire. The coordinator joins a
/// WebSocket from here (GET /api/xosetup/relay) to frames on one machine's
/// socket; for each connection that machine asks for, this phone opens a
/// plain TCP connection to the address the person typed, on its own network,
/// and pumps bytes both ways. The machine opens TLS over those bytes itself
/// and holds it to the pin (src/fleet/host/xo-relay.js), so what crosses this
/// phone is TLS records with the sign-in inside them, which it cannot read
/// and does not try to.
///
/// ONE ADDRESS, FIXED HERE. No frame names where to connect: the target is
/// parsed once from what was typed, and every connection goes to it, so
/// neither the machine nor the coordinator can point this phone at anything
/// else on the network it is on.
///
/// AND ITS OWN LOOK AT THE CERTIFICATE (`ownLook`). Through a relay the
/// coordinator is on the path the probe takes, so it could answer the
/// machine's handshake with a certificate of its own and have the person
/// accept it. This phone is on the pool's network itself: it reads the
/// certificate at the address directly, and the screen goes on only when the
/// machine saw that same one through the relay.
///
/// Network.framework for the TCP side, because a relay connection is raw bytes
/// that URLSession has no API for; URLSessionWebSocketTask for the fleet side,
/// with the same credential every other request carries. Everything that
/// touches the connections runs on one serial queue, so a frame is handled in
/// the order it arrived and the dictionary of connections has one owner.
///
/// THE SCREEN HAS TO STAY OPEN. iOS suspends an app in the background and its
/// sockets with it, so a relay lasts as long as Add a hypervisor is on screen;
/// it says so while the setup runs.
final class PhoneRelay: @unchecked Sendable {
    /// What the fleet said when it opened the relay.
    struct Ready {
        let relay: String
        let hostId: String
    }

    /// Where this phone connects: the typed address as a host and a port, the
    /// way the machine splits it (splitAddress in xo-ws.js), 443 when none.
    struct Target {
        let host: NWEndpoint.Host
        let port: NWEndpoint.Port
        /// The name the certificate is for, sent as SNI; nil for an address.
        let name: String?

        init?(_ address: String) {
            var host = address
            var port: UInt16 = 443
            if address.hasPrefix("[") {
                guard let close = address.firstIndex(of: "]") else { return nil }
                host = String(address[address.index(after: address.startIndex)..<close])
                let rest = address[address.index(after: close)...]
                if rest.hasPrefix(":") {
                    guard let given = UInt16(rest.dropFirst()) else { return nil }
                    port = given
                } else if !rest.isEmpty {
                    return nil
                }
            } else if let colon = address.lastIndex(of: ":") {
                host = String(address[..<colon])
                guard let given = UInt16(address[address.index(after: colon)...]) else { return nil }
                port = given
            }
            guard !host.isEmpty, let endpointPort = NWEndpoint.Port(rawValue: port) else { return nil }
            self.host = NWEndpoint.Host(host)
            self.port = endpointPort
            self.name = IPv4Address(host) == nil && IPv6Address(host) == nil ? host : nil
        }
    }

    /// The most one frame carries, the coordinator's bound (relays.js).
    static let chunk = 48 * 1024

    let address: String
    private let target: Target
    private let queue = DispatchQueue(label: "network.thetech.fleetwright.relay")
    private var task: URLSessionWebSocketTask?
    private var connections: [Int: NWConnection] = [:]
    /// Connections that reached the address, so one that ends is told as
    /// ended and one that never got there as refused.
    private var reached: Set<Int> = []
    private var waitingForReady: CheckedContinuation<Ready, Error>?
    private var finished = false
    /// Called once, on the main queue, when the relay closes for a reason
    /// this phone did not choose: the job ended, the fleet's limit, the
    /// connection to the fleet dropped.
    var onClose: ((String) -> Void)?

    init?(address: String) {
        guard let target = Target(address) else { return nil }
        self.address = address
        self.target = target
    }

    /// Open the relay for one machine, or the one the fleet chooses, and
    /// wait for the fleet to say it is ready or why it is not.
    func open(settings: Settings, host: String?) async throws -> Ready {
        guard var parts = URLComponents(string: settings.coordinatorURL + "/api/xosetup/relay"), let scheme = parts.scheme?.lowercased() else {
            throw FleetError.message("That coordinator URL is not a URL")
        }
        // NOT OVER CLEARTEXT, for the reason Fleet.send gives: the upgrade
        // carries this device's credential.
        if scheme != "https", !Fleet.isLocal(parts.host) {
            throw FleetError.message("Refusing to send your credential over plain http. Use https:// for \(parts.host ?? "that address").")
        }
        parts.scheme = scheme == "https" ? "wss" : "ws"
        parts.queryItems = [URLQueryItem(name: "address", value: address)] + (host.map { [URLQueryItem(name: "host", value: $0)] } ?? [])
        guard let url = parts.url else { throw FleetError.message("That coordinator URL is not a URL") }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(settings.credential)", forHTTPHeaderField: "authorization")
        if settings.viewAsMember { request.setValue("member", forHTTPHeaderField: "x-fleetwright-view") }
        let task = URLSession.shared.webSocketTask(with: request)
        task.maximumMessageSize = 1 << 20
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                self.task = task
                self.waitingForReady = continuation
                task.resume()
                self.receive()
            }
        }
    }

    /// Stop carrying it: every connection through this phone ends now.
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
                    self.finish("The connection to the fleet ended, so this phone is no longer carrying anything to Xen Orchestra.")
                }
            }
        }
    }

    private func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let frame = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let op = frame["op"] as? String
        else { return }
        let stream = frame["stream"] as? Int
        switch op {
        case "ready":
            guard let relay = frame["relay"] as? String, let hostId = frame["hostId"] as? String else { return }
            waitingForReady?.resume(returning: Ready(relay: relay, hostId: hostId))
            waitingForReady = nil
        case "closed":
            finish(frame["text"] as? String ?? "The fleet closed the relay.")
        case "open":
            if let stream { connect(stream) }
        case "data":
            guard let stream, let encoded = frame["data"] as? String, let bytes = Data(base64Encoded: encoded),
                  let connection = connections[stream] else { return }
            connection.send(content: bytes, completion: .contentProcessed { _ in })
        case "end":
            if let stream, let connection = connections.removeValue(forKey: stream) {
                reached.remove(stream)
                connection.cancel()
            }
        default:
            break
        }
    }

    private func send(_ frame: [String: Any]) {
        guard !finished, let task,
              let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8)
        else { return }
        // In the order called: the task sends its messages in order, and
        // every call is made from this one queue.
        task.send(.string(text)) { _ in }
    }

    // MARK: The address's side

    private func connect(_ stream: Int) {
        let connection = NWConnection(host: target.host, port: target.port, using: .tcp)
        connections[stream] = connection
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.reached.insert(stream)
                self.send(["op": "opened", "stream": stream])
                self.pump(stream, connection)
            case .failed(let error), .waiting(let error):
                self.drop(stream, connection, why: "this phone could not reach \(self.address): \(error.localizedDescription)")
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func pump(_ stream: Int, _ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: Self.chunk) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.send(["op": "data", "stream": stream, "data": data.base64EncodedString()])
            }
            if isComplete || error != nil {
                self.drop(stream, connection, why: nil)
            } else {
                self.pump(stream, connection)
            }
        }
    }

    /// A connection this phone ended, or that ended under it: the machine is
    /// told once, as refused when it never reached the address.
    private func drop(_ stream: Int, _ connection: NWConnection, why: String?) {
        guard connections[stream] === connection else { return }
        connections[stream] = nil
        connection.cancel()
        if reached.remove(stream) != nil {
            send(["op": "end", "stream": stream])
        } else {
            send(["op": "refused", "stream": stream, "text": why ?? "this phone could not reach \(address)"])
        }
    }

    private func finish(_ text: String?) {
        guard !finished else { return }
        finished = true
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
        reached.removeAll()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        let why = text ?? "This phone stopped carrying the relay."
        waitingForReady?.resume(throwing: FleetError.message(why))
        waitingForReady = nil
        if let text, let onClose {
            DispatchQueue.main.async { onClose(text) }
        }
    }

    // MARK: This phone's own look

    /// The certificate at the address as this phone sees it, over its own
    /// network: its SHA-256 in lowercase hex, the way the machine writes a
    /// pin. Nil is cannot tell — nothing answered over TLS, or the phone is
    /// not on a network that reaches it — and the screen says so and goes no
    /// further, rather than accept the machine's word alone.
    ///
    /// The handshake stops once the certificate is read: nothing is ever sent
    /// to the server from here.
    static func ownLook(address: String) async -> String? {
        guard let target = Target(address) else { return nil }
        let queue = DispatchQueue(label: "network.thetech.fleetwright.relay.look")
        let seen = Seen()
        let tls = NWProtocolTLS.Options()
        if let name = target.name { sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, name) }
        sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
            let ref = sec_trust_copy_ref(trust).takeRetainedValue()
            if let chain = SecTrustCopyCertificateChain(ref) as? [SecCertificate], let leaf = chain.first {
                let der = SecCertificateCopyData(leaf) as Data
                seen.pin = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
            }
            complete(false)
        }, queue)
        let connection = NWConnection(host: target.host, port: target.port, using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
        return await withCheckedContinuation { continuation in
            let end: @Sendable () -> Void = {
                guard !seen.done else { return }
                seen.done = true
                connection.cancel()
                continuation.resume(returning: seen.pin)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready, .failed, .waiting, .cancelled: end()
                default: break
                }
            }
            connection.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 10, execute: end)
        }
    }

    /// What the look found, written from its queue only.
    private final class Seen: @unchecked Sendable {
        var pin: String?
        var done = false
    }
}
