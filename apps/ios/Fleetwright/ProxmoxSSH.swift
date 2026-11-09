import CryptoKit
import Foundation
import NIOCore
import NIOPosix
import NIOSSH

/// THE PROXMOX SETUP RUN FROM THIS PHONE, over SSH to the node as root.
/// docs/proxmox.md, "From the phone". The same steps as Android's ProxmoxSsh,
/// and the same commands, which test/pve-pools.test.js holds equal.
///
/// ON APPLE'S OWN swift-nio-ssh, and not a client built on it: the usual one
/// (Citadel) takes its SSH layer from a personal fork, and the thing this
/// sends is a node's root password.
///
/// THE ROOT PASSWORD GOES FROM THIS PHONE TO THE NODE AND NOWHERE ELSE, and
/// lives in the screen's memory while it is open. THE NODE IS WHO IT SAYS
/// ONLY ONCE ITS KEY IS: the first look reads the host key and sends nothing;
/// the person checks its fingerprint on the node's console, and only then is
/// the password sent, to a node holding that key and no other. THE JOB
/// OUTLIVES THE CONNECTION: it runs under `systemd-run`, and the phone asks how
/// far it has got; the line it ends with goes to a file only root reads.
enum ProxmoxSSH {
    static let unit = "fleetwright-pve-setup"
    static let lineFile = "/root/.fleetwright-pve-line"

    /// The node's clock at the start, so the journal is read from this run alone.
    static let now = "date +%s"

    /// Start the setup as a unit of its own, with the command the phone shows
    /// for running it by hand, and the line to a file. A run already going is
    /// stopped first: the person asked again.
    static func startCommand(coordinator: String, vmids: String = "", options: ProxmoxOptions = ProxmoxOptions(), holderJoin: Bool = false) -> String {
        // ITS OWN MACHINE only with the file its pin was written to, and made
        // again only then: the script refuses one without the other.
        let holder = holderJoin ? " " + holderJoinFlag + " " + holderJoinFile + (options.holderAgain == true ? " " + holderAgainFlag : "") : ""
        let run = ProxmoxLine.setupCommand(coordinator: coordinator, vmids: vmids, options: options) + holder + " --line-file \(lineFile)"
        return "systemctl stop \(unit) 2>/dev/null; systemctl reset-failed \(unit) 2>/dev/null; rm -f \(lineFile); "
            + "systemd-run --unit=\(unit) --collect /bin/bash -c '\(run)'"
    }

    /// How far it has got: its step and error lines since `since`, the last
    /// `fleetwright-part:` line of the step it is on, whether it runs, and
    /// whether the line is there.
    static func pollCommand(since: Int) -> String {
        "journalctl -u \(unit) --since @\(since) -o cat --no-pager | "
            + "awk '/^fleetwright-(step|error):/ {print} /^fleetwright-step:/ {p=0} /^fleetwright-part:/ {p=$0} END {if (p) print p}'; "
            + "echo \"state=$(systemctl is-active \(unit))\"; test -f \(lineFile) && echo line=ready"
    }

    /// The line, read once and removed.
    static let takeLine = "cat \(lineFile) && rm -f \(lineFile)"

    // A MACHINE OF ITS OWN (docs/proxmox.md): pve-setup.js's commands, which
    // test/pvesetup-in-apps.test.js holds equal.

    /// Where the pin and name it joins with are written; the script removes it.
    static let holderJoinFile = "/root/.fleetwright-holder-join"
    /// The script's flags for it, by themselves.
    static let holderJoinFlag = "--holder-join"
    static let holderAgainFlag = "--holder-again"
    /// The cluster's guests, to see whether it has one already.
    static let holderFind = "pvesh get /cluster/resources --type vm --output-format json"
    /// The node's first address, which the line will carry with port 8006.
    static let addressFind = "hostname -I | awk '{print $1}'"

