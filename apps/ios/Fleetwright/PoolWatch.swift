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
///
/// FROM AWAY, THROUGH A MACHINE. On 5G the phone reaches no pool, and the
/// page used to stop there. When the socket cannot open, the page is read
/// instead by one of the person's machines that holds the pool's token
/// (`xolook`, docs/manage.md "From away"), sealed to a key made here for the
/// one look, and read again every 20 seconds while the page is open, since
/// nothing pushes changes that way. Its actions go the same way (`xoact`).
/// The screen says which machine and when, never "Watching now" (C-5).
@MainActor
@Observable
final class PoolWatch {
    enum Phase: Equatable {
        case idle
        case connecting
        /// The phone could not reach the pool and is asking a machine to.
        case relaying
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
    /// The machine the page is read through, while this phone cannot reach
    /// the pool itself. Nil is read directly, over the socket.
    private(set) var via: String?

    /// How a page read through a machine is asked for again, and how often.
    static let throughEvery: Duration = .seconds(20)
    private let fleet: Fleet?
    /// Holds this watch weakly, so letting go of the page ends it on its next turn.
    @ObservationIgnored private var polling: Task<Void, Never>?
    /// Bumped whenever the page is let go of, so an answer from the fleet
    /// that arrives after it is not drawn on a page that has moved on.
    @ObservationIgnored private var generation = 0

    /// Whether this attempt's socket opened. Until it has, a failure is a pool
    /// this phone could not reach, not a connection that ended.
    @ObservationIgnored private var reached = false

    /// Outside the main actor, so letting go of this object closes the socket.
    private let holder = LinkHolder()
    /// While the first read is in flight, notifications wait here rather than
    /// changing a picture that is about to be replaced.
    @ObservationIgnored private var loading = false
    @ObservationIgnored private var held: [(String, XOLink.Answer)] = []

    init(address: String, fleet: Fleet? = nil) {
        self.address = address
        self.fleet = fleet
        lookedAt = Manage.lastLooked(address)
    }

    deinit {
        holder.take()?.close()
    }

    // MARK: Connecting

    /// Connect, sign in with the token, read the method list and the pool.
    /// A second call while connecting or connected does nothing.
    func start() async {
        if phase == .connecting || phase == .relaying || phase == .live { return }
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
            await readThrough(after: error.localizedDescription)
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

    /// Close the socket, or stop reading through a machine, keeping what was
    /// seen and when.
    func stop() {
        generation += 1
        polling?.cancel()
        polling = nil
        let link = holder.take()
        let through = via != nil || phase == .relaying
        guard link != nil || through else { return }
        link?.close()
        if phase == .live { touch() }
        loading = false
        held = []
        via = nil
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
        if via != nil, let fleet, phase == .live {
            return await runThrough(fleet, method, params, done: done)
        }
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

    /// How current what is shown is: watching, read through a machine at a
    /// time, or when it was last looked at.
    var currentLine: String {
        guard phase == .live else { return lookedLine }
        guard let via else { return Manage.Words.watching }
        return Manage.Words.through(via, at: (lookedAt ?? Date()).formatted(date: .omitted, time: .shortened))
    }

    // MARK: Through one of your machines

    /// Read the page through a machine that holds the pool's token, after
    /// this phone could not reach it (`why`). Again on the timer while the
    /// page is open; a failure then keeps what was shown and says so.
    private func readThrough(after why: String) async {
        guard let fleet else {
            phase = .stopped(Manage.Words.unreachable(address, why), retry: true)
            return
        }
        let first = via == nil
        if first { phase = .relaying }
        let asked = generation
        let key = Seal.newKey()
        do {
            let r = try await fleet.xolook(address, reply: key.publicKey)
            guard r.ok != false, let sealed = r.sealed else {
                throw FleetError.message(r.text ?? "the fleet sent no page")
            }
            let page = try Seal.open(key, aad: Seal.xolookAAD(address: address), sealed: sealed)
            if asked != generation { return }
            // NULL IS CANNOT TELL, as over the socket: no action is drawn.
            let listed = (page["methods"] as? [String]).map { Set($0) }
            if let listed, !listed.contains("xo.getAllObjects") {
                phase = .stopped(Manage.Words.noObjects, retry: false)
                return
            }
            var next = Manage.Snapshot()
            next.take(page["objects"])
            methods = listed
            if next != snapshot || first { revision += 1 }
            snapshot = next
            via = r.hostId ?? Manage.Words.oneOfYours
            phase = .live
            touch()
            if polling == nil { poll() }
        } catch {
            if asked != generation { return }
            polling?.cancel()
            polling = nil
            if let host = via {
                via = nil
                phase = .stopped(Manage.Words.throughLost(host, error.localizedDescription), retry: true)
            } else {
                phase = .stopped(Manage.Words.unreachableEverywhere(address, why, error.localizedDescription), retry: true)
            }
        }
    }

    private func poll() {
        polling = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: PoolWatch.throughEvery)
                guard !Task.isCancelled, let self, self.via != nil else { return }
                await self.readThrough(after: "")
            }
        }
    }

    /// An action, asked of the machine the page is read through, then the
    /// page read again so the change shows without waiting for the timer.
    private func runThrough(_ fleet: Fleet, _ method: String, _ params: [String: Any], done: String) async -> (ok: Bool, text: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: params), let args = String(data: data, encoding: .utf8) else {
            return (false, Manage.Words.refused("the action could not be written down"))
        }
        do {
            let r = try await fleet.xoact(address, method: method, args: args)
            if r.ok == false { return (false, r.text ?? Manage.Words.refused("the fleet refused it")) }
            await readThrough(after: "")
            return (true, done)
        } catch {
            return (false, Manage.Words.throughLost(via ?? Manage.Words.oneOfYours, error.localizedDescription))
        }
    }

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
            if reached {
                phase = .stopped(Manage.Words.lost(reason), retry: true)
            } else {
                Task { await readThrough(after: reason) }
            }
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
