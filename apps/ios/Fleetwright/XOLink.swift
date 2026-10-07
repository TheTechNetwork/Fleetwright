import Foundation
import Security

/// Talking to Xen Orchestra from this phone: its JSON-RPC, over a WebSocket at
/// `/api/`, over TLS held to one certificate. docs/manage.md, "Talking".
///
/// THE SAME CONVERSATION src/fleet/host/xo-ws.js HAS from a machine, and the
/// same calls: `session.signIn` with the token, `system.getMethodsInfo`,
/// `xo.getAllObjects` filtered by type. Xen Orchestra pushes `all`
/// notifications on the same socket when an object arrives, changes or goes,
/// which is how the screen stays current without asking again; they reach
/// `onNotice` as they come.
///
/// THE PIN IS CHECKED IN THE TLS CHALLENGE, BEFORE A BYTE IS SENT. A Xen
/// Orchestra built from sources serves a self-signed certificate, so the
/// ordinary check (a chain to a public root) fails on every real pool. What
/// replaces it is stronger: the SHA-256 of the exact certificate the person
/// accepted when the pool was set up, which the machine that ran the setup
/// recorded and sealed back to this phone with the token. The server-trust
/// challenge arrives during the handshake, before the upgrade request is
/// written, so a server answering with any other certificate is cancelled
/// and never hears the token.
///
/// A POOL ON PLAIN HTTP IS NOT CONNECTED TO. There is nothing to pin, and the
/// token would cross the network as it is on every connection; that is
/// PoolWatch's refusal, said on the screen.
///
/// NOTHING HERE LOGS A MESSAGE. The first one sent carries the token.
final class XOLink: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {

    enum Failure: LocalizedError {
        case wrongCertificate
        case refused(String)
        case closed(String)
        case slow(String)

        var errorDescription: String? {
            switch self {
            case .wrongCertificate: return "the certificate was not the pinned one"
            case let .refused(why): return why
            case let .closed(why): return why
            case let .slow(method): return "Xen Orchestra did not answer \(method) in time"
            }
        }
    }

    /// What a call answered, carried across the continuation.
    struct Answer: @unchecked Sendable {
        let value: Any?
    }

    private let url: URL
    private let pin: String
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var nextId = 1
    private var waiting: [Int: CheckedContinuation<Answer, Error>] = [:]
    private var opening: CheckedContinuation<Void, Error>?
    private var sawWrongCertificate = false
    private var ended = false

    /// A notification: its method and params. Called on no particular queue.
    var onNotice: (@Sendable (String, Answer) -> Void)?
    /// The connection ended without being asked to, and why.
    var onEnd: (@Sendable (String) -> Void)?

    /// Nil for an address that does not make a URL.
    init?(address: String, pin: String) {
        guard let url = URL(string: "wss://\(address)/api/") else { return nil }
        self.url = url
        self.pin = pin.lowercased()
        super.init()
    }