    /// Its own machines in holderFind's answer: outside the pool, not
    /// templates, tagged `fleetwright-holder`.
    static func holders(in out: String) -> [String] {
        guard let all = try? JSONSerialization.jsonObject(with: Data(out.utf8)) as? [[String: Any]] else { return [] }
        return all.filter { v in
            v["type"] as? String == "qemu" && (v["pool"] as? String ?? "") != "fleetwright"
                && (v["template"] as? Int ?? 0) != 1
                && (v["tags"] as? String ?? "").split(whereSeparator: { ";, ".contains($0) }).contains("fleetwright-holder")
        }.compactMap { $0["name"] as? String }
    }

    /// The address the line will carry, from addressFind's answer, or nil.
    static func lineAddress(of out: String) -> String? {
        let ip = out.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ").first.map(String.init) ?? ""
        guard (2...45).contains(ip.count), ip.allSatisfy({ $0.isHexDigit || $0 == "." || $0 == ":" }) else { return nil }
        return "\(ip):8006"
    }

    /// The file written root-only in one command: the JSON in base64, so
    /// nothing in it reaches the shell as words.
    static func holderJoinCommand(hostId: String, pin: String, address: String, secret: String?) -> String {
        var join: [String: Any] = ["hostId": hostId, "pin": pin, "address": address]
        if let secret { join["secret"] = secret }
        let data = (try? JSONSerialization.data(withJSONObject: join, options: [.sortedKeys])) ?? Data()
        return "umask 077; printf %s \(data.base64EncodedString()) | base64 -d >\(holderJoinFile)"
    }

    struct Progress: Equatable {
        let steps: [String]
        let error: String?
        let running: Bool
        let lineReady: Bool
        /// How far into the step it is on, as the script said it: nil when it
        /// said nothing of this step.
        var part: Part? = nil
    }

    /// `fill` in thousandths, or nil when the script measured nothing, and
    /// what it is doing. pve-setup.js, partOf, reads it the same way.
    struct Part: Equatable {
        let fill: Int?
        let text: String
    }

    static func progress(of out: String) -> Progress {
        let lines = out.components(separatedBy: "\n")
        let afterStep = lines.lastIndex { $0.hasPrefix("fleetwright-step: ") }.map { lines.index(after: $0) } ?? lines.startIndex
        return Progress(
            steps: lines.filter { $0.hasPrefix("fleetwright-step: ") }.map { String($0.dropFirst("fleetwright-step: ".count)).trimmingCharacters(in: .whitespaces) },
            error: lines.last { $0.hasPrefix("fleetwright-error: ") }.map { String($0.dropFirst("fleetwright-error: ".count)).trimmingCharacters(in: .whitespaces) },
            running: lines.contains("state=active") || lines.contains("state=activating"),
            lineReady: lines.contains("line=ready"),
            part: lines[afterStep...].last { $0.hasPrefix("fleetwright-part: ") }.flatMap(part(of:))
        )
    }

