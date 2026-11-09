import CryptoKit
import Foundation
import Network
import NIOCore
import NIOPosix
import NIOSSH

/// One SSH shell to a machine of yours, as `fleetwright`, with this phone's
/// key (PhoneSSHKey): a pty and a shell, bytes in and out, and the window's
/// size. docs/hypervisors.md, "SSH in the app".
///
/// FROM AWAY, through one of your machines (ConsoleTunnel, naming the
/// machine): the connection goes to the loopback proxy the tunnel listens on,
/// asks it to CONNECT, and speaks SSH through it, so the machine carrying it
/// and the fleet carry SSH's ciphertext. Nothing here is logged.
final class SSHTerminal: @unchecked Sendable {
    let machine: String
    private let host: String
    private let proxy: NWEndpoint?
    private let lock = NSLock()
    private var channel: Channel?
    private var shell: Channel?
    private var ended = false

    var onOpen: (@Sendable () -> Void)?
    var onData: (@Sendable (Data) -> Void)?
    /// It ended, and why; `refusedKey` when the machine would not take this phone's key.
    var onEnd: (@Sendable (_ why: String, _ refusedKey: Bool) -> Void)?

    enum Failure: LocalizedError {
        case otherHostKey(String)
        case noShell
        var errorDescription: String? {
            switch self {
            case .otherHostKey(let f): return "the machine answered with another host key (\(f)) than the one it showed first, so nothing was sent"
            case .noShell: return "the machine would not open a shell"
            }
        }
    }

    init(machine: String, host: String, proxy: NWEndpoint? = nil) {
        self.machine = machine
        self.host = host
        self.proxy = proxy
    }

    func open(cols: Int, rows: Int) {
        Task {
            do {
                try await connect(cols: cols, rows: rows)
            } catch {
                end(error.localizedDescription, refusedKey: String(describing: error).localizedCaseInsensitiveContains("auth"))
            }
        }
    }

    private func connect(cols: Int, rows: Int) async throws {
        let auth = KeyAuth(key: PhoneSSHKey.key())
        let check = TrustFirst(machine: machine)
        let through: (String, Int)? = proxy.flatMap { endpoint in
            if case let .hostPort(h, p) = endpoint { return ("\(h)", Int(p.rawValue)) }
            return nil
        }
        let target = host
        let bootstrap = ClientBootstrap(group: MultiThreadedEventLoopGroup.singleton)
            .connectTimeout(.seconds(15))
            .channelInitializer { channel in
                channel.eventLoop.makeCompletedFuture {
                    let ssh = NIOSSHHandler(
                        role: .client(.init(userAuthDelegate: auth, serverAuthDelegate: check)),
                        allocator: channel.allocator,
                        inboundChildChannelInitializer: nil
                    )
                    if through != nil {
                        // CONNECT first; the SSH handler joins once the tunnel says yes.
                        try channel.pipeline.syncOperations.addHandler(ConnectThrough(target: "\(target):22", then: ssh))
                    } else {
                        try channel.pipeline.syncOperations.addHandler(ssh)
                    }
                }
            }
        let channel = try await (through.map { bootstrap.connect(host: $0.0, port: $0.1) } ?? bootstrap.connect(host: target, port: 22)).get()
        lock.withLock { self.channel = channel }
        channel.closeFuture.whenComplete { [weak self] _ in self?.end("the connection closed", refusedKey: false) }
        let child = channel.eventLoop.makePromise(of: Channel.self)
        let reader = ShellHandler(cols: cols, rows: rows, onData: { [weak self] data in self?.onData?(data) }, onReady: { [weak self] in self?.onOpen?() })
        // SSH waits for the CONNECT reply where there is one; the session is
        // asked for once the SSH handler is in the pipeline.
        func ask() {
            channel.eventLoop.execute {
                do {
                    let ssh = try channel.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
                    ssh.createChannel(child, channelType: .session) { childChannel, type in
                        guard case .session = type else { return childChannel.eventLoop.makeFailedFuture(Failure.noShell) }
                        return childChannel.eventLoop.makeCompletedFuture {
                            try childChannel.pipeline.syncOperations.addHandler(reader)
                        }
                    }
                } catch {
                    channel.eventLoop.scheduleTask(in: .milliseconds(100)) { ask() }
                }
            }
        }
        ask()
        let shell = try await child.futureResult.get()
        lock.withLock { self.shell = shell }
    }

    func send(_ data: Data) {
        let shell: Channel? = lock.withLock { ended ? nil : self.shell }
        guard let shell else { return }
        var buffer = shell.allocator.buffer(capacity: data.count)
        buffer.writeBytes(data)
        shell.writeAndFlush(SSHChannelData(type: .channel, data: .byteBuffer(buffer)), promise: nil)
    }

    func resize(cols: Int, rows: Int) {
        let shell: Channel? = lock.withLock { ended ? nil : self.shell }
        shell?.triggerUserOutboundEvent(SSHChannelRequestEvent.WindowChangeRequest(terminalCharacterWidth: cols, terminalRowHeight: rows, terminalPixelWidth: 0, terminalPixelHeight: 0), promise: nil)
    }