    /// Connect, and return once the WebSocket is open. Throws
    /// `wrongCertificate` for a server that answered with any other
    /// certificate, having sent nothing to it.
    func open(timeout: TimeInterval = 15) async throws {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: url)
        // A large pool's VMs in one answer pass the default megabyte; this is
        // the bound xo-ws.js keeps (MAX_MESSAGE_BYTES).
        task.maximumMessageSize = 16 * 1024 * 1024
        lock.withLock {
            self.session = session
            self.task = task
        }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            lock.withLock { opening = c }
            task.resume()
        }
        receive()
    }

    /// One JSON-RPC call, answered with its result, or thrown with Xen
    /// Orchestra's own words for a refusal.
    func call(_ method: String, _ params: [String: Any] = [:], timeout: TimeInterval = 60) async throws -> Any? {
        let task: URLSessionWebSocketTask? = lock.withLock { ended ? nil : self.task }
        guard let task else { throw Failure.closed("the connection to Xen Orchestra is closed") }
        let id: Int = lock.withLock {
            defer { nextId += 1 }
            return nextId
        }
        let body = try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "method": method, "params": params])
        let text = String(decoding: body, as: UTF8.self)
        let answer: Answer = try await withCheckedThrowingContinuation { (c: CheckedContinuation<Answer, Error>) in
            lock.withLock { waiting[id] = c }
            task.send(.string(text)) { [weak self] error in
                if let error { self?.settle(id, error) }
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.settle(id, Failure.slow(method))
            }
        }
        return answer.value
    }

    /// Asked to end: nothing is reported to `onEnd`.
    func close() {
        let (task, session, opener): (URLSessionWebSocketTask?, URLSession?, CheckedContinuation<Void, Error>?) = lock.withLock {
            ended = true
            let opener = opening
            opening = nil
            return (self.task, self.session, opener)
        }
        opener?.resume(throwing: Failure.closed("closed here"))
        task?.cancel(with: .goingAway, reason: nil)
        // A session keeps its delegate until it is invalidated, so this is
        // also what lets this object go.
        session?.invalidateAndCancel()
        failAll(Failure.closed("closed here"))
    }

    // MARK: The pin

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        if XOLink.fingerprint(of: trust) == pin {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            lock.withLock { sawWrongCertificate = true }
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// The SHA-256 of the certificate the server presented, its leaf, as the
    /// host writes a pin.
    static func fingerprint(of trust: SecTrust) -> String? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        return Manage.fingerprint(der: SecCertificateCopyData(leaf) as Data)
    }

    // MARK: The socket

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol chosen: String?) {
        let c: CheckedContinuation<Void, Error>? = lock.withLock {
            defer { opening = nil }
            return opening
        }
        c?.resume()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        end("Xen Orchestra closed the connection")
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        end(error?.localizedDescription ?? "the connection closed")
    }

    private func receive() {
        let task: URLSessionWebSocketTask? = lock.withLock { ended ? nil : self.task }
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .success(message):
                switch message {
                case let .string(text): self.take(Data(text.utf8))
                case let .data(data): self.take(data)
                @unknown default: break
                }
                self.receive()
            case let .failure(error):
                self.end(error.localizedDescription)
            }
        }
    }

    /// An answer to a call, by its id; or, with no id, a notification.
    private func take(_ data: Data) {
        guard let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        if let id = (msg["id"] as? NSNumber)?.intValue {
            let c: CheckedContinuation<Answer, Error>? = lock.withLock { waiting.removeValue(forKey: id) }
            guard let c else { return }
            if let error = msg["error"] as? [String: Any] {
                // Xen Orchestra's own words, bounded, and never the params:
                // the first call carries the token.
                let why = (error["message"] as? String).map { String($0.prefix(300)) } ?? "an error"
                c.resume(throwing: Failure.refused(why))
            } else {
                c.resume(returning: Answer(value: msg["result"]))
            }
        } else if let method = msg["method"] as? String {
            onNotice?(method, Answer(value: msg["params"]))
        }
    }

    private func settle(_ id: Int, _ error: Error) {
        let c: CheckedContinuation<Answer, Error>? = lock.withLock { waiting.removeValue(forKey: id) }
        c?.resume(throwing: error)
    }

    private func failAll(_ error: Error) {
        let all: [CheckedContinuation<Answer, Error>] = lock.withLock {
            defer { waiting.removeAll() }
            return Array(waiting.values)
        }
        for c in all { c.resume(throwing: error) }
    }

    /// The connection ended. An open still waiting hears why, the
    /// certificate first; every call still waiting hears it; and `onEnd`
    /// hears it once, unless the end was asked for.
    private func end(_ reason: String) {
        let (first, opener, wrong, session): (Bool, CheckedContinuation<Void, Error>?, Bool, URLSession?) = lock.withLock {
            let first = !ended
            ended = true
            let opener = opening
            opening = nil
            return (first, opener, sawWrongCertificate, self.session)
        }
        opener?.resume(throwing: wrong ? Failure.wrongCertificate : Failure.closed(reason))
        failAll(Failure.closed(reason))
        session?.invalidateAndCancel()
        if first { onEnd?(reason) }
    }
}