    /// One `fleetwright-part:` line, or nil for one not shaped as the script writes it.
    static func part(of line: String) -> Part? {
        let rest = line.trimmingCharacters(in: .whitespaces).dropFirst("fleetwright-part: ".count)
        guard let space = rest.firstIndex(of: " ") else { return nil }
        let head = String(rest[..<space])
        let text = rest[rest.index(after: space)...].trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return nil }
        if head == "-" { return Part(fill: nil, text: String(text.prefix(160))) }
        guard head.count <= 4, head.allSatisfy(\.isASCII), let n = Int(head), n >= 0 else { return nil }
        return Part(fill: min(1000, n), text: String(text.prefix(160)))
    }

    /// A step as the person reads it.
    static func stepWords(_ step: String) -> String {
        switch step {
        case "pool": return "The pool"
        case "user": return "The user and its roles"
        case "token": return "Its token"
        case "fence": return "The firewall group"
        case "networks": return "Lab and group networks"
        case "image": return "The machine image, which takes a few minutes"
        case "holder": return "Its own machine"
        case "line": return "Saving the token"
        case "done": return "Done"
        default: return step
        }
    }

    /// A key's fingerprint as `ssh-keygen -lf` prints it: SHA256 and unpadded base64.
    static func fingerprint(_ key: NIOSSHPublicKey) -> String {
        let parts = String(openSSHPublicKey: key).split(separator: " ")
        guard parts.count >= 2, let blob = Data(base64Encoded: String(parts[1])) else { return String(openSSHPublicKey: key) }
        let digest = Data(SHA256.hash(data: blob))
        return "SHA256:" + digest.base64EncodedString().replacingOccurrences(of: "=", with: "")
    }

    /// Address and port, as typed: `host`, `host:port`, or `[v6]:port`.
    static func hostAndPort(_ address: String) -> (String, Int) {
        let a = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if a.hasPrefix("["), let close = a.firstIndex(of: "]") {
            let host = String(a[a.index(after: a.startIndex)..<close])
            let rest = a[a.index(after: close)...]
            return (host, rest.hasPrefix(":") ? Int(rest.dropFirst()) ?? 22 : 22)
        }
        let parts = a.split(separator: ":")
        if parts.count == 2 { return (String(parts[0]), Int(parts[1]) ?? 22) }
        return (a, 22)
    }

    enum Failure: LocalizedError {
        case otherKey(String)
        case noAnswer(String)
        case refused

        var errorDescription: String? {
            switch self {
            case .otherKey(let f): return "The node answered with another key (\(f)) than the one you checked. Nothing was sent."
            case .noAnswer(let host): return "\(host) did not answer as an SSH server."
            case .refused: return "The node refused that password for root. Root may also have password sign-in turned off in its sshd."
            }
        }
    }

    /// The node's host key, without signing in: the first look.
    static func hostKey(_ address: String) async throws -> String {
        let check = HostKeyCheck(expected: nil)
        _ = try? await exec(address, check: check, password: "", command: "true")
        guard let seen = check.seen else { throw Failure.noAnswer(hostAndPort(address).0) }
        return seen
    }

    /// Run one command as root on the node, with the key it must hold.
    static func run(_ address: String, fingerprint: String, password: String, command: String) async throws -> (Int, String) {
        let check = HostKeyCheck(expected: fingerprint)
        do {
            return try await exec(address, check: check, password: password, command: command)
        } catch {
            if let seen = check.seen, seen != fingerprint { throw Failure.otherKey(seen) }
            if check.seen == fingerprint, PasswordAuth.wasRefused(error) { throw Failure.refused }
            throw error
        }
    }

    private static func exec(_ address: String, check: HostKeyCheck, password: String, command: String) async throws -> (Int, String) {
        let (host, port) = hostAndPort(address)
        let auth = PasswordAuth(password: password)
        let bootstrap = ClientBootstrap(group: MultiThreadedEventLoopGroup.singleton)
            .connectTimeout(.seconds(10))
            .channelInitializer { channel in
                channel.eventLoop.makeCompletedFuture {
                    try channel.pipeline.syncOperations.addHandlers([
                        NIOSSHHandler(
                            role: .client(.init(userAuthDelegate: auth, serverAuthDelegate: check)),
                            allocator: channel.allocator,
                            inboundChildChannelInitializer: nil
                        ),
                        CloseOnError(),
                    ])
                }
            }
        let channel = try await bootstrap.connect(host: host, port: port).get()
        defer { channel.close(promise: nil) }
        let done = channel.eventLoop.makePromise(of: (Int, String).self)
        let exec = ExecHandler(command: command, done: done)
        // ON THE CHANNEL'S OWN EVENT LOOP: the SSH handler is not to be
        // handed out of it, so the session is opened there.
        let child = channel.eventLoop.makePromise(of: Channel.self)
        channel.eventLoop.execute {
            do {
                let ssh = try channel.pipeline.syncOperations.handler(type: NIOSSHHandler.self)
                ssh.createChannel(child, channelType: .session) { childChannel, type in
                    guard case .session = type else {
                        return childChannel.eventLoop.makeFailedFuture(Failure.noAnswer(host))
                    }
                    return childChannel.eventLoop.makeCompletedFuture {
                        try childChannel.pipeline.syncOperations.addHandler(exec)
                    }
                }
            } catch {
                child.fail(error)
            }
        }
        _ = try await child.futureResult.get()
        // A COMMAND THAT NEVER ENDS is not waited on for ever; the handler
        // completes the answer once, whichever comes first.
        let timeout = channel.eventLoop.scheduleTask(in: .seconds(90)) { exec.finish(.failure(Failure.noAnswer(host))) }
        done.futureResult.whenComplete { _ in timeout.cancel() }
        return try await done.futureResult.get()
    }
}