    /// Asked to end: nothing is reported to `onEnd`.
    func close() {
        let channel: Channel? = lock.withLock {
            ended = true
            return self.channel
        }
        channel?.close(promise: nil)
    }

    private func end(_ why: String, refusedKey: Bool) {
        let (already, channel): (Bool, Channel?) = lock.withLock {
            defer { ended = true }
            return (ended, self.channel)
        }
        guard !already else { return }
        channel?.close(promise: nil)
        onEnd?(why, refusedKey)
    }
}

/// This phone's key, offered once, as `fleetwright`.
private final class KeyAuth: NIOSSHClientUserAuthenticationDelegate, @unchecked Sendable {
    let key: NIOSSHPrivateKey
    private var offered = false
    init(key: Curve25519.Signing.PrivateKey) { self.key = NIOSSHPrivateKey(ed25519Key: key) }

    func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods, nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
        guard !offered, availableMethods.contains(.publicKey) else {
            nextChallengePromise.succeed(nil)
            return
        }
        offered = true
        nextChallengePromise.succeed(NIOSSHUserAuthenticationOffer(username: "fleetwright", serviceName: "", offer: .privateKey(.init(privateKey: key))))
    }
}

/// The machine held to the host key it showed first (PhoneSSHKey).
private final class TrustFirst: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
    let machine: String
    init(machine: String) { self.machine = machine }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let seen = ProxmoxSSH.fingerprint(hostKey)
        if let first = PhoneSSHKey.hostKey(of: machine), first != seen {
            validationCompletePromise.fail(SSHTerminal.Failure.otherHostKey(seen))
            return
        }
        PhoneSSHKey.hold(seen, for: machine)
        validationCompletePromise.succeed(())
    }
}

/// HTTP CONNECT through the tunnel's loopback proxy, then out of the way:
/// the SSH handler takes its place once the proxy says 200.
private final class ConnectThrough: ChannelDuplexHandler, RemovableChannelHandler, @unchecked Sendable {
    typealias InboundIn = ByteBuffer
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = ByteBuffer
    typealias OutboundOut = ByteBuffer

    let target: String
    let then: NIOSSHHandler
    private var head = ByteBuffer()

    init(target: String, then: NIOSSHHandler) {
        self.target = target
        self.then = then
    }

    func channelActive(context: ChannelHandlerContext) {
        var out = context.channel.allocator.buffer(capacity: 128)
        out.writeString("CONNECT \(target) HTTP/1.1\r\nHost: \(target)\r\n\r\n")
        context.writeAndFlush(wrapOutboundOut(out), promise: nil)
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        var chunk = unwrapInboundIn(data)
        head.writeBuffer(&chunk)
        let text = String(buffer: head)
        guard let end = text.range(of: "\r\n\r\n") else {
            if head.readableBytes > 8192 { context.close(promise: nil) }
            return
        }
        guard text.hasPrefix("HTTP/1.1 200") || text.hasPrefix("HTTP/1.0 200") else {
            context.close(promise: nil)
            return
        }
        let rest = text.utf8.count - text[end.upperBound...].utf8.count
        head.moveReaderIndex(forwardBy: rest)
        let leftover = head
        let pipeline = context.pipeline
        let ssh = then
        // ADDED TO A CHANNEL ALREADY ACTIVE, the SSH handler starts its
        // handshake at once (as NIO's handlers do in handlerAdded), and what
        // came after the proxy's reply is the server's first bytes.
        _ = pipeline.addHandler(ssh, position: .after(self)).flatMap { pipeline.removeHandler(self) }.map {
            if leftover.readableBytes > 0 { pipeline.fireChannelRead(NIOAny(leftover)) }
        }
    }
}

/// The shell: a pty of the page's size, then bytes both ways.
private final class ShellHandler: ChannelDuplexHandler, @unchecked Sendable {
    typealias InboundIn = SSHChannelData
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = SSHChannelData
    typealias OutboundOut = SSHChannelData

    let cols: Int
    let rows: Int
    let onData: @Sendable (Data) -> Void
    let onReady: @Sendable () -> Void

    init(cols: Int, rows: Int, onData: @escaping @Sendable (Data) -> Void, onReady: @escaping @Sendable () -> Void) {
        self.cols = cols
        self.rows = rows
        self.onData = onData
        self.onReady = onReady
    }

    func handlerAdded(context: ChannelHandlerContext) {
        context.channel.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).whenFailure { error in
            context.fireErrorCaught(error)
        }
    }

    func channelActive(context: ChannelHandlerContext) {
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.PseudoTerminalRequest(
            wantReply: true, term: "xterm-256color",
            terminalCharacterWidth: max(cols, 20), terminalRowHeight: max(rows, 5),
            terminalPixelWidth: 0, terminalPixelHeight: 0, terminalModes: .init([:])
        ), promise: nil)
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.ShellRequest(wantReply: true), promise: nil)
        onReady()
        context.fireChannelActive()
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let message = unwrapInboundIn(data)
        guard case .byteBuffer(let buffer) = message.data else { return }
        onData(Data(buffer.readableBytesView))
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        context.close(promise: nil)
    }
}
