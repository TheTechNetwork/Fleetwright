import Foundation

/// Commands the phone is holding because the fleet was not reachable.
///
/// The app used to send on tap and, when that failed, say so and lose the
/// command. That is the wrong answer on a phone: the ordinary case is a lift, a
/// tunnel, or a coordinator restarting, and "try again in a minute" asks
/// somebody to remember what they wanted and to be watching when it comes back.
///
/// So a command that could not be DELIVERED is held on the device and sent when
/// the fleet answers again. Four rules make that safe, and each is load-bearing:
///
///   1. **The idempotency key is minted here, when the command is queued, and
///      reused on every retry.** This is the whole reason holding a command is
///      safe at all: the coordinator honours the key, so a `start` that was
///      delivered but whose reply was lost returns the original outcome instead
///      of starting a second session. An id minted at send time — which is what
///      the app did before — would make a retry a second command.
///
///   2. **Only a delivery failure is held.** A 401, a 403, a refusal from the
///      fleet: those are ANSWERS. Holding an answer and replaying it later is
///      how somebody's revoked credential retries all night.
///
///   3. **Never a verb carrying a secret.** `link` and `renew` take a
///      credential. Writing one to device storage to send later is exactly what
///      this project refuses everywhere else, and a queue is a file — see
///      `holdable`.
///
///   4. **It expires.** A command sent a day later is a surprise, and a
///      surprise that starts a session on somebody's machine. Expired entries
///      are shown as expired rather than dropped quietly, because a queue that
///      forgets is a queue that lies.
@Observable
final class Outbox {
    struct Held: Codable, Identifiable, Hashable {
        let id: String
        let verb: String
        let params: [String: String]
        let numeric: [String]
        let host: String?
        let queuedAt: Date
        /// What the person asked for, in their words, for the pending list.
        let summary: String
        var attempts: Int = 0
        var lastProblem: String?

        var isExpired: Bool { Date().timeIntervalSince(queuedAt) > Outbox.expiry }
    }

    /// A held command older than this is not sent. Long enough to cover a
    /// commute and a night's sleep, short enough that nobody is surprised.
    static let expiry: TimeInterval = 12 * 3600

    /// Verbs worth holding.
    ///
    /// READS ARE ABSENT ON PURPOSE. A `list` that failed is worth repeating now,
    /// not in an hour — the answer would be stale before it arrived, and the app
    /// refreshes anyway.
    ///
    /// `link`, `renew` and `connect` are absent for a different and stronger
    /// reason: they carry or mint credentials. A queue is a file on a phone.
    static let holdable: Set<String> = [
        "start", "stop", "resume", "forget", "restore", "purge", "answer",
        "writefile", "copyfile", "deletefile",
    ]

    private(set) var held: [Held] = []

    private let store: URL

    init(directory: URL? = nil) {
        let base = directory
            ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        store = base.appendingPathComponent("outbox.json")
        load()
    }

    // MARK: - Holding

    /// Hold a command. Returns nil when this verb must not be held.
    @discardableResult
    func hold(verb: String, params: [String: String], numeric: Set<String>, host: String?, summary: String) -> Held? {
        guard Self.holdable.contains(verb) else { return nil }
        let entry = Held(
            // MINTED NOW, NOT AT SEND. See rule 1 — this is the line that makes
            // a retry safe rather than a duplicate.
            id: "app-\(UUID().uuidString)",
            verb: verb,
            params: params,
            numeric: Array(numeric),
            host: host,
            queuedAt: Date(),
            summary: summary
        )
        held.append(entry)
        save()
        return entry
    }

    func drop(_ id: String) {
        held.removeAll { $0.id == id }
        save()
    }

    func dropExpired() {
        let before = held.count
        held.removeAll { $0.isExpired }
        if held.count != before { save() }
    }

    // MARK: - Sending

    /// Try everything held, oldest first, and stop at the first thing that
    /// still cannot be delivered.
    ///
    /// STOPS RATHER THAN CONTINUES, because a fleet that is unreachable for one
    /// command is unreachable for all of them, and marching through the queue
    /// would turn one outage into N timeouts of two minutes each.
    ///
    /// Order is preserved for the same reason it matters anywhere: `stop` then
    /// `resume` and `resume` then `stop` are different intentions.
    @discardableResult
    func flush(using send: (Held) async -> Result<Void, Error>) async -> Int {
        dropExpired()
        var sent = 0
        for entry in held.sorted(by: { $0.queuedAt < $1.queuedAt }) {
            switch await send(entry) {
            case .success:
                drop(entry.id)
                sent += 1
            case .failure(let error):
                mark(entry.id, problem: error.localizedDescription)
                return sent
            }
        }
        return sent
    }

    private func mark(_ id: String, problem: String) {
        guard let i = held.firstIndex(where: { $0.id == id }) else { return }
        held[i].attempts += 1
        held[i].lastProblem = problem
        save()
    }

    // MARK: - Storage

    private func load() {
        guard let data = try? Data(contentsOf: store) else { return }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        held = (try? decoder.decode([Held].self, from: data)) ?? []
        dropExpired()
    }

    private func save() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(held) else { return }
        // Excluded from backups and readable only by this app. A held command
        // names a session and may carry file contents; it is not a credential,
        // and it is not something to copy into iCloud either.
        try? data.write(to: store, options: [.atomic, .completeFileProtection])
        var url = store
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}

/// Is this failure a failure to DELIVER, or an answer we did not like?
///
/// Only the first may be held. A refusal replayed later is a refusal replayed
/// all night, and an expired credential retrying every time the app opens is
/// how an account gets locked.
func isDeliveryFailure(_ error: Error) -> Bool {
    if let urlError = error as? URLError {
        switch urlError.code {
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost,
             .cannotFindHost, .timedOut, .dnsLookupFailed, .internationalRoamingOff,
             .dataNotAllowed, .secureConnectionFailed:
            return true
        default:
            return false
        }
    }
    // FleetError is this app's own refusal — a bad URL, cleartext, a message
    // from the coordinator. None of those are fixed by waiting.
    return false
}
