import Foundation

/// One VM's screen from Xen Orchestra: VNC over a WebSocket at
/// `/api/consoles/<vm id>`, over TLS held to the pool's pinned certificate.
/// docs/manage.md, "The console".
///
/// THE SAME PIN AS THE POOL PAGE (XOLink), checked in the TLS challenge before
/// a byte is sent, and the same token, sent the one way Xen Orchestra reads it
/// for a console: as the `token` cookie on the upgrade request
/// (setUpConsoleProxy in xo-server's index.mjs). Xen Orchestra then checks
/// that the token's user may operate that machine, and closes the socket if
/// not.
///
/// BYTES IN, BYTES OUT. Nothing here speaks VNC; noVNC does, in the page
/// (src/vnc/page.js), and this carries its frames. Nothing is logged.
final class XOConsole: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {

    private let request: URLRequest
    private let pin: String
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var sawWrongCertificate = false
    private var ended = false

    /// The socket is open. Called on no particular queue.
    var onOpen: (@Sendable () -> Void)?
    /// A frame from Xen Orchestra.
    var onData: (@Sendable (Data) -> Void)?
    /// It ended without being asked to: true when the certificate was not the pinned one.
    var onEnd: (@Sendable (_ why: String, _ wrongCertificate: Bool) -> Void)?

    /// Nil for an address or an id that does not make a URL.
    init?(address: String, vm: String, token: String, pin: String) {
        guard let id = vm.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
              let url = URL(string: "wss://\(address)/api/consoles/\(id)") else { return nil }
        var request = URLRequest(url: url)
        request.setValue("token=\(token)", forHTTPHeaderField: "Cookie")
        request.httpShouldHandleCookies = false
        self.request = request
        self.pin = pin.lowercased()
        super.init()
    }

    func open() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
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

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol chosen: String?) {
        onOpen?()
        receive()
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        end("Xen Orchestra closed the console")
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
        let (report, wrong): (Bool, Bool) = lock.withLock {
            defer { ended = true }
            return (!ended, sawWrongCertificate)
        }
        guard report else { return }
        session?.invalidateAndCancel()
        onEnd?(why, wrong)
    }
}
