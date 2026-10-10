import Foundation
import Observation

/// One pool, watched from this phone while its page is open.
/// docs/manage.md, "The first slice".
///
/// WHERE THE TOKEN COMES FROM. A pool added through Add a hypervisor already
/// has its token here: setup sealed it back to this phone, and
/// XOSetupHandoff keeps the record in the Keychain under the address, with the
/// certificate the person accepted as its pin. So connecting is reading that
/// record. Nothing else is read for it: never XOSaved, which keeps the admin
/// sign-in for setup when a person asks it to, because a password used to make
/// a token is not a thing this screen holds.
///
/// WHAT THAT TOKEN REACHES is what the `fleetwright` user setup made may see:
/// Xen Orchestra gives every token its user's rights, and that user's are its
/// resource set's. The screen says so in a sentence rather than presenting a
/// short list as the whole pool (C-5).
///
/// WHILE THE PAGE IS OPEN, AND NOT OTHERWISE. The socket is opened when the
/// pool's page appears, kept current from the `all` notifications, and closed
/// when the page goes or the app leaves the foreground. Nothing watches while
/// the app is closed, so what is kept is when it was last looked at, and the
/// screen says that time rather than implying the picture is current.
@MainActor
@Observable
final class PoolWatch {
    enum Phase: Equatable {
        case idle
        case connecting
        case live
        /// Not connected, a sentence saying why, and whether looking again
        /// could change the answer: a lost connection can, a pool set up over
        /// plain HTTP cannot, and a button that can only fail is not drawn.
        case stopped(String, retry: Bool)
    }

    let address: String
    private(set) var phase: Phase = .idle
    private(set) var snapshot = Manage.Snapshot()
    /// The methods this Xen Orchestra lists. Nil is cannot tell, which offers
    /// nothing (C-2).
    private(set) var methods: Set<String>?
    private(set) var lookedAt: Date?
    /// The user the token is for, as the record names it.
    private(set) var user: String?
    /// Bumped on every change, for the one animation that carries it.
    private(set) var revision = 0

    /// Whether this attempt's socket opened. Until it has, a failure is a pool
    /// this phone could not reach, not a connection that ended.
    @ObservationIgnored private var reached = false

    /// Outside the main actor, so letting go of this object closes the socket.
    private let holder = LinkHolder()
    /// While the first read is in flight, notifications wait here rather than
    /// changing a picture that is about to be replaced.
    @ObservationIgnored private var loading = false
    @ObservationIgnored private var held: [(String, XOLink.Answer)] = []

    init(address: String) {
        self.address = address
        lookedAt = Manage.lastLooked(address)
    }

    deinit {
        holder.take()?.close()
    }

    // MARK: Connecting