/// The password, offered once, as root.
private final class PasswordAuth: NIOSSHClientUserAuthenticationDelegate, @unchecked Sendable {
    let password: String
    private var offered = false
    init(password: String) { self.password = password }

    func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods, nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
        guard !offered, !password.isEmpty, availableMethods.contains(.password) else {
            nextChallengePromise.succeed(nil)
            return
        }
        offered = true
        nextChallengePromise.succeed(NIOSSHUserAuthenticationOffer(username: "root", serviceName: "", offer: .password(.init(password: password))))
    }

    /// Whether an error is the server having said no to every offer.
    static func wasRefused(_ error: Error) -> Bool {
        String(describing: error).localizedCaseInsensitiveContains("auth")
    }
}

/// The node held to the key the person checked; with none, the key is only read.
private final class HostKeyCheck: NIOSSHClientServerAuthenticationDelegate, @unchecked Sendable {
    let expected: String?
    var seen: String?
    init(expected: String?) { self.expected = expected }

    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        let f = ProxmoxSSH.fingerprint(hostKey)
        seen = f
        if let expected, expected == f {
            validationCompletePromise.succeed(())
        } else {
            validationCompletePromise.fail(ProxmoxSSH.Failure.otherKey(f))
        }
    }
}

private final class CloseOnError: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = Any
    func errorCaught(context: ChannelHandlerContext, error: Error) {
        context.close(promise: nil)
    }
}

/// One command on a session channel: its output and its exit status.
private final class ExecHandler: ChannelDuplexHandler, @unchecked Sendable {
    typealias InboundIn = SSHChannelData
    typealias InboundOut = ByteBuffer
    typealias OutboundIn = SSHChannelData
    typealias OutboundOut = SSHChannelData

    let command: String
    let done: EventLoopPromise<(Int, String)>
    private var out = ""
    private var status = -1
    /// The answer is given once: by the exit, an error, or the timeout.
    private var finished = false

    /// Complete the answer, once, on the channel's event loop.
    func finish(_ result: Result<(Int, String), Error>) {
        done.futureResult.eventLoop.execute {
            guard !self.finished else { return }
            self.finished = true
            self.done.completeWith(result)
        }
    }

    init(command: String, done: EventLoopPromise<(Int, String)>) {
        self.command = command
        self.done = done
    }

    func handlerAdded(context: ChannelHandlerContext) {
        context.channel.setOption(ChannelOptions.allowRemoteHalfClosure, value: true).whenFailure { error in
            context.fireErrorCaught(error)
        }
    }

    func channelActive(context: ChannelHandlerContext) {
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: command, wantReply: true), promise: nil)
        context.fireChannelActive()
    }

    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if let exit = event as? SSHChannelRequestEvent.ExitStatus {
            status = exit.exitStatus
        } else {
            context.fireUserInboundEventTriggered(event)
        }
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let message = unwrapInboundIn(data)
        guard case .byteBuffer(let buffer) = message.data, case .channel = message.type else { return }
        out += String(buffer: buffer)
    }

    func channelInactive(context: ChannelHandlerContext) {
        finish(.success((status, out)))
        context.fireChannelInactive()
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        finish(.failure(error))
        context.close(promise: nil)
    }
}