    /// Connect, sign in with the token, read the method list and the pool.
    /// A second call while connecting or connected does nothing.
    func start() async {
        if phase == .connecting || phase == .live { return }
        guard let raw = Keychain.get(XOSetupHandoff.tokenAccount(address)), let record = Manage.record(raw, address: address) else {
            phase = .stopped(Manage.Words.noToken(address), retry: false)
            return
        }
        user = record.user
        guard !record.plain, let pin = record.pin else {
            phase = .stopped(Manage.Words.plainPool(address), retry: false)
            return
        }
        if let expires = record.expires, expires < Date() {
            phase = .stopped(Manage.Words.expired(address, on: expires.formatted(date: .long, time: .omitted)), retry: false)
            return
        }
        guard let link = XOLink(address: address, pin: pin) else {
            phase = .stopped(Manage.Words.noToken(address), retry: false)
            return
        }
        phase = .connecting
        reached = false
        // THE MAIN QUEUE, NOT A TASK PER MESSAGE. The socket hands messages
        // over in order, and Xen Orchestra's notifications only make sense in
        // order: an object that arrived and then went must not go and then
        // arrive. The main queue keeps that order; separate Tasks need not.
        link.onNotice = { [weak self, weak link] method, params in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self, let link else { return }
                    self.notice(method, params, from: link)
                }
            }
        }
        // Weak both ways: the link holds this closure, so a strong capture of
        // the link would keep it alive for ever.
        link.onEnd = { [weak self, weak link] reason in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if let link { self?.lost(link, reason) }
                }
            }
        }
        holder.put(link)
        // STOPPED WHILE IT WAITED: the page went, or the app left the
        // foreground, between one answer and the next. Whatever came of the
        // wait is not news then, and stop() has already said what is.
        func stale() -> Bool { holder.peek() !== link }

        do {
            try await link.open()
        } catch XOLink.Failure.wrongCertificate {
            if stale() { return }
            drop(link)
            phase = .stopped(Manage.Words.wrongCertificate(address), retry: false)
            return
        } catch {
            if stale() { return }
            drop(link)
            phase = .stopped(Manage.Words.unreachable(address, error.localizedDescription), retry: true)
            return
        }
        reached = true
        do {
            _ = try await link.call("session.signIn", ["token": record.token])
        } catch {
            if stale() { return }
            drop(link)
            phase = .stopped(Manage.Words.signInRefused(address, error.localizedDescription), retry: false)
            return
        }
        // A LIST THAT COULD NOT BE READ IS NOT AN EMPTY ONE: nil draws no
        // action and says why, rather than drawing none and saying nothing.
        let listed = try? await link.call("system.getMethodsInfo")
        if stale() { return }
        let methods = (listed as? [String: Any]).map { Set($0.keys) }
        if let methods, !methods.contains("xo.getAllObjects") {
            drop(link)
            phase = .stopped(Manage.Words.noObjects, retry: false)
            return
        }
        loading = true
        var next = Manage.Snapshot()
        do {
            for type in Manage.objectTypes {
                let got = try await link.call("xo.getAllObjects", ["filter": ["type": type]])
                next.take(got)
            }
        } catch {
            if stale() { return }
            loading = false
            held = []
            drop(link)
            phase = .stopped(Manage.Words.lost(error.localizedDescription), retry: true)
            return
        }
        if stale() { return }
        for (method, params) in held { next.apply(method: method, params: params.value) }
        held = []
        loading = false
        self.methods = methods
        snapshot = next
        phase = .live
        revision += 1
        touch()
    }

    /// Close the socket, keeping what was seen and when.
    func stop() {
        guard let link = holder.take() else { return }
        link.close()
        if phase == .live { touch() }
        loading = false
        held = []
        phase = .idle
    }

    /// Pull to refresh: read everything again, from a new connection.
    func again() async {
        stop()
        await start()
    }

    // MARK: Acting

    /// Call one method on the open connection, and say what came of it.
    /// Xen Orchestra answers once it is done, so a yes is done, and the
    /// change itself arrives as a notification.
    func run(_ method: String, _ params: [String: Any], done: String) async -> (ok: Bool, text: String) {
        guard let link = holder.peek(), phase == .live else {
            return (false, Manage.Words.lost("this phone is not connected"))
        }
        do {
            _ = try await link.call(method, params, timeout: 300)
            touch()
            return (true, done)
        } catch let failure as XOLink.Failure {
            switch failure {
            case let .refused(why): return (false, Manage.Words.refused(why))
            case .slow: return (false, Manage.Words.slow)
            case .wrongCertificate, .closed: return (false, Manage.Words.lost(failure.localizedDescription))
            }
        } catch {
            return (false, Manage.Words.lost(error.localizedDescription))
        }
    }

    // MARK: Words

    /// When it was last looked at, or that it never has been.
    var lookedLine: String {
        guard let lookedAt else { return Manage.Words.never }
        let time = lookedAt.formatted(date: .omitted, time: .shortened)
        return Manage.Words.lookedAt("\(time), \(relativeTime(lookedAt.timeIntervalSince1970 * 1000))")
    }

    /// How current what is shown is: watching, or when it was last looked at.
    var currentLine: String { phase == .live ? Manage.Words.watching : lookedLine }

    // MARK: Inside

    /// A notification, from the link it came on: a late one from a link this
    /// watch has let go of is not about the picture on the screen.
    private func notice(_ method: String, _ params: XOLink.Answer, from link: XOLink) {
        guard holder.peek() === link else { return }
        if loading {
            held.append((method, params))
            return
        }
        guard phase == .live else { return }
        if snapshot.apply(method: method, params: params.value) {
            revision += 1
            touch()
        }
    }

    /// The socket ended without being asked to: a phone that slept, a
    /// network that changed, a server that went.
    private func lost(_ link: XOLink, _ reason: String) {
        guard holder.peek() === link else { return }
        _ = holder.take()
        loading = false
        held = []
        if phase == .live || phase == .connecting {
            phase = .stopped(reached ? Manage.Words.lost(reason) : Manage.Words.unreachable(address, reason), retry: true)
        }
    }

    private func drop(_ link: XOLink) {
        if holder.peek() === link { _ = holder.take() }
        link.close()
    }

    private func touch() {
        let now = Date()
        lookedAt = now
        Manage.rememberLooked(address, at: now)
    }
}

/// The open link, behind a lock rather than the main actor, so the watch's
/// deinit (which runs on no actor) can close it.
private final class LinkHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var link: XOLink?

    func put(_ next: XOLink) {
        let old: XOLink? = lock.withLock {
            let old = link
            link = next
            return old
        }
        old?.close()
    }

    func peek() -> XOLink? { lock.withLock { link } }

    func take() -> XOLink? {
        lock.withLock {
            let old = link
            link = nil
            return old
        }
    }
}
